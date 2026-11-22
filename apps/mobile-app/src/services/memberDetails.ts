import {
  formatLastSeenRelative,
  haversineMeters,
  resolveMemberPresenceStatus,
  type GroupPlace,
  type MemberPresenceStatus,
  type PlaceTransitionEvent,
  type TrackingState,
} from '@loved-ones/shared';

export { formatLastSeenRelative, resolveMemberPresenceStatus, type MemberPresenceStatus };

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
 * Resolves the name of the Place a member is currently inside, returning null
 * for FUZZED coordinates so exact Place names are never inferred from jittered pins.
 */
export function resolveInsidePlaceName(
  coord: { latitude: number; longitude: number },
  places: readonly GroupPlace[],
  isFuzzed?: boolean,
): string | null {
  if (isFuzzed) return null;
  const nearest = findNearestPlace(coord, places);
  return nearest?.inside ? nearest.place.name : null;
}

export function describeMemberStatus(input: {
  latitude: number;
  longitude: number;
  recordedAt: string;
  lastHeartbeatAt?: string | null;
  trackingState?: TrackingState | null;
  isFuzzed?: boolean;
  places: readonly GroupPlace[];
  nowMs?: number;
}): MemberPresenceStatus {
  const insidePlaceName = resolveInsidePlaceName(
    { latitude: input.latitude, longitude: input.longitude },
    input.places,
    input.isFuzzed,
  );
  return resolveMemberPresenceStatus({
    recordedAt: input.recordedAt,
    lastHeartbeatAt: input.lastHeartbeatAt,
    trackingState: input.trackingState,
    isFuzzed: input.isFuzzed,
    insidePlaceName,
    nowMs: input.nowMs,
  });
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
