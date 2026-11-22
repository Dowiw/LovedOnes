export interface GeoWarmupCandidate {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: string;
}

export interface GeoWarmupOptions {
  /** Maximum number of initial fixes to evaluate before committing even a coarse fix (default 3). */
  maxWarmupSamples?: number;
  /** Maximum warmup window in milliseconds from start (default 12000). */
  maxWarmupWindowMs?: number;
  /** Accuracy threshold in meters considered crisp enough to end warmup immediately (default 120). */
  acceptableAccuracyMeters?: number;
}

export interface GeoWarmupDecision<T extends GeoWarmupCandidate> {
  /** Whether this fix (or the best seen so far) should be uploaded to the server now. */
  shouldUpload: boolean;
  /** The fix to upload when `shouldUpload` is true. */
  pointToUpload: T | null;
  /** True while warmup is still waiting for a tighter initial fix. */
  warmingUp: boolean;
}

/**
 * Filters coarse initial browser/desktop geolocation fixes during startup so
 * a stale or IP-based first ping does not anchor the start of a trail when a
 * tighter GNSS/Wi-Fi fix arrives a few seconds later.
 */
export function createGeoWarmupGate<T extends GeoWarmupCandidate>(
  options: GeoWarmupOptions = {},
): {
  evaluate: (point: T, nowMs?: number) => GeoWarmupDecision<T>;
  reset: () => void;
} {
  const maxSamples = Math.max(1, options.maxWarmupSamples ?? 3);
  const maxWindowMs = Math.max(0, options.maxWarmupWindowMs ?? 12_000);
  const acceptableAccuracy = Math.max(1, options.acceptableAccuracyMeters ?? 120);

  let startedAtMs: number | null = null;
  let sampleCount = 0;
  let completed = false;
  let bestPoint: T | null = null;
  let bestAccuracy = Infinity;

  const reset = () => {
    startedAtMs = null;
    sampleCount = 0;
    completed = false;
    bestPoint = null;
    bestAccuracy = Infinity;
  };

  const evaluate = (point: T, nowMs = Date.now()): GeoWarmupDecision<T> => {
    if (completed) {
      return { shouldUpload: true, pointToUpload: point, warmingUp: false };
    }

    if (startedAtMs === null) {
      startedAtMs = nowMs;
    }
    sampleCount += 1;

    const acc =
      typeof point.accuracy === 'number' && Number.isFinite(point.accuracy) && point.accuracy >= 0
        ? point.accuracy
        : Infinity;

    if (bestPoint === null || acc <= bestAccuracy) {
      bestPoint = point;
      bestAccuracy = acc;
    }

    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    if (acc <= acceptableAccuracy) {
      completed = true;
      return { shouldUpload: true, pointToUpload: point, warmingUp: false };
    }

    if (sampleCount >= maxSamples || elapsedMs >= maxWindowMs) {
      completed = true;
      return { shouldUpload: true, pointToUpload: bestPoint, warmingUp: false };
    }

    return { shouldUpload: false, pointToUpload: null, warmingUp: true };
  };

  return { evaluate, reset };
}
