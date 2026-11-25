import type { LocationPoint } from '@loved-ones/shared';
import { formatUserError } from './errorFormatter';
import { getStoredConfig, saveStoredConfig } from './secureConfig';

export interface QueuedLocationRow extends LocationPoint {
  id: number;
}

export interface OfflineQueueStorage {
  enqueue(points: LocationPoint[]): Promise<void>;
  getPending(limit: number): Promise<QueuedLocationRow[]>;
  deleteByIds(ids: number[]): Promise<void>;
  count(): Promise<number>;
}

export function createInMemoryQueueStorage(): OfflineQueueStorage {
  let nextId = 1;
  let rows: QueuedLocationRow[] = [];

  return {
    async enqueue(points: LocationPoint[]) {
      for (const p of points) {
        rows.push({ ...p, id: nextId++ });
      }
    },
    async getPending(limit: number) {
      return rows.slice(0, limit);
    },
    async deleteByIds(ids: number[]) {
      const idSet = new Set(ids);
      rows = rows.filter((r) => !idSet.has(r.id));
    },
    async count() {
      return rows.length;
    },
  };
}

let sqliteStoragePromise: Promise<OfflineQueueStorage> | null = null;

export async function getSqliteQueueStorage(): Promise<OfflineQueueStorage> {
  if (!sqliteStoragePromise) {
    sqliteStoragePromise = (async () => {
      const SQLite = await import('expo-sqlite');
      const db = await SQLite.openDatabaseAsync('lovedones_queue.db');
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS queued_locations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          altitude REAL,
          accuracy REAL,
          speed REAL,
          heading REAL,
          activity TEXT,
          battery_level INTEGER,
          recorded_at TEXT NOT NULL
        );
      `);
      // Migrate existing device queues created before accuracy, heading, or activity tracking were added
      for (const ddl of [
        'ALTER TABLE queued_locations ADD COLUMN accuracy REAL;',
        'ALTER TABLE queued_locations ADD COLUMN heading REAL;',
        'ALTER TABLE queued_locations ADD COLUMN activity TEXT;',
      ]) {
        try {
          await db.execAsync(ddl);
        } catch {
          // Column already exists
        }
      }

      return {
        async enqueue(points: LocationPoint[]) {
          for (const pt of points) {
            await db.runAsync(
              `INSERT INTO queued_locations (latitude, longitude, altitude, accuracy, speed, heading, activity, battery_level, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              pt.latitude,
              pt.longitude,
              pt.altitude ?? null,
              pt.accuracy ?? null,
              pt.speed ?? null,
              pt.heading ?? null,
              pt.activity ?? null,
              pt.batteryLevel ?? null,
              pt.recordedAt,
            );
          }
        },
        async getPending(limit: number): Promise<QueuedLocationRow[]> {
          const result = await db.getAllAsync<{
            id: number;
            latitude: number;
            longitude: number;
            altitude: number | null;
            accuracy: number | null;
            speed: number | null;
            heading: number | null;
            activity: LocationPoint['activity'];
            battery_level: number | null;
            recorded_at: string;
          }>('SELECT * FROM queued_locations ORDER BY id ASC LIMIT ?', limit);

          return result.map((r) => ({
            id: r.id,
            latitude: r.latitude,
            longitude: r.longitude,
            altitude: r.altitude,
            accuracy: r.accuracy,
            speed: r.speed,
            heading: r.heading ?? null,
            activity: r.activity ?? null,
            batteryLevel: r.battery_level,
            recordedAt: r.recorded_at,
          }));
        },
        async deleteByIds(ids: number[]) {
          if (ids.length === 0) return;
          const placeholders = ids.map(() => '?').join(', ');
          await db.runAsync(`DELETE FROM queued_locations WHERE id IN (${placeholders})`, ...ids);
        },
        async count(): Promise<number> {
          const row = await db.getFirstAsync<{ cnt: number }>(
            'SELECT COUNT(*) AS cnt FROM queued_locations',
          );
          return row?.cnt ?? 0;
        },
      };
    })();
  }
  return sqliteStoragePromise;
}

export async function enqueueLocationPoints(
  points: LocationPoint[],
  storage?: OfflineQueueStorage,
): Promise<void> {
  if (points.length === 0) return;
  const s = storage ?? (await getSqliteQueueStorage());
  await s.enqueue(points);
}

export async function getPendingLocationCount(storage?: OfflineQueueStorage): Promise<number> {
  const s = storage ?? (await getSqliteQueueStorage());
  return s.count();
}

export interface BackgroundAuthOptions {
  refreshToken?: string | null;
  onTokensRefreshed?: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
}

/**
 * Sends an authenticated JSON POST from background or foreground tasks, automatically
 * refreshing an expired accessToken once via /api/auth/refresh when refreshToken is present.
 */
export async function postBackgroundAuthedJson(
  serverUrl: string,
  path: string,
  accessToken: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
  authOptions?: BackgroundAuthOptions,
): Promise<Response> {
  const cleanBase = serverUrl.replace(/\/$/, '');
  const send = (token: string) =>
    fetchImpl(`${cleanBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

  let response: Response;
  try {
    response = await send(accessToken);
  } catch (err) {
    throw new Error(
      formatUserError(err, 'Unable to reach the server. Check your internet connection or server URL.'),
    );
  }

  if (response.status === 401) {
    const refreshToken =
      authOptions && 'refreshToken' in authOptions
        ? authOptions.refreshToken
        : (await getStoredConfig().catch(() => null))?.refreshToken;
    if (refreshToken) {
      try {
        const refreshRes = await fetchImpl(`${cleanBase}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshRes.ok) {
          const tokens = (await refreshRes.json()) as {
            accessToken?: string;
            refreshToken?: string;
          };
          if (tokens.accessToken && tokens.refreshToken) {
            if (authOptions?.onTokensRefreshed) {
              await authOptions.onTokensRefreshed({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
              });
            } else {
              await saveStoredConfig({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
              });
            }
            response = await send(tokens.accessToken);
          }
        }
      } catch {
        // Return original 401 response if refresh attempt failed due to connectivity
      }
    }
  }

  return response;
}

export async function flushOfflineLocations(
  serverUrl: string,
  accessToken: string,
  storage?: OfflineQueueStorage,
  fetchImpl: typeof fetch = fetch,
  batchSize = 100,
  authOptions?: BackgroundAuthOptions,
): Promise<{ flushed: number; remaining: number }> {
  const s = storage ?? (await getSqliteQueueStorage());
  const pending = await s.getPending(batchSize);
  if (pending.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  const points: LocationPoint[] = pending.map((row) => ({
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude ?? null,
    accuracy: row.accuracy ?? null,
    speed: row.speed ?? null,
    heading: row.heading ?? null,
    activity: row.activity ?? null,
    batteryLevel: row.batteryLevel ?? null,
    recordedAt: row.recordedAt,
  }));

  const response = await postBackgroundAuthedJson(
    serverUrl,
    '/api/realtime/locations',
    accessToken,
    { points },
    fetchImpl,
    authOptions,
  );

  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    throw new Error(formatUserError(err, 'Unable to sync queued locations right now.'));
  }

  await s.deleteByIds(pending.map((row) => row.id));
  const remaining = await s.count();
  return { flushed: pending.length, remaining };
}
