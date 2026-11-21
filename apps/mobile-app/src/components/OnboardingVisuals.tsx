import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import type { OnboardingPalette } from '../services/onboardingTheme';

interface BackArrowButtonProps {
  palette: OnboardingPalette;
  onPress: () => void;
  accessibilityLabel?: string;
}

/**
 * Minimalist geometric arrow-only back button (no text label).
 */
export function BackArrowButton({
  palette,
  onPress,
  accessibilityLabel = 'Go back',
}: BackArrowButtonProps) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      activeOpacity={0.72}
      hitSlop={10}
      style={[
        styles.arrowBtn,
        { backgroundColor: palette.surface, borderColor: palette.border },
      ]}
      onPress={onPress}
    >
      <View style={styles.arrowGlyph}>
        <View style={[styles.arrowHead, { borderColor: palette.ink }]} />
        <View style={[styles.arrowShaft, { backgroundColor: palette.ink }]} />
      </View>
    </TouchableOpacity>
  );
}

interface PinEmblemProps {
  palette: OnboardingPalette;
  reduceMotion: boolean;
  active: boolean;
}

/**
 * Concentric pulsing brand pin emblem. Restarts cleanly every time `active` becomes true.
 */
export function PinEmblem({ palette, reduceMotion, active }: PinEmblemProps) {
  const pulseA = useRef(new Animated.Value(0)).current;
  const pulseB = useRef(new Animated.Value(0)).current;
  const pinFloat = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active || reduceMotion) {
      pulseA.stopAnimation();
      pulseB.stopAnimation();
      pinFloat.stopAnimation();
      pulseA.setValue(0);
      pulseB.setValue(0);
      pinFloat.setValue(0);
      return;
    }

    pulseA.setValue(0);
    pulseB.setValue(0);
    pinFloat.setValue(0);

    const loopA = Animated.loop(
      Animated.timing(pulseA, {
        toValue: 1,
        duration: 2400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    );

    const loopB = Animated.loop(
      Animated.sequence([
        Animated.delay(900),
        Animated.timing(pulseB, {
          toValue: 1,
          duration: 2400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    );

    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pinFloat, {
          toValue: -4,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pinFloat, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    loopA.start();
    loopB.start();
    floatLoop.start();

    return () => {
      loopA.stop();
      loopB.stop();
      floatLoop.stop();
    };
  }, [active, reduceMotion, pulseA, pulseB, pinFloat]);

  const scaleA = pulseA.interpolate({ inputRange: [0, 1], outputRange: [0.76, 1.24] });
  const opacityA = pulseA.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0.52, 0] });

  const scaleB = pulseB.interpolate({ inputRange: [0, 1], outputRange: [0.76, 1.24] });
  const opacityB = pulseB.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0.4, 0] });

  return (
    <View style={styles.emblemStage}>
      <Animated.View
        style={[
          styles.emblemPulseRing,
          {
            borderColor: palette.pulseRing,
            transform: [{ scale: scaleA }],
            opacity: opacityA,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.emblemPulseRing,
          {
            borderColor: palette.pulseRing,
            transform: [{ scale: scaleB }],
            opacity: opacityB,
          },
        ]}
      />
      <View
        style={[
          styles.emblemMidRing,
          { borderColor: palette.borderStrong, backgroundColor: palette.surfaceMuted },
        ]}
      />
      <Animated.View
        style={[
          styles.emblemCore,
          {
            backgroundColor: palette.ctaBg,
            transform: [{ translateY: pinFloat }],
          },
        ]}
      >
        <View style={[styles.emblemPinHead, { backgroundColor: palette.ctaText }]} />
        <View style={[styles.emblemPinStem, { backgroundColor: palette.ctaText }]} />
      </Animated.View>
    </View>
  );
}

interface HandshakeAnimationProps {
  palette: OnboardingPalette;
  reduceMotion: boolean;
  connected: boolean;
}

/**
 * Animated Phone -> Electric Dashed Data Line -> Internet Globe visual
 * showing the device sending its IP handshake to the server.
 */
