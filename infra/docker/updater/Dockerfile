FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-buildx docker-cli-compose
COPY infra/docker/updater/server.mjs /app/server.mjs
ENV PORT=4010 \
    REPO_DIR=/repo \
    STATE_FILE=/var/log/app/system-update.json \
    DOCKER_BUILDKIT=1 \
    COMPOSE_DOCKER_CLI_BUILD=1 \
    SYSTEM_UPDATE_BUILD_TIMEOUT_MS=1800000
EXPOSE 4010
CMD ["node", "/app/server.mjs"]
