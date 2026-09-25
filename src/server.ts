/**
 * Deployz fixture application — the container a fresh installation runs,
 * and the deterministic release the version/rollback canary deploys.
 *
 * A customer deployment has no release when it is first installed, so the
 * application stack still needs something to run: CloudFormation does not
 * report an ECS service complete until it stabilises, which means a real
 * image that starts and answers its health check. This is that image.
 *
 * It is deliberately close to nothing. Its whole job is to be honest about
 * three things:
 *
 * - **`/health` answers 200 as soon as the process is listening.** It is
 *   the ALB target-group check and the container health check, and both are
 *   asking whether the container is up — not whether the application is
 *   fully wired. A `/health` that failed while the database was still
 *   coming up would fail the install for a reason the install did not
 *   cause. The one exception is a release built with `healthMode: broken`
 *   (`release.json`), which answers 500 on purpose so the canary can prove
 *   a failed release never replaces the running one.
 * - **The database probe is reported, not enforced.** The body says what
 *   the connection is doing so an operator can see it; it never changes the
 *   status code. `GET /` carries the same detail for a human.
 * - **`/version` and `/canary/markers` say what is really running and
 *   really stored.** The release identity is baked into the image at build
 *   time (`release.json`), never read from a mutable tag, and a marker
 *   written through one release must still be readable after an update or
 *   a rollback — that is the persistence contract the canary asserts.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

import express, { type Express } from 'express';
import { Pool, type PoolConfig } from 'pg';

const PORT = Number(process.env['PORT'] ?? 3000);

type DatabaseState = 'connected' | 'unavailable' | 'not-configured';

export type HealthMode = 'ok' | 'broken';

/** The release identity baked into the image at build time. */
export interface ReleaseInfo {
  readonly version: string;
  readonly commit: string;
  readonly healthMode: HealthMode;
}

const DEFAULT_RELEASE: ReleaseInfo = { version: 'dev', commit: 'local', healthMode: 'ok' };

/**
 * `release.json` sits next to `package.json` in the image (the Dockerfile
 * copies it). Environment overrides exist for local runs and tests only —
 * a deployed image always carries its identity in the file, which is what
 * makes two builds of the same tag answer the same thing.
 */
export function readReleaseInfo(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ReleaseInfo {
  let fromFile: Partial<ReleaseInfo> = {};
  try {
    fromFile = JSON.parse(readFile(resolve(process.cwd(), 'release.json'))) as Partial<ReleaseInfo>;
  } catch {
    // No file: a bare local run. The defaults below say so.
  }
  const healthMode = env['FIXTURE_HEALTH_MODE'] ?? fromFile.healthMode ?? DEFAULT_RELEASE.healthMode;
  return {
    version: env['FIXTURE_VERSION'] ?? fromFile.version ?? DEFAULT_RELEASE.version,
    commit: env['FIXTURE_COMMIT'] ?? fromFile.commit ?? DEFAULT_RELEASE.commit,
    healthMode: healthMode === 'broken' ? 'broken' : 'ok',
  };
}

/**
 * The stack injects DATABASE_HOST and friends; a bare `docker run` does
 * not. Absent configuration is `null`, which is a different answer from
 * "configured and not reachable" and worth keeping distinct.
 *
 * Exported and taking its environment as an argument so the connection
 * settings can be asserted without opening a socket.
 */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv): PoolConfig | null {
  const host = env['DATABASE_HOST'];
  if (!host) return null;

  return {
    host,
    port: Number(env['DATABASE_PORT'] ?? 5432),
    database: env['DATABASE_NAME'] ?? 'deployz',
    user: env['DATABASE_USER'] ?? 'deployz_app',
    password: env['DATABASE_PASSWORD'] ?? '',
    // The stack's RDS runs on the default postgres16 parameter group, where
    // `rds.force_ssl` is 1 — an unencrypted connection is refused outright.
    // Without this the container comes up healthy and reports its database
    // permanently unavailable, which reads like a networking fault and is
    // not one.
    //
    // `rejectUnauthorized: false` encrypts without verifying the server
    // certificate. That is the wrong trade for a real application, which
    // should pin the RDS CA bundle; it is the right one here, where the
    // point is to prove the wiring reaches the database and shipping a CA
    // bundle in a fixture would obscure that.
    ssl: { rejectUnauthorized: false },
    // Short, because this only ever backs a status field. A slow database
    // must not make the health endpoint slow enough to look like a timeout.
    connectionTimeoutMillis: 2_000,
    max: 2,
  };
}

