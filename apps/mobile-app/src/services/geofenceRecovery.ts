import { haversineMeters } from '@loved-ones/shared';
import type { RecoveryGeofenceAnchor } from './secureConfig';

export const BACKGROUND_LOCATION_TASK = 'LOVED_ONES_BACKGROUND_LOCATION_TASK';
export const BACKGROUND_GEOFENCE_RECOVERY_TASK = 'LOVED_ONES_GEOFENCE_RECOVERY_TASK';
export const RECOVERY_GEOFENCE_IDENTIFIER = 'lovedones-recovery-anchor';
export const DEFAULT_RECOVERY_GEOFENCE_RADIUS_METERS = 250;
export const RECOVERY_ANCHOR_SHIFT_RATIO = 0.5;
export const GEOFENCING_EVENT_EXIT = 2;

export interface RecoveryLocationRegion {
  identifier?: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter?: boolean;
  notifyOnExit?: boolean;
}

export interface RecoveryPosition {
  coords: {
    latitude: number;
    longitude: number;
    altitude?: number | null;
    accuracy?: number | null;
    speed?: number | null;
    heading?: number | null;
  };
  timestamp: number;
}

export interface GeofenceTaskData {
  eventType?: number;
  region?: { identifier?: string };
}

export interface GeofenceRecoveryAdapter {
  hasStartedGeofencingAsync(taskName: string): Promise<boolean>;
  startGeofencingAsync(taskName: string, regions: RecoveryLocationRegion[]): Promise<void>;
  stopGeofencingAsync(taskName: string): Promise<void>;
  hasStartedLocationUpdatesAsync(taskName: string): Promise<boolean>;
  startContinuousLocationUpdatesAsync(): Promise<void>;
  getCurrentPositionAsync?(): Promise<RecoveryPosition | null>;
  getLastKnownPositionAsync?(): Promise<RecoveryPosition | null>;
  getBackgroundPermissionLevel(): Promise<'always' | 'foreground' | 'denied'>;
  isTrackingEnabled(): Promise<boolean>;
  hasActiveSession(): Promise<boolean>;
  getAnchor(): Promise<RecoveryGeofenceAnchor | null>;
  saveAnchor(anchor: RecoveryGeofenceAnchor | null): Promise<void>;
  ingestPosition?(position: RecoveryPosition): Promise<void>;
}

function isValidAnchorCoordinate(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  if (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6) return false;
  return true;
}

/**
 * Builds the exit-only CoreLocation/Android recovery geofence centered at the
 * device's latest known coordinates so OS termination/reboot wakes the app when moved.
 */
export function buildRecoveryGeofenceRegion(
  latitude: number,
  longitude: number,
  radiusMeters = DEFAULT_RECOVERY_GEOFENCE_RADIUS_METERS,
): RecoveryLocationRegion {
  const clampedRadius = Math.min(1000, Math.max(150, Math.round(radiusMeters)));
  return {
    identifier: RECOVERY_GEOFENCE_IDENTIFIER,
    latitude,
    longitude,
    radius: clampedRadius,
    notifyOnEnter: false,
    notifyOnExit: true,
  };
}

/**
 * Determines whether the moving recovery anchor should be re-centered to avoid
 * churning OS geofence registrations on every stationary GPS tick.
 */
export function shouldRefreshRecoveryAnchor(
  currentAnchor: RecoveryGeofenceAnchor | null,
  latitude: number,
  longitude: number,
  radiusMeters = DEFAULT_RECOVERY_GEOFENCE_RADIUS_METERS,
): boolean {
  if (!isValidAnchorCoordinate(latitude, longitude)) return false;
  if (!currentAnchor) return true;
  const dist = haversineMeters(currentAnchor.latitude, currentAnchor.longitude, latitude, longitude);
  return dist >= radiusMeters * RECOVERY_ANCHOR_SHIFT_RATIO;
}

/**
 * Unregisters the background geofence recovery task and clears stored anchor coordinates.
 */
export async function stopRecoveryGeofence(
  adapter: Pick<
    GeofenceRecoveryAdapter,
    'hasStartedGeofencingAsync' | 'stopGeofencingAsync' | 'saveAnchor'
  >,
): Promise<void> {
  const started = await adapter
    .hasStartedGeofencingAsync(BACKGROUND_GEOFENCE_RECOVERY_TASK)
    .catch(() => false);
  if (started) {
    await adapter.stopGeofencingAsync(BACKGROUND_GEOFENCE_RECOVERY_TASK).catch(() => {});
  }
  await adapter.saveAnchor(null).catch(() => {});
}

