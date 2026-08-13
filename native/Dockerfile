# Prism — native (Snowflake Marketplace) edition image. Phase N1 of
# docs/NATIVE_APP_PLAN.md: runs the app as a single container with the
# standard env-tier Snowflake credentials (SPCS ambient auth arrives in N2).
#
# Build (from the repo root — context is stand-ui/):
#   docker build -f native/Dockerfile -t prism-native stand-ui
#
# Run (see native/README.md for the full env set):
#   docker run -p 8000:8000 -v prism-data:/data --env-file native/dev.env prism-native
#
# Debian-slim, not alpine: better-sqlite3 ships glibc prebuilds; musl would
# force a source build. The toolchain is installed anyway as a fallback for
# platforms without a matching prebuild.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain fallback for native addons (better-sqlite3) if no prebuild matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# npm ci needs registry.npmjs.org AND cdn.sheetjs.com (the pinned xlsx tarball).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The edition is baked at build time: NEXT_PUBLIC_ is inlined into the client
# bundle; the bare var covers server reads. PRISM_BUILD_STANDALONE turns on
# Next's standalone output (see next.config.ts) without touching the standard
# edition's build.
ENV PRISM_EDITION=native \
    NEXT_PUBLIC_PRISM_EDITION=native \
    PRISM_BUILD_STANDALONE=true \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PRISM_EDITION=native \
    NEXT_PUBLIC_PRISM_EDITION=native \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8000 \
    HOSTNAME=0.0.0.0 \
    # App state lives on the mounted volume — the container filesystem is
    # ephemeral (docs/NATIVE_APP_PLAN.md §2.5).
    PRISM_SQLITE_PATH=/data/prism.db

# Standalone output: traced server.js + the exact node_modules subset it needs
# (serverExternalPackages better-sqlite3 / re2-wasm are included by the trace).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Run as the unprivileged node user; /data must be writable by it.
RUN mkdir -p /data && chown node:node /data /app
USER node
VOLUME /data
EXPOSE 8000

# server.js runs instrumentation.ts's register() → poller + tick start with
# the process, same as `next start`.
CMD ["node", "server.js"]
