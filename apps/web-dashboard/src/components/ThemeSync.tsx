'use client';

import { useEffect } from 'react';
import {
  applyDocumentTheme,
  MAP_THEME_STORAGE_KEY,
  readStoredThemePreference,
  resolveMapTheme,
  THEME_CHANGE_EVENT,
} from '@/lib/mapTheme';

export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      const pref = readStoredThemePreference();
      applyDocumentTheme(resolveMapTheme(pref, media.matches));
    };

    sync();

    const onMediaChange = () => sync();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === MAP_THEME_STORAGE_KEY) sync();
    };
    const onThemeEvent = () => sync();

    media.addEventListener('change', onMediaChange);
    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_CHANGE_EVENT, onThemeEvent);
    return () => {
      media.removeEventListener('change', onMediaChange);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeEvent);
    };
  }, []);

  return null;
}
