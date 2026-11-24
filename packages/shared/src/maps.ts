import { z } from 'zod';

export const MapRegionSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  url: z.string(),
  minLon: z.number(),
  minLat: z.number(),
  maxLon: z.number(),
  maxLat: z.number(),
  minZoom: z.number().int(),
  maxZoom: z.number().int(),
  sizeBytes: z.number().int().nonnegative(),
  isStub: z.boolean(),
  isPrimary: z.boolean(),
  downloadedAt: z.string().nullable().optional(),
  sourceBuild: z.string().nullable().optional(),
});
export type MapRegion = z.infer<typeof MapRegionSchema>;

export const MapDownloadJobStatusSchema = z.enum([
  'queued',
  'resolving',
  'downloading',
  'completed',
  'failed',
]);
export type MapDownloadJobStatus = z.infer<typeof MapDownloadJobStatusSchema>;

export const MapDownloadJobSchema = z.object({
  id: z.string(),
  cityName: z.string(),
  displayName: z.string().nullable().optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  status: MapDownloadJobStatusSchema,
  progressPct: z.number().min(0).max(100),
  message: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  regionId: z.string().nullable().optional(),
  requestedBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MapDownloadJob = z.infer<typeof MapDownloadJobSchema>;

export const RequestMapDownloadSchema = z.object({
  latitude: z.number().min(-85).max(85),
  longitude: z.number().min(-180).max(180),
  cityName: z.string().trim().min(1).max(120).optional(),
  radiusKm: z.number().min(5).max(60).optional(),
});
export type RequestMapDownloadInput = z.infer<typeof RequestMapDownloadSchema>;

export const DEFAULT_CITY_RADIUS_KM = 20;
const KM_PER_DEG_LAT = 111.32;
const MAX_SPAN_LAT_DEG = 1.6;
const MAX_SPAN_LON_DEG = 2.4;
const MIN_PAD_LAT_DEG = 0.08;

export const WORLD_OVERVIEW_REGION_ID = 'world-overview';
export const WORLD_OVERVIEW_MAX_ZOOM = 5;

export function isWorldOverviewRegion(region: Pick<MapRegion, 'id' | 'maxZoom' | 'isStub'>): boolean {
  return !region.isStub && (region.id === WORLD_OVERVIEW_REGION_ID || region.maxZoom <= 6);
}

export function isRegionOperational(region: Pick<MapRegion, 'isStub' | 'maxZoom'>): boolean {
  return !region.isStub && region.maxZoom >= 12;
}

export function findCoveringRegions(
  latitude: number,
  longitude: number,
  regions: MapRegion[],
): MapRegion[] {
  return regions
    .filter(
      (r) =>
        isRegionOperational(r) &&
        longitude >= r.minLon &&
        longitude <= r.maxLon &&
        latitude >= r.minLat &&
        latitude <= r.maxLat,
    )
    .sort((a, b) => {
      const areaA = Math.max(0.0001, (a.maxLon - a.minLon) * (a.maxLat - a.minLat));
      const areaB = Math.max(0.0001, (b.maxLon - b.minLon) * (b.maxLat - b.minLat));
      if (areaA !== areaB) return areaA - areaB;
      return (b.downloadedAt ?? '').localeCompare(a.downloadedAt ?? '');
    });
}

export function isPointCoveredByRegions(
  latitude: number,
  longitude: number,
  regions: MapRegion[],
): boolean {
  return findCoveringRegions(latitude, longitude, regions).length > 0;
}

export function computeCityFallbackBbox(
  latitude: number,
  longitude: number,
  radiusKm = DEFAULT_CITY_RADIUS_KM,
): [number, number, number, number] {
  const latDelta = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  const lonDelta = radiusKm / (KM_PER_DEG_LAT * cosLat);
  return [
    Math.max(-180, Number((longitude - lonDelta).toFixed(5))),
    Math.max(-85, Number((latitude - latDelta).toFixed(5))),
    Math.min(180, Number((longitude + lonDelta).toFixed(5))),
    Math.min(85, Number((latitude + latDelta).toFixed(5))),
  ];
}

export function normalizeCityBbox(
  latitude: number,
  longitude: number,
  rawBbox?: [number, number, number, number] | null,
  fallbackRadiusKm = DEFAULT_CITY_RADIUS_KM,
): [number, number, number, number] {
  const fallback = computeCityFallbackBbox(latitude, longitude, fallbackRadiusKm);
  if (!rawBbox) return fallback;

  const [rawMinLon, rawMinLat, rawMaxLon, rawMaxLat] = rawBbox;
  if (
    !Number.isFinite(rawMinLon) ||
    !Number.isFinite(rawMinLat) ||
    !Number.isFinite(rawMaxLon) ||
    !Number.isFinite(rawMaxLat) ||
    rawMinLon >= rawMaxLon ||
    rawMinLat >= rawMaxLat
  ) {
    return fallback;
  }

  const cosLat = Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  const minPadLon = MIN_PAD_LAT_DEG / cosLat;

  // Pad around both the city bounds and the user's coordinate so city outskirts stay visible.
  let minLon = Math.min(rawMinLon - 0.04, longitude - minPadLon);
  let maxLon = Math.max(rawMaxLon + 0.04, longitude + minPadLon);
  let minLat = Math.min(rawMinLat - 0.03, latitude - MIN_PAD_LAT_DEG);
  let maxLat = Math.max(rawMaxLat + 0.03, latitude + MIN_PAD_LAT_DEG);

  // Clamp overly large administrative regions centered around the requested point.
  if (maxLon - minLon > MAX_SPAN_LON_DEG) {
    const half = MAX_SPAN_LON_DEG / 2;
    minLon = longitude - half;
    maxLon = longitude + half;
  }
  if (maxLat - minLat > MAX_SPAN_LAT_DEG) {
    const half = MAX_SPAN_LAT_DEG / 2;
    minLat = latitude - half;
    maxLat = latitude + half;
  }

  return [
    Math.max(-180, Number(minLon.toFixed(5))),
    Math.max(-85, Number(minLat.toFixed(5))),
    Math.min(180, Number(maxLon.toFixed(5))),
    Math.min(85, Number(maxLat.toFixed(5))),
  ];
}

export function slugifyCityName(name: string, latitude: number, longitude: number): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  const base = ascii.length > 0 ? ascii : 'region';
  const latTag = `${Math.abs(latitude).toFixed(2)}${latitude >= 0 ? 'n' : 's'}`;
  const lonTag = `${Math.abs(longitude).toFixed(2)}${longitude >= 0 ? 'e' : 'w'}`;
  return `${base}-${latTag}-${lonTag}`.replace(/\./g, '_');
}

export type ExternalMapPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'linux';

export interface ExternalMapPlatformInput {
  platformOs?: string | null;
  userAgent?: string | null;
}

export interface ExternalMapsUrlOptions extends ExternalMapPlatformInput {
  latitude: number;
  longitude: number;
  label?: string | null;
  isNativeApp?: boolean;
}

export interface ExternalMapsUrls {
  platform: ExternalMapPlatform;
  primaryUrl: string;
  fallbackUrl: string;
  appLabel: string;
}

export function detectExternalMapPlatform(
  input: ExternalMapPlatformInput = {},
): ExternalMapPlatform {
  const os = input.platformOs?.toLowerCase().trim();
  if (os === 'android') return 'android';
  if (os === 'ios') return 'ios';
  if (os === 'macos') return 'macos';
  if (os === 'windows') return 'windows';

  const ua = (input.userAgent ?? '').toLowerCase();
  if (ua.includes('android')) return 'android';
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (ua.includes('macintosh') || ua.includes('mac os x')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  return 'linux';
}

/**
 * Builds platform-native default Maps app deep links (`geo:`, `maps://`, `bingmaps:`)
 * paired with a universal web maps fallback URL.
 */
export function buildExternalMapsUrls(options: ExternalMapsUrlOptions): ExternalMapsUrls {
  const lat = Number(Math.max(-90, Math.min(90, options.latitude)).toFixed(6));
  const lon = Number(Math.max(-180, Math.min(180, options.longitude)).toFixed(6));
  const cleanLabel = (options.label ?? 'Location')
    .replace(/[()\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Location';
  const encodedLabel = encodeURIComponent(cleanLabel);
  const platform = detectExternalMapPlatform(options);
  const googleFallback = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  const appleUniversal = `https://maps.apple.com/?ll=${lat},${lon}&q=${encodedLabel}`;

  if (platform === 'android') {
    return {
      platform,
      primaryUrl: `geo:${lat},${lon}?q=${lat},${lon}(${encodedLabel})`,
      fallbackUrl: googleFallback,
      appLabel: 'Default Maps',
    };
  }

  if (platform === 'ios') {
    return {
      platform,
      primaryUrl: options.isNativeApp ? `maps://?ll=${lat},${lon}&q=${encodedLabel}` : appleUniversal,
      fallbackUrl: options.isNativeApp ? appleUniversal : googleFallback,
      appLabel: 'Apple Maps',
    };
  }

  if (platform === 'macos') {
    return {
      platform,
      primaryUrl: `maps://?ll=${lat},${lon}&q=${encodedLabel}`,
      fallbackUrl: appleUniversal,
      appLabel: 'Apple Maps',
    };
  }

  if (platform === 'windows') {
    return {
      platform,
      primaryUrl: `bingmaps:?cp=${lat}~${lon}&lvl=16&sp=point.${lat}_${lon}_${encodedLabel}`,
      fallbackUrl: googleFallback,
      appLabel: 'Windows Maps',
    };
  }

  return {
    platform,
    primaryUrl: `geo:${lat},${lon}?q=${lat},${lon}(${encodedLabel})`,
    fallbackUrl: googleFallback,
    appLabel: 'Maps App',
  };
}
