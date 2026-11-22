import { describe, expect, it, vi } from 'vitest';
import {
  applyDocumentTheme,
  getMapPaintOverrides,
  MAP_THEME_STORAGE_KEY,
  parseMapThemePreference,
  persistThemePreference,
  readStoredThemePreference,
  resolveMapTheme,
  THEME_CHANGE_EVENT,
} from '../lib/mapTheme';

describe('map theme preference & night mode resolution', () => {
  it('defaults unknown values to system preference', () => {
    expect(parseMapThemePreference(null)).toBe('system');
    expect(parseMapThemePreference('invalid')).toBe('system');
    expect(parseMapThemePreference('system')).toBe('system');
    expect(parseMapThemePreference('light')).toBe('light');
    expect(parseMapThemePreference('dark')).toBe('dark');
  });

  it('resolves system mode from OS color scheme and honors explicit overrides', () => {
    expect(resolveMapTheme('system', true)).toBe('dark');
    expect(resolveMapTheme('system', false)).toBe('light');
    expect(resolveMapTheme('light', true)).toBe('light');
    expect(resolveMapTheme('dark', false)).toBe('dark');
  });

  it('provides matching layer paint overrides for both light and dark map themes', () => {
    const light = getMapPaintOverrides('light');
    const dark = getMapPaintOverrides('dark');

    expect(light.length).toBe(dark.length);
    expect(dark.find((o) => o.layerId === 'earth')?.value).toBe('#111318');
    expect(light.find((o) => o.layerId === 'earth')?.value).toBe('#f3f2ed');
    expect(dark.find((o) => o.layerId === 'lovedones-trails-line')?.value).toBe('#f4f4f5');
  });

  it('applies dark class and theme attributes to documentElement and persists preference', () => {
    const classSet = new Set<string>();
    const root = {
      classList: {
        toggle(cls: string, force?: boolean) {
          if (force) classSet.add(cls);
          else classSet.delete(cls);
        },
      },
      dataset: {} as Record<string, string>,
      style: { colorScheme: '' },
    };
    const store = new Map<string, string>();
    const dispatched: string[] = [];

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
        },
        matchMedia: vi.fn(() => ({ matches: true })),
        dispatchEvent: (ev: { type: string }) => {
          dispatched.push(ev.type);
          return true;
        },
      };

      expect(readStoredThemePreference()).toBe('system');
      expect(persistThemePreference('dark')).toBe('dark');
      expect(store.get(MAP_THEME_STORAGE_KEY)).toBe('dark');
      expect(classSet.has('dark')).toBe(true);
      expect(root.dataset.theme).toBe('dark');
      expect(root.dataset.mapTheme).toBe('dark');
      expect(root.style.colorScheme).toBe('dark');
      expect(dispatched).toContain(THEME_CHANGE_EVENT);

      applyDocumentTheme('light');
      expect(classSet.has('dark')).toBe(false);
      expect(root.dataset.theme).toBe('light');
      expect(root.style.colorScheme).toBe('light');
    } finally {
      (globalThis as unknown as { window: unknown }).window = origWindow;
      (globalThis as unknown as { document: unknown }).document = origDocument;
      (globalThis as unknown as { CustomEvent: unknown }).CustomEvent = origCustomEvent;
    }
  });
});
