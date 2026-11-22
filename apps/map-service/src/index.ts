import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import { registerGracefulShutdown } from '@loved-ones/shared/auth';
import { createServiceLogger, ServiceLoggerHandle } from '@loved-ones/shared/logger';
import { startServiceHeartbeatFromUrl } from '@loved-ones/shared/telemetry';

export interface MapServiceOptions {
  tilesDir?: string;
  logDir?: string;
  redisUrl?: string;
  disableFileLog?: boolean;
  disableRedisLog?: boolean;
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pmtiles':
      return 'application/vnd.pmtiles';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.pbf':
      return 'application/x-protobuf';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function parseByteRange(rangeHeader: string, totalSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return null;

  let start = 0;
  let end = totalSize - 1;

  if (startStr && endStr) {
    start = Number.parseInt(startStr, 10);
    end = Math.min(Number.parseInt(endStr, 10), totalSize - 1);
  } else if (startStr) {
    start = Number.parseInt(startStr, 10);
    end = totalSize - 1;
  } else if (endStr) {
    const suffixLength = Number.parseInt(endStr, 10);
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
    return null;
  }
  return { start, end };
}

export async function createMapServer(
  options: MapServiceOptions = {},
): Promise<{ app: FastifyInstance; loggerHandle: ServiceLoggerHandle }> {
  const tilesDir = path.resolve(
    options.tilesDir ?? process.env.TILES_DIR ?? path.resolve(process.cwd(), '../../infra/tiles'),
  );

  const resolvedLogDir = options.logDir ?? process.env.LOG_DIR;
  const resolvedRedisUrl = options.redisUrl ?? process.env.REDIS_URL;

  const loggerHandle = await createServiceLogger('map-service', {
    logDir: resolvedLogDir,
    redisUrl: resolvedRedisUrl,
    disableFile: options.disableFileLog,
    disableRedis: options.disableRedisLog,
  });

  const heartbeat = options.disableRedisLog
    ? null
    : startServiceHeartbeatFromUrl({
        service: 'map-service',
        redisUrl: resolvedRedisUrl,
        mounts: [
          { mountLabel: 'tiles', path: tilesDir },
          ...(resolvedLogDir ? [{ mountLabel: 'logs' as const, path: resolvedLogDir }] : []),
        ],
      });

  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Range', 'If-Modified-Since', 'Cache-Control', 'Content-Type'],
    exposedHeaders: ['Accept-Ranges', 'Content-Range', 'Content-Length', 'ETag'],
  });

  app.get('/health', async (_request, reply) => {
    const tilesAvailable = fs.existsSync(tilesDir);
    return reply.code(tilesAvailable ? 200 : 503).send({
      status: tilesAvailable ? 'ok' : 'degraded',
      service: 'map-service',
      tilesDir,
    });
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/tiles/*',
    handler: async (request, reply) => {
      const wildcard = (request.params as { '*': string })['*'] ?? '';
      const safeRel = path.normalize(wildcard).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.resolve(tilesDir, safeRel);

      if (!fullPath.startsWith(tilesDir) || !fs.existsSync(fullPath)) {
        return reply.code(404).send({ error: 'Tile resource not found' });
      }

      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) {
        return reply.code(404).send({ error: 'Resource is not a file' });
      }

      const contentType = getContentType(fullPath);
      const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;

      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Type', contentType);
      reply.header('ETag', etag);
      reply.header('Cache-Control', 'public, max-age=3600');

      const rangeHeader = request.headers.range;
      if (rangeHeader) {
        const parsed = parseByteRange(rangeHeader, stat.size);
        if (!parsed) {
          reply.header('Content-Range', `bytes */${stat.size}`);
          return reply.code(416).send({ error: 'Range Not Satisfiable' });
        }

        const chunkSize = parsed.end - parsed.start + 1;
        reply.header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${stat.size}`);
        reply.header('Content-Length', String(chunkSize));
        reply.code(206);

        if (request.method === 'HEAD') {
          return reply.send();
        }
        return reply.send(fs.createReadStream(fullPath, { start: parsed.start, end: parsed.end }));
      }

      reply.header('Content-Length', String(stat.size));
      reply.code(200);
      if (request.method === 'HEAD') {
        return reply.send();
      }
      return reply.send(fs.createReadStream(fullPath));
    },
  });

  app.addHook('onClose', async () => {
    await heartbeat?.stop();
    await loggerHandle.close();
  });

  return { app, loggerHandle };
}

async function main() {
  const port = Number.parseInt(process.env.PORT ?? process.env.MAP_SERVICE_PORT ?? '8085', 10);
  const { app, loggerHandle } = await createMapServer();
  registerGracefulShutdown(app, loggerHandle.logger, 'map-service');
  await app.listen({ port, host: '0.0.0.0' });
  loggerHandle.logger.info({ port }, 'map-service listening');
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error('map-service fatal error:', err);
    process.exit(1);
  });
}
