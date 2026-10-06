# syntax=docker/dockerfile:1.7

# Web-only production image. Voice Platform is built as a separate service.
# The exact official Node image is pinned for reproducible native dependencies.
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PUPPETEER_SKIP_DOWNLOAD=true
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/enforce-pnpm.mjs ./scripts/enforce-pnpm.mjs
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN node -e "require('sharp').metadata; const Database=require('better-sqlite3'); new Database(':memory:').close()"

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec next build \
    && test -f .next/standalone/server.js \
    && test -s .next/BUILD_ID

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       chromium \
       ffmpeg \
       fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs

ENV NODE_ENV=production \
    COZE_PROJECT_ENV=PROD \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=5000 \
    HOSTNAME=0.0.0.0 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

COPY --chown=nextjs:nodejs --from=builder /app/.next/standalone ./
COPY --chown=nextjs:nodejs --from=builder /app/.next/static ./.next/static
# The clean Git source contains only explicitly allowlisted public metadata.
# Large immutable media is served from versioned COS/CDN or a read-only mount.
COPY --chown=nextjs:nodejs --from=builder /app/public ./public

USER nextjs
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5000/api/version',{cache:'no-store'}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
