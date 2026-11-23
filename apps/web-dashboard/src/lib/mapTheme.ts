export type MapThemePreference = 'system' | 'light' | 'dark';
export type ResolvedMapTheme = 'light' | 'dark';

export const MAP_THEME_STORAGE_KEY = 'lovedones_map_theme_v1';
export const THEME_CHANGE_EVENT = 'lovedones:theme-change';

export function parseMapThemePreference(raw: string | null | undefined): MapThemePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') {
    return raw;
  }
  return 'system';
}

export function resolveMapTheme(
  preference: MapThemePreference,
  systemPrefersDark: boolean,
): ResolvedMapTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}

export function readStoredThemePreference(): MapThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    return parseMapThemePreference(window.localStorage.getItem(MAP_THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function applyDocumentTheme(resolved: ResolvedMapTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = resolved;
  root.dataset.mapTheme = resolved;
  root.style.colorScheme = resolved;
}

export function persistThemePreference(pref: MapThemePreference): ResolvedMapTheme {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(MAP_THEME_STORAGE_KEY, pref);
    } catch {
      // ignore storage quota errors
    }
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const resolved = resolveMapTheme(pref, systemDark);
    applyDocumentTheme(resolved);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { pref, resolved } }));
    return resolved;
  }
  return resolveMapTheme(pref, false);
}

export interface MapLayerPaintOverride {
  layerId: string;
  property: string;
  value: unknown;
}

const LIGHT_MAP_PAINT_OVERRIDES: MapLayerPaintOverride[] = [
  { layerId: 'fallback-bg', property: 'background-color', value: '#e9eff3' },
  { layerId: 'background', property: 'background-color', value: '#cfe3ee' },
  { layerId: 'earth', property: 'fill-color', value: '#f3f2ed' },
  { layerId: 'landuse-urban', property: 'fill-color', value: '#eeede7' },
  { layerId: 'landuse-urban', property: 'fill-opacity', value: 0.65 },
  { layerId: 'landuse-green', property: 'fill-color', value: '#d5e8ce' },
  { layerId: 'landuse-green', property: 'fill-opacity', value: 0.82 },
  { layerId: 'water', property: 'fill-color', value: '#bfe0f0' },
  { layerId: 'water-lines', property: 'line-color', value: '#bfe0f0' },
  { layerId: 'buildings', property: 'fill-color', value: '#e6e4dd' },
  { layerId: 'buildings', property: 'fill-outline-color', value: '#d6d3cb' },
  { layerId: 'roads-rail', property: 'line-color', value: '#94a3b8' },
  { layerId: 'roads-casing', property: 'line-color', value: '#d4d8dd' },
  {
    layerId: 'roads',
    property: 'line-color',
    value: ['match', ['get', 'kind'], 'highway', '#ffffff', 'major_road', '#ffffff', '#fafaf9'],
  },
  { layerId: 'roads-paths', property: 'line-color', value: '#dcdad3' },
  { layerId: 'boundaries', property: 'line-color', value: '#94a3b8' },
  { layerId: 'buildings-housenumbers', property: 'text-color', value: '#94a3b8' },
  { layerId: 'buildings-housenumbers', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.85)' },
  { layerId: 'pois-food-labels', property: 'text-color', value: '#9a5828' },
  { layerId: 'pois-food-labels', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'pois-retail-labels', property: 'text-color', value: '#356299' },
  { layerId: 'pois-retail-labels', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'water-labels', property: 'text-color', value: '#4b7b94' },
  { layerId: 'water-labels', property: 'text-halo-color', value: 'rgba(232, 245, 251, 0.92)' },
  { layerId: 'road-labels-minor', property: 'text-color', value: '#525866' },
  { layerId: 'road-labels-minor', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'road-labels', property: 'text-color', value: '#3f444e' },
  { layerId: 'road-labels', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'pois-parks-labels', property: 'text-color', value: '#456847' },
  { layerId: 'pois-parks-labels', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.92)' },
  { layerId: 'pois-health-local', property: 'text-color', value: '#c23648' },
  { layerId: 'pois-health-local', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'pois-civic-local', property: 'text-color', value: '#475569' },
  { layerId: 'pois-civic-local', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'pois-landmarks-labels', property: 'text-color', value: '#2c5b8c' },
  { layerId: 'pois-landmarks-labels', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'pois-health-major', property: 'text-color', value: '#be123c' },
  { layerId: 'pois-health-major', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.96)' },
  { layerId: 'places-neighborhoods', property: 'text-color', value: '#475569' },
  { layerId: 'places-neighborhoods', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.94)' },
  { layerId: 'places-cities', property: 'text-color', value: '#18181b' },
  { layerId: 'places-cities', property: 'text-halo-color', value: 'rgba(255, 255, 255, 0.96)' },
  { layerId: 'lovedones-trails-line', property: 'line-color', value: '#18181b' },
  { layerId: 'lovedones-trails-direct-line', property: 'line-color', value: '#18181b' },
  { layerId: 'lovedones-trails-spur-line', property: 'line-color', value: '#52525b' },
  { layerId: 'lovedones-trails-chevrons', property: 'icon-color', value: '#ffffff' },
  { layerId: 'lovedones-trails-chevrons', property: 'icon-halo-color', value: '#18181b' },
  { layerId: 'lovedones-trails-pts', property: 'circle-color', value: '#ffffff' },
  { layerId: 'lovedones-trails-pts', property: 'circle-stroke-color', value: '#18181b' },
];

