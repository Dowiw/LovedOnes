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
export function LocationPinIcon({ active = false }: { active?: boolean }) {
  const fill = active ? '#059669' : '#18181b';
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pinHead, { backgroundColor: fill }]}>
        <View style={styles.pinInnerHole} />
      </View>
      <View style={[styles.pinPoint, { borderTopColor: fill }]} />
    </View>
  );
}

/**
 * Minimal geometric bookmark/place icon for the Places bottom tab.
 */
export function PlacesTabIcon({ active = false }: { active?: boolean }) {
  const color = active ? '#18181b' : '#64748b';
  return (
    <View style={styles.tabIconWrap}>
      <View style={[styles.placeOuter, { borderColor: color }]}>
        <View style={[styles.placeDot, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

/**
 * Minimal geometric speech bubble icon for the Chat bottom tab.
 */
export function ChatTabIcon({ active = false }: { active?: boolean }) {
  const color = active ? '#18181b' : '#64748b';
  return (
    <View style={styles.tabIconWrap}>
      <View style={[styles.chatBox, { borderColor: color }]} />
      <View style={[styles.chatTail, { borderTopColor: color }]} />
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
});
