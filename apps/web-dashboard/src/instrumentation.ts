export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const redisUrl = (process.env.REDIS_URL ?? '').trim();
  if (!redisUrl) return;

  const g = globalThis as typeof globalThis & {
    __lovedOnesWebHeartbeatStarted?: boolean;
  };
  if (g.__lovedOnesWebHeartbeatStarted) return;
  g.__lovedOnesWebHeartbeatStarted = true;

  const { startServiceHeartbeatFromUrl } = await import('@loved-ones/shared/telemetry');
  startServiceHeartbeatFromUrl({
    service: 'web-dashboard',
    redisUrl,
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
  });
}
