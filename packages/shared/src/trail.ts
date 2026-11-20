export const DEFAULT_TRAIL_CLUSTER_RADIUS_METERS = 85;
const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_DEGREE_LAT = 111_320;

export interface TrailPingLike {
  userId: string;
  username: string;
  latitude: number;
  longitude: number;
  recordedAt: string;
  isFuzzed?: boolean;
}

export interface AveragedTrailStop {
  userId: string;
  username: string;
  latitude: number;
  longitude: number;
  pingCount: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  isFuzzed: boolean;
}

export interface CompactUserTrail {
  userId: string;
  username: string;
  stops: AveragedTrailStop[];
  /** Chronological [longitude, latitude] vertices with consecutive same-stop duplicates collapsed. */
  pathCoordinates: [number, number][];
}

export interface AverageTrailPingsOptions {
  clusterRadiusMeters?: number;
}

interface RawCoordSample {
  lat: number;
  lon: number;
}

interface MutableCluster {
  id: number;
  version: number;
  active: boolean;
  isFuzzed: boolean;
  username: string;
  latSum: number;
  lonSum: number;
  count: number;
  centroidLat: number;
  centroidLon: number;
  cx: number;
  cy: number;
  firstRecordedAt: string;
  firstTimeMs: number;
  lastRecordedAt: string;
  lastTimeMs: number;
  points: RawCoordSample[];
}

interface HeapPair {
  dist: number;
  aId: number;
  aVer: number;
  bId: number;
  bVer: number;
}

