import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { LocationPoint } from '@loved-ones/shared';
import { enqueueLocationPoints, flushOfflineLocations } from './offlineQueue';
import { getStoredConfig } from './secureConfig';

export const BACKGROUND_LOCATION_TASK = 'LOVED_ONES_BACKGROUND_LOCATION_TASK';

interface LocationTaskPayload {
  locations?: Location.LocationObject[];
}

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask<LocationTaskPayload>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) {
      return;
    }

    let batteryLevel: number | null = null;
    try {
      const level = await Battery.getBatteryLevelAsync();
      if (level >= 0) {
        batteryLevel = Math.round(level * 100);
      }
    } catch {
      batteryLevel = null;
    }

    const points: LocationPoint[] = data.locations.map((loc) => ({
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
  });
}

export async function startBackgroundTracking(): Promise<void> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    throw new Error('Foreground location permission denied');
  }
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    throw new Error('Background location permission denied');
  }

  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) return;

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 15_000,
    distanceInterval: 20,
    deferredUpdatesInterval: 30_000,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'LovedOnes Location Beacon Active',
      notificationBody: 'Sharing location updates with your group.',
      notificationColor: '#10b981',
    },
  });
}

export async function stopBackgroundTracking(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}

export async function isBackgroundTrackingActive(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
}
