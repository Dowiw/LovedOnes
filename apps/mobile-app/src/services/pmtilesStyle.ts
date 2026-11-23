import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { MobileMapThemePreference } from './secureConfig';

export type MapLabelLanguage = 'en' | 'local';
export type ResolvedMobileMapTheme = 'light' | 'dark';

export function resolveMobileMapTheme(
  preference: MobileMapThemePreference,
  systemScheme: 'light' | 'dark' | null | undefined,
): ResolvedMobileMapTheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return systemScheme === 'dark' ? 'dark' : 'light';
}

const MOBILE_MAP_PALETTES = {
  light: {
    background: '#cfe3ee',
    earth: '#f3f2ed',
    landuseUrban: '#eeede7',
    landuseUrbanOpacity: 0.65,
    landuseGreen: '#d5e8ce',
    landuseGreenOpacity: 0.82,
    water: '#bfe0f0',
    buildings: '#e6e4dd',
    buildingsOutline: '#d6d3cb',
    roadsCasing: '#d4d8dd',
    roadsMajor: '#ffffff',
    roadsMinor: '#fafaf9',
    roadsPath: '#dcdad3',
    roadsRail: '#94a3b8',
    housenumbers: '#94a3b8',
    housenumbersHalo: 'rgba(255, 255, 255, 0.85)',
    foodText: '#9a5828',
    retailText: '#356299',
    waterText: '#4b7b94',
    waterHalo: 'rgba(232, 245, 251, 0.92)',
    roadMinorText: '#525866',
    roadMajorText: '#3f444e',
    parkText: '#456847',
    healthLocalText: '#c23648',
    civicText: '#475569',
    landmarkText: '#2c5b8c',
    healthMajorText: '#be123c',
    neighborhoodText: '#475569',
    cityText: '#18181b',
    labelHalo: 'rgba(255, 255, 255, 0.94)',
    labelHaloStrong: 'rgba(255, 255, 255, 0.96)',
  },
  dark: {
    background: '#0c141d',
    earth: '#111318',
    landuseUrban: '#161920',
    landuseUrbanOpacity: 0.78,
    landuseGreen: '#132019',
    landuseGreenOpacity: 0.88,
    water: '#0c1c2c',
    buildings: '#1c2028',
    buildingsOutline: '#272c37',
    roadsCasing: '#1f242e',
    roadsMajor: '#475569',
    roadsMinor: '#282e39',
    roadsPath: '#2e3440',
    roadsRail: '#64748b',
    housenumbers: '#71717a',
    housenumbersHalo: 'rgba(17, 19, 24, 0.9)',
    foodText: '#fdba74',
    retailText: '#93c5fd',
    waterText: '#7dd3fc',
    waterHalo: 'rgba(12, 28, 44, 0.92)',
    roadMinorText: '#9ca3af',
    roadMajorText: '#e4e4e7',
    parkText: '#86efac',
    healthLocalText: '#fda4af',
    civicText: '#cbd5e1',
    landmarkText: '#93c5fd',
    healthMajorText: '#fb7185',
    neighborhoodText: '#cbd5e1',
    cityText: '#f4f4f5',
    labelHalo: 'rgba(17, 19, 24, 0.92)',
    labelHaloStrong: 'rgba(17, 19, 24, 0.96)',
  },
} as const;

export function buildPmtilesSourceUrl(serverUrl: string, localFileUri?: string | null): string {
  if (localFileUri && localFileUri.trim().length > 0) {
    const normalized = localFileUri.startsWith('file://')
      ? localFileUri
      : `file://${localFileUri}`;
    return `pmtiles://${normalized}`;
  }
  const cleanServer = serverUrl.replace(/\/$/, '');
  return `pmtiles://${cleanServer}/tiles/region.pmtiles`;
}

