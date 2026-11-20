FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose
COPY infra/docker/updater/server.mjs /app/server.mjs
ENV PORT=4010 \
    REPO_DIR=/repo \
    STATE_FILE=/var/log/app/system-update.json
EXPOSE 4010
CMD ["node", "/app/server.mjs"]