const DARK_MAP_PAINT_OVERRIDES: MapLayerPaintOverride[] = [
  { layerId: 'fallback-bg', property: 'background-color', value: '#111318' },
  { layerId: 'background', property: 'background-color', value: '#0c141d' },
  { layerId: 'earth', property: 'fill-color', value: '#111318' },
  { layerId: 'landuse-urban', property: 'fill-color', value: '#161920' },
  { layerId: 'landuse-urban', property: 'fill-opacity', value: 0.78 },
  { layerId: 'landuse-green', property: 'fill-color', value: '#132019' },
  { layerId: 'landuse-green', property: 'fill-opacity', value: 0.88 },
  { layerId: 'water', property: 'fill-color', value: '#0c1c2c' },
  { layerId: 'water-lines', property: 'line-color', value: '#0c1c2c' },
  { layerId: 'buildings', property: 'fill-color', value: '#1c2028' },
  { layerId: 'buildings', property: 'fill-outline-color', value: '#272c37' },
  { layerId: 'roads-rail', property: 'line-color', value: '#64748b' },
  { layerId: 'roads-casing', property: 'line-color', value: '#1f242e' },
  {
    layerId: 'roads',
    property: 'line-color',
    value: ['match', ['get', 'kind'], 'highway', '#475569', 'major_road', '#384152', '#282e39'],
  },
  { layerId: 'roads-paths', property: 'line-color', value: '#2e3440' },
  { layerId: 'boundaries', property: 'line-color', value: '#475569' },
  { layerId: 'buildings-housenumbers', property: 'text-color', value: '#71717a' },
  { layerId: 'buildings-housenumbers', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.9)' },
  { layerId: 'pois-food-labels', property: 'text-color', value: '#fdba74' },
  { layerId: 'pois-food-labels', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.92)' },
  { layerId: 'pois-retail-labels', property: 'text-color', value: '#93c5fd' },
  { layerId: 'pois-retail-labels', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.92)' },
  { layerId: 'water-labels', property: 'text-color', value: '#7dd3fc' },
  { layerId: 'water-labels', property: 'text-halo-color', value: 'rgba(12, 28, 44, 0.92)' },
  { layerId: 'road-labels-minor', property: 'text-color', value: '#9ca3af' },
  { layerId: 'road-labels-minor', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.94)' },
  { layerId: 'road-labels', property: 'text-color', value: '#e4e4e7' },
  { layerId: 'road-labels', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.94)' },
  { layerId: 'pois-parks-labels', property: 'text-color', value: '#86efac' },
  { layerId: 'pois-parks-labels', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.92)' },
  { layerId: 'pois-health-local', property: 'text-color', value: '#fda4af' },
  { layerId: 'pois-health-local', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.92)' },
  { layerId: 'pois-civic-local', property: 'text-color', value: '#cbd5e1' },
  { layerId: 'pois-civic-local', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.92)' },
  { layerId: 'pois-landmarks-labels', property: 'text-color', value: '#93c5fd' },
  { layerId: 'pois-landmarks-labels', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.92)' },
  { layerId: 'pois-health-major', property: 'text-color', value: '#fb7185' },
  { layerId: 'pois-health-major', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.94)' },
  { layerId: 'places-neighborhoods', property: 'text-color', value: '#cbd5e1' },
  { layerId: 'places-neighborhoods', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.94)' },
  { layerId: 'places-cities', property: 'text-color', value: '#f4f4f5' },
  { layerId: 'places-cities', property: 'text-halo-color', value: 'rgba(17, 19, 24, 0.96)' },
  { layerId: 'lovedones-trails-line', property: 'line-color', value: '#f4f4f5' },
  { layerId: 'lovedones-trails-direct-line', property: 'line-color', value: '#f4f4f5' },
  { layerId: 'lovedones-trails-spur-line', property: 'line-color', value: '#a1a1aa' },
  { layerId: 'lovedones-trails-chevrons', property: 'icon-color', value: '#09090b' },
  { layerId: 'lovedones-trails-chevrons', property: 'icon-halo-color', value: '#f4f4f5' },
  { layerId: 'lovedones-trails-pts', property: 'circle-color', value: '#09090b' },
  { layerId: 'lovedones-trails-pts', property: 'circle-stroke-color', value: '#f4f4f5' },
];

export function getMapPaintOverrides(theme: ResolvedMapTheme): readonly MapLayerPaintOverride[] {
  return theme === 'dark' ? DARK_MAP_PAINT_OVERRIDES : LIGHT_MAP_PAINT_OVERRIDES;
}
