'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  Eye,
  Filter,
  ListFilter,
  Maximize2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Route as RouteIcon,
  SlidersHorizontal,
  X,
  Zap,
} from 'lucide-react';
import {
  buildTimelapseTimeline,
  buildTrailTrips,
  formatStayDuration,
  realToVirtualMs,
  sampleTimelapseFrame,
  sortTrailTrips,
  TIMELAPSE_SPEED_OPTIONS,
  TRAIL_ACTIVITY_META,
  virtualToRealMs,
  type GroupPlace,
  type LocationBroadcast,
  type MatchedUserTrail,
  type TimelapseFrame,
  type TimelapseSpeedOption,
  type TrailDisplayMode,
  type TrailsResponseMeta,
  type TrailTimeRangePreset,
  type TrailTripSort,
  type TrailTripSummary,
} from '@loved-ones/shared';

export interface TrailsTimeRangeState {
  preset: TrailTimeRangePreset;
  customMode: 'day' | 'range';
  customDay: string; // YYYY-MM-DD
  customFrom: string; // YYYY-MM-DD
  customTo: string; // YYYY-MM-DD
}

interface TrailsTimelapseOverlayProps {
  trails: LocationBroadcast[];
  matchedTrails: MatchedUserTrail[];
  places: GroupPlace[];
  members: Array<{ userId: string; username: string }>;
  meta: TrailsResponseMeta | null;
  loading: boolean;
  timeRange: TrailsTimeRangeState;
  onChangeTimeRange: (next: TrailsTimeRangeState) => void;
  selectedMemberId: string | null;
  onChangeSelectedMemberId: (userId: string | null) => void;
  trailDisplayMode: TrailDisplayMode;
  onChangeTrailDisplayMode: (mode: TrailDisplayMode) => void;
  colorTrailsByActivity: boolean;
  onToggleColorByActivity: () => void;
  focusedTrip: TrailTripSummary | null;
  onSelectTrip: (trip: TrailTripSummary | null) => void;
  focusMode: boolean;
  onChangeFocusMode: (active: boolean) => void;
  followUserId: string | null;
  onChangeFollowUserId: (userId: string | null) => void;
  onFitTrails: () => void;
  onTimelapseFrame: (frame: TimelapseFrame | null) => void;
  hideTopBar?: boolean;
  hideBottomBarOnCompact?: boolean;
  hideBottomBarOnMedium?: boolean;
  closePopoversNonce?: number;
  onRequestCloseOtherPanels?: () => void;
}

function formatShortDistance(meters: number, approx: boolean): string {
  const prefix = approx ? '~' : '';
  if (meters >= 1000) {
    return `${prefix}${(meters / 1000).toFixed(approx ? 0 : 1)} km`;
  }
  return `${prefix}${Math.round(meters)} m`;
}

function formatClockTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatClockDateAndTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}`;
}

interface RotarySpeedDialProps {
  speed: TimelapseSpeedOption;
  onChange: (next: TimelapseSpeedOption) => void;
}

/**
 * Mobile-web vertical safe-dial speed tumbler mounted along the right edge.
 * Supports touch dragging, wheel scrolling, and direct taps on speed numbers.
 */
function MobileRotarySpeedDial({ speed, onChange }: RotarySpeedDialProps) {
  const dragStartYRef = useRef<number | null>(null);
  const dragStartIdxRef = useRef<number>(TIMELAPSE_SPEED_OPTIONS.indexOf(speed));
  const activeIdx = Math.max(0, TIMELAPSE_SPEED_OPTIONS.indexOf(speed));

  const commitIndex = (rawIdx: number) => {
    const clamped = Math.max(0, Math.min(TIMELAPSE_SPEED_OPTIONS.length - 1, Math.round(rawIdx)));
    const nextSpeed = TIMELAPSE_SPEED_OPTIONS[clamped];
    if (nextSpeed !== speed) onChange(nextSpeed);
  };

  return (
    <div
      className="pointer-events-auto fixed right-2 top-1/2 z-30 flex -translate-y-1/2 select-none flex-col items-center sm:hidden"
      aria-label="Timelapse playback speed dial"
      onPointerDown={(e) => {
        dragStartYRef.current = e.clientY;
        dragStartIdxRef.current = activeIdx;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragStartYRef.current === null) return;
        const dy = dragStartYRef.current - e.clientY;
        const stepOffset = Math.round(dy / 26);
        commitIndex(dragStartIdxRef.current + stepOffset);
      }}
      onPointerUp={() => {
        dragStartYRef.current = null;
      }}
      onPointerCancel={() => {
        dragStartYRef.current = null;
      }}
      onWheel={(e) => {
        e.preventDefault();
        commitIndex(activeIdx + (e.deltaY > 0 ? 1 : -1));
      }}
    >
      <div className="relative flex flex-col items-center gap-0.5 rounded-2xl border border-zinc-200/85 bg-white/92 px-1.5 py-2 shadow-[0_12px_32px_rgba(9,9,11,0.16)] backdrop-blur-xl dark:border-zinc-700/80 dark:bg-zinc-900/92">
        <div className="mb-0.5 text-[8px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Dial
        </div>
        {TIMELAPSE_SPEED_OPTIONS.map((opt, idx) => {
          const dist = Math.abs(idx - activeIdx);
          const isCurrent = idx === activeIdx;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`relative flex h-7 w-10 items-center justify-center rounded-lg font-mono transition-all duration-150 ${
                isCurrent
                  ? 'scale-105 bg-zinc-950 text-[11px] font-bold text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                  : dist === 1
                    ? 'text-[10px] font-semibold text-zinc-600 hover:text-zinc-950 dark:text-zinc-300'
                    : 'text-[9px] text-zinc-400 opacity-65 dark:text-zinc-500'
              }`}
            >
              <span
                className={`absolute left-0.5 h-2 w-0.5 rounded-full ${
                  isCurrent ? 'bg-emerald-400 dark:bg-emerald-600' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
              />
              {opt}x
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TrailsTimelapseOverlay({
  trails,
  matchedTrails,
  places,
  members,
  meta,
  loading,
  timeRange,
  onChangeTimeRange,
  selectedMemberId,
  onChangeSelectedMemberId,
  trailDisplayMode,
  onChangeTrailDisplayMode,
  colorTrailsByActivity,
  onToggleColorByActivity,
  focusedTrip,
  onSelectTrip,
  focusMode,
  onChangeFocusMode,
  followUserId,
  onChangeFollowUserId,
  onFitTrails,
  onTimelapseFrame,
  hideTopBar = false,
  hideBottomBarOnCompact = false,
  hideBottomBarOnMedium = false,
  closePopoversNonce = 0,
  onRequestCloseOtherPanels,
}: TrailsTimelapseOverlayProps) {
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [tripsOpen, setTripsOpen] = useState(false);
  const [sortBy, setSortBy] = useState<TrailTripSort>('newest');
  const [includeStays, setIncludeStays] = useState(false);

  // Close Trips & Time-Window popovers whenever Hamburger, Group, Inspector, or Map Options opens
  useEffect(() => {
    if (hideTopBar || closePopoversNonce > 0) {
      setControlsExpanded(false);
      setTripsOpen(false);
    }
  }, [hideTopBar, closePopoversNonce]);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<TimelapseSpeedOption>(10);
  const [loop, setLoop] = useState(false);
  const [compactIdle, setCompactIdle] = useState(true);
  const [virtualMs, setVirtualMs] = useState(0);
  const [timelapseEngaged, setTimelapseEngaged] = useState(false);

  // Build trips from active dataset
  const trips = useMemo(() => {
    const built = buildTrailTrips({
      trails,
      matchedTrails,
      mode: trailDisplayMode,
      filterUserId: selectedMemberId,
      places,
      includeStays,
    });
    return sortTrailTrips(built, sortBy);
  }, [trails, matchedTrails, trailDisplayMode, selectedMemberId, places, includeStays, sortBy]);

  // Build synchronized timelapse timeline (connects all trips unless a single trip is focused)
  const timeline = useMemo(
    () =>
      buildTimelapseTimeline({
        trails,
        matchedTrails,
        mode: trailDisplayMode,
        filterUserId: selectedMemberId,
        focusTrip: focusedTrip
          ? {
              userId: focusedTrip.userId,
              startedAt: focusedTrip.startedAt,
              endedAt: focusedTrip.endedAt,
            }
          : null,
        compactIdle,
      }),
    [trails, matchedTrails, trailDisplayMode, selectedMemberId, focusedTrip, compactIdle],
  );

  // Reset scrubber smoothly when dataset/focus changes
  const prevTimelineSigRef = useRef<string>('');
  useEffect(() => {
    const sig = `${timeline.realStartMs}:${timeline.realEndMs}:${timeline.tracks.length}:${focusedTrip?.id ?? 'all'}`;
    if (sig !== prevTimelineSigRef.current) {
      prevTimelineSigRef.current = sig;
      setPlaying(false);
      setVirtualMs(timeline.virtualDurationMs);
      if (!focusedTrip) {
        setTimelapseEngaged(false);
        onChangeFocusMode(false);
      }
    }
  }, [timeline, focusedTrip, onChangeFocusMode]);

  // Push current frame whenever engaged, or clear back to static trail when parked at 100% and idle
  const currentRealMs = useMemo(
    () => virtualToRealMs(timeline, virtualMs),
    [timeline, virtualMs],
  );

  useEffect(() => {
    if (timeline.isEmpty || (!timelapseEngaged && !playing && !focusMode)) {
      onTimelapseFrame(null);
      return;
    }
    onTimelapseFrame(sampleTimelapseFrame(timeline, currentRealMs, { places }));
  }, [timeline, currentRealMs, timelapseEngaged, playing, focusMode, places, onTimelapseFrame]);

  // Clean up on unmount
  useEffect(() => () => onTimelapseFrame(null), [onTimelapseFrame]);

  // 60 FPS requestAnimationFrame loop
  const rafRef = useRef<number | null>(null);
  const virtualMsRef = useRef(virtualMs);
  virtualMsRef.current = virtualMs;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!playing || timeline.isEmpty || timeline.virtualDurationMs <= 0) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    let lastFrameAt = performance.now();
    const tick = (now: number) => {
      if (!playingRef.current) return;
      const dtMs = Math.min(100, Math.max(0, now - lastFrameAt));
      lastFrameAt = now;
      const nextV = virtualMsRef.current + dtMs * speed;
      if (nextV >= timeline.virtualDurationMs) {
        if (loop) {
          virtualMsRef.current = 0;
          setVirtualMs(0);
        } else {
          virtualMsRef.current = timeline.virtualDurationMs;
          setVirtualMs(timeline.virtualDurationMs);
          setPlaying(false);
          return;
        }
      } else {
        virtualMsRef.current = nextV;
        setVirtualMs(nextV);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playing, speed, loop, timeline]);

  const followCandidateUserId = focusedTrip?.userId ?? selectedMemberId;
  const canFollowMember = Boolean(followCandidateUserId);

  const handleTogglePlay = () => {
    if (timeline.isEmpty) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    setTimelapseEngaged(true);
    onChangeFocusMode(true);
    if (virtualMs >= timeline.virtualDurationMs - 50) {
      setVirtualMs(0);
      virtualMsRef.current = 0;
    }
    setPlaying(true);
  };

  const handleExitFocus = () => {
    setPlaying(false);
    setTimelapseEngaged(false);
    setVirtualMs(timeline.virtualDurationMs);
    onChangeFocusMode(false);
    onChangeFollowUserId(null);
  };

  const scrubPercent =
    timeline.virtualDurationMs > 0
      ? Math.max(0, Math.min(100, (virtualMs / timeline.virtualDurationMs) * 100))
      : 100;

  const activeSegment = useMemo(
    () =>
      timeline.segments.find(
        (s) => currentRealMs >= s.realStartMs && currentRealMs <= s.realEndMs,
      ) ?? null,
    [timeline.segments, currentRealMs],
  );

  const rangeBadgeLabel =
    timeRange.preset === 'custom'
      ? timeRange.customMode === 'day'
        ? timeRange.customDay
        : `${timeRange.customFrom} → ${timeRange.customTo}`
      : timeRange.preset;

  const topBarHidden = focusMode || hideTopBar;
  const bottomBarHiddenCompact = !focusMode && hideBottomBarOnCompact;
  const bottomBarHiddenMedium = !focusMode && hideBottomBarOnMedium;

  return (
    <>
      {/* Progressive-Disclosure Top-Center / Top-Left Trails Filter & Trip Explorer (fades out in Focus Mode or when Hamburger/Group popover is open) */}
      <div
        className={`pointer-events-none fixed left-[calc(0.75rem+var(--lo-safe-left,0px))] right-[calc(0.75rem+var(--lo-safe-right,0px))] top-[calc(4.1rem+var(--lo-safe-top,0px))] z-20 flex flex-col items-start gap-2 transition-all duration-300 sm:left-[calc(1rem+var(--lo-safe-left,0px))] sm:right-auto sm:top-[calc(4.5rem+var(--lo-safe-top,0px))] sm:w-[316px] ${
          topBarHidden ? 'pointer-events-none -translate-y-3 opacity-0 [&_*]:!pointer-events-none' : ''
        }`}
        aria-hidden={topBarHidden}
      >
        {/* Compact Summary Pill */}
        <div className="lo-float-in pointer-events-auto flex w-full flex-wrap items-center gap-1.5 rounded-xl border border-zinc-200/85 bg-white/95 p-1.5 shadow-[0_8px_28px_rgba(9,9,11,0.1)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
          <button
            type="button"
            onClick={() => {
              setControlsExpanded((v) => {
                const next = !v;
                if (next) {
                  setTripsOpen(false);
                  onRequestCloseOtherPanels?.();
                }
                return next;
              });
            }}
            className="lo-press flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold text-zinc-900 transition hover:bg-zinc-200/80 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            <Calendar className="h-3.5 w-3.5 text-zinc-600 dark:text-zinc-300" />
            <span>{rangeBadgeLabel}</span>
            {controlsExpanded ? (
              <ChevronUp className="h-3 w-3 text-zinc-500" />
            ) : (
              <ChevronDown className="h-3 w-3 text-zinc-500" />
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setTripsOpen((v) => {
                const next = !v;
                if (next) {
                  setControlsExpanded(false);
                  onRequestCloseOtherPanels?.();
                }
                return next;
              });
            }}
            className={`lo-press flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
              tripsOpen
                ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                : 'bg-zinc-100 text-zinc-800 hover:bg-zinc-200/80 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
            }`}
          >
            <RouteIcon className="h-3.5 w-3.5" />
            <span>Trips ({trips.length})</span>
          </button>

          {focusedTrip && (
            <button
              type="button"
              onClick={() => onSelectTrip(null)}
              className="lo-press ml-auto flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-800 hover:bg-amber-500/25 dark:text-amber-300"
            >
              <RotateCcw className="h-3 w-3" />
              Full range
            </button>
          )}

          {loading && (
            <span className="ml-auto px-1.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
              Loading…
            </span>
          )}
        </div>

        {/* Expanded Time Range + Member Filter (Progressive Disclosure) */}
        {controlsExpanded && (
          <div className="lo-float-in pointer-events-auto w-full space-y-2.5 rounded-xl border border-zinc-200/85 bg-white/95 p-3 shadow-[0_14px_40px_rgba(9,9,11,0.14)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                <Clock className="h-3.5 w-3.5" />
                Time Window
              </span>
              {meta?.truncated && (
                <span
                  title={`Showing ${meta.returnedCount} of ${meta.totalCount} points sampled across the range`}
                  className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                >
                  Sampled · select Trip for detail
                </span>
              )}
            </div>

            <div className="grid grid-cols-5 gap-1 rounded-lg bg-zinc-100 p-0.5 text-[11px] font-semibold dark:bg-zinc-800">
              {(['24h', '3d', '7d', '30d', 'custom'] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => onChangeTimeRange({ ...timeRange, preset })}
                  className={`lo-press rounded-md py-1 transition ${
                    timeRange.preset === preset
                      ? 'bg-zinc-950 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                      : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  {preset === 'custom' ? 'Custom' : preset}
                </button>
              ))}
            </div>

            {timeRange.preset === 'custom' && (
              <div className="space-y-2 rounded-lg border border-zinc-200/80 bg-zinc-50/70 p-2 dark:border-zinc-800 dark:bg-zinc-800/50">
                <div className="flex items-center gap-1 text-[10px] font-semibold">
                  {(
                    [
                      ['day', 'Single Day'],
                      ['range', 'From → To'],
                    ] as const
                  ).map(([modeKey, label]) => (
                    <button
                      key={modeKey}
                      type="button"
                      onClick={() => onChangeTimeRange({ ...timeRange, customMode: modeKey })}
                      className={`rounded-md px-2 py-1 transition ${
                        timeRange.customMode === modeKey
                          ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                          : 'text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {timeRange.customMode === 'day' ? (
                  <input
                    type="date"
                    value={timeRange.customDay}
                    onChange={(e) =>
                      onChangeTimeRange({ ...timeRange, customDay: e.target.value })
                    }
                    className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      type="date"
                      value={timeRange.customFrom}
                      onChange={(e) =>
                        onChangeTimeRange({ ...timeRange, customFrom: e.target.value })
                      }
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                    <input
                      type="date"
                      value={timeRange.customTo}
                      onChange={(e) =>
                        onChangeTimeRange({ ...timeRange, customTo: e.target.value })
                      }
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Member Filter */}
            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                <Filter className="h-3.5 w-3.5 text-zinc-500" />
                Member
              </span>
              <select
                value={selectedMemberId ?? ''}
                onChange={(e) => {
                  const next = e.target.value || null;
                  onChangeSelectedMemberId(next);
                  if (focusedTrip && next && focusedTrip.userId !== next) {
                    onSelectTrip(null);
                  }
                }}
                className="max-w-[190px] rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="">All visible members</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.username}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Sortable Trip List Drawer (Progressive Disclosure) */}
        {tripsOpen && (
          <div className="lo-float-in pointer-events-auto flex max-h-[min(46dvh,380px)] w-full flex-col overflow-hidden rounded-xl border border-zinc-200/85 bg-white/95 shadow-[0_14px_40px_rgba(9,9,11,0.16)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <div className="flex items-center gap-1.5">
                <ListFilter className="h-3.5 w-3.5 text-zinc-500" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as TrailTripSort)}
                  aria-label="Sort trips"
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] font-semibold text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="member">By member</option>
                  <option value="duration_desc">Longest duration</option>
                  <option value="duration_asc">Shortest duration</option>
                  <option value="distance_desc">Longest distance</option>
                  <option value="distance_asc">Shortest distance</option>
                </select>
              </div>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={includeStays}
                  onChange={(e) => setIncludeStays(e.target.checked)}
                  className="h-3.5 w-3.5 rounded accent-zinc-950 dark:accent-zinc-100"
                />
                Stays
              </label>
            </div>

            <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
              {trips.map((trip) => {
                const isSelected = focusedTrip?.id === trip.id;
                const actMeta = trip.primaryActivityMode
                  ? TRAIL_ACTIVITY_META[trip.primaryActivityMode]
                  : null;
                const routeLabel = trip.isFuzzed
                  ? 'Approximate area'
                  : trip.originLabel && trip.destinationLabel
                    ? trip.originLabel === trip.destinationLabel
                      ? `Around ${trip.originLabel}`
                      : `${trip.originLabel} → ${trip.destinationLabel}`
                    : trip.originLabel
                      ? `From ${trip.originLabel}`
                      : trip.destinationLabel
                        ? `To ${trip.destinationLabel}`
                        : `${trip.stopCount} stop${trip.stopCount === 1 ? '' : 's'}`;

                return (
                  <button
                    key={trip.id}
                    type="button"
                    onClick={() => {
                      onSelectTrip(isSelected ? null : trip);
                      setTripsOpen(false);
                    }}
                    className={`lo-press w-full rounded-lg border px-2.5 py-2 text-left transition ${
                      isSelected
                        ? 'border-zinc-950 bg-zinc-950 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                        : 'border-zinc-200/80 bg-zinc-50/70 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold">{trip.username}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {actMeta && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] font-medium dark:bg-white/10">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: actMeta.color }}
                            />
                            {actMeta.shortLabel}
                          </span>
                        )}
                        {trip.isFuzzed && (
                          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 dark:text-amber-300">
                            Fuzzed
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className={`mt-0.5 truncate text-[11px] ${
                        isSelected
                          ? 'text-zinc-200 dark:text-zinc-700'
                          : 'text-zinc-600 dark:text-zinc-300'
                      }`}
                    >
                      {routeLabel}
                    </div>
                    <div
                      className={`mt-1 flex items-center justify-between font-mono text-[10px] ${
                        isSelected
                          ? 'text-zinc-300 dark:text-zinc-600'
                          : 'text-zinc-500 dark:text-zinc-400'
                      }`}
                    >
                      <span>
                        {formatClockTime(Date.parse(trip.startedAt))} –{' '}
                        {formatClockTime(Date.parse(trip.endedAt))}
                      </span>
                      <span>
                        {formatStayDuration(trip.durationMs)} ·{' '}
                        {formatShortDistance(trip.distanceMeters, trip.isApproximateDistance)}
                      </span>
                    </div>
                  </button>
                );
              })}
              {trips.length === 0 && (
                <p className="py-5 text-center text-xs text-zinc-500 dark:text-zinc-400">
                  No movement trips in this window.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Focus Mode Top Simulated Clock Badge */}
      {focusMode && !timeline.isEmpty && (
        <div className="lo-float-in pointer-events-none fixed left-1/2 top-[calc(0.9rem+var(--lo-safe-top,0px))] z-30 flex -translate-x-1/2 items-center gap-2">
          <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-zinc-200/85 bg-white/95 px-3.5 py-1.5 shadow-[0_10px_30px_rgba(9,9,11,0.16)] backdrop-blur-xl dark:border-zinc-700 dark:bg-zinc-900/95">
            <span
              className={`h-2 w-2 rounded-full ${
                playing ? 'animate-pulse bg-emerald-500' : 'bg-zinc-400'
              }`}
            />
            <span className="font-mono text-xs font-semibold text-zinc-950 dark:text-zinc-50">
              {formatClockDateAndTime(currentRealMs)}
            </span>
            {activeSegment?.compressed && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                Idle skipped
              </span>
            )}
            <button
              type="button"
              onClick={handleExitFocus}
              title="Exit focus mode"
              className="lo-press ml-1 flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <Eye className="h-3 w-3" />
              Show UI
            </button>
          </div>
        </div>
      )}

      {/* Mobile Web Side Rotary Safe-Dial Speed Tumbler (visible on < sm in Trails mode when no sheet covers screen) */}
      {!timeline.isEmpty && !bottomBarHiddenCompact && (
        <MobileRotarySpeedDial speed={speed} onChange={setSpeed} />
      )}

      {/* Bottom-Center Timelapse Player + Clean/Raw/Activity Controls */}
      <div
        className={`pointer-events-none fixed left-1/2 z-20 flex w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 flex-col items-center gap-1.5 transition-all duration-300 ${
          focusMode
            ? 'bottom-[calc(1rem+var(--lo-safe-bottom,0px))] z-30'
            : 'bottom-[calc(4.15rem+var(--lo-safe-bottom,0px))] sm:bottom-[calc(4.5rem+var(--lo-safe-bottom,0px))]'
        } ${
          bottomBarHiddenCompact
            ? 'max-md:translate-y-3 max-md:opacity-0 max-md:pointer-events-none max-md:[&_*]:!pointer-events-none'
            : ''
        } ${
          bottomBarHiddenMedium
            ? 'max-lg:translate-y-3 max-lg:opacity-0 max-lg:pointer-events-none max-lg:[&_*]:!pointer-events-none'
            : ''
        }`}
      >
        {/* Clean / Raw / Activity Pill + Legend (auto-hides in Focus Mode for distraction-free viewing) */}
        {!focusMode && (
          <div className="lo-float-in pointer-events-auto flex flex-col items-center gap-1">
            {colorTrailsByActivity && (
              <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-lg border border-zinc-200/80 bg-white/95 px-2.5 py-1 text-[10px] font-medium text-zinc-700 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-300">
                {(['walking', 'running', 'cycling', 'transit', 'driving', 'stationary'] as const).map(
                  (modeKey) => (
                    <span key={modeKey} className="inline-flex items-center gap-1">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: TRAIL_ACTIVITY_META[modeKey].color }}
                      />
                      {TRAIL_ACTIVITY_META[modeKey].shortLabel}
                    </span>
                  ),
                )}
              </div>
            )}
            <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200/80 bg-white/95 p-0.5 text-[10px] font-semibold shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95 sm:text-[11px]">
              {(
                [
                  ['roads', 'Clean'],
                  ['raw', 'Raw'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChangeTrailDisplayMode(mode)}
                  className={`lo-press rounded-md px-2.5 py-1 transition ${
                    trailDisplayMode === mode
                      ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                      : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="mx-0.5 h-3.5 w-px bg-zinc-200 dark:bg-zinc-700" />
              <button
                type="button"
                onClick={onToggleColorByActivity}
                className={`lo-press rounded-md px-2.5 py-1 transition ${
                  colorTrailsByActivity
                    ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                Activity
              </button>
            </div>
          </div>
        )}

        {/* Timelapse Scrubber & Controls Bar */}
        {!timeline.isEmpty && (
          <div className="lo-float-in pointer-events-auto w-full rounded-2xl border border-zinc-200/85 bg-white/95 px-3 py-2 shadow-[0_12px_36px_rgba(9,9,11,0.14)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
            {/* Scrubber Row with compressed-idle indicators */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={handleTogglePlay}
                aria-label={playing ? 'Pause timelapse' : 'Play timelapse'}
                className="lo-press flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
              </button>

              <div className="min-w-0 flex-1 space-y-1">
                <div className="relative flex h-4 items-center">
                  {/* Track background showing compressed idle bands */}
                  <div className="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    {timeline.virtualDurationMs > 0 &&
                      timeline.segments.map((seg, idx) =>
                        seg.compressed ? (
                          <div
                            key={idx}
                            className="absolute top-0 h-full bg-amber-400/55 dark:bg-amber-500/45"
                            style={{
                              left: `${(seg.virtualStartMs / timeline.virtualDurationMs) * 100}%`,
                              width: `${Math.max(
                                1,
                                ((seg.virtualEndMs - seg.virtualStartMs) /
                                  timeline.virtualDurationMs) *
                                  100,
                              )}%`,
                            }}
                          />
                        ) : null,
                      )}
                    <div
                      className="h-full bg-zinc-950 transition-[width] duration-75 dark:bg-zinc-100"
                      style={{ width: `${scrubPercent}%` }}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, timeline.virtualDurationMs)}
                    value={Math.round(virtualMs)}
                    onChange={(e) => {
                      setPlaying(false);
                      setTimelapseEngaged(true);
                      setVirtualMs(Number(e.target.value));
                    }}
                    aria-label="Timelapse scrubber"
                    className="relative z-10 h-4 w-full cursor-pointer appearance-none bg-transparent accent-zinc-950 dark:accent-zinc-100"
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                  <span>{formatClockTime(timeline.realStartMs)}</span>
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {formatClockDateAndTime(currentRealMs)}
                  </span>
                  <span>{formatClockTime(timeline.realEndMs)}</span>
                </div>
              </div>
            </div>

            {/* Secondary Controls Row */}
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCompactIdle((v) => !v)}
                  title="Shorten multi-minute stationary dwells into quick pauses"
                  className={`lo-press flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                    compactIdle
                      ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                      : 'bg-zinc-100 text-zinc-600 hover:text-zinc-950 dark:bg-zinc-800 dark:text-zinc-400'
                  }`}
                >
                  <Zap className="h-3 w-3" />
                  Shorten idle
                </button>

                <button
                  type="button"
                  onClick={() => setLoop((v) => !v)}
                  title="Loop timelapse"
                  className={`lo-press flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                    loop
                      ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                      : 'bg-zinc-100 text-zinc-600 hover:text-zinc-950 dark:bg-zinc-800 dark:text-zinc-400'
                  }`}
                >
                  <Repeat className="h-3 w-3" />
                  Loop
                </button>

                {canFollowMember ? (
                  <button
                    type="button"
                    onClick={() =>
                      onChangeFollowUserId(
                        followUserId === followCandidateUserId ? null : followCandidateUserId,
                      )
                    }
                    className={`lo-press flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                      followUserId === followCandidateUserId
                        ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                        : 'bg-zinc-100 text-zinc-600 hover:text-zinc-950 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}
                  >
                    <Crosshair className="h-3 w-3" />
                    Follow
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onFitTrails}
                    className="lo-press flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 text-[10px] font-semibold text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    <Maximize2 className="h-3 w-3" />
                    Fit all
                  </button>
                )}
              </div>

              {/* Desktop Speed Selector Pill (hidden on < sm because mobile uses side Rotary Safe Dial) */}
              <div className="hidden items-center gap-0.5 rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800 sm:flex">
                {TIMELAPSE_SPEED_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setSpeed(opt)}
                    className={`lo-press rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition ${
                      speed === opt
                        ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                        : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    {opt}x
                  </button>
                ))}
              </div>

              {focusMode && (
                <button
                  type="button"
                  onClick={handleExitFocus}
                  className="lo-press flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[10px] font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 sm:hidden"
                >
                  <X className="h-3 w-3" />
                  Exit
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