export function buildMobileMapStyle(
  serverUrl: string,
  localFileUri?: string | null,
  labelLanguage: MapLabelLanguage = 'en',
  useCompositeServerTiles = false,
  mapTheme: ResolvedMobileMapTheme = 'light',
): StyleSpecification {
  const palette = MOBILE_MAP_PALETTES[mapTheme];
  const cleanServer = serverUrl.replace(/\/$/, '');
  const pmtilesUrl = buildPmtilesSourceUrl(serverUrl, localFileUri);
  const openmaptilesSource =
    useCompositeServerTiles && !localFileUri
      ? {
          type: 'vector' as const,
          tiles: [`${cleanServer}/api/maps/tiles/{z}/{x}/{y}.pbf`],
          minzoom: 0,
          maxzoom: 15,
        }
      : {
          type: 'vector' as const,
          url: pmtilesUrl,
        };
  const labelTextField: ['coalesce', ['get', string], ['get', string]] =
    labelLanguage === 'local'
      ? ['coalesce', ['get', 'name'], ['get', 'name:en']]
      : ['coalesce', ['get', 'name:en'], ['get', 'name']];
  return {
    version: 8,
    name: 'LovedOnes Mobile PMTiles Style',
    sprite: `${cleanServer}/tiles/sprites/maki`,
    glyphs: `${cleanServer}/tiles/fonts/{fontstack}/{range}.pbf`,
    sources: {
      openmaptiles: openmaptilesSource,
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': palette.background,
        },
      },
      {
        id: 'earth',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'earth',
        paint: {
          'fill-color': palette.earth,
        },
      },
      {
        id: 'landuse-urban',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        filter: [
          'in',
          ['get', 'kind'],
          ['literal', ['residential', 'commercial', 'industrial', 'university', 'hospital', 'school', 'college']],
        ],
        paint: {
          'fill-color': palette.landuseUrban,
          'fill-opacity': palette.landuseUrbanOpacity,
        },
      },
      {
        id: 'landuse-green',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        filter: [
          'in',
          ['get', 'kind'],
          [
            'literal',
            ['park', 'grass', 'wood', 'scrub', 'meadow', 'recreation_ground', 'garden', 'playground', 'pitch', 'cemetery', 'farmland'],
          ],
        ],
        paint: {
          'fill-color': palette.landuseGreen,
          'fill-opacity': palette.landuseGreenOpacity,
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': palette.water,
        },
      },
      {
        id: 'water-lines',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': palette.water,
          'line-width': ['match', ['get', 'kind'], 'river', 3.2, 'canal', 2.4, 1.2],
        },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'buildings',
        minzoom: 13,
        paint: {
          'fill-color': palette.buildings,
          'fill-outline-color': palette.buildingsOutline,
        },
      },
      {
        id: 'roads-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'roads',
        filter: ['!', ['in', ['get', 'kind'], ['literal', ['rail', 'path']]]],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': palette.roadsCasing,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            ['match', ['get', 'kind'], 'highway', 3.2, 'major_road', 2.0, 0.8],
            15,
            ['match', ['get', 'kind'], 'highway', 8.5, 'major_road', 6.2, 4.2],
          ],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'roads',
        filter: ['!', ['in', ['get', 'kind'], ['literal', ['rail', 'path']]]],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'highway',
            palette.roadsMajor,
            'major_road',
            palette.roadsMajor,
            palette.roadsMinor,
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            ['match', ['get', 'kind'], 'highway', 2.0, 'major_road', 1.2, 0.4],
            15,
            ['match', ['get', 'kind'], 'highway', 6.5, 'major_road', 4.6, 2.8],
          ],
        },
      },
      {
        id: 'roads-paths',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'path'],
        minzoom: 14,
        paint: {
          'line-color': palette.roadsPath,
          'line-dasharray': [2, 2],
          'line-width': 1.0,
        },
      },
      {
        id: 'roads-rail',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'rail'],
        minzoom: 11,
        paint: {
          'line-color': palette.roadsRail,
          'line-dasharray': [3, 3],
          'line-width': 1.3,
        },
      },
      {
        id: 'buildings-housenumbers',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'buildings',
        minzoom: 16.5,
        filter: ['has', 'addr_housenumber'],
        layout: {
          'text-field': ['get', 'addr_housenumber'],
          'text-font': ['PlusJakartaSans-Regular'],
          'text-size': 9.5,
        },
        paint: {
          'text-color': palette.housenumbers,
          'text-halo-color': palette.housenumbersHalo,
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'pois-food-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 14.5,
        filter: [
          'all',
          [
            'in',
            ['get', 'kind'],
            ['literal', ['restaurant', 'cafe', 'bakery', 'fast_food', 'bar', 'ice_cream', 'canteen']],
          ],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'cafe',
            'cafe',
            'bakery',
            'bakery',
            'fast_food',
            'fast-food',
            'bar',
            'bar',
            'ice_cream',
            'ice-cream',
            'restaurant',
          ],
          'icon-size': 0.78,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10, 17, 11.5],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.foodText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'pois-retail-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 13.8,
        filter: [
          'all',
          [
            'in',
            ['get', 'kind'],
            [
              'literal',
              [
                'supermarket',
                'mall',
                'convenience',
                'chemist',
                'department_store',
                'marketplace',
                'bank',
                'hotel',
                'furniture',
                'florist',
                'jewelry',
                'optician',
                'mobile_phone',
                'kiosk',
                'wine',
                'beverages',
                'commercial',
                'art',
                'gallery',
                'fitness_centre',
                'sports_centre',
                'sports_hall',
              ],
            ],
          ],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            ['supermarket', 'convenience', 'marketplace'],
            'grocery',
            'bank',
            'bank',
            'hotel',
            'lodging',
            'furniture',
            'furniture',
            'florist',
            'florist',
            'jewelry',
            'jewelry-store',
            ['art', 'gallery'],
            'art-gallery',
            'fitness_centre',
            'fitness-centre',
            ['sports_centre', 'sports_hall'],
            'soccer',
            'commercial',
            'commercial',
            'shop',
          ],
          'icon-size': 0.78,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13.8, 10, 17, 12],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.retailText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'water-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water',
        minzoom: 11,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']],
        layout: {
          'symbol-placement': 'line',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 12],
          'symbol-spacing': 520,
        },
        paint: {
          'text-color': palette.waterText,
          'text-halo-color': palette.waterHalo,
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'road-labels-minor',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'roads',
        minzoom: 14.5,
        filter: [
          'all',
          ['==', ['get', 'kind'], 'minor_road'],
          ['!', ['has', 'service']],
          ['has', 'name'],
        ],
        layout: {
          'symbol-placement': 'line',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10, 17, 12],
          'text-max-angle': 35,
          'text-padding': 18,
          'symbol-spacing': 620,
        },
        paint: {
          'text-color': palette.roadMinorText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.7,
        },
      },
      {
        id: 'road-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'roads',
        minzoom: 12,
        filter: [
          'all',
          ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
          ['!', ['has', 'service']],
          ['has', 'name'],
        ],
        layout: {
          'symbol-placement': 'line',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 11.5, 17, 13],
          'text-max-angle': 35,
          'text-padding': 16,
          'symbol-spacing': 560,
        },
        paint: {
          'text-color': palette.roadMajorText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.8,
        },
      },
      {
        id: 'pois-parks-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 12.5,
        filter: [
          'all',
          ['in', ['get', 'kind'], ['literal', ['park', 'recreation_ground', 'garden', 'wood', 'cemetery', 'beach', 'playground']]],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'garden',
            'garden',
            'cemetery',
            'cemetery',
            'beach',
            'beach',
            'playground',
            'playground',
            'park',
          ],
          'icon-size': 0.78,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10.5, 16, 12],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.parkText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'pois-health-local',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 14,
        filter: [
          'all',
          ['in', ['get', 'kind'], ['literal', ['pharmacy', 'doctors', 'dentist', 'medical_supply']]],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'pharmacy',
            'pharmacy',
            'dentist',
            'dentist',
            'doctor',
          ],
          'icon-size': 0.78,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 11.5],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.healthLocalText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'pois-civic-local',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 14.2,
        filter: [
          'all',
          ['in', ['get', 'kind'], ['literal', ['school', 'kindergarten', 'tram_stop', 'bus_stop', 'subway_entrance']]],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'tram_stop',
            'rail-light',
            'bus_stop',
            'bus',
            'subway_entrance',
            'rail-metro',
            'school',
          ],
          'icon-size': 0.78,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.2, 10, 17, 11.5],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.civicText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'pois-landmarks-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 12.5,
        filter: [
          'all',
          [
            'in',
            ['get', 'kind'],
            [
              'literal',
              [
                'station',
                'university',
                'college',
                'research_institute',
                'museum',
                'attraction',
                'historic',
                'library',
                'stadium',
                'police',
                'post_office',
                'place_of_worship',
                'church',
                'community_centre',
              ],
            ],
          ],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'station',
            'rail',
            ['university', 'college', 'research_institute'],
            'college',
            'museum',
            'museum',
            'library',
            'library',
            'police',
            'police',
            'post_office',
            'post',
            'historic',
            'monument',
            'stadium',
            'stadium',
            ['place_of_worship', 'church'],
            'place-of-worship',
            'community_centre',
            'town-hall',
            'attraction',
          ],
          'icon-size': 0.78,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10.5, 16, 12.5],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.landmarkText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.7,
        },
      },
      {
        id: 'pois-health-major',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 12.5,
        filter: [
          'all',
          ['in', ['get', 'kind'], ['literal', ['hospital', 'social_facility']]],
          ['has', 'name'],
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'kind'],
            'social_facility',
            'heart',
            'hospital',
          ],
          'icon-size': 0.82,
          'icon-anchor': 'bottom',
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-SemiBold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 10.5, 16, 12.5],
          'text-anchor': 'top',
          'text-offset': [0, 0.28],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.healthMajorText,
          'text-halo-color': palette.labelHaloStrong,
          'text-halo-width': 1.8,
        },
      },
      {
        id: 'places-neighborhoods',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'places',
        minzoom: 11,
        filter: ['!', ['in', ['get', 'kind'], ['literal', ['locality', 'country', 'region']]]],
        layout: {
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 14, 13.5],
          'text-max-width': 9,
        },
        paint: {
          'text-color': palette.neighborhoodText,
          'text-halo-color': palette.labelHalo,
          'text-halo-width': 1.9,
        },
      },
      {
        id: 'places-cities',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'places',
        minzoom: 3,
        filter: ['in', ['get', 'kind'], ['literal', ['locality', 'country', 'region']]],
        layout: {
          'text-field': labelTextField,
          'text-font': ['PlusJakartaSans-SemiBold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 10, 15, 13, 18],
          'text-max-width': 8,
        },
        paint: {
          'text-color': palette.cityText,
          'text-halo-color': palette.labelHaloStrong,
          'text-halo-width': 2.2,
        },
      },
    ],
  };
}

