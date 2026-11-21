import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { Redis } from 'ioredis';
import pino, { Logger, StreamEntry } from 'pino';
import buildRoll from 'pino-roll';
import {
  LogRetentionSettingsSchema,
  type LogPruneResult,
  type LogRetentionSettings,
  type UpdateLogRetentionInput,
} from './schemas.js';

export const LOGS_RING_KEY = 'logs:ring';
export const LOGS_STREAM_CHANNEL = 'logs:stream';
export const LOG_RETENTION_CONFIG_KEY = 'config:log_retention';

export const DEFAULT_LOG_RETENTION_DAYS = 14;
export const DEFAULT_LOG_MAX_FILES_PER_SERVICE = 10;
export const DEFAULT_LOG_RING_MAX_ENTRIES = 500;
export const DEFAULT_MAX_LOG_STORAGE_MB = 500;

const ROTATED_LOG_FILE_RE = /^(.+?\.log)\.\d+(?:\..+)?$/;

function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function getEnvLogRetentionDefaults(
  overrides: Partial<LogRetentionSettings> = {},
): LogRetentionSettings {
  return {
    retentionDays:
      overrides.retentionDays ??
      clampNumber(process.env.LOG_RETENTION_DAYS, DEFAULT_LOG_RETENTION_DAYS, 1, 365),
    maxFilesPerService:
      overrides.maxFilesPerService ??
      clampNumber(
        process.env.LOG_RETENTION_FILES,
        DEFAULT_LOG_MAX_FILES_PER_SERVICE,
        1,
        100,
      ),
    maxRecentEntries:
      overrides.maxRecentEntries ??
      clampNumber(
        process.env.LOG_RING_MAX_ENTRIES,
        DEFAULT_LOG_RING_MAX_ENTRIES,
        50,
        10000,
      ),
    maxStorageMb:
      overrides.maxStorageMb ??
      clampNumber(process.env.MAX_LOG_STORAGE_MB, DEFAULT_MAX_LOG_STORAGE_MB, 10, 50000),
    autoPruneDiskLogs:
      overrides.autoPruneDiskLogs ?? process.env.LOG_AUTO_PRUNE !== 'false',
    updatedAt: overrides.updatedAt ?? null,
  };
}

export async function loadLogRetentionSettings(
  redis: Redis,
  defaults: Partial<LogRetentionSettings> = {},
): Promise<LogRetentionSettings> {
  const base = getEnvLogRetentionDefaults(defaults);
  try {
    const raw = await redis.get(LOG_RETENTION_CONFIG_KEY);
    if (!raw) return base;
    const parsed = LogRetentionSettingsSchema.safeParse({ ...base, ...JSON.parse(raw) });
    return parsed.success ? parsed.data : base;
  } catch {
    return base;
  }
}

