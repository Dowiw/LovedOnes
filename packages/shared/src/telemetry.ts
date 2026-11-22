import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import {
  AdminNotice,
  AdminNoticeSchema,
  AdminNoticeScope,
  DiskMountTelemetry,
  RedisTelemetry,
  ResourceLimitsSettings,
  ResourceLimitsSettingsSchema,
  ServiceNodeTelemetry,
  ServiceNodeTelemetrySchema,
  type TrackingState,
  UpdateResourceLimitsInput,
  type UserPresenceRecord,
} from './schemas.js';

export const TELEMETRY_USER_PREFIX = 'telemetry:user:';
export const TELEMETRY_NODE_PREFIX = 'telemetry:node:';
export const RESOURCE_LIMITS_CONFIG_KEY = 'config:resource_limits';
export const ADMIN_NOTICES_KEY = 'telemetry:admin_notices';
export const SESSION_USER_PREFIX = 'session:user:';
export const SOCKETS_USER_PREFIX = 'sockets:user:';
export const TRACKER_JTI_USER_PREFIX = 'tracker:jti:user:';
export const REMOVED_USER_PREFIX = 'removed:user:';
export const PRESENCE_USER_PREFIX = 'presence:user:';
export const USER_PROFILE_UPDATED_CHANNEL = 'user:profile:updated';
export const USER_ACCOUNT_REMOVED_CHANNEL = 'user:account:removed';
export const USER_PRIVACY_UPDATED_CHANNEL = 'user:privacy:updated';

const PRESENCE_TTL_SECONDS = 86_400;
const VALID_TRACKING_STATES = new Set<TrackingState>([
  'active',
  'idle',
  'paused',
  'permission_denied',
  'gps_off',
  'interrupted',
]);

function parseUserPresenceJson(raw: string | null): UserPresenceRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UserPresenceRecord>;
    if (
      typeof parsed.lastHeartbeatAt !== 'string' ||
      !parsed.trackingState ||
      !VALID_TRACKING_STATES.has(parsed.trackingState)
    ) {
      return null;
    }
    const batteryLevel =
      typeof parsed.batteryLevel === 'number' &&
      Number.isFinite(parsed.batteryLevel) &&
      parsed.batteryLevel >= 0 &&
      parsed.batteryLevel <= 100
        ? Math.round(parsed.batteryLevel)
        : null;
    return {
      lastHeartbeatAt: parsed.lastHeartbeatAt,
      trackingState: parsed.trackingState,
      batteryLevel,
    };
  } catch {
    return null;
  }
}

export async function setUserPresenceInRedis(
  redis: Redis,
  userId: string,
  record: UserPresenceRecord,
  ttlSeconds = PRESENCE_TTL_SECONDS,
): Promise<void> {
  await redis.set(`${PRESENCE_USER_PREFIX}${userId}`, JSON.stringify(record), 'EX', ttlSeconds);
}

export async function getUsersPresenceFromRedis(
  redis: Redis,
  userIds: readonly string[],
): Promise<Map<string, UserPresenceRecord>> {
  const result = new Map<string, UserPresenceRecord>();
  if (userIds.length === 0) return result;
  const uniqueIds = Array.from(new Set(userIds));
  const keys = uniqueIds.map((id) => `${PRESENCE_USER_PREFIX}${id}`);
  const values = await redis.mget(...keys);
  uniqueIds.forEach((id, idx) => {
    const parsed = parseUserPresenceJson(values[idx] ?? null);
    if (parsed) {
      result.set(id, parsed);
    }
  });
  return result;
}

const MAX_ADMIN_NOTICES = 100;

function clampNonNegInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.round(parsed));
}

function clampNonNegFloat(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, parsed);
}