export function HandshakeAnimation({
  palette,
  reduceMotion,
  connected,
}: HandshakeAnimationProps) {
  const spark1 = useRef(new Animated.Value(0)).current;
  const spark2 = useRef(new Animated.Value(0)).current;
  const spark3 = useRef(new Animated.Value(0)).current;
  const globeGlow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      spark1.setValue(0.5);
      spark2.setValue(0.5);
      spark3.setValue(0.5);
      globeGlow.setValue(connected ? 1 : 0.4);
      return;
    }

    spark1.setValue(0);
    spark2.setValue(0);
    spark3.setValue(0);

    const makeSparkLoop = (val: Animated.Value, delayMs: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delayMs),
          Animated.timing(val, {
            toValue: 1,
            duration: 1250,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      );

    const l1 = makeSparkLoop(spark1, 0);
    const l2 = makeSparkLoop(spark2, 420);
    const l3 = makeSparkLoop(spark3, 840);
    const lGlobe = Animated.loop(
      Animated.sequence([
        Animated.timing(globeGlow, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(globeGlow, {
          toValue: 0.25,
          duration: 900,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    l1.start();
    l2.start();
    l3.start();
    lGlobe.start();

    return () => {
      l1.stop();
      l2.stop();
      l3.stop();
      lGlobe.stop();
    };
  }, [reduceMotion, connected, spark1, spark2, spark3, globeGlow]);

  const accent = connected ? palette.badgeSuccessDot : palette.electricGlow;
  const makeSparkStyle = (val: Animated.Value) => ({
    transform: [
      {
        translateX: val.interpolate({
          inputRange: [0, 1],
          outputRange: [-6, 118],
        }),
      },
      {
        scale: val.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: [0.65, 1.2, 0.7],
        }),
      },
    ],
    opacity: val.interpolate({
      inputRange: [0, 0.12, 0.85, 1],
      outputRange: [0, 1, 1, 0],
    }),
  });

  const globeScale = globeGlow.interpolate({
    inputRange: [0.25, 1],
    outputRange: [0.96, 1.16],
  });

  return (
    <View style={styles.handshakeRow}>
      {/* Phone Icon */}
      <View
        style={[
          styles.nodeBadge,
          { backgroundColor: palette.surfaceMuted, borderColor: palette.borderStrong },
        ]}
      >
        <View style={[styles.phoneFrame, { borderColor: palette.ink }]}>
          <View style={[styles.phoneSpeaker, { backgroundColor: palette.inkMuted }]} />
          <View style={[styles.phoneScreenDot, { backgroundColor: accent }]} />
          <View style={[styles.phoneHomeBar, { backgroundColor: palette.ink }]} />
        </View>
      </View>

      {/* Dashed Electric Conduit */}
      <View style={styles.conduitWrap}>
        <View style={styles.dashTrack}>
          {[0, 1, 2, 3, 4, 5, 6].map((idx) => (
            <View
              key={idx}
              style={[
                styles.dashSegment,
                { backgroundColor: connected ? palette.badgeSuccessDot : palette.borderStrong },
              ]}
            />
          ))}
        </View>

        <Animated.View
          style={[
            styles.electricSpark,
            { backgroundColor: accent, shadowColor: accent },
            makeSparkStyle(spark1),
          ]}
        />
        <Animated.View
          style={[
            styles.electricSparkSmall,
            { backgroundColor: palette.ink, shadowColor: accent },
            makeSparkStyle(spark2),
          ]}
        />
        <Animated.View
          style={[
            styles.electricSpark,
            { backgroundColor: accent, shadowColor: accent },
            makeSparkStyle(spark3),
          ]}
        />
      </View>

      {/* Internet Globe Icon */}
      <View style={styles.globeStage}>
        <Animated.View
          style={[
            styles.globePulseAura,
            {
              borderColor: accent,
              opacity: globeGlow,
              transform: [{ scale: globeScale }],
            },
          ]}
        />
        <View
          style={[
            styles.nodeBadge,
            {
              backgroundColor: palette.surfaceMuted,
              borderColor: connected ? palette.badgeSuccessDot : palette.borderStrong,
            },
          ]}
        >
          <View style={[styles.globeOuter, { borderColor: palette.ink }]}>
            <View style={[styles.globeMeridian, { borderColor: palette.ink }]} />
            <View style={[styles.globeEquator, { backgroundColor: palette.ink }]} />
            <View style={[styles.globeLatTop, { backgroundColor: palette.inkMuted }]} />
            <View style={[styles.globeLatBottom, { backgroundColor: palette.inkMuted }]} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  arrowBtn: {
    width: 44,
    height: 44,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowGlyph: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowHead: {
    position: 'absolute',
    left: 2,
    width: 8,
    height: 8,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    transform: [{ rotate: '45deg' }],
  },
  arrowShaft: {
    width: 13,
    height: 2,
    borderRadius: 2,
    marginLeft: 2,
  },
  emblemStage: {
    width: 136,
    height: 136,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emblemPulseRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  emblemMidRing: {
    position: 'absolute',
    width: 86,
    height: 86,
    borderRadius: 999,
    borderWidth: 1,
  },
  emblemCore: {
    width: 54,
    height: 54,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  emblemPinHead: {
    width: 15,
    height: 15,
    borderRadius: 999,
  },
  emblemPinStem: {
    width: 3,
    height: 8,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    marginTop: -1,
  },
  handshakeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    gap: 10,
  },
  nodeBadge: {
    width: 60,
    height: 60,
    borderRadius: 18,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneFrame: {
    width: 24,
    height: 36,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  phoneSpeaker: {
    width: 8,
    height: 2,
    borderRadius: 2,
  },
  phoneScreenDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
  },
  phoneHomeBar: {
    width: 8,
    height: 2,
    borderRadius: 2,
  },
  conduitWrap: {
    width: 122,
    height: 28,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  dashTrack: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  dashSegment: {
    width: 10,
    height: 2.5,
    borderRadius: 999,
  },
  electricSpark: {
    position: 'absolute',
    left: 0,
    width: 14,
    height: 5,
    borderRadius: 999,
    shadowOpacity: 0.75,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  electricSparkSmall: {
    position: 'absolute',
    left: 0,
    width: 8,
    height: 4,
    borderRadius: 999,
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  globeStage: {
    width: 66,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  globePulseAura: {
    position: 'absolute',
    width: 66,
    height: 66,
    borderRadius: 22,
    borderWidth: 1.5,
  },
  globeOuter: {
    width: 30,
    height: 30,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  globeMeridian: {
    position: 'absolute',
    width: 14,
    height: 30,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  globeEquator: {
    position: 'absolute',
    width: 30,
    height: 1.8,
  },
  globeLatTop: {
    position: 'absolute',
    top: 7,
    width: 24,
    height: 1.2,
  },
  globeLatBottom: {
    position: 'absolute',
    bottom: 7,
    width: 24,
    height: 1.2,
  },
});