/**
 * Arms or re-centers the moving exit geofence when Always-Allow background tracking
 * is active, or tears it down if tracking was paused, signed out, or downgraded.
 */
export async function syncRecoveryGeofenceAnchor(
  latitude: number,
  longitude: number,
  adapter: GeofenceRecoveryAdapter,
  options?: { force?: boolean; radiusMeters?: number },
): Promise<boolean> {
  if (!isValidAnchorCoordinate(latitude, longitude)) return false;

  const [trackingEnabled, activeSession, permissionLevel] = await Promise.all([
    adapter.isTrackingEnabled(),
    adapter.hasActiveSession(),
    adapter.getBackgroundPermissionLevel(),
  ]);

  if (!trackingEnabled || !activeSession || permissionLevel !== 'always') {
    await stopRecoveryGeofence(adapter);
    return false;
  }

  const radiusMeters = options?.radiusMeters ?? DEFAULT_RECOVERY_GEOFENCE_RADIUS_METERS;
  const [geofenceStarted, currentAnchor] = await Promise.all([
    adapter.hasStartedGeofencingAsync(BACKGROUND_GEOFENCE_RECOVERY_TASK).catch(() => false),
    adapter.getAnchor().catch(() => null),
  ]);

  if (
    !options?.force &&
    geofenceStarted &&
    !shouldRefreshRecoveryAnchor(currentAnchor, latitude, longitude, radiusMeters)
  ) {
    return false;
  }

  const region = buildRecoveryGeofenceRegion(latitude, longitude, radiusMeters);
  await adapter.startGeofencingAsync(BACKGROUND_GEOFENCE_RECOVERY_TASK, [region]);
  await adapter.saveAnchor({
    latitude,
    longitude,
    radiusMeters: region.radius,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * Handles headless OS geofence-exit wake-ups (e.g. on iOS after termination or
 * reboot once unlocked): verifies active consent/session, re-arms continuous GPS
 * updates, flushes a fresh coordinate when available, and shifts the exit fence.
 */
export async function handleGeofenceRecoveryEvent(
  data: GeofenceTaskData | undefined,
  error: unknown,
  adapter: GeofenceRecoveryAdapter,
): Promise<{ recovered: boolean; continuousRestarted: boolean; reanchored: boolean }> {
  if (error || !data || data.eventType !== GEOFENCING_EVENT_EXIT) {
    return { recovered: false, continuousRestarted: false, reanchored: false };
  }

  const [trackingEnabled, activeSession, permissionLevel] = await Promise.all([
    adapter.isTrackingEnabled(),
    adapter.hasActiveSession(),
    adapter.getBackgroundPermissionLevel(),
  ]);

  if (!trackingEnabled || !activeSession || permissionLevel !== 'always') {
    await stopRecoveryGeofence(adapter);
    return { recovered: false, continuousRestarted: false, reanchored: false };
  }

  let continuousRestarted = false;
  try {
    const continuousActive = await adapter.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    if (!continuousActive) {
      await adapter.startContinuousLocationUpdatesAsync();
      continuousRestarted = true;
    }
  } catch {
    // On platforms like Android 14+ that restrict starting a location FGS from background,
    // still continue to attempt a one-shot position sync below.
  }

  let position: RecoveryPosition | null = null;
  if (adapter.getCurrentPositionAsync) {
    position = await adapter.getCurrentPositionAsync().catch(() => null);
  }
  if (!position && adapter.getLastKnownPositionAsync) {
    position = await adapter.getLastKnownPositionAsync().catch(() => null);
  }

  let reanchored = false;
  if (position && isValidAnchorCoordinate(position.coords.latitude, position.coords.longitude)) {
    try {
      await adapter.ingestPosition?.(position);
    } catch {
      // Do not skip re-anchoring if network flush failed
    }
    try {
      reanchored = await syncRecoveryGeofenceAnchor(
        position.coords.latitude,
        position.coords.longitude,
        adapter,
        { force: true },
      );
    } catch {
      reanchored = false;
    }
  } else {
    // Clear stale center so the next continuous GPS tick shifts the anchor cleanly
    await adapter.saveAnchor(null).catch(() => {});
  }

  return {
    recovered: true,
    continuousRestarted,
    reanchored,
  };
}
