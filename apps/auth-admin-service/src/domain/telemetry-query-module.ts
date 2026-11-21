import { DatabaseTelemetryResult } from '@loved-ones/db';
import { LogRetentionSettings, SystemTelemetry } from '@loved-ones/shared';
import { RedisUserTelemetrySnapshot } from '@loved-ones/shared/telemetry';

export interface TelemetryQueryStore {
  computeLogStorageBytes(): Promise<number>;
  getDatabaseTelemetry(): Promise<DatabaseTelemetryResult>;
  getUserTelemetry(userId: string): Promise<RedisUserTelemetrySnapshot>;
  getRecentLogLines(limit: number): Promise<string[]>;
}

export interface TelemetryQueryModuleOptions {
  store: TelemetryQueryStore;
  logDir: string;
  maxLogStorageMb: number;
  getLogRetention?: () => Promise<LogRetentionSettings>;
  now?: () => Date;
}

/**
 * Deep query module aggregating host disk log footprint, PostGIS user storage,
 * and per-Account Redis telemetry into a TelemetrySnapshot.
 */
export class TelemetryQueryModule {
  private readonly store: TelemetryQueryStore;
  private readonly logDir: string;
  private readonly maxLogStorageMb: number;
  private readonly getLogRetention?: () => Promise<LogRetentionSettings>;
  private readonly now: () => Date;

  constructor(options: TelemetryQueryModuleOptions) {
    this.store = options.store;
    this.logDir = options.logDir;
    this.maxLogStorageMb = options.maxLogStorageMb;
    this.getLogRetention = options.getLogRetention;
    this.now = options.now ?? (() => new Date());
  }

  async getSystemTelemetry(): Promise<SystemTelemetry> {
    const [logStorageBytes, dbTelemetry, retention] = await Promise.all([
      this.store.computeLogStorageBytes(),
      this.store.getDatabaseTelemetry(),
      this.getLogRetention ? this.getLogRetention().catch(() => null) : Promise.resolve(null),
    ]);

    const effectiveMaxMb = retention?.maxStorageMb ?? this.maxLogStorageMb;
    const maxLogStorageBytes = Math.round(effectiveMaxMb * 1024 * 1024);
    const logStoragePercent =
      maxLogStorageBytes > 0
        ? Number(((logStorageBytes / maxLogStorageBytes) * 100).toFixed(2))
        : 0;

    const users = await Promise.all(
      dbTelemetry.users.map(async (u) => {
        const redisStats = await this.store.getUserTelemetry(u.userId);
        return {
          userId: u.userId,
          username: u.username,
          email: u.email,
          role: u.role,
          locationBytes: u.locationBytes,
          locationPoints: u.locationPoints,
          ...redisStats,
        };
      }),
    );

    users.sort((a, b) => {
      if (b.cpuMsPerMin !== a.cpuMsPerMin) return b.cpuMsPerMin - a.cpuMsPerMin;
      return b.eventsCount - a.eventsCount;
    });

    const totalLocationPoints = users.reduce((acc, u) => acc + u.locationPoints, 0);
    const totalActiveSockets = users.reduce((acc, u) => acc + u.activeSockets, 0);

    return {
      timestamp: this.now().toISOString(),
      logDir: this.logDir,
      logStorageBytes,
      maxLogStorageBytes,
      logStoragePercent,
      logStorageAlert: logStoragePercent >= 80,
      databaseBytes: dbTelemetry.databaseBytes,
      totalLocationPoints,
      totalActiveSockets,
      users,
    };
  }

  async getRecentLogs(limit = 200): Promise<{ logs: string[] }> {
    const lines = await this.store.getRecentLogLines(limit);
    return { logs: lines.reverse() };
  }
}
