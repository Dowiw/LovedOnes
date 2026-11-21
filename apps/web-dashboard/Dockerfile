FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/web-dashboard/package.json apps/web-dashboard/tsconfig.json ./apps/web-dashboard/
RUN pnpm install --filter @loved-ones/web-dashboard...
COPY packages/shared ./packages/shared
COPY apps/web-dashboard ./apps/web-dashboard
RUN pnpm --filter @loved-ones/shared build && pnpm --filter @loved-ones/web-dashboard build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web-dashboard/.next/standalone ./
COPY --from=builder /app/apps/web-dashboard/.next/static ./apps/web-dashboard/.next/static
COPY --from=builder /app/apps/web-dashboard/public ./apps/web-dashboard/public
EXPOSE 3000
CMD ["node", "apps/web-dashboard/server.js"]
