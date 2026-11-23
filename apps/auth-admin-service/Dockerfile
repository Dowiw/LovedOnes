FROM node:22-alpine AS builder
WORKDIR /app
ENV PNPM_STORE_DIR=/pnpm/store
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY apps/auth-admin-service/package.json apps/auth-admin-service/tsconfig.json ./apps/auth-admin-service/
COPY apps/realtime-service/package.json ./apps/realtime-service/
COPY apps/web-dashboard/package.json ./apps/web-dashboard/
COPY apps/map-service/package.json ./apps/map-service/
COPY apps/mobile-app/package.json apps/mobile-app/app.json ./apps/mobile-app/
RUN --mount=type=cache,id=lovedones-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @loved-ones/auth-admin-service... --store-dir /pnpm/store
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/auth-admin-service ./apps/auth-admin-service
RUN pnpm --filter @loved-ones/shared build \
 && pnpm --filter @loved-ones/db build \
 && pnpm --filter @loved-ones/auth-admin-service build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ca-certificates curl tar su-exec \
 && case "$(uname -m)" in \
      x86_64) PMTILES_ARCH="x86_64" ;; \
      aarch64|arm64) PMTILES_ARCH="arm64" ;; \
      *) echo "Unsupported arch: $(uname -m)" && exit 1 ;; \
    esac \
 && curl -sfL "https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_${PMTILES_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin pmtiles \
 && chmod +x /usr/local/bin/pmtiles
COPY --from=builder --chown=node:node /app ./
COPY infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 4001
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/auth-admin-service/dist/index.js"]
