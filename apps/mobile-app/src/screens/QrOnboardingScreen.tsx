import React, { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import type { QrInvitePayload } from '@loved-ones/shared';
import { parseInviteInput } from '@loved-ones/shared';
import {
  MobileStoredConfig,
  parseAndBindQrInvite,
  saveStoredConfig,
} from '../services/secureConfig';

interface QrOnboardingScreenProps {
  onAuthenticated: (config: MobileStoredConfig) => void;
}

export function QrOnboardingScreen({ onAuthenticated }: QrOnboardingScreenProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [invite, setInvite] = useState<QrInvitePayload | null>(null);
  const [serverUrl, setServerUrl] = useState('http://10.0.2.2:8080');

  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [forgotMode, setForgotMode] = useState(false);
  const [forgotStep, setForgotStep] = useState<'request' | 'reset'>('request');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');

  async function handleQrScanned(result: BarcodeScanningResult) {
    if (!scanning) return;
    setScanning(false);
    setError(null);
    try {
      const bound = await parseAndBindQrInvite(result.data);
      setInvite(bound);
      setServerUrl(bound.serverUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid QR invite code');
    }
  }

  async function handleBindManual() {
    setError(null);
    try {
      const parsed = parseInviteInput(manualInput);
      if (parsed.serverUrl) {
        const bound = await parseAndBindQrInvite(manualInput);
        setInvite(bound);
        setServerUrl(bound.serverUrl);
      } else {
        const cleanServer = serverUrl.trim().replace(/\/$/, '');
        if (!cleanServer) {
          throw new Error('Enter Server Base URL or paste a full invite URL/QR JSON');
        }
        setInvite({
          v: 1,
          serverUrl: cleanServer,
          inviteToken: parsed.inviteToken,
          groupName: parsed.groupName ?? 'Invited Group',
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid QR JSON, URL, or token');
    }
  }

  async function handleSubmitAuth() {
    setLoading(true);
    setError(null);
    const cleanServer = serverUrl.trim().replace(/\/$/, '');
    try {
      const endpoint =
        mode === 'register' ? `${cleanServer}/api/auth/register` : `${cleanServer}/api/auth/login`;
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

      const nextConfig: MobileStoredConfig = {
        serverUrl: cleanServer,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? null,
        user: data.user,
        activeGroupId,
      };
      await saveStoredConfig(nextConfig);
      onAuthenticated(nextConfig);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleRequestReset() {
    setLoading(true);
    setError(null);
    setNotice(null);
    const cleanServer = serverUrl.trim().replace(/\/$/, '');
    try {
      const res = await fetch(`${cleanServer}/api/auth/forgot-password/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setForgotStep('reset');
      setNotice(
        data.message ??
          'If that account has a verified backup email, a 6-digit reset code has been sent.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request reset code');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmReset() {
    if (forgotNewPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }
    if (forgotNewPassword !== forgotConfirmPassword) {
      setError('New passwords do not match');
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    const cleanServer = serverUrl.trim().replace(/\/$/, '');
    try {
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
      setEmail(forgotEmail.trim());
      setPassword('');
      setForgotCode('');
      setForgotNewPassword('');
      setForgotConfirmPassword('');
      setForgotMode(false);
      setForgotStep('request');
      setMode('login');
      setNotice('Password reset! Sign in with your new password.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  }

  if (scanning) {
    return (
      <View style={styles.scannerWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(res) => void handleQrScanned(res)}
        />
        <View style={styles.scannerOverlay}>
          <Text style={styles.scannerPrompt}>Scan Admin QR Invite</Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setScanning(false)}>
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <View style={styles.brandBadge}>
          <View style={styles.brandDot} />
          <Text style={styles.brandBadgeText}>LovedOnes</Text>
        </View>
        <Text style={styles.title}>Connect your device</Text>
        <Text style={styles.subtitle}>
          Scan an invite QR code or sign in to your private self-hosted instance.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.mintCtaBtn}
        onPress={async () => {
          if (!permission?.granted) {
            const next = await requestPermission();
            if (!next.granted) {
              setError('Camera permission is required to scan QR codes.');
              return;
            }
          }
          setScanning(true);
        }}
      >
        <Text style={styles.mintCtaBtnText}>Scan Onboarding QR Code</Text>
      </TouchableOpacity>

      {invite && (
        <View style={styles.badge}>
          <View style={styles.badgeDot} />
          <Text style={styles.badgeText}>
            Bound to {invite.groupName} ({invite.serverUrl})
          </Text>
        </View>
      )}

      <View style={styles.card}>
        {forgotMode ? (
          <>
            <Text style={styles.cardTitle}>Recover forgotten password</Text>
            <Text style={styles.label}>
              Enter your account email or verified backup email to receive a 6-digit code.
            </Text>

            <Text style={styles.label}>Server Base URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              keyboardType="url"
              placeholder="https://track.example.com"
              placeholderTextColor="#94a3b8"
            />

            {forgotStep === 'request' ? (
              <>
                <Text style={styles.label}>Account or Verified Backup Email</Text>
                <TextInput
                  style={styles.input}
                  value={forgotEmail}
                  onChangeText={setForgotEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  placeholder="you@example.com"
                  placeholderTextColor="#94a3b8"
                />

                {error && <Text style={styles.errorText}>{error}</Text>}

                <TouchableOpacity
                  style={styles.primaryBtn}
                  disabled={loading}
                  onPress={() => void handleRequestReset()}
                >
                  {loading ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Send Reset Code</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.label}>6-Digit Reset Code</Text>
                <TextInput
                  style={styles.input}
                  value={forgotCode}
                  onChangeText={(txt) => setForgotCode(txt.replace(/\D/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="123456"
                  placeholderTextColor="#94a3b8"
                />

                <Text style={styles.label}>New Password</Text>
                <TextInput
                  style={styles.input}
                  value={forgotNewPassword}
                  onChangeText={setForgotNewPassword}
                  secureTextEntry
                  placeholder="Minimum 8 characters"
                  placeholderTextColor="#94a3b8"
                />

                <Text style={styles.label}>Confirm New Password</Text>
                <TextInput
                  style={styles.input}
                  value={forgotConfirmPassword}
                  onChangeText={setForgotConfirmPassword}
                  secureTextEntry
                  placeholder="Repeat new password"
                  placeholderTextColor="#94a3b8"
                />

                {notice && <Text style={styles.noticeText}>{notice}</Text>}
                {error && <Text style={styles.errorText}>{error}</Text>}

                <TouchableOpacity
                  style={styles.primaryBtn}
                  disabled={loading}
                  onPress={() => void handleConfirmReset()}
                >
                  {loading ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Reset Password</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => {
                setForgotMode(false);
                setForgotStep('request');
                setError(null);
                setNotice(null);
              }}
            >
              <Text style={styles.secondaryBtnText}>Back to Sign In</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={styles.segmentWrap}>
              <TouchableOpacity
                style={[styles.segmentBtn, mode === 'login' && styles.segmentBtnActive]}
                onPress={() => {
                  setMode('login');
                  setError(null);
                  setNotice(null);
                }}
              >
                <Text style={[styles.segmentText, mode === 'login' && styles.segmentTextActive]}>
                  Sign In
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentBtn, mode === 'register' && styles.segmentBtnActive]}
                onPress={() => {
                  setMode('register');
                  setError(null);
                  setNotice(null);
                }}
              >
                <Text style={[styles.segmentText, mode === 'register' && styles.segmentTextActive]}>
                  Create Account
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Server Base URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              keyboardType="url"
              placeholder="https://track.example.com"
              placeholderTextColor="#94a3b8"
            />

            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="member@example.com"
              placeholderTextColor="#94a3b8"
            />

            {mode === 'register' && (
              <>
                <Text style={styles.label}>Display Name</Text>
                <TextInput
                  style={styles.input}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Sam"
                  placeholderTextColor="#94a3b8"
                />
              </>
            )}

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="••••••••"
              placeholderTextColor="#94a3b8"
            />

            {notice && <Text style={styles.noticeText}>{notice}</Text>}
            {error && <Text style={styles.errorText}>{error}</Text>}

            <TouchableOpacity
              style={styles.primaryBtn}
              disabled={loading}
              onPress={() => void handleSubmitAuth()}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {mode === 'register' ? 'Register & Connect' : 'Sign In & Connect'}
                </Text>
              )}
            </TouchableOpacity>

            {mode === 'login' && (
              <TouchableOpacity
                style={styles.linkBtn}
                onPress={() => {
                  setForgotEmail(email.trim());
                  setForgotMode(true);
                  setForgotStep('request');
                  setError(null);
                  setNotice(null);
                }}
              >
                <Text style={styles.linkBtnText}>Forgot password?</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>Manual QR JSON / Invite URL</Text>
        <TextInput
          style={styles.input}
          value={manualInput}
          onChangeText={setManualInput}
          placeholder='{"v":1,"serverUrl":"https://...","inviteToken":"inv_..."}'
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => void handleBindManual()}>
          <Text style={styles.secondaryBtnText}>Bind Invite Payload</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#eef3f6',
    paddingHorizontal: 20,
    paddingTop: 52,
    paddingBottom: 32,
    gap: 14,
  },
  header: {
    gap: 6,
    marginBottom: 4,
  },
  brandBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#18181b',
  },
  brandBadgeText: {
    color: '#18181b',
    fontSize: 12,
    fontWeight: '700',
  },
  title: {
    marginTop: 6,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: '#18181b',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    color: '#64748b',
  },
  mintCtaBtn: {
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  mintCtaBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  card: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
    gap: 10,
    shadowColor: '#0f172a',
    shadowOpacity: 0.05,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  cardTitle: {
    color: '#18181b',
    fontSize: 16,
    fontWeight: '700',
  },
  segmentWrap: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    padding: 4,
    marginBottom: 4,
  },
  segmentBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  segmentBtnActive: {
    backgroundColor: '#18181b',
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
  },
  segmentTextActive: {
    color: '#ffffff',
  },
  label: {
    fontSize: 12,
    color: '#475569',
    fontWeight: '600',
    marginTop: 2,
  },
  input: {
    backgroundColor: '#f8fafc',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 10,
    color: '#18181b',
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
  },
  primaryBtn: {
    marginTop: 4,
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  linkBtn: {
    alignSelf: 'flex-end',
    paddingVertical: 4,
  },
  linkBtnText: {
    color: '#18181b',
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  secondaryBtn: {
    backgroundColor: '#f1f5f9',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#18181b',
    fontWeight: '600',
    fontSize: 13,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
    borderColor: '#d4d4d8',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#18181b',
  },
  badgeText: {
    flex: 1,
    color: '#18181b',
    fontSize: 12,
    fontWeight: '600',
  },
  noticeText: {
    color: '#18181b',
    backgroundColor: '#f4f4f5',
    borderColor: '#e4e4e7',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: '500',
  },
  errorText: {
    color: '#be123c',
    backgroundColor: '#fff1f2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: '500',
  },
  scannerWrap: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'flex-end',
  },
  scannerOverlay: {
    paddingHorizontal: 24,
    paddingTop: 22,
    paddingBottom: 34,
    backgroundColor: 'rgba(255, 255, 255, 0.94)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    alignItems: 'center',
    gap: 12,
  },
  scannerPrompt: {
    color: '#18181b',
    fontSize: 16,
    fontWeight: '700',
  },
});
