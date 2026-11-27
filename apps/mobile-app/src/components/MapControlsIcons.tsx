import React from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Geometric North-pointing compass needle rotated by `-bearingDeg` so the red
 * tip continuously points toward true North whenever the map is rotated.
 */
export function CompassNeedleIcon({ bearingDeg }: { bearingDeg: number }) {
  return (
    <View style={[styles.compassWrap, { transform: [{ rotate: `${-bearingDeg}deg` }] }]}>
      <View style={styles.compassNorthTip} />
      <View style={styles.compassSouthTip} />
      <View style={styles.compassPivot} />
    </View>
  );
}

/**
 * Clean geometric location pin icon used on the floating recalibrate/GPS button.
 */
export function LocationPinIcon({
  active = false,
  tintColor = '#18181b',
  holeColor = '#ffffff',
}: {
  active?: boolean;
  tintColor?: string;
  holeColor?: string;
}) {
  const fill = active ? '#059669' : tintColor;
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pinHead, { backgroundColor: fill }]}>
        <View style={[styles.pinInnerHole, { backgroundColor: holeColor }]} />
      </View>
      <View style={[styles.pinPoint, { borderTopColor: fill }]} />
    </View>
  );
}

/**
 * Minimal geometric bookmark/place icon for the Places bottom tab.
 */
