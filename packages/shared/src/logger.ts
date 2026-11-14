import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Redis } from 'ioredis';
import pino, { Logger, StreamEntry } from 'pino';
import buildRoll from 'pino-roll';

export const LOGS_RING_KEY = 'logs:ring';
export const LOGS_STREAM_CHANNEL = 'logs:stream';

export interface ServiceLoggerOptions {
  logDir?: string;
  redisUrl?: string;
  redisClient?: Redis;
  level?: string;
  disableFile?: boolean;
  disableRedis?: boolean;
}

export interface ServiceLoggerHandle {
  logger: Logger;
  close: () => Promise<void>;
}

class RedisLogStream extends Writable {
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  private pending: Set<Promise<void>> = new Set();

  constructor(redisClient: Redis, ownsRedis: boolean) {
    super();
    this.redis = redisClient;
    this.ownsRedis = ownsRedis;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      callback();
      return;
    }

    const job = (async () => {
      try {
        const pipeline = this.redis.pipeline();
        for (const line of lines) {
          pipeline.lpush(LOGS_RING_KEY, line);
          pipeline.ltrim(LOGS_RING_KEY, 0, 499);
          pipeline.publish(LOGS_STREAM_CHANNEL, line);
        }
        await pipeline.exec();
      } catch {
        // Avoid recursive logging loop if Redis is temporarily unavailable
      }
    })();

    this.pending.add(job);
    void job.finally(() => {
      this.pending.delete(job);
    });

    callback();
  }

  async flushAndClose(): Promise<void> {
    if (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    if (this.ownsRedis) {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
  }
}

export async function createServiceLogger(
  serviceName: string,
  options: ServiceLoggerOptions = {},
): Promise<ServiceLoggerHandle> {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  const logDir = options.logDir ?? process.env.LOG_DIR ?? path.resolve(process.cwd(), 'logs');
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;

  const streams: StreamEntry[] = [{ stream: process.stdout, level: level as pino.Level }];

  let rollStream: pino.DestinationStream | undefined;
  if (!options.disableFile) {
    fs.mkdirSync(logDir, { recursive: true });
    const createdRoll = await buildRoll({
      file: path.join(logDir, `${serviceName}.log`),
      frequency: 'daily',
      size: '50m',
      limit: { count: 10 },
      mkdir: true,
    });
    rollStream = createdRoll;
    streams.push({ stream: createdRoll, level: level as pino.Level });
  }

  let redisLogStream: RedisLogStream | undefined;
  if (!options.disableRedis && (options.redisClient || redisUrl)) {
    const client =
      options.redisClient ??
      new Redis(redisUrl as string, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
    client.on('error', () => {
      // Suppress unhandled error events from background log publisher
    });
    redisLogStream = new RedisLogStream(client, !options.redisClient);
    streams.push({ stream: redisLogStream, level: level as pino.Level });
  }

  const logger = pino(
    {
      level,
      base: { service: serviceName },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );

  return {
    logger,
    close: async () => {
      if (redisLogStream) {
        await redisLogStream.flushAndClose();
      }
      if (rollStream) {
        const boom = rollStream as unknown as {
          fd?: number;
          destroyed?: boolean;
          once?: (event: string, cb: () => void) => void;
          flushSync?: () => void;
          end?: () => void;
        };
        if (typeof boom.fd === 'number' && boom.fd < 0 && !boom.destroyed && typeof boom.once === 'function') {
          await new Promise<void>((resolve) => {
            boom.once?.('ready', () => resolve());
          });
        }
        if (typeof boom.flushSync === 'function' && !boom.destroyed) {
          boom.flushSync();
        }
        if (typeof boom.end === 'function' && !boom.destroyed) {
          await new Promise<void>((resolve) => {
            boom.once?.('close', () => resolve());
            boom.end?.();
          });
        }
      }
    },
  };
}
