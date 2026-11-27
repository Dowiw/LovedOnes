import {
  buildGeodesicCircleRing,
  FUZZED_AREA_RADIUS_METERS,
  TrailActivityMode,
} from './schemas.js';
import {
  averageNearbyTrailPings,
  DEFAULT_TRAIL_DWELL_THRESHOLD_MS,
  DEFAULT_TRAIL_MAX_DISTANCE_METERS,
  DEFAULT_TRAIL_MAX_TIME_GAP_MS,
  DEFAULT_TRAIL_TRIP_DWELL_SPLIT_MS,
  formatStayDuration,
  haversineMeters,
  MatchedUserTrail,
  resolveTrailPointDetails,
  TrailDisplayMode,
  TrailPathSegment,
  TrailPingLike,
  TrailPlaceLike,
  TrailSegmentKind,
  TrailStopVisit,
} from './trail.js';

export const TIMELAPSE_SPEED_OPTIONS = [1, 2, 5, 10, 30, 60] as const;
export type TimelapseSpeedOption = (typeof TIMELAPSE_SPEED_OPTIONS)[number];

export const DEFAULT_TIMELAPSE_IDLE_COMPRESS_MIN_MS = DEFAULT_TRAIL_TRIP_DWELL_SPLIT_MS;
export const DEFAULT_TIMELAPSE_COMPRESSED_SPAN_VIRTUAL_MS = 12_000;
const METERS_PER_DEGREE_LAT = 111_320;
const FUZZED_WANDER_RADIUS_METERS = 360;

export interface TimelapseTimelineSegment {
  realStartMs: number;
  realEndMs: number;
  virtualStartMs: number;
  virtualEndMs: number;
  compressed: boolean;
}

export interface TimelapseTrackNode {
  timeMs: number;
  longitude: number;
  latitude: number;
  isFuzzed: boolean;
  isIdle: boolean;
  connected: boolean;
  kind?: TrailSegmentKind;
  roadKind?: string;
  activityMode?: TrailActivityMode;
}

export interface TimelapseStopEvent {
  timeMs: number;
  endTimeMs: number;
  longitude: number;
  latitude: number;
  isFuzzed: boolean;
  isDwell: boolean;
  pingCount: number;
  durationLabel: string;
  activityMode?: TrailActivityMode;
}

export interface TimelapseUserTrack {
  userId: string;
  username: string;
  nodes: TimelapseTrackNode[];
  stops: TimelapseStopEvent[];
}

export interface TimelapseTimeline {
  realStartMs: number;
  realEndMs: number;
  realDurationMs: number;
  virtualDurationMs: number;
  compactIdle: boolean;
  segments: TimelapseTimelineSegment[];
  tracks: TimelapseUserTrack[];
  isEmpty: boolean;
}

export interface BuildTimelapseTimelineOptions {
  trails: readonly TrailPingLike[];
  matchedTrails?: readonly MatchedUserTrail[] | null;
  mode?: TrailDisplayMode;
  filterUserId?: string | null;
  focusTrip?: { userId: string; startedAt: string; endedAt: string } | null;
  compactIdle?: boolean;
  minIdleCompressMs?: number;
  compressedSpanVirtualMs?: number;
}

export interface TimelapseMemberMarker {
  userId: string;
  username: string;
  longitude: number;
  latitude: number;
  baseLongitude: number;
  baseLatitude: number;
  bearingDeg: number;
  isFuzzed: boolean;
  isIdle: boolean;
  activityMode?: TrailActivityMode;
  matchedPlaceName: string | null;
}

export interface TimelapseFrameFeature {
  type: 'Feature';
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'Polygon'; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
}

export interface TimelapseFrame {
  realMs: number;
  markers: TimelapseMemberMarker[];
  features: TimelapseFrameFeature[];
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function computeBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.max(0.15, Math.cos((((lat1 + lat2) * 0.5) * Math.PI) / 180));
  const dx = (lon2 - lon1) * cosLat;
  const dy = lat2 - lat1;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return 0;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return Number((((deg % 360) + 360) % 360).toFixed(1));
}

