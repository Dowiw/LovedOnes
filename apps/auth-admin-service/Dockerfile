FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY apps/auth-admin-service/package.json apps/auth-admin-service/tsconfig.json ./apps/auth-admin-service/
RUN pnpm install --filter @loved-ones/auth-admin-service...
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/auth-admin-service ./apps/auth-admin-service
RUN pnpm --filter @loved-ones/shared build \
 && pnpm --filter @loved-ones/db build \
 && pnpm --filter @loved-ones/auth-admin-service build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
COPY infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 4001
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/auth-admin-service/dist/index.js"]