/** Great-circle surface distance in meters between two WGS84 coordinates. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roundCoord(value: number): number {
  return Number(value.toFixed(6));
}

function makeCellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function addToGrid(grid: Map<string, Set<number>>, cluster: MutableCluster): void {
  const key = makeCellKey(cluster.cx, cluster.cy);
  let bucket = grid.get(key);
  if (!bucket) {
    bucket = new Set<number>();
    grid.set(key, bucket);
  }
  bucket.add(cluster.id);
}

function removeFromGrid(grid: Map<string, Set<number>>, cluster: MutableCluster): void {
  const key = makeCellKey(cluster.cx, cluster.cy);
  const bucket = grid.get(key);
  if (!bucket) return;
  bucket.delete(cluster.id);
  if (bucket.size === 0) grid.delete(key);
}

function pushHeap(heap: HeapPair[], item: HeapPair): void {
  heap.push(item);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (heap[parent].dist <= item.dist) break;
    heap[idx] = heap[parent];
    idx = parent;
  }
  heap[idx] = item;
}

function popHeap(heap: HeapPair[]): HeapPair | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    let idx = 0;
    const len = heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (left < len && heap[left].dist < heap[smallest].dist) smallest = left;
      if (right < len && heap[right].dist < heap[smallest].dist) smallest = right;
      if (smallest === idx) break;
      heap[idx] = heap[smallest];
      idx = smallest;
    }
    heap[idx] = last;
  }
  return top;
}

function allSamplesWithinRadius(
  samples: readonly RawCoordSample[],
  targetLat: number,
  targetLon: number,
  radiusMeters: number,
): boolean {
  for (const s of samples) {
    if (haversineMeters(s.lat, s.lon, targetLat, targetLon) > radiusMeters) {
      return false;
    }
  }
  return true;
}

function compactSingleUserTrail(
  userId: string,
  rawPoints: readonly TrailPingLike[],
  radiusMeters: number,
): CompactUserTrail {
  const sorted = [...rawPoints].sort((a, b) => {
    const ta = Date.parse(a.recordedAt);
    const tb = Date.parse(b.recordedAt);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return a.recordedAt.localeCompare(b.recordedAt);
  });

  const latestUsername = sorted[sorted.length - 1]?.username ?? 'Member';
  if (sorted.length === 0) {
    return { userId, username: latestUsername, stops: [], pathCoordinates: [] };
  }

  if (radiusMeters <= 0 || sorted.length === 1) {
    const stops: AveragedTrailStop[] = sorted.map((pt) => ({
      userId,
      username: pt.username,
      latitude: roundCoord(pt.latitude),
      longitude: roundCoord(pt.longitude),
      pingCount: 1,
      firstRecordedAt: pt.recordedAt,
      lastRecordedAt: pt.recordedAt,
      isFuzzed: Boolean(pt.isFuzzed),
    }));
    return {
      userId,
      username: latestUsername,
      stops,
      pathCoordinates: stops.map((s) => [s.longitude, s.latitude]),
    };
  }

  const maxAbsLat = sorted.reduce((acc, p) => Math.max(acc, Math.abs(p.latitude)), 0);
  const cosLat = Math.max(0.08, Math.cos((Math.min(85, maxAbsLat) * Math.PI) / 180));
  const cellLatDeg = Math.max((radiusMeters * 1.05) / METERS_PER_DEGREE_LAT, 1e-6);
  const cellLonDeg = cellLatDeg / cosLat;

  const microRadius = Math.min(10, radiusMeters * 0.15);
  const microCellLat = Math.max((microRadius * 1.05) / METERS_PER_DEGREE_LAT, 1e-6);
  const microCellLon = microCellLat / cosLat;
  const microGrid = new Map<string, Set<number>>();

  const clusters: MutableCluster[] = [];
  const pingToCluster: number[] = new Array(sorted.length);

  // Phase 1: fast linear micro-clustering of sub-10m duplicates/bursts so dense stays stay O(1)
  for (let i = 0; i < sorted.length; i += 1) {
    const pt = sorted[i];
    const isFuzzed = Boolean(pt.isFuzzed);
    const timeMs = Date.parse(pt.recordedAt);
    const normTime = Number.isFinite(timeMs) ? timeMs : i;
    const mCx = Math.floor(pt.latitude / microCellLat);
    const mCy = Math.floor(pt.longitude / microCellLon);

    let target: MutableCluster | null = null;
    let bestDist = Infinity;

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = microGrid.get(makeCellKey(mCx + dx, mCy + dy));
        if (!bucket) continue;
        for (const cid of bucket) {
          const cand = clusters[cid];
          if (cand.isFuzzed !== isFuzzed) continue;
          const dist = haversineMeters(pt.latitude, pt.longitude, cand.centroidLat, cand.centroidLon);
          if (dist <= microRadius && dist < bestDist) {
            bestDist = dist;
            target = cand;
          }
        }
      }
    }

    if (target) {
      const nextCount = target.count + 1;
      const nextLatSum = target.latSum + pt.latitude;
      const nextLonSum = target.lonSum + pt.longitude;
      const nextLat = nextLatSum / nextCount;
      const nextLon = nextLonSum / nextCount;
      const canAbsorb =
        distWithinTolerance(target.points, pt, nextLat, nextLon, microRadius, radiusMeters);
      if (canAbsorb) {
        target.count = nextCount;
        target.latSum = nextLatSum;
        target.lonSum = nextLonSum;
        target.centroidLat = nextLat;
        target.centroidLon = nextLon;
        target.username = pt.username;
        target.points.push({ lat: pt.latitude, lon: pt.longitude });
        if (normTime < target.firstTimeMs) {
          target.firstTimeMs = normTime;
          target.firstRecordedAt = pt.recordedAt;
        }
        if (normTime >= target.lastTimeMs) {
          target.lastTimeMs = normTime;
          target.lastRecordedAt = pt.recordedAt;
        }
        pingToCluster[i] = target.id;
        continue;
      }
    }

    const id = clusters.length;
    const created: MutableCluster = {
      id,
      version: 0,
      active: true,
      isFuzzed,
      username: pt.username,
      latSum: pt.latitude,
      lonSum: pt.longitude,
      count: 1,
      centroidLat: pt.latitude,
      centroidLon: pt.longitude,
      cx: Math.floor(pt.latitude / cellLatDeg),
      cy: Math.floor(pt.longitude / cellLonDeg),
      firstRecordedAt: pt.recordedAt,
      firstTimeMs: normTime,
      lastRecordedAt: pt.recordedAt,
      lastTimeMs: normTime,
      points: [{ lat: pt.latitude, lon: pt.longitude }],
    };
    clusters.push(created);
    let mBucket = microGrid.get(makeCellKey(mCx, mCy));
    if (!mBucket) {
      mBucket = new Set<number>();
      microGrid.set(makeCellKey(mCx, mCy), mBucket);
    }
    mBucket.add(id);
    pingToCluster[i] = id;
  }

  // Phase 2: bounded agglomerative centroid merging within clusterRadiusMeters
  const grid = new Map<string, Set<number>>();
  for (const c of clusters) {
    addToGrid(grid, c);
  }

  const heap: HeapPair[] = [];
  const enqueueNeighbors = (cluster: MutableCluster, minOtherId: number) => {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(makeCellKey(cluster.cx + dx, cluster.cy + dy));
        if (!bucket) continue;
        for (const otherId of bucket) {
          if (otherId === cluster.id || otherId < minOtherId) continue;
          const other = clusters[otherId];
          if (!other.active || other.isFuzzed !== cluster.isFuzzed) continue;
          const dist = haversineMeters(
            cluster.centroidLat,
            cluster.centroidLon,
            other.centroidLat,
            other.centroidLon,
          );
          if (dist <= radiusMeters) {
            pushHeap(heap, {
              dist,
              aId: cluster.id,
              aVer: cluster.version,
              bId: other.id,
              bVer: other.version,
            });
          }
        }
      }
    }
  };

  for (const c of clusters) {
    enqueueNeighbors(c, c.id + 1);
  }

  const mergedInto = clusters.map((c) => c.id);
  const resolveClusterId = (id: number): number => {
    let cur = id;
    while (mergedInto[cur] !== cur) {
      cur = mergedInto[cur];
    }
    let walker = id;
    while (walker !== cur) {
      const next = mergedInto[walker];
      mergedInto[walker] = cur;
      walker = next;
    }
    return cur;
  };

  while (heap.length > 0) {
    const pair = popHeap(heap)!;
    const a = clusters[pair.aId];
    const b = clusters[pair.bId];
    if (!a.active || !b.active || a.version !== pair.aVer || b.version !== pair.bVer) {
      continue;
    }

    const totalCount = a.count + b.count;
    const mergedLat = (a.latSum + b.latSum) / totalCount;
    const mergedLon = (a.lonSum + b.lonSum) / totalCount;

    if (
      !allSamplesWithinRadius(a.points, mergedLat, mergedLon, radiusMeters) ||
      !allSamplesWithinRadius(b.points, mergedLat, mergedLon, radiusMeters)
    ) {
      continue;
    }

    removeFromGrid(grid, a);
    removeFromGrid(grid, b);

    a.latSum += b.latSum;
    a.lonSum += b.lonSum;
    a.count = totalCount;
    a.centroidLat = mergedLat;
    a.centroidLon = mergedLon;
    a.cx = Math.floor(mergedLat / cellLatDeg);
    a.cy = Math.floor(mergedLon / cellLonDeg);
    for (const p of b.points) {
      a.points.push(p);
    }
    if (b.firstTimeMs < a.firstTimeMs) {
      a.firstTimeMs = b.firstTimeMs;
      a.firstRecordedAt = b.firstRecordedAt;
    }
    if (b.lastTimeMs >= a.lastTimeMs) {
      a.lastTimeMs = b.lastTimeMs;
      a.lastRecordedAt = b.lastRecordedAt;
      a.username = b.username;
    }
    a.version += 1;

    b.active = false;
    b.points = [];
    mergedInto[b.id] = a.id;

    addToGrid(grid, a);
    enqueueNeighbors(a, 0);
  }

  const stopByClusterId = new Map<number, AveragedTrailStop>();
  const stops: AveragedTrailStop[] = [];
  const pathCoordinates: [number, number][] = [];
  let lastClusterId: number | null = null;

  for (let i = 0; i < sorted.length; i += 1) {
    const cid = resolveClusterId(pingToCluster[i]);
    let stop = stopByClusterId.get(cid);
    if (!stop) {
      const c = clusters[cid];
      stop = {
        userId,
        username: c.username,
        latitude: roundCoord(c.centroidLat),
        longitude: roundCoord(c.centroidLon),
        pingCount: c.count,
        firstRecordedAt: c.firstRecordedAt,
        lastRecordedAt: c.lastRecordedAt,
        isFuzzed: c.isFuzzed,
      };
      stopByClusterId.set(cid, stop);
      stops.push(stop);
    }
    if (lastClusterId !== cid) {
      pathCoordinates.push([stop.longitude, stop.latitude]);
      lastClusterId = cid;
    }
  }

  return {
    userId,
    username: latestUsername,
    stops,
    pathCoordinates,
  };
}

function distWithinTolerance(
  existing: readonly RawCoordSample[],
  incoming: TrailPingLike,
  nextLat: number,
  nextLon: number,
  microRadius: number,
  maxClusterRadius: number,
): boolean {
  const cap = Math.min(microRadius, maxClusterRadius);
  if (haversineMeters(incoming.latitude, incoming.longitude, nextLat, nextLon) > cap) {
    return false;
  }
  return allSamplesWithinRadius(existing, nextLat, nextLon, cap);
}

/**
 * Groups nearby trail pings per member into their spatial average coordinates so
 * stationary GPS jitter collapses to a single clean vertex without zig-zagging.
 */
export function averageNearbyTrailPings(
  trails: readonly TrailPingLike[],
  options: AverageTrailPingsOptions = {},
): CompactUserTrail[] {
  const radiusMeters = options.clusterRadiusMeters ?? DEFAULT_TRAIL_CLUSTER_RADIUS_METERS;
  const byUser = new Map<string, TrailPingLike[]>();
  for (const pt of trails) {
    const arr = byUser.get(pt.userId);
    if (arr) {
      arr.push(pt);
    } else {
      byUser.set(pt.userId, [pt]);
    }
  }

  const results: CompactUserTrail[] = [];
  for (const [userId, points] of byUser.entries()) {
    results.push(compactSingleUserTrail(userId, points, radiusMeters));
  }
  return results;
}
