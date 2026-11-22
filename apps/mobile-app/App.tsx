import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import './src/services/backgroundLocation';
import { MobileMapScreen } from './src/screens/MobileMapScreen';
import { QrOnboardingScreen } from './src/screens/QrOnboardingScreen';
import { getOnboardingPalette } from './src/services/onboardingTheme';
import { resolveMobileMapTheme } from './src/services/pmtilesStyle';
import { SafeAreaProvider, useSafeAreaInsets } from './src/services/safeArea';
import {
  extractInviteCandidateFromUrl,
  getMapThemePreference,
  getStoredConfig,
  type MobileMapThemePreference,
  MobileStoredConfig,
} from './src/services/secureConfig';

interface AppRootContentProps {
  loading: boolean;
  config: MobileStoredConfig | null;
  themePreference: MobileMapThemePreference;
  pendingInviteUrl: string | null;
  persistentRemovedToast: string | null;
  onThemePreferenceChange: (pref: MobileMapThemePreference) => void;
  onClearPendingInvite: () => void;
  onAuthenticated: (nextConfig: MobileStoredConfig) => void;
  onSignedOut: (removedReason?: string) => void;
}

function AppRootContent({
  loading,
  config,
  themePreference,
  pendingInviteUrl,
  persistentRemovedToast,
  onThemePreferenceChange,
  onClearPendingInvite,
  onAuthenticated,
  onSignedOut,
}: AppRootContentProps) {
  const colorScheme = useColorScheme();
  const resolvedTheme = resolveMobileMapTheme(themePreference, colorScheme);
  const palette = getOnboardingPalette(resolvedTheme);
  const insets = useSafeAreaInsets();

  if (loading) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.root, { backgroundColor: palette.canvas }]}
      >
        <StatusBar style={palette.statusBarStyle} />
        <View style={[styles.loader, { marginBottom: insets.bottom }]}>
          <ActivityIndicator color={palette.ink} size="large" />
        </View>
      </View>
    );
  }

  const isAuthenticated = Boolean(config?.accessToken && config.serverUrl);
  const authenticatedCanvas = resolvedTheme === 'dark' ? '#0c141d' : '#cfe3ee';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.root,
        { backgroundColor: isAuthenticated ? authenticatedCanvas : palette.canvas },
      ]}
    >
      <StatusBar style={palette.statusBarStyle} />
      {/* Keep every UI component, orb, and overlay strictly above the bottom navigation bar */}
      <View
        style={[
          styles.safeViewport,
          {
            marginBottom: insets.bottom,
            backgroundColor: isAuthenticated ? authenticatedCanvas : palette.canvas,
          },
        ]}
      >
        {isAuthenticated && config ? (
          <MobileMapScreen
            config={config}
            initialThemePreference={themePreference}
            onThemePreferenceChange={onThemePreferenceChange}
            onSignedOut={onSignedOut}
          />
        ) : (
          <QrOnboardingScreen
            initialServerUrl={config?.serverUrl ?? null}
            pendingInviteUrl={pendingInviteUrl}
            persistentToast={persistentRemovedToast}
            themePreference={themePreference}
            onConsumePendingInvite={onClearPendingInvite}
            onAuthenticated={onAuthenticated}
          />
        )}
      </View>
    </View>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<MobileStoredConfig | null>(null);
  const [themePreference, setThemePreference] = useState<MobileMapThemePreference>('system');
  const [pendingInviteUrl, setPendingInviteUrl] = useState<string | null>(null);
  const [persistentRemovedToast, setPersistentRemovedToast] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getStoredConfig(), getMapThemePreference()])
      .then(([cfg, pref]) => {
        if (!active) return;
        setConfig(cfg);
        setThemePreference(pref);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    void Linking.getInitialURL()
      .then((url) => {
        const invite = extractInviteCandidateFromUrl(url);
        if (active && invite) {
          setPendingInviteUrl(invite);
        }
      })
      .catch(() => {});

    const sub = Linking.addEventListener('url', (event) => {
      const invite = extractInviteCandidateFromUrl(event.url);
      if (invite) {
        setPendingInviteUrl(invite);
      }
    });

    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <AppRootContent
        loading={loading}
        config={config}
        themePreference={themePreference}
        pendingInviteUrl={pendingInviteUrl}
        persistentRemovedToast={persistentRemovedToast}
        onThemePreferenceChange={setThemePreference}
        onClearPendingInvite={() => setPendingInviteUrl(null)}
        onAuthenticated={(nextConfig) => {
          setPersistentRemovedToast(null);
          setConfig(nextConfig);
        }}
        onSignedOut={(removedReason) => {
          if (removedReason) {
            setPersistentRemovedToast(removedReason);
          }
          setConfig((prev) => ({
            serverUrl: prev?.serverUrl ?? null,
            accessToken: null,
            refreshToken: null,
            user: null,
            activeGroupId: null,
          }));
        }}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safeViewport: {
    flex: 1,
    overflow: 'hidden',
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
