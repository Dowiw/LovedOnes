import * as BackgroundTask from 'expo-background-task';
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  IDLE_CHECKIN_INTERVAL_MS,
  type LocationPoint,
  MOVING_CHECKIN_INTERVAL_MS,
  type TrackingState,
} from '@loved-ones/shared';
import {
  type AdaptiveLocationMode,
  BACKGROUND_WATCHDOG_TASK,
  evaluateAdaptiveTrackingTransition,
  isAdaptiveWarmupActive,
  runWatchdogCheck,
  shouldTriggerTurnSample,
  type TurnSampleCandidate,
  WATCHDOG_MINIMUM_INTERVAL_MINUTES,
  type WatchdogAdapter,
} from './adaptiveTracking';
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
import {
  enqueueLocationPoints,
  flushOfflineLocations,
  getPendingLocationCount,
  postBackgroundAuthedJson,
} from './offlineQueue';
import {
  getAdaptiveTrackingState,
  getBackgroundTrackingEnabled,
  getRecoveryGeofenceAnchor,
  getStoredConfig,
  saveAdaptiveTrackingState,
  saveRecoveryGeofenceAnchor,
  setBackgroundTrackingEnabled,
} from './secureConfig';

export { BACKGROUND_GEOFENCE_RECOVERY_TASK, BACKGROUND_LOCATION_TASK } from './geofenceRecovery';
export { BACKGROUND_WATCHDOG_TASK } from './adaptiveTracking';

interface LocationTaskPayload {
  locations?: Location.LocationObject[];
}

export function buildLocationTaskOptions(
  mode: AdaptiveLocationMode,
  isWarmup = false,
): Location.LocationTaskOptions {
  const isIdle = mode === 'idle' && !isWarmup;
  return {
    accuracy: isIdle ? Location.Accuracy.Balanced : Location.Accuracy.High,
    timeInterval: isIdle ? IDLE_CHECKIN_INTERVAL_MS : MOVING_CHECKIN_INTERVAL_MS,
    distanceInterval: 0,
    deferredUpdatesInterval: isIdle ? IDLE_CHECKIN_INTERVAL_MS : 30_000,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Fitness,
    foregroundService: {
      notificationTitle: 'LovedOnes Location Beacon Active',
      notificationBody: 'Sharing location updates with your group.',
      notificationColor: '#10b981',
    },
  };
}

let foregroundSubscription: Location.LocationSubscription | null = null;
let lastForegroundSample: TurnSampleCandidate | null = null;

async function readBatteryPercent(): Promise<number | null> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (level >= 0) {
      return Math.round(level * 100);
    }
  } catch {
    // Battery API unavailable on some simulators/devices
  }
  return null;
}

export async function sendPresenceHeartbeat(
  trackingState: TrackingState,
  batteryLevel?: number | null,
): Promise<void> {
  const cfg = await getStoredConfig().catch(() => null);
  if (!cfg?.serverUrl || !cfg.accessToken) return;
  const resolvedBattery =
    batteryLevel !== undefined ? batteryLevel : await readBatteryPercent();
  await postBackgroundAuthedJson(
    cfg.serverUrl,
    '/api/realtime/heartbeat',
    cfg.accessToken,
    {
      trackingState,
      batteryLevel: resolvedBattery,
      recordedAt: new Date().toISOString(),
    },
  ).catch(() => {});
}

async function startContinuousLocationUpdatesIfNeeded(
  mode?: AdaptiveLocationMode,
  forceWarmup = false,
): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (!started) {
    const savedState = mode ? null : await getAdaptiveTrackingState().catch(() => null);
    const warmupActive = forceWarmup || isAdaptiveWarmupActive(savedState);
    const targetMode: AdaptiveLocationMode = warmupActive
      ? 'moving'
      : (mode ?? savedState?.mode ?? 'moving');
    await Location.startLocationUpdatesAsync(
      BACKGROUND_LOCATION_TASK,
      buildLocationTaskOptions(targetMode, warmupActive),
    );
  }
}

export async function syncAdaptiveTrackingForPosition(
  latitude: number,
  longitude: number,
): Promise<AdaptiveLocationMode> {
  const current = await getAdaptiveTrackingState().catch(() => null);
  const evaluation = evaluateAdaptiveTrackingTransition(current, latitude, longitude);
  await saveAdaptiveTrackingState(evaluation.nextState).catch(() => {});

  if (evaluation.modeChanged) {
    const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(
      () => false,
    );
    if (started) {
      await Location.startLocationUpdatesAsync(
        BACKGROUND_LOCATION_TASK,
        buildLocationTaskOptions(evaluation.nextMode, evaluation.isWarmup),
      ).catch(() => {});
    }
  }

  return evaluation.nextMode;
}