/** The persistence round trip the canary asserts across releases. */
export interface MarkerRecord {
  readonly key: string;
  readonly value: string;
  readonly createdAt: string;
}

export interface MarkerStore {
  write(key: string, value: string): Promise<MarkerRecord>;
  read(key: string): Promise<MarkerRecord | null>;
}

export const MARKERS_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS canary_markers (key text PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())';

/**
 * Markers live in one small table the fixture creates on first use (and
 * that `migrate.ts` creates as the release's migration command). A marker
 * is write-once: a second write of the same key keeps the original row, so
 * a re-run of the same canary step cannot mask lost data.
 */
export function createPgMarkerStore(pool: Pool): MarkerStore {
  return {
    async write(key, value) {
      await pool.query(MARKERS_TABLE_SQL);
      const inserted = await pool.query<{ key: string; value: string; created_at: Date }>(
        'INSERT INTO canary_markers (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key, value, created_at',
        [key, value],
      );
      const row =
        inserted.rows[0] ??
        (
          await pool.query<{ key: string; value: string; created_at: Date }>(
            'SELECT key, value, created_at FROM canary_markers WHERE key = $1',
            [key],
          )
        ).rows[0];
      if (!row) throw new Error(`Marker ${key} was neither inserted nor found`);
      return { key: row.key, value: row.value, createdAt: row.created_at.toISOString() };
    },
    async read(key) {
      await pool.query(MARKERS_TABLE_SQL);
      const result = await pool.query<{ key: string; value: string; created_at: Date }>(
        'SELECT key, value, created_at FROM canary_markers WHERE key = $1',
        [key],
      );
      const row = result.rows[0];
      return row ? { key: row.key, value: row.value, createdAt: row.created_at.toISOString() } : null;
    },
  };
}

/**
 * `/canary/bindings` — what the version canary asks the running container
 * about its own environment, so a profile run (pg/stateless/redis) can prove
 * the application stack actually injected the env/secret bindings its
 * manifest promised. Never the value itself: a SHA-256 prefix is enough to
 * tell "present and non-empty" from "absent" without putting a credential in
 * a response body or an evidence file.
 */
const BINDING_ENV_KEYS = ['DATABASE_URL', 'STORAGE_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET', 'REDIS_URL'] as const;

export interface BindingCheck {
  readonly present: boolean;
  readonly sha256Prefix: string | null;
}

export function checkBinding(value: string | undefined): BindingCheck {
  if (!value) return { present: false, sha256Prefix: null };
  return { present: true, sha256Prefix: createHash('sha256').update(value).digest('hex').slice(0, 8) };
}

export interface RedisPingResult {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * A raw-TCP RESP `PING` — no redis client dependency (the fixture stays
 * close to nothing, see the file doc comment). Resolves once a full line
 * comes back or the connection errors/times out; never rejects.
 */
export function pingRedis(host: string, port: number, timeoutMs = 3_000): Promise<RedisPingResult> {
  return new Promise((resolvePing) => {
    let settled = false;
    const finish = (result: RedisPingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePing(result);
    };
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => finish({ attempted: true, ok: false, detail: 'timeout' }), timeoutMs);
    let data = '';
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n')) finish({ attempted: true, ok: data.startsWith('+PONG'), detail: data.trim() });
    });
    socket.once('error', (error) => finish({ attempted: true, ok: false, detail: String(error) }));
  });
}

/** `redis://[:password@]host:port` -> `{host, port}`; `null` when unparseable. */
export function parseRedisUrl(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return { host: parsed.hostname, port: Number(parsed.port || 6379) };
  } catch {
    return null;
  }
}

/** The `{host, port}` to ping from whichever REDIS_* bindings are set — `REDIS_URL` first, then REDIS_HOST/REDIS_PORT. `null` when neither is configured. */
export function redisPingTarget(env: NodeJS.ProcessEnv): { host: string; port: number } | null {
  const url = env['REDIS_URL'];
  if (url) return parseRedisUrl(url);
  const host = env['REDIS_HOST'];
  if (!host) return null;
  return { host, port: Number(env['REDIS_PORT'] ?? 6379) };
}