function computeFuzzedWanderOffset(
  userId: string,
  baseLat: number,
  realMs: number,
  amplitudeScale = 1,
): { dLon: number; dLat: number; bearingDeg: number } {
  const seed = hashSeed(userId);
  const phaseA = (seed % 360) * (Math.PI / 180);
  const phaseB = ((seed >>> 8) % 360) * (Math.PI / 180);
  // Sped-up deterministic Lissajous wander inside the ~1 km fuzzed zone
  const t = realMs / 1000;
  const w1 = 0.045;
  const w2 = 0.071;
  const r = FUZZED_WANDER_RADIUS_METERS * Math.max(0, Math.min(1, amplitudeScale));
  const northMeters = r * (0.62 * Math.sin(w1 * t + phaseA) + 0.35 * Math.cos(w2 * t + phaseB));
  const eastMeters = r * (0.62 * Math.cos(w1 * 1.13 * t + phaseB) + 0.35 * Math.sin(w2 * 0.87 * t + phaseA));
  const dNorth =
    r * (0.62 * w1 * Math.cos(w1 * t + phaseA) - 0.35 * w2 * Math.sin(w2 * t + phaseB));
  const dEast =
    r * (-0.62 * w1 * 1.13 * Math.sin(w1 * 1.13 * t + phaseB) + 0.35 * w2 * 0.87 * Math.cos(w2 * 0.87 * t + phaseA));

  const cosLat = Math.max(0.15, Math.cos((baseLat * Math.PI) / 180));
  const dLat = northMeters / METERS_PER_DEGREE_LAT;
  const dLon = eastMeters / (METERS_PER_DEGREE_LAT * cosLat);
  const bearingDeg = Number((((Math.atan2(dEast, dNorth) * 180) / Math.PI) % 360 + 360) % 360);
  return { dLon, dLat, bearingDeg };
}

function computeSegmentVertexTimes(
  seg: TrailPathSegment,
  fallbackStartMs: number,
  fallbackEndMs: number,
): number[] {
  const n = seg.coordinates.length;
  if (seg.vertexTimesMs && seg.vertexTimesMs.length === n) {
    return seg.vertexTimesMs;
  }
  const sMs = seg.startedAt ? Date.parse(seg.startedAt) : fallbackStartMs;
  const eMs = seg.endedAt ? Date.parse(seg.endedAt) : fallbackEndMs;
  const startMs = Number.isFinite(sMs) ? sMs : fallbackStartMs;
  const endMs = Number.isFinite(eMs) && eMs >= startMs ? eMs : startMs;

  if (n <= 1 || endMs <= startMs) {
    return new Array<number>(n).fill(startMs);
  }

  const cumDist: number[] = [0];
  let totalDist = 0;
  for (let i = 1; i < n; i += 1) {
    const [lonA, latA] = seg.coordinates[i - 1];
    const [lonB, latB] = seg.coordinates[i];
    totalDist += haversineMeters(latA, lonA, latB, lonB);
    cumDist.push(totalDist);
  }

  const span = endMs - startMs;
  if (totalDist <= 1e-6) {
    return seg.coordinates.map((_, idx) => Math.round(startMs + (idx / (n - 1)) * span));
  }
  return cumDist.map((d) => Math.round(startMs + (d / totalDist) * span));
}

function pushNodeWithBreakCheck(nodes: TimelapseTrackNode[], next: TimelapseTrackNode): void {
  const prev = nodes[nodes.length - 1];
  if (!prev) {
    nodes.push({ ...next, connected: false });
    return;
  }
  if (next.timeMs < prev.timeMs) {
    return;
  }
  const dt = next.timeMs - prev.timeMs;
  const dist = haversineMeters(prev.latitude, prev.longitude, next.latitude, next.longitude);
  const hasBreak =
    dt > DEFAULT_TRAIL_MAX_TIME_GAP_MS || dist > DEFAULT_TRAIL_MAX_DISTANCE_METERS;

  if (
    next.timeMs === prev.timeMs &&
    Math.abs(next.longitude - prev.longitude) < 1e-6 &&
    Math.abs(next.latitude - prev.latitude) < 1e-6
  ) {
    return;
  }

  nodes.push({
    ...next,
    connected: !hasBreak && next.connected,
  });
}

