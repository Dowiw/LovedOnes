export const DEFAULT_TRAIL_CLUSTER_RADIUS_METERS = 85;
export const DEFAULT_TRAIL_MAX_TIME_GAP_MS = 30 * 60 * 1000;
export const DEFAULT_TRAIL_MAX_DISTANCE_METERS = 15_000;
export const DEFAULT_TRAIL_SPUR_THRESHOLD_METERS = 15;
const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_DEGREE_LAT = 111_320;

export interface TrailPingLike {
  userId: string;
  username: string;
  latitude: number;
  longitude: number;
  recordedAt: string;
  isFuzzed?: boolean;
  speed?: number | null;
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

export interface TrailStopVisit {
  stopIndex: number;
  latitude: number;
  longitude: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
  isFuzzed: boolean;
  maxSpeedMps: number | null;
}

export interface CompactUserTrail {
  userId: string;
  username: string;
  stops: AveragedTrailStop[];
  /** Chronological [longitude, latitude] vertices with consecutive same-stop duplicates collapsed. */
  pathCoordinates: [number, number][];
  /** Chronological visit sequence with per-visit timestamps and speed hints for trip splitting & road snapping. */
  visits?: TrailStopVisit[];
}

export type TrailSegmentKind = 'road' | 'direct' | 'spur';

export type TrailDisplayMode = 'roads' | 'raw';

export interface TrailPathSegment {
  kind: TrailSegmentKind;
  /** Chronological [longitude, latitude] coordinates for this segment. */
  coordinates: [number, number][];
  /** Road class hint when kind === 'road' (e.g. 'highway', 'major_road', 'minor_road', 'path'). */
  roadKind?: string;
}

export interface MatchedUserTrail {
  userId: string;
  username: string;
  stops: AveragedTrailStop[];
  /** Ordered segments combining road-snapped routes ('road'), unmatched/fuzzed gaps ('direct'), and >15m off-road spurs ('spur'). */
  segments: TrailPathSegment[];
  /** True when at least one segment was matched onto road/path geometry. */
  hasRoadMatches: boolean;
}

export interface TrailGeoJsonFeature {
  type: 'Feature';
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Point'; coordinates: [number, number] };
  properties: {
    kind: 'stop' | TrailSegmentKind;
    userId: string;
    username: string;
    pingCount?: number;
    firstRecordedAt?: string;
    lastRecordedAt?: string;
    isFuzzed?: boolean;
    roadKind?: string;
  };
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
    return { userId, username: latestUsername, stops: [], pathCoordinates: [], visits: [] };
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
    const visits: TrailStopVisit[] = stops.map((stop, idx) => ({
      stopIndex: idx,
      latitude: stop.latitude,
      longitude: stop.longitude,
      firstRecordedAt: stop.firstRecordedAt,
      lastRecordedAt: stop.lastRecordedAt,
      isFuzzed: stop.isFuzzed,
      maxSpeedMps:
        typeof sorted[idx]?.speed === 'number' && Number.isFinite(sorted[idx].speed!)
          ? sorted[idx].speed!
          : null,
    }));
    return {
      userId,
      username: latestUsername,
      stops,
      pathCoordinates: stops.map((s) => [s.longitude, s.latitude]),
      visits,
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

  const stopByClusterId = new Map<number, { stop: AveragedTrailStop; stopIndex: number }>();
  const stops: AveragedTrailStop[] = [];
  const pathCoordinates: [number, number][] = [];
  const visits: TrailStopVisit[] = [];
  let lastClusterId: number | null = null;

  for (let i = 0; i < sorted.length; i += 1) {
    const pt = sorted[i];
    const cid = resolveClusterId(pingToCluster[i]);
    let entry = stopByClusterId.get(cid);
    if (!entry) {
      const c = clusters[cid];
      const stop: AveragedTrailStop = {
        userId,
        username: c.username,
        latitude: roundCoord(c.centroidLat),
        longitude: roundCoord(c.centroidLon),
        pingCount: c.count,
        firstRecordedAt: c.firstRecordedAt,
        lastRecordedAt: c.lastRecordedAt,
        isFuzzed: c.isFuzzed,
      };
      const stopIndex = stops.length;
      stops.push(stop);
      entry = { stop, stopIndex };
      stopByClusterId.set(cid, entry);
    }
    const speedVal =
      typeof pt.speed === 'number' && Number.isFinite(pt.speed) && pt.speed >= 0 ? pt.speed : null;

    if (lastClusterId !== cid) {
      pathCoordinates.push([entry.stop.longitude, entry.stop.latitude]);
      visits.push({
        stopIndex: entry.stopIndex,
        latitude: entry.stop.latitude,
        longitude: entry.stop.longitude,
        firstRecordedAt: pt.recordedAt,
        lastRecordedAt: pt.recordedAt,
        isFuzzed: entry.stop.isFuzzed,
        maxSpeedMps: speedVal,
      });
      lastClusterId = cid;
    } else if (visits.length > 0) {
      const curVisit = visits[visits.length - 1];
      curVisit.lastRecordedAt = pt.recordedAt;
      if (speedVal !== null && (curVisit.maxSpeedMps === null || speedVal > curVisit.maxSpeedMps)) {
        curVisit.maxSpeedMps = speedVal;
      }
    }
  }

  return {
    userId,
    username: latestUsername,
    stops,
    pathCoordinates,
    visits,
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

export interface SplitTripsOptions {
  maxTimeGapMs?: number;
  maxDistanceMeters?: number;
}

/**
 * Splits a user's chronological stop visits into contiguous trips, breaking
 * whenever a gap exceeds `maxTimeGapMs` (default 30 min) or `maxDistanceMeters` (default 15 km),
 * or when transitioning between EXACT and FUZZED privacy modes.
 */
export function splitVisitsIntoTrips(
  visits: readonly TrailStopVisit[],
  options: SplitTripsOptions = {},
): TrailStopVisit[][] {
  if (visits.length === 0) return [];
  const maxTimeGapMs = options.maxTimeGapMs ?? DEFAULT_TRAIL_MAX_TIME_GAP_MS;
  const maxDistanceMeters = options.maxDistanceMeters ?? DEFAULT_TRAIL_MAX_DISTANCE_METERS;

  const trips: TrailStopVisit[][] = [[visits[0]]];
  for (let i = 1; i < visits.length; i += 1) {
    const prev = visits[i - 1];
    const curr = visits[i];
    const prevExitMs = Date.parse(prev.lastRecordedAt);
    const currEnterMs = Date.parse(curr.firstRecordedAt);
    const timeGapMs =
      Number.isFinite(prevExitMs) && Number.isFinite(currEnterMs)
        ? Math.max(0, currEnterMs - prevExitMs)
        : 0;
    const distMeters = haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);

    if (
      prev.isFuzzed !== curr.isFuzzed ||
      timeGapMs > maxTimeGapMs ||
      distMeters > maxDistanceMeters
    ) {
      trips.push([curr]);
    } else {
      trips[trips.length - 1].push(curr);
    }
  }
  return trips;
}

/** Appends coordinates to a polyline while skipping consecutive duplicate vertices. */
export function mergeTrailCoordinates(
  chunks: readonly (readonly [number, number][])[],
): [number, number][] {
  const merged: [number, number][] = [];
  for (const chunk of chunks) {
    for (const pt of chunk) {
      const prev = merged[merged.length - 1];
      if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
        merged.push([pt[0], pt[1]]);
      }
    }
  }
  return merged;
}

export interface BuildTrailGeoJsonOptions {
  trails: readonly TrailPingLike[];
  matchedTrails?: readonly MatchedUserTrail[] | null;
  mode?: TrailDisplayMode;
  filterUserId?: string | null;
}

/**
 * Converts either road-snapped `MatchedUserTrail[]` or raw `TrailPingLike[]`
 * into MapLibre-ready GeoJSON Point/LineString features shared across web and mobile.
 */
export function buildTrailGeoJsonFeatures(options: BuildTrailGeoJsonOptions): {
  features: TrailGeoJsonFeature[];
  stopsCount: number;
  hasRoadMatches: boolean;
} {
  const mode = options.mode ?? 'roads';
  const filterUserId = options.filterUserId ?? null;
  const features: TrailGeoJsonFeature[] = [];
  let stopsCount = 0;
  let hasRoadMatches = false;

  const usableMatched =
    mode === 'roads' && options.matchedTrails && options.matchedTrails.length > 0
      ? options.matchedTrails.filter((t) => !filterUserId || t.userId === filterUserId)
      : null;

  if (usableMatched && usableMatched.length > 0) {
    for (const userTrail of usableMatched) {
      if (userTrail.hasRoadMatches) hasRoadMatches = true;
      for (const stop of userTrail.stops) {
        stopsCount += 1;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [stop.longitude, stop.latitude] },
          properties: {
            kind: 'stop',
            userId: stop.userId,
            username: stop.username,
            pingCount: stop.pingCount,
            firstRecordedAt: stop.firstRecordedAt,
            lastRecordedAt: stop.lastRecordedAt,
            isFuzzed: stop.isFuzzed,
          },
        });
      }
      for (const seg of userTrail.segments) {
        if (seg.coordinates.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: seg.coordinates },
          properties: {
            kind: seg.kind,
            userId: userTrail.userId,
            username: userTrail.username,
            ...(seg.roadKind ? { roadKind: seg.roadKind } : {}),
          },
        });
      }
    }
    return { features, stopsCount, hasRoadMatches };
  }

  const rawFiltered = filterUserId
    ? options.trails.filter((t) => t.userId === filterUserId)
    : options.trails;
  if (rawFiltered.length === 0) {
    return { features, stopsCount: 0, hasRoadMatches: false };
  }

  const compacted = averageNearbyTrailPings(rawFiltered);
  for (const userTrail of compacted) {
    for (const stop of userTrail.stops) {
      stopsCount += 1;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [stop.longitude, stop.latitude] },
        properties: {
          kind: 'stop',
          userId: stop.userId,
          username: stop.username,
          pingCount: stop.pingCount,
          firstRecordedAt: stop.firstRecordedAt,
          lastRecordedAt: stop.lastRecordedAt,
          isFuzzed: stop.isFuzzed,
        },
      });
    }
    if (userTrail.pathCoordinates.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: userTrail.pathCoordinates },
        properties: {
          kind: 'direct',
          userId: userTrail.userId,
          username: userTrail.username,
        },
      });
    }
  }

  return { features, stopsCount, hasRoadMatches: false };
}
