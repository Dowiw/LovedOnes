import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  useColorScheme,
  View,
} from 'react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import type { QrInvitePayload } from '@loved-ones/shared';
import { parseInviteInput, withMinDelay } from '@loved-ones/shared';
import { formatUserError } from '../services/errorFormatter';
import {
  formatServerHostLabel,
  getDefaultServerUrl,
  getOnboardingPalette,
  validateAuthForm,
} from '../services/onboardingTheme';
import { useSafeAreaInsets } from '../services/safeArea';
import {
  MobileStoredConfig,
  parseAndBindQrInvite,
  saveStoredConfig,
} from '../services/secureConfig';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type OnboardingStep = 'welcome' | 'invite_ready' | 'manual_invite' | 'auth';

export interface QrOnboardingScreenProps {
  onAuthenticated: (config: MobileStoredConfig) => void;
  initialServerUrl?: string | null;
  pendingInviteUrl?: string | null;
  onConsumePendingInvite?: () => void;
}

export function QrOnboardingScreen({
  onAuthenticated,
  initialServerUrl = null,
  pendingInviteUrl = null,
  onConsumePendingInvite,
}: QrOnboardingScreenProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const palette = getOnboardingPalette(colorScheme);

  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [scanning, setScanning] = useState(false);

  const [invite, setInvite] = useState<QrInvitePayload | null>(null);
  const [serverUrl, setServerUrl] = useState<string>(
    initialServerUrl?.trim() || getDefaultServerUrl(Platform.OS),
  );
  const [serverEditorOpen, setServerEditorOpen] = useState(false);

  const [manualInput, setManualInput] = useState('');
  const [manualNeedsServer, setManualNeedsServer] = useState(false);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotStep, setForgotStep] = useState<'request' | 'reset'>('request');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const emailRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const passwordRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const forgotNewPassRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const forgotConfirmPassRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);

  const heroFade = useRef(new Animated.Value(0)).current;
  const heroSlide = useRef(new Animated.Value(16)).current;
  const ringPulse = useRef(new Animated.Value(0)).current;
  const screenFade = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotion(enabled);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (initialServerUrl?.trim() && !invite) {
      setServerUrl(initialServerUrl.trim());
    }
  }, [initialServerUrl, invite]);

  useEffect(() => {
    if (reduceMotion) {
      heroFade.setValue(1);
      heroSlide.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.timing(heroFade, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(heroSlide, {
        toValue: 0,
        duration: 460,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [heroFade, heroSlide, reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      ringPulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, {
          toValue: 1,
          duration: 2400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(ringPulse, {
          toValue: 0,
          duration: 2400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [ringPulse, reduceMotion]);

  useEffect(() => {
    if (!pendingInviteUrl) return;
    let cancelled = false;
    void parseAndBindQrInvite(pendingInviteUrl)
      .then((bound) => {
        if (cancelled) return;
        setInvite(bound);
        setServerUrl(bound.serverUrl);
        setScanning(false);
        setForgotMode(false);
        setError(null);
        setNotice(null);
        transitionTo('invite_ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          formatUserError(err, 'Could not open that invite link. Try scanning the QR code instead.'),
        );
      })
      .finally(() => {
        onConsumePendingInvite?.();
      });
    return () => {
      cancelled = true;
    };
  }, [pendingInviteUrl]);

  function transitionTo(nextStep: OnboardingStep) {
    if (!reduceMotion) {
      screenFade.setValue(0.86);
      Animated.timing(screenFade, {
        toValue: 1,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    setStep(nextStep);
  }

  function toggleServerEditor() {
    if (!reduceMotion) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
    setServerEditorOpen((prev) => !prev);
  }

  async function openQrScanner() {
    setError(null);
    setNotice(null);
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setError('Camera access is needed to scan your family invite QR code.');
        return;
      }
    }
    setScanning(true);
  }

  async function handleQrScanned(result: BarcodeScanningResult) {
    if (!scanning) return;
    setScanning(false);
    setError(null);
    setNotice(null);
    try {
      const bound = await parseAndBindQrInvite(result.data);
      setInvite(bound);
      setServerUrl(bound.serverUrl);
      setServerEditorOpen(false);
      transitionTo('invite_ready');
    } catch (err) {
      setError(
        formatUserError(
          err,
          'That QR code does not look like a LovedOnes invite. Try scanning again or enter the code.',
        ),
      );
    }
  }

  async function handleBindManual() {
    setError(null);
    setNotice(null);
    const trimmed = manualInput.trim();
    if (!trimmed) {
      setError('Paste your invite link or enter the invite code first.');
      return;
    }

    setLoading(true);
    try {
      const bound = await withMinDelay(async () => {
        if (trimmed.startsWith('lovedones://') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('{')) {
          return parseAndBindQrInvite(trimmed);
        }

        const parsed = parseInviteInput(trimmed);
        const cleanServer = serverUrl.trim().replace(/\/$/, '');
        if (!cleanServer || !/^https?:\/\/.+/i.test(cleanServer)) {
          setManualNeedsServer(true);
          throw new Error('Enter your server address below so we know where to check this invite code.');
        }

        const built: QrInvitePayload = {
          v: 1,
          serverUrl: cleanServer,
          inviteToken: parsed.inviteToken,
          groupName: parsed.groupName ?? 'Invited Circle',
        };
        await saveStoredConfig({ serverUrl: cleanServer });
        return built;
      }, 450);

      setInvite(bound);
      setServerUrl(bound.serverUrl);
      setManualNeedsServer(false);
      setServerEditorOpen(false);
      transitionTo('invite_ready');
    } catch (err) {
      setError(
        formatUserError(
          err,
          'Invalid invite code or link format. Double-check what was shared with you.',
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitAuth() {
    setError(null);
    setNotice(null);
    const validationError = validateAuthForm({
      mode,
      serverUrl,
      email,
      username,
      password,
    });
    if (validationError) {
      if (!/^https?:\/\/.+/i.test(serverUrl.trim())) {
        setServerEditorOpen(true);
      }
      setError(validationError);
      return;
    }

    setLoading(true);
    const cleanServer = serverUrl.trim().replace(/\/$/, '');
    try {
      const nextConfig = await withMinDelay(async () => {
        const endpoint =
          mode === 'register'
            ? `${cleanServer}/api/auth/register`
            : `${cleanServer}/api/auth/login`;
        const body =
          mode === 'register'
            ? {
                email: email.trim(),
                username: username.trim(),
                password,
                ...(invite ? { inviteToken: invite.inviteToken } : {}),
              }
            : {
                email: email.trim(),
                password,
              };

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as {
          error?: string;
          accessToken?: string;
          refreshToken?: string;
          user?: MobileStoredConfig['user'];
          joinedGroup?: { groupId: string };
        };
        if (!res.ok || !data.accessToken || !data.user) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }

        let activeGroupId = data.joinedGroup?.groupId ?? null;
        if (mode === 'login' && invite) {
          const joinRes = await fetch(`${cleanServer}/api/auth/join`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${data.accessToken}`,
            },
            body: JSON.stringify({ inviteToken: invite.inviteToken }),
          });
          if (joinRes.ok) {
            const joined = (await joinRes.json()) as { groupId: string };
            activeGroupId = joined.groupId;
          }
        }

        const builtConfig: MobileStoredConfig = {
          serverUrl: cleanServer,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? null,
          user: data.user,
          activeGroupId,
        };
        await saveStoredConfig(builtConfig);
        return builtConfig;
      });
      onAuthenticated(nextConfig);
    } catch (err) {
      setError(
        formatUserError(
          err,
          'Could not connect. Check your email, password, and server address.',
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestReset() {
    setError(null);
    setNotice(null);
    const cleanEmail = forgotEmail.trim();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Enter the email address linked to your account.');
      return;
    }
    const cleanServer = serverUrl.trim().replace(/\/$/, '');
    if (!/^https?:\/\/.+/i.test(cleanServer)) {
      setServerEditorOpen(true);
      setError('Check your server address first.');
      return;
    }

    setLoading(true);
    try {
      const data = await withMinDelay(async () => {
        const res = await fetch(`${cleanServer}/api/auth/forgot-password/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: cleanEmail }),
        });
        const body = (await res.json()) as { error?: string; message?: string };
        if (!res.ok) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body;
      });
      setForgotStep('reset');
      setNotice(
        data.message ??
          'If that account has a verified backup email, a 6-digit reset code has been sent.',
      );
    } catch (err) {
      setError(formatUserError(err, 'Failed to request reset code.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmReset() {
    setError(null);
    setNotice(null);
    if (forgotCode.trim().length !== 6) {
      setError('Enter the 6-digit reset code.');
      return;
    }
    if (forgotNewPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (forgotNewPassword !== forgotConfirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    setLoading(true);
    const cleanServer = serverUrl.trim().replace(/\/$/, '');
    try {
      await withMinDelay(async () => {
        const res = await fetch(`${cleanServer}/api/auth/forgot-password/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: forgotEmail.trim(),
            code: forgotCode.trim(),
            newPassword: forgotNewPassword,
          }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
      });
      setEmail(forgotEmail.trim());
      setPassword('');
      setForgotCode('');
      setForgotNewPassword('');
      setForgotConfirmPassword('');
      setShowForgotPassword(false);
      setForgotMode(false);
      setForgotStep('request');
      setMode('login');
      setNotice('Password updated. Sign in with your new password.');
    } catch (err) {
      setError(formatUserError(err, 'Failed to reset password.'));
    } finally {
      setLoading(false);
    }
  }

  const ringOuterScale = ringPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.94, 1.08],
  });
  const ringOuterOpacity = ringPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.55, 0.2],
  });

  if (scanning) {
    return (
      <View style={styles.scannerWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(res) => void handleQrScanned(res)}
        />

        <View
          pointerEvents="none"
          style={[styles.scannerTopBanner, { paddingTop: Math.max(insets.top + 16, 48) }]}
        >
          <View style={styles.scannerPill}>
            <Text style={styles.scannerPillText}>Scan circle invite QR</Text>
          </View>
        </View>

        <View pointerEvents="none" style={styles.reticleContainer}>
          <View style={styles.reticleBox}>
            <View style={[styles.reticleCorner, styles.reticleTL]} />
            <View style={[styles.reticleCorner, styles.reticleTR]} />
            <View style={[styles.reticleCorner, styles.reticleBL]} />
            <View style={[styles.reticleCorner, styles.reticleBR]} />
          </View>
        </View>

        <View
          style={[
            styles.scannerTray,
            {
              backgroundColor: palette.surface,
              borderTopColor: palette.border,
              paddingBottom: Math.max(insets.bottom + 20, 32),
            },
          ]}
        >
          <Text style={[styles.scannerTitle, { color: palette.ink }]}>Point at an invite QR code</Text>
          <Text style={[styles.scannerHint, { color: palette.inkMuted }]}>
            Ask your family or group admin to open Dashboard → Invites.
          </Text>

          <View style={styles.scannerActionsRow}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Cancel QR scan"
              activeOpacity={0.78}
              style={[
                styles.secondaryBtn,
                styles.flexHalfBtn,
                { backgroundColor: palette.surfaceChip, borderColor: palette.border },
              ]}
              onPress={() => setScanning(false)}
            >
              <Text style={[styles.secondaryBtnText, { color: palette.ink }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Enter invite code manually"
              activeOpacity={0.78}
              style={[
                styles.primaryBtn,
                styles.flexHalfBtn,
                styles.noTopMargin,
                { backgroundColor: palette.ctaBg },
              ]}
              onPress={() => {
                setScanning(false);
                setError(null);
                transitionTo('manual_invite');
              }}
            >
              <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>Enter Code</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  const topPad = Math.max(insets.top + 16, 48);
  const bottomPad = Math.max(insets.bottom + 24, 34);
  const hostLabel = formatServerHostLabel(serverUrl);
  const rememberedHost = initialServerUrl ? formatServerHostLabel(initialServerUrl) : null;

  return (
    <KeyboardAvoidingView
      style={[styles.flexRoot, { backgroundColor: palette.canvas }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View
        pointerEvents="none"
        style={[styles.ambientOrbTop, { backgroundColor: palette.orbBg }]}
      />
      <View
        pointerEvents="none"
        style={[styles.ambientOrbBottom, { backgroundColor: palette.orbBg }]}
      />

      {step === 'welcome' && (
        <Animated.View
          style={[
            styles.welcomeContainer,
            {
              paddingTop: topPad,
              paddingBottom: bottomPad,
              opacity: heroFade,
              transform: [{ translateY: heroSlide }],
            },
          ]}
        >
          <View style={styles.welcomeTopBar}>
            <View
              style={[
                styles.brandPill,
                { backgroundColor: palette.surface, borderColor: palette.border },
              ]}
            >
              <View style={[styles.brandDot, { backgroundColor: palette.ink }]} />
              <Text style={[styles.brandPillText, { color: palette.ink }]}>LovedOnes</Text>
            </View>
          </View>

          <View style={styles.heroCenter}>
            <View style={styles.emblemStage}>
              <Animated.View
                style={[
                  styles.emblemOuterRing,
                  {
                    borderColor: palette.pulseRing,
                    transform: [{ scale: ringOuterScale }],
                    opacity: ringOuterOpacity,
                  },
                ]}
              />
              <View
                style={[
                  styles.emblemMidRing,
                  { borderColor: palette.borderStrong, backgroundColor: palette.surfaceMuted },
                ]}
              />
              <View style={[styles.emblemCore, { backgroundColor: palette.ctaBg }]}>
                <View style={[styles.emblemPinHead, { backgroundColor: palette.ctaText }]} />
                <View style={[styles.emblemPinStem, { backgroundColor: palette.ctaText }]} />
              </View>
            </View>

            <Text style={[styles.heroHeadline, { color: palette.ink }]}>
              Stay close to{'\n'}your people.
            </Text>
            <Text style={[styles.heroBody, { color: palette.inkMuted }]}>
              Private live locations on your own server — simple, calm, and shared only with the
              circle you trust.
            </Text>

            {error && (
              <View
                style={[
                  styles.feedbackBox,
                  styles.heroErrorBox,
                  { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                ]}
              >
                <Text style={[styles.errorText, { color: palette.errorText }]}>{error}</Text>
              </View>
            )}
          </View>

          <View style={styles.welcomeDock}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Join with QR Invite"
              activeOpacity={0.82}
              style={[styles.heroPrimaryBtn, { backgroundColor: palette.ctaBg }]}
              onPress={() => void openQrScanner()}
            >
              <Text style={[styles.heroPrimaryBtnText, { color: palette.ctaText }]}>
                Join with QR Invite
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="I already have an account"
              activeOpacity={0.78}
              style={[
                styles.heroSecondaryBtn,
                { backgroundColor: palette.secondaryBg, borderColor: palette.secondaryBorder },
              ]}
              onPress={() => {
                setError(null);
                setNotice(null);
                setForgotMode(false);
                setMode('login');
                transitionTo('auth');
              }}
            >
              <Text style={[styles.heroSecondaryBtnText, { color: palette.secondaryText }]}>
                I already have an account
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Enter invite code manually"
              hitSlop={10}
              style={styles.quietFootLink}
              onPress={() => {
                setError(null);
                setNotice(null);
                transitionTo('manual_invite');
              }}
            >
              <Text style={[styles.quietFootLinkText, { color: palette.inkMuted }]}>
                Have an invite link or code?{' '}
                <Text style={[styles.quietFootLinkEmph, { color: palette.ink }]}>
                  Enter manually
                </Text>
              </Text>
            </TouchableOpacity>

            {rememberedHost && (
              <Text style={[styles.rememberedCaption, { color: palette.inkMuted }]}>
                Last server: {rememberedHost}
              </Text>
            )}
          </View>
        </Animated.View>
      )}

      {step !== 'welcome' && (
        <ScrollView
          contentContainerStyle={[
            styles.sheetScroll,
            { paddingTop: topPad, paddingBottom: bottomPad },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View style={{ opacity: screenFade, gap: 16 }}>
            <View style={styles.navBar}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Go back"
                hitSlop={10}
                style={[
                  styles.backChip,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
                onPress={() => {
                  setError(null);
                  setNotice(null);
                  if (forgotMode) {
                    setForgotMode(false);
                    setForgotStep('request');
                    return;
                  }
                  if (step === 'auth' && invite) {
                    transitionTo('invite_ready');
                    return;
                  }
                  transitionTo('welcome');
                }}
              >
                <Text style={[styles.backChipText, { color: palette.ink }]}>‹ Back</Text>
              </TouchableOpacity>

              {step === 'auth' && (
                invite ? (
                  <View
                    style={[
                      styles.contextPill,
                      {
                        backgroundColor: palette.badgeSuccessBg,
                        borderColor: palette.badgeSuccessBorder,
                      },
                    ]}
                  >
                    <View
                      style={[styles.contextDot, { backgroundColor: palette.badgeSuccessDot }]}
                    />
                    <Text
                      numberOfLines={1}
                      style={[styles.contextPillText, { color: palette.badgeSuccessText }]}
                    >
                      Joining {invite.groupName}
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Change server address"
                    hitSlop={8}
                    style={[
                      styles.serverChip,
                      { backgroundColor: palette.surface, borderColor: palette.border },
                    ]}
                    onPress={toggleServerEditor}
                  >
                    <Text
                      numberOfLines={1}
                      style={[styles.serverChipText, { color: palette.inkSubtle }]}
                    >
                      {hostLabel}
                    </Text>
                    <Text style={[styles.serverChipAction, { color: palette.ink }]}>
                      {serverEditorOpen ? 'Done' : 'Change'}
                    </Text>
                  </TouchableOpacity>
                )
              )}
            </View>

            {step === 'invite_ready' && invite && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <View
                  style={[
                    styles.verifiedPill,
                    {
                      backgroundColor: palette.badgeSuccessBg,
                      borderColor: palette.badgeSuccessBorder,
                    },
                  ]}
                >
                  <View
                    style={[styles.contextDot, { backgroundColor: palette.badgeSuccessDot }]}
                  />
                  <Text style={[styles.verifiedPillText, { color: palette.badgeSuccessText }]}>
                    INVITE VERIFIED
                  </Text>
                </View>

                <Text style={[styles.sheetTitle, { color: palette.ink }]}>
                  You're invited to{'\n'}
                  {invite.groupName}
                </Text>
                <Text style={[styles.sheetSubtitle, { color: palette.inkMuted }]}>
                  Hosted privately on{' '}
                  <Text style={{ color: palette.ink, fontWeight: '600' }}>
                    {formatServerHostLabel(invite.serverUrl)}
                  </Text>
                  . Choose how you want to step in:
                </Text>

                <View style={styles.stackBtns}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="I'm new here, create an account"
                    activeOpacity={0.82}
                    style={[styles.primaryBtn, { backgroundColor: palette.ctaBg }]}
                    onPress={() => {
                      setError(null);
                      setNotice(null);
                      setForgotMode(false);
                      setMode('register');
                      transitionTo('auth');
                    }}
                  >
                    <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                      I'm new here — Create Account
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Sign in to join with an existing account"
                    activeOpacity={0.78}
                    style={[
                      styles.secondaryBtn,
                      { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                    ]}
                    onPress={() => {
                      setError(null);
                      setNotice(null);
                      setForgotMode(false);
                      setMode('login');
                      transitionTo('auth');
                    }}
                  >
                    <Text style={[styles.secondaryBtnText, { color: palette.ink }]}>
                      Sign in to join
                    </Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Use a different invite"
                  hitSlop={10}
                  style={styles.centerLinkBtn}
                  onPress={() => {
                    setInvite(null);
                    setError(null);
                    transitionTo('welcome');
                  }}
                >
                  <Text style={[styles.centerLinkText, { color: palette.inkMuted }]}>
                    Use a different invite
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {step === 'manual_invite' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.sheetTitle, { color: palette.ink }]}>
                  Enter invite link or code
                </Text>
                <Text style={[styles.sheetSubtitle, { color: palette.inkMuted }]}>
                  Paste the invite link shared by your group admin, or type the invite code.
                </Text>

                <View style={styles.fieldGroup}>
                  <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                    Invite Link or Code
                  </Text>
                  <TextInput
                    accessibilityLabel="Invite link or code"
                    style={[
                      styles.input,
                      styles.multilineInput,
                      {
                        backgroundColor: palette.surfaceMuted,
                        borderColor: palette.border,
                        color: palette.ink,
                      },
                    ]}
                    value={manualInput}
                    onChangeText={setManualInput}
                    placeholder="https://.../join?token=inv_... or inv_..."
                    placeholderTextColor={palette.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                  />
                </View>

                {manualNeedsServer && (
                  <View style={styles.fieldGroup}>
                    <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                      Server Address
                    </Text>
                    <TextInput
                      accessibilityLabel="Server address"
                      style={[
                        styles.input,
                        {
                          backgroundColor: palette.surfaceMuted,
                          borderColor: palette.border,
                          color: palette.ink,
                        },
                      ]}
                      value={serverUrl}
                      onChangeText={setServerUrl}
                      placeholder="https://track.example.com"
                      placeholderTextColor={palette.placeholder}
                      autoCapitalize="none"
                      keyboardType="url"
                    />
                  </View>
                )}

                {error && (
                  <View
                    style={[
                      styles.feedbackBox,
                      { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                    ]}
                  >
                    <Text style={[styles.errorText, { color: palette.errorText }]}>{error}</Text>
                  </View>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Continue with invite"
                  activeOpacity={0.82}
                  disabled={loading}
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                  ]}
                  onPress={() => void handleBindManual()}
                >
                  {loading ? (
                    <View style={styles.btnLoadingRow}>
                      <ActivityIndicator color={palette.ctaText} size="small" />
                      <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                        Checking invite...
                      </Text>
                    </View>
                  ) : (
                    <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                      Continue
                    </Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Scan QR code instead"
                  hitSlop={10}
                  style={styles.centerLinkBtn}
                  onPress={() => void openQrScanner()}
                >
                  <Text style={[styles.centerLinkText, { color: palette.inkMuted }]}>
                    Prefer camera? <Text style={{ color: palette.ink, fontWeight: '600' }}>Scan QR instead</Text>
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {step === 'auth' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                {serverEditorOpen && !invite && (
                  <View
                    style={[
                      styles.serverDrawer,
                      { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                    ]}
                  >
                    <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                      Self-Hosted Server Address
                    </Text>
                    <TextInput
                      accessibilityLabel="Server Base URL"
                      style={[
                        styles.input,
                        {
                          backgroundColor: palette.surface,
                          borderColor: palette.borderStrong,
                          color: palette.ink,
                        },
                      ]}
                      value={serverUrl}
                      onChangeText={setServerUrl}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      placeholder="https://track.example.com"
                      placeholderTextColor={palette.placeholder}
                    />
                    <Text style={[styles.helperHint, { color: palette.inkMuted }]}>
                      Provided by whoever hosts your LovedOnes server.
                    </Text>
                    <View style={styles.quickPresetRow}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={[
                          styles.presetChip,
                          { backgroundColor: palette.surface, borderColor: palette.border },
                        ]}
                        onPress={() => setServerUrl('http://localhost:8080')}
                      >
                        <Text style={[styles.presetChipText, { color: palette.inkSubtle }]}>
                          localhost:8080
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={[
                          styles.presetChip,
                          { backgroundColor: palette.surface, borderColor: palette.border },
                        ]}
                        onPress={() => setServerUrl('http://10.0.2.2:8080')}
                      >
                        <Text style={[styles.presetChipText, { color: palette.inkSubtle }]}>
                          Emulator (10.0.2.2)
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {forgotMode ? (
                  <>
                    <Text style={[styles.sheetTitle, { color: palette.ink }]}>
                      Reset your password
                    </Text>
                    <Text style={[styles.sheetSubtitle, { color: palette.inkMuted }]}>
                      {forgotStep === 'request'
                        ? 'Enter your email or verified backup email for a 6-digit recovery code.'
                        : 'Enter the 6-digit code and choose a new password.'}
                    </Text>

                    {forgotStep === 'request' ? (
                      <>
                        <View style={styles.fieldGroup}>
                          <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                            Account or Backup Email
                          </Text>
                          <TextInput
                            accessibilityLabel="Account or verified backup email"
                            style={[
                              styles.input,
                              {
                                backgroundColor: palette.surfaceMuted,
                                borderColor: palette.border,
                                color: palette.ink,
                              },
                            ]}
                            value={forgotEmail}
                            onChangeText={setForgotEmail}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="email"
                            textContentType="emailAddress"
                            keyboardType="email-address"
                            returnKeyType="done"
                            onSubmitEditing={() => void handleRequestReset()}
                            placeholder="you@example.com"
                            placeholderTextColor={palette.placeholder}
                          />
                        </View>

                        {error && (
                          <View
                            style={[
                              styles.feedbackBox,
                              { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                            ]}
                          >
                            <Text style={[styles.errorText, { color: palette.errorText }]}>
                              {error}
                            </Text>
                          </View>
                        )}

                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Send reset code"
                          activeOpacity={0.82}
                          disabled={loading}
                          style={[
                            styles.primaryBtn,
                            { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                          ]}
                          onPress={() => void handleRequestReset()}
                        >
                          {loading ? (
                            <View style={styles.btnLoadingRow}>
                              <ActivityIndicator color={palette.ctaText} size="small" />
                              <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                                Sending code...
                              </Text>
                            </View>
                          ) : (
                            <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                              Send Reset Code
                            </Text>
                          )}
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <View style={styles.fieldGroup}>
                          <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                            6-Digit Reset Code
                          </Text>
                          <TextInput
                            accessibilityLabel="6-digit reset code"
                            style={[
                              styles.input,
                              styles.codeInput,
                              {
                                backgroundColor: palette.surfaceMuted,
                                borderColor: palette.border,
                                color: palette.ink,
                              },
                            ]}
                            value={forgotCode}
                            onChangeText={(txt) => setForgotCode(txt.replace(/\D/g, '').slice(0, 6))}
                            keyboardType="number-pad"
                            maxLength={6}
                            returnKeyType="next"
                            onSubmitEditing={() => forgotNewPassRef.current?.focus()}
                            placeholder="123456"
                            placeholderTextColor={palette.placeholder}
                          />
                        </View>

                        <View style={styles.fieldGroup}>
                          <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                            New Password
                          </Text>
                          <View
                            style={[
                              styles.passwordWrap,
                              {
                                backgroundColor: palette.surfaceMuted,
                                borderColor: palette.border,
                              },
                            ]}
                          >
                            <TextInput
                              ref={forgotNewPassRef}
                              accessibilityLabel="New password"
                              style={[styles.passwordInput, { color: palette.ink }]}
                              value={forgotNewPassword}
                              onChangeText={setForgotNewPassword}
                              secureTextEntry={!showForgotPassword}
                              autoComplete="new-password"
                              textContentType="newPassword"
                              returnKeyType="next"
                              onSubmitEditing={() => forgotConfirmPassRef.current?.focus()}
                              placeholder="Minimum 8 characters"
                              placeholderTextColor={palette.placeholder}
                            />
                            <TouchableOpacity
                              accessibilityRole="button"
                              accessibilityLabel={showForgotPassword ? 'Hide password' : 'Show password'}
                              hitSlop={10}
                              style={styles.eyeToggleBtn}
                              onPress={() => setShowForgotPassword((v) => !v)}
                            >
                              <Text style={[styles.eyeToggleText, { color: palette.inkSubtle }]}>
                                {showForgotPassword ? 'Hide' : 'Show'}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>

                        <View style={styles.fieldGroup}>
                          <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                            Confirm New Password
                          </Text>
                          <TextInput
                            ref={forgotConfirmPassRef}
                            accessibilityLabel="Confirm new password"
                            style={[
                              styles.input,
                              {
                                backgroundColor: palette.surfaceMuted,
                                borderColor: palette.border,
                                color: palette.ink,
                              },
                            ]}
                            value={forgotConfirmPassword}
                            onChangeText={setForgotConfirmPassword}
                            secureTextEntry={!showForgotPassword}
                            returnKeyType="done"
                            onSubmitEditing={() => void handleConfirmReset()}
                            placeholder="Repeat new password"
                            placeholderTextColor={palette.placeholder}
                          />
                        </View>

                        {notice && (
                          <View
                            style={[
                              styles.feedbackBox,
                              { backgroundColor: palette.noticeBg, borderColor: palette.noticeBorder },
                            ]}
                          >
                            <Text style={[styles.noticeText, { color: palette.noticeText }]}>
                              {notice}
                            </Text>
                          </View>
                        )}
                        {error && (
                          <View
                            style={[
                              styles.feedbackBox,
                              { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                            ]}
                          >
                            <Text style={[styles.errorText, { color: palette.errorText }]}>
                              {error}
                            </Text>
                          </View>
                        )}

                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Reset password"
                          activeOpacity={0.82}
                          disabled={loading}
                          style={[
                            styles.primaryBtn,
                            { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                          ]}
                          onPress={() => void handleConfirmReset()}
                        >
                          {loading ? (
                            <View style={styles.btnLoadingRow}>
                              <ActivityIndicator color={palette.ctaText} size="small" />
                              <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                                Updating password...
                              </Text>
                            </View>
                          ) : (
                            <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                              Reset Password
                            </Text>
                          )}
                        </TouchableOpacity>
                      </>
                    )}

                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Back to sign in"
                      hitSlop={10}
                      style={styles.centerLinkBtn}
                      onPress={() => {
                        setForgotMode(false);
                        setForgotStep('request');
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      <Text style={[styles.centerLinkText, { color: palette.inkMuted }]}>
                        Back to Sign In
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <Text style={[styles.sheetTitle, { color: palette.ink }]}>
                      {mode === 'register'
                        ? invite
                          ? `Join ${invite.groupName}`
                          : 'Set up your profile'
                        : 'Welcome back'}
                    </Text>
                    <Text style={[styles.sheetSubtitle, { color: palette.inkMuted }]}>
                      {mode === 'register'
                        ? 'Create your account so your loved ones recognize you on the map.'
                        : invite
                          ? `Sign in with your existing account to join ${invite.groupName}.`
                          : 'Sign in to view your live circle and places.'}
                    </Text>

                    {mode === 'register' && (
                      <View style={styles.fieldGroup}>
                        <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                          Display Name
                        </Text>
                        <TextInput
                          accessibilityLabel="Display Name"
                          style={[
                            styles.input,
                            {
                              backgroundColor: palette.surfaceMuted,
                              borderColor: palette.border,
                              color: palette.ink,
                            },
                          ]}
                          value={username}
                          onChangeText={setUsername}
                          autoCapitalize="words"
                          autoComplete="name"
                          textContentType="name"
                          returnKeyType="next"
                          onSubmitEditing={() => emailRef.current?.focus()}
                          placeholder="How your circle knows you"
                          placeholderTextColor={palette.placeholder}
                        />
                      </View>
                    )}

                    <View style={styles.fieldGroup}>
                      <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>Email</Text>
                      <TextInput
                        ref={emailRef}
                        accessibilityLabel="Email"
                        style={[
                          styles.input,
                          {
                            backgroundColor: palette.surfaceMuted,
                            borderColor: palette.border,
                            color: palette.ink,
                          },
                        ]}
                        value={email}
                        onChangeText={setEmail}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="email"
                        textContentType="emailAddress"
                        keyboardType="email-address"
                        returnKeyType="next"
                        onSubmitEditing={() => passwordRef.current?.focus()}
                        placeholder="you@example.com"
                        placeholderTextColor={palette.placeholder}
                      />
                    </View>

                    <View style={styles.fieldGroup}>
                      <View style={styles.labelRow}>
                        <Text style={[styles.fieldLabel, { color: palette.inkSubtle }]}>
                          Password
                        </Text>
                        {mode === 'login' && (
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Forgot password"
                            hitSlop={10}
                            onPress={() => {
                              setForgotEmail(email.trim());
                              setForgotMode(true);
                              setForgotStep('request');
                              setError(null);
                              setNotice(null);
                            }}
                          >
                            <Text style={[styles.inlineLinkText, { color: palette.inkMuted }]}>
                              Forgot password?
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>

                      <View
                        style={[
                          styles.passwordWrap,
                          {
                            backgroundColor: palette.surfaceMuted,
                            borderColor: palette.border,
                          },
                        ]}
                      >
                        <TextInput
                          ref={passwordRef}
                          accessibilityLabel="Password"
                          style={[styles.passwordInput, { color: palette.ink }]}
                          value={password}
                          onChangeText={setPassword}
                          secureTextEntry={!showPassword}
                          autoCapitalize="none"
                          autoCorrect={false}
                          autoComplete={mode === 'register' ? 'new-password' : 'password'}
                          textContentType={mode === 'register' ? 'newPassword' : 'password'}
                          returnKeyType="done"
                          onSubmitEditing={() => void handleSubmitAuth()}
                          placeholder={mode === 'register' ? 'At least 8 characters' : '••••••••'}
                          placeholderTextColor={palette.placeholder}
                        />
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                          hitSlop={10}
                          style={styles.eyeToggleBtn}
                          onPress={() => setShowPassword((prev) => !prev)}
                        >
                          <Text style={[styles.eyeToggleText, { color: palette.inkSubtle }]}>
                            {showPassword ? 'Hide' : 'Show'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    {notice && (
                      <View
                        style={[
                          styles.feedbackBox,
                          { backgroundColor: palette.noticeBg, borderColor: palette.noticeBorder },
                        ]}
                      >
                        <Text style={[styles.noticeText, { color: palette.noticeText }]}>
                          {notice}
                        </Text>
                      </View>
                    )}

                    {error && (
                      <View
                        style={[
                          styles.feedbackBox,
                          { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                        ]}
                      >
                        <Text style={[styles.errorText, { color: palette.errorText }]}>
                          {error}
                        </Text>
                      </View>
                    )}

                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={
                        mode === 'register' ? 'Create Account' : 'Sign In'
                      }
                      activeOpacity={0.82}
                      disabled={loading}
                      style={[
                        styles.primaryBtn,
                        { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                      ]}
                      onPress={() => void handleSubmitAuth()}
                    >
                      {loading ? (
                        <View style={styles.btnLoadingRow}>
                          <ActivityIndicator color={palette.ctaText} size="small" />
                          <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                            {mode === 'register' ? 'Creating account...' : 'Signing in...'}
                          </Text>
                        </View>
                      ) : (
                        <Text style={[styles.primaryBtnText, { color: palette.ctaText }]}>
                          {mode === 'register'
                            ? invite
                              ? 'Create Account & Join'
                              : 'Create Account'
                            : invite
                              ? 'Sign In & Join'
                              : 'Sign In'}
                        </Text>
                      )}
                    </TouchableOpacity>

                    <View style={styles.authFooter}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={
                          mode === 'login'
                            ? 'Create a new account'
                            : 'Sign in with existing account'
                        }
                        hitSlop={10}
                        style={styles.centerLinkBtn}
                        onPress={() => {
                          setMode(mode === 'login' ? 'register' : 'login');
                          setError(null);
                          setNotice(null);
                        }}
                      >
                        <Text style={[styles.centerLinkText, { color: palette.inkMuted }]}>
                          {mode === 'login' ? (
                            <>
                              New to this server?{' '}
                              <Text style={{ color: palette.ink, fontWeight: '600' }}>
                                Create account
                              </Text>
                            </>
                          ) : (
                            <>
                              Already have an account?{' '}
                              <Text style={{ color: palette.ink, fontWeight: '600' }}>Sign in</Text>
                            </>
                          )}
                        </Text>
                      </TouchableOpacity>

                      {!invite && (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Scan an invite QR code"
                          hitSlop={10}
                          style={styles.centerLinkBtn}
                          onPress={() => void openQrScanner()}
                        >
                          <Text style={[styles.centerLinkText, { color: palette.inkMuted }]}>
                            Have an invite QR?{' '}
                            <Text style={{ color: palette.ink, fontWeight: '600' }}>Scan code</Text>
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </>
                )}
              </View>
            )}
          </Animated.View>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flexRoot: {
    flex: 1,
    overflow: 'hidden',
  },
  ambientOrbTop: {
    position: 'absolute',
    top: -110,
    left: -90,
    width: 300,
    height: 300,
    borderRadius: 999,
  },
  ambientOrbBottom: {
    position: 'absolute',
    bottom: -120,
    right: -100,
    width: 320,
    height: 320,
    borderRadius: 999,
  },
  welcomeContainer: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'space-between',
  },
  welcomeTopBar: {
    alignItems: 'flex-start',
  },
  brandPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  brandDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  brandPillText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  heroCenter: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  emblemStage: {
    width: 132,
    height: 132,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  emblemOuterRing: {
    position: 'absolute',
    width: 128,
    height: 128,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  emblemMidRing: {
    position: 'absolute',
    width: 88,
    height: 88,
    borderRadius: 999,
    borderWidth: 1,
  },
  emblemCore: {
    width: 52,
    height: 52,
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
    width: 14,
    height: 14,
    borderRadius: 999,
  },
  emblemPinStem: {
    width: 3,
    height: 7,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
    marginTop: -1,
  },
  heroHeadline: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    letterSpacing: -0.9,
    textAlign: 'center',
  },
  heroBody: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 310,
  },
  heroErrorBox: {
    marginTop: 18,
    width: '100%',
  },
  welcomeDock: {
    gap: 11,
  },
  heroPrimaryBtn: {
    minHeight: 54,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  heroPrimaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  heroSecondaryBtn: {
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  heroSecondaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  quietFootLink: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quietFootLinkText: {
    fontSize: 13,
  },
  quietFootLinkEmph: {
    fontWeight: '600',
  },
  rememberedCaption: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: -4,
    fontVariant: ['tabular-nums'],
  },
  sheetScroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  backChip: {
    minHeight: 40,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  contextPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: '68%',
  },
  contextDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  contextPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  serverChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: '68%',
  },
  serverChipText: {
    fontSize: 12,
    flexShrink: 1,
  },
  serverChipAction: {
    fontSize: 12,
    fontWeight: '700',
  },
  sheetCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 22,
    gap: 14,
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  verifiedPillText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
  },
  sheetTitle: {
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  sheetSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: -4,
  },
  stackBtns: {
    gap: 10,
    marginTop: 4,
  },
  serverDrawer: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  helperHint: {
    fontSize: 12,
    lineHeight: 17,
  },
  quickPresetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
  presetChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  presetChipText: {
    fontSize: 11,
    fontWeight: '600',
  },
  fieldGroup: {
    gap: 6,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  inlineLinkText: {
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  multilineInput: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  codeInput: {
    letterSpacing: 4,
    fontWeight: '700',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  passwordWrap: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 8,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 15,
  },
  eyeToggleBtn: {
    minHeight: 36,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  eyeToggleText: {
    fontSize: 12,
    fontWeight: '700',
  },
  primaryBtn: {
    minHeight: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    marginTop: 2,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  btnLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  feedbackBox: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  noticeText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
  authFooter: {
    gap: 2,
    marginTop: 2,
  },
  centerLinkBtn: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerLinkText: {
    fontSize: 13,
  },
  scannerWrap: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'space-between',
  },
  scannerTopBanner: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  scannerPill: {
    backgroundColor: 'rgba(24, 24, 27, 0.78)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  scannerPillText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  reticleContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticleBox: {
    width: 224,
    height: 224,
    position: 'relative',
  },
  reticleCorner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#ffffff',
  },
  reticleTL: {
    top: 0,
    left: 0,
    borderTopWidth: 3.5,
    borderLeftWidth: 3.5,
    borderTopLeftRadius: 16,
  },
  reticleTR: {
    top: 0,
    right: 0,
    borderTopWidth: 3.5,
    borderRightWidth: 3.5,
    borderTopRightRadius: 16,
  },
  reticleBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3.5,
    borderLeftWidth: 3.5,
    borderBottomLeftRadius: 16,
  },
  reticleBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3.5,
    borderRightWidth: 3.5,
    borderBottomRightRadius: 16,
  },
  scannerTray: {
    paddingHorizontal: 22,
    paddingTop: 22,
    borderTopWidth: 1,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    alignItems: 'center',
    gap: 8,
  },
  scannerTitle: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  scannerHint: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  scannerActionsRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginTop: 10,
  },
  flexHalfBtn: {
    flex: 1,
  },
  noTopMargin: {
    marginTop: 0,
  },
});
