'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  MapPin,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Route,
  Sliders,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import {
  ACTIVITY_MODE_LABELS,
  ACTIVITY_PALETTE_GROUPS,
  DEFAULT_EXACT_HALO_COLOR,
  DEFAULT_FUZZ_CIRCLE_COLOR,
  DEFAULT_USER_CUSTOMIZATION,
  hexToRgba,
  hslToHex,
  INTERFACE_THEME_PRESETS,
  isSafeHexColor,
  resolveActivityColors,
  resolveInterfaceThemeTokens,
  withMinDelay,
  type ActivityPaletteGroupId,
  type ChatBubbleStyleOption,
  type CornerStyleOption,
  type DensityOption,
  type InterfacePresetId,
  type SurfaceWashLevel,
  type TrailActivityMode,
  type UserCustomization,
} from '@loved-ones/shared';
import { apiUpdateProfile, saveSession, type StoredSession } from '@/lib/api';
import type { MapThemePreference, ResolvedMapTheme } from '@/lib/mapTheme';

export type CustomizeAppearanceTab = 'interface' | 'map';

const PIN_COLOR_PRESETS = [
  { label: 'Amber', hex: '#f59e0b' },
  { label: 'Sky', hex: '#0ea5e9' },
  { label: 'Emerald', hex: '#10b981' },
  { label: 'Violet', hex: '#8b5cf6' },
  { label: 'Rose', hex: '#f43f5e' },
  { label: 'Ink', hex: '#18181b' },
] as const;

interface CustomizeAppearanceModalProps {
  open: boolean;
  initialTab?: CustomizeAppearanceTab;
  username: string;
  session: StoredSession;
  mapThemePreference: MapThemePreference;
  resolvedTheme: ResolvedMapTheme;
  customization: UserCustomization;
  onChangeMapTheme: (next: MapThemePreference) => void;
  onSessionUpdated: (next: StoredSession) => void;
  onUpdate: (updater: (prev: UserCustomization) => UserCustomization) => void;
  onResetAll: () => void;
  onClose: () => void;
}

const ACTIVITY_ORDER: readonly TrailActivityMode[] = [
  'walking',
  'running',
  'cycling',
  'transit',
  'driving',
  'stationary',
];

