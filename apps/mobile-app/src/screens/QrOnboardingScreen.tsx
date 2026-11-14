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
      const bound = await parseAndBindQrInvite(manualInput);
      setInvite(bound);
      setServerUrl(bound.serverUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid QR JSON or URL');
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>LovedOnes Mobile</Text>
      <Text style={styles.subtitle}>
        Scan the Host Admin QR code to bind your self-hosted backend URL automatically.
      </Text>

      <TouchableOpacity
        style={styles.primaryBtn}
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
        <Text style={styles.primaryBtnText}>Scan Onboarding QR Code</Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.label}>Or paste QR JSON / Invite URL</Text>
        <TextInput
          style={styles.input}
          value={manualInput}
          onChangeText={setManualInput}
          placeholder='{"v":1,"serverUrl":"https://...","inviteToken":"inv_..."}'
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => void handleBindManual()}>
          <Text style={styles.secondaryBtnText}>Bind Invite Payload</Text>
        </TouchableOpacity>
      </View>

      {invite && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            Bound to {invite.groupName} ({invite.serverUrl})
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Server Base URL</Text>
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          keyboardType="url"
        />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="member@example.com"
          placeholderTextColor="#64748b"
        />

        {mode === 'register' && (
          <>
            <Text style={styles.label}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="Sam"
              placeholderTextColor="#64748b"
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
          placeholderTextColor="#64748b"
        />

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={styles.primaryBtn}
          disabled={loading}
          onPress={() => void handleSubmitAuth()}
        >
          {loading ? (
            <ActivityIndicator color="#020617" />
          ) : (
            <Text style={styles.primaryBtnText}>
              {mode === 'register' ? 'Register & Connect' : 'Sign In & Connect'}
            </Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setMode((m) => (m === 'register' ? 'login' : 'register'))}
          style={styles.switchBtn}
        >
          <Text style={styles.switchText}>
            {mode === 'register'
              ? 'Already have an account? Switch to Sign In'
              : 'New user? Switch to Register'}
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#020617',
    padding: 20,
    gap: 14,
  },
  title: {
    marginTop: 28,
    fontSize: 26,
    fontWeight: '700',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 13,
    color: '#94a3b8',
  },
  card: {
    backgroundColor: '#0f172a',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  label: {
    fontSize: 12,
    color: '#cbd5e1',
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#020617',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 8,
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: '#10b981',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#020617',
    fontWeight: '700',
    fontSize: 14,
  },
  secondaryBtn: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#e2e8f0',
    fontWeight: '600',
    fontSize: 13,
  },
  badge: {
    backgroundColor: '#064e3b',
    borderRadius: 8,
    padding: 10,
  },
  badgeText: {
    color: '#6ee7b7',
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    color: '#fda4af',
    fontSize: 12,
  },
  switchBtn: {
    paddingVertical: 6,
    alignItems: 'center',
  },
  switchText: {
    color: '#38bdf8',
    fontSize: 12,
  },
  scannerWrap: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'flex-end',
  },
  scannerOverlay: {
    padding: 24,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    alignItems: 'center',
    gap: 12,
  },
  scannerPrompt: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
  },
});
