import {
  haversineMeters,
  STATIONARY_COALESCE_RADIUS_METERS,
  type TrackingState,
} from '@loved-ones/shared';
import type { AdaptiveTrackingState } from './secureConfig';

export const BACKGROUND_WATCHDOG_TASK = 'LOVED_ONES_BACKGROUND_WATCHDOG_TASK';
export const WATCHDOG_MINIMUM_INTERVAL_MINUTES = 15;
export const STATIONARY_DWELL_BEFORE_IDLE_MS = 60_000;

export type AdaptiveLocationMode = 'moving' | 'idle';

export interface AdaptiveModeEvaluation {
  previousMode: AdaptiveLocationMode;
  nextMode: AdaptiveLocationMode;
  modeChanged: boolean;
  movedMeters: number;
  nextState: AdaptiveTrackingState;
}

/**
 * Computes whether background location polling should stay in fast moving mode
 * (15s) or step down to low-power idle check-in mode (5 min) based on whether
 * the device stayed within 20m of its anchor for at least 60 seconds.
 */
export function evaluateAdaptiveTrackingTransition(
  currentState: AdaptiveTrackingState | null,
  latitude: number,
  longitude: number,
  nowMs = Date.now(),
  stationaryRadiusMeters = STATIONARY_COALESCE_RADIUS_METERS,
  dwellThresholdMs = STATIONARY_DWELL_BEFORE_IDLE_MS,
): AdaptiveModeEvaluation {
  if (!currentState) {
    return {
      previousMode: 'moving',
      nextMode: 'moving',
      modeChanged: false,
      movedMeters: 0,
      nextState: {
        mode: 'moving',
        anchorLatitude: latitude,
        anchorLongitude: longitude,
        stationarySinceMs: nowMs,
      },
    };
  }

  const movedMeters = haversineMeters(
    currentState.anchorLatitude,
    currentState.anchorLongitude,
    latitude,
    longitude,
  );

  if (movedMeters >= stationaryRadiusMeters) {
    return {
      previousMode: currentState.mode,
      nextMode: 'moving',
      modeChanged: currentState.mode !== 'moving',
      movedMeters,
      nextState: {
        mode: 'moving',
        anchorLatitude: latitude,
        anchorLongitude: longitude,
        stationarySinceMs: nowMs,
      },
    };
  }

  const elapsedStationaryMs = Math.max(0, nowMs - currentState.stationarySinceMs);
  const nextMode: AdaptiveLocationMode =
    currentState.mode === 'idle' || elapsedStationaryMs >= dwellThresholdMs ? 'idle' : 'moving';

  return {
    previousMode: currentState.mode,
    nextMode,
    modeChanged: nextMode !== currentState.mode,
    movedMeters,
    nextState: {
      mode: nextMode,
      anchorLatitude: currentState.anchorLatitude,
      anchorLongitude: currentState.anchorLongitude,
      stationarySinceMs: currentState.stationarySinceMs,
    },
  };
}

export interface WatchdogAdapter {
  isTrackingEnabled(): Promise<boolean>;
  hasActiveSession(): Promise<boolean>;
  getBackgroundPermissionLevel(): Promise<'always' | 'foreground' | 'denied'>;
  hasLocationServicesEnabled(): Promise<boolean>;
  isContinuousLocationActive(): Promise<boolean>;
  startContinuousLocationUpdates(): Promise<void>;
  getPendingLocationCount(): Promise<number>;
  flushOfflineLocations(): Promise<void>;
  getBatteryLevel(): Promise<number | null>;
  sendHeartbeat(trackingState: TrackingState, batteryLevel: number | null): Promise<void>;
}

export interface WatchdogRunResult {
  action:
    | 'skipped'
    | 'permission_denied'
    | 'gps_off'
    | 'restarted_and_synced'
    | 'interrupted'
    | 'flushed_queue'
    | 'heartbeat_sent';
}

/**
 * Executes one OS background-task watchdog pass: verifies permissions and GPS
 * provider availability, attempts to recover a stopped location task, flushes
 * pending offline fixes, and emits a lightweight liveness/status heartbeat.
 */
export async function runWatchdogCheck(adapter: WatchdogAdapter): Promise<WatchdogRunResult> {
  const [trackingEnabled, activeSession] = await Promise.all([
    adapter.isTrackingEnabled(),
    adapter.hasActiveSession(),
  ]);
  if (!trackingEnabled || !activeSession) {
    return { action: 'skipped' };
  }

  const batteryLevel = await adapter.getBatteryLevel().catch(() => null);
  const permissionLevel = await adapter.getBackgroundPermissionLevel();
  if (permissionLevel !== 'always') {
    await adapter.sendHeartbeat('permission_denied', batteryLevel).catch(() => {});
    return { action: 'permission_denied' };
  }

  const servicesEnabled = await adapter.hasLocationServicesEnabled().catch(() => true);
  if (!servicesEnabled) {
    await adapter.sendHeartbeat('gps_off', batteryLevel).catch(() => {});
    return { action: 'gps_off' };
  }

  const continuousActive = await adapter.isContinuousLocationActive().catch(() => false);
  if (!continuousActive) {
    try {
      await adapter.startContinuousLocationUpdates();
      const pending = await adapter.getPendingLocationCount().catch(() => 0);
      if (pending > 0) {
        await adapter.flushOfflineLocations().catch(() => {});
      }
      await adapter.sendHeartbeat('idle', batteryLevel).catch(() => {});
      return { action: 'restarted_and_synced' };
    } catch {
      await adapter.sendHeartbeat('interrupted', batteryLevel).catch(() => {});
      return { action: 'interrupted' };
    }
  }

  const pending = await adapter.getPendingLocationCount().catch(() => 0);
  if (pending > 0) {
    try {
      await adapter.flushOfflineLocations();
      return { action: 'flushed_queue' };
    } catch {
      // Fall through to heartbeat attempt if flush failed
    }
  }

  await adapter.sendHeartbeat('idle', batteryLevel).catch(() => {});
  return { action: 'heartbeat_sent' };
}
