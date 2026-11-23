FROM node:22-alpine AS builder
WORKDIR /app
ENV PNPM_STORE_DIR=/pnpm/store
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY apps/auth-admin-service/package.json ./apps/auth-admin-service/
COPY apps/realtime-service/package.json ./apps/realtime-service/
COPY apps/web-dashboard/package.json ./apps/web-dashboard/
COPY apps/map-service/package.json apps/map-service/tsconfig.json ./apps/map-service/
COPY apps/mobile-app/package.json ./apps/mobile-app/
RUN --mount=type=cache,id=lovedones-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @loved-ones/map-service... --store-dir /pnpm/store
COPY packages/shared ./packages/shared
COPY apps/map-service ./apps/map-service
RUN pnpm --filter @loved-ones/shared build && pnpm --filter @loved-ones/map-service build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache su-exec
COPY --from=builder --chown=node:node /app ./
COPY infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/map-service/dist/index.js"]
