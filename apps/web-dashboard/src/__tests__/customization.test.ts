import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_CUSTOMIZATION, getUserCustomizationStorageKey } from '@loved-ones/shared';
import {
  applyDocumentCustomization,
  clearUserCustomization,
  persistUserCustomization,
  readUserCustomization,
  USER_CUSTOMIZATION_EVENT,
} from '../lib/customization';

describe('per-user web customization storage & CSS variable sync', () => {
  it('isolates customization cache by userId, applies CSS vars, and reverts when signed out', () => {
    const store = new Map<string, string>();
    const cssProps = new Map<string, string>();
    const events: string[] = [];
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (k: string, v: string) => {
          cssProps.set(k, v);
        },
      },
    };

    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origCustomEvent = globalThis.CustomEvent;

    try {
      (globalThis as unknown as { document: unknown }).document = { documentElement: root };
      (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      };
      (globalThis as unknown as { window: unknown }).window = {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => {
            store.set(k, v);
          },
          removeItem: (k: string) => {
            store.delete(k);
          },
        },
        dispatchEvent: (ev: { type: string }) => {
          events.push(ev.type);
          return true;
        },
      };

      expect(readUserCustomization(null)).toEqual(DEFAULT_USER_CUSTOMIZATION);

      const userAPrefs = persistUserCustomization('user-a', {
        ...DEFAULT_USER_CUSTOMIZATION,
        themeMode: 'preset',
        interfacePreset: 'pink',
        activityPaletteId: 'neon',
        visualStyle: {
          cornerStyle: 'soft',
          density: 'compact',
          glassBlur: false,
          reducedMotion: true,
        },
      });

      expect(store.get(getUserCustomizationStorageKey('user-a'))).toBeTruthy();
      expect(readUserCustomization('user-a').interfacePreset).toBe('pink');
      expect(readUserCustomization('user-b').interfacePreset).toBe('default');
      expect(events).toContain(USER_CUSTOMIZATION_EVENT);

      const tokens = applyDocumentCustomization(userAPrefs, 'light');
      expect(cssProps.get('--lo-accent')).toBe('#ec4899');
      expect(tokens.isDefaultMonochrome).toBe(false);
      expect(root.dataset.loCustomTheme).toBe('on');
      expect(root.dataset.loCorner).toBe('soft');
      expect(root.dataset.loDensity).toBe('compact');
      expect(root.dataset.loGlass).toBe('off');
      expect(root.dataset.loReducedMotion).toBe('on');

      clearUserCustomization('user-a');
      const signedOutPrefs = readUserCustomization('user-a');
      expect(signedOutPrefs).toEqual(DEFAULT_USER_CUSTOMIZATION);
      applyDocumentCustomization(signedOutPrefs, 'dark');
      expect(root.dataset.loCustomTheme).toBe('off');
    } finally {
      (globalThis as unknown as { window: unknown }).window = origWindow;
      (globalThis as unknown as { document: unknown }).document = origDocument;
      (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = origCustomEvent;
    }
  });
});