const defaultGeofenceAdapter: GeofenceRecoveryAdapter = {
  hasStartedGeofencingAsync: (taskName) => Location.hasStartedGeofencingAsync(taskName),
  startGeofencingAsync: (taskName, regions) => Location.startGeofencingAsync(taskName, regions),
  stopGeofencingAsync: (taskName) => Location.stopGeofencingAsync(taskName),
  hasStartedLocationUpdatesAsync: (taskName) => Location.hasStartedLocationUpdatesAsync(taskName),
  startContinuousLocationUpdatesAsync: startContinuousLocationUpdatesIfNeeded,
  getCurrentPositionAsync: () =>
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
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
          heading: pos.coords.heading ?? null,
          speed: pos.coords.speed ?? null,
        },
        timestamp: pos.timestamp,
      },
    ]),
};

function parseValidHeading(raw: number | null | undefined): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 360 ? raw : null;
}

async function ingestLocationsAndOpportunisticFlush(
  locations: Location.LocationObject[],
): Promise<void> {
  if (!locations.length) return;

  const batteryLevel = await readBatteryPercent();

  const points: LocationPoint[] = locations.map((loc) => ({
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    altitude: loc.coords.altitude ?? null,
    accuracy:
      typeof loc.coords.accuracy === 'number' && loc.coords.accuracy >= 0
        ? loc.coords.accuracy
        : null,
    speed: loc.coords.speed !== null && loc.coords.speed >= 0 ? loc.coords.speed : null,
    heading: parseValidHeading(loc.coords.heading),
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
    await syncAdaptiveTrackingForPosition(
      latest.coords.latitude,
      latest.coords.longitude,
    ).catch(() => {});
    await syncRecoveryGeofenceAnchor(
      latest.coords.latitude,
      latest.coords.longitude,
      defaultGeofenceAdapter,
    ).catch(() => {});
  }
}

const defaultWatchdogAdapter: WatchdogAdapter = {
  isTrackingEnabled: () => getBackgroundTrackingEnabled(),
  hasActiveSession: async () => {
    const cfg = await getStoredConfig();
    return Boolean(cfg.serverUrl && cfg.accessToken);
  },
  getBackgroundPermissionLevel: async () => (await getLocationPermissionStatus(Location)).level,
  hasLocationServicesEnabled: () => Location.hasServicesEnabledAsync().catch(() => true),
  isContinuousLocationActive: () => Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK),
  startContinuousLocationUpdates: () => startContinuousLocationUpdatesIfNeeded('moving'),
  getPendingLocationCount: () => getPendingLocationCount(),
  flushOfflineLocations: async () => {
    const cfg = await getStoredConfig();
    if (cfg.serverUrl && cfg.accessToken) {
      await flushOfflineLocations(cfg.serverUrl, cfg.accessToken);
    }
  },
  getBatteryLevel: () => readBatteryPercent(),
  sendHeartbeat: (trackingState, batteryLevel) => sendPresenceHeartbeat(trackingState, batteryLevel),
};

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

if (!TaskManager.isTaskDefined(BACKGROUND_WATCHDOG_TASK)) {
  TaskManager.defineTask(BACKGROUND_WATCHDOG_TASK, async () => {
    try {
      await runWatchdogCheck(defaultWatchdogAdapter);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
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
    await saveAdaptiveTrackingState(null).catch(() => {});
    await startContinuousLocationUpdatesIfNeeded('moving', true);
    await BackgroundTask.registerTaskAsync(BACKGROUND_WATCHDOG_TASK, {
      minimumInterval: WATCHDOG_MINIMUM_INTERVAL_MINUTES,
    }).catch(() => {});

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
  await BackgroundTask.unregisterTaskAsync(BACKGROUND_WATCHDOG_TASK).catch(() => {});

  if (!foregroundSubscription) {
    lastForegroundSample = null;
    foregroundSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 3_000,
        distanceInterval: 0,
      },
      (loc) => {
        const nowMs = loc.timestamp || Date.now();
        const cand: TurnSampleCandidate = {
          heading: parseValidHeading(loc.coords.heading),
          speed: loc.coords.speed !== null && loc.coords.speed >= 0 ? loc.coords.speed : null,
          recordedAtMs: nowMs,
        };
        const elapsedSinceLast =
          lastForegroundSample !== null ? nowMs - lastForegroundSample.recordedAtMs : Infinity;
        if (
          lastForegroundSample === null ||
          elapsedSinceLast >= MOVING_CHECKIN_INTERVAL_MS ||
          shouldTriggerTurnSample(lastForegroundSample, cand)
        ) {
          lastForegroundSample = cand;
          void ingestLocationsAndOpportunisticFlush([loc]);
        }
      },
    );
  }
  return { mode: 'foreground', permission };
}

export async function stopBackgroundTracking(): Promise<void> {
  await sendPresenceHeartbeat('paused').catch(() => {});
  await setBackgroundTrackingEnabled(false).catch(() => {});
  await saveAdaptiveTrackingState(null).catch(() => {});
  if (foregroundSubscription) {
    foregroundSubscription.remove();
    foregroundSubscription = null;
  }
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  await BackgroundTask.unregisterTaskAsync(BACKGROUND_WATCHDOG_TASK).catch(() => {});
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
