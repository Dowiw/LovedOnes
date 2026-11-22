import React, { useEffect, useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import WheelColorPicker from 'react-native-wheel-color-picker';
import { isSafeHexColor } from '@loved-ones/shared';
import {
  type GeometricFontFamily,
  type OnboardingPalette,
} from '../services/onboardingTheme';
import { useSafeAreaInsets } from '../services/safeArea';

interface ColorPickerSheetProps {
  visible: boolean;
  initialHex: string | null;
  palette: OnboardingPalette;
  fonts: GeometricFontFamily;
  onApply: (hex: string) => void;
  onClose: () => void;
}

/**
 * Interactive custom color wheel + brightness slider + direct #RRGGBB hex editor
 * powered by react-native-wheel-color-picker with minimal rounded-square framing.
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
  const fallbackHex = initialHex && isSafeHexColor(initialHex) ? initialHex.toLowerCase() : '#0ea5e9';
  const [wheelSeedColor, setWheelSeedColor] = useState<string>(fallbackHex);
  const [liveHex, setLiveHex] = useState<string>(fallbackHex);
  const [hexInput, setHexInput] = useState<string>(fallbackHex);

  useEffect(() => {
    if (!visible) return;
    const seed = initialHex && isSafeHexColor(initialHex) ? initialHex.toLowerCase() : '#0ea5e9';
    setWheelSeedColor(seed);
    setLiveHex(seed);
    setHexInput(seed);
  }, [visible, initialHex]);

  function handleHexText(raw: string) {
    setHexInput(raw);
    const trimmed = raw.trim();
    if (isSafeHexColor(trimmed)) {
      const normalized = trimmed.toLowerCase();
      setLiveHex(normalized);
      setWheelSeedColor(normalized);
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
                  Drag the color wheel or type a #RRGGBB hex code.
                </Text>
              </View>
              <View
                style={[
                  styles.livePreview,
                  { backgroundColor: liveHex, borderColor: palette.borderStrong },
                ]}
              />
            </View>

            <View
              style={[
                styles.wheelContainer,
                { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
              ]}
            >
              <WheelColorPicker
                color={wheelSeedColor}
                thumbSize={26}
                sliderSize={22}
                gapSize={14}
                noSnap
                swatches={false}
                useNativeLayout
                shadeSliderThumb
                onColorChange={(hex) => {
                  const normalized = hex.toLowerCase();
                  setLiveHex(normalized);
                  setHexInput(normalized);
                }}
                onColorChangeComplete={(hex) => {
                  const normalized = hex.toLowerCase();
                  setLiveHex(normalized);
                  setHexInput(normalized);
                }}
              />
            </View>

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
                    borderColor: palette.borderStrong,
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
    borderRadius: 10,
    padding: 20,
    gap: 14,
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
    width: 38,
    height: 38,
    borderRadius: 6,
    borderWidth: 1.5,
  },
  wheelContainer: {
    height: 274,
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
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
    borderRadius: 6,
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
    borderRadius: 8,
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
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
