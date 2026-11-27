import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
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
  type ActivityPaletteGroupId,
  type ChatBubbleStyleOption,
  type CornerStyleOption,
  type DensityOption,
  type InterfacePresetId,
  type SurfaceWashLevel,
  type TrailActivityMode,
  type UserCustomization,
} from '@loved-ones/shared';
import { ColorPickerSheet } from './ColorPickerSheet';
import {
  getOnboardingPalette,
  hexToHsv,
  ONBOARDING_COLOR_PRESETS,
  type GeometricFontFamily,
  type OnboardingPalette,
} from '../services/onboardingTheme';
import { useSafeAreaInsets } from '../services/safeArea';
import type { MobileMapThemePreference } from '../services/secureConfig';

export type MobileCustomizeTab = 'interface' | 'map';

interface MobileCustomizeModalProps {
  visible: boolean;
  initialTab?: MobileCustomizeTab;
  username: string;
  scheme: 'light' | 'dark';
  mapThemePreference: MobileMapThemePreference;
  fonts: GeometricFontFamily;
  customization: UserCustomization;
  haloColor: string | null;
  fuzzCircleColor: string | null;
  onChangeMapTheme: (pref: MobileMapThemePreference) => void;
  onSavePinAppearance: (halo: string | null, fuzz: string | null) => Promise<void>;
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

type PickerTarget =
  | { kind: 'custom-ui'; hex: string }
  | { kind: 'activity'; mode: TrailActivityMode; hex: string }
  | { kind: 'group-place'; hex: string }
  | { kind: 'private-place'; hex: string }
  | { kind: 'fallback-trail'; hex: string }
  | { kind: 'pin-halo'; hex: string }
  | { kind: 'pin-fuzz'; hex: string };

export function MobileCustomizeModal({
  visible,
  initialTab = 'interface',
  username,
  scheme,
  mapThemePreference,
  fonts,
  customization,
  haloColor,
  fuzzCircleColor,
  onChangeMapTheme,
  onSavePinAppearance,
  onUpdate,
  onResetAll,
  onClose,
}: MobileCustomizeModalProps) {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<MobileCustomizeTab>(initialTab);
  const [visualStyleExpanded, setVisualStyleExpanded] = useState(false);
  const [mapDetailsExpanded, setMapDetailsExpanded] = useState(false);
  const [pinExpanded, setPinExpanded] = useState(false);
  const [draftHalo, setDraftHalo] = useState<string | null>(haloColor);
  const [draftFuzz, setDraftFuzz] = useState<string | null>(fuzzCircleColor);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinSaved, setPinSaved] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);

  useEffect(() => {
    if (visible) {
      setActiveTab(initialTab);
      setDraftHalo(haloColor);
      setDraftFuzz(fuzzCircleColor);
      setPinSaved(null);
      setPinError(null);
    }
  }, [visible, initialTab, haloColor, fuzzCircleColor]);

  const ui = useMemo(() => getOnboardingPalette(scheme, customization), [scheme, customization]);
  const tokens = useMemo(
    () => resolveInterfaceThemeTokens(customization, scheme),
    [customization, scheme],
  );
  const resolvedActivities = useMemo(() => resolveActivityColors(customization), [customization]);
  const s = useMemo(() => createStyles(ui, scheme), [ui, scheme]);

  const customModeActive = customization.themeMode === 'custom';
  const showWashControl =
    customization.themeMode === 'custom' || customization.interfacePreset !== 'default';
  const customHexPreview = hslToHex(
    customization.customInterface.hue,
    customization.customInterface.saturation,
    customization.customInterface.lightness,
  );

  function selectPreset(id: InterfacePresetId) {
    onUpdate((prev) => ({
      ...prev,
      themeMode: 'preset',
      interfacePreset: id,
    }));
  }

  function activateCustomMode() {
    onUpdate((prev) => {
      if (prev.themeMode === 'custom') return prev;
      const src =
        INTERFACE_THEME_PRESETS.find((p) => p.id === prev.interfacePreset) ??
        INTERFACE_THEME_PRESETS[1];
      return {
        ...prev,
        themeMode: 'custom',
        customInterface:
          src.id === 'default'
            ? prev.customInterface
            : { hue: src.hue, saturation: src.saturation, lightness: src.lightness },
      };
    });
  }

  function stepHue(delta: number) {
    onUpdate((prev) => {
      const nextHue = (prev.customInterface.hue + delta + 360) % 360;
      return {
        ...prev,
        themeMode: 'custom',
        customInterface: { ...prev.customInterface, hue: nextHue },
      };
    });
  }

  function selectActivityGroup(groupId: ActivityPaletteGroupId) {
    onUpdate((prev) => {
      if (groupId === 'custom') {
        return {
          ...prev,
          activityPaletteId: 'custom',
          customActivityColors: resolveActivityColors(prev),
        };
      }
      return {
        ...prev,
        activityPaletteId: groupId,
      };
    });
  }

  function handleResetTab() {
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

  function handleApplyPickedHex(hex: string) {
    if (!pickerTarget) return;
    const clean = hex.toLowerCase();
    if (pickerTarget.kind === 'custom-ui') {
      const hsv = hexToHsv(clean);
      const lightness = Math.max(24, Math.min(68, Math.round(hsv.v * (1 - hsv.s / 2) * 100)));
      onUpdate((prev) => ({
        ...prev,
        themeMode: 'custom',
        customInterface: {
          hue: Math.round(hsv.h),
          saturation: Math.max(15, Math.min(100, Math.round(hsv.s * 100))),
          lightness,
        },
      }));
    } else if (pickerTarget.kind === 'activity') {
      const targetMode = pickerTarget.mode;
      onUpdate((prev) => ({
        ...prev,
        activityPaletteId: 'custom',
        customActivityColors: {
          ...resolveActivityColors(prev),
          [targetMode]: clean,
        },
      }));
    } else if (pickerTarget.kind === 'group-place') {
      onUpdate((prev) => ({
        ...prev,
        mapAccents: { ...prev.mapAccents, groupPlaceColor: clean },
      }));
    } else if (pickerTarget.kind === 'private-place') {
      onUpdate((prev) => ({
        ...prev,
        mapAccents: { ...prev.mapAccents, privatePlaceColor: clean },
      }));
    } else if (pickerTarget.kind === 'fallback-trail') {
      onUpdate((prev) => ({
        ...prev,
        mapAccents: { ...prev.mapAccents, fallbackTrailColor: clean },
      }));
    } else if (pickerTarget.kind === 'pin-halo') {
      setDraftHalo(clean);
    } else if (pickerTarget.kind === 'pin-fuzz') {
      setDraftFuzz(clean);
    }
    setPickerTarget(null);
  }

  async function handleSavePins() {
    setPinError(null);
    setPinSaved(null);
    setPinBusy(true);
    try {
      await onSavePinAppearance(draftHalo, draftFuzz);
      setPinSaved('Map pin colors saved');
    } catch (err) {
      setPinError(err instanceof Error ? err.message : 'Unable to save map pin colors');
    } finally {
      setPinBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={[
          s.wrap,
          { paddingTop: Math.max(insets.top + 8, 48), paddingBottom: Math.max(insets.bottom + 8, 16) },
        ]}
      >
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={[s.title, { fontFamily: fonts.display }]}>
              Personalized Theme &amp; Activity
            </Text>
            <Text style={s.subtitle}>Saved locally for @{username} · Instant preview</Text>
          </View>
          <TouchableOpacity style={s.doneBtn} onPress={onClose}>
            <Text style={s.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={s.tabSegment}>
          <TouchableOpacity
            style={[s.tabBtn, activeTab === 'interface' && s.tabBtnActive]}
            onPress={() => setActiveTab('interface')}
          >
            <Text style={[s.tabBtnText, activeTab === 'interface' && s.tabBtnTextActive]}>
              Interface &amp; Hue
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabBtn, activeTab === 'map' && s.tabBtnActive]}
            onPress={() => setActiveTab('map')}
          >
            <Text style={[s.tabBtnText, activeTab === 'map' && s.tabBtnTextActive]}>
              Trails &amp; Map Colors
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={s.scrollContent}>
          {activeTab === 'interface' ? (
            <>
              {/* Live Preview Card */}
              <View
                style={[
                  s.previewCard,
                  { backgroundColor: tokens.canvasBg, borderColor: tokens.borderColor },
                ]}
              >
                <View style={s.previewRow}>
                  <View style={[s.previewPill, { backgroundColor: tokens.accentBg }]}>
                    <Text style={[s.previewPillText, { color: tokens.accentFg }]}>Primary CTA</Text>
                  </View>
                  <View style={[s.previewPill, { backgroundColor: tokens.accentSoftBg }]}>
                    <Text style={[s.previewPillText, { color: tokens.accentSoftText }]}>
                      Active Tab
                    </Text>
                  </View>
                  <View
                    style={[
                      s.previewPill,
                      customization.mapAccents.chatBubbleStyle === 'tinted'
                        ? {
                            backgroundColor: tokens.accentSoftBg,
                            borderWidth: 1,
                            borderColor: tokens.accentBorder,
                          }
                        : { backgroundColor: tokens.accentBg },
                    ]}
                  >
                    <Text
                      style={[
                        s.previewPillText,
                        {
                          color:
                            customization.mapAccents.chatBubbleStyle === 'tinted'
                              ? tokens.accentSoftText
                              : tokens.accentFg,
                        },
                      ]}
                    >
                      Chat
                    </Text>
                  </View>
                </View>
              </View>

              {/* Map & Interface Mode (System / Light / Dark) */}
              <View style={s.card}>
                <View style={s.sectionRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.sectionHeading}>Map &amp; Interface Mode</Text>
                    <Text style={s.hintText}>Light, Dark, or follow system</Text>
                  </View>
                  <View style={s.segSmall}>
                    {(
                      [
                        ['system', 'System'],
                        ['light', 'Light'],
                        ['dark', 'Dark'],
                      ] as const
                    ).map(([pref, label]) => {
                      const active = mapThemePreference === pref;
                      return (
                        <TouchableOpacity
                          key={pref}
                          style={[s.segSmallBtn, active && s.segSmallBtnActive]}
                          onPress={() => onChangeMapTheme(pref)}
                        >
                          <Text style={[s.segSmallText, active && s.segSmallTextActive]}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </View>

              {/* Presets + Custom Mode */}
              <View style={s.card}>
                <View style={s.sectionRow}>
                  <Text style={s.sectionHeading}>Interface Color</Text>
                  <TouchableOpacity
                    style={[s.miniPill, customModeActive && s.miniPillActive]}
                    onPress={activateCustomMode}
                  >
                    <Text style={[s.miniPillText, customModeActive && s.miniPillTextActive]}>
                      Custom Mode
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={s.swatchGrid}>
                  {INTERFACE_THEME_PRESETS.map((preset) => {
                    const selected = !customModeActive && customization.interfacePreset === preset.id;
                    return (
                      <TouchableOpacity
                        key={preset.id}
                        style={[s.swatchBtn, selected && s.swatchBtnActive]}
                        onPress={() => selectPreset(preset.id)}
                      >
                        <View style={[s.swatchDot, { backgroundColor: preset.swatchHex }]} />
                        <Text
                          style={[s.swatchLabel, selected && s.swatchLabelActive]}
                          numberOfLines={1}
                        >
                          {preset.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {customModeActive && (
                  <View style={s.customBox}>
                    <View style={s.sectionRow}>
                      <Text style={s.fieldLabel}>
                        Custom Hue · {Math.round(customization.customInterface.hue)}°
                      </Text>
                      <TouchableOpacity
                        style={s.wheelBtn}
                        onPress={() =>
                          setPickerTarget({ kind: 'custom-ui', hex: customHexPreview })
                        }
                      >
                        <View style={[s.miniDot, { backgroundColor: customHexPreview }]} />
                        <Text style={s.wheelBtnText}>Open Wheel ({customHexPreview})</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={s.stepRow}>
                      <TouchableOpacity style={s.stepBtn} onPress={() => stepHue(-20)}>
                        <Text style={s.stepBtnText}>-20°</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.stepBtn} onPress={() => stepHue(-5)}>
                        <Text style={s.stepBtnText}>-5°</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.stepBtn} onPress={() => stepHue(5)}>
                        <Text style={s.stepBtnText}>+5°</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.stepBtn} onPress={() => stepHue(20)}>
                        <Text style={s.stepBtnText}>+20°</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {showWashControl && (
                  <View style={s.washRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fieldLabel}>Surface Wash</Text>
                      <Text style={s.hintText}>Subtle background &amp; border tint</Text>
                    </View>
                    <View style={s.segSmall}>
                      {(['off', 'subtle', 'bold'] as SurfaceWashLevel[]).map((level) => {
                        const active = customization.surfaceWash === level;
                        return (
                          <TouchableOpacity
                            key={level}
                            style={[s.segSmallBtn, active && s.segSmallBtnActive]}
                            onPress={() =>
                              onUpdate((prev) => ({ ...prev, surfaceWash: level }))
                            }
                          >
                            <Text style={[s.segSmallText, active && s.segSmallTextActive]}>
                              {level}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
              </View>

              {/* Progressive Disclosure: Visual Style */}
              <View style={s.card}>
                <TouchableOpacity
                  style={s.sectionRow}
                  onPress={() => setVisualStyleExpanded((v) => !v)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.sectionHeading}>Layout Shape &amp; Comfort</Text>
                    <Text style={s.hintText}>
                      {customization.visualStyle.cornerStyle} corners ·{' '}
                      {customization.visualStyle.density}
                    </Text>
                  </View>
                  <Text style={s.expandText}>{visualStyleExpanded ? 'Hide ▲' : 'Show ▼'}</Text>
                </TouchableOpacity>

                {visualStyleExpanded && (
                  <View style={s.disclosureBody}>
                    <View style={s.disclosureRow}>
                      <Text style={s.fieldLabel}>Corner Style</Text>
                      <View style={s.segSmall}>
                        {(['crisp', 'balanced', 'soft'] as CornerStyleOption[]).map((opt) => {
                          const active = customization.visualStyle.cornerStyle === opt;
                          return (
                            <TouchableOpacity
                              key={opt}
                              style={[s.segSmallBtn, active && s.segSmallBtnActive]}
                              onPress={() =>
                                onUpdate((prev) => ({
                                  ...prev,
                                  visualStyle: { ...prev.visualStyle, cornerStyle: opt },
                                }))
                              }
                            >
                              <Text style={[s.segSmallText, active && s.segSmallTextActive]}>
                                {opt}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>

                    <View style={s.disclosureRow}>
                      <Text style={s.fieldLabel}>Density</Text>
                      <View style={s.segSmall}>
                        {(['comfortable', 'compact'] as DensityOption[]).map((opt) => {
                          const active = customization.visualStyle.density === opt;
                          return (
                            <TouchableOpacity
                              key={opt}
                              style={[s.segSmallBtn, active && s.segSmallBtnActive]}
                              onPress={() =>
                                onUpdate((prev) => ({
                                  ...prev,
                                  visualStyle: { ...prev.visualStyle, density: opt },
                                }))
                              }
                            >
                              <Text style={[s.segSmallText, active && s.segSmallTextActive]}>
                                {opt}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                )}
              </View>
            </>
          ) : (
            <>
              {/* Activity Palette Groups */}
              <View style={s.card}>
                <Text style={s.sectionHeading}>Activity Trail Color Groups</Text>
                {ACTIVITY_PALETTE_GROUPS.map((group) => {
                  const selected = customization.activityPaletteId === group.id;
                  return (
                    <TouchableOpacity
                      key={group.id}
                      style={[s.groupRow, selected && s.groupRowActive]}
                      onPress={() => selectActivityGroup(group.id)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={s.groupTitle}>{group.label}</Text>
                        <Text style={s.hintText}>{group.description}</Text>
                      </View>
                      <View style={s.dotsRow}>
                        {ACTIVITY_ORDER.map((mode) => (
                          <View
                            key={mode}
                            style={[s.activityDot, { backgroundColor: group.colors[mode] }]}
                          />
                        ))}
                      </View>
                    </TouchableOpacity>
                  );
                })}

                <TouchableOpacity
                  style={[s.groupRow, customization.activityPaletteId === 'custom' && s.groupRowActive]}
                  onPress={() => selectActivityGroup('custom')}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.groupTitle}>Custom Activity Group</Text>
                    <Text style={s.hintText}>Tailored per movement mode</Text>
                  </View>
                  <View style={s.dotsRow}>
                    {ACTIVITY_ORDER.map((mode) => (
                      <View
                        key={mode}
                        style={[s.activityDot, { backgroundColor: resolvedActivities[mode] }]}
                      />
                    ))}
                  </View>
                </TouchableOpacity>
              </View>

              {/* Individual Activity Overrides */}
              <View style={s.card}>
                <Text style={s.sectionHeading}>Fine-Tune Each Activity</Text>
                <Text style={s.hintText}>
                  Tap any activity to open the color wheel (clones active group to Custom).
                </Text>
                <View style={s.activityChipGrid}>
                  {ACTIVITY_ORDER.map((mode) => (
                    <TouchableOpacity
                      key={mode}
                      style={s.activityEditChip}
                      onPress={() =>
                        setPickerTarget({ kind: 'activity', mode, hex: resolvedActivities[mode] })
                      }
                    >
                      <View
                        style={[s.activityDot, { backgroundColor: resolvedActivities[mode] }]}
                      />
                      <Text style={s.activityEditLabel}>{ACTIVITY_MODE_LABELS[mode]}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Progressive Disclosure: Places, Fallback Trail, Chat */}
              <View style={s.card}>
                <TouchableOpacity
                  style={s.sectionRow}
                  onPress={() => setMapDetailsExpanded((v) => !v)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.sectionHeading}>Places, Trail Line &amp; Chat Bubble</Text>
                    <Text style={s.hintText}>Geofence pin colors &amp; non-activity lines</Text>
                  </View>
                  <Text style={s.expandText}>{mapDetailsExpanded ? 'Hide ▲' : 'Show ▼'}</Text>
                </TouchableOpacity>

                {mapDetailsExpanded && (
                  <View style={s.disclosureBody}>
                    <TouchableOpacity
                      style={s.disclosureRow}
                      onPress={() =>
                        setPickerTarget({
                          kind: 'group-place',
                          hex: customization.mapAccents.groupPlaceColor,
                        })
                      }
                    >
                      <Text style={s.fieldLabel}>Group Shared Place Pin</Text>
                      <View
                        style={[
                          s.colorChipPreview,
                          { backgroundColor: customization.mapAccents.groupPlaceColor },
                        ]}
                      />
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={s.disclosureRow}
                      onPress={() =>
                        setPickerTarget({
                          kind: 'private-place',
                          hex: customization.mapAccents.privatePlaceColor,
                        })
                      }
                    >
                      <Text style={s.fieldLabel}>Private Place Pin</Text>
                      <View
                        style={[
                          s.colorChipPreview,
                          { backgroundColor: customization.mapAccents.privatePlaceColor },
                        ]}
                      />
                    </TouchableOpacity>

                    <View style={s.disclosureRow}>
                      <Text style={s.fieldLabel}>Single-Color Trail</Text>
                      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                        <TouchableOpacity
                          style={[
                            s.miniPill,
                            customization.mapAccents.fallbackTrailColor === 'auto' &&
                              s.miniPillActive,
                          ]}
                          onPress={() =>
                            onUpdate((prev) => ({
                              ...prev,
                              mapAccents: { ...prev.mapAccents, fallbackTrailColor: 'auto' },
                            }))
                          }
                        >
                          <Text
                            style={[
                              s.miniPillText,
                              customization.mapAccents.fallbackTrailColor === 'auto' &&
                                s.miniPillTextActive,
                            ]}
                          >
                            Auto
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={s.wheelBtn}
                          onPress={() =>
                            setPickerTarget({
                              kind: 'fallback-trail',
                              hex:
                                customization.mapAccents.fallbackTrailColor === 'auto'
                                  ? tokens.accentBg
                                  : customization.mapAccents.fallbackTrailColor,
                            })
                          }
                        >
                          <View
                            style={[
                              s.miniDot,
                              {
                                backgroundColor:
                                  customization.mapAccents.fallbackTrailColor === 'auto'
                                    ? tokens.accentBg
                                    : customization.mapAccents.fallbackTrailColor,
                              },
                            ]}
                          />
                          <Text style={s.wheelBtnText}>Pick</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    <View style={s.disclosureRow}>
                      <Text style={s.fieldLabel}>Chat Bubble Style</Text>
                      <View style={s.segSmall}>
                        {(['accent', 'tinted'] as ChatBubbleStyleOption[]).map((opt) => {
                          const active = customization.mapAccents.chatBubbleStyle === opt;
                          return (
                            <TouchableOpacity
                              key={opt}
                              style={[s.segSmallBtn, active && s.segSmallBtnActive]}
                              onPress={() =>
                                onUpdate((prev) => ({
                                  ...prev,
                                  mapAccents: { ...prev.mapAccents, chatBubbleStyle: opt },
                                }))
                              }
                            >
                              <Text style={[s.segSmallText, active && s.segSmallTextActive]}>
                                {opt === 'accent' ? 'Solid' : 'Tinted'}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                )}
              </View>

              {/* Map Pin Appearance (Visible to Group) */}
              <View style={s.card}>
                <TouchableOpacity
                  style={s.sectionRow}
                  onPress={() => setPinExpanded((v) => !v)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.sectionHeading}>Map Pin Appearance (Visible to Group)</Text>
                    <Text style={s.hintText}>Your marker halo &amp; fuzzed area ring</Text>
                  </View>
                  <Text style={s.expandText}>{pinExpanded ? 'Hide ▲' : 'Show ▼'}</Text>
                </TouchableOpacity>

                {pinExpanded && (
                  <View style={s.disclosureBody}>
                    <View style={s.sectionRow}>
                      <Text style={s.fieldLabel}>User Halo Color</Text>
                      {draftHalo && (
                        <TouchableOpacity onPress={() => setDraftHalo(null)}>
                          <Text style={s.hintText}>Reset</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={s.dotsRow}>
                      {ONBOARDING_COLOR_PRESETS.map((preset) => (
                        <TouchableOpacity
                          key={`pin-halo-${preset.hex}`}
                          onPress={() => setDraftHalo(preset.hex)}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 999,
                            backgroundColor: preset.hex,
                            borderWidth: draftHalo?.toLowerCase() === preset.hex ? 3 : 1.5,
                            borderColor:
                              draftHalo?.toLowerCase() === preset.hex ? ui.ctaBg : ui.borderStrong,
                          }}
                        />
                      ))}
                      <TouchableOpacity
                        style={s.miniPill}
                        onPress={() =>
                          setPickerTarget({
                            kind: 'pin-halo',
                            hex: isSafeHexColor(draftHalo) ? draftHalo : DEFAULT_EXACT_HALO_COLOR,
                          })
                        }
                      >
                        <Text style={s.miniPillText}>Custom</Text>
                      </TouchableOpacity>
                    </View>

                    <View style={s.sectionRow}>
                      <Text style={s.fieldLabel}>Fuzzed Circle Color</Text>
                      {draftFuzz && (
                        <TouchableOpacity onPress={() => setDraftFuzz(null)}>
                          <Text style={s.hintText}>Reset</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={s.dotsRow}>
                      {ONBOARDING_COLOR_PRESETS.map((preset) => (
                        <TouchableOpacity
                          key={`pin-fuzz-${preset.hex}`}
                          onPress={() => setDraftFuzz(preset.hex)}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 999,
                            backgroundColor: preset.hex,
                            borderWidth: draftFuzz?.toLowerCase() === preset.hex ? 3 : 1.5,
                            borderColor:
                              draftFuzz?.toLowerCase() === preset.hex ? ui.ctaBg : ui.borderStrong,
                          }}
                        />
                      ))}
                      <TouchableOpacity
                        style={s.miniPill}
                        onPress={() =>
                          setPickerTarget({
                            kind: 'pin-fuzz',
                            hex: isSafeHexColor(draftFuzz) ? draftFuzz : DEFAULT_FUZZ_CIRCLE_COLOR,
                          })
                        }
                      >
                        <Text style={s.miniPillText}>Custom</Text>
                      </TouchableOpacity>
                    </View>

                    {pinError ? <Text style={s.resetAllText}>{pinError}</Text> : null}
                    {pinSaved ? (
                      <Text style={{ color: ui.badgeSuccessText, fontSize: 11, fontWeight: '600' }}>
                        {pinSaved}
                      </Text>
                    ) : null}

                    <TouchableOpacity
                      style={[
                        s.tabBtnActive,
                        { borderRadius: 10, paddingVertical: 9, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
                      ]}
                      disabled={pinBusy}
                      onPress={() => void handleSavePins()}
                    >
                      {pinBusy && <ActivityIndicator size="small" color={ui.ctaText} />}
                      <Text style={s.tabBtnTextActive}>
                        {pinBusy ? 'Saving Pin Colors...' : 'Save Pin Colors'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </>
          )}
        </ScrollView>

        <View style={s.footer}>
          <TouchableOpacity style={s.resetTabBtn} onPress={handleResetTab}>
            <Text style={s.resetTabText}>Reset Tab</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.resetAllBtn} onPress={onResetAll}>
            <Text style={s.resetAllText}>Reset All Defaults</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ColorPickerSheet
        visible={pickerTarget !== null}
        initialHex={pickerTarget?.hex ?? tokens.accentBg}
        palette={ui}
        fonts={fonts}
        onApply={handleApplyPickedHex}
        onClose={() => setPickerTarget(null)}
      />
    </Modal>
  );
}

function createStyles(ui: OnboardingPalette, scheme: 'light' | 'dark') {
  return StyleSheet.create({
    wrap: { flex: 1, backgroundColor: ui.canvas },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 12,
      gap: 12,
    },
    title: { color: ui.ink, fontSize: 19, fontWeight: '700' },
    subtitle: { color: ui.inkMuted, fontSize: 12, marginTop: 2 },
    doneBtn: {
      backgroundColor: ui.ctaBg,
      borderRadius: 999,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    doneText: { color: ui.ctaText, fontSize: 12, fontWeight: '700' },
    tabSegment: {
      flexDirection: 'row',
      marginHorizontal: 16,
      marginBottom: 12,
      borderRadius: 10,
      backgroundColor: ui.surfaceMuted,
      padding: 3,
      borderWidth: 1,
      borderColor: ui.border,
    },
    tabBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
    tabBtnActive: { backgroundColor: ui.ctaBg },
    tabBtnText: { color: ui.inkMuted, fontSize: 12, fontWeight: '700' },
    tabBtnTextActive: { color: ui.ctaText },
    scrollContent: { paddingHorizontal: 16, paddingBottom: 20, gap: 12 },
    previewCard: {
      borderRadius: 14,
      borderWidth: 1,
      padding: 12,
    },
    previewRow: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'space-between' },
    previewPill: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
    previewPillText: { fontSize: 11, fontWeight: '700' },
    card: {
      backgroundColor: ui.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: ui.border,
      padding: 14,
      gap: 10,
    },
    sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    sectionHeading: { color: ui.ink, fontSize: 13, fontWeight: '700' },
    fieldLabel: { color: ui.ink, fontSize: 12, fontWeight: '600' },
    hintText: { color: ui.inkMuted, fontSize: 11 },
    expandText: { color: ui.inkMuted, fontSize: 11, fontWeight: '700' },
    miniPill: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    miniPillActive: { backgroundColor: ui.ctaBg, borderColor: ui.ctaBg },
    miniPillText: { color: ui.ink, fontSize: 11, fontWeight: '700' },
    miniPillTextActive: { color: ui.ctaText },
    swatchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    swatchBtn: {
      width: '48%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 10,
      paddingVertical: 9,
    },
    swatchBtnActive: {
      borderColor: ui.ctaBg,
      backgroundColor: hexToRgba(ui.ctaBg, scheme === 'dark' ? 0.16 : 0.08),
    },
    swatchDot: { width: 14, height: 14, borderRadius: 999 },
    swatchLabel: { color: ui.ink, fontSize: 12, fontWeight: '600', flex: 1 },
    swatchLabelActive: { fontWeight: '700' },
    customBox: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 10,
      gap: 8,
    },
    wheelBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      backgroundColor: ui.surface,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    wheelBtnText: { color: ui.ink, fontSize: 11, fontWeight: '600' },
    miniDot: { width: 10, height: 10, borderRadius: 999 },
    stepRow: { flexDirection: 'row', gap: 6 },
    stepBtn: {
      flex: 1,
      alignItems: 'center',
      borderRadius: 8,
      backgroundColor: ui.surface,
      borderWidth: 1,
      borderColor: ui.border,
      paddingVertical: 6,
    },
    stepBtnText: { color: ui.ink, fontSize: 11, fontWeight: '700' },
    washRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingTop: 4,
    },
    segSmall: {
      flexDirection: 'row',
      gap: 2,
      backgroundColor: ui.surfaceMuted,
      borderRadius: 8,
      padding: 2,
      borderWidth: 1,
      borderColor: ui.border,
    },
    segSmallBtn: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
    segSmallBtnActive: { backgroundColor: ui.ctaBg },
    segSmallText: { color: ui.inkMuted, fontSize: 10, fontWeight: '700', textTransform: 'capitalize' },
    segSmallTextActive: { color: ui.ctaText },
    disclosureBody: { gap: 10, paddingTop: 6, borderTopWidth: 1, borderTopColor: ui.border },
    disclosureRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    groupRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      padding: 10,
    },
    groupRowActive: {
      borderColor: ui.ctaBg,
      backgroundColor: hexToRgba(ui.ctaBg, scheme === 'dark' ? 0.16 : 0.08),
    },
    groupTitle: { color: ui.ink, fontSize: 12, fontWeight: '700' },
    dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    activityDot: { width: 11, height: 11, borderRadius: 999 },
    activityChipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    activityEditChip: {
      width: '31%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: ui.border,
      backgroundColor: ui.surfaceMuted,
      paddingHorizontal: 9,
      paddingVertical: 8,
    },
    activityEditLabel: { color: ui.ink, fontSize: 11, fontWeight: '600' },
    colorChipPreview: {
      width: 24,
      height: 24,
      borderRadius: 999,
      borderWidth: 1.5,
      borderColor: ui.borderStrong,
    },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: ui.border,
    },
    resetTabBtn: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: ui.borderStrong,
      backgroundColor: ui.surface,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    resetTabText: { color: ui.ink, fontSize: 11, fontWeight: '600' },
    resetAllBtn: { paddingHorizontal: 8, paddingVertical: 7 },
    resetAllText: { color: ui.errorText, fontSize: 11, fontWeight: '600' },
  });
}
