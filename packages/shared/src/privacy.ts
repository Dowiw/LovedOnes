import { PrivacyMode } from './schemas.js';

export interface FuzzedLocationResult {
  visible: boolean;
  latitude: number;
  longitude: number;
  isFuzzed: boolean;
}

const ONE_KM_LAT_DEG = 0.009; // ~1.0 km in latitude

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Applies group privacy rules to raw coordinates.
 * - EXACT: returns exact coordinates.
 * - FUZZED: snaps to a ~1 km grid with deterministic time-windowed per-user salt
 *   to prevent multi-ping triangulation while remaining stable across a 10-minute bucket.
 * - GHOST: suppresses coordinates from broadcasts and snapshots.
 */
export function applyPrivacyFuzzing(
  latitude: number,
  longitude: number,
  mode: PrivacyMode,
  userId = 'anonymous',
  nowMs = Date.now(),
): FuzzedLocationResult {
  if (mode === 'GHOST') {
    return {
      visible: false,
      latitude: 0,
      longitude: 0,
      isFuzzed: true,
    };
  }

  if (mode === 'EXACT') {
    return {
      visible: true,
      latitude,
      longitude,
      isFuzzed: false,
    };
  }

  const cosLat = Math.max(Math.cos((latitude * Math.PI) / 180), 0.15);
  const lonStep = ONE_KM_LAT_DEG / cosLat;

  const bucket = Math.floor(nowMs / (10 * 60 * 1000));
  const seedLat = hashString(`${userId}:${bucket}:lat`);
  const seedLon = hashString(`${userId}:${bucket}:lon`);

  const offsetLat = ((seedLat % 1000) / 1000 - 0.5) * ONE_KM_LAT_DEG;
  const offsetLon = ((seedLon % 1000) / 1000 - 0.5) * lonStep;

  const snappedLat = Math.round((latitude + offsetLat) / ONE_KM_LAT_DEG) * ONE_KM_LAT_DEG;
  const snappedLon = Math.round((longitude + offsetLon) / lonStep) * lonStep;

  return {
    visible: true,
    latitude: Number(Math.max(-90, Math.min(90, snappedLat)).toFixed(6)),
    longitude: Number(Math.max(-180, Math.min(180, snappedLon)).toFixed(6)),
    isFuzzed: true,
  };
}
