import { DatabaseTelemetryResult } from '@loved-ones/db';
import {
  AdminNotice,
  LogRetentionSettings,
  MapStorageSummary,
  RedisTelemetry,
  ResourceLimitsSettings,
  ServiceNodeTelemetry,
  SystemTelemetry,
} from '@loved-ones/shared';
import {
  getEnvResourceLimitsDefaults,
  RedisUserTelemetrySnapshot,
} from '@loved-ones/shared/telemetry';

export interface TelemetryQueryStore {
  computeLogStorageBytes(): Promise<number>;
  getDatabaseTelemetry(): Promise<DatabaseTelemetryResult>;
  getUserTelemetry(userId: string): Promise<RedisUserTelemetrySnapshot>;
  getRecentLogLines(limit: number): Promise<string[]>;
  getRedisTelemetry?(): Promise<RedisTelemetry>;
  getClusterNodes?(): Promise<ServiceNodeTelemetry[]>;
  listAdminNotices?(): Promise<AdminNotice[]>;
}

export interface TelemetryQueryModuleOptions {
  store: TelemetryQueryStore;
  logDir: string;
  maxLogStorageMb: number;
  getLogRetention?: () => Promise<LogRetentionSettings>;
  getResourceLimits?: () => Promise<ResourceLimitsSettings>;
  getMapStorageSummary?: () => Promise<MapStorageSummary>;
  now?: () => Date;
}

/**
 * Deep query module aggregating host disk log footprint, PostGIS user/table
 * storage, cluster service node CPU/RAM/disks, Redis stats, and persistent
 * Host Admin notices into a TelemetrySnapshot.
 */
export class TelemetryQueryModule {
  private readonly store: TelemetryQueryStore;
  private readonly logDir: string;
  private readonly maxLogStorageMb: number;
  private readonly getLogRetention?: () => Promise<LogRetentionSettings>;
  private readonly getResourceLimits?: () => Promise<ResourceLimitsSettings>;
  private readonly getMapStorageSummary?: () => Promise<MapStorageSummary>;
  private readonly now: () => Date;

  constructor(options: TelemetryQueryModuleOptions) {
    this.store = options.store;
    this.logDir = options.logDir;
    this.maxLogStorageMb = options.maxLogStorageMb;
    this.getLogRetention = options.getLogRetention;
    this.getResourceLimits = options.getResourceLimits;
    this.getMapStorageSummary = options.getMapStorageSummary;
    this.now = options.now ?? (() => new Date());
  }

  async getSystemTelemetry(): Promise<SystemTelemetry> {
    const [
      logStorageBytes,
      dbTelemetry,
      retention,
      resourceLimits,
      redisStats,
      nodes,
      mapStorage,
      notices,
    ] = await Promise.all([
      this.store.computeLogStorageBytes(),
      this.store.getDatabaseTelemetry(),
      this.getLogRetention ? this.getLogRetention().catch(() => null) : Promise.resolve(null),
      this.getResourceLimits ? this.getResourceLimits().catch(() => null) : Promise.resolve(null),
      this.store.getRedisTelemetry
        ? this.store.getRedisTelemetry().catch(() => null)
        : Promise.resolve(null),
      this.store.getClusterNodes
        ? this.store.getClusterNodes().catch(() => [])
        : Promise.resolve([]),
      this.getMapStorageSummary
        ? this.getMapStorageSummary().catch(() => null)
        : Promise.resolve(null),
      this.store.listAdminNotices
        ? this.store.listAdminNotices().catch(() => [])
        : Promise.resolve([]),
    ]);

    const effectiveMaxMb = retention?.maxStorageMb ?? this.maxLogStorageMb;
    const maxLogStorageBytes = Math.round(effectiveMaxMb * 1024 * 1024);
    const logStoragePercent =
      maxLogStorageBytes > 0
        ? Number(((logStorageBytes / maxLogStorageBytes) * 100).toFixed(2))
        : 0;

    const users = await Promise.all(
      dbTelemetry.users.map(async (u) => {
        const redisStatsForUser = await this.store.getUserTelemetry(u.userId);
        const estimatedIndexBytes = u.estimatedIndexBytes ?? 0;
        const messageBytes = u.messageBytes ?? 0;
        const avatarBytes = u.avatarBytes ?? 0;
        return {
          userId: u.userId,
          username: u.username,
          email: u.email,
          role: u.role,
          locationBytes: u.locationBytes,
          locationPoints: u.locationPoints,
          estimatedIndexBytes,
          messageBytes,
          messageCount: u.messageCount ?? 0,
          avatarBytes,
          placeEventCount: u.placeEventCount ?? 0,
          totalDbBytes:
            u.totalDbBytes ?? u.locationBytes + estimatedIndexBytes + messageBytes + avatarBytes,
          ...redisStatsForUser,
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
      ...(dbTelemetry.breakdown ? { databaseBreakdown: dbTelemetry.breakdown } : {}),
      ...(mapStorage ? { mapStorage } : {}),
      ...(redisStats ? { redis: redisStats } : {}),
      nodes,
      resourceLimits: resourceLimits ?? getEnvResourceLimitsDefaults(),
      notices,
    };
  }

  async getRecentLogs(limit = 200): Promise<{ logs: string[] }> {
    const lines = await this.store.getRecentLogLines(limit);
    return { logs: lines.reverse() };
  }
}
