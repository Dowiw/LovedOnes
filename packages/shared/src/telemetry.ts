import { Redis } from 'ioredis';

export const TELEMETRY_USER_PREFIX = 'telemetry:user:';
export const SESSION_USER_PREFIX = 'session:user:';
export const SOCKETS_USER_PREFIX = 'sockets:user:';
export const TRACKER_JTI_USER_PREFIX = 'tracker:jti:user:';
export const REMOVED_USER_PREFIX = 'removed:user:';
export const USER_PROFILE_UPDATED_CHANNEL = 'user:profile:updated';
export const USER_ACCOUNT_REMOVED_CHANNEL = 'user:account:removed';

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