export function getEnvResourceLimitsDefaults(
  overrides: Partial<ResourceLimitsSettings> = {},
): ResourceLimitsSettings {
  return {
    maxDatabaseMb:
      overrides.maxDatabaseMb ??
      clampNonNegFloat(process.env.MAX_DATABASE_MB, 0, 1_000_000),
    perUserMaxLocationMb:
      overrides.perUserMaxLocationMb ??
      clampNonNegFloat(process.env.PER_USER_MAX_LOCATION_MB, 0, 100_000),
    perUserMaxPoints:
      overrides.perUserMaxPoints ??
      clampNonNegInt(process.env.PER_USER_MAX_POINTS, 0, 50_000_000),
    locationRetentionDays:
      overrides.locationRetentionDays ??
      clampNonNegInt(process.env.LOCATION_RETENTION_DAYS, 0, 3650),
    messageRetentionDays:
      overrides.messageRetentionDays ??
      clampNonNegInt(process.env.MESSAGE_RETENTION_DAYS, 0, 3650),
    placeEventRetentionDays:
      overrides.placeEventRetentionDays ??
      clampNonNegInt(process.env.PLACE_EVENT_RETENTION_DAYS, 0, 3650),
    resolvedRequestRetentionDays:
      overrides.resolvedRequestRetentionDays ??
      clampNonNegInt(process.env.RESOLVED_REQUEST_RETENTION_DAYS, 30, 365),
    maxMapStorageMb:
      overrides.maxMapStorageMb ??
      clampNonNegFloat(process.env.MAX_MAP_STORAGE_MB, 0, 1_000_000),
    autoTrimOnQuota:
      overrides.autoTrimOnQuota ?? process.env.AUTO_TRIM_ON_QUOTA !== 'false',
    updatedAt: overrides.updatedAt ?? null,
  };
}

export async function loadResourceLimitsSettings(
  redis: Redis,
  defaults: Partial<ResourceLimitsSettings> = {},
): Promise<ResourceLimitsSettings> {
  const base = getEnvResourceLimitsDefaults(defaults);
  try {
    const raw = await redis.get(RESOURCE_LIMITS_CONFIG_KEY);
    if (!raw) return base;
    const parsed = ResourceLimitsSettingsSchema.safeParse({ ...base, ...JSON.parse(raw) });
    return parsed.success ? parsed.data : base;
  } catch {
    return base;
  }
}

