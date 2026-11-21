import React, { useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { isSafeHexColor } from '@loved-ones/shared';
import {
  type GeometricFontFamily,
  hexToHsv,
  type HsvColor,
  hsvToHex,
  type OnboardingPalette,
} from '../services/onboardingTheme';
import { useSafeAreaInsets } from '../services/safeArea';

export { hexToHsv, type HsvColor, hsvToHex };

const HUE_STOPS = Array.from({ length: 24 }, (_, idx) => (idx / 23) * 360);
const SAT_SHADE_ROWS = [1, 0.8, 0.6, 0.4, 0.2];
const SAT_SHADE_COLS = [0.15, 0.35, 0.55, 0.75, 0.92, 1];

interface ColorPickerSheetProps {
  visible: boolean;
  initialHex: string | null;
  palette: OnboardingPalette;
  fonts: GeometricFontFamily;
  onApply: (hex: string) => void;
  onClose: () => void;
}

/**
 * Interactive visual custom hex color picker for Android & iOS (Hue bar + Sat/Value grid + #RRGGBB).
 */
export function ColorPickerSheet({
  visible,
  initialHex,
  palette,
  fonts,
  onApply,
  onClose,
}: ColorPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const startHex = initialHex && isSafeHexColor(initialHex) ? initialHex : '#0ea5e9';
  const [hsv, setHsv] = useState<HsvColor>(() => hexToHsv(startHex));
  const [hexInput, setHexInput] = useState<string>(startHex);
  const hueBarWidthRef = useRef(260);

  const liveHex = useMemo(() => hsvToHex(hsv), [hsv]);

  const huePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const w = Math.max(1, hueBarWidthRef.current);
          const ratio = Math.max(0, Math.min(1, evt.nativeEvent.locationX / w));
          const next = { ...hsv, h: ratio * 359 };
          setHsv(next);
          setHexInput(hsvToHex(next));
        },
        onPanResponderMove: (evt) => {
          const w = Math.max(1, hueBarWidthRef.current);
          const ratio = Math.max(0, Math.min(1, evt.nativeEvent.locationX / w));
          setHsv((prev) => {
            const next = { ...prev, h: ratio * 359 };
            setHexInput(hsvToHex(next));
            return next;
          });
        },
      }),
    [hsv],
  );

  function handleHexText(raw: string) {
    setHexInput(raw);
    const trimmed = raw.trim();
    if (isSafeHexColor(trimmed)) {
      setHsv(hexToHsv(trimmed));
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View pointerEvents="box-none" style={styles.modalOuter}>
        <View style={[styles.backdrop, { marginBottom: insets.bottom }]}>
        <View
          style={[
            styles.card,
            { backgroundColor: palette.surface, borderColor: palette.border },
          ]}
        >
          <View style={styles.headerRow}>
            <View>
              <Text style={[styles.title, { color: palette.ink, fontFamily: fonts.display }]}>
                Custom Accent Color
              </Text>
              <Text style={[styles.subtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}>
                Pick a shade or type any #RRGGBB hex code.
              </Text>
            </View>
            <View
              style={[
                styles.livePreview,
                { backgroundColor: liveHex, borderColor: palette.borderStrong },
              ]}
            />
          </View>

          {/* Saturation x Brightness Grid for selected Hue */}
          <View style={[styles.gridWrap, { borderColor: palette.border }]}>
            {SAT_SHADE_ROWS.map((vVal) => (
              <View key={vVal} style={styles.gridRow}>
                {SAT_SHADE_COLS.map((sVal) => {
                  const cellHex = hsvToHex({ h: hsv.h, s: sVal, v: vVal });
                  const selected =
                    Math.abs(hsv.s - sVal) < 0.09 && Math.abs(hsv.v - vVal) < 0.09;
                  return (
                    <TouchableOpacity
                      key={`${vVal}-${sVal}`}
                      activeOpacity={0.85}
                      style={[
                        styles.gridCell,
                        { backgroundColor: cellHex },
                        selected && { borderWidth: 2.5, borderColor: '#ffffff' },
                      ]}
                      onPress={() => {
                        const next = { ...hsv, s: sVal, v: vVal };
                        setHsv(next);
                        setHexInput(hsvToHex(next));
                      }}
                    />
                  );
                })}
              </View>
            ))}
          </View>

          {/* Continuous Hue Spectrum Slider */}
          <View style={styles.hueSection}>
            <Text style={[styles.label, { color: palette.inkSubtle, fontFamily: fonts.heading }]}>
              Hue Spectrum
            </Text>
            <View
              onLayout={(e) => {
                hueBarWidthRef.current = e.nativeEvent.layout.width;
              }}
              {...huePan.panHandlers}
              style={[styles.hueBar, { borderColor: palette.border }]}
            >
              {HUE_STOPS.map((stopH) => (
                <View
                  key={stopH}
                  style={[styles.hueSlice, { backgroundColor: hsvToHex({ h: stopH, s: 1, v: 1 }) }]}
                />
              ))}
              <View
                pointerEvents="none"
                style={[
                  styles.hueThumb,
                  {
                    left: `${(hsv.h / 360) * 92}%`,
                    backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }),
                  },
                ]}
              />
            </View>
          </View>

          {/* Direct Hex Entry */}
          <View style={styles.hexRow}>
            <Text style={[styles.label, { color: palette.inkSubtle, fontFamily: fonts.heading }]}>
              Hex Code
            </Text>
            <TextInput
              accessibilityLabel="Custom hex color code"
              style={[
                styles.hexInput,
                {
                  backgroundColor: palette.surfaceMuted,
                  borderColor: palette.border,
                  color: palette.ink,
                  fontFamily: fonts.mono,
                },
              ]}
              value={hexInput}
              onChangeText={handleHexText}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={7}
              placeholder="#0ea5e9"
              placeholderTextColor={palette.placeholder}
            />
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity
              accessibilityRole="button"
              style={[
                styles.secondaryBtn,
                { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
              ]}
              onPress={onClose}
            >
              <Text style={[styles.secondaryText, { color: palette.ink, fontFamily: fonts.heading }]}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              style={[styles.primaryBtn, { backgroundColor: palette.ctaBg }]}
              onPress={() => onApply(liveHex)}
            >
              <Text style={[styles.primaryText, { color: palette.ctaText, fontFamily: fonts.display }]}>
                Use {liveHex}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOuter: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(9, 9, 11, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  card: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 20,
    gap: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  livePreview: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 2,
  },
  gridWrap: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  gridRow: {
    flexDirection: 'row',
    height: 30,
  },
  gridCell: {
    flex: 1,
  },
  hueSection: {
    gap: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
  hueBar: {
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
    position: 'relative',
    alignItems: 'center',
  },
  hueSlice: {
    flex: 1,
    height: '100%',
  },
  hueThumb: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: '#ffffff',
    elevation: 3,
  },
  hexRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  hexInput: {
    minWidth: 130,
    height: 42,
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 12,
    fontSize: 14,
    textAlign: 'center',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: {
    fontSize: 14,
    fontWeight: '600',
  },
  primaryBtn: {
    flex: 1.4,
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
