import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Easing,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  Vibration,
  View,
} from 'react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import type {
  OnboardingHandshakeResponse,
  QrInvitePayload,
  RegistrationRequestItem,
} from '@loved-ones/shared';
import {
  DEFAULT_EXACT_HALO_COLOR,
  formatCountdownRemaining,
  isSafeAvatarUrl,
  parseInviteInput,
  withMinDelay,
} from '@loved-ones/shared';
import { ColorPickerSheet } from '../components/ColorPickerSheet';
import {
  BackArrowButton,
  HandshakeAnimation,
  PinEmblem,
} from '../components/OnboardingVisuals';
import { pickAndCropSquareAvatar } from '../services/avatarPicker';
import { formatUserError } from '../services/errorFormatter';
import { sendLocalNotification } from '../services/notifications';
import {
  formatServerHostLabel,
  getDefaultServerUrl,
  getGeometricFonts,
  getOnboardingPalette,
  ONBOARDING_COLOR_PRESETS,
  validateAuthForm,
} from '../services/onboardingTheme';
import { useSafeAreaInsets } from '../services/safeArea';
import {
  clearPendingRegistration,
  getPendingRegistration,
  getPingedServers,
  isPendingRecordActive,
  MobileStoredConfig,
  normalizeServerUrlKey,
  parseAndBindQrInvite,
  PendingRegistrationRecord,
  PingedServersMap,
  savePendingRegistration,
  saveStoredConfig,
} from '../services/secureConfig';

type OnboardingStep =
  | 'welcome'
  | 'first_time_choice'
  | 'join_group'
  | 'join_server'
  | 'connecting'
  | 'create_account'
  | 'waiting_admin'
  | 'existing_server'
  | 'existing_login'
  | 'forgot';

const LOCKED_SETUP_STEPS: ReadonlySet<OnboardingStep> = new Set([
  'connecting',
  'create_account',
]);

export interface QrOnboardingScreenProps {
  onAuthenticated: (config: MobileStoredConfig) => void;
  initialServerUrl?: string | null;
  pendingInviteUrl?: string | null;
  persistentToast?: string | null;
  onConsumePendingInvite?: () => void;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function toPendingRecord(
  req: RegistrationRequestItem,
  serverUrl: string,
): PendingRegistrationRecord {
  return {
    requestId: req.id,
    serverUrl: serverUrl.replace(/\/+$/, ''),
    email: req.email,
    username: req.username,
    avatarUrl: req.avatarUrl,
    haloColor: req.haloColor,
    groupName: req.groupName,
    requesterIp: req.requesterIp,
    status: req.status,
    createdAt: req.createdAt,
    expiresAt: req.expiresAt,
  };
}

export function QrOnboardingScreen({
  onAuthenticated,
  initialServerUrl = null,
  pendingInviteUrl = null,
  persistentToast = null,
  onConsumePendingInvite,
}: QrOnboardingScreenProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const palette = getOnboardingPalette(colorScheme);
  const fonts = getGeometricFonts(Platform.OS);

  const [permission, requestPermission] = useCameraPermissions();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [scanning, setScanning] = useState(false);

  const devDefaultServer = __DEV__ ? getDefaultServerUrl(Platform.OS) : '';
  const [serverUrl, setServerUrl] = useState<string>(
    initialServerUrl?.trim() || devDefaultServer,
  );
  const [hasKnownServer, setHasKnownServer] = useState<boolean>(
    Boolean(initialServerUrl?.trim() || devDefaultServer),
  );
  const [existingServerReturnToLogin, setExistingServerReturnToLogin] = useState(false);

  const [joinOrigin, setJoinOrigin] = useState<'group' | 'server' | 'existing_fallback'>('group');
  const [invite, setInvite] = useState<QrInvitePayload | null>(null);
  const [manualInput, setManualInput] = useState('');
  const [manualNeedsServer, setManualNeedsServer] = useState(false);

  const [handshakeStage, setHandshakeStage] = useState<string>('Connecting to server...');
  const [handshakeConnected, setHandshakeConnected] = useState(false);
  const [handshakeIp, setHandshakeIp] = useState<string | null>(null);
  const [handshakeError, setHandshakeError] = useState<string | null>(null);

  const [pendingReg, setPendingReg] = useState<PendingRegistrationRecord | null>(null);
  const [pingedServers, setPingedServers] = useState<PingedServersMap>({});
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [checkingStatus, setCheckingStatus] = useState(false);

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [showPhotoUrlInput, setShowPhotoUrlInput] = useState(false);
  const [haloColor, setHaloColor] = useState<string | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [requestBanner, setRequestBanner] = useState<{
    kind: 'approved' | 'expired' | 'denied';
    title: string;
    body: string;
  } | null>(null);

  const [loginNotFoundPrompt, setLoginNotFoundPrompt] = useState(false);

  const [forgotStep, setForgotStep] = useState<'request' | 'reset'>('request');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  const emailRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const passwordRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const forgotNewPassRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const forgotConfirmPassRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);

