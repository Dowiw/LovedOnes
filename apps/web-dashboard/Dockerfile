FROM node:22-alpine AS builder
WORKDIR /app
ENV PNPM_STORE_DIR=/pnpm/store
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY apps/auth-admin-service/package.json ./apps/auth-admin-service/
COPY apps/realtime-service/package.json ./apps/realtime-service/
COPY apps/web-dashboard/package.json apps/web-dashboard/tsconfig.json ./apps/web-dashboard/
COPY apps/map-service/package.json ./apps/map-service/
COPY apps/mobile-app/package.json ./apps/mobile-app/
RUN --mount=type=cache,id=lovedones-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @loved-ones/web-dashboard... --store-dir /pnpm/store
COPY packages/shared ./packages/shared
COPY apps/web-dashboard ./apps/web-dashboard
RUN --mount=type=cache,id=lovedones-next-cache,target=/app/apps/web-dashboard/.next/cache \
    pnpm --filter @loved-ones/shared build && pnpm --filter @loved-ones/web-dashboard build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/apps/web-dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web-dashboard/.next/static ./apps/web-dashboard/.next/static
COPY --from=builder --chown=node:node /app/apps/web-dashboard/public ./apps/web-dashboard/public
USER node
EXPOSE 3000
CMD ["node", "apps/web-dashboard/server.js"]
