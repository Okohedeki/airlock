# syntax=docker/dockerfile:1
#
# airlock dashboard server — multi-stage, build context = repo root.
#
# The server's tsconfig extends ../../tsconfig.base.json and pnpm needs the
# workspace + lockfile, so this builds from the monorepo root:
#
#   docker build -f packages/server/Dockerfile -t airlock-dashboard .
#
# better-sqlite3 is a native module: it compiles in the full node image (which
# ships gcc/g++/make/python), then the slim runtime stage just carries the
# prebuilt .node — same Node major (22) keeps the ABI compatible.

# ---- builder: full node image has the C++ toolchain for node-gyp ----
FROM node:22-bookworm AS builder
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --filter @airlockhq/server... --frozen-lockfile
RUN pnpm --filter @airlockhq/server build
# Produce a self-contained dir (dist + pruned production node_modules incl. the compiled .node).
RUN pnpm --filter @airlockhq/server deploy --prod --legacy /out

# ---- runtime: slim, no toolchain ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/airlock.db \
    PUBLIC_BASE_URL=http://localhost:8787
WORKDIR /app
COPY --from=builder /out/dist ./dist
COPY --from=builder /out/node_modules ./node_modules
COPY --from=builder /out/package.json ./package.json
RUN mkdir -p /data

EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
