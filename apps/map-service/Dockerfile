FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/map-service/package.json apps/map-service/tsconfig.json ./apps/map-service/
RUN pnpm install --filter @loved-ones/map-service...
COPY packages/shared ./packages/shared
COPY apps/map-service ./apps/map-service
RUN pnpm --filter @loved-ones/shared build && pnpm --filter @loved-ones/map-service build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 8080
CMD ["node", "apps/map-service/dist/index.js"]
