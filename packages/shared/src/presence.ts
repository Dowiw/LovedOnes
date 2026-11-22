import type { TrackingState } from './schemas.js';

export const MOVING_CHECKIN_INTERVAL_MS = 15_000;
export const MOVING_DISTANCE_INTERVAL_METERS = 20;
export const IDLE_CHECKIN_INTERVAL_MS = 300_000;
export const STATIONARY_COALESCE_RADIUS_METERS = 20;
export const PRESENCE_RECENT_FIX_MS = 3 * 60_000;
export const PRESENCE_OFFLINE_THRESHOLD_MS = 15 * 60_000;

export type MemberPresenceKind =
  | 'moving'
  | 'idle_at_place'
  | 'stationary'
  | 'paused'
  | 'permission_denied'
  | 'gps_off'
  | 'interrupted'
  | 'offline';

export interface ResolveMemberPresenceInput {
  recordedAt: string;
  lastHeartbeatAt?: string | null;
  trackingState?: TrackingState | null;
  isFuzzed?: boolean;
  insidePlaceName?: string | null;
  nowMs?: number;
}

export interface MemberPresenceStatus {
  kind: MemberPresenceKind;
  isOnline: boolean;
  label: string;
  detailText: string;
  shortText: string;
  placeName: string | null;
}

/**
 * Formats an ISO timestamp into a concise relative age without clock suffix (e.g. "Just now", "2m ago").
 */
export function formatRelativeAge(isoTimestamp: string, nowMs = Date.now()): string {
  const ts = Date.parse(isoTimestamp);
  if (!Number.isFinite(ts)) return 'Unknown';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 45) return 'Just now';
  if (diffSec < 3600) {
    const mins = Math.max(1, Math.floor(diffSec / 60));
    return `${mins}m ago`;
  }
  if (diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    return `${hrs}h ago`;
  }
  const days = Math.floor(diffSec / 86400);
  return `${days}d ago`;
}

/**
 * Formats an ISO timestamp into a concise human-friendly "Last seen at" string with clock time.
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

function formatClockLabel(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatOnlineClause(onlineMs: number, nowMs: number): string {
  const age = formatRelativeAge(new Date(onlineMs).toISOString(), nowMs);
  return age === 'Just now' ? 'online just now' : `online ${age}`;
}

/**
 * Resolves a member's human-readable liveness/idle status, separating stationary
 * online presence ("Idle at Dowi Home") from true signal loss ("No signal") or
 * explicit user/OS location disables while respecting FUZZED privacy.
 */
export function resolveMemberPresenceStatus(
  input: ResolveMemberPresenceInput,
): MemberPresenceStatus {
  const nowMs = input.nowMs ?? Date.now();
  const recordedMs = Date.parse(input.recordedAt);
  const heartbeatMs = input.lastHeartbeatAt ? Date.parse(input.lastHeartbeatAt) : Number.NaN;

  const hasExplicitStopState =
    input.trackingState === 'paused' ||
    input.trackingState === 'permission_denied' ||
    input.trackingState === 'gps_off' ||
    input.trackingState === 'interrupted';

  const stopNotSupersededByNewerFix =
    !Number.isFinite(recordedMs) || !Number.isFinite(heartbeatMs) || heartbeatMs >= recordedMs - 1000;

  if (hasExplicitStopState && stopNotSupersededByNewerFix) {
    const refMs = Number.isFinite(heartbeatMs) ? heartbeatMs : recordedMs;
    const clockSuffix = Number.isFinite(refMs) ? ` · ${formatClockLabel(refMs)}` : '';
    switch (input.trackingState) {
      case 'paused':
        return {
          kind: 'paused',
          isOnline: false,
          label: 'Sharing paused',
          detailText: `Sharing paused${clockSuffix}`,
          shortText: 'Sharing paused',
          placeName: null,
        };
      case 'permission_denied':
        return {
          kind: 'permission_denied',
          isOnline: false,
          label: 'Location permission off',
          detailText: `Location permission off${clockSuffix}`,
          shortText: 'Permission off',
          placeName: null,
        };
      case 'gps_off':
        return {
          kind: 'gps_off',
          isOnline: false,
          label: 'Location services off',
          detailText: `Location services off${clockSuffix}`,
          shortText: 'GPS off',
          placeName: null,
        };
      case 'interrupted':
        return {
          kind: 'interrupted',
          isOnline: false,
          label: 'Background task interrupted',
          detailText: `Background task interrupted${clockSuffix}`,
          shortText: 'Interrupted',
          placeName: null,
        };
    }
  }

  const recordedAgeMs = Number.isFinite(recordedMs) ? Math.max(0, nowMs - recordedMs) : Infinity;
  if (recordedAgeMs < PRESENCE_RECENT_FIX_MS) {
    const rel = formatLastSeenRelative(input.recordedAt, nowMs);
    const shortAge = formatRelativeAge(input.recordedAt, nowMs);
    return {
      kind: 'moving',
      isOnline: true,
      label: rel,
      detailText: rel,
      shortText: shortAge,
      placeName: !input.isFuzzed && input.insidePlaceName ? input.insidePlaceName : null,
    };
  }

  const effectiveOnlineMs =
    Number.isFinite(heartbeatMs) && Number.isFinite(recordedMs)
      ? Math.max(heartbeatMs, recordedMs)
      : Number.isFinite(heartbeatMs)
        ? heartbeatMs
        : recordedMs;
  const onlineAgeMs = Number.isFinite(effectiveOnlineMs)
    ? Math.max(0, nowMs - effectiveOnlineMs)
    : Infinity;

  if (onlineAgeMs <= PRESENCE_OFFLINE_THRESHOLD_MS) {
    const sinceClock = Number.isFinite(recordedMs) ? ` · since ${formatClockLabel(recordedMs)}` : '';
    const onlineClause = formatOnlineClause(effectiveOnlineMs, nowMs);

    if (!input.isFuzzed && input.insidePlaceName) {
      return {
        kind: 'idle_at_place',
        isOnline: true,
        label: `Idle at ${input.insidePlaceName}`,
        detailText: `Idle at ${input.insidePlaceName}${sinceClock} · ${onlineClause}`,
        shortText: `Idle at ${input.insidePlaceName}`,
        placeName: input.insidePlaceName,
      };
    }

    const baseLabel = input.isFuzzed ? 'Stationary (~1 km)' : 'Stationary';
    return {
      kind: 'stationary',
      isOnline: true,
      label: baseLabel,
      detailText: `${baseLabel}${sinceClock} · ${onlineClause}`,
      shortText: baseLabel,
      placeName: null,
    };
  }

  const lastSeen = formatLastSeenRelative(input.recordedAt, nowMs);
  const shortAgo = formatRelativeAge(input.recordedAt, nowMs);
  return {
    kind: 'offline',
    isOnline: false,
    label: 'No signal',
    detailText: `No signal · ${lastSeen}`,
    shortText: `No signal · ${shortAgo}`,
    placeName: null,
  };
}
