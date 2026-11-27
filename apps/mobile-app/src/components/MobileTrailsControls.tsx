import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  formatStayDuration,
  TIMELAPSE_SPEED_OPTIONS,
  TRAIL_ACTIVITY_META,
  type TimelapseFrame,
  type TimelapseSpeedOption,
  type TimelapseTimeline,
  type TrailDisplayMode,
  type TrailsResponseMeta,
  type TrailTimeRangePreset,
  type TrailTripSort,
  type TrailTripSummary,
  virtualToRealMs,
} from '@loved-ones/shared';
import type { OnboardingPalette } from '../services/onboardingTheme';

export interface MobileTrailsTimeRange {
  preset: TrailTimeRangePreset;
  customMode: 'day' | 'range';
  customDay: string;
  customFrom: string;
  customTo: string;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateAndClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}`;
}

function formatDistance(meters: number, approx: boolean): string {
  const prefix = approx ? '~' : '';
  if (meters >= 1000) return `${prefix}${(meters / 1000).toFixed(approx ? 0 : 1)} km`;
  return `${prefix}${Math.round(meters)} m`;
}

function shiftDateIsoDay(yyyyMmDd: string, deltaDays: number): string {
  const d = new Date(`${yyyyMmDd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

interface MobileTrailsTabContentProps {
  ui: OnboardingPalette;
  isDark: boolean;
  members: Array<{ userId: string; username: string }>;
  selectedMemberFilterId: string | null;
  onChangeMemberFilterId: (userId: string | null) => void;
  timeRange: MobileTrailsTimeRange;
  onChangeTimeRange: (next: MobileTrailsTimeRange) => void;
  trailDisplayMode: TrailDisplayMode;
  onChangeTrailDisplayMode: (mode: TrailDisplayMode) => void;
  colorTrailsByActivity: boolean;
  onToggleColorByActivity: () => void;
  trips: TrailTripSummary[];
  sortBy: TrailTripSort;
  onChangeSortBy: (sort: TrailTripSort) => void;
  includeStays: boolean;
  onToggleIncludeStays: () => void;
  focusedTrip: TrailTripSummary | null;
  onSelectTrip: (trip: TrailTripSummary | null) => void;
  meta: TrailsResponseMeta | null;
  busy: boolean;
  message: string | null;
}

const SORT_OPTIONS: Array<{ key: TrailTripSort; label: string }> = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'member', label: 'Member' },
  { key: 'duration_desc', label: 'Longest' },
  { key: 'duration_asc', label: 'Shortest' },
  { key: 'distance_desc', label: 'Dist ↓' },
  { key: 'distance_asc', label: 'Dist ↑' },
];