const poolConfig = poolConfigFromEnv(process.env);
const pool = poolConfig === null ? null : new Pool(poolConfig);

async function probeDatabase(): Promise<DatabaseState> {
  if (!pool) return 'not-configured';
  try {
    await pool.query('SELECT 1');
    return 'connected';
  } catch {
    return 'unavailable';
  }
}

export interface AppOptions {
  readonly probe?: () => Promise<DatabaseState>;
  readonly release?: ReleaseInfo;
  /** Null when no database is configured — marker routes answer 503. */
  readonly markers?: MarkerStore | null;
  /** Injectable for tests; defaults to the real raw-TCP `pingRedis`. */
  readonly pingRedis?: (host: string, port: number) => Promise<RedisPingResult>;
  /** Injectable for tests; defaults to reading `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const MARKER_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

export function createApp(options: AppOptions = {}): Express {
  const probe = options.probe ?? probeDatabase;
  const release = options.release ?? readReleaseInfo(process.env);
  const markers =
    options.markers !== undefined ? options.markers : pool === null ? null : createPgMarkerStore(pool);
  const env = options.env ?? process.env;
  const doPingRedis = options.pingRedis ?? pingRedis;

  const app = express();
  app.use(express.json());

  app.get('/health', async (_request, response) => {
    if (release.healthMode === 'broken') {
      response
        .status(500)
        .json({ status: 'unhealthy', reason: 'health-mode-broken', version: release.version });
      return;
    }
    response.status(200).json({ status: 'ok', database: await probe(), version: release.version });
  });

  app.get('/version', (_request, response) => {
    response.status(200).json(release);
  });

  app.get('/', async (_request, response) => {
    response.status(200).json({
      application: 'deployz-fixture',
      status: 'ok',
      database: await probe(),
      ...release,
    });
  });

  app.post('/canary/markers', async (request, response) => {
    const body = request.body as { key?: unknown; value?: unknown } | undefined;
    const key = typeof body?.key === 'string' ? body.key : '';
    if (!MARKER_KEY_PATTERN.test(key)) {
      response.status(400).json({ error: 'key must match [A-Za-z0-9_.-]{1,200}' });
      return;
    }
    const value = typeof body?.value === 'string' ? body.value : release.version;
    if (markers === null) {
      response.status(503).json({ error: 'database not configured' });
      return;
    }
    try {
      response.status(201).json(await markers.write(key, value));
    } catch (error) {
      response.status(503).json({ error: `database unavailable: ${String(error)}` });
    }
  });

  app.get('/canary/markers/:key', async (request, response) => {
    const key = request.params['key'] ?? '';
    if (!MARKER_KEY_PATTERN.test(key)) {
      response.status(400).json({ error: 'key must match [A-Za-z0-9_.-]{1,200}' });
      return;
    }
    if (markers === null) {
      response.status(503).json({ error: 'database not configured' });
      return;
    }
    try {
      const record = await markers.read(key);
      if (record === null) {
        response.status(404).json({ error: 'marker not found', key });
        return;
      }
      response.status(200).json(record);
    } catch (error) {
      response.status(503).json({ error: `database unavailable: ${String(error)}` });
    }
  });

  app.get('/canary/bindings', async (_request, response) => {
    const bindings: Record<string, BindingCheck> = {};
    for (const key of BINDING_ENV_KEYS) bindings[key] = checkBinding(env[key]);
    const target = redisPingTarget(env);
    const redis = target
      ? await doPingRedis(target.host, target.port)
      : ({ attempted: false, ok: false, detail: 'no REDIS_URL/REDIS_HOST configured' } satisfies RedisPingResult);
    response.status(200).json({ bindings, redis });
  });

  return app;
}

// Only when run as the container's entry point — importing this module in a
// test must not bind a port.
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const release = readReleaseInfo(process.env);
  createApp({ release }).listen(PORT, () => {
    console.log(JSON.stringify({ event: 'fixture:listening', port: PORT, ...release }));
  });
}
