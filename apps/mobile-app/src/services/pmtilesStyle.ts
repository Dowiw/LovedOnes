import type { StyleSpecification } from '@maplibre/maplibre-react-native';

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
): StyleSpecification {
  const cleanServer = serverUrl.replace(/\/$/, '');
  const pmtilesUrl = buildPmtilesSourceUrl(serverUrl, localFileUri);
  return {
    version: 8,
    name: 'LovedOnes Mobile PMTiles Style',
    glyphs: `${cleanServer}/tiles/fonts/{fontstack}/{range}.pbf`,
    sources: {
      openmaptiles: {
        type: 'vector',
        url: pmtilesUrl,
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#cfe3ee',
        },
      },
      {
        id: 'earth',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'earth',
        paint: {
          'fill-color': '#f3f2ed',
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
          'fill-color': '#eeede7',
          'fill-opacity': 0.65,
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
          'fill-color': '#d5e8ce',
          'fill-opacity': 0.82,
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': '#bfe0f0',
        },
      },
      {
        id: 'water-lines',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#bfe0f0',
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
          'fill-color': '#e6e4dd',
          'fill-outline-color': '#d6d3cb',
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
          'line-color': '#d4d8dd',
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
          'line-color': ['match', ['get', 'kind'], 'highway', '#ffffff', 'major_road', '#ffffff', '#fafaf9'],
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
        id: 'water-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water',
        minzoom: 11,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 12],
          'symbol-spacing': 380,
        },
        paint: {
          'text-color': '#4b7b94',
          'text-halo-color': 'rgba(232, 245, 251, 0.92)',
          'text-halo-width': 1.6,
        },
      },
      {
        id: 'road-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'roads',
        minzoom: 12,
        filter: ['all', ['!', ['in', ['get', 'kind'], ['literal', ['rail', 'path']]]], ['has', 'name']],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 11.5, 17, 13.5],
          'text-max-angle': 45,
          'symbol-spacing': 200,
        },
        paint: {
          'text-color': '#3f444e',
          'text-halo-color': 'rgba(255, 255, 255, 0.94)',
          'text-halo-width': 1.8,
        },
      },
      {
        id: 'pois-landmarks-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'pois',
        minzoom: 13,
        filter: [
          'all',
          [
            'in',
            ['get', 'kind'],
            ['literal', ['park', 'recreation_ground', 'station', 'university', 'hospital', 'museum', 'attraction']],
          ],
          ['has', 'name'],
        ],
        layout: {
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['PlusJakartaSans-Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 16, 12],
          'text-max-width': 9,
        },
        paint: {
          'text-color': '#475569',
          'text-halo-color': 'rgba(255, 255, 255, 0.92)',
          'text-halo-width': 1.6,
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
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['PlusJakartaSans-Medium'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 14, 13.5],
          'text-max-width': 9,
        },
        paint: {
          'text-color': '#475569',
          'text-halo-color': 'rgba(255, 255, 255, 0.94)',
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
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['PlusJakartaSans-SemiBold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 10, 15, 13, 18],
          'text-max-width': 8,
        },
        paint: {
          'text-color': '#18181b',
          'text-halo-color': 'rgba(255, 255, 255, 0.96)',
          'text-halo-width': 2.2,
        },
      },
    ],
  };
}

export async function getCachedRegionPmtilesUri(): Promise<string | null> {
  const { File, Paths } = await import('expo-file-system');
  const localFile = new File(Paths.document, 'region.pmtiles');
  return localFile.exists ? localFile.uri : null;
}

export async function downloadOfflineRegionPmtiles(serverUrl: string): Promise<string> {
  const { File, Paths } = await import('expo-file-system');
  const cleanServer = serverUrl.replace(/\/$/, '');
  const destination = new File(Paths.document, 'region.pmtiles');
  const downloaded = await File.downloadFileAsync(
    `${cleanServer}/tiles/region.pmtiles`,
    destination,
    { idempotent: true },
  );
  return downloaded.uri;
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