export async function saveLogRetentionSettings(
  redis: Redis,
  patch: UpdateLogRetentionInput,
  defaults: Partial<LogRetentionSettings> = {},
): Promise<LogRetentionSettings> {
  const current = await loadLogRetentionSettings(redis, defaults);
  const next = LogRetentionSettingsSchema.parse({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  await redis.set(LOG_RETENTION_CONFIG_KEY, JSON.stringify(next));
  return next;
}

function parseLogLineTimestampMs(rawLine: string): number | null {
  try {
    const obj = JSON.parse(rawLine) as { time?: unknown };
    if (typeof obj.time === 'number' && Number.isFinite(obj.time)) {
      return obj.time;
    }
    if (typeof obj.time === 'string') {
      const ms = Date.parse(obj.time);
      return Number.isFinite(ms) ? ms : null;
    }
  } catch {
    // Non-JSON line
  }
  return null;
}

/**
 * Removes rotated disk log files (`*.log.*`) exceeding `retentionDays` or
 * `maxFilesPerService` (newest kept first), and trims Redis `logs:ring` by age
 * and max entry count. Never deletes `.gitkeep` or state JSON files.
 */
export async function pruneLogArtifacts(options: {
  logDir?: string;
  redis?: Redis;
  settings: LogRetentionSettings;
  nowMs?: number;
}): Promise<Omit<LogPruneResult, 'settings'>> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.settings.retentionDays * 24 * 60 * 60 * 1000;
  let deletedFiles = 0;
  let freedBytes = 0;

  if (options.logDir) {
    try {
      const entries = await fsp.readdir(options.logDir, { withFileTypes: true });
      const byService = new Map<
        string,
        Array<{ fullPath: string; mtimeMs: number; size: number }>
      >();

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(ROTATED_LOG_FILE_RE);
        if (!match) continue;
        const fullPath = path.join(options.logDir, entry.name);
        try {
          const stat = await fsp.stat(fullPath);
          const list = byService.get(match[1]) ?? [];
          list.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
          byService.set(match[1], list);
        } catch {
          // ignore race
        }
      }

      for (const files of byService.values()) {
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (let idx = 0; idx < files.length; idx += 1) {
          const file = files[idx];
          const overFileLimit = idx >= options.settings.maxFilesPerService;
          const expiredByAge = file.mtimeMs < cutoffMs;
          if (!overFileLimit && !expiredByAge) continue;

          try {
            await fsp.unlink(file.fullPath);
            deletedFiles += 1;
            freedBytes += file.size;
          } catch {
            // ignore unlink race
          }
        }
      }
    } catch {
      // Directory missing or unreadable
    }
  }

  let trimmedRedisEntries = 0;
  let remainingRedisEntries = 0;
  if (options.redis) {
    try {
      const existing = await options.redis.lrange(LOGS_RING_KEY, 0, -1);
      const kept: string[] = [];
      for (const line of existing) {
        if (kept.length >= options.settings.maxRecentEntries) break;
        const lineTs = parseLogLineTimestampMs(line);
        if (lineTs !== null && lineTs < cutoffMs) continue;
        kept.push(line);
      }
      trimmedRedisEntries = Math.max(0, existing.length - kept.length);
      remainingRedisEntries = kept.length;
      if (trimmedRedisEntries > 0) {
        const pipe = options.redis.pipeline();
        pipe.del(LOGS_RING_KEY);
        if (kept.length > 0) {
          pipe.rpush(LOGS_RING_KEY, ...kept);
        }
        await pipe.exec();
      }
    } catch {
      // ignore Redis transient error
    }
  }

  return {
    deletedFiles,
    freedBytes,
    trimmedRedisEntries,
    remainingRedisEntries,
  };
}

export interface ServiceLoggerOptions {
  logDir?: string;
  redisUrl?: string;
  redisClient?: Redis;
  level?: string;
  disableFile?: boolean;
  disableRedis?: boolean;
  maxFilesPerService?: number;
  maxRecentEntries?: number;
}

export interface ServiceLoggerHandle {
  logger: Logger;
  close: () => Promise<void>;
}

class RedisLogStream extends Writable {
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  private maxEntries: number;
  private lastConfigCheckMs = 0;
  private pending: Set<Promise<void>> = new Set();

  constructor(redisClient: Redis, ownsRedis: boolean, initialMaxEntries: number) {
    super();
    this.redis = redisClient;
    this.ownsRedis = ownsRedis;
    this.maxEntries = initialMaxEntries;
  }

  private async refreshMaxEntriesIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastConfigCheckMs < 15_000) return;
    this.lastConfigCheckMs = now;
    const settings = await loadLogRetentionSettings(this.redis);
    this.maxEntries = settings.maxRecentEntries;
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
        await this.refreshMaxEntriesIfDue();
        const maxIdx = Math.max(49, this.maxEntries - 1);
        const pipeline = this.redis.pipeline();
        for (const line of lines) {
          pipeline.lpush(LOGS_RING_KEY, line);
          pipeline.ltrim(LOGS_RING_KEY, 0, maxIdx);
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
  const envDefaults = getEnvLogRetentionDefaults({
    maxFilesPerService: options.maxFilesPerService,
    maxRecentEntries: options.maxRecentEntries,
  });

  const streams: StreamEntry[] = [{ stream: process.stdout, level: level as pino.Level }];

  let rollStream: pino.DestinationStream | undefined;
  if (!options.disableFile) {
    fs.mkdirSync(logDir, { recursive: true });
    const createdRoll = await buildRoll({
      file: path.join(logDir, `${serviceName}.log`),
      frequency: 'daily',
      size: '50m',
      limit: { count: envDefaults.maxFilesPerService },
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
    redisLogStream = new RedisLogStream(
      client,
      !options.redisClient,
      envDefaults.maxRecentEntries,
    );
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
