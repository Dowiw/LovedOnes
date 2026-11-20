import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import './src/services/backgroundLocation';
import { MobileMapScreen } from './src/screens/MobileMapScreen';
import { QrOnboardingScreen } from './src/screens/QrOnboardingScreen';
import { SafeAreaProvider } from './src/services/safeArea';
import { getStoredConfig, MobileStoredConfig } from './src/services/secureConfig';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<MobileStoredConfig | null>(null);

  useEffect(() => {
    void getStoredConfig()
      .then((cfg) => {
        setConfig(cfg);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <SafeAreaProvider>
        <View style={styles.loader}>
          <StatusBar style="light" />
          <ActivityIndicator color="#10b981" size="large" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="light" />
        {config?.accessToken && config.serverUrl ? (
          <MobileMapScreen
            config={config}
            onSignedOut={() =>
              setConfig({
                serverUrl: null,
                accessToken: null,
                refreshToken: null,
                user: null,
                activeGroupId: null,
              })
            }
          />
        ) : (
          <QrOnboardingScreen onAuthenticated={setConfig} />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#020617' },
  loader: {
    flex: 1,
    backgroundColor: '#020617',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
