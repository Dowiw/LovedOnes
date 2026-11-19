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
  const pmtilesUrl = buildPmtilesSourceUrl(serverUrl, localFileUri);
  return {
    version: 8,
    name: 'LovedOnes Mobile PMTiles Style',
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
          'background-color': '#0b1120',
        },
      },
      {
        id: 'earth',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'earth',
        paint: {
          'fill-color': '#0f172a',
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: {
          'fill-color': '#1e3a5f',
        },
      },
      {
        id: 'landuse',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        paint: {
          'fill-color': '#132238',
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'roads',
        paint: {
          'line-color': '#475569',
          'line-width': 1.2,
        },
      },
      {
        id: 'buildings',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'buildings',
        paint: {
          'fill-color': '#1e293b',
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
