import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import './src/services/backgroundLocation';
import { MobileMapScreen } from './src/screens/MobileMapScreen';
import { QrOnboardingScreen } from './src/screens/QrOnboardingScreen';
import { getOnboardingPalette } from './src/services/onboardingTheme';
import { SafeAreaProvider } from './src/services/safeArea';
import {
  extractInviteCandidateFromUrl,
  getStoredConfig,
  MobileStoredConfig,
} from './src/services/secureConfig';

export default function App() {
  const colorScheme = useColorScheme();
  const palette = getOnboardingPalette(colorScheme);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<MobileStoredConfig | null>(null);
  const [pendingInviteUrl, setPendingInviteUrl] = useState<string | null>(null);

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

  if (loading) {
    return (
      <SafeAreaProvider>
        <View style={[styles.loader, { backgroundColor: palette.canvas }]}>
          <StatusBar style={palette.statusBarStyle} />
          <ActivityIndicator color={palette.ink} size="large" />
        </View>
      </SafeAreaProvider>
    );
  }

  const isAuthenticated = Boolean(config?.accessToken && config.serverUrl);

  return (
    <SafeAreaProvider>
      <View style={[styles.root, { backgroundColor: palette.canvas }]}>
        <StatusBar style={isAuthenticated ? 'light' : palette.statusBarStyle} />
        {isAuthenticated && config ? (
          <MobileMapScreen
            config={config}
            onSignedOut={() =>
              setConfig((prev) => ({
                serverUrl: prev?.serverUrl ?? null,
                accessToken: null,
                refreshToken: null,
                user: null,
                activeGroupId: null,
              }))
            }
          />
        ) : (
          <QrOnboardingScreen
            initialServerUrl={config?.serverUrl ?? null}
            pendingInviteUrl={pendingInviteUrl}
            onConsumePendingInvite={() => setPendingInviteUrl(null)}
            onAuthenticated={setConfig}
          />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
