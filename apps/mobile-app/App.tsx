import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import './src/services/backgroundLocation';
import { MobileMapScreen } from './src/screens/MobileMapScreen';
import { QrOnboardingScreen } from './src/screens/QrOnboardingScreen';
import { getOnboardingPalette } from './src/services/onboardingTheme';
import { SafeAreaProvider, useSafeAreaInsets } from './src/services/safeArea';
import {
  extractInviteCandidateFromUrl,
  getStoredConfig,
  MobileStoredConfig,
} from './src/services/secureConfig';

interface AppRootContentProps {
  loading: boolean;
  config: MobileStoredConfig | null;
  pendingInviteUrl: string | null;
  persistentRemovedToast: string | null;
  onClearPendingInvite: () => void;
  onAuthenticated: (nextConfig: MobileStoredConfig) => void;
  onSignedOut: (removedReason?: string) => void;
}

function AppRootContent({
  loading,
  config,
  pendingInviteUrl,
  persistentRemovedToast,
  onClearPendingInvite,
  onAuthenticated,
  onSignedOut,
}: AppRootContentProps) {
  const colorScheme = useColorScheme();
  const palette = getOnboardingPalette(colorScheme);
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

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.root,
        { backgroundColor: isAuthenticated ? '#ffffff' : palette.canvas },
      ]}
    >
      <StatusBar style={isAuthenticated ? 'dark' : palette.statusBarStyle} />
      {/* Keep every UI component, orb, and overlay strictly above the bottom navigation bar */}
      <View
        style={[
          styles.safeViewport,
          {
            marginBottom: insets.bottom,
            backgroundColor: isAuthenticated ? '#09090b' : palette.canvas,
          },
        ]}
      >
        {isAuthenticated && config ? (
          <MobileMapScreen config={config} onSignedOut={onSignedOut} />
        ) : (
          <QrOnboardingScreen
            initialServerUrl={config?.serverUrl ?? null}
            pendingInviteUrl={pendingInviteUrl}
            persistentToast={persistentRemovedToast}
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
  const [pendingInviteUrl, setPendingInviteUrl] = useState<string | null>(null);
  const [persistentRemovedToast, setPersistentRemovedToast] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getStoredConfig()
      .then((cfg) => {
        if (active) setConfig(cfg);
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
        pendingInviteUrl={pendingInviteUrl}
        persistentRemovedToast={persistentRemovedToast}
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
