import { haversineMeters, type GroupPlace, type PlaceTransitionEvent } from '@loved-ones/shared';

export interface NearestPlaceMatch {
  place: GroupPlace;
  inside: boolean;
  distanceMeters: number;
}

/**
 * Normalizes any camera bearing angle in degrees into `(-180, 180]`.
 */
export function normalizeBearingDegrees(bearing: number): number {
  if (!Number.isFinite(bearing)) return 0;
  let deg = bearing % 360;
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  return Object.is(deg, -0) ? 0 : deg;
}

/**
 * Formats an ISO timestamp into a concise human-friendly "Last seen at" string.
 */
export function formatLastSeenRelative(isoTimestamp: string, nowMs = Date.now()): string {
  const ts = Date.parse(isoTimestamp);
  if (!Number.isFinite(ts)) return 'Unknown';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  const timeClock = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffSec < 45) return `Just now · ${timeClock}`;
  if (diffSec < 3600) {
    const mins = Math.max(1, Math.floor(diffSec / 60));
    return `${mins}m ago · ${timeClock}`;
  }
  if (diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    return `${hrs}h ago · ${timeClock}`;
  }
  const dayLabel = new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${dayLabel} · ${timeClock}`;
}

/**
 * Finds the closest saved Place (private or group-shared) to a coordinate and
 * indicates whether the coordinate is currently inside its geofence radius.
 */
export function findNearestPlace(
  coord: { latitude: number; longitude: number },
  places: readonly GroupPlace[],
): NearestPlaceMatch | null {
  if (!places || places.length === 0) return null;
  let best: NearestPlaceMatch | null = null;
  for (const place of places) {
    const dist = haversineMeters(
      coord.latitude,
      coord.longitude,
      place.latitude,
      place.longitude,
    );
    if (!best || dist < best.distanceMeters) {
      best = {
        place,
        inside: dist <= place.radiusMeters,
        distanceMeters: dist,
      };
    }
  }
  return best;
}

/**
 * Builds a concise "Last near at" description combining live place proximity,
 * recent geofence transition events, and privacy fuzzing awareness.
 */
export function describeLastNearPlace(input: {
  userId: string;
  latitude: number;
  longitude: number;
  isFuzzed?: boolean;
  places: readonly GroupPlace[];
  transitions: readonly PlaceTransitionEvent[];
  nowMs?: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const latestTransition = input.transitions.find((t) => t.userId === input.userId) ?? null;

  if (input.isFuzzed) {
    if (latestTransition) {
      return `${latestTransition.placeName} (${latestTransition.transition === 'enter' ? 'entered' : 'left'} ${formatLastSeenRelative(latestTransition.recordedAt, nowMs)})`;
    }
    return 'Approximate ~1 km zone (FUZZED)';
  }

  const nearest = findNearestPlace(
    { latitude: input.latitude, longitude: input.longitude },
    input.places,
  );

  if (nearest && nearest.inside) {
    const scope = nearest.place.isPrivate ? ' · Private' : '';
    return `Inside ${nearest.place.name}${scope}`;
  }

  if (latestTransition) {
    const verb = latestTransition.transition === 'enter' ? 'Entered' : 'Left';
    return `${verb} ${latestTransition.placeName} (${formatLastSeenRelative(latestTransition.recordedAt, nowMs)})`;
  }

  if (nearest) {
    const distLabel =
      nearest.distanceMeters >= 1000
        ? `${(nearest.distanceMeters / 1000).toFixed(1)} km`
        : `${Math.round(nearest.distanceMeters)} m`;
    return `${distLabel} from ${nearest.place.name}`;
  }

  return `${input.latitude.toFixed(4)}, ${input.longitude.toFixed(4)}`;
}
