import React, { createContext, useContext, useEffect, useState } from 'react';
import { Dimensions, Platform, StatusBar } from 'react-native';
import { computeSafeAreaInsets, type EdgeInsets } from './safeAreaMath';

export { computeSafeAreaInsets, type EdgeInsets };

function getCurrentDeviceInsets(): EdgeInsets {
  const screen = Dimensions.get('screen');
  const win = Dimensions.get('window');
  return computeSafeAreaInsets(
    Platform.OS,
    StatusBar.currentHeight ?? null,
    screen.height,
    win.height,
  );
}

const SafeAreaContext = createContext<EdgeInsets | null>(null);

export function SafeAreaProvider({ children }: { children: React.ReactNode }) {
  const [insets, setInsets] = useState<EdgeInsets>(() => getCurrentDeviceInsets());

  useEffect(() => {
    const refresh = () => {
      setInsets(getCurrentDeviceInsets());
    };
    refresh();
    const sub = Dimensions.addEventListener('change', refresh);
    return () => sub.remove();
  }, []);

  return <SafeAreaContext.Provider value={insets}>{children}</SafeAreaContext.Provider>;
}

export function useSafeAreaInsets(): EdgeInsets {
  const ctx = useContext(SafeAreaContext);
  return ctx ?? getCurrentDeviceInsets();
}