export function MobileTrailsTabContent({
  ui,
  isDark,
  members,
  selectedMemberFilterId,
  onChangeMemberFilterId,
  timeRange,
  onChangeTimeRange,
  trailDisplayMode,
  onChangeTrailDisplayMode,
  colorTrailsByActivity,
  onToggleColorByActivity,
  trips,
  sortBy,
  onChangeSortBy,
  includeStays,
  onToggleIncludeStays,
  focusedTrip,
  onSelectTrip,
  meta,
  busy,
  message,
}: MobileTrailsTabContentProps) {
  const s = useMemo(() => createStyles(ui, isDark), [ui, isDark]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <View style={s.container}>
      {/* Compact Progressive-Disclosure Header Row */}
      <View style={s.topBarRow}>
        <View style={s.presetRow}>
          {(['24h', '3d', '7d', '30d', 'custom'] as const).map((preset) => {
            const active = timeRange.preset === preset;
            return (
              <TouchableOpacity
                key={preset}
                style={[s.presetPill, active && s.presetPillActive]}
                onPress={() => onChangeTimeRange({ ...timeRange, preset })}
              >
                <Text style={[s.presetPillText, active && s.presetPillTextActive]}>
                  {preset === 'custom' ? 'Day' : preset}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity
          style={[s.filterToggleBtn, filtersOpen && s.filterToggleBtnActive]}
          onPress={() => setFiltersOpen((v) => !v)}
        >
          <Text style={[s.filterToggleText, filtersOpen && s.filterToggleTextActive]}>
            {filtersOpen ? 'Hide' : 'Filters'}
          </Text>
        </TouchableOpacity>
      </View>

      {timeRange.preset === 'custom' && (
        <View style={s.customBox}>
          <View style={s.customModeRow}>
            {(['day', 'range'] as const).map((modeKey) => {
              const active = timeRange.customMode === modeKey;
              return (
                <TouchableOpacity
                  key={modeKey}
                  style={[s.smallPill, active && s.smallPillActive]}
                  onPress={() => onChangeTimeRange({ ...timeRange, customMode: modeKey })}
                >
                  <Text style={[s.smallPillText, active && s.smallPillTextActive]}>
                    {modeKey === 'day' ? 'Single Day' : 'From → To'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {timeRange.customMode === 'day' ? (
            <View style={s.dayStepperRow}>
              <TouchableOpacity
                style={s.stepBtn}
                onPress={() =>
                  onChangeTimeRange({
                    ...timeRange,
                    customDay: shiftDateIsoDay(timeRange.customDay, -1),
                  })
                }
              >
                <Text style={s.stepBtnText}>‹ Prev</Text>
              </TouchableOpacity>
              <TextInput
                value={timeRange.customDay}
                onChangeText={(txt) => onChangeTimeRange({ ...timeRange, customDay: txt })}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={ui.inkMuted}
                style={s.dateInput}
              />
              <TouchableOpacity
                style={s.stepBtn}
                onPress={() =>
                  onChangeTimeRange({
                    ...timeRange,
                    customDay: shiftDateIsoDay(timeRange.customDay, 1),
                  })
                }
              >
                <Text style={s.stepBtnText}>Next ›</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.dayStepperRow}>
              <TextInput
                value={timeRange.customFrom}
                onChangeText={(txt) => onChangeTimeRange({ ...timeRange, customFrom: txt })}
                placeholder="From YYYY-MM-DD"
                placeholderTextColor={ui.inkMuted}
                style={[s.dateInput, { flex: 1 }]}
              />
              <Text style={s.arrowText}>→</Text>
              <TextInput
                value={timeRange.customTo}
                onChangeText={(txt) => onChangeTimeRange({ ...timeRange, customTo: txt })}
                placeholder="To YYYY-MM-DD"
                placeholderTextColor={ui.inkMuted}
                style={[s.dateInput, { flex: 1 }]}
              />
            </View>
          )}
        </View>
      )}

      {/* Member Filter Strip */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.horizList}
      >
        <TouchableOpacity
          style={[s.chip, selectedMemberFilterId === null && s.chipActive]}
          onPress={() => onChangeMemberFilterId(null)}
        >
          <Text style={[s.chipText, selectedMemberFilterId === null && s.chipTextActive]}>
            All visible
          </Text>
        </TouchableOpacity>
        {members.map((m) => {
          const active = selectedMemberFilterId === m.userId;
          return (
            <TouchableOpacity
              key={m.userId}
              style={[s.chip, active && s.chipActive]}
              onPress={() => onChangeMemberFilterId(m.userId)}
            >
              <Text style={[s.chipText, active && s.chipTextActive]}>{m.username}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Expandable Display Mode, Activity & Sort Controls */}
      {filtersOpen && (
        <View style={s.filtersCard}>
          <View style={s.modeActionRow}>
            <View style={s.segmentRow}>
              {(['roads', 'raw'] as const).map((m) => {
                const active = trailDisplayMode === m;
                return (
                  <TouchableOpacity
                    key={m}
                    style={[s.smallPill, active && s.smallPillActive]}
                    onPress={() => onChangeTrailDisplayMode(m)}
                  >
                    <Text style={[s.smallPillText, active && s.smallPillTextActive]}>
                      {m === 'roads' ? 'Clean' : 'Raw'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[s.smallPill, colorTrailsByActivity && s.smallPillActive]}
                onPress={onToggleColorByActivity}
              >
                <Text style={[s.smallPillText, colorTrailsByActivity && s.smallPillTextActive]}>
                  Activity
                </Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[s.smallPill, includeStays && s.smallPillActive]}
              onPress={onToggleIncludeStays}
            >
              <Text style={[s.smallPillText, includeStays && s.smallPillTextActive]}>
                {includeStays ? 'Stays: On' : 'Stays: Off'}
              </Text>
            </TouchableOpacity>
          </View>

          {colorTrailsByActivity && (
            <View style={s.legendRow}>
              {(['walking', 'running', 'cycling', 'transit', 'driving', 'stationary'] as const).map(
                (key) => (
                  <View key={key} style={s.legendItem}>
                    <View
                      style={[s.legendDot, { backgroundColor: TRAIL_ACTIVITY_META[key].color }]}
                    />
                    <Text style={s.legendText}>{TRAIL_ACTIVITY_META[key].shortLabel}</Text>
                  </View>
                ),
              )}
            </View>
          )}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.horizList}
          >
            {SORT_OPTIONS.map((opt) => {
              const active = sortBy === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[s.smallPill, active && s.smallPillActive]}
                  onPress={() => onChangeSortBy(opt.key)}
                >
                  <Text style={[s.smallPillText, active && s.smallPillTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Status / Sampled Notice / Focused Reset */}
      <View style={s.statusRow}>
        <Text style={s.statusHeading}>
          {busy ? 'Trips (…)' : `Trips (${trips.length})`}
          {meta?.truncated ? ' · Sampled' : ''}
        </Text>
        <View style={s.statusRight}>
          {busy && (
            <View style={s.busyInline}>
              <ActivityIndicator size="small" color={ui.ink} />
              <Text style={s.busyInlineText}>Loading trails…</Text>
            </View>
          )}
          {focusedTrip && (
            <TouchableOpacity style={s.resetPill} onPress={() => onSelectTrip(null)}>
              <Text style={s.resetPillText}>Full range ✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {message ? <Text style={s.messageText}>{message}</Text> : null}

      {/* Sortable Trip Cards */}
      <View style={s.tripList}>
        {busy && trips.length === 0 && (
          <View style={s.loadingSkeletonList}>
            <View style={s.loadingSkeletonCard} />
            <View style={[s.loadingSkeletonCard, { opacity: 0.65 }]} />
          </View>
        )}
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
            <TouchableOpacity
              key={trip.id}
              activeOpacity={0.85}
              style={[s.tripCard, isSelected && s.tripCardActive]}
              onPress={() => onSelectTrip(isSelected ? null : trip)}
            >
              <View style={s.tripCardTop}>
                <Text style={[s.tripUser, isSelected && s.tripTextActive]} numberOfLines={1}>
                  {trip.username}
                </Text>
                <View style={s.tripBadges}>
                  {actMeta && (
                    <View style={s.actBadge}>
                      <View style={[s.legendDot, { backgroundColor: actMeta.color }]} />
                      <Text style={[s.actBadgeText, isSelected && s.tripTextActive]}>
                        {actMeta.shortLabel}
                      </Text>
                    </View>
                  )}
                  {trip.isFuzzed && (
                    <View style={s.fuzzBadge}>
                      <Text style={s.fuzzBadgeText}>Fuzzed</Text>
                    </View>
                  )}
                </View>
              </View>
              <Text style={[s.tripRoute, isSelected && s.tripSubActive]} numberOfLines={1}>
                {routeLabel}
              </Text>
              <View style={s.tripMetaRow}>
                <Text style={[s.tripMetaMono, isSelected && s.tripSubActive]}>
                  {formatClock(Date.parse(trip.startedAt))} – {formatClock(Date.parse(trip.endedAt))}
                </Text>
                <Text style={[s.tripMetaMono, isSelected && s.tripSubActive]}>
                  {formatStayDuration(trip.durationMs)} ·{' '}
                  {formatDistance(trip.distanceMeters, trip.isApproximateDistance)}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
        {!busy && trips.length === 0 && (
          <Text style={s.emptyText}>No movement trips found in this window.</Text>
        )}
      </View>
    </View>
  );
}

interface MobileTimelapseBarProps {
  ui: OnboardingPalette;
  isDark: boolean;
  timeline: TimelapseTimeline;
  currentRealMs: number;
  virtualMs: number;
  playing: boolean;
  speed: TimelapseSpeedOption;
  loop: boolean;
  compactIdle: boolean;
  focusMode: boolean;
  canFollow: boolean;
  following: boolean;
  onTogglePlay: () => void;
  onSeekVirtualMs: (vMs: number) => void;
  onCycleSpeed: (nextSpeed: TimelapseSpeedOption) => void;
  onToggleLoop: () => void;
  onToggleCompactIdle: () => void;
  onToggleFollow: () => void;
  onFitAll: () => void;
  onExitFocus: () => void;
}

export function MobileTimelapseBar({
  ui,
  isDark,
  timeline,
  currentRealMs,
  virtualMs,
  playing,
  speed,
  loop,
  compactIdle,
  focusMode,
  canFollow,
  following,
  onTogglePlay,
  onSeekVirtualMs,
  onCycleSpeed,
  onToggleLoop,
  onToggleCompactIdle,
  onToggleFollow,
  onFitAll,
  onExitFocus,
}: MobileTimelapseBarProps) {
  const s = useMemo(() => createStyles(ui, isDark), [ui, isDark]);
  const trackWidthRef = useRef(200);

  if (timeline.isEmpty) return null;

  const pct =
    timeline.virtualDurationMs > 0
      ? Math.max(0, Math.min(100, (virtualMs / timeline.virtualDurationMs) * 100))
      : 100;

  const nextSpeed = () => {
    const idx = TIMELAPSE_SPEED_OPTIONS.indexOf(speed);
    onCycleSpeed(TIMELAPSE_SPEED_OPTIONS[(idx + 1) % TIMELAPSE_SPEED_OPTIONS.length]);
  };

  const handleTouchSeek = (locationX: number) => {
    const w = Math.max(1, trackWidthRef.current);
    const ratio = Math.max(0, Math.min(1, locationX / w));
    onSeekVirtualMs(ratio * timeline.virtualDurationMs);
  };

  return (
    <View style={s.playerCard}>
      <View style={s.playerTopRow}>
        <TouchableOpacity style={s.playBtn} onPress={onTogglePlay} activeOpacity={0.85}>
          <Text style={s.playBtnText}>{playing ? '❚❚' : '▶'}</Text>
        </TouchableOpacity>

        <View style={s.scrubberWrap}>
          <View
            style={s.scrubTouchArea}
            onLayout={(e) => {
              trackWidthRef.current = e.nativeEvent.layout.width;
            }}
            onStartShouldSetResponder={() => true}
            onResponderGrant={(e) => handleTouchSeek(e.nativeEvent.locationX)}
            onResponderMove={(e) => handleTouchSeek(e.nativeEvent.locationX)}
          >
            <View style={s.scrubTrack}>
              {timeline.virtualDurationMs > 0 &&
                timeline.segments.map((seg, idx) =>
                  seg.compressed ? (
                    <View
                      key={idx}
                      style={[
                        s.scrubCompressedBand,
                        {
                          left: `${(seg.virtualStartMs / timeline.virtualDurationMs) * 100}%`,
                          width: `${Math.max(
                            1,
                            ((seg.virtualEndMs - seg.virtualStartMs) /
                              timeline.virtualDurationMs) *
                              100,
                          )}%`,
                        },
                      ]}
                    />
                  ) : null,
                )}
              <View style={[s.scrubFill, { width: `${pct}%` }]} />
            </View>
            <View style={[s.scrubThumb, { left: `${pct}%` }]} />
          </View>
          <View style={s.clockRow}>
            <Text style={s.clockEdge}>{formatClock(timeline.realStartMs)}</Text>
            <Text style={s.clockLive}>{formatDateAndClock(currentRealMs)}</Text>
            <Text style={s.clockEdge}>{formatClock(timeline.realEndMs)}</Text>
          </View>
        </View>
      </View>

      <View style={s.playerActionsRow}>
        <TouchableOpacity
          style={[s.smallPill, s.speedPill]}
          onPress={nextSpeed}
          activeOpacity={0.85}
        >
          <Text style={s.smallPillText}>{speed}x</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.smallPill, compactIdle && s.smallPillActive]}
          onPress={onToggleCompactIdle}
        >
          <Text style={[s.smallPillText, compactIdle && s.smallPillTextActive]}>
            Shorten idle
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.smallPill, loop && s.smallPillActive]}
          onPress={onToggleLoop}
        >
          <Text style={[s.smallPillText, loop && s.smallPillTextActive]}>Loop</Text>
        </TouchableOpacity>

        {canFollow ? (
          <TouchableOpacity
            style={[s.smallPill, following && s.smallPillActive]}
            onPress={onToggleFollow}
          >
            <Text style={[s.smallPillText, following && s.smallPillTextActive]}>Follow</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.smallPill} onPress={onFitAll}>
            <Text style={s.smallPillText}>Fit all</Text>
          </TouchableOpacity>
        )}

        {focusMode && (
          <TouchableOpacity style={s.exitFocusBtn} onPress={onExitFocus}>
            <Text style={s.exitFocusText}>Show UI</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

export { formatDateAndClock, virtualToRealMs };

function createStyles(ui: OnboardingPalette, isDark: boolean) {
  const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  return StyleSheet.create({
    container: { gap: 10 },
    topBarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    presetRow: {
      flex: 1,
      flexDirection: 'row',
      backgroundColor: ui.surfaceChip,
      borderRadius: 10,
      padding: 3,
      gap: 3,
    },
    presetPill: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 6,
      borderRadius: 8,
    },
    presetPillActive: {
      backgroundColor: ui.ctaBg,
    },
    presetPillText: {
      color: ui.inkMuted,
      fontSize: 11,
      fontWeight: '700',
    },
    presetPillTextActive: {
      color: ui.ctaText,
    },
    filterToggleBtn: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    filterToggleBtnActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    filterToggleText: {
      color: ui.ink,
      fontSize: 11,
      fontWeight: '700',
    },
    filterToggleTextActive: {
      color: ui.ctaText,
    },
    customBox: {
      gap: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 10,
    },
    customModeRow: { flexDirection: 'row', gap: 6 },
    dayStepperRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    stepBtn: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surface,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    stepBtnText: { color: ui.ink, fontSize: 11, fontWeight: '700' },
    dateInput: {
      flex: 1,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surface,
      color: ui.ink,
      fontFamily: mono,
      fontSize: 11,
      paddingHorizontal: 8,
      paddingVertical: 6,
      textAlign: 'center',
    },
    arrowText: { color: ui.inkMuted, fontSize: 12, fontWeight: '700' },
    horizList: { gap: 6, paddingVertical: 2 },
    chip: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 11,
      paddingVertical: 6,
    },
    chipActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    chipText: { color: ui.ink, fontSize: 11, fontWeight: '600' },
    chipTextActive: { color: ui.ctaText },
    filtersCard: {
      gap: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 10,
    },
    modeActionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
    },
    segmentRow: { flexDirection: 'row', gap: 4 },
    smallPill: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surface,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    smallPillActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    smallPillText: { color: ui.ink, fontSize: 11, fontWeight: '700' },
    smallPillTextActive: { color: ui.ctaText },
    speedPill: {
      minWidth: 40,
      alignItems: 'center',
    },
    legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendDot: { width: 7, height: 7, borderRadius: 999 },
    legendText: { color: ui.inkMuted, fontSize: 10, fontWeight: '600' },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    statusHeading: { color: ui.ink, fontSize: 13, fontWeight: '700' },
    statusRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    busyInline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    busyInlineText: { color: ui.inkMuted, fontSize: 11, fontWeight: '600' },
    loadingSkeletonList: { gap: 8 },
    loadingSkeletonCard: {
      height: 62,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
    },
    resetPill: {
      borderRadius: 999,
      backgroundColor: isDark ? 'rgba(245,158,11,0.2)' : 'rgba(245,158,11,0.16)',
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    resetPillText: {
      color: isDark ? '#fbbf24' : '#b45309',
      fontSize: 10,
      fontWeight: '700',
    },
    messageText: { color: ui.inkMuted, fontSize: 12 },
    tripList: { gap: 8 },
    tripCard: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 11,
      gap: 4,
    },
    tripCardActive: {
      backgroundColor: ui.ctaBg,
      borderColor: ui.ctaBg,
    },
    tripCardTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    tripUser: { color: ui.ink, fontSize: 13, fontWeight: '700', flex: 1 },
    tripTextActive: { color: ui.ctaText },
    tripBadges: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    actBadge: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    actBadgeText: { color: ui.inkMuted, fontSize: 10, fontWeight: '700' },
    fuzzBadge: {
      borderRadius: 999,
      backgroundColor: 'rgba(245,158,11,0.2)',
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    fuzzBadgeText: { color: '#f59e0b', fontSize: 9, fontWeight: '700' },
    tripRoute: { color: ui.inkMuted, fontSize: 12, fontWeight: '500' },
    tripSubActive: { color: ui.ctaText, opacity: 0.85 },
    tripMetaRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 2,
    },
    tripMetaMono: { color: ui.inkMuted, fontSize: 10, fontFamily: mono },
    emptyText: {
      color: ui.inkMuted,
      fontSize: 12,
      textAlign: 'center',
      paddingVertical: 14,
    },
    playerCard: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: isDark ? 'rgba(24,24,27,0.95)' : 'rgba(255,255,255,0.96)',
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 8,
      shadowColor: '#000000',
      shadowOpacity: isDark ? 0.42 : 0.16,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    playerTopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    playBtn: {
      width: 34,
      height: 34,
      borderRadius: 999,
      backgroundColor: ui.ctaBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playBtnText: { color: ui.ctaText, fontSize: 12, fontWeight: '700' },
    scrubberWrap: { flex: 1, gap: 4 },
    scrubTouchArea: { height: 22, justifyContent: 'center' },
    scrubTrack: {
      height: 6,
      borderRadius: 999,
      backgroundColor: ui.surfaceChip,
      overflow: 'hidden',
    },
    scrubCompressedBand: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      backgroundColor: 'rgba(245,158,11,0.45)',
    },
    scrubFill: {
      height: '100%',
      backgroundColor: ui.ctaBg,
    },
    scrubThumb: {
      position: 'absolute',
      width: 14,
      height: 14,
      borderRadius: 999,
      backgroundColor: ui.ctaBg,
      borderWidth: 2,
      borderColor: ui.surface,
      marginLeft: -7,
    },
    clockRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    clockEdge: { color: ui.inkMuted, fontSize: 9, fontFamily: mono },
    clockLive: { color: ui.ink, fontSize: 10, fontFamily: mono, fontWeight: '700' },
    playerActionsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 6,
    },
    exitFocusBtn: {
      marginLeft: 'auto',
      borderRadius: 8,
      backgroundColor: ui.ctaBg,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    exitFocusText: { color: ui.ctaText, fontSize: 10, fontWeight: '700' },
  });
}