function buildTrackFromMatched(
  mt: MatchedUserTrail,
  focusRange: { startMs: number; endMs: number } | null,
): TimelapseUserTrack | null {
  const rawVisits: TrailStopVisit[] =
    mt.visits && mt.visits.length > 0
      ? mt.visits
      : mt.stops.map((s, idx) => ({
          stopIndex: idx,
          latitude: s.latitude,
          longitude: s.longitude,
          firstRecordedAt: s.firstRecordedAt,
          lastRecordedAt: s.lastRecordedAt,
          isFuzzed: s.isFuzzed,
          maxSpeedMps: null,
          pingCount: s.pingCount,
        }));

  const visits = focusRange
    ? rawVisits.filter((v) => {
        const s = Date.parse(v.firstRecordedAt);
        const e = Date.parse(v.lastRecordedAt);
        return e >= focusRange.startMs - 1000 && s <= focusRange.endMs + 1000;
      })
    : rawVisits;

  const stops: TimelapseStopEvent[] = visits.map((v) => {
    const startMs = Date.parse(v.firstRecordedAt);
    const endMs = Date.parse(v.lastRecordedAt);
    const dur = Math.max(0, endMs - startMs);
    return {
      timeMs: startMs,
      endTimeMs: endMs,
      longitude: v.longitude,
      latitude: v.latitude,
      isFuzzed: v.isFuzzed,
      isDwell: v.isDwell ?? dur >= DEFAULT_TRAIL_DWELL_THRESHOLD_MS,
      pingCount: v.pingCount ?? 1,
      durationLabel: formatStayDuration(dur),
      activityMode: v.isFuzzed ? undefined : v.activityMode,
    };
  });

  const routedSegs = mt.segments.filter((s) => s.kind !== 'spur' && s.coordinates.length >= 2);
  const relevantSegs = focusRange
    ? routedSegs.filter((s) => {
        if (!s.startedAt || !s.endedAt) return false;
        const ss = Date.parse(s.startedAt);
        const ee = Date.parse(s.endedAt);
        return ss >= focusRange.startMs - 1000 && ee <= focusRange.endMs + 1000;
      })
    : routedSegs;

  const nodes: TimelapseTrackNode[] = [];
  const firstVisitMs = visits[0] ? Date.parse(visits[0].firstRecordedAt) : 0;
  const lastVisitMs = visits[visits.length - 1]
    ? Date.parse(visits[visits.length - 1].lastRecordedAt)
    : firstVisitMs;

  if (relevantSegs.length > 0) {
    // Anchor initial dwell if the first visit starts before the first moving segment
    const firstSegStart = relevantSegs[0].startedAt
      ? Date.parse(relevantSegs[0].startedAt)
      : firstVisitMs;
    if (visits[0] && Number.isFinite(firstVisitMs) && firstVisitMs < firstSegStart) {
      const [firstLon, firstLat] = relevantSegs[0].coordinates[0];
      pushNodeWithBreakCheck(nodes, {
        timeMs: Math.max(firstVisitMs, focusRange?.startMs ?? firstVisitMs),
        longitude: visits[0].isFuzzed ? visits[0].longitude : firstLon,
        latitude: visits[0].isFuzzed ? visits[0].latitude : firstLat,
        isFuzzed: visits[0].isFuzzed,
        isIdle: true,
        connected: false,
      });
    }

    for (let sIdx = 0; sIdx < relevantSegs.length; sIdx += 1) {
      const seg = relevantSegs[sIdx];
      const times = computeSegmentVertexTimes(seg, firstVisitMs, lastVisitMs);
      const isFuzzedSeg =
        visits.length > 0 &&
        visits.some(
          (v) =>
            v.isFuzzed &&
            Date.parse(v.lastRecordedAt) >= times[0] - 1000 &&
            Date.parse(v.firstRecordedAt) <= times[times.length - 1] + 1000,
        ) &&
        !visits.some(
          (v) =>
            !v.isFuzzed &&
            Date.parse(v.lastRecordedAt) >= times[0] &&
            Date.parse(v.firstRecordedAt) <= times[times.length - 1],
        );

      for (let k = 0; k < seg.coordinates.length; k += 1) {
        const [lon, lat] = seg.coordinates[k];
        const tMs = times[k];
        const prev = nodes[nodes.length - 1];
        // If there's a stationary dwell pause between previous segment end and this segment start,
        // hold at prev's coordinate until tMs so the marker waits at the stop before departing.
        if (k === 0 && prev && tMs > prev.timeMs) {
          const gapDist = haversineMeters(prev.latitude, prev.longitude, lat, lon);
          if (
            tMs - prev.timeMs <= DEFAULT_TRAIL_MAX_TIME_GAP_MS &&
            gapDist <= DEFAULT_TRAIL_MAX_DISTANCE_METERS
          ) {
            pushNodeWithBreakCheck(nodes, {
              timeMs: tMs,
              longitude: prev.longitude,
              latitude: prev.latitude,
              isFuzzed: prev.isFuzzed,
              isIdle: true,
              connected: true,
              kind: seg.kind,
              roadKind: seg.roadKind,
              activityMode: 'stationary',
            });
          }
        }
        pushNodeWithBreakCheck(nodes, {
          timeMs: tMs,
          longitude: lon,
          latitude: lat,
          isFuzzed: isFuzzedSeg,
          isIdle: false,
          connected: true,
          kind: seg.kind,
          roadKind: seg.roadKind,
          activityMode: seg.activityMode,
        });
      }
    }

    const lastVisit = visits[visits.length - 1];
    const lastNode = nodes[nodes.length - 1];
    if (lastVisit && lastNode) {
      const endClamp = focusRange
        ? Math.min(Date.parse(lastVisit.lastRecordedAt), focusRange.endMs)
        : Date.parse(lastVisit.lastRecordedAt);
      if (Number.isFinite(endClamp) && endClamp > lastNode.timeMs) {
        pushNodeWithBreakCheck(nodes, {
          timeMs: endClamp,
          longitude: lastNode.longitude,
          latitude: lastNode.latitude,
          isFuzzed: lastVisit.isFuzzed,
          isIdle: true,
          connected: true,
          activityMode: 'stationary',
        });
      }
    }
  } else if (visits.length > 0) {
    for (const v of visits) {
      const sMs = Math.max(Date.parse(v.firstRecordedAt), focusRange?.startMs ?? -Infinity);
      const eMs = Math.min(Date.parse(v.lastRecordedAt), focusRange?.endMs ?? Infinity);
      pushNodeWithBreakCheck(nodes, {
        timeMs: sMs,
        longitude: v.longitude,
        latitude: v.latitude,
        isFuzzed: v.isFuzzed,
        isIdle: Boolean(v.isDwell),
        connected: true,
        kind: 'direct',
        activityMode: v.activityMode,
      });
      if (eMs > sMs) {
        pushNodeWithBreakCheck(nodes, {
          timeMs: eMs,
          longitude: v.longitude,
          latitude: v.latitude,
          isFuzzed: v.isFuzzed,
          isIdle: true,
          connected: true,
          kind: 'direct',
          activityMode: v.isFuzzed ? undefined : 'stationary',
        });
      }
    }
  }

  if (nodes.length === 0) return null;
  return { userId: mt.userId, username: mt.username, nodes, stops };
}