  const heroFade = useRef(new Animated.Value(0)).current;
  const heroSlide = useRef(new Animated.Value(18)).current;
  const screenFade = useRef(new Animated.Value(1)).current;
  const screenSlide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotion(enabled);
      })
      .catch(() => {});

    void Promise.all([getPendingRegistration(), getPingedServers()])
      .then(([savedPending, savedPings]) => {
        if (!active) return;
        setPingedServers(savedPings);
        if (savedPending) {
          if (savedPending.status !== 'PENDING' || isPendingRecordActive(savedPending)) {
            setPendingReg(savedPending);
          } else {
            setPendingReg({ ...savedPending, status: 'EXPIRED' });
          }
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (initialServerUrl?.trim() && !invite) {
      setServerUrl(initialServerUrl.trim());
      setHasKnownServer(true);
    }
  }, [initialServerUrl, invite]);

  // Fix animation bug: replay entrance cleanly every time we land back on the opening screen
  useEffect(() => {
    if (step !== 'welcome' || scanning) return;
    if (reduceMotion) {
      heroFade.setValue(1);
      heroSlide.setValue(0);
      return;
    }
    heroFade.setValue(0);
    heroSlide.setValue(18);
    const anim = Animated.parallel([
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
    ]);
    anim.start();
    return () => anim.stop();
  }, [step, scanning, reduceMotion, heroFade, heroSlide]);

  // Block Android hardware back button during locked setup steps
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (scanning) {
        setScanning(false);
        return true;
      }
      if (LOCKED_SETUP_STEPS.has(step)) {
        return true;
      }
      if (step === 'first_time_choice' || step === 'existing_login' || step === 'waiting_admin') {
        setError(null);
        setNotice(null);
        transitionTo('welcome');
        return true;
      }
      if (step === 'join_group' || step === 'join_server') {
        setError(null);
        setNotice(null);
        transitionTo('first_time_choice');
        return true;
      }
      if (step === 'existing_server') {
        setError(null);
        setNotice(null);
        transitionTo(existingServerReturnToLogin ? 'existing_login' : 'welcome');
        return true;
      }
      if (step === 'forgot') {
        setError(null);
        setNotice(null);
        setForgotStep('request');
        transitionTo('existing_login');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [step, scanning, existingServerReturnToLogin]);

  // Live 1-second timer for 24h countdown on waiting page or server-ping block notice
  useEffect(() => {
    const needsTicker =
      step === 'waiting_admin' ||
      isPendingRecordActive(pendingReg) ||
      Object.keys(pingedServers).length > 0;
    if (!needsTicker) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [step, pendingReg, pingedServers]);

  // Poll active pending request status across onboarding & on foreground resume
  // so APPROVED / EXPIRED events always notify the user immediately.
  useEffect(() => {
    if (!pendingReg || pendingReg.status !== 'PENDING') return;
    void refreshRequestStatus(pendingReg, true);
    const interval = setInterval(() => {
      void refreshRequestStatus(pendingReg, true);
    }, 10_000);
    const appSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void refreshRequestStatus(pendingReg, true);
      }
    });
    return () => {
      clearInterval(interval);
      appSub.remove();
    };
  }, [pendingReg?.requestId, pendingReg?.status]);

  // Incoming deep-link invite handling (lovedones:// or https://.../join?token=...)
  useEffect(() => {
    if (!pendingInviteUrl) return;
    let cancelled = false;
    void parseAndBindQrInvite(pendingInviteUrl)
      .then((bound) => {
        if (cancelled) return;
        setInvite(bound);
        setServerUrl(bound.serverUrl);
        setHasKnownServer(true);
        setJoinOrigin('group');
        setScanning(false);
        setError(null);
        setNotice(null);
        void beginServerHandshake(bound.serverUrl, bound.inviteToken, bound.groupName);
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
    if (!reduceMotion && nextStep !== 'welcome') {
      screenFade.setValue(0.75);
      screenSlide.setValue(10);
      Animated.parallel([
        Animated.timing(screenFade, {
          toValue: 1,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(screenSlide, {
          toValue: 0,
          duration: 260,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }
    setStep(nextStep);
  }

  async function beginServerHandshake(
    targetServerUrl: string,
    inviteToken?: string,
    fallbackGroupName?: string | null,
  ) {
    const cleanServer = targetServerUrl.trim().replace(/\/+$/, '');
    if (!cleanServer || !/^https?:\/\/.+/i.test(cleanServer)) {
      setError('Enter a valid server address starting with http:// or https://');
      return;
    }

    const serverKey = normalizeServerUrlKey(cleanServer);
    const localPing = pingedServers[serverKey];
    if (isPendingRecordActive(localPing, Date.now())) {
      setPendingReg(localPing);
      transitionTo('waiting_admin');
      return;
    }

    setServerUrl(cleanServer);
    setHasKnownServer(true);
    setError(null);
    setNotice(null);
    setHandshakeError(null);
    setHandshakeConnected(false);
    setHandshakeIp(null);
    setHandshakeStage(`Connecting to ${formatServerHostLabel(cleanServer)}...`);
    transitionTo('connecting');

    const phaseTimer1 = setTimeout(() => {
      setHandshakeStage('Sending device IP handshake...');
    }, 750);

    try {
      const response = await withMinDelay(async () => {
        const res = await fetch(`${cleanServer}/api/auth/onboarding/handshake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(inviteToken ? { inviteToken } : {}),
        });
        const body = (await res.json()) as Partial<OnboardingHandshakeResponse> & {
          error?: string;
        };
        if (!res.ok || !body.ok) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return body as OnboardingHandshakeResponse;
      }, 2150);

      clearTimeout(phaseTimer1);
      setHandshakeConnected(true);
      setHandshakeIp(response.requesterIp);
      setHandshakeStage('Connection verified');

      await saveStoredConfig({ serverUrl: cleanServer });

      if (response.alreadyPinged && response.activeRequest) {
        const record = toPendingRecord(response.activeRequest, cleanServer);
        const nextMap = await savePendingRegistration(record);
        setPendingReg(record);
        setPingedServers(nextMap);
        await withMinDelay(Promise.resolve(), 650);
        transitionTo('waiting_admin');
        return;
      }

      if (response.invite && inviteToken) {
        setInvite({
          v: 1,
          serverUrl: cleanServer,
          inviteToken,
          groupName: response.invite.groupName,
        });
      } else if (inviteToken && fallbackGroupName) {
        setInvite({
          v: 1,
          serverUrl: cleanServer,
          inviteToken,
          groupName: fallbackGroupName,
        });
      } else {
        setInvite(null);
      }

      await withMinDelay(Promise.resolve(), 650);
      transitionTo('create_account');
    } catch (err) {
      clearTimeout(phaseTimer1);
      setHandshakeConnected(false);
      setHandshakeError(
        formatUserError(
          err,
          'Could not connect to that server. Check the address and internet connection.',
        ),
      );
    }
  }

  async function openQrScanner() {
    setError(null);
    setNotice(null);
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setError('Camera permission is required to scan a group QR invite.');
        return;
      }
    }
    setScanning(true);
  }

  async function handleQrScanned(result: BarcodeScanningResult) {
    if (!scanning) return;
    setScanning(false);
    setError(null);
    try {
      const bound = await parseAndBindQrInvite(result.data);
      setInvite(bound);
      setServerUrl(bound.serverUrl);
      setHasKnownServer(true);
      await beginServerHandshake(bound.serverUrl, bound.inviteToken, bound.groupName);
    } catch (err) {
      setError(
        formatUserError(
          err,
          'That QR code does not look like a LovedOnes invite. Try again or paste the invite link.',
        ),
      );
    }
  }

  async function handleConnectGroupManual() {
    setError(null);
    const trimmed = manualInput.trim();
    if (!trimmed) {
      setError('Paste an invite link or code first, or scan the QR code above.');
      return;
    }

    try {
      if (
        trimmed.startsWith('lovedones://') ||
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('{')
      ) {
        const bound = await parseAndBindQrInvite(trimmed);
        setInvite(bound);
        setServerUrl(bound.serverUrl);
        setManualNeedsServer(false);
        await beginServerHandshake(bound.serverUrl, bound.inviteToken, bound.groupName);
        return;
      }

      const parsed = parseInviteInput(trimmed);
      const cleanServer = serverUrl.trim().replace(/\/+$/, '');
      if (!cleanServer || !/^https?:\/\/.+/i.test(cleanServer)) {
        setManualNeedsServer(true);
        setError('Enter your server address below so we know where to verify this invite code.');
        return;
      }
      await beginServerHandshake(
        cleanServer,
        parsed.inviteToken,
        parsed.groupName ?? 'Invited Group',
      );
    } catch (err) {
      setError(
        formatUserError(
          err,
          'Invalid invite link or code format. Double-check what was shared with you.',
        ),
      );
    }
  }

  async function handleSubmitAccountRequest() {
    setError(null);
    setNotice(null);
    const validationErr = validateAuthForm({
      mode: 'register',
      serverUrl,
      email,
      username,
      password,
    });
    if (validationErr) {
      setError(validationErr);
      return;
    }

    const trimmedAvatar = avatarUrl.trim();
    if (trimmedAvatar && !isSafeAvatarUrl(trimmedAvatar)) {
      setError('Profile photo must be a valid http(s) image link.');
      return;
    }

    const cleanServer = serverUrl.trim().replace(/\/+$/, '');
    setLoading(true);
    try {
      const result = await withMinDelay(async () => {
        const res = await fetch(`${cleanServer}/api/auth/registration-requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: username.trim(),
            email: email.trim(),
            password,
            avatarUrl: trimmedAvatar || null,
            haloColor: haloColor ?? null,
            ...(invite ? { inviteToken: invite.inviteToken } : {}),
          }),
        });
        const data = (await res.json()) as {
          request?: RegistrationRequestItem;
          error?: string;
          details?: { activeRequest?: RegistrationRequestItem };
        };
        if (res.status === 409 && data.details?.activeRequest) {
          return { request: data.details.activeRequest };
        }
        if (!res.ok || !data.request) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        return { request: data.request };
      }, 950);

      const record = toPendingRecord(result.request, cleanServer);
      const nextMap = await savePendingRegistration(record);
      setPendingReg(record);
      setPingedServers(nextMap);
      setLoginNotFoundPrompt(false);
      transitionTo('waiting_admin');
    } catch (err) {
      setError(
        formatUserError(
          err,
          'Could not submit your account request. Check your details and try again.',
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function refreshRequestStatus(
    target: PendingRegistrationRecord,
    silent = false,
  ) {
    if (!silent) {
      setCheckingStatus(true);
      setError(null);
    }
    try {
      const fetched = await (silent
        ? fetch(
            `${target.serverUrl}/api/auth/registration-requests/status?id=${encodeURIComponent(
              target.requestId,
            )}`,
          ).then((r) => r.json() as Promise<{ request?: RegistrationRequestItem | null }>)
        : withMinDelay(async () => {
            const res = await fetch(
              `${target.serverUrl}/api/auth/registration-requests/status?id=${encodeURIComponent(
                target.requestId,
              )}`,
            );
            const data = (await res.json()) as {
              request?: RegistrationRequestItem | null;
              error?: string;
            };
            if (!res.ok) {
              throw new Error(data.error ?? `HTTP ${res.status}`);
            }
            return data;
          }, 700));

      if (fetched.request) {
        const updated = toPendingRecord(fetched.request, target.serverUrl);
        const nextMap = await savePendingRegistration(updated);
        setPendingReg(updated);
        setPingedServers(nextMap);

        if (target.status === 'PENDING' && updated.status !== 'PENDING') {
          Vibration.vibrate(140);
          if (updated.status === 'APPROVED') {
            const title = 'Account Approved';
            const body = `Your profile on ${formatServerHostLabel(updated.serverUrl)} was approved! Sign in now.`;
            setRequestBanner({ kind: 'approved', title, body });
            void sendLocalNotification(title, body);
          } else if (updated.status === 'EXPIRED') {
            const title = 'Request Expired';
            const body = `Your 24h account request to ${formatServerHostLabel(updated.serverUrl)} expired.`;
            setRequestBanner({ kind: 'expired', title, body });
            void sendLocalNotification(title, body);
          } else if (updated.status === 'DENIED') {
            const title = 'Request Declined';
            const body = `The server admin declined your request on ${formatServerHostLabel(updated.serverUrl)}.`;
            setRequestBanner({ kind: 'denied', title, body });
            void sendLocalNotification(title, body);
          }
        }
      }
    } catch (err) {
      if (!silent) {
        setError(formatUserError(err, 'Unable to check status right now.'));
      }
    } finally {
      if (!silent) {
        setCheckingStatus(false);
      }
    }
  }

  async function handleExistingServerContinue() {
    setError(null);
    const cleanServer = serverUrl.trim().replace(/\/+$/, '');
    if (!cleanServer || !/^https?:\/\/.+/i.test(cleanServer)) {
      setError('Enter a valid server address (for example, https://track.example.com).');
      return;
    }
    setLoading(true);
    try {
      await withMinDelay(async () => {
        await saveStoredConfig({ serverUrl: cleanServer });
      }, 650);
      setServerUrl(cleanServer);
      setHasKnownServer(true);
      setLoginNotFoundPrompt(false);
      transitionTo('existing_login');
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitLogin() {
    setError(null);
    setNotice(null);
    setLoginNotFoundPrompt(false);

    const validationErr = validateAuthForm({
      mode: 'login',
      serverUrl,
      email,
      username: '',
      password,
    });
    if (validationErr) {
      setError(validationErr);
      return;
    }

    setLoading(true);
    const cleanServer = serverUrl.trim().replace(/\/+$/, '');
    try {
      const outcome = await withMinDelay(async () => {
        const res = await fetch(`${cleanServer}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim(),
            password,
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          accessToken?: string;
          refreshToken?: string;
          user?: MobileStoredConfig['user'];
        };
        if (res.status === 401) {
          return { invalidCredentials: true as const, message: data.error };
        }
        if (!res.ok || !data.accessToken || !data.user) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const builtConfig: MobileStoredConfig = {
          serverUrl: cleanServer,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? null,
          user: data.user,
          activeGroupId: null,
        };
        await saveStoredConfig(builtConfig);
        return { invalidCredentials: false as const, config: builtConfig };
      }, 850);

      if (outcome.invalidCredentials) {
        setError('That email or password did not match an account on this server.');
        setLoginNotFoundPrompt(true);
        return;
      }

      if (pendingReg && normalizeServerUrlKey(pendingReg.serverUrl) === normalizeServerUrlKey(cleanServer)) {
        const nextMap = await clearPendingRegistration(cleanServer);
        setPendingReg(null);
        setPingedServers(nextMap);
      }

      onAuthenticated(outcome.config);
    } catch (err) {
      setError(
        formatUserError(
          err,
          'Could not reach that server. Check the address and try again.',
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
    const cleanServer = serverUrl.trim().replace(/\/+$/, '');
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
      }, 750);
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
    const cleanServer = serverUrl.trim().replace(/\/+$/, '');
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
      }, 750);
      setEmail(forgotEmail.trim());
      setPassword('');
      setForgotCode('');
      setForgotNewPassword('');
      setForgotConfirmPassword('');
      setShowForgotPassword(false);
      setForgotStep('request');
      setNotice('Password updated. Sign in with your new password.');
      transitionTo('existing_login');
    } catch (err) {
      setError(formatUserError(err, 'Failed to reset password.'));
    } finally {
      setLoading(false);
    }
  }

  async function handlePickPhotoFromDisk() {
    setError(null);
    setPickingAvatar(true);
    try {
      const picked = await pickAndCropSquareAvatar();
      if (picked.status === 'ok') {
        setAvatarUrl(picked.dataUri);
        setShowPhotoUrlInput(false);
      } else if (picked.status === 'denied' || picked.status === 'error') {
        setError(picked.message);
      }
    } finally {
      setPickingAvatar(false);
    }
  }

  const topPad = Math.max(insets.top + 16, 48);
  const bottomPad = Math.max(insets.bottom + 24, 34);
  const hostLabel = formatServerHostLabel(serverUrl);
  const activePending = isPendingRecordActive(pendingReg, nowMs) ? pendingReg : null;
  const currentServerPing = serverUrl
    ? pingedServers[normalizeServerUrlKey(serverUrl)]
    : undefined;
  const isCurrentServerAlreadyPinged = isPendingRecordActive(currentServerPing, nowMs);

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
          style={[styles.scannerTopBanner, { paddingTop: topPad }]}
        >
          <View style={styles.scannerPill}>
            <Text style={[styles.scannerPillText, { fontFamily: fonts.heading }]}>
              Scan Group QR Invite
            </Text>
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
          <Text style={[styles.scannerTitle, { color: palette.ink, fontFamily: fonts.display }]}>
            Point at your invite QR
          </Text>
          <Text style={[styles.scannerHint, { color: palette.inkMuted, fontFamily: fonts.body }]}>
            Ask your group admin to open Dashboard → Invites.
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Close camera scanner"
            activeOpacity={0.78}
            style={[
              styles.secondaryBtn,
              styles.fullWidthBtn,
              { backgroundColor: palette.surfaceChip, borderColor: palette.border },
            ]}
            onPress={() => setScanning(false)}
          >
            <Text style={[styles.secondaryBtnText, { color: palette.ink, fontFamily: fonts.heading }]}>
              Enter Code Manually
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const previewHalo = haloColor ?? DEFAULT_EXACT_HALO_COLOR;
  const safeAvatarPreview = isSafeAvatarUrl(avatarUrl.trim());

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
          {persistentToast ? (
            <View
              accessibilityLiveRegion="assertive"
              style={[
                styles.persistentToastCard,
                { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
              ]}
            >
              <Text
                style={[styles.persistentToastTitle, { color: palette.errorText, fontFamily: fonts.display }]}
              >
                Account Removed from Server
              </Text>
              <Text
                style={[styles.persistentToastBody, { color: palette.errorText, fontFamily: fonts.body }]}
              >
                {persistentToast}
              </Text>
            </View>
          ) : requestBanner ? (
            <TouchableOpacity
              activeOpacity={0.85}
              style={[
                styles.persistentToastCard,
                requestBanner.kind === 'approved'
                  ? { backgroundColor: palette.badgeSuccessBg, borderColor: palette.badgeSuccessBorder }
                  : requestBanner.kind === 'expired'
                    ? { backgroundColor: palette.badgeWarnBg, borderColor: palette.badgeWarnBorder }
                    : { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
              ]}
              onPress={() => {
                if (requestBanner.kind === 'approved' && pendingReg) {
                  setServerUrl(pendingReg.serverUrl);
                  setHasKnownServer(true);
                  setEmail(pendingReg.email);
                  transitionTo('waiting_admin');
                }
              }}
            >
              <Text
                style={[
                  styles.persistentToastTitle,
                  {
                    color:
                      requestBanner.kind === 'approved'
                        ? palette.badgeSuccessText
                        : requestBanner.kind === 'expired'
                          ? palette.badgeWarnText
                          : palette.errorText,
                    fontFamily: fonts.display,
                  },
                ]}
              >
                {requestBanner.title}
              </Text>
              <Text
                style={[
                  styles.persistentToastBody,
                  {
                    color:
                      requestBanner.kind === 'approved'
                        ? palette.badgeSuccessText
                        : requestBanner.kind === 'expired'
                          ? palette.badgeWarnText
                          : palette.errorText,
                    fontFamily: fonts.body,
                  },
                ]}
              >
                {requestBanner.body}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.welcomeSpacer} />
          )}

          <View style={styles.heroCenter}>
            <Text
              style={[
                styles.brandCenterTitle,
                { color: palette.ink, fontFamily: fonts.display },
              ]}
            >
              LovedOnes
            </Text>

            <PinEmblem
              palette={palette}
              reduceMotion={reduceMotion}
              active={step === 'welcome' && !scanning}
            />

            <Text
              style={[
                styles.heroHeadline,
                { color: palette.ink, fontFamily: fonts.display },
              ]}
            >
              Stay close to{'\n'}your people.
            </Text>
            <Text
              style={[
                styles.heroBody,
                { color: palette.inkMuted, fontFamily: fonts.body },
              ]}
            >
              Private live locations on your own server — calm, direct, and shared only with your
              circle.
            </Text>

            {error && (
              <View
                style={[
                  styles.feedbackBox,
                  styles.heroErrorBox,
                  { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                ]}
              >
                <Text style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}>
                  {error}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.welcomeDock}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="First Time?"
              activeOpacity={0.82}
              style={[styles.heroPrimaryBtn, { backgroundColor: palette.ctaBg }]}
              onPress={() => {
                setError(null);
                setNotice(null);
                if (activePending) {
                  transitionTo('waiting_admin');
                  return;
                }
                transitionTo('first_time_choice');
              }}
            >
              <Text
                style={[
                  styles.heroPrimaryBtnText,
                  { color: palette.ctaText, fontFamily: fonts.display },
                ]}
              >
                First Time?
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
                setLoginNotFoundPrompt(false);
                if (hasKnownServer && /^https?:\/\/.+/i.test(serverUrl.trim())) {
                  transitionTo('existing_login');
                } else {
                  setExistingServerReturnToLogin(false);
                  transitionTo('existing_server');
                }
              }}
            >
              <Text
                style={[
                  styles.heroSecondaryBtnText,
                  { color: palette.secondaryText, fontFamily: fonts.heading },
                ]}
              >
                I already have an account
              </Text>
            </TouchableOpacity>
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
          <Animated.View
            style={{
              opacity: screenFade,
              transform: [{ translateY: screenSlide }],
              gap: 16,
            }}
          >
            {/* Top Bar — Arrow-only back button ONLY on steps that allow going back */}
            {!LOCKED_SETUP_STEPS.has(step) && step !== 'waiting_admin' && (
              <View style={styles.navBar}>
                <BackArrowButton
                  palette={palette}
                  onPress={() => {
                    setError(null);
                    setNotice(null);
                    setLoginNotFoundPrompt(false);
                    if (step === 'forgot') {
                      setForgotStep('request');
                      transitionTo('existing_login');
                      return;
                    }
                    if (step === 'join_group' || step === 'join_server') {
                      transitionTo('first_time_choice');
                      return;
                    }
                    if (step === 'existing_server' && existingServerReturnToLogin) {
                      transitionTo('existing_login');
                      return;
                    }
                    transitionTo('welcome');
                  }}
                />

                {step === 'existing_login' && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Switch server address"
                    hitSlop={8}
                    style={[
                      styles.serverChip,
                      { backgroundColor: palette.surface, borderColor: palette.border },
                    ]}
                    onPress={() => {
                      setError(null);
                      setNotice(null);
                      setLoginNotFoundPrompt(false);
                      setExistingServerReturnToLogin(true);
                      transitionTo('existing_server');
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.serverChipText,
                        { color: palette.inkSubtle, fontFamily: fonts.body },
                      ]}
                    >
                      {hostLabel}
                    </Text>
                    <Text
                      style={[
                        styles.serverChipAction,
                        { color: palette.ink, fontFamily: fonts.display },
                      ]}
                    >
                      Switch
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Layer 2: First Time -> Join a Group vs Join a Server */}
            {step === 'first_time_choice' && (
              <View style={styles.choiceStage}>
                <Text
                  style={[
                    styles.pageTitle,
                    { color: palette.ink, fontFamily: fonts.display },
                  ]}
                >
                  How would you{'\n'}like to join?
                </Text>
                <Text
                  style={[
                    styles.pageSubtitle,
                    { color: palette.inkMuted, fontFamily: fonts.body },
                  ]}
                >
                  Pick how you were invited. Once you continue into setup, you'll connect and send
                  your profile straight to the server admin.
                </Text>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Join a Group with QR code or invite link"
                  activeOpacity={0.8}
                  style={[
                    styles.choiceCard,
                    { backgroundColor: palette.surface, borderColor: palette.border },
                  ]}
                  onPress={() => {
                    setError(null);
                    setNotice(null);
                    setJoinOrigin('group');
                    setInvite(null);
                    setManualInput('');
                    setManualNeedsServer(false);
                    transitionTo('join_group');
                  }}
                >
                  <View style={styles.choiceCardTextWrap}>
                    <Text
                      style={[
                        styles.choiceCardTitle,
                        { color: palette.ink, fontFamily: fonts.display },
                      ]}
                    >
                      Join a Group
                    </Text>
                    <Text
                      style={[
                        styles.choiceCardSub,
                        { color: palette.inkMuted, fontFamily: fonts.body },
                      ]}
                    >
                      Scan a QR invite or enter a shared link or code.
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.choiceBadge,
                      { backgroundColor: palette.ctaBg },
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceBadgeText,
                        { color: palette.ctaText, fontFamily: fonts.display },
                      ]}
                    >
                      QR / Code
                    </Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Join a Server by address"
                  activeOpacity={0.8}
                  style={[
                    styles.choiceCard,
                    { backgroundColor: palette.surface, borderColor: palette.border },
                  ]}
                  onPress={() => {
                    setError(null);
                    setNotice(null);
                    setJoinOrigin('server');
                    setInvite(null);
                    transitionTo('join_server');
                  }}
                >
                  <View style={styles.choiceCardTextWrap}>
                    <Text
                      style={[
                        styles.choiceCardTitle,
                        { color: palette.ink, fontFamily: fonts.display },
                      ]}
                    >
                      Join a Server
                    </Text>
                    <Text
                      style={[
                        styles.choiceCardSub,
                        { color: palette.inkMuted, fontFamily: fonts.body },
                      ]}
                    >
                      Connect directly using your private server address.
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.choiceBadge,
                      { backgroundColor: palette.surfaceChip, borderColor: palette.border, borderWidth: 1 },
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceBadgeText,
                        { color: palette.ink, fontFamily: fonts.display },
                      ]}
                    >
                      URL
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>
            )}

            {/* Locked Step: Join a Group (Scan QR + Enter Code/Link, NO BACK) */}
            {step === 'join_group' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  Join a Group
                </Text>
                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  Scan your admin's QR invite or paste the invite link or code below.
                </Text>

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Scan QR Code"
                  activeOpacity={0.82}
                  style={[styles.primaryBtn, { backgroundColor: palette.ctaBg }]}
                  onPress={() => void openQrScanner()}
                >
                  <Text
                    style={[
                      styles.primaryBtnText,
                      { color: palette.ctaText, fontFamily: fonts.display },
                    ]}
                  >
                    Scan QR Code
                  </Text>
                </TouchableOpacity>

                <View style={styles.dividerRow}>
                  <View style={[styles.dividerLine, { backgroundColor: palette.border }]} />
                  <Text style={[styles.dividerText, { color: palette.inkMuted, fontFamily: fonts.body }]}>
                    or enter code / link
                  </Text>
                  <View style={[styles.dividerLine, { backgroundColor: palette.border }]} />
                </View>

                <View style={styles.fieldGroup}>
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
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
                        fontFamily: fonts.body,
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
                    <Text
                      style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                    >
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
                          fontFamily: fonts.body,
                        },
                      ]}
                      value={serverUrl}
                      onChangeText={setServerUrl}
                      placeholder="https://track.example.com"
                      placeholderTextColor={palette.placeholder}
                      autoCapitalize="none"
                      autoCorrect={false}
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
                    <Text
                      style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}
                    >
                      {error}
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Connect with invite"
                  activeOpacity={0.8}
                  style={[
                    styles.secondaryBtn,
                    { backgroundColor: palette.surfaceMuted, borderColor: palette.borderStrong },
                  ]}
                  onPress={() => void handleConnectGroupManual()}
                >
                  <Text
                    style={[
                      styles.secondaryBtnText,
                      { color: palette.ink, fontFamily: fonts.display },
                    ]}
                  >
                    Connect with Code
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Locked Step: Join a Server (Server URL input, NO BACK) */}
            {step === 'join_server' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  Join a Server
                </Text>
                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  Enter the address of the private LovedOnes server you'd like to connect to.
                </Text>

                <View style={styles.fieldGroup}>
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
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
                        fontFamily: fonts.body,
                      },
                    ]}
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    placeholder="https://track.example.com"
                    placeholderTextColor={palette.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="done"
                    onSubmitEditing={() => void beginServerHandshake(serverUrl)}
                  />
                </View>

                {__DEV__ && (
                  <View style={styles.quickPresetRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[
                        styles.presetChip,
                        { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                      ]}
                      onPress={() => setServerUrl('http://localhost:8080')}
                    >
                      <Text
                        style={[
                          styles.presetChipText,
                          { color: palette.inkSubtle, fontFamily: fonts.mono },
                        ]}
                      >
                        localhost:8080
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[
                        styles.presetChip,
                        { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                      ]}
                      onPress={() => setServerUrl('http://10.0.2.2:8080')}
                    >
                      <Text
                        style={[
                          styles.presetChipText,
                          { color: palette.inkSubtle, fontFamily: fonts.mono },
                        ]}
                      >
                        10.0.2.2:8080
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {error && (
                  <View
                    style={[
                      styles.feedbackBox,
                      { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                    ]}
                  >
                    <Text
                      style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}
                    >
                      {error}
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Connect to Server"
                  activeOpacity={0.82}
                  style={[styles.primaryBtn, { backgroundColor: palette.ctaBg }]}
                  onPress={() => void beginServerHandshake(serverUrl)}
                >
                  <Text
                    style={[
                      styles.primaryBtnText,
                      { color: palette.ctaText, fontFamily: fonts.display },
                    ]}
                  >
                    Connect to Server
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Locked Step: Animated Handshake (Phone -> Electric Line -> Internet) */}
            {step === 'connecting' && (
              <View
                style={[
                  styles.sheetCard,
                  styles.connectingCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <HandshakeAnimation
                  palette={palette}
                  reduceMotion={reduceMotion}
                  connected={handshakeConnected}
                />

                <Text
                  style={[
                    styles.connectingTitle,
                    { color: palette.ink, fontFamily: fonts.display },
                  ]}
                >
                  {handshakeError ? 'Connection interrupted' : handshakeStage}
                </Text>

                <Text
                  style={[
                    styles.connectingHost,
                    { color: palette.inkMuted, fontFamily: fonts.mono },
                  ]}
                >
                  {hostLabel}
                  {handshakeIp ? ` · ${handshakeIp}` : ''}
                </Text>

                {!handshakeError && (
                  <Text
                    style={[
                      styles.connectingSub,
                      { color: palette.inkMuted, fontFamily: fonts.body },
                    ]}
                  >
                    Verifying server reachability and registering this device handshake once.
                  </Text>
                )}

                {handshakeError && (
                  <>
                    <View
                      style={[
                        styles.feedbackBox,
                        styles.fullWidthBtn,
                        { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                      ]}
                    >
                      <Text
                        style={[
                          styles.errorText,
                          { color: palette.errorText, fontFamily: fonts.body },
                        ]}
                      >
                        {handshakeError}
                      </Text>
                    </View>
                    <View style={styles.handshakeRetryRow}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={[
                          styles.secondaryBtn,
                          styles.flexHalfBtn,
                          { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                        ]}
                        onPress={() => {
                          setHandshakeError(null);
                          if (joinOrigin === 'group') transitionTo('join_group');
                          else if (joinOrigin === 'server') transitionTo('join_server');
                          else transitionTo('existing_login');
                        }}
                      >
                        <Text
                          style={[
                            styles.secondaryBtnText,
                            { color: palette.ink, fontFamily: fonts.heading },
                          ]}
                        >
                          Edit Details
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={[
                          styles.primaryBtn,
                          styles.flexHalfBtn,
                          styles.noTopMargin,
                          { backgroundColor: palette.ctaBg },
                        ]}
                        onPress={() =>
                          void beginServerHandshake(serverUrl, invite?.inviteToken, invite?.groupName)
                        }
                      >
                        <Text
                          style={[
                            styles.primaryBtnText,
                            { color: palette.ctaText, fontFamily: fonts.display },
                          ]}
                        >
                          Retry
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </View>
            )}

            {/* Locked Step: Create Account Request (Mandatory + Color & Photo, NO BACK) */}
            {step === 'create_account' && (
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
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.verifiedPillText,
                      { color: palette.badgeSuccessText, fontFamily: fonts.heading },
                    ]}
                  >
                    {invite ? `JOINING ${invite.groupName.toUpperCase()}` : `CONNECTED · ${hostLabel}`}
                  </Text>
                </View>

                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  Create your profile
                </Text>
                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  Your request will be sent to the server admin for approval.
                </Text>

                {/* Live Avatar & Color Preview (PC-style, no "optional" wording) */}
                <View
                  style={[
                    styles.profilePersonalizeBox,
                    { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                  ]}
                >
                  <View style={styles.avatarPreviewRow}>
                    <View
                      style={[
                        styles.avatarRing,
                        {
                          borderColor: previewHalo,
                          backgroundColor: palette.surface,
                        },
                      ]}
                    >
                      {safeAvatarPreview ? (
                        <Image
                          source={{ uri: avatarUrl.trim() }}
                          style={styles.avatarImg}
                        />
                      ) : (
                        <Text
                          style={[
                            styles.avatarInitials,
                            { color: palette.ink, fontFamily: fonts.display },
                          ]}
                        >
                          {getInitials(username)}
                        </Text>
                      )}
                    </View>

                    <View style={styles.avatarMetaCol}>
                      <Text
                        style={[
                          styles.fieldLabel,
                          { color: palette.ink, fontFamily: fonts.display },
                        ]}
                      >
                        Profile Photo &amp; Color
                      </Text>
                      <Text
                        style={[
                          styles.helperHint,
                          { color: palette.inkMuted, fontFamily: fonts.body },
                        ]}
                      >
                        Personalize how your pin appears on the map.
                      </Text>
                    </View>
                  </View>

                  <View style={styles.photoBtnRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Attach and crop 1 by 1 profile photo from device"
                      activeOpacity={0.8}
                      disabled={pickingAvatar}
                      style={[
                        styles.photoPickBtn,
                        { backgroundColor: palette.surface, borderColor: palette.borderStrong },
                      ]}
                      onPress={() => void handlePickPhotoFromDisk()}
                    >
                      {pickingAvatar ? (
                        <ActivityIndicator color={palette.ink} size="small" />
                      ) : (
                        <Text
                          style={[
                            styles.photoPickBtnText,
                            { color: palette.ink, fontFamily: fonts.display },
                          ]}
                        >
                          {avatarUrl ? 'Change Photo (1:1)' : 'Choose Photo (1:1 Crop)'}
                        </Text>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      accessibilityRole="button"
                      hitSlop={8}
                      style={[
                        styles.photoToggleBtn,
                        { backgroundColor: palette.surface, borderColor: palette.border },
                      ]}
                      onPress={() => setShowPhotoUrlInput((v) => !v)}
                    >
                      <Text
                        style={[
                          styles.inlineLinkText,
                          { color: palette.inkMuted, fontFamily: fonts.heading },
                        ]}
                      >
                        {showPhotoUrlInput ? 'Hide URL' : 'Paste URL'}
                      </Text>
                    </TouchableOpacity>

                    {avatarUrl.trim().length > 0 && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={() => setAvatarUrl('')}
                      >
                        <Text
                          style={[
                            styles.inlineLinkText,
                            { color: palette.errorText, fontFamily: fonts.heading },
                          ]}
                        >
                          Remove
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {showPhotoUrlInput && (
                    <View style={styles.fieldGroup}>
                      <TextInput
                        accessibilityLabel="Profile photo URL"
                        style={[
                          styles.input,
                          {
                            backgroundColor: palette.surface,
                            borderColor: palette.border,
                            color: palette.ink,
                            fontFamily: fonts.body,
                          },
                        ]}
                        value={avatarUrl.startsWith('data:') ? '' : avatarUrl}
                        onChangeText={setAvatarUrl}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        placeholder="https://example.com/photo.jpg"
                        placeholderTextColor={palette.placeholder}
                      />
                    </View>
                  )}

                  <View style={styles.fieldGroup}>
                    <View style={styles.labelRow}>
                      <Text
                        style={[
                          styles.fieldLabel,
                          { color: palette.inkSubtle, fontFamily: fonts.heading },
                        ]}
                      >
                        Accent Color
                      </Text>
                      {haloColor && (
                        <TouchableOpacity
                          accessibilityRole="button"
                          hitSlop={8}
                          onPress={() => setHaloColor(null)}
                        >
                          <Text
                            style={[
                              styles.inlineLinkText,
                              { color: palette.inkMuted, fontFamily: fonts.heading },
                            ]}
                          >
                            Reset
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    <View style={styles.swatchRow}>
                      {ONBOARDING_COLOR_PRESETS.map((preset) => {
                        const active = haloColor === preset.hex;
                        return (
                          <TouchableOpacity
                            key={preset.hex}
                            accessibilityRole="button"
                            accessibilityLabel={`Color ${preset.label}`}
                            activeOpacity={0.78}
                            style={[
                              styles.swatchOuter,
                              { borderColor: active ? palette.ink : 'transparent' },
                            ]}
                            onPress={() => setHaloColor(preset.hex)}
                          >
                            <View style={[styles.swatchDot, { backgroundColor: preset.hex }]} />
                          </TouchableOpacity>
                        );
                      })}
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Open custom hex color picker"
                        activeOpacity={0.78}
                        style={[
                          styles.customColorPill,
                          {
                            backgroundColor: palette.surface,
                            borderColor: haloColor ? haloColor : palette.borderStrong,
                          },
                        ]}
                        onPress={() => setColorPickerOpen(true)}
                      >
                        <View
                          style={[
                            styles.customColorDot,
                            { backgroundColor: haloColor ?? DEFAULT_EXACT_HALO_COLOR },
                          ]}
                        />
                        <Text
                          style={[
                            styles.customColorText,
                            { color: palette.ink, fontFamily: fonts.mono },
                          ]}
                        >
                          {haloColor ?? 'Custom'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                <View style={styles.fieldGroup}>
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
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
                        fontFamily: fonts.body,
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

                <View style={styles.fieldGroup}>
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
                    Email
                  </Text>
                  <TextInput
                    ref={emailRef}
                    accessibilityLabel="Email"
                    style={[
                      styles.input,
                      {
                        backgroundColor: palette.surfaceMuted,
                        borderColor: palette.border,
                        color: palette.ink,
                        fontFamily: fonts.body,
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
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
                    Password
                  </Text>
                  <View
                    style={[
                      styles.passwordWrap,
                      { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                    ]}
                  >
                    <TextInput
                      ref={passwordRef}
                      accessibilityLabel="Password"
                      style={[styles.passwordInput, { color: palette.ink, fontFamily: fonts.body }]}
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="new-password"
                      textContentType="newPassword"
                      returnKeyType="done"
                      onSubmitEditing={() => void handleSubmitAccountRequest()}
                      placeholder="At least 8 characters"
                      placeholderTextColor={palette.placeholder}
                    />
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                      hitSlop={10}
                      style={styles.eyeToggleBtn}
                      onPress={() => setShowPassword((v) => !v)}
                    >
                      <Text
                        style={[
                          styles.eyeToggleText,
                          { color: palette.inkSubtle, fontFamily: fonts.display },
                        ]}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {error && (
                  <View
                    style={[
                      styles.feedbackBox,
                      { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                    ]}
                  >
                    <Text
                      style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}
                    >
                      {error}
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Send request to admin"
                  activeOpacity={0.82}
                  disabled={loading}
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                  ]}
                  onPress={() => void handleSubmitAccountRequest()}
                >
                  {loading ? (
                    <View style={styles.btnLoadingRow}>
                      <ActivityIndicator color={palette.ctaText} size="small" />
                      <Text
                        style={[
                          styles.primaryBtnText,
                          { color: palette.ctaText, fontFamily: fonts.display },
                        ]}
                      >
                        Sending to admin...
                      </Text>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: palette.ctaText, fontFamily: fonts.display },
                      ]}
                    >
                      Send Request to Admin
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Waiting for Admin Approval Page */}
            {step === 'waiting_admin' && pendingReg && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <View
                  style={[
                    styles.verifiedPill,
                    pendingReg.status === 'APPROVED'
                      ? {
                          backgroundColor: palette.badgeSuccessBg,
                          borderColor: palette.badgeSuccessBorder,
                        }
                      : pendingReg.status === 'DENIED'
                        ? {
                            backgroundColor: palette.errorBg,
                            borderColor: palette.errorBorder,
                          }
                        : {
                            backgroundColor: palette.badgeWarnBg,
                            borderColor: palette.badgeWarnBorder,
                          },
                  ]}
                >
                  <View
                    style={[
                      styles.contextDot,
                      {
                        backgroundColor:
                          pendingReg.status === 'APPROVED'
                            ? palette.badgeSuccessDot
                            : pendingReg.status === 'DENIED'
                              ? palette.errorText
                              : '#f59e0b',
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.verifiedPillText,
                      {
                        color:
                          pendingReg.status === 'APPROVED'
                            ? palette.badgeSuccessText
                            : pendingReg.status === 'DENIED'
                              ? palette.errorText
                              : palette.badgeWarnText,
                        fontFamily: fonts.display,
                      },
                    ]}
                  >
                    {pendingReg.status === 'APPROVED'
                      ? 'REQUEST APPROVED'
                      : pendingReg.status === 'DENIED'
                        ? 'REQUEST DECLINED'
                        : pendingReg.status === 'EXPIRED'
                          ? 'REQUEST EXPIRED'
                          : 'AWAITING ADMIN APPROVAL'}
                  </Text>
                </View>

                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  {pendingReg.status === 'APPROVED'
                    ? 'You are approved!'
                    : pendingReg.status === 'DENIED'
                      ? 'Request declined'
                      : pendingReg.status === 'EXPIRED'
                        ? 'Request expired'
                        : 'Request sent to Admin'}
                </Text>

                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  {pendingReg.status === 'APPROVED'
                    ? 'The server admin accepted your account. Sign in now to join your circle.'
                    : pendingReg.status === 'DENIED'
                      ? 'The server admin declined this account request. Reach out to your host if this was unexpected.'
                      : pendingReg.status === 'EXPIRED'
                        ? 'This request expired after 24 hours without an admin response.'
                        : 'Sit tight while the server admin accepts your profile. You can check back anytime from the home screen.'}
                </Text>

                {/* Request Summary Card */}
                <View
                  style={[
                    styles.summaryBox,
                    { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                  ]}
                >
                  <View style={styles.avatarPreviewRow}>
                    <View
                      style={[
                        styles.avatarRing,
                        {
                          borderColor: pendingReg.haloColor ?? DEFAULT_EXACT_HALO_COLOR,
                          backgroundColor: palette.surface,
                        },
                      ]}
                    >
                      {isSafeAvatarUrl(pendingReg.avatarUrl) ? (
                        <Image
                          source={{ uri: pendingReg.avatarUrl }}
                          style={styles.avatarImg}
                        />
                      ) : (
                        <Text
                          style={[
                            styles.avatarInitials,
                            { color: palette.ink, fontFamily: fonts.display },
                          ]}
                        >
                          {getInitials(pendingReg.username)}
                        </Text>
                      )}
                    </View>
                    <View style={styles.avatarMetaCol}>
                      <Text
                        style={[
                          styles.summaryName,
                          { color: palette.ink, fontFamily: fonts.display },
                        ]}
                      >
                        {pendingReg.username}
                      </Text>
                      <Text
                        style={[
                          styles.summarySub,
                          { color: palette.inkMuted, fontFamily: fonts.body },
                        ]}
                      >
                        {pendingReg.email}
                      </Text>
                      <Text
                        style={[
                          styles.summaryMeta,
                          { color: palette.inkSubtle, fontFamily: fonts.mono },
                        ]}
                      >
                        {formatServerHostLabel(pendingReg.serverUrl)}
                        {pendingReg.groupName ? ` · ${pendingReg.groupName}` : ''}
                      </Text>
                    </View>
                  </View>

                  {pendingReg.status === 'PENDING' && (
                    <View
                      style={[
                        styles.countdownBanner,
                        { backgroundColor: palette.surface, borderColor: palette.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.countdownLabel,
                          { color: palette.inkMuted, fontFamily: fonts.heading },
                        ]}
                      >
                        EXPIRES IN
                      </Text>
                      <Text
                        style={[
                          styles.countdownValue,
                          { color: palette.ink, fontFamily: fonts.mono },
                        ]}
                      >
                        {formatCountdownRemaining(pendingReg.expiresAt, nowMs)}
                      </Text>
                    </View>
                  )}
                </View>

                {error && (
                  <View
                    style={[
                      styles.feedbackBox,
                      { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                    ]}
                  >
                    <Text
                      style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}
                    >
                      {error}
                    </Text>
                  </View>
                )}

                {pendingReg.status === 'PENDING' && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Check approval status"
                    activeOpacity={0.82}
                    disabled={checkingStatus}
                    style={[
                      styles.primaryBtn,
                      { backgroundColor: palette.ctaBg, opacity: checkingStatus ? 0.72 : 1 },
                    ]}
                    onPress={() => void refreshRequestStatus(pendingReg, false)}
                  >
                    {checkingStatus ? (
                      <View style={styles.btnLoadingRow}>
                        <ActivityIndicator color={palette.ctaText} size="small" />
                        <Text
                          style={[
                            styles.primaryBtnText,
                            { color: palette.ctaText, fontFamily: fonts.display },
                          ]}
                        >
                          Checking status...
                        </Text>
                      </View>
                    ) : (
                      <Text
                        style={[
                          styles.primaryBtnText,
                          { color: palette.ctaText, fontFamily: fonts.display },
                        ]}
                      >
                        Check Status
                      </Text>
                    )}
                  </TouchableOpacity>
                )}

                {pendingReg.status === 'APPROVED' && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Sign in now"
                    activeOpacity={0.82}
                    style={[styles.primaryBtn, { backgroundColor: palette.ctaBg }]}
                    onPress={async () => {
                      const targetEmail = pendingReg.email;
                      const targetServer = pendingReg.serverUrl;
                      const nextMap = await clearPendingRegistration(targetServer);
                      setPendingReg(null);
                      setPingedServers(nextMap);
                      setServerUrl(targetServer);
                      setHasKnownServer(true);
                      setEmail(targetEmail);
                      setNotice('Your account is ready. Enter your password to sign in.');
                      transitionTo('existing_login');
                    }}
                  >
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: palette.ctaText, fontFamily: fonts.display },
                      ]}
                    >
                      Sign In Now
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Back to Home"
                  activeOpacity={0.78}
                  style={[
                    styles.secondaryBtn,
                    { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                  ]}
                  onPress={async () => {
                    if (pendingReg.status === 'DENIED' || pendingReg.status === 'EXPIRED') {
                      const nextMap = await clearPendingRegistration(pendingReg.serverUrl);
                      setPendingReg(null);
                      setPingedServers(nextMap);
                    }
                    setError(null);
                    setNotice(null);
                    transitionTo('welcome');
                  }}
                >
                  <Text
                    style={[
                      styles.secondaryBtnText,
                      { color: palette.ink, fontFamily: fonts.heading },
                    ]}
                  >
                    Back to Home
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Existing Account: Enter or Switch Server Address */}
            {step === 'existing_server' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  Connect to your server
                </Text>
                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  Enter your LovedOnes server address to sign in or try another server.
                </Text>

                <View style={styles.fieldGroup}>
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
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
                        fontFamily: fonts.body,
                      },
                    ]}
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    placeholder="https://track.example.com"
                    placeholderTextColor={palette.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="done"
                    onSubmitEditing={() => void handleExistingServerContinue()}
                  />
                </View>

                {__DEV__ && (
                  <View style={styles.quickPresetRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[
                        styles.presetChip,
                        { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                      ]}
                      onPress={() => setServerUrl('http://localhost:8080')}
                    >
                      <Text
                        style={[
                          styles.presetChipText,
                          { color: palette.inkSubtle, fontFamily: fonts.mono },
                        ]}
                      >
                        localhost:8080
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[
                        styles.presetChip,
                        { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                      ]}
                      onPress={() => setServerUrl('http://10.0.2.2:8080')}
                    >
                      <Text
                        style={[
                          styles.presetChipText,
                          { color: palette.inkSubtle, fontFamily: fonts.mono },
                        ]}
                      >
                        10.0.2.2:8080
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {error && (
                  <View
                    style={[
                      styles.feedbackBox,
                      { backgroundColor: palette.errorBg, borderColor: palette.errorBorder },
                    ]}
                  >
                    <Text
                      style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}
                    >
                      {error}
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Continue to sign in"
                  activeOpacity={0.82}
                  disabled={loading}
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                  ]}
                  onPress={() => void handleExistingServerContinue()}
                >
                  {loading ? (
                    <View style={styles.btnLoadingRow}>
                      <ActivityIndicator color={palette.ctaText} size="small" />
                      <Text
                        style={[
                          styles.primaryBtnText,
                          { color: palette.ctaText, fontFamily: fonts.display },
                        ]}
                      >
                        Connecting...
                      </Text>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: palette.ctaText, fontFamily: fonts.display },
                      ]}
                    >
                      Continue
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Existing Account: Sign In + Wrong Credentials -> Create Account Prompt */}
            {step === 'existing_login' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  Welcome back
                </Text>
                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  Sign in to view your live circle and places.
                </Text>

                <View style={styles.fieldGroup}>
                  <Text
                    style={[styles.fieldLabel, { color: palette.inkSubtle, fontFamily: fonts.heading }]}
                  >
                    Email
                  </Text>
                  <TextInput
                    ref={emailRef}
                    accessibilityLabel="Email"
                    style={[
                      styles.input,
                      {
                        backgroundColor: palette.surfaceMuted,
                        borderColor: palette.border,
                        color: palette.ink,
                        fontFamily: fonts.body,
                      },
                    ]}
                    value={email}
                    onChangeText={(txt) => {
                      setEmail(txt);
                      setLoginNotFoundPrompt(false);
                    }}
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
                    <Text
                      style={[
                        styles.fieldLabel,
                        { color: palette.inkSubtle, fontFamily: fonts.heading },
                      ]}
                    >
                      Password
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Forgot password"
                      hitSlop={10}
                      onPress={() => {
                        setForgotEmail(email.trim());
                        setForgotStep('request');
                        setError(null);
                        setNotice(null);
                        transitionTo('forgot');
                      }}
                    >
                      <Text
                        style={[
                          styles.inlineLinkText,
                          { color: palette.inkMuted, fontFamily: fonts.heading },
                        ]}
                      >
                        Forgot password?
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <View
                    style={[
                      styles.passwordWrap,
                      { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                    ]}
                  >
                    <TextInput
                      ref={passwordRef}
                      accessibilityLabel="Password"
                      style={[styles.passwordInput, { color: palette.ink, fontFamily: fonts.body }]}
                      value={password}
                      onChangeText={(txt) => {
                        setPassword(txt);
                        setLoginNotFoundPrompt(false);
                      }}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="password"
                      textContentType="password"
                      returnKeyType="done"
                      onSubmitEditing={() => void handleSubmitLogin()}
                      placeholder="••••••••"
                      placeholderTextColor={palette.placeholder}
                    />
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                      hitSlop={10}
                      style={styles.eyeToggleBtn}
                      onPress={() => setShowPassword((prev) => !prev)}
                    >
                      <Text
                        style={[
                          styles.eyeToggleText,
                          { color: palette.inkSubtle, fontFamily: fonts.display },
                        ]}
                      >
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
                    <Text
                      style={[styles.noticeText, { color: palette.noticeText, fontFamily: fonts.body }]}
                    >
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
                    <Text
                      style={[styles.errorText, { color: palette.errorText, fontFamily: fonts.body }]}
                    >
                      {error}
                    </Text>
                  </View>
                )}

                {loginNotFoundPrompt && (
                  <View
                    style={[
                      styles.fallbackCard,
                      { backgroundColor: palette.surfaceMuted, borderColor: palette.borderStrong },
                    ]}
                  >
                    {isCurrentServerAlreadyPinged && currentServerPing ? (
                      <>
                        <Text
                          style={[
                            styles.fallbackTitle,
                            { color: palette.ink, fontFamily: fonts.display },
                          ]}
                        >
                          Request already sent to {hostLabel}
                        </Text>
                        <Text
                          style={[
                            styles.fallbackBody,
                            { color: palette.inkMuted, fontFamily: fonts.body },
                          ]}
                        >
                          You already pinged this server (expires in{' '}
                          {formatCountdownRemaining(currentServerPing.expiresAt, nowMs)}). You can
                          switch to another server or check your waiting status.
                        </Text>
                        <TouchableOpacity
                          accessibilityRole="button"
                          style={[
                            styles.secondaryBtn,
                            { backgroundColor: palette.surface, borderColor: palette.border },
                          ]}
                          onPress={() => {
                            setPendingReg(currentServerPing);
                            transitionTo('waiting_admin');
                          }}
                        >
                          <Text
                            style={[
                              styles.secondaryBtnText,
                              { color: palette.ink, fontFamily: fonts.display },
                            ]}
                          >
                            View Waiting Status
                          </Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <Text
                          style={[
                            styles.fallbackTitle,
                            { color: palette.ink, fontFamily: fonts.display },
                          ]}
                        >
                          Create an account instead?
                        </Text>
                        <Text
                          style={[
                            styles.fallbackBody,
                            { color: palette.inkMuted, fontFamily: fonts.body },
                          ]}
                        >
                          We can send an account request to the admin of{' '}
                          <Text style={{ color: palette.ink, fontWeight: '600' }}>{hostLabel}</Text>{' '}
                          using the details you entered.
                        </Text>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel="Create an account instead"
                          activeOpacity={0.82}
                          style={[
                            styles.secondaryBtn,
                            { backgroundColor: palette.surface, borderColor: palette.borderStrong },
                          ]}
                          onPress={() => {
                            setLoginNotFoundPrompt(false);
                            setInvite(null);
                            setJoinOrigin('existing_fallback');
                            void beginServerHandshake(serverUrl);
                          }}
                        >
                          <Text
                            style={[
                              styles.secondaryBtnText,
                              { color: palette.ink, fontFamily: fonts.display },
                            ]}
                          >
                            Create Account Instead
                          </Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                )}

                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Sign In"
                  activeOpacity={0.82}
                  disabled={loading}
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: palette.ctaBg, opacity: loading ? 0.72 : 1 },
                  ]}
                  onPress={() => void handleSubmitLogin()}
                >
                  {loading ? (
                    <View style={styles.btnLoadingRow}>
                      <ActivityIndicator color={palette.ctaText} size="small" />
                      <Text
                        style={[
                          styles.primaryBtnText,
                          { color: palette.ctaText, fontFamily: fonts.display },
                        ]}
                      >
                        Signing in...
                      </Text>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.primaryBtnText,
                        { color: palette.ctaText, fontFamily: fonts.display },
                      ]}
                    >
                      Sign In
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Forgot Password */}
            {step === 'forgot' && (
              <View
                style={[
                  styles.sheetCard,
                  { backgroundColor: palette.surface, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.sheetTitle, { color: palette.ink, fontFamily: fonts.display }]}>
                  Reset your password
                </Text>
                <Text
                  style={[styles.sheetSubtitle, { color: palette.inkMuted, fontFamily: fonts.body }]}
                >
                  {forgotStep === 'request'
                    ? 'Enter your account email or verified backup email for a 6-digit recovery code.'
                    : 'Enter the 6-digit code and set your new password.'}
                </Text>

                {forgotStep === 'request' ? (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text
                        style={[
                          styles.fieldLabel,
                          { color: palette.inkSubtle, fontFamily: fonts.heading },
                        ]}
                      >
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
                            fontFamily: fonts.body,
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
                        <Text
                          style={[
                            styles.errorText,
                            { color: palette.errorText, fontFamily: fonts.body },
                          ]}
                        >
                          {error}
                        </Text>
                      </View>
                    )}

                    <TouchableOpacity
                      accessibilityRole="button"
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
                          <Text
                            style={[
                              styles.primaryBtnText,
                              { color: palette.ctaText, fontFamily: fonts.display },
                            ]}
                          >
                            Sending code...
                          </Text>
                        </View>
                      ) : (
                        <Text
                          style={[
                            styles.primaryBtnText,
                            { color: palette.ctaText, fontFamily: fonts.display },
                          ]}
                        >
                          Send Reset Code
                        </Text>
                      )}
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text
                        style={[
                          styles.fieldLabel,
                          { color: palette.inkSubtle, fontFamily: fonts.heading },
                        ]}
                      >
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
                            fontFamily: fonts.mono,
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
                      <Text
                        style={[
                          styles.fieldLabel,
                          { color: palette.inkSubtle, fontFamily: fonts.heading },
                        ]}
                      >
                        New Password
                      </Text>
                      <View
                        style={[
                          styles.passwordWrap,
                          { backgroundColor: palette.surfaceMuted, borderColor: palette.border },
                        ]}
                      >
                        <TextInput
                          ref={forgotNewPassRef}
                          accessibilityLabel="New password"
                          style={[
                            styles.passwordInput,
                            { color: palette.ink, fontFamily: fonts.body },
                          ]}
                          value={forgotNewPassword}
                          onChangeText={setForgotNewPassword}
                          secureTextEntry={!showForgotPassword}
                          autoComplete="new-password"
                          textContentType="newPassword"
                          returnKeyType="next"
                          onSubmitEditing={() => forgotConfirmPassRef.current?.focus()}
                          placeholder="At least 8 characters"
                          placeholderTextColor={palette.placeholder}
                        />
                        <TouchableOpacity
                          accessibilityRole="button"
                          hitSlop={10}
                          style={styles.eyeToggleBtn}
                          onPress={() => setShowForgotPassword((v) => !v)}
                        >
                          <Text
                            style={[
                              styles.eyeToggleText,
                              { color: palette.inkSubtle, fontFamily: fonts.display },
                            ]}
                          >
                            {showForgotPassword ? 'Hide' : 'Show'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    <View style={styles.fieldGroup}>
                      <Text
                        style={[
                          styles.fieldLabel,
                          { color: palette.inkSubtle, fontFamily: fonts.heading },
                        ]}
                      >
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
                            fontFamily: fonts.body,
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
                        <Text
                          style={[
                            styles.noticeText,
                            { color: palette.noticeText, fontFamily: fonts.body },
                          ]}
                        >
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
                        <Text
                          style={[
                            styles.errorText,
                            { color: palette.errorText, fontFamily: fonts.body },
                          ]}
                        >
                          {error}
                        </Text>
                      </View>
                    )}

                    <TouchableOpacity
                      accessibilityRole="button"
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
                          <Text
                            style={[
                              styles.primaryBtnText,
                              { color: palette.ctaText, fontFamily: fonts.display },
                            ]}
                          >
                            Updating password...
                          </Text>
                        </View>
                      ) : (
                        <Text
                          style={[
                            styles.primaryBtnText,
                            { color: palette.ctaText, fontFamily: fonts.display },
                          ]}
                        >
                          Reset Password
                        </Text>
                      )}
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}
          </Animated.View>
        </ScrollView>
      )}

      <ColorPickerSheet
        visible={colorPickerOpen}
        initialHex={haloColor}
        palette={palette}
        fonts={fonts}
        onApply={(hex) => {
          setHaloColor(hex);
          setColorPickerOpen(false);
        }}
        onClose={() => setColorPickerOpen(false)}
      />
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
  welcomeSpacer: {
    height: 16,
  },
  persistentToastCard: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 3,
  },
  persistentToastTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  persistentToastBody: {
    fontSize: 12,
    lineHeight: 17,
  },
  heroCenter: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  brandCenterTitle: {
    fontSize: 38,
    lineHeight: 44,
    fontWeight: '700',
    letterSpacing: -0.7,
    marginBottom: 16,
  },
  photoBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  photoPickBtn: {
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 13,
    paddingVertical: 9,
    minHeight: 38,
    justifyContent: 'center',
  },
  photoPickBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  photoToggleBtn: {
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 11,
    paddingVertical: 9,
    minHeight: 38,
    justifyContent: 'center',
  },
  customColorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
    minHeight: 34,
  },
  customColorDot: {
    width: 14,
    height: 14,
    borderRadius: 999,
  },
  customColorText: {
    fontSize: 11,
    fontWeight: '700',
  },
  heroHeadline: {
    marginTop: 22,
    fontSize: 33,
    lineHeight: 40,
    fontWeight: '700',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  heroBody: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: 0.15,
    textAlign: 'center',
    maxWidth: 312,
  },
  heroErrorBox: {
    marginTop: 18,
    width: '100%',
  },
  welcomeDock: {
    gap: 12,
  },
  heroPrimaryBtn: {
    minHeight: 54,
    borderRadius: 15,
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
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  heroSecondaryBtn: {
    minHeight: 52,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  heroSecondaryBtnText: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
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
  serverChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    maxWidth: '72%',
  },
  serverChipText: {
    fontSize: 12,
    flexShrink: 1,
  },
  serverChipAction: {
    fontSize: 12,
    fontWeight: '700',
  },
  choiceStage: {
    gap: 14,
    paddingVertical: 6,
  },
  pageTitle: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  pageSubtitle: {
    fontSize: 14,
    lineHeight: 21,
    letterSpacing: 0.15,
    marginBottom: 4,
  },
  choiceCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  choiceCardTextWrap: {
    flex: 1,
    gap: 4,
  },
  choiceCardTitle: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  choiceCardSub: {
    fontSize: 13,
    lineHeight: 19,
  },
  choiceBadge: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  choiceBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sheetCard: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 22,
    gap: 14,
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  connectingCard: {
    alignItems: 'center',
    paddingVertical: 30,
  },
  connectingTitle: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  connectingHost: {
    fontSize: 12,
    textAlign: 'center',
  },
  connectingSub: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 270,
  },
  handshakeRetryRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginTop: 6,
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
    maxWidth: '100%',
  },
  verifiedPillText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    flexShrink: 1,
  },
  contextDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  sheetTitle: {
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  sheetSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.1,
    marginTop: -4,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 2,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 12,
  },
  profilePersonalizeBox: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  avatarPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  avatarRing: {
    width: 56,
    height: 56,
    borderRadius: 999,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
  },
  avatarInitials: {
    fontSize: 18,
    fontWeight: '700',
  },
  avatarMetaCol: {
    flex: 1,
    gap: 2,
  },
  swatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  swatchOuter: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchDot: {
    width: 24,
    height: 24,
    borderRadius: 999,
  },
  hexInput: {
    minWidth: 88,
    height: 36,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    fontSize: 12,
  },
  summaryBox: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  summaryName: {
    fontSize: 16,
    fontWeight: '700',
  },
  summarySub: {
    fontSize: 13,
  },
  summaryMeta: {
    fontSize: 11,
    marginTop: 2,
  },
  countdownBanner: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countdownLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  countdownValue: {
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  fallbackCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  fallbackTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  fallbackBody: {
    fontSize: 13,
    lineHeight: 18,
  },
  quickPresetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
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
    letterSpacing: 0.1,
  },
  helperHint: {
    fontSize: 12,
    lineHeight: 17,
  },
  inlineLinkText: {
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  multilineInput: {
    minHeight: 78,
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
    borderRadius: 13,
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
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    marginTop: 2,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  btnLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  secondaryBtn: {
    minHeight: 48,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  fullWidthBtn: {
    width: '100%',
  },
  flexHalfBtn: {
    flex: 1,
  },
  noTopMargin: {
    marginTop: 0,
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
    gap: 10,
  },
  scannerTitle: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  scannerHint: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 4,
  },
});
