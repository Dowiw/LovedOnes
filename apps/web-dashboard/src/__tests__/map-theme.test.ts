import { describe, expect, it } from 'vitest';
import {
  getMapPaintOverrides,
  parseMapThemePreference,
  resolveMapTheme,
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
});