function buildTrackFromRawPings(
  userId: string,
  pings: readonly TrailPingLike[],
  focusRange: { startMs: number; endMs: number } | null,
): TimelapseUserTrack | null {
  const sorted = [...pings]
    .filter((p) => {
      if (!focusRange) return true;
      const t = Date.parse(p.recordedAt);
      return t >= focusRange.startMs - 1000 && t <= focusRange.endMs + 1000;
    })
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));

  if (sorted.length === 0) return null;

  const compacted = averageNearbyTrailPings(sorted);
  const stops: TimelapseStopEvent[] = (compacted[0]?.visits ?? []).map((v) => {
    const s = Date.parse(v.firstRecordedAt);
    const e = Date.parse(v.lastRecordedAt);
    const dur = Math.max(0, e - s);
    return {
      timeMs: s,
      endTimeMs: e,
      longitude: v.longitude,
      latitude: v.latitude,
      isFuzzed: v.isFuzzed,
      isDwell: v.isDwell ?? dur >= DEFAULT_TRAIL_DWELL_THRESHOLD_MS,
      pingCount: v.pingCount ?? 1,
      durationLabel: formatStayDuration(dur),
      activityMode: v.isFuzzed ? undefined : v.activityMode,
    };
  });

  const nodes: TimelapseTrackNode[] = [];
  for (const pt of sorted) {
    const tMs = Date.parse(pt.recordedAt);
    if (!Number.isFinite(tMs)) continue;
    pushNodeWithBreakCheck(nodes, {
      timeMs: tMs,
      longitude: pt.longitude,
      latitude: pt.latitude,
      isFuzzed: Boolean(pt.isFuzzed),
      isIdle: pt.activity === 'stationary' || (typeof pt.speed === 'number' && pt.speed < 0.3),
      connected: true,
      kind: 'direct',
    });
  }

  if (nodes.length === 0) return null;
  return {
    userId,
    username: sorted[sorted.length - 1]?.username ?? 'Member',
    nodes,
    stops,
  };
}

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i];
    const last = merged[merged.length - 1];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/**
 * Builds a synchronized multi-member or single-member Timelapse timeline across
 * Clean (`roads`) or Raw (`raw`) trails, optionally compressing periods where all
 * visible members are simultaneously stationary or gapped (`compactIdle`).
 */
