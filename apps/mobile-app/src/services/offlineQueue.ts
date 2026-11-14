import type { LocationPoint } from '@loved-ones/shared';

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
          speed REAL,
          battery_level INTEGER,
          recorded_at TEXT NOT NULL
        );
      `);

      return {
        async enqueue(points: LocationPoint[]) {
          for (const pt of points) {
            await db.runAsync(
              `INSERT INTO queued_locations (latitude, longitude, altitude, speed, battery_level, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              pt.latitude,
              pt.longitude,
              pt.altitude ?? null,
              pt.speed ?? null,
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
            speed: number | null;
            battery_level: number | null;
            recorded_at: string;
          }>('SELECT * FROM queued_locations ORDER BY id ASC LIMIT ?', limit);

          return result.map((r) => ({
            id: r.id,
            latitude: r.latitude,
            longitude: r.longitude,
            altitude: r.altitude,
            speed: r.speed,
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

export async function flushOfflineLocations(
  serverUrl: string,
  accessToken: string,
  storage?: OfflineQueueStorage,
  fetchImpl: typeof fetch = fetch,
  batchSize = 100,
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
    speed: row.speed ?? null,
    batteryLevel: row.batteryLevel ?? null,
    recordedAt: row.recordedAt,
  }));

  const cleanBase = serverUrl.replace(/\/$/, '');
  const response = await fetchImpl(`${cleanBase}/api/realtime/locations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ points }),
  });

  if (!response.ok) {
    throw new Error(`Batch upload failed with HTTP ${response.status}`);
  }

  await s.deleteByIds(pending.map((row) => row.id));
  const remaining = await s.count();
  return { flushed: pending.length, remaining };
}