export function PlacesTabIcon({
  active = false,
  activeColor = '#18181b',
  inactiveColor = '#64748b',
}: {
  active?: boolean;
  activeColor?: string;
  inactiveColor?: string;
}) {
  const color = active ? activeColor : inactiveColor;
  return (
    <View style={styles.tabIconWrap}>
      <View style={[styles.placeOuter, { borderColor: color }]}>
        <View style={[styles.placeDot, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

/**
 * Minimal geometric route/trail icon for the Trails bottom tab.
 */
export function TrailsTabIcon({
  active = false,
  activeColor = '#18181b',
  inactiveColor = '#64748b',
}: {
  active?: boolean;
  activeColor?: string;
  inactiveColor?: string;
}) {
  const color = active ? activeColor : inactiveColor;
  return (
    <View style={styles.tabIconWrap}>
      <View style={[styles.trailDotA, { backgroundColor: color }]} />
      <View style={[styles.trailLine, { backgroundColor: color }]} />
      <View style={[styles.trailDotB, { borderColor: color }]} />
    </View>
  );
}

/**
 * Minimal geometric speech bubble icon for the Chat bottom tab.
 */
export function ChatTabIcon({
  active = false,
  activeColor = '#18181b',
  inactiveColor = '#64748b',
}: {
  active?: boolean;
  activeColor?: string;
  inactiveColor?: string;
}) {
  const color = active ? activeColor : inactiveColor;
  return (
    <View style={styles.tabIconWrap}>
      <View style={[styles.chatBox, { borderColor: color }]} />
      <View style={[styles.chatTail, { borderTopColor: color }]} />
    </View>
  );
}

/**
 * Minimal geometric four-corner frame icon for explicit Fit All / frame members button.
 */
export function FitAllIcon({ tintColor = '#18181b' }: { tintColor?: string }) {
  return (
    <View style={styles.fitWrap}>
      <View style={[styles.fitCorner, styles.fitTL, { borderColor: tintColor }]} />
      <View style={[styles.fitCorner, styles.fitTR, { borderColor: tintColor }]} />
      <View style={[styles.fitCorner, styles.fitBL, { borderColor: tintColor }]} />
      <View style={[styles.fitCorner, styles.fitBR, { borderColor: tintColor }]} />
      <View style={[styles.fitDot, { backgroundColor: tintColor }]} />
    </View>
  );
}

/**
 * Minimal geometric horizontal sliders icon for progressive-disclosure Map Options.
 */
export function MapOptionsIcon({
  tintColor = '#18181b',
  knobFill = '#ffffff',
}: {
  tintColor?: string;
  knobFill?: string;
}) {
  return (
    <View style={styles.optionsWrap}>
      <View style={styles.optionsRow}>
        <View style={[styles.optionsBar, { backgroundColor: tintColor }]} />
        <View
          style={[
            styles.optionsKnob,
            styles.optionsKnobLeft,
            { borderColor: tintColor, backgroundColor: knobFill },
          ]}
        />
      </View>
      <View style={styles.optionsRow}>
        <View style={[styles.optionsBar, { backgroundColor: tintColor }]} />
        <View
          style={[
            styles.optionsKnob,
            styles.optionsKnobRight,
            { borderColor: tintColor, backgroundColor: knobFill },
          ]}
        />
      </View>
      <View style={styles.optionsRow}>
        <View style={[styles.optionsBar, { backgroundColor: tintColor }]} />
        <View
          style={[
            styles.optionsKnob,
            styles.optionsKnobMid,
            { borderColor: tintColor, backgroundColor: knobFill },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  compassWrap: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compassNorthTip: {
    width: 0,
    height: 0,
    borderLeftWidth: 4.5,
    borderRightWidth: 4.5,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#ef4444',
  },
  compassSouthTip: {
    width: 0,
    height: 0,
    borderLeftWidth: 4.5,
    borderRightWidth: 4.5,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#71717a',
  },
  compassPivot: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 999,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#18181b',
  },
  pinWrap: {
    width: 22,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinHead: {
    width: 15,
    height: 15,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinInnerHole: {
    width: 5.5,
    height: 5.5,
    borderRadius: 999,
    backgroundColor: '#ffffff',
  },
  pinPoint: {
    marginTop: -2,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  tabIconWrap: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeOuter: {
    width: 13,
    height: 13,
    borderRadius: 999,
    borderWidth: 1.75,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeDot: {
    width: 4,
    height: 4,
    borderRadius: 999,
  },
  trailDotA: {
    position: 'absolute',
    left: 2,
    bottom: 2,
    width: 4.5,
    height: 4.5,
    borderRadius: 999,
  },
  trailLine: {
    width: 9,
    height: 1.75,
    borderRadius: 999,
    transform: [{ rotate: '-35deg' }],
  },
  trailDotB: {
    position: 'absolute',
    right: 2,
    top: 2,
    width: 5,
    height: 5,
    borderRadius: 999,
    borderWidth: 1.75,
  },
  chatBox: {
    width: 13,
    height: 10,
    borderRadius: 3.5,
    borderWidth: 1.75,
  },
  chatTail: {
    alignSelf: 'flex-start',
    marginLeft: 3,
    width: 0,
    height: 0,
    borderRightWidth: 4,
    borderTopWidth: 3.5,
    borderRightColor: 'transparent',
  },
  fitWrap: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fitCorner: {
    position: 'absolute',
    width: 6,
    height: 6,
  },
  fitTL: {
    top: 1,
    left: 1,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: 2,
  },
  fitTR: {
    top: 1,
    right: 1,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderTopRightRadius: 2,
  },
  fitBL: {
    bottom: 1,
    left: 1,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderBottomLeftRadius: 2,
  },
  fitBR: {
    bottom: 1,
    right: 1,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomRightRadius: 2,
  },
  fitDot: {
    width: 4,
    height: 4,
    borderRadius: 999,
  },
  optionsWrap: {
    width: 20,
    height: 18,
    justifyContent: 'space-between',
    paddingVertical: 1,
  },
  optionsRow: {
    height: 4,
    justifyContent: 'center',
  },
  optionsBar: {
    height: 1.75,
    borderRadius: 999,
    width: '100%',
  },
  optionsKnob: {
    position: 'absolute',
    width: 5.5,
    height: 5.5,
    borderRadius: 999,
    borderWidth: 1.75,
  },
  optionsKnobLeft: {
    left: 2,
  },
  optionsKnobRight: {
    right: 2,
  },
  optionsKnobMid: {
    left: 7,
  },
});