export function buildTimelapseTimeline(
  options: BuildTimelapseTimelineOptions,
): TimelapseTimeline {
  const mode = options.mode ?? 'roads';
  const filterUserId = options.filterUserId ?? null;
  const compactIdle = options.compactIdle ?? false;
  const minIdleCompressMs = options.minIdleCompressMs ?? DEFAULT_TIMELAPSE_IDLE_COMPRESS_MIN_MS;
  const compressedSpanVirtualMs =
    options.compressedSpanVirtualMs ?? DEFAULT_TIMELAPSE_COMPRESSED_SPAN_VIRTUAL_MS;

  const focusRange = options.focusTrip
    ? {
        startMs: Date.parse(options.focusTrip.startedAt),
        endMs: Date.parse(options.focusTrip.endedAt),
      }
    : null;
  const activeUserFilter = options.focusTrip?.userId ?? filterUserId;

  const tracks: TimelapseUserTrack[] = [];

  const usableMatched =
    mode === 'roads' && options.matchedTrails && options.matchedTrails.length > 0
      ? options.matchedTrails.filter((t) => !activeUserFilter || t.userId === activeUserFilter)
      : null;

  if (usableMatched && usableMatched.length > 0) {
    for (const mt of usableMatched) {
      const tr = buildTrackFromMatched(mt, focusRange);
      if (tr) tracks.push(tr);
    }
  } else {
    const byUser = new Map<string, TrailPingLike[]>();
    for (const ping of options.trails) {
      if (activeUserFilter && ping.userId !== activeUserFilter) continue;
      const arr = byUser.get(ping.userId);
      if (arr) arr.push(ping);
      else byUser.set(ping.userId, [ping]);
    }
    for (const [uid, pings] of byUser.entries()) {
      const tr = buildTrackFromRawPings(uid, pings, focusRange);
      if (tr) tracks.push(tr);
    }
  }

  if (tracks.length === 0) {
    return {
      realStartMs: 0,
      realEndMs: 0,
      realDurationMs: 0,
      virtualDurationMs: 0,
      compactIdle,
      segments: [],
      tracks: [],
      isEmpty: true,
    };
  }

  let realStartMs = Infinity;
  let realEndMs = -Infinity;
  const activeMotionIntervals: Array<[number, number]> = [];

  for (const track of tracks) {
    const firstT = track.nodes[0].timeMs;
    const lastT = track.nodes[track.nodes.length - 1].timeMs;
    if (firstT < realStartMs) realStartMs = firstT;
    if (lastT > realEndMs) realEndMs = lastT;

    for (let i = 1; i < track.nodes.length; i += 1) {
      const prev = track.nodes[i - 1];
      const curr = track.nodes[i];
      if (!curr.connected || curr.timeMs <= prev.timeMs) continue;
      const dist = haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
      if (dist > 15 || prev.isFuzzed !== curr.isFuzzed || (curr.isFuzzed && curr.timeMs - prev.timeMs < minIdleCompressMs)) {
        activeMotionIntervals.push([prev.timeMs, curr.timeMs]);
      }
    }
  }

  const realDurationMs = Math.max(0, realEndMs - realStartMs);
  if (realDurationMs === 0) {
    return {
      realStartMs,
      realEndMs,
      realDurationMs: 0,
      virtualDurationMs: 0,
      compactIdle,
      segments: [
        {
          realStartMs,
          realEndMs,
          virtualStartMs: 0,
          virtualEndMs: 0,
          compressed: false,
        },
      ],
      tracks,
      isEmpty: false,
    };
  }

  const mergedActive = mergeIntervals(activeMotionIntervals);
  const rawSegments: Array<{ realStartMs: number; realEndMs: number; compressed: boolean }> = [];
  let cursor = realStartMs;

  for (const [actS, actE] of mergedActive) {
    const s = Math.max(realStartMs, actS);
    const e = Math.min(realEndMs, actE);
    if (s > cursor) {
      const idleLen = s - cursor;
      rawSegments.push({
        realStartMs: cursor,
        realEndMs: s,
        compressed: compactIdle && idleLen >= minIdleCompressMs,
      });
    }
    if (e > s) {
      rawSegments.push({ realStartMs: s, realEndMs: e, compressed: false });
      cursor = e;
    }
  }
  if (cursor < realEndMs) {
    const tailLen = realEndMs - cursor;
    rawSegments.push({
      realStartMs: cursor,
      realEndMs,
      compressed: compactIdle && tailLen >= minIdleCompressMs,
    });
  }

  const segments: TimelapseTimelineSegment[] = [];
  let virtualCursor = 0;
  for (const seg of rawSegments) {
    const realLen = Math.max(0, seg.realEndMs - seg.realStartMs);
    const virtualLen = seg.compressed ? Math.min(realLen, compressedSpanVirtualMs) : realLen;
    segments.push({
      realStartMs: seg.realStartMs,
      realEndMs: seg.realEndMs,
      virtualStartMs: virtualCursor,
      virtualEndMs: virtualCursor + virtualLen,
      compressed: seg.compressed,
    });
    virtualCursor += virtualLen;
  }

  return {
    realStartMs,
    realEndMs,
    realDurationMs,
    virtualDurationMs: virtualCursor,
    compactIdle,
    segments,
    tracks,
    isEmpty: false,
  };
}

