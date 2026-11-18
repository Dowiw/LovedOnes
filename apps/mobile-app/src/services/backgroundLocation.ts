import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { LocationPoint } from '@loved-ones/shared';
import {
  LocationPermissionResult,
  requestLocationPermissionsOnLaunch,
} from './locationPermissions';
import { enqueueLocationPoints, flushOfflineLocations } from './offlineQueue';
import { getStoredConfig } from './secureConfig';

export const BACKGROUND_LOCATION_TASK = 'LOVED_ONES_BACKGROUND_LOCATION_TASK';

interface LocationTaskPayload {
  locations?: Location.LocationObject[];
}

let foregroundSubscription: Location.LocationSubscription | null = null;

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
}

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask<LocationTaskPayload>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) {
      return;
    }
    await ingestLocationsAndOpportunisticFlush(data.locations);
  });
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

    const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    if (!started) {
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
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
      });
    }
    return { mode: 'background', permission };
  }

  // Fallback to foreground watcher when 'Always Allow' is denied on iOS or Android
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
  if (foregroundSubscription) {
    foregroundSubscription.remove();
    foregroundSubscription = null;
  }
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}

export async function isBackgroundTrackingActive(): Promise<boolean> {
  if (foregroundSubscription) {
    return true;
  }
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
}
