export const DEFAULT_TRAIL_CLUSTER_RADIUS_METERS = 85;
export const DEFAULT_TRAIL_MAX_TIME_GAP_MS = 30 * 60 * 1000;
export const DEFAULT_TRAIL_MAX_DISTANCE_METERS = 15_000;
export const DEFAULT_TRAIL_SPUR_THRESHOLD_METERS = 15;
export const DEFAULT_TRAIL_DWELL_THRESHOLD_MS = 90_000;
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
  accuracy?: number | null;
  heading?: number | null;
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
  pingCount?: number;
  dwellDurationMs?: number;
  isDwell?: boolean;
  accuracyMeters?: number | null;
  headingDeg?: number | null;
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
  /** Per-visit arrival/departure sequence preserving separate revisits to the same stop. */
  visits?: TrailStopVisit[];
  /** Ordered segments combining road-snapped routes ('road'), unmatched/fuzzed gaps ('direct'), and >15m off-road dwell spurs ('spur'). */
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
    kind: 'stop' | 'chevron' | TrailSegmentKind;
    userId: string;
    username: string;
    pingCount?: number;
    firstRecordedAt?: string;
    lastRecordedAt?: string;
    stayDurationMs?: number;
    durationLabel?: string;
    isDwell?: boolean;
    isFuzzed?: boolean;
    matchedPlaceName?: string | null;
    matchedPlaceIsPrivate?: boolean;
    roadKind?: string;
    bearingDeg?: number;
    progress?: number;
    isReturnPass?: boolean;
    segmentOrder?: number;
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
  weightSum: number;
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

function pingInverseVarianceWeight(accuracy?: number | null): number {
  const sigma =
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy > 0
      ? Math.max(5, Math.min(250, accuracy))
      : 20;
  return 1 / (sigma * sigma);
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
      pingCount: 1,
      dwellDurationMs: 0,
      isDwell: false,
      accuracyMeters:
        typeof sorted[idx]?.accuracy === 'number' &&
        Number.isFinite(sorted[idx].accuracy!) &&
        sorted[idx].accuracy! >= 0
          ? sorted[idx].accuracy!
          : null,
      headingDeg:
        typeof sorted[idx]?.heading === 'number' &&
        Number.isFinite(sorted[idx].heading!) &&
        sorted[idx].heading! >= 0 &&
        sorted[idx].heading! <= 360
          ? sorted[idx].heading!
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

    const ptWeight = pingInverseVarianceWeight(pt.accuracy);

    if (target) {
      const nextCount = target.count + 1;
      const nextWeightSum = target.weightSum + ptWeight;
      const nextLatSum = target.latSum + pt.latitude * ptWeight;
      const nextLonSum = target.lonSum + pt.longitude * ptWeight;
      const nextLat = nextLatSum / nextWeightSum;
      const nextLon = nextLonSum / nextWeightSum;
      const canAbsorb =
        distWithinTolerance(target.points, pt, nextLat, nextLon, microRadius, radiusMeters);
      if (canAbsorb) {
        target.count = nextCount;
        target.weightSum = nextWeightSum;
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
      latSum: pt.latitude * ptWeight,
      lonSum: pt.longitude * ptWeight,
      weightSum: ptWeight,
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
    const totalWeight = a.weightSum + b.weightSum;
    const mergedLat = (a.latSum + b.latSum) / totalWeight;
    const mergedLon = (a.lonSum + b.lonSum) / totalWeight;

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
    a.weightSum = totalWeight;
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
  const visitAccuracyState: Array<{ sum: number; count: number }> = [];
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
    const accVal =
      !entry.stop.isFuzzed &&
      typeof pt.accuracy === 'number' &&
      Number.isFinite(pt.accuracy) &&
      pt.accuracy >= 0
        ? pt.accuracy
        : null;
    const headVal =
      !entry.stop.isFuzzed &&
      typeof pt.heading === 'number' &&
      Number.isFinite(pt.heading) &&
      pt.heading >= 0 &&
      pt.heading <= 360
        ? pt.heading
        : null;

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
        pingCount: 1,
        dwellDurationMs: 0,
        isDwell: false,
        accuracyMeters: accVal,
        headingDeg: headVal,
      });
      visitAccuracyState.push({ sum: accVal ?? 0, count: accVal !== null ? 1 : 0 });
      lastClusterId = cid;
    } else if (visits.length > 0) {
      const curVisit = visits[visits.length - 1];
      const accState = visitAccuracyState[visitAccuracyState.length - 1];
      curVisit.lastRecordedAt = pt.recordedAt;
      curVisit.pingCount = (curVisit.pingCount ?? 1) + 1;
      const firstMs = Date.parse(curVisit.firstRecordedAt);
      const lastMs = Date.parse(curVisit.lastRecordedAt);
      const durationMs =
        Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - firstMs) : 0;
      curVisit.dwellDurationMs = durationMs;
      curVisit.isDwell = durationMs >= DEFAULT_TRAIL_DWELL_THRESHOLD_MS;
      if (speedVal !== null && (curVisit.maxSpeedMps === null || speedVal > curVisit.maxSpeedMps)) {
        curVisit.maxSpeedMps = speedVal;
      }
      if (accVal !== null) {
        accState.sum += accVal;
        accState.count += 1;
        curVisit.accuracyMeters = Number((accState.sum / accState.count).toFixed(1));
      }
      if (headVal !== null) {
        curVisit.headingDeg = headVal;
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
  /** Optional saved Places used to pre-compute stop Place names and duration labels ahead of click/tap. */
  places?: readonly TrailPlaceLike[];
}