/** Converts a virtual scrubber offset (ms) into the synchronized real-world epoch timestamp (ms). */
export function virtualToRealMs(timeline: TimelapseTimeline, virtualMs: number): number {
  if (timeline.isEmpty || timeline.segments.length === 0) return timeline.realStartMs;
  const clamped = Math.max(0, Math.min(timeline.virtualDurationMs, virtualMs));
  for (const seg of timeline.segments) {
    if (clamped <= seg.virtualEndMs || seg === timeline.segments[timeline.segments.length - 1]) {
      const vSpan = seg.virtualEndMs - seg.virtualStartMs;
      const rSpan = seg.realEndMs - seg.realStartMs;
      if (vSpan <= 0 || rSpan <= 0) return seg.realStartMs;
      const frac = Math.max(0, Math.min(1, (clamped - seg.virtualStartMs) / vSpan));
      return Math.round(seg.realStartMs + frac * rSpan);
    }
  }
  return timeline.realEndMs;
}

/** Converts a real-world epoch timestamp (ms) into the corresponding virtual scrubber offset (ms). */
export function realToVirtualMs(timeline: TimelapseTimeline, realMs: number): number {
  if (timeline.isEmpty || timeline.segments.length === 0) return 0;
  const clamped = Math.max(timeline.realStartMs, Math.min(timeline.realEndMs, realMs));
  for (const seg of timeline.segments) {
    if (clamped <= seg.realEndMs || seg === timeline.segments[timeline.segments.length - 1]) {
      const rSpan = seg.realEndMs - seg.realStartMs;
      const vSpan = seg.virtualEndMs - seg.virtualStartMs;
      if (rSpan <= 0 || vSpan <= 0) return seg.virtualStartMs;
      const frac = Math.max(0, Math.min(1, (clamped - seg.realStartMs) / rSpan));
      return seg.virtualStartMs + frac * vSpan;
    }
  }
  return timeline.virtualDurationMs;
}

/**
 * Samples a single synchronized Timelapse frame at `realMs`, producing progressive
 * multi-modal trail LineStrings, reached Stop Points, FUZZED ~1 km zone polygons,
 * and smoothly interpolated (or bounded-wander FUZZED) member cursor markers.
 */
