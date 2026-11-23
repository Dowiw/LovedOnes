import {
  haversineMeters,
  STATIONARY_COALESCE_RADIUS_METERS,
  type TrackingState,
} from '@loved-ones/shared';
import type { AdaptiveTrackingState } from './secureConfig';

export const BACKGROUND_WATCHDOG_TASK = 'LOVED_ONES_BACKGROUND_WATCHDOG_TASK';
export const WATCHDOG_MINIMUM_INTERVAL_MINUTES = 15;
export const STATIONARY_DWELL_BEFORE_IDLE_MS = 60_000;
export const DEFAULT_WARMUP_PING_COUNT = 3;
export const DEFAULT_WARMUP_WINDOW_MS = 30_000;
export const TURN_TRIGGER_HEADING_DELTA_DEG = 35;
export const TURN_TRIGGER_MIN_SPEED_MPS = 1.2;
export const TURN_TRIGGER_MIN_INTERVAL_MS = 3_000;

export interface TurnSampleCandidate {
  heading?: number | null;
  speed?: number | null;
  recordedAtMs: number;
}

/**
 * Returns shortest circular angular difference in degrees [0, 180] between two compass bearings.
 */
export function shortestHeadingDeltaDegrees(headingA: number, headingB: number): number {
  const diff = Math.abs(headingA - headingB) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Evaluates whether a moving device has turned sharply enough (`|Δheading| >= 35°`
 * at `speed >= 1.2 m/s` and `dt >= 3s`) to flush an immediate corner sample so street
 * intersections are anchored at the vertex instead of cutting diagonally across blocks.
 */
export function shouldTriggerTurnSample(
  previousSample: TurnSampleCandidate | null,
  currentSample: TurnSampleCandidate,
  minHeadingDeltaDeg = TURN_TRIGGER_HEADING_DELTA_DEG,
  minSpeedMps = TURN_TRIGGER_MIN_SPEED_MPS,
  minIntervalMs = TURN_TRIGGER_MIN_INTERVAL_MS,
): boolean {
  if (!previousSample) return false;
  const prevHeading = previousSample.heading;
  const currHeading = currentSample.heading;
  const currSpeed = currentSample.speed;
  if (
    typeof prevHeading !== 'number' ||
    !Number.isFinite(prevHeading) ||
    prevHeading < 0 ||
    prevHeading > 360 ||
    typeof currHeading !== 'number' ||
    !Number.isFinite(currHeading) ||
    currHeading < 0 ||
    currHeading > 360 ||
    typeof currSpeed !== 'number' ||
    !Number.isFinite(currSpeed) ||
    currSpeed < minSpeedMps
  ) {
    return false;
  }
  const elapsedMs = currentSample.recordedAtMs - previousSample.recordedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < minIntervalMs) {
    return false;
  }
  return shortestHeadingDeltaDegrees(prevHeading, currHeading) >= minHeadingDeltaDeg;
}

export type AdaptiveLocationMode = 'moving' | 'idle';

export interface AdaptiveModeEvaluation {
  previousMode: AdaptiveLocationMode;
  nextMode: AdaptiveLocationMode;
  modeChanged: boolean;
  isWarmup: boolean;
  movedMeters: number;
  nextState: AdaptiveTrackingState;
}

/** Returns true while cold-start high-accuracy warmup pings are still active. */
export function isAdaptiveWarmupActive(
  state: AdaptiveTrackingState | null,
  nowMs = Date.now(),
): boolean {
  if (!state) return true;
  const remaining = state.warmupRemainingPings ?? 0;
  const untilMs = state.warmupUntilMs ?? 0;
  return remaining > 0 && nowMs < untilMs;
}

/** Creates a fresh high-accuracy warmup state when starting or resuming tracking. */
export function createInitialAdaptiveWarmupState(
  latitude: number,
  longitude: number,
  nowMs = Date.now(),
): AdaptiveTrackingState {
  return {
    mode: 'moving',
    anchorLatitude: latitude,
    anchorLongitude: longitude,
    stationarySinceMs: nowMs,
    warmupRemainingPings: DEFAULT_WARMUP_PING_COUNT,
    warmupUntilMs: nowMs + DEFAULT_WARMUP_WINDOW_MS,
  };
}

/**
 * Computes whether background location polling should stay in fast moving mode
 * (15s, High accuracy) or step down to low-power idle check-in mode (5 min, Balanced)
 * after cold-start warmup completes and the device stays within 20m for 60s.
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
    const remaining = Math.max(0, DEFAULT_WARMUP_PING_COUNT - 1);
    const warmupUntilMs = nowMs + DEFAULT_WARMUP_WINDOW_MS;
    return {
      previousMode: 'moving',
      nextMode: 'moving',
      modeChanged: false,
      isWarmup: remaining > 0,
      movedMeters: 0,
      nextState: {
        mode: 'moving',
        anchorLatitude: latitude,
        anchorLongitude: longitude,
        stationarySinceMs: nowMs,
        warmupRemainingPings: remaining,
        warmupUntilMs,
      },
    };
  }

  const nextWarmupRemaining = Math.max(0, (currentState.warmupRemainingPings ?? 0) - 1);
  const nextWarmupUntilMs = currentState.warmupUntilMs ?? 0;
  const isWarmup = nextWarmupRemaining > 0 && nowMs < nextWarmupUntilMs;

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
      isWarmup,
      movedMeters,
      nextState: {
        mode: 'moving',
        anchorLatitude: latitude,
        anchorLongitude: longitude,
        stationarySinceMs: nowMs,
        warmupRemainingPings: nextWarmupRemaining,
        warmupUntilMs: nextWarmupUntilMs,
      },
    };
  }

  const elapsedStationaryMs = Math.max(0, nowMs - currentState.stationarySinceMs);
  const nextMode: AdaptiveLocationMode =
    !isWarmup && (currentState.mode === 'idle' || elapsedStationaryMs >= dwellThresholdMs)
      ? 'idle'
      : 'moving';

  return {
    previousMode: currentState.mode,
    nextMode,
    modeChanged: nextMode !== currentState.mode,
    isWarmup,
    movedMeters,
    nextState: {
      mode: nextMode,
      anchorLatitude: currentState.anchorLatitude,
      anchorLongitude: currentState.anchorLongitude,
      stationarySinceMs: currentState.stationarySinceMs,
      warmupRemainingPings: nextWarmupRemaining,
      warmupUntilMs: nextWarmupUntilMs,
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
