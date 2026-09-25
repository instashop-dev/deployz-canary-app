/**
 * The fixture's migration command — `node dist/migrate.js`.
 *
 * Deployz runs a release's migration command as a one-off ECS task before
 * the service update, so a release that declares this exercises the real
 * migration stage end-to-end. The migration is idempotent (CREATE TABLE IF
 * NOT EXISTS) and never touches existing rows: a rollback, which runs no
 * migrations, must find every marker written before it still in place.
 */

import { Pool } from 'pg';

import { MARKERS_TABLE_SQL, poolConfigFromEnv } from './server.js';

const config = poolConfigFromEnv(process.env);
if (config === null) {
  console.error(JSON.stringify({ event: 'fixture:migrate-skipped', reason: 'database not configured' }));
  process.exit(1);
}

const pool = new Pool(config);
try {
  await pool.query(MARKERS_TABLE_SQL);
  console.log(JSON.stringify({ event: 'fixture:migrated', table: 'canary_markers' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'fixture:migrate-failed', error: String(error) }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