export function CustomizeAppearanceModal({
  open,
  initialTab = 'interface',
  username,
  session,
  mapThemePreference,
  resolvedTheme,
  customization,
  onChangeMapTheme,
  onSessionUpdated,
  onUpdate,
  onResetAll,
  onClose,
}: CustomizeAppearanceModalProps) {
  const [activeTab, setActiveTab] = useState<CustomizeAppearanceTab>(initialTab);
  const [visualStyleExpanded, setVisualStyleExpanded] = useState(false);
  const [mapDetailsExpanded, setMapDetailsExpanded] = useState(false);
  const [pinAppearanceExpanded, setPinAppearanceExpanded] = useState(false);
  const [haloColor, setHaloColor] = useState<string | null>(session.user.haloColor ?? null);
  const [fuzzCircleColor, setFuzzCircleColor] = useState<string | null>(
    session.user.fuzzCircleColor ?? null,
  );
  const [pinBusy, setPinBusy] = useState(false);
  const [pinSaved, setPinSaved] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      setHaloColor(session.user.haloColor ?? null);
      setFuzzCircleColor(session.user.fuzzCircleColor ?? null);
      setPinSaved(null);
      setPinError(null);
    }
  }, [open, initialTab, session.user.haloColor, session.user.fuzzCircleColor]);

  async function handleSavePinAppearance() {
    setPinError(null);
    setPinSaved(null);
    setPinBusy(true);
    try {
      const next = await withMinDelay(
        apiUpdateProfile(session.accessToken, {
          username: session.user.username,
          email: session.user.email,
          avatarUrl: session.user.avatarUrl ?? null,
          haloColor,
          fuzzCircleColor,
        }),
      );
      saveSession(next);
      onSessionUpdated(next);
      setPinSaved('Map pin colors saved');
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Failed to save map pin colors');
    } finally {
      setPinBusy(false);
    }
  }

  const tokens = useMemo(
    () => resolveInterfaceThemeTokens(customization, resolvedTheme),
    [customization, resolvedTheme],
  );
  const resolvedActivities = useMemo(() => resolveActivityColors(customization), [customization]);

  if (!open) return null;

  const customModeActive = customization.themeMode === 'custom';
  const showWashControl =
    customization.themeMode === 'custom' || customization.interfacePreset !== 'default';

  const customHexPreview = hslToHex(
    customization.customInterface.hue,
    customization.customInterface.saturation,
    customization.customInterface.lightness,
  );

  function selectPresetTheme(presetId: InterfacePresetId) {
    onUpdate((prev) => ({
      ...prev,
      themeMode: 'preset',
      interfacePreset: presetId,
    }));
  }

  function enableCustomMode() {
    onUpdate((prev) => {
      if (prev.themeMode === 'custom') return prev;
      const sourcePreset =
        INTERFACE_THEME_PRESETS.find((p) => p.id === prev.interfacePreset) ??
        INTERFACE_THEME_PRESETS[1];
      return {
        ...prev,
        themeMode: 'custom',
        customInterface:
          sourcePreset.id === 'default'
            ? prev.customInterface
            : {
                hue: sourcePreset.hue,
                saturation: sourcePreset.saturation,
                lightness: sourcePreset.lightness,
              },
      };
    });
  }

  function selectActivityGroup(groupId: ActivityPaletteGroupId) {
    onUpdate((prev) => {
      if (groupId === 'custom') {
        const currentResolved = resolveActivityColors(prev);
        return {
          ...prev,
          activityPaletteId: 'custom',
          customActivityColors: currentResolved,
        };
      }
      return {
        ...prev,
        activityPaletteId: groupId,
      };
    });
  }

  function setSingleActivityColor(mode: TrailActivityMode, hex: string) {
    const clean = hex.toLowerCase();
    onUpdate((prev) => {
      const base = resolveActivityColors(prev);
      return {
        ...prev,
        activityPaletteId: 'custom',
        customActivityColors: {
          ...base,
          [mode]: clean,
        },
      };
    });
  }

  function resetCurrentTab() {
    if (activeTab === 'interface') {
      onUpdate((prev) => ({
        ...prev,
        themeMode: DEFAULT_USER_CUSTOMIZATION.themeMode,
        interfacePreset: DEFAULT_USER_CUSTOMIZATION.interfacePreset,
        surfaceWash: DEFAULT_USER_CUSTOMIZATION.surfaceWash,
        customInterface: { ...DEFAULT_USER_CUSTOMIZATION.customInterface },
        visualStyle: { ...DEFAULT_USER_CUSTOMIZATION.visualStyle },
      }));
    } else {
      onUpdate((prev) => ({
        ...prev,
        activityPaletteId: DEFAULT_USER_CUSTOMIZATION.activityPaletteId,
        customActivityColors: { ...DEFAULT_USER_CUSTOMIZATION.customActivityColors },
        mapAccents: { ...DEFAULT_USER_CUSTOMIZATION.mapAccents },
      }));
    }
  }

  return (
    <div
      className="lo-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 pb-[calc(1rem+var(--lo-safe-bottom,0px))] pl-[calc(1rem+var(--lo-safe-left,0px))] pr-[calc(1rem+var(--lo-safe-right,0px))] pt-[calc(1rem+var(--lo-safe-top,0px))] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Customize theme and colors"
    >
      <div className="lo-modal-in max-h-[calc(var(--lo-app-height,100dvh)-2rem-var(--lo-safe-top,0px)-var(--lo-safe-bottom,0px))] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-200/80 bg-white/95 p-5 shadow-[0_24px_60px_rgba(9,9,11,0.18)] backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/95">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-bold text-zinc-950 dark:text-zinc-50">
              <Palette className="h-4 w-4" />
              Personalized Theme &amp; Activity
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Saved locally for <span className="font-semibold">@{username}</span> · Updates live
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Close appearance customizer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Context Switcher Tabs */}
        <div className="mt-3.5 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 text-xs font-semibold dark:bg-zinc-800">
          <button
            type="button"
            onClick={() => setActiveTab('interface')}
            className={`lo-press flex items-center justify-center gap-1.5 rounded-md py-1.5 transition ${
              activeTab === 'interface'
                ? 'bg-zinc-950 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Interface &amp; Hue
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('map')}
            className={`lo-press flex items-center justify-center gap-1.5 rounded-md py-1.5 transition ${
              activeTab === 'map'
                ? 'bg-zinc-950 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            <Route className="h-3.5 w-3.5" />
            Trails &amp; Map Colors
          </button>
        </div>

        {activeTab === 'interface' ? (
          <div className="mt-4 space-y-4">
            {/* Live Preview */}
            <div
              className="rounded-xl border p-3 transition-colors"
              style={{
                backgroundColor: tokens.canvasBg,
                borderColor: tokens.borderColor,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span
                    className="rounded-md px-2.5 py-1 text-[11px] font-semibold shadow-sm"
                    style={{ backgroundColor: tokens.accentBg, color: tokens.accentFg }}
                  >
                    Primary Action
                  </span>
                  <span
                    className="rounded-md px-2 py-1 text-[10px] font-semibold"
                    style={{ backgroundColor: tokens.accentSoftBg, color: tokens.accentSoftText }}
                  >
                    Active Pill
                  </span>
                </div>
                <span
                  className="rounded-lg px-2.5 py-1 text-[10px] font-medium"
                  style={
                    customization.mapAccents.chatBubbleStyle === 'tinted'
                      ? {
                          backgroundColor: tokens.accentSoftBg,
                          color: tokens.accentSoftText,
                          border: `1px solid ${tokens.accentBorder}`,
                        }
                      : {
                          backgroundColor: tokens.accentBg,
                          color: tokens.accentFg,
                        }
                  }
                >
                  Chat Bubble
                </span>
              </div>
            </div>

            {/* Map & App Theme Selector (Auto / Light / Dark) */}
            <div className="flex items-center justify-between rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-800/60">
              <div>
                <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                  Map &amp; Interface Mode
                </div>
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  Choose light, dark, or match device
                </div>
              </div>
              <div className="flex items-center gap-0.5 rounded-lg bg-zinc-200/70 p-0.5 dark:bg-zinc-900">
                {(
                  [
                    ['system', 'System', Monitor],
                    ['light', 'Light', Sun],
                    ['dark', 'Dark', Moon],
                  ] as const
                ).map(([pref, label, Icon]) => {
                  const active = mapThemePreference === pref;
                  return (
                    <button
                      key={pref}
                      type="button"
                      onClick={() => onChangeMapTheme(pref)}
                      className={`lo-press flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                        active
                          ? 'bg-zinc-950 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                          : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Curated Interface Swatches + Custom Mode Toggle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Interface Color
                </span>
                <button
                  type="button"
                  onClick={enableCustomMode}
                  className={`lo-press inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold transition ${
                    customModeActive
                      ? 'border-transparent bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                      : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                  }`}
                >
                  <Sliders className="h-3 w-3" />
                  Custom Hue
                </button>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {INTERFACE_THEME_PRESETS.map((preset) => {
                  const selected =
                    !customModeActive && customization.interfacePreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => selectPresetTheme(preset.id)}
                      className={`lo-press flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[11px] font-semibold transition ${
                        selected
                          ? 'border-zinc-950 bg-zinc-100 text-zinc-950 dark:border-zinc-100 dark:bg-zinc-800 dark:text-zinc-50'
                          : 'border-zinc-200/80 bg-zinc-50/70 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <span
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/70 shadow-sm dark:border-zinc-700"
                        style={{ backgroundColor: preset.swatchHex }}
                      >
                        {selected && <Check className="h-2.5 w-2.5 text-white" />}
                      </span>
                      <span className="truncate">{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Progressive Disclosure: Custom Mode Hue / Saturation / Brightness */}
            {customModeActive && (
              <div className="lo-tab-enter space-y-3 rounded-xl border border-zinc-200/80 bg-zinc-50/80 p-3.5 dark:border-zinc-800 dark:bg-zinc-800/60">
                <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                  <span>Custom Interface Color</span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px]">
                    <span
                      className="h-3.5 w-3.5 rounded-full border border-white shadow-sm"
                      style={{ backgroundColor: customHexPreview }}
                    />
                    {customHexPreview}
                  </span>
                </div>

                <label className="block space-y-1">
                  <div className="flex justify-between text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                    <span>Hue</span>
                    <span className="font-mono">{Math.round(customization.customInterface.hue)}°</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    value={customization.customInterface.hue}
                    onChange={(e) => {
                      const hue = Number(e.target.value);
                      onUpdate((prev) => ({
                        ...prev,
                        themeMode: 'custom',
                        customInterface: { ...prev.customInterface, hue },
                      }));
                    }}
                    className="h-2 w-full cursor-pointer appearance-none rounded-full"
                    style={{
                      background:
                        'linear-gradient(to right, #ef4444, #f59e0b, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)',
                    }}
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block space-y-1">
                    <div className="flex justify-between text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                      <span>Intensity</span>
                      <span className="font-mono">{customization.customInterface.saturation}%</span>
                    </div>
                    <input
                      type="range"
                      min={15}
                      max={100}
                      value={customization.customInterface.saturation}
                      onChange={(e) => {
                        const saturation = Number(e.target.value);
                        onUpdate((prev) => ({
                          ...prev,
                          themeMode: 'custom',
                          customInterface: { ...prev.customInterface, saturation },
                        }));
                      }}
                      className="h-1.5 w-full cursor-pointer"
                    />
                  </label>

                  <label className="block space-y-1">
                    <div className="flex justify-between text-[10px] font-medium text-zinc-600 dark:text-zinc-300">
                      <span>Tone</span>
                      <span className="font-mono">{customization.customInterface.lightness}%</span>
                    </div>
                    <input
                      type="range"
                      min={24}
                      max={68}
                      value={customization.customInterface.lightness}
                      onChange={(e) => {
                        const lightness = Number(e.target.value);
                        onUpdate((prev) => ({
                          ...prev,
                          themeMode: 'custom',
                          customInterface: { ...prev.customInterface, lightness },
                        }));
                      }}
                      className="h-1.5 w-full cursor-pointer"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Surface Wash Control (shown only when non-monochrome) */}
            {showWashControl && (
              <div className="flex items-center justify-between rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-800/60">
                <div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Panel &amp; Surface Tint
                  </div>
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    Subtle hue wash on cards &amp; borders
                  </div>
                </div>
                <div className="flex items-center gap-0.5 rounded-lg bg-zinc-200/70 p-0.5 dark:bg-zinc-900">
                  {(['off', 'subtle', 'bold'] as SurfaceWashLevel[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => onUpdate((prev) => ({ ...prev, surfaceWash: level }))}
                      className={`rounded-md px-2 py-1 text-[10px] font-semibold capitalize transition ${
                        customization.surfaceWash === level
                          ? 'bg-zinc-950 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-950'
                          : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-100'
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Progressive Disclosure: Visual Style & Comfort */}
            <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setVisualStyleExpanded((v) => !v)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
              >
                <div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Layout Shape, Density &amp; Motion
                  </div>
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    {customization.visualStyle.cornerStyle} corners ·{' '}
                    {customization.visualStyle.density} ·{' '}
                    {customization.visualStyle.glassBlur ? 'glass on' : 'solid surfaces'}
                  </div>
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-zinc-400 transition-transform ${
                    visualStyleExpanded ? 'rotate-180 text-zinc-800 dark:text-zinc-200' : ''
                  }`}
                />
              </button>

              {visualStyleExpanded && (
                <div className="lo-tab-enter space-y-2.5 border-t border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Corner Radius
                    </span>
                    <div className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
                      {(['crisp', 'balanced', 'soft'] as CornerStyleOption[]).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() =>
                            onUpdate((prev) => ({
                              ...prev,
                              visualStyle: { ...prev.visualStyle, cornerStyle: opt },
                            }))
                          }
                          className={`rounded-md px-2 py-1 text-[10px] font-semibold capitalize ${
                            customization.visualStyle.cornerStyle === opt
                              ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                              : 'text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Density
                    </span>
                    <div className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
                      {(['comfortable', 'compact'] as DensityOption[]).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() =>
                            onUpdate((prev) => ({
                              ...prev,
                              visualStyle: { ...prev.visualStyle, density: opt },
                            }))
                          }
                          className={`rounded-md px-2 py-1 text-[10px] font-semibold capitalize ${
                            customization.visualStyle.density === opt
                              ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                              : 'text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Frosted Glass Blur
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdate((prev) => ({
                          ...prev,
                          visualStyle: {
                            ...prev.visualStyle,
                            glassBlur: !prev.visualStyle.glassBlur,
                          },
                        }))
                      }
                      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                        customization.visualStyle.glassBlur
                          ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                      }`}
                    >
                      {customization.visualStyle.glassBlur ? 'On' : 'Off'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Reduced Motion
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdate((prev) => ({
                          ...prev,
                          visualStyle: {
                            ...prev.visualStyle,
                            reducedMotion: !prev.visualStyle.reducedMotion,
                          },
                        }))
                      }
                      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold ${
                        customization.visualStyle.reducedMotion
                          ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                      }`}
                    >
                      {customization.visualStyle.reducedMotion ? 'On' : 'Off'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Curated Activity Palette Groups + Custom */}
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Activity Trail Color Groups
              </div>
              <div className="space-y-1.5">
                {ACTIVITY_PALETTE_GROUPS.map((group) => {
                  const selected = customization.activityPaletteId === group.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => selectActivityGroup(group.id)}
                      className={`lo-press flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition ${
                        selected
                          ? 'border-zinc-950 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800'
                          : 'border-zinc-200/80 bg-zinc-50/70 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/50 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                          {group.label}
                        </div>
                        <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                          {group.description}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {ACTIVITY_ORDER.map((mode) => (
                          <span
                            key={mode}
                            title={`${ACTIVITY_MODE_LABELS[mode]}: ${group.colors[mode]}`}
                            className="h-3.5 w-3.5 rounded-full border border-white/80 shadow-sm dark:border-zinc-900"
                            style={{ backgroundColor: group.colors[mode] }}
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => selectActivityGroup('custom')}
                  className={`lo-press flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition ${
                    customization.activityPaletteId === 'custom'
                      ? 'border-zinc-950 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-800'
                      : 'border-zinc-200/80 bg-zinc-50/70 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <div>
                    <div className="text-xs font-semibold text-zinc-950 dark:text-zinc-50">
                      Custom Activity Colors
                    </div>
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      Pick individual hues for Walk, Run, Cycle, Transit, Drive &amp; Stay
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {ACTIVITY_ORDER.map((mode) => (
                      <span
                        key={mode}
                        className="h-3.5 w-3.5 rounded-full border border-white/80 shadow-sm dark:border-zinc-900"
                        style={{ backgroundColor: resolvedActivities[mode] }}
                      />
                    ))}
                  </div>
                </button>
              </div>
            </div>

            {/* Individual Activity Pickers (shown when Custom OR user wants fine control) */}
            <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-800/50">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-200">
                  Fine-Tune Per Activity
                  {customization.activityPaletteId !== 'custom' && (
                    <span className="ml-1.5 text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                      (clones active group to Custom)
                    </span>
                  )}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {ACTIVITY_ORDER.map((mode) => (
                  <label
                    key={mode}
                    className="flex cursor-pointer items-center justify-between rounded-lg border border-zinc-200/80 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <span>{ACTIVITY_MODE_LABELS[mode]}</span>
                    <input
                      type="color"
                      aria-label={`${ACTIVITY_MODE_LABELS[mode]} color`}
                      value={resolvedActivities[mode]}
                      onChange={(e) => setSingleActivityColor(mode, e.target.value)}
                      className="h-4 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                  </label>
                ))}
              </div>
            </div>

            {/* Progressive Disclosure: Places, Fallback Trail & Chat Bubble */}
            <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setMapDetailsExpanded((v) => !v)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
              >
                <div className="flex items-center gap-2">
                  <MapPin className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                  <div>
                    <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      Places, Fallback Trail &amp; Chat Bubble
                    </div>
                    <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      Geofence pin colors &amp; non-activity trail tint
                    </div>
                  </div>
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-zinc-400 transition-transform ${
                    mapDetailsExpanded ? 'rotate-180 text-zinc-800 dark:text-zinc-200' : ''
                  }`}
                />
              </button>

              {mapDetailsExpanded && (
                <div className="lo-tab-enter space-y-2.5 border-t border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Group Shared Place Pin
                    </span>
                    <input
                      type="color"
                      aria-label="Group shared place color"
                      value={customization.mapAccents.groupPlaceColor}
                      onChange={(e) => {
                        const val = e.target.value.toLowerCase();
                        onUpdate((prev) => ({
                          ...prev,
                          mapAccents: { ...prev.mapAccents, groupPlaceColor: val },
                        }));
                      }}
                      className="h-5 w-7 cursor-pointer rounded border border-zinc-200 bg-transparent p-0 dark:border-zinc-700"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Private Place Pin
                    </span>
                    <input
                      type="color"
                      aria-label="Private place color"
                      value={customization.mapAccents.privatePlaceColor}
                      onChange={(e) => {
                        const val = e.target.value.toLowerCase();
                        onUpdate((prev) => ({
                          ...prev,
                          mapAccents: { ...prev.mapAccents, privatePlaceColor: val },
                        }));
                      }}
                      className="h-5 w-7 cursor-pointer rounded border border-zinc-200 bg-transparent p-0 dark:border-zinc-700"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      Single-Color Trail Line
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdate((prev) => ({
                            ...prev,
                            mapAccents: { ...prev.mapAccents, fallbackTrailColor: 'auto' },
                          }))
                        }
                        className={`rounded-md px-2 py-1 text-[10px] font-semibold ${
                          customization.mapAccents.fallbackTrailColor === 'auto'
                            ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                        }`}
                      >
                        Auto
                      </button>
                      <input
                        type="color"
                        aria-label="Custom fallback trail color"
                        value={
                          customization.mapAccents.fallbackTrailColor === 'auto'
                            ? tokens.accentBg
                            : customization.mapAccents.fallbackTrailColor
                        }
                        onChange={(e) => {
                          const val = e.target.value.toLowerCase();
                          onUpdate((prev) => ({
                            ...prev,
                            mapAccents: { ...prev.mapAccents, fallbackTrailColor: val },
                          }));
                        }}
                        className="h-5 w-7 cursor-pointer rounded border border-zinc-200 bg-transparent p-0 dark:border-zinc-700"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      My Chat Bubble Style
                    </span>
                    <div className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
                      {(['accent', 'tinted'] as ChatBubbleStyleOption[]).map((styleOpt) => (
                        <button
                          key={styleOpt}
                          type="button"
                          onClick={() =>
                            onUpdate((prev) => ({
                              ...prev,
                              mapAccents: { ...prev.mapAccents, chatBubbleStyle: styleOpt },
                            }))
                          }
                          className={`rounded-md px-2 py-1 text-[10px] font-semibold capitalize ${
                            customization.mapAccents.chatBubbleStyle === styleOpt
                              ? 'bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950'
                              : 'text-zinc-600 dark:text-zinc-400'
                          }`}
                        >
                          {styleOpt === 'accent' ? 'Solid' : 'Soft Tint'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Map Pin Appearance (Moved from Account Settings, synced with Group) */}
            <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/40">
              <button
                type="button"
                onClick={() => setPinAppearanceExpanded((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
              >
                <div>
                  <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Map Pin Appearance (Visible to Group)
                  </div>
                  <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                    Your marker halo &amp; fuzzed area circle shared across devices
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed"
                    style={{
                      backgroundColor: hexToRgba(
                        isSafeHexColor(fuzzCircleColor)
                          ? fuzzCircleColor
                          : DEFAULT_FUZZ_CIRCLE_COLOR,
                        0.18,
                      ),
                      borderColor: hexToRgba(
                        isSafeHexColor(fuzzCircleColor)
                          ? fuzzCircleColor
                          : DEFAULT_FUZZ_CIRCLE_COLOR,
                        0.7,
                      ),
                    }}
                  >
                    <div
                      className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-zinc-900 text-[8px] font-bold text-white"
                      style={{
                        boxShadow: `0 0 0 2.5px ${hexToRgba(
                          isSafeHexColor(haloColor) ? haloColor : DEFAULT_EXACT_HALO_COLOR,
                          0.45,
                        )}`,
                      }}
                    >
                      {username.slice(0, 1).toUpperCase()}
                    </div>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 text-zinc-400 transition-transform ${
                      pinAppearanceExpanded ? 'rotate-180 text-zinc-800 dark:text-zinc-200' : ''
                    }`}
                  />
                </div>
              </button>

              {pinAppearanceExpanded && (
                <div className="lo-tab-enter space-y-3 border-t border-zinc-200/70 px-3.5 py-3 dark:border-zinc-800">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      <span>User Halo Color</span>
                      {haloColor && (
                        <button
                          type="button"
                          onClick={() => setHaloColor(null)}
                          className="text-[10px] text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {PIN_COLOR_PRESETS.map((preset) => {
                        const selected = haloColor?.toLowerCase() === preset.hex;
                        return (
                          <button
                            key={`pin-halo-${preset.hex}`}
                            type="button"
                            title={preset.label}
                            onClick={() => setHaloColor(preset.hex)}
                            className={`h-6 w-6 rounded-full border-2 transition ${
                              selected
                                ? 'scale-110 border-zinc-950 ring-2 ring-zinc-900/20 dark:border-zinc-100 dark:ring-zinc-100/25'
                                : 'border-white shadow-sm dark:border-zinc-800'
                            }`}
                            style={{ backgroundColor: preset.hex }}
                          />
                        );
                      })}
                      <label className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700">
                        <input
                          type="color"
                          aria-label="Custom halo color"
                          value={isSafeHexColor(haloColor) ? haloColor : DEFAULT_EXACT_HALO_COLOR}
                          onChange={(e) => setHaloColor(e.target.value.toLowerCase())}
                          className="h-3.5 w-3.5 cursor-pointer border-0 bg-transparent p-0"
                        />
                        Custom
                      </label>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                      <span>Fuzzed Circle Color</span>
                      {fuzzCircleColor && (
                        <button
                          type="button"
                          onClick={() => setFuzzCircleColor(null)}
                          className="text-[10px] text-zinc-500 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {PIN_COLOR_PRESETS.map((preset) => {
                        const selected = fuzzCircleColor?.toLowerCase() === preset.hex;
                        return (
                          <button
                            key={`pin-fuzz-${preset.hex}`}
                            type="button"
                            title={preset.label}
                            onClick={() => setFuzzCircleColor(preset.hex)}
                            className={`h-6 w-6 rounded-full border-2 transition ${
                              selected
                                ? 'scale-110 border-zinc-950 ring-2 ring-zinc-900/20 dark:border-zinc-100 dark:ring-zinc-100/25'
                                : 'border-white shadow-sm dark:border-zinc-800'
                            }`}
                            style={{ backgroundColor: preset.hex }}
                          />
                        );
                      })}
                      <label className="ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700">
                        <input
                          type="color"
                          aria-label="Custom fuzzed circle color"
                          value={
                            isSafeHexColor(fuzzCircleColor)
                              ? fuzzCircleColor
                              : DEFAULT_FUZZ_CIRCLE_COLOR
                          }
                          onChange={(e) => setFuzzCircleColor(e.target.value.toLowerCase())}
                          className="h-3.5 w-3.5 cursor-pointer border-0 bg-transparent p-0"
                        />
                        Custom
                      </label>
                    </div>
                  </div>

                  {pinError && (
                    <p className="text-[11px] text-rose-600 dark:text-rose-400">{pinError}</p>
                  )}
                  {pinSaved && (
                    <p className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                      <Check className="h-3 w-3" />
                      {pinSaved}
                    </p>
                  )}

                  <button
                    type="button"
                    disabled={pinBusy}
                    onClick={() => void handleSavePinAppearance()}
                    className="lo-press flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-950 py-1.5 text-[11px] font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                  >
                    {pinBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                    <span>{pinBusy ? 'Saving Pin Colors...' : 'Save Pin Colors'}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="mt-5 flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetCurrentTab}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <RotateCcw className="h-3 w-3" />
              Reset Tab
            </button>
            <button
              type="button"
              onClick={onResetAll}
              className="text-[11px] font-medium text-zinc-500 hover:text-rose-600 dark:text-zinc-400 dark:hover:text-rose-400"
            >
              Reset All
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="lo-press rounded-lg bg-zinc-950 px-4 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