export async function saveResourceLimitsSettings(
  redis: Redis,
  patch: UpdateResourceLimitsInput,
  defaults: Partial<ResourceLimitsSettings> = {},
): Promise<ResourceLimitsSettings> {
  const current = await loadResourceLimitsSettings(redis, defaults);
  const next = ResourceLimitsSettingsSchema.parse({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  await redis.set(RESOURCE_LIMITS_CONFIG_KEY, JSON.stringify(next));
  return next;
}

function formatCompactTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatTrimNoticeMessage(params: {
  username: string | null;
  deletedPoints: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  scope: AdminNoticeScope | null;
}): string {
  const who = params.username ?? 'an account';
  const countStr = params.deletedPoints.toLocaleString('en-US');
  const rangeStr =
    params.rangeStart && params.rangeEnd
      ? params.rangeStart === params.rangeEnd
        ? `at ${formatCompactTimestamp(params.rangeStart)}`
        : `from ${formatCompactTimestamp(params.rangeStart)} to ${formatCompactTimestamp(params.rangeEnd)}`
      : 'in oldest history';
  const reason =
    params.scope === 'user_points'
      ? 'per-user point quota'
      : params.scope === 'user_storage'
        ? 'per-user storage quota'
        : params.scope === 'global_database'
          ? 'server database storage cap'
          : 'scheduled retention policy';
  return `Deleted ${countStr} location point(s) for ${who} (${rangeStr}) due to ${reason}.`;
}

function minIsoTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function listAdminNotices(redis: Redis): Promise<AdminNotice[]> {
  try {
    const raw = await redis.get(ADMIN_NOTICES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: AdminNotice[] = [];
    for (const item of parsed) {
      const res = AdminNoticeSchema.safeParse(item);
      if (res.success) valid.push(res.data);
    }
    return valid;
  } catch {
    return [];
  }
}

/**
 * Records a persistent Host Admin notice in Redis (surviving restarts until
 * dismissed). Consecutive `quota_trim` notices for the same `(userId, scope)`
 * are coalesced so total deleted points and full [rangeStart, rangeEnd] span
 * stay accurate without flooding the UI.
 */
export async function recordAdminNotice(
  redis: Redis,
  input: {
    kind: AdminNotice['kind'];
    severity?: AdminNotice['severity'];
    title?: string;
    message?: string;
    userId?: string | null;
    username?: string | null;
    deletedPoints?: number | null;
    rangeStart?: string | null;
    rangeEnd?: string | null;
    scope?: AdminNoticeScope | null;
    nowIso?: string;
  },
): Promise<AdminNotice> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const notices = await listAdminNotices(redis);

  if (
    input.kind === 'quota_trim' &&
    input.userId &&
    input.scope &&
    typeof input.deletedPoints === 'number' &&
    input.deletedPoints > 0
  ) {
    const existingIdx = notices.findIndex(
      (n) =>
        n.kind === 'quota_trim' &&
        n.userId === input.userId &&
        n.scope === input.scope,
    );
    if (existingIdx !== -1) {
      const existing = notices[existingIdx];
      const nextDeleted = (existing.deletedPoints ?? 0) + input.deletedPoints;
      const nextStart = minIsoTimestamp(existing.rangeStart, input.rangeStart ?? null);
      const nextEnd = maxIsoTimestamp(existing.rangeEnd, input.rangeEnd ?? null);
      const username = input.username ?? existing.username;
      const updated: AdminNotice = {
        ...existing,
        username,
        deletedPoints: nextDeleted,
        rangeStart: nextStart,
        rangeEnd: nextEnd,
        message:
          input.message ??
          formatTrimNoticeMessage({
            username,
            deletedPoints: nextDeleted,
            rangeStart: nextStart,
            rangeEnd: nextEnd,
            scope: input.scope,
          }),
        updatedAt: nowIso,
      };
      const nextList = [updated, ...notices.filter((_, idx) => idx !== existingIdx)].slice(
        0,
        MAX_ADMIN_NOTICES,
      );
      await redis.set(ADMIN_NOTICES_KEY, JSON.stringify(nextList));
      return updated;
    }
  }

  const deletedPoints = input.deletedPoints ?? null;
  const rangeStart = input.rangeStart ?? null;
  const rangeEnd = input.rangeEnd ?? null;
  const scope = input.scope ?? null;
  const username = input.username ?? null;
  const title =
    input.title ??
    (input.kind === 'quota_trim'
      ? `Auto-trimmed ${username ?? 'account'} location history`
      : 'System notice');
  const message =
    input.message ??
    (input.kind === 'quota_trim' && deletedPoints !== null
      ? formatTrimNoticeMessage({ username, deletedPoints, rangeStart, rangeEnd, scope })
      : title);

  const created = AdminNoticeSchema.parse({
    id: randomUUID(),
    kind: input.kind,
    severity: input.severity ?? (input.kind === 'quota_trim' ? 'warning' : 'info'),
    title,
    message,
    userId: input.userId ?? null,
    username,
    deletedPoints,
    rangeStart,
    rangeEnd,
    scope,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const nextList = [created, ...notices].slice(0, MAX_ADMIN_NOTICES);
  await redis.set(ADMIN_NOTICES_KEY, JSON.stringify(nextList));
  return created;
}

export async function dismissAdminNotice(redis: Redis, noticeId: string): Promise<boolean> {
  const notices = await listAdminNotices(redis);
  const filtered = notices.filter((n) => n.id !== noticeId);
  if (filtered.length === notices.length) return false;
  await redis.set(ADMIN_NOTICES_KEY, JSON.stringify(filtered));
  return true;
}

export async function dismissAllAdminNotices(redis: Redis): Promise<number> {
  const notices = await listAdminNotices(redis);
  if (notices.length === 0) return 0;
  await redis.del(ADMIN_NOTICES_KEY);
  return notices.length;
}

function parseRedisInfoMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return map;
}

export async function getRedisTelemetrySnapshot(redis: Redis): Promise<RedisTelemetry> {
  try {
    const [memInfoRaw, clientsInfoRaw, statsInfoRaw, maxMemConfig] = await Promise.all([
      redis.info('memory'),
      redis.info('clients').catch(() => ''),
      redis.info('stats').catch(() => ''),
      redis.config('GET', 'maxmemory').catch(() => null),
    ]);
    const mem = parseRedisInfoMap(memInfoRaw);
    const clients = parseRedisInfoMap(clientsInfoRaw);
    const stats = parseRedisInfoMap(statsInfoRaw);

    let maxMemoryBytes: number | null = Number.parseInt(mem.maxmemory ?? '', 10);
    if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes <= 0) {
      if (Array.isArray(maxMemConfig) && maxMemConfig.length >= 2) {
        const parsedCfg = Number.parseInt(String(maxMemConfig[1]), 10);
        maxMemoryBytes = Number.isFinite(parsedCfg) && parsedCfg > 0 ? parsedCfg : null;
      } else {
        maxMemoryBytes = null;
      }
    }

    const frag = Number.parseFloat(mem.mem_fragmentation_ratio ?? '');
    const connected = Number.parseInt(clients.connected_clients ?? '', 10);
    const opsPerSec = Number.parseInt(stats.instantaneous_ops_per_sec ?? '', 10);
    const evictedKeys = Number.parseInt(stats.evicted_keys ?? '', 10);

    return {
      available: true,
      usedMemoryBytes: Number.parseInt(mem.used_memory ?? '0', 10) || 0,
      usedMemoryRssBytes: Number.parseInt(mem.used_memory_rss ?? '0', 10) || 0,
      maxMemoryBytes,
      memFragmentationRatio: Number.isFinite(frag) ? Number(frag.toFixed(2)) : null,
      connectedClients: Number.isFinite(connected) ? connected : null,
      opsPerSec: Number.isFinite(opsPerSec) ? opsPerSec : null,
      evictedKeys: Number.isFinite(evictedKeys) ? evictedKeys : null,
      error: null,
    };
  } catch (err) {
    return {
      available: false,
      usedMemoryBytes: 0,
      usedMemoryRssBytes: 0,
      maxMemoryBytes: null,
      memFragmentationRatio: null,
      connectedClients: null,
      opsPerSec: null,
      evictedKeys: null,
      error: err instanceof Error ? err.message : 'Redis INFO unavailable',
    };
  }
}

export interface NodeDiskMountSpec {
  mountLabel: DiskMountTelemetry['mountLabel'];
  path: string;
}

async function computePathSizeBytes(targetPath: string, depth = 0): Promise<number> {
  if (depth > 4) return 0;
  try {
    const st = await fs.stat(targetPath);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = path.join(targetPath, entry.name);
      if (entry.isFile()) {
        const fst = await fs.stat(full).catch(() => null);
        if (fst) total += fst.size;
      } else if (entry.isDirectory()) {
        total += await computePathSizeBytes(full, depth + 1);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function readCgroupMemoryStats(systemTotalBytes: number): Promise<{
  limitBytes: number | null;
  usedBytes: number | null;
}> {
  const readInt = async (p: string): Promise<number | null> => {
    try {
      const raw = (await fs.readFile(p, 'utf8')).trim();
      if (!raw || raw === 'max') return null;
      const num = Number.parseInt(raw, 10);
      return Number.isFinite(num) && num > 0 ? num : null;
    } catch {
      return null;
    }
  };

  // cgroup v2
  let limit = await readInt('/sys/fs/cgroup/memory.max');
  let used = await readInt('/sys/fs/cgroup/memory.current');

  // cgroup v1 fallback
  if (limit === null) {
    limit = await readInt('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  }
  if (used === null) {
    used = await readInt('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  }

  // Filter out kernel "unlimited" sentinel values (>= ~1 TiB or > 2x host RAM)
  if (limit !== null && (limit > systemTotalBytes * 2 || limit > 1024 ** 5)) {
    limit = null;
  }
  return { limitBytes: limit, usedBytes: used };
}

export async function collectServiceNodeTelemetry(options: {
  service: string;
  instanceId?: string;
  version?: string | null;
  mounts?: NodeDiskMountSpec[];
  prevCpuUsage?: NodeJS.CpuUsage;
  prevHrTimeNs?: bigint;
}): Promise<{
  snapshot: ServiceNodeTelemetry;
  cpuUsage: NodeJS.CpuUsage;
  hrTimeNs: bigint;
}> {
  const nowHr = process.hrtime.bigint();
  const cpuUsage = process.cpuUsage();
  const hostname = os.hostname();
  const instanceId = options.instanceId ?? `${hostname}-${process.pid}`;
  const cpuCores = Math.max(1, os.cpus().length || 1);

  let cpuPercent = 0;
  if (options.prevCpuUsage && options.prevHrTimeNs) {
    const elapsedUs = Number(nowHr - options.prevHrTimeNs) / 1000;
    if (elapsedUs > 0) {
      const userDelta = Math.max(0, cpuUsage.user - options.prevCpuUsage.user);
      const sysDelta = Math.max(0, cpuUsage.system - options.prevCpuUsage.system);
      const rawPct = ((userDelta + sysDelta) / elapsedUs) * 100;
      cpuPercent = Number(Math.min(100 * cpuCores, Math.max(0, rawPct)).toFixed(2));
    }
  }

  const mem = process.memoryUsage();
  const systemMemTotalBytes = os.totalmem();
  const systemMemFreeBytes = os.freemem();
  const systemMemUsedBytes = Math.max(0, systemMemTotalBytes - systemMemFreeBytes);
  const cgroup = await readCgroupMemoryStats(systemMemTotalBytes);

  const disks: DiskMountTelemetry[] = [];
  for (const mount of options.mounts ?? []) {
    try {
      const resolved = path.resolve(mount.path);
      const st = await fs.stat(resolved).catch(() => null);
      if (!st) continue;
      if (typeof fs.statfs !== 'function') continue;
      const sfs = await fs.statfs(resolved);
      const bsize = Number(sfs.bsize);
      const totalBytes = Math.max(0, Number(sfs.blocks) * bsize);
      const freeBytes = Math.max(0, Number(sfs.bfree) * bsize);
      const availableBytes = Math.max(0, Number(sfs.bavail) * bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const pathSizeBytes = await computePathSizeBytes(resolved);
      disks.push({
        mountLabel: mount.mountLabel,
        path: resolved,
        fsId: `${st.dev}:${totalBytes}`,
        totalBytes,
        freeBytes,
        availableBytes,
        usedBytes,
        pathSizeBytes,
      });
    } catch {
      // Ignore inaccessible mount
    }
  }

  const loadAvg = os.loadavg();
  const snapshot: ServiceNodeTelemetry = {
    nodeKey: `${options.service}:${instanceId}`,
    service: options.service,
    instanceId,
    hostname,
    pid: process.pid,
    version: options.version ?? null,
    uptimeSeconds: Math.round(process.uptime()),
    cpuPercent,
    cpuCores,
    loadAvg1m: Number((loadAvg[0] ?? 0).toFixed(2)),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    systemMemTotalBytes,
    systemMemUsedBytes,
    cgroupMemLimitBytes: cgroup.limitBytes,
    cgroupMemUsedBytes: cgroup.usedBytes,
    disks,
    updatedAt: new Date().toISOString(),
  };

  return { snapshot, cpuUsage, hrTimeNs: nowHr };
}

export interface ServiceHeartbeatHandle {
  stop(): Promise<void>;
  beatNow(): Promise<ServiceNodeTelemetry>;
}

/**
 * Periodically publishes CPU, RAM, and mounted disk telemetry for this service
 * instance into Redis so separated/multi-host deployments report into /admin.
 */
export function startServiceHeartbeat(options: {
  service: string;
  redis: Redis;
  version?: string | null;
  mounts?: NodeDiskMountSpec[];
  intervalMs?: number;
  ttlSeconds?: number;
}): ServiceHeartbeatHandle {
  const intervalMs = Math.max(2000, options.intervalMs ?? 5000);
  const ttlSeconds = Math.max(10, options.ttlSeconds ?? 20);
  const instanceId = `${os.hostname()}-${process.pid}`;
  const key = `${TELEMETRY_NODE_PREFIX}${options.service}:${instanceId}`;

  let prevCpuUsage: NodeJS.CpuUsage | undefined;
  let prevHrTimeNs: bigint | undefined;
  let stopped = false;

  const beatNow = async (): Promise<ServiceNodeTelemetry> => {
    const res = await collectServiceNodeTelemetry({
      service: options.service,
      instanceId,
      version: options.version,
      mounts: options.mounts,
      prevCpuUsage,
      prevHrTimeNs,
    });
    prevCpuUsage = res.cpuUsage;
    prevHrTimeNs = res.hrTimeNs;
    if (!stopped) {
      await options.redis
        .set(key, JSON.stringify(res.snapshot), 'EX', ttlSeconds)
        .catch(() => {});
    }
    return res.snapshot;
  };

  void beatNow().catch(() => {});
  const timer = setInterval(() => {
    void beatNow().catch(() => {});
  }, intervalMs);
  timer.unref();

  return {
    beatNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await options.redis.del(key).catch(() => {});
    },
  };
}

/**
 * Convenience wrapper for services without their own ioredis dependency (such as
 * map-service or Next.js web-dashboard instrumentation). Connects to `redisUrl`,
 * publishes heartbeats, and closes the connection on `stop()`.
 */
export function startServiceHeartbeatFromUrl(options: {
  service: string;
  redisUrl?: string;
  version?: string | null;
  mounts?: NodeDiskMountSpec[];
  intervalMs?: number;
  ttlSeconds?: number;
}): ServiceHeartbeatHandle | null {
  const url = options.redisUrl?.trim();
  if (!url) return null;

  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  client.on('error', () => {});
  void client.connect().catch(() => {});

  const inner = startServiceHeartbeat({
    service: options.service,
    redis: client,
    version: options.version,
    mounts: options.mounts,
    intervalMs: options.intervalMs,
    ttlSeconds: options.ttlSeconds,
  });

  return {
    beatNow: () => inner.beatNow(),
    async stop() {
      await inner.stop();
      await client.quit().catch(() => client.disconnect());
    },
  };
}

export async function listClusterNodeTelemetry(redis: Redis): Promise<ServiceNodeTelemetry[]> {
  try {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(
        cursor,
        'MATCH',
        `${TELEMETRY_NODE_PREFIX}*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < 500);

    if (keys.length === 0) return [];
    const values = await redis.mget(...keys);
    const nodes: ServiceNodeTelemetry[] = [];
    for (const raw of values) {
      if (!raw) continue;
      try {
        const parsed = ServiceNodeTelemetrySchema.safeParse(JSON.parse(raw));
        if (parsed.success) nodes.push(parsed.data);
      } catch {
        // ignore malformed node record
      }
    }
    nodes.sort((a, b) => {
      if (a.service !== b.service) return a.service.localeCompare(b.service);
      return a.instanceId.localeCompare(b.instanceId);
    });
    return nodes;
  } catch {
    return [];
  }
}

export function getCurrentMinuteBucket(nowMs = Date.now()): number {
  return Math.floor(nowMs / 60_000);
}

export async function recordUserTelemetry(
  redis: Redis,
  userId: string,
  elapsedMs: number,
  eventIncrement = 1,
  nowMs = Date.now(),
): Promise<void> {
  const safeMs = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0;
  const bucket = getCurrentMinuteBucket(nowMs);
  const hashKey = `${TELEMETRY_USER_PREFIX}${userId}`;
  const cpuMinKey = `${TELEMETRY_USER_PREFIX}${userId}:cpu_min:${bucket}`;
  const eventsMinKey = `${TELEMETRY_USER_PREFIX}${userId}:events_min:${bucket}`;

  const pipeline = redis.pipeline();
  pipeline.hincrbyfloat(hashKey, 'cpu_ms', safeMs);
  pipeline.hincrby(hashKey, 'events_count', eventIncrement);
  pipeline.hset(hashKey, 'last_seen_ms', String(nowMs));
  pipeline.incrbyfloat(cpuMinKey, safeMs);
  pipeline.expire(cpuMinKey, 180);
  pipeline.incrby(eventsMinKey, eventIncrement);
  pipeline.expire(eventsMinKey, 180);
  await pipeline.exec();
}

export async function trackUserSocket(
  redis: Redis,
  userId: string,
  socketId: string,
  action: 'connect' | 'disconnect',
): Promise<void> {
  const key = `${SOCKETS_USER_PREFIX}${userId}`;
  if (action === 'connect') {
    await redis.sadd(key, socketId);
    await redis.expire(key, 86400);
  } else {
    await redis.srem(key, socketId);
  }
}

export interface RedisUserTelemetrySnapshot {
  cpuMsTotal: number;
  cpuMsPerMin: number;
  eventsCount: number;
  pingsPerMin: number;
  activeSockets: number;
  redisMemoryBytes: number;
}

export async function getUserTelemetryFromRedis(
  redis: Redis,
  userId: string,
  nowMs = Date.now(),
): Promise<RedisUserTelemetrySnapshot> {
  const bucket = getCurrentMinuteBucket(nowMs);
  const prevBucket = bucket - 1;
  const hashKey = `${TELEMETRY_USER_PREFIX}${userId}`;
  const sessionKey = `${SESSION_USER_PREFIX}${userId}`;
  const socketsKey = `${SOCKETS_USER_PREFIX}${userId}`;

  const [hashData, curCpu, prevCpu, curEvents, prevEvents, activeSockets, memUsage] =
    await Promise.all([
      redis.hgetall(hashKey),
      redis.get(`${TELEMETRY_USER_PREFIX}${userId}:cpu_min:${bucket}`),
      redis.get(`${TELEMETRY_USER_PREFIX}${userId}:cpu_min:${prevBucket}`),
      redis.get(`${TELEMETRY_USER_PREFIX}${userId}:events_min:${bucket}`),
      redis.get(`${TELEMETRY_USER_PREFIX}${userId}:events_min:${prevBucket}`),
      redis.scard(socketsKey),
      redis.call('MEMORY', 'USAGE', sessionKey).catch(() => 0),
    ]);

  const cpuMsTotal = Number.parseFloat(hashData.cpu_ms ?? '0') || 0;
  const eventsCount = Number.parseInt(hashData.events_count ?? '0', 10) || 0;
  const cpuCurVal = Number.parseFloat(curCpu ?? '0') || 0;
  const cpuPrevVal = Number.parseFloat(prevCpu ?? '0') || 0;
  const evCurVal = Number.parseInt(curEvents ?? '0', 10) || 0;
  const evPrevVal = Number.parseInt(prevEvents ?? '0', 10) || 0;

  return {
    cpuMsTotal: Number(cpuMsTotal.toFixed(3)),
    cpuMsPerMin: Number(Math.max(cpuCurVal, cpuPrevVal).toFixed(3)),
    eventsCount,
    pingsPerMin: Math.max(evCurVal, evPrevVal),
    activeSockets,
    redisMemoryBytes: typeof memUsage === 'number' ? memUsage : Number(memUsage ?? 0) || 0,
  };
}