export function sampleTimelapseFrame(
  timeline: TimelapseTimeline,
  realMs: number,
  options: { places?: readonly TrailPlaceLike[] } = {},
): TimelapseFrame {
  if (timeline.isEmpty) {
    return { realMs, markers: [], features: [] };
  }

  const clampedRealMs = Math.max(timeline.realStartMs, Math.min(timeline.realEndMs, realMs));
  const features: TimelapseFrameFeature[] = [];
  const markers: TimelapseMemberMarker[] = [];

  for (const track of timeline.tracks) {
    const nodes = track.nodes;
    if (nodes.length === 0 || clampedRealMs < nodes[0].timeMs) {
      continue;
    }

    // Build progressive trail segments up to clampedRealMs
    let currentLineCoords: [number, number][] = [[nodes[0].longitude, nodes[0].latitude]];
    let currentKind: TrailSegmentKind = nodes[0].kind ?? 'direct';
    let currentRoadKind = nodes[0].roadKind;
    let currentActivityMode = nodes[0].activityMode;
    let currentFuzzed = nodes[0].isFuzzed;

    const flushLine = () => {
      if (currentLineCoords.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: currentLineCoords },
          properties: {
            kind: currentKind,
            userId: track.userId,
            username: track.username,
            isFuzzed: currentFuzzed,
            ...(currentRoadKind ? { roadKind: currentRoadKind } : {}),
            ...(currentActivityMode && !currentFuzzed ? { activityMode: currentActivityMode } : {}),
          },
        });
      }
      currentLineCoords = [];
    };

    let markerLon = nodes[0].longitude;
    let markerLat = nodes[0].latitude;
    let baseLon = markerLon;
    let baseLat = markerLat;
    let markerFuzzed = nodes[0].isFuzzed;
    let markerIdle = true;
    let markerActivity = nodes[0].isFuzzed ? undefined : nodes[0].activityMode;
    let markerBearing = 0;
    let wanderScale = markerFuzzed ? 1 : 0;

    for (let i = 1; i < nodes.length; i += 1) {
      const prev = nodes[i - 1];
      const curr = nodes[i];

      if (clampedRealMs >= curr.timeMs) {
        if (!curr.connected) {
          flushLine();
          currentLineCoords = [[curr.longitude, curr.latitude]];
          currentKind = curr.kind ?? 'direct';
          currentRoadKind = curr.roadKind;
          currentActivityMode = curr.activityMode;
          currentFuzzed = curr.isFuzzed;
        } else {
          const styleChanged =
            (curr.kind ?? 'direct') !== currentKind ||
            curr.roadKind !== currentRoadKind ||
            curr.activityMode !== currentActivityMode ||
            curr.isFuzzed !== currentFuzzed;
          if (styleChanged) {
            flushLine();
            currentLineCoords = [
              [prev.longitude, prev.latitude],
              [curr.longitude, curr.latitude],
            ];
            currentKind = curr.kind ?? 'direct';
            currentRoadKind = curr.roadKind;
            currentActivityMode = curr.activityMode;
            currentFuzzed = curr.isFuzzed;
          } else {
            const tail = currentLineCoords[currentLineCoords.length - 1];
            if (!tail || tail[0] !== curr.longitude || tail[1] !== curr.latitude) {
              currentLineCoords.push([curr.longitude, curr.latitude]);
            }
          }
        }

        baseLon = curr.longitude;
        baseLat = curr.latitude;
        markerLon = baseLon;
        markerLat = baseLat;
        markerFuzzed = curr.isFuzzed;
        wanderScale = curr.isFuzzed ? 1 : 0;
        markerIdle = curr.isIdle;
        markerActivity = curr.isFuzzed ? undefined : curr.activityMode;
        if (curr.connected) {
          const d = haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
          if (d >= 1) {
            markerBearing = computeBearingDeg(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
          }
        }
        continue;
      }

      // clampedRealMs is between prev.timeMs and curr.timeMs
      if (!curr.connected || curr.timeMs <= prev.timeMs) {
        baseLon = prev.longitude;
        baseLat = prev.latitude;
        markerLon = baseLon;
        markerLat = baseLat;
        markerFuzzed = prev.isFuzzed;
        wanderScale = prev.isFuzzed ? 1 : 0;
        markerIdle = true;
        markerActivity = prev.isFuzzed ? undefined : 'stationary';
      } else {
        const frac = Math.max(0, Math.min(1, (clampedRealMs - prev.timeMs) / (curr.timeMs - prev.timeMs)));
        const interpLon = Number((prev.longitude + frac * (curr.longitude - prev.longitude)).toFixed(6));
        const interpLat = Number((prev.latitude + frac * (curr.latitude - prev.latitude)).toFixed(6));
        const styleChanged =
          (curr.kind ?? 'direct') !== currentKind ||
          curr.roadKind !== currentRoadKind ||
          curr.activityMode !== currentActivityMode ||
          curr.isFuzzed !== currentFuzzed;
        if (styleChanged) {
          flushLine();
          currentLineCoords = [
            [prev.longitude, prev.latitude],
            [interpLon, interpLat],
          ];
          currentKind = curr.kind ?? 'direct';
          currentRoadKind = curr.roadKind;
          currentActivityMode = curr.activityMode;
          currentFuzzed = curr.isFuzzed || prev.isFuzzed;
        } else {
          const tail = currentLineCoords[currentLineCoords.length - 1];
          if (!tail || tail[0] !== interpLon || tail[1] !== interpLat) {
            currentLineCoords.push([interpLon, interpLat]);
          }
        }

        baseLon = interpLon;
        baseLat = interpLat;
        markerLon = interpLon;
        markerLat = interpLat;
        markerFuzzed = prev.isFuzzed || (curr.isFuzzed && frac > 0);
        if (prev.isFuzzed && curr.isFuzzed) {
          wanderScale = 1;
        } else if (prev.isFuzzed && !curr.isFuzzed) {
          // Smoothly converge from bounded fuzzed wander onto the exact resuming point
          wanderScale = Math.max(0, 1 - frac);
        } else if (!prev.isFuzzed && curr.isFuzzed) {
          wanderScale = frac;
        } else {
          wanderScale = 0;
        }
        const segDist = haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
        markerIdle = segDist < 1 || curr.isIdle;
        markerActivity = markerFuzzed ? undefined : curr.activityMode;
        if (segDist >= 1) {
          markerBearing = computeBearingDeg(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
        }
      }
      break;
    }

    flushLine();

    if (markerFuzzed && wanderScale > 0) {
      const wander = computeFuzzedWanderOffset(track.userId, baseLat, clampedRealMs, wanderScale);
      markerLon = Number((baseLon + wander.dLon).toFixed(6));
      markerLat = Number(Math.max(-85, Math.min(85, baseLat + wander.dLat)).toFixed(6));
      markerBearing = wander.bearingDeg;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [buildGeodesicCircleRing(baseLon, baseLat, FUZZED_AREA_RADIUS_METERS, 48)],
        },
        properties: {
          kind: 'fuzz-zone',
          userId: track.userId,
          username: track.username,
        },
      });
    }

    for (const stop of track.stops) {
      if (stop.timeMs > clampedRealMs) break;
      const details = resolveTrailPointDetails({
        latitude: stop.latitude,
        longitude: stop.longitude,
        username: track.username,
        firstRecordedAt: new Date(stop.timeMs).toISOString(),
        lastRecordedAt: new Date(stop.endTimeMs).toISOString(),
        pingCount: stop.pingCount,
        isDwell: stop.isDwell,
        isFuzzed: stop.isFuzzed,
        activityMode: stop.activityMode,
        places: options.places,
      });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [stop.longitude, stop.latitude] },
        properties: {
          kind: 'stop',
          userId: track.userId,
          username: track.username,
          pingCount: details.pingCount,
          firstRecordedAt: details.firstRecordedAt,
          lastRecordedAt: details.lastRecordedAt,
          stayDurationMs: details.stayDurationMs,
          durationLabel: details.durationLabel,
          isDwell: details.isDwell,
          isFuzzed: details.isFuzzed,
          ...(details.activityMode ? { activityMode: details.activityMode } : {}),
          matchedPlaceName: details.matchedPlaceName,
          matchedPlaceIsPrivate: details.matchedPlaceIsPrivate,
        },
      });
    }

    const matchedPlaceName = !markerFuzzed && options.places?.length
      ? resolveTrailPointDetails({
          latitude: baseLat,
          longitude: baseLon,
          isFuzzed: false,
          places: options.places,
        }).matchedPlaceName
      : null;

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [markerLon, markerLat] },
      properties: {
        kind: 'timelapse-cursor',
        userId: track.userId,
        username: track.username,
        bearingDeg: markerBearing,
        isFuzzed: markerFuzzed,
        isIdle: markerIdle,
        fuzzBadge: markerFuzzed ? 'Fuzzed' : null,
        ...(markerActivity ? { activityMode: markerActivity } : {}),
        matchedPlaceName,
      },
    });

    markers.push({
      userId: track.userId,
      username: track.username,
      longitude: markerLon,
      latitude: markerLat,
      baseLongitude: baseLon,
      baseLatitude: baseLat,
      bearingDeg: markerBearing,
      isFuzzed: markerFuzzed,
      isIdle: markerIdle,
      ...(markerActivity ? { activityMode: markerActivity } : {}),
      matchedPlaceName,
    });
  }

  return { realMs: clampedRealMs, markers, features };
}