export interface OfflineCacheInfo {
  exists: boolean;
  uri: string | null;
  sizeBytes: number;
  lastModified: number | null;
}

export interface OfflineDownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  percent: number;
}

export function formatCacheBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(1)} ${units[idx]}`;
}

export async function getCachedRegionPmtilesUri(): Promise<string | null> {
  const { File, Paths } = await import('expo-file-system');
  const localFile = new File(Paths.document, 'region.pmtiles');
  return localFile.exists ? localFile.uri : null;
}

export async function getCachedRegionPmtilesInfo(
  localFilename = 'region.pmtiles',
): Promise<OfflineCacheInfo> {
  const { File, Paths } = await import('expo-file-system');
  const localFile = new File(Paths.document, localFilename);
  if (!localFile.exists) {
    return { exists: false, uri: null, sizeBytes: 0, lastModified: null };
  }
  return {
    exists: true,
    uri: localFile.uri,
    sizeBytes: Number.isFinite(localFile.size) ? localFile.size : 0,
    lastModified: localFile.lastModified ?? null,
  };
}

export async function deleteCachedRegionPmtiles(
  localFilename = 'region.pmtiles',
): Promise<void> {
  const { File, Paths } = await import('expo-file-system');
  const localFile = new File(Paths.document, localFilename);
  if (localFile.exists) {
    localFile.delete();
  }
}

export async function estimateOfflineRegionSize(
  serverUrl: string,
  regionUrl = '/tiles/region.pmtiles',
  fallbackSizeBytes?: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const cleanServer = serverUrl.replace(/\/$/, '');
  const cleanRegionUrl = regionUrl.startsWith('/') ? regionUrl : `/${regionUrl}`;
  try {
    const res = await fetchImpl(`${cleanServer}${cleanRegionUrl}`, { method: 'HEAD' });
    if (res.ok) {
      const rawLen = res.headers.get('content-length');
      const parsed = rawLen ? Number.parseInt(rawLen, 10) : Number.NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch {
    // Fall back to known region metadata if HEAD fails or is blocked
  }
  return typeof fallbackSizeBytes === 'number' && fallbackSizeBytes > 0 ? fallbackSizeBytes : null;
}

export async function downloadOfflineRegionPmtilesWithProgress(options: {
  serverUrl: string;
  regionUrl?: string;
  localFilename?: string;
  expectedBytes?: number | null;
  onProgress?: (progress: OfflineDownloadProgress) => void;
  signal?: AbortSignal;
}): Promise<{ uri: string; sizeBytes: number }> {
  const { File, Paths } = await import('expo-file-system');
  const cleanServer = options.serverUrl.replace(/\/$/, '');
  const regionPath = options.regionUrl ?? '/tiles/region.pmtiles';
  const cleanRegionUrl = regionPath.startsWith('/') ? regionPath : `/${regionPath}`;
  const destination = new File(Paths.document, options.localFilename ?? 'region.pmtiles');

  try {
    const downloaded = await File.downloadFileAsync(
      `${cleanServer}${cleanRegionUrl}`,
      destination,
      {
        idempotent: true,
        signal: options.signal,
        onProgress: (data) => {
          const totalBytes =
            data.totalBytes > 0 ? data.totalBytes : (options.expectedBytes ?? 0);
          const percent =
            totalBytes > 0
              ? Math.min(100, Math.max(0, Math.round((data.bytesWritten / totalBytes) * 100)))
              : 0;
          options.onProgress?.({
            bytesWritten: data.bytesWritten,
            totalBytes,
            percent,
          });
        },
      },
    );
    return {
      uri: downloaded.uri,
      sizeBytes: Number.isFinite(downloaded.size) ? downloaded.size : 0,
    };
  } catch (err) {
    if (options.signal?.aborted) {
      try {
        if (destination.exists) destination.delete();
      } catch {
        // ignore cleanup failure
      }
      throw new Error('Download cancelled');
    }
    throw err;
  }
}

export async function downloadOfflineRegionPmtiles(
  serverUrl: string,
  regionUrl = '/tiles/region.pmtiles',
  localFilename = 'region.pmtiles',
): Promise<string> {
  const res = await downloadOfflineRegionPmtilesWithProgress({
    serverUrl,
    regionUrl,
    localFilename,
  });
  return res.uri;
}

export async function checkForOtaUpdate(): Promise<{ updated: boolean; message: string }> {
  const Updates = await import('expo-updates');
  if (!Updates.isEnabled) {
    return { updated: false, message: 'OTA updates disabled in dev build' };
  }
  const check = await Updates.checkForUpdateAsync();
  if (!check.isAvailable) {
    return { updated: false, message: 'Already running latest bundle' };
  }
  await Updates.fetchUpdateAsync();
  await Updates.reloadAsync();
  return { updated: true, message: 'Update downloaded and reloading' };
}
