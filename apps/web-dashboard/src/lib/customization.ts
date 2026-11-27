'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_USER_CUSTOMIZATION,
  getUserCustomizationStorageKey,
  parseUserCustomization,
  resolveActivityColors,
  resolveInterfaceThemeTokens,
  USER_CUSTOMIZATION_STORAGE_PREFIX,
  type ActivityColorsMap,
  type ResolvedInterfaceTokens,
  type UserCustomization,
} from '@loved-ones/shared';
import { loadSession } from './api';
import { readStoredThemePreference, resolveMapTheme, type ResolvedMapTheme } from './mapTheme';

export const USER_CUSTOMIZATION_EVENT = 'lovedones:user-customization-changed';

export function readUserCustomization(userId: string | null | undefined): UserCustomization {
  if (!userId || typeof window === 'undefined') {
    return DEFAULT_USER_CUSTOMIZATION;
  }
  try {
    const raw = window.localStorage.getItem(getUserCustomizationStorageKey(userId));
    return parseUserCustomization(raw);
  } catch {
    return DEFAULT_USER_CUSTOMIZATION;
  }
}

export function persistUserCustomization(
  userId: string,
  next: UserCustomization,
): UserCustomization {
  const safe = parseUserCustomization(JSON.stringify(next));
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(getUserCustomizationStorageKey(userId), JSON.stringify(safe));
    } catch {
      // ignore storage quota errors
    }
    window.dispatchEvent(
      new CustomEvent(USER_CUSTOMIZATION_EVENT, { detail: { userId, customization: safe } }),
    );
  }
  return safe;
}

export function clearUserCustomization(userId: string): UserCustomization {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(getUserCustomizationStorageKey(userId));
    } catch {
      // ignore
    }
    window.dispatchEvent(
      new CustomEvent(USER_CUSTOMIZATION_EVENT, {
        detail: { userId, customization: DEFAULT_USER_CUSTOMIZATION },
      }),
    );
  }
  return DEFAULT_USER_CUSTOMIZATION;
}

export function applyDocumentCustomization(
  prefs: UserCustomization,
  scheme: ResolvedMapTheme,
): ResolvedInterfaceTokens {
  const tokens = resolveInterfaceThemeTokens(prefs, scheme);
  if (typeof document === 'undefined') return tokens;

  const root = document.documentElement;
  const style = root.style;

  style.setProperty('--lo-accent', tokens.accentBg);
  style.setProperty('--lo-accent-fg', tokens.accentFg);
  style.setProperty('--lo-accent-hover', tokens.accentHoverBg);
  style.setProperty('--lo-accent-soft', tokens.accentSoftBg);
  style.setProperty('--lo-accent-soft-text', tokens.accentSoftText);
  style.setProperty('--lo-accent-border', tokens.accentBorder);
  style.setProperty('--lo-surface-wash', tokens.surfaceBg);
  style.setProperty('--lo-surface-muted', tokens.surfaceMutedBg);
  style.setProperty('--lo-canvas-wash', tokens.canvasBg);
  style.setProperty('--lo-border-wash', tokens.borderColor);
  style.setProperty('--lo-radius-card', `${tokens.cornerPx.card}px`);
  style.setProperty('--lo-radius-control', `${tokens.cornerPx.control}px`);
  style.setProperty('--lo-radius-pill', `${tokens.cornerPx.pill}px`);
  style.setProperty('--lo-blur-px', prefs.visualStyle.glassBlur ? '20px' : '0px');

  root.dataset.loCustomTheme = tokens.isDefaultMonochrome ? 'off' : 'on';
  root.dataset.loSurfaceWash = prefs.surfaceWash;
  root.dataset.loCorner = prefs.visualStyle.cornerStyle;
  root.dataset.loDensity = prefs.visualStyle.density;
  root.dataset.loGlass = prefs.visualStyle.glassBlur ? 'on' : 'off';
  root.dataset.loReducedMotion = prefs.visualStyle.reducedMotion ? 'on' : 'off';
  root.dataset.loChatBubble = prefs.mapAccents.chatBubbleStyle;

  return tokens;
}

export function syncActiveDocumentCustomization(prefersDarkOverride?: boolean): UserCustomization {
  if (typeof window === 'undefined') return DEFAULT_USER_CUSTOMIZATION;
  const activeSession = loadSession();
  const prefs = readUserCustomization(activeSession?.user.id ?? null);
  const prefersDark =
    typeof prefersDarkOverride === 'boolean'
      ? prefersDarkOverride
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const scheme = resolveMapTheme(readStoredThemePreference(), prefersDark);
  applyDocumentCustomization(prefs, scheme);
  return prefs;
}

export function isCustomizationStorageKey(key: string | null): boolean {
  return Boolean(key && key.startsWith(USER_CUSTOMIZATION_STORAGE_PREFIX));
}

export interface UseUserCustomizationResult {
  customization: UserCustomization;
  activityColors: ActivityColorsMap;
  updateCustomization: (updater: (prev: UserCustomization) => UserCustomization) => void;
  resetCustomization: () => void;
}

export function useUserCustomization(
  userId: string | null | undefined,
  scheme: ResolvedMapTheme,
): UseUserCustomizationResult {
  const [customization, setCustomization] = useState<UserCustomization>(() =>
    readUserCustomization(userId),
  );

  useEffect(() => {
    const next = readUserCustomization(userId);
    setCustomization(next);
    applyDocumentCustomization(next, scheme);
  }, [userId, scheme]);

  useEffect(() => {
    const onCustomEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<{ userId?: string }>).detail;
      if (!userId || !detail?.userId || detail.userId === userId) {
        const next = readUserCustomization(userId);
        setCustomization(next);
        applyDocumentCustomization(next, scheme);
      }
    };
    const onStorage = (evt: StorageEvent) => {
      if (!evt.key || isCustomizationStorageKey(evt.key)) {
        const next = readUserCustomization(userId);
        setCustomization(next);
        applyDocumentCustomization(next, scheme);
      }
    };
    window.addEventListener(USER_CUSTOMIZATION_EVENT, onCustomEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(USER_CUSTOMIZATION_EVENT, onCustomEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, scheme]);

  const updateCustomization = useCallback(
    (updater: (prev: UserCustomization) => UserCustomization) => {
      setCustomization((prev) => {
        const draft = updater(prev);
        const applied = userId
          ? persistUserCustomization(userId, draft)
          : parseUserCustomization(JSON.stringify(draft));
        applyDocumentCustomization(applied, scheme);
        return applied;
      });
    },
    [userId, scheme],
  );

  const resetCustomization = useCallback(() => {
    const next = userId ? clearUserCustomization(userId) : DEFAULT_USER_CUSTOMIZATION;
    setCustomization(next);
    applyDocumentCustomization(next, scheme);
  }, [userId, scheme]);

  const activityColors = useMemo(() => resolveActivityColors(customization), [customization]);

  return {
    customization,
    activityColors,
    updateCustomization,
    resetCustomization,
  };
}
