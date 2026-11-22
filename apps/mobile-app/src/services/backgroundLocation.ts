import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { LocationPoint } from '@loved-ones/shared';
import {
  BACKGROUND_GEOFENCE_RECOVERY_TASK,
  BACKGROUND_LOCATION_TASK,
  type GeofenceRecoveryAdapter,
  type GeofenceTaskData,
  handleGeofenceRecoveryEvent,
  stopRecoveryGeofence,
  syncRecoveryGeofenceAnchor,
} from './geofenceRecovery';
import {
  getLocationPermissionStatus,
  LocationPermissionResult,
  requestLocationPermissionsOnLaunch,
} from './locationPermissions';
import { enqueueLocationPoints, flushOfflineLocations } from './offlineQueue';
import {
  getBackgroundTrackingEnabled,
  getRecoveryGeofenceAnchor,
  getStoredConfig,
  saveRecoveryGeofenceAnchor,
  setBackgroundTrackingEnabled,
} from './secureConfig';

export { BACKGROUND_GEOFENCE_RECOVERY_TASK, BACKGROUND_LOCATION_TASK } from './geofenceRecovery';

interface LocationTaskPayload {
  locations?: Location.LocationObject[];
}

const CONTINUOUS_LOCATION_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: 15_000,
  distanceInterval: 20,
  deferredUpdatesInterval: 30_000,
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  activityType: Location.ActivityType.Fitness,
  foregroundService: {
    notificationTitle: 'LovedOnes Location Beacon Active',
    notificationBody: 'Sharing location updates with your group.',
    notificationColor: '#10b981',
  },
};

let foregroundSubscription: Location.LocationSubscription | null = null;

async function startContinuousLocationUpdatesIfNeeded(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (!started) {
    await Location.startLocationUpdatesAsync(
      BACKGROUND_LOCATION_TASK,
      CONTINUOUS_LOCATION_OPTIONS,
    );
  }
}

const defaultGeofenceAdapter: GeofenceRecoveryAdapter = {
  hasStartedGeofencingAsync: (taskName) => Location.hasStartedGeofencingAsync(taskName),
  startGeofencingAsync: (taskName, regions) => Location.startGeofencingAsync(taskName, regions),
  stopGeofencingAsync: (taskName) => Location.stopGeofencingAsync(taskName),
  hasStartedLocationUpdatesAsync: (taskName) => Location.hasStartedLocationUpdatesAsync(taskName),
  startContinuousLocationUpdatesAsync: startContinuousLocationUpdatesIfNeeded,
  getCurrentPositionAsync: () =>
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
  getLastKnownPositionAsync: () => Location.getLastKnownPositionAsync(),
  getBackgroundPermissionLevel: async () => (await getLocationPermissionStatus(Location)).level,
  isTrackingEnabled: () => getBackgroundTrackingEnabled(),
  hasActiveSession: async () => {
    const cfg = await getStoredConfig();
    return Boolean(cfg.serverUrl && cfg.accessToken);
  },
  getAnchor: () => getRecoveryGeofenceAnchor(),
  saveAnchor: (anchor) => saveRecoveryGeofenceAnchor(anchor),
  ingestPosition: (pos) =>
    ingestLocationsAndOpportunisticFlush([
      {
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude ?? null,
          accuracy: pos.coords.accuracy ?? null,
          altitudeAccuracy: null,
          heading: null,
          speed: pos.coords.speed ?? null,
        },
        timestamp: pos.timestamp,
      },
    ]),
};

