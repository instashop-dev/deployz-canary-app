# syntax=docker/dockerfile:1

# Deployz fixture application — a minimal Node.js/Express app with a
# /health endpoint and a PostgreSQL connection, deployed by the integration
# suite to prove the INSTALL flow reaches HEALTHY.
#
# The build context is THIS directory, not the repository root. The build
# pipeline derives the context from the Dockerfile's own location
# (`dirname "$DOCKERFILE_PATH"`, see packages/cdk/src/pipeline/build-pipeline.ts),
# so a Dockerfile that reached up into the repo for tsconfig.base.json could
# not be built by the pipeline that has to build it.
#
#   docker build -t deployz-fixture packages/fixture

# The ECR Public mirror of the Docker Hub official image: CodeBuild pulls
# anonymously from shared egress IPs and Docker Hub answers 429 Too Many
# Requests often enough to fail a canary build (seen live); the mirror is
# not rate-limited that way.
# ── Stage 1: compile TypeScript ──────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.build.json ./
COPY src ./src
RUN npm install && npx tsc -p tsconfig.build.json

# ── Stage 2: production runtime ──────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-alpine AS runtime
WORKDIR /app
# The ECS task definition's health check shells out to curl, which the base
# image does not carry. Without it every task is marked unhealthy, the
# deployment circuit breaker fires, and CloudFormation rolls the stack back.
RUN apk add --no-cache curl
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The release identity (/version, health mode) is baked in at build time —
# the canary tags differ only in this file, never in a mutable image tag.
COPY release.json ./release.json
RUN npm install --omit=dev && npm cache clean --force
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]