function computeVisitDurationMs(firstRecordedAt?: string, lastRecordedAt?: string): number {
  if (!firstRecordedAt || !lastRecordedAt) return 0;
  const startMs = Date.parse(firstRecordedAt);
  const endMs = Date.parse(lastRecordedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

/** Formats a dwell/stay duration in milliseconds into a concise label (`Passing through`, `< 1m`, `12m`, `1h 25m`). */
export function formatStayDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 'Passing through';
  const totalMinutes = Math.floor(durationMs / 60_000);
  if (totalMinutes < 1) return '< 1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export interface TrailPlaceLike {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isPrivate?: boolean;
}

export interface TrailPointDetails {
  username: string;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  pingCount: number;
  stayDurationMs: number;
  durationLabel: string;
  isDwell: boolean;
  isFuzzed: boolean;
  matchedPlaceName: string | null;
  matchedPlaceIsPrivate: boolean;
}

/**
 * Computes human-readable timestamp, stay duration, and saved-Place match details
 * for a clicked or tapped trail point feature while respecting FUZZED privacy.
 */
export function resolveTrailPointDetails(input: {
  latitude: number;
  longitude: number;
  username?: string;
  firstRecordedAt?: string | null;
  lastRecordedAt?: string | null;
  pingCount?: number;
  stayDurationMs?: number;
  durationLabel?: string;
  isDwell?: boolean;
  isFuzzed?: boolean;
  matchedPlaceName?: string | null;
  matchedPlaceIsPrivate?: boolean;
  places?: readonly TrailPlaceLike[];
}): TrailPointDetails {
  const firstRecordedAt = input.firstRecordedAt ?? null;
  const lastRecordedAt = input.lastRecordedAt ?? firstRecordedAt;
  const stayDurationMs =
    typeof input.stayDurationMs === 'number' && Number.isFinite(input.stayDurationMs)
      ? Math.max(0, input.stayDurationMs)
      : computeVisitDurationMs(firstRecordedAt ?? undefined, lastRecordedAt ?? undefined);
  const isDwell =
    typeof input.isDwell === 'boolean'
      ? input.isDwell
      : stayDurationMs >= DEFAULT_TRAIL_DWELL_THRESHOLD_MS;
  const isFuzzed = Boolean(input.isFuzzed);
  const durationLabel =
    typeof input.durationLabel === 'string' && input.durationLabel.length > 0
      ? input.durationLabel
      : formatStayDuration(stayDurationMs);

  if (!isFuzzed && input.matchedPlaceName !== undefined) {
    return {
      username: input.username ?? 'Member',
      firstRecordedAt,
      lastRecordedAt,
      pingCount: typeof input.pingCount === 'number' && input.pingCount >= 1 ? input.pingCount : 1,
      stayDurationMs,
      durationLabel,
      isDwell,
      isFuzzed,
      matchedPlaceName: input.matchedPlaceName || null,
      matchedPlaceIsPrivate: Boolean(input.matchedPlaceIsPrivate),
    };
  }

  let matchedPlace: { name: string; isPrivate: boolean; dist: number } | null = null;
  if (!isFuzzed && input.places && input.places.length > 0) {
    for (const place of input.places) {
      const dist = haversineMeters(input.latitude, input.longitude, place.latitude, place.longitude);
      if (dist <= place.radiusMeters && (!matchedPlace || dist < matchedPlace.dist)) {
        matchedPlace = { name: place.name, isPrivate: Boolean(place.isPrivate), dist };
      }
    }
  }

  return {
    username: input.username ?? 'Member',
    firstRecordedAt,
    lastRecordedAt,
    pingCount: typeof input.pingCount === 'number' && input.pingCount >= 1 ? input.pingCount : 1,
    stayDurationMs,
    durationLabel,
    isDwell,
    isFuzzed,
    matchedPlaceName: matchedPlace?.name ?? null,
    matchedPlaceIsPrivate: matchedPlace?.isPrivate ?? false,
  };
}

function appendUserPointFeatures(
  features: TrailGeoJsonFeature[],
  userId: string,
  username: string,
  stops: readonly AveragedTrailStop[],
  visits?: readonly TrailStopVisit[],
  places?: readonly TrailPlaceLike[],
): number {
  let count = 0;
  if (visits && visits.length > 0) {
    for (const visit of visits) {
      count += 1;
      const stayDurationMs =
        visit.dwellDurationMs ?? computeVisitDurationMs(visit.firstRecordedAt, visit.lastRecordedAt);
      const isDwell =
        visit.isDwell ?? stayDurationMs >= DEFAULT_TRAIL_DWELL_THRESHOLD_MS;
      const precomputed = resolveTrailPointDetails({
        latitude: visit.latitude,
        longitude: visit.longitude,
        username,
        firstRecordedAt: visit.firstRecordedAt,
        lastRecordedAt: visit.lastRecordedAt,
        pingCount: visit.pingCount ?? stops[visit.stopIndex]?.pingCount ?? 1,
        stayDurationMs,
        isDwell,
        isFuzzed: visit.isFuzzed,
        places,
      });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [visit.longitude, visit.latitude] },
        properties: {
          kind: 'stop',
          userId,
          username,
          pingCount: precomputed.pingCount,
          firstRecordedAt: visit.firstRecordedAt,
          lastRecordedAt: visit.lastRecordedAt,
          stayDurationMs,
          durationLabel: precomputed.durationLabel,
          isDwell,
          isFuzzed: visit.isFuzzed,
          matchedPlaceName: precomputed.matchedPlaceName,
          matchedPlaceIsPrivate: precomputed.matchedPlaceIsPrivate,
        },
      });
    }
    return count;
  }

  for (const stop of stops) {
    count += 1;
    const stayDurationMs = computeVisitDurationMs(stop.firstRecordedAt, stop.lastRecordedAt);
    const isDwell = stayDurationMs >= DEFAULT_TRAIL_DWELL_THRESHOLD_MS;
    const precomputed = resolveTrailPointDetails({
      latitude: stop.latitude,
      longitude: stop.longitude,
      username: stop.username,
      firstRecordedAt: stop.firstRecordedAt,
      lastRecordedAt: stop.lastRecordedAt,
      pingCount: stop.pingCount,
      stayDurationMs,
      isDwell,
      isFuzzed: stop.isFuzzed,
      places,
    });
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
        stayDurationMs,
        durationLabel: precomputed.durationLabel,
        isDwell,
        isFuzzed: stop.isFuzzed,
        matchedPlaceName: precomputed.matchedPlaceName,
        matchedPlaceIsPrivate: precomputed.matchedPlaceIsPrivate,
      },
    });
  }
  return count;
}

function computeCompassBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const cosLat = Math.max(0.15, Math.cos((((lat1 + lat2) * 0.5) * Math.PI) / 180));
  const dx = (lon2 - lon1) * cosLat;
  const dy = lat2 - lat1;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return 0;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return Number((((deg % 360) + 360) % 360).toFixed(1));
}

function directedBearingDiffDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

const CHEVRON_SPACING_METERS = 130;
const CHEVRON_MIN_SEGMENT_METERS = 42;
const CHEVRON_STOP_CLEARANCE_METERS = 26;
const CHEVRON_SAME_DIR_CLEARANCE_METERS = 85;
const CHEVRON_OPPOSITE_STAGGER_METERS = 34;

/**
 * Generates chronological inline directional chevron Point features along a user's
 * trail segments from earlier nodes to later nodes, staggering return-pass arrows
 * into open gaps along the line so outbound and return directions read cleanly without clutter.
 */
function appendTrailChevronFeatures(
  features: TrailGeoJsonFeature[],
  userId: string,
  username: string,
  lineSegments: readonly { kind: TrailSegmentKind; coordinates: readonly [number, number][] }[],
  stopCoords: readonly [number, number][],
): void {
  const routedSegments = lineSegments.filter(
    (s) => (s.kind === 'road' || s.kind === 'direct') && s.coordinates.length >= 2,
  );
  if (routedSegments.length === 0) return;

  const segTotals: number[] = [];
  let grandTotalMeters = 0;
  for (const seg of routedSegments) {
    let segLen = 0;
    for (let i = 0; i < seg.coordinates.length - 1; i += 1) {
      const [lonA, latA] = seg.coordinates[i];
      const [lonB, latB] = seg.coordinates[i + 1];
      segLen += haversineMeters(latA, lonA, latB, lonB);
    }
    segTotals.push(segLen);
    grandTotalMeters += segLen;
  }
  if (grandTotalMeters < CHEVRON_MIN_SEGMENT_METERS) return;

  const placed: Array<{ lon: number; lat: number; bearingDeg: number }> = [];
  let cumulativeBaseMeters = 0;
  let segmentOrder = 0;

  for (let sIdx = 0; sIdx < routedSegments.length; sIdx += 1) {
    const seg = routedSegments[sIdx];
    const segLen = segTotals[sIdx];
    if (segLen < CHEVRON_MIN_SEGMENT_METERS) {
      cumulativeBaseMeters += segLen;
      continue;
    }

    const targetsMeters: number[] = [];
    if (segLen < CHEVRON_SPACING_METERS * 1.4) {
      targetsMeters.push(segLen * 0.5);
    } else {
      for (let d = CHEVRON_SPACING_METERS * 0.45; d <= segLen - 20; d += CHEVRON_SPACING_METERS) {
        targetsMeters.push(d);
      }
    }

    // Walk vertices chronologically and sample each target arc-length, staggering
    // opposite-direction passes cleanly into open gaps along the polyline.
    let targetIdx = 0;
    let walkedMeters = 0;
    let staggerOffsetMeters = 0;
    for (let i = 0; i < seg.coordinates.length - 1 && targetIdx < targetsMeters.length; i += 1) {
      const [lonA, latA] = seg.coordinates[i];
      const [lonB, latB] = seg.coordinates[i + 1];
      const edgeLen = haversineMeters(latA, lonA, latB, lonB);
      if (edgeLen < 1) continue;

      while (
        targetIdx < targetsMeters.length &&
        targetsMeters[targetIdx] + staggerOffsetMeters <= walkedMeters + edgeLen
      ) {
        const sampleDistAlongSeg = targetsMeters[targetIdx] + staggerOffsetMeters;
        const localDist = Math.max(0, sampleDistAlongSeg - walkedMeters);
        const frac = localDist / edgeLen;
        const sampleLon = lonA + frac * (lonB - lonA);
        const sampleLat = latA + frac * (latB - latA);
        const bearingDeg = computeCompassBearingDeg(latA, lonA, latB, lonB);

        const nearStop = stopCoords.some(
          ([sLon, sLat]) => haversineMeters(sampleLat, sampleLon, sLat, sLon) < CHEVRON_STOP_CLEARANCE_METERS,
        );
        const overlapsSameDir = placed.some(
          (p) =>
            haversineMeters(sampleLat, sampleLon, p.lat, p.lon) < CHEVRON_SAME_DIR_CLEARANCE_METERS &&
            directedBearingDiffDeg(bearingDeg, p.bearingDeg) <= 45,
        );
        const collidesOpposite = placed.some(
          (p) =>
            haversineMeters(sampleLat, sampleLon, p.lat, p.lon) < CHEVRON_OPPOSITE_STAGGER_METERS &&
            directedBearingDiffDeg(bearingDeg, p.bearingDeg) >= 115,
        );

        // If a return chevron lands right on top of an outbound chevron, stagger it ~40m along the line
        if (!nearStop && !overlapsSameDir && collidesOpposite && staggerOffsetMeters === 0) {
          staggerOffsetMeters = 40;
          if (targetsMeters[targetIdx] + staggerOffsetMeters <= walkedMeters + edgeLen) {
            continue;
          }
          break;
        }

        if (!nearStop && !overlapsSameDir && !collidesOpposite) {
          const progress = Number(
            Math.max(
              0,
              Math.min(1, (cumulativeBaseMeters + sampleDistAlongSeg) / grandTotalMeters),
            ).toFixed(3),
          );
          const hasEarlierOpposite = placed.some(
            (p) =>
              haversineMeters(sampleLat, sampleLon, p.lat, p.lon) < CHEVRON_SAME_DIR_CLEARANCE_METERS &&
              directedBearingDiffDeg(bearingDeg, p.bearingDeg) >= 115,
          );
          placed.push({ lon: sampleLon, lat: sampleLat, bearingDeg });
          features.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [roundCoord(sampleLon), roundCoord(sampleLat)],
            },
            properties: {
              kind: 'chevron',
              userId,
              username,
              bearingDeg,
              progress,
              isReturnPass: hasEarlierOpposite,
              segmentOrder,
            },
          });
          segmentOrder += 1;
        }
        staggerOffsetMeters = 0;
        targetIdx += 1;
      }

      walkedMeters += edgeLen;
    }

    cumulativeBaseMeters += segLen;
  }
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
      const beforeFeatureCount = features.length;
      stopsCount += appendUserPointFeatures(
        features,
        userTrail.userId,
        userTrail.username,
        userTrail.stops,
        userTrail.visits,
        options.places,
      );
      const stopCoords: [number, number][] = [];
      for (let idx = beforeFeatureCount; idx < features.length; idx += 1) {
        const g = features[idx].geometry;
        if (g.type === 'Point') stopCoords.push(g.coordinates);
      }

      const lineSegs: TrailPathSegment[] = [];
      for (const seg of userTrail.segments) {
        if (seg.coordinates.length < 2) continue;
        lineSegs.push(seg);
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
      appendTrailChevronFeatures(
        features,
        userTrail.userId,
        userTrail.username,
        lineSegs,
        stopCoords,
      );
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
    const beforeFeatureCount = features.length;
    stopsCount += appendUserPointFeatures(
      features,
      userTrail.userId,
      userTrail.username,
      userTrail.stops,
      userTrail.visits,
      options.places,
    );
    const stopCoords: [number, number][] = [];
    for (let idx = beforeFeatureCount; idx < features.length; idx += 1) {
      const g = features[idx].geometry;
      if (g.type === 'Point') stopCoords.push(g.coordinates);
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
      appendTrailChevronFeatures(
        features,
        userTrail.userId,
        userTrail.username,
        [{ kind: 'direct', coordinates: userTrail.pathCoordinates }],
        stopCoords,
      );
    }
  }

  return { features, stopsCount, hasRoadMatches: false };
}