async function ingestLocationsAndOpportunisticFlush(
  locations: Location.LocationObject[],
): Promise<void> {
  if (!locations.length) return;

  let batteryLevel: number | null = null;
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (level >= 0) {
      batteryLevel = Math.round(level * 100);
    }
  } catch {
    batteryLevel = null;
  }

  const points: LocationPoint[] = locations.map((loc) => ({
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    altitude: loc.coords.altitude ?? null,
    accuracy:
      typeof loc.coords.accuracy === 'number' && loc.coords.accuracy >= 0
        ? loc.coords.accuracy
        : null,
    speed: loc.coords.speed && loc.coords.speed >= 0 ? loc.coords.speed : null,
    batteryLevel,
    recordedAt: new Date(loc.timestamp || Date.now()).toISOString(),
  }));

  await enqueueLocationPoints(points);

  const cfg = await getStoredConfig();
  if (cfg.serverUrl && cfg.accessToken) {
    try {
      await flushOfflineLocations(cfg.serverUrl, cfg.accessToken);
    } catch {
      // Remains queued in SQLite for the next opportunistic sync
    }
  }

  const latest = locations[locations.length - 1];
  if (latest) {
    await syncRecoveryGeofenceAnchor(
      latest.coords.latitude,
      latest.coords.longitude,
      defaultGeofenceAdapter,
    ).catch(() => {});
  }
}

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask<LocationTaskPayload>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) {
      return;
    }
    await ingestLocationsAndOpportunisticFlush(data.locations);
  });
}

if (!TaskManager.isTaskDefined(BACKGROUND_GEOFENCE_RECOVERY_TASK)) {
  TaskManager.defineTask<GeofenceTaskData>(
    BACKGROUND_GEOFENCE_RECOVERY_TASK,
    async ({ data, error }) => {
      await handleGeofenceRecoveryEvent(data, error, defaultGeofenceAdapter);
    },
  );
}

/**
 * Arms or shifts the moving iOS/Android exit-recovery geofence around the given coordinates.
 */
export async function syncRecoveryGeofenceForPosition(
  latitude: number,
  longitude: number,
): Promise<boolean> {
  return syncRecoveryGeofenceAnchor(latitude, longitude, defaultGeofenceAdapter).catch(
    () => false,
  );
}

export async function startBackgroundTracking(): Promise<{
  mode: 'background' | 'foreground';
  permission: LocationPermissionResult;
}> {
  const permission = await requestLocationPermissionsOnLaunch(Location);
  if (permission.level === 'denied') {
    throw new Error('Location permission denied');
  }

  if (permission.level === 'always') {
    if (foregroundSubscription) {
      foregroundSubscription.remove();
      foregroundSubscription = null;
    }

    await setBackgroundTrackingEnabled(true);
    await startContinuousLocationUpdatesIfNeeded();

    const lastKnown = await Location.getLastKnownPositionAsync().catch(() => null);
    if (lastKnown) {
      await syncRecoveryGeofenceAnchor(
        lastKnown.coords.latitude,
        lastKnown.coords.longitude,
        defaultGeofenceAdapter,
      ).catch(() => {});
    } else {
      const savedAnchor = await getRecoveryGeofenceAnchor().catch(() => null);
      if (savedAnchor) {
        await syncRecoveryGeofenceAnchor(
          savedAnchor.latitude,
          savedAnchor.longitude,
          defaultGeofenceAdapter,
        ).catch(() => {});
      }
    }

    return { mode: 'background', permission };
  }

  // Fallback to foreground watcher when 'Always Allow' is denied on iOS or Android
  await setBackgroundTrackingEnabled(false);
  await stopRecoveryGeofence(defaultGeofenceAdapter).catch(() => {});

  if (!foregroundSubscription) {
    foregroundSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 15_000,
        distanceInterval: 20,
      },
      (loc) => {
        void ingestLocationsAndOpportunisticFlush([loc]);
      },
    );
  }
  return { mode: 'foreground', permission };
}

export async function stopBackgroundTracking(): Promise<void> {
  await setBackgroundTrackingEnabled(false).catch(() => {});
  if (foregroundSubscription) {
    foregroundSubscription.remove();
    foregroundSubscription = null;
  }
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  await stopRecoveryGeofence(defaultGeofenceAdapter).catch(() => {});
}

export async function isBackgroundTrackingActive(): Promise<boolean> {
  if (foregroundSubscription) {
    return true;
  }
  const [updatesActive, geofenceActive] = await Promise.all([
    Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false),
    Location.hasStartedGeofencingAsync(BACKGROUND_GEOFENCE_RECOVERY_TASK).catch(() => false),
  ]);
  return updatesActive || geofenceActive;
}
