'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';
import {
  averageNearbyTrailPings,
  buildExternalMapsUrls,
  buildGeodesicCircleRing,
  DEFAULT_EXACT_HALO_COLOR,
  DEFAULT_FUZZ_CIRCLE_COLOR,
  DEFAULT_FUZZED_HALO_COLOR,
  FUZZED_AREA_RADIUS_METERS,
  hexToRgba,
  isSafeAvatarUrl,
  isSafeHexColor,
  type GroupPlace,
  type LocationBroadcast,
  type MapRegion,
} from '@loved-ones/shared';
import { getServiceBaseUrls } from '@/lib/api';
import { getMapPaintOverrides, type ResolvedMapTheme } from '@/lib/mapTheme';

let pmtilesProtocolRegistered = false;
const archiveInstanceCache = new Map<string, PMTiles>();
let activeCompositeEntries: Array<{ region: MapRegion; pmtiles: PMTiles }> = [];
let hasSyncedRegions = false;

const FUZZED_ZONES_SOURCE_ID = 'lovedones-fuzzed-zones-src';
const FUZZED_ZONES_FILL_LAYER_ID = 'lovedones-fuzzed-zones-fill';
const FUZZED_ZONES_OUTLINE_LAYER_ID = 'lovedones-fuzzed-zones-outline';

function getOrCreateArchive(url: string): PMTiles {
  let instance = archiveInstanceCache.get(url);
  if (!instance) {
    instance = new PMTiles(url);
    archiveInstanceCache.set(url, instance);
  }
  return instance;
}

function syncCompositeEntries(tilesBase: string, regions: MapRegion[] | undefined): void {
  if (!regions) return;
  hasSyncedRegions = true;
  activeCompositeEntries = regions
    .filter((r) => !r.isStub)
    .map((r) => ({
      region: r,
      pmtiles: getOrCreateArchive(`${tilesBase}${r.url}`),
    }));
}

function tileCoordsToBbox(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const latSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  const latNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [minLon, latSouth, maxLon, latNorth];
}

function boxesOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function registerCompositePmtilesProtocol(defaultTilesBase: string): void {
  if (pmtilesProtocolRegistered) return;
  const fallbackProtocol = new Protocol();

  maplibregl.addProtocol('pmtiles', async (params, abortController) => {
    const rawUrl = params.url;
    const [urlWithoutQuery, queryString] = rawUrl.split('?');
    const isCompositeUrl = urlWithoutQuery.endsWith('/tiles/region.pmtiles');
    const tileMatch = urlWithoutQuery.match(/^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/);

    if (tileMatch && tileMatch[1].endsWith('/tiles/region.pmtiles')) {
      const z = Number.parseInt(tileMatch[2], 10);
      const x = Number.parseInt(tileMatch[3], 10);
      const y = Number.parseInt(tileMatch[4], 10);
      const candidates = hasSyncedRegions
        ? activeCompositeEntries
        : [
            {
              region: {
                id: 'default',
                name: 'Region',
                url: '/tiles/region.pmtiles',
                minLon: -180,
                minLat: -85,
                maxLon: 180,
                maxLat: 85,
                minZoom: 0,
                maxZoom: 15,
                sizeBytes: 0,
                isStub: false,
                isPrimary: true,
              },
              pmtiles: getOrCreateArchive(`${defaultTilesBase}/tiles/region.pmtiles`),
            },
          ];

      const tileBox = tileCoordsToBbox(z, x, y);
      for (const entry of candidates) {
        const r = entry.region;
        if (z < r.minZoom || z > r.maxZoom) continue;
        if (!boxesOverlap(tileBox, [r.minLon, r.minLat, r.maxLon, r.maxLat])) continue;
        try {
          const tile = await entry.pmtiles.getZxy(z, x, y, abortController.signal);
          abortController.signal.throwIfAborted();
          if (tile && tile.data) {
            return {
              data: new Uint8Array(tile.data),
              cacheControl: tile.cacheControl,
              expires: tile.expires,
            };
          }
        } catch (err) {
          if (abortController.signal.aborted) throw err;
        }
      }
      return { data: new Uint8Array() };
    }

    if (params.type === 'json' && isCompositeUrl) {
      const candidates = hasSyncedRegions
        ? activeCompositeEntries
        : [
            {
              region: {
                id: 'default',
                name: 'Region',
                url: '/tiles/region.pmtiles',
                minLon: -180,
                minLat: -85,
                maxLon: 180,
                maxLat: 85,
                minZoom: 0,
                maxZoom: 15,
                sizeBytes: 0,
                isStub: false,
                isPrimary: true,
              },
              pmtiles: getOrCreateArchive(`${defaultTilesBase}/tiles/region.pmtiles`),
            },
          ];

      let metadata: Record<string, unknown> | null = null;
      let maxZoom = 15;
      if (candidates.length > 0) {
        maxZoom = Math.max(15, ...candidates.map((c) => c.region.maxZoom));
        try {
          metadata = (await candidates[0].pmtiles.getMetadata()) as Record<string, unknown>;
        } catch {
          metadata = null;
        }
      }

      return {
        data: {
          tilejson: '3.0.0',
          scheme: 'xyz',
          tiles: [`${urlWithoutQuery}/{z}/{x}/{y}${queryString ? `?${queryString}` : ''}`],
          vector_layers: Array.isArray(metadata?.vector_layers) ? metadata.vector_layers : [],
          attribution: typeof metadata?.attribution === 'string' ? metadata.attribution : undefined,
          description: typeof metadata?.description === 'string' ? metadata.description : undefined,
          name: typeof metadata?.name === 'string' ? metadata.name : 'LovedOnes Basemap',
          minzoom: 0,
          maxzoom: maxZoom,
          bounds: [-180, -85.0511, 180, 85.0511],
        },
      };
    }

    return fallbackProtocol.tilev4(params, abortController);
  });

  pmtilesProtocolRegistered = true;
}

const TRAIL_SOURCE_ID = 'lovedones-trails-src';
const TRAIL_LINE_LAYER_ID = 'lovedones-trails-line';
const TRAIL_POINT_LAYER_ID = 'lovedones-trails-pts';

export type MapLabelLanguage = 'en' | 'local';

const LANGUAGE_LABEL_LAYER_IDS = [
  'pois-food-labels',
  'pois-retail-labels',
  'water-labels',
  'road-labels-minor',
  'road-labels',
  'pois-parks-labels',
  'pois-health-local',
  'pois-civic-local',
  'pois-landmarks-labels',
  'pois-health-major',
  'places-neighborhoods',
  'places-cities',
] as const;

const CONTEXT_NEIGHBORHOOD_LAYERS = ['places-neighborhoods'] as const;
const CONTEXT_POI_LAYERS = [
  'pois-landmarks-labels',
  'pois-parks-labels',
  'pois-civic-local',
  'pois-health-major',
  'pois-health-local',
  'pois-food-labels',
  'pois-retail-labels',
] as const;
const CONTEXT_ROAD_LAYERS = ['road-labels', 'road-labels-minor'] as const;
const CONTEXT_CITY_LAYERS = ['places-cities'] as const;

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatRelativeTime(isoDate: string): string {
  const ms = Date.parse(isoDate);
  if (!Number.isFinite(ms)) return 'Recently';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 45) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function pickFeatureLabel(
  props: Record<string, unknown> | undefined,
  lang: MapLabelLanguage,
): string | null {
  if (!props) return null;
  const local = typeof props.name === 'string' ? props.name.trim() : '';
  const en = typeof props['name:en'] === 'string' ? props['name:en'].trim() : '';
  const chosen = lang === 'local' ? local || en : en || local;
  return chosen || null;
}

function queryNearestLayerLabel(
  map: maplibregl.Map,
  px: number,
  py: number,
  radiusPx: number,
  layerIds: readonly string[],
  lang: MapLabelLanguage,
): string | null {
  const activeLayers = layerIds.filter((id) => Boolean(map.getLayer(id)));
  if (activeLayers.length === 0) return null;
  try {
    const features = map.queryRenderedFeatures(
      [
        [px - radiusPx, py - radiusPx],
        [px + radiusPx, py + radiusPx],
      ],
      { layers: activeLayers },
    );
    for (const f of features) {
      const label = pickFeatureLabel(f.properties as Record<string, unknown> | undefined, lang);
      if (label) return label;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveHumanLocationContext(
  map: maplibregl.Map,
  lon: number,
  lat: number,
  places: GroupPlace[],
  lang: MapLabelLanguage,
  isFuzzed: boolean,
): { prefix: 'At' | 'Located near'; label: string } | null {
  if (!isFuzzed && places.length > 0) {
    let bestInside: { name: string; dist: number } | null = null;
    let bestNearby: { name: string; dist: number } | null = null;
    for (const p of places) {
      const d = distanceMeters(lat, lon, p.latitude, p.longitude);
      if (d <= p.radiusMeters && (!bestInside || d < bestInside.dist)) {
        bestInside = { name: p.name, dist: d };
      } else if (d <= Math.max(p.radiusMeters * 1.8, 350) && (!bestNearby || d < bestNearby.dist)) {
        bestNearby = { name: p.name, dist: d };
      }
    }
    if (bestInside) return { prefix: 'At', label: bestInside.name };
    if (bestNearby) return { prefix: 'Located near', label: bestNearby.name };
  }

  if (!map.isStyleLoaded()) return null;
  const pt = map.project([lon, lat]);
  const canvas = map.getCanvas();
  const w = canvas?.clientWidth || 1000;
  const h = canvas?.clientHeight || 800;
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  if (pt.x < -200 || pt.x > w + 200 || pt.y < -200 || pt.y > h + 200) return null;

  const neighborhood =
    queryNearestLayerLabel(map, pt.x, pt.y, 85, CONTEXT_NEIGHBORHOOD_LAYERS, lang) ??
    queryNearestLayerLabel(map, pt.x, pt.y, 180, CONTEXT_NEIGHBORHOOD_LAYERS, lang);

  if (isFuzzed) {
    const city = queryNearestLayerLabel(map, pt.x, pt.y, 240, CONTEXT_CITY_LAYERS, lang);
    const broad = neighborhood ?? city;
    return broad ? { prefix: 'Located near', label: broad } : null;
  }

  const poi = queryNearestLayerLabel(map, pt.x, pt.y, 32, CONTEXT_POI_LAYERS, lang);
  const road = queryNearestLayerLabel(map, pt.x, pt.y, 36, CONTEXT_ROAD_LAYERS, lang);
  const city = queryNearestLayerLabel(map, pt.x, pt.y, 240, CONTEXT_CITY_LAYERS, lang);

  const label = neighborhood ?? poi ?? road ?? city;
  return label ? { prefix: 'Located near', label } : null;
}

function buildPopupDetailsHtml(params: {
  latitude: number;
  longitude: number;
  recordedAt: string;
  extraLines?: string[];
}): string {
  const extras = (params.extraLines ?? [])
    .map((line) => `<div class="text-zinc-500">${escapeHtml(line)}</div>`)
    .join('');
  return `
    <details class="mt-1.5 border-t border-zinc-100 pt-1.5">
      <summary class="cursor-pointer select-none text-[11px] font-medium text-zinc-500 hover:text-zinc-900">
        Details
      </summary>
      <div class="mt-1 space-y-0.5 text-[11px]">
        ${extras}
        <div class="font-mono text-zinc-500">${params.latitude.toFixed(4)}, ${params.longitude.toFixed(4)}</div>
        <div class="text-zinc-400">${escapeHtml(new Date(params.recordedAt).toLocaleTimeString())}</div>
      </div>
    </details>
  `;
}

function buildLabelTextExpression(lang: MapLabelLanguage): maplibregl.ExpressionSpecification {
  return lang === 'local'
    ? ['coalesce', ['get', 'name'], ['get', 'name:en']]
    : ['coalesce', ['get', 'name:en'], ['get', 'name']];
}

function applyMapLabelLanguage(map: maplibregl.Map, lang: MapLabelLanguage): void {
  const expr = buildLabelTextExpression(lang);
  for (const layerId of LANGUAGE_LABEL_LAYER_IDS) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'text-field', expr);
    }
  }
}

function applyMapTheme(map: maplibregl.Map, theme: ResolvedMapTheme): void {
  for (const entry of getMapPaintOverrides(theme)) {
    if (map.getLayer(entry.layerId)) {
      map.setPaintProperty(entry.layerId, entry.property, entry.value);
    }
  }
}

function buildExternalMapsPopupRowHtml(
  latitude: number,
  longitude: number,
  label: string,
): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const urls = buildExternalMapsUrls({ latitude, longitude, label, userAgent: ua });
  return `
    <div class="mt-2 flex items-center gap-1.5 pt-1.5 border-t border-zinc-100">
      <a
        href="${escapeHtml(urls.primaryUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        class="lo-popup-maps-primary inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-zinc-950 px-2.5 py-1.5 text-[11px] font-semibold text-white no-underline hover:bg-zinc-800"
      >
        Open in Maps
      </a>
      <a
        href="${escapeHtml(urls.fallbackUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        title="Open in browser map"
        class="lo-popup-maps-secondary inline-flex items-center justify-center rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[10px] font-medium text-zinc-700 no-underline hover:bg-zinc-50"
      >
        Web
      </a>
    </div>
  `;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface SelfLocationFix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  recordedAt: string;
}

interface FocusCoordsRequest {
  latitude: number;
  longitude: number;
  zoom?: number;
  nonce: number;
}

interface DraftPlaceCoords {
  latitude: number;
  longitude: number;
  name?: string;
}

interface MapCanvasProps {
  locations: LocationBroadcast[];
  places?: GroupPlace[];
  trails?: LocationBroadcast[];
  regions?: MapRegion[];
  regionsRevision?: number;
  showTrails?: boolean;
  selectedUserId?: string | null;
  selectedPlaceId?: string | null;
  currentUserId?: string | null;
  currentUserAvatarUrl?: string | null;
  currentUserHaloColor?: string | null;
  currentUserFuzzCircleColor?: string | null;
  selfLocation?: SelfLocationFix | null;
  focusCoords?: FocusCoordsRequest | null;
  draftPlace?: DraftPlaceCoords | null;
  pickingPlace?: boolean;
  labelLanguage?: MapLabelLanguage;
  mapTheme?: ResolvedMapTheme;
  onMapSelectCoords?: (latitude: number, longitude: number) => void;
  onViewportChange?: (viewport: { latitude: number; longitude: number; zoom: number }) => void;
  className?: string;
}

export function MapCanvas({
  locations,
  places = [],
  trails = [],
  regions,
  regionsRevision = 0,
  showTrails = false,
  selectedUserId,
  selectedPlaceId,
  currentUserId = null,
  currentUserAvatarUrl = null,
  currentUserHaloColor = null,
  currentUserFuzzCircleColor = null,
  selfLocation = null,
  focusCoords = null,
  draftPlace = null,
  pickingPlace = false,
  labelLanguage = 'en',
  mapTheme = 'light',
  onMapSelectCoords,
  onViewportChange,
  className,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const markersRef = useRef<
    Map<string, { marker: maplibregl.Marker; signature: string; loc: LocationBroadcast }>
  >(new Map());
  const markerAnimFramesRef = useRef<Map<string, number>>(new Map());
  const placeMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const draftPlaceMarkerRef = useRef<maplibregl.Marker | null>(null);
  const selfMarkerRef = useRef<maplibregl.Marker | null>(null);
  const hasAutoFramedRef = useRef(false);
  const labelLanguageRef = useRef<MapLabelLanguage>(labelLanguage);
  labelLanguageRef.current = labelLanguage;
  const mapThemeRef = useRef<ResolvedMapTheme>(mapTheme);
  mapThemeRef.current = mapTheme;
  const placesRef = useRef<GroupPlace[]>(places);
  placesRef.current = places;
  const currentUserIdRef = useRef<string | null>(currentUserId);
  currentUserIdRef.current = currentUserId;
  const currentUserAvatarUrlRef = useRef<string | null>(currentUserAvatarUrl);
  currentUserAvatarUrlRef.current = currentUserAvatarUrl;
  const selfLocationRef = useRef<SelfLocationFix | null>(selfLocation);
  selfLocationRef.current = selfLocation;
  const onSelectCoordsRef = useRef(onMapSelectCoords);
  onSelectCoordsRef.current = onMapSelectCoords;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  function buildMemberPopupHtml(loc: LocationBroadcast): string {
    const resolvedAvatar =
      loc.avatarUrl ??
      (loc.userId === currentUserIdRef.current ? currentUserAvatarUrlRef.current : null) ??
      null;
    const safeAvatar = isSafeAvatarUrl(resolvedAvatar) ? resolvedAvatar : null;
    const safeUser = escapeHtml(loc.username);
    const popupAvatarHtml = safeAvatar
      ? `<img src="${escapeHtml(safeAvatar)}" alt="${safeUser}" class="h-7 w-7 rounded-full object-cover border border-zinc-200 shrink-0" />`
      : '';
    const privacyBadge = loc.isFuzzed ? `${loc.privacyMode} · ~1 km` : loc.privacyMode;
    const ctx = mapRef.current
      ? resolveHumanLocationContext(
          mapRef.current,
          loc.longitude,
          loc.latitude,
          placesRef.current,
          labelLanguageRef.current,
          loc.isFuzzed,
        )
      : null;
    const contextHtml = ctx
      ? `<div class="text-[11px] text-zinc-700">${escapeHtml(ctx.prefix)} <span class="font-medium text-zinc-950">${escapeHtml(ctx.label)}</span></div>`
      : '';
    const extraLines =
      loc.batteryLevel !== null && loc.batteryLevel !== undefined
        ? [`Battery ${loc.batteryLevel}%`]
        : [];
    const detailsHtml = buildPopupDetailsHtml({
      latitude: loc.latitude,
      longitude: loc.longitude,
      recordedAt: loc.recordedAt,
      extraLines,
    });
    const mapsRowHtml = buildExternalMapsPopupRowHtml(
      loc.latitude,
      loc.longitude,
      loc.isFuzzed ? `${loc.username} (~1km)` : loc.username,
    );

    return `
      <div class="text-xs space-y-1 min-w-[190px]">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            ${popupAvatarHtml}
            <div class="truncate font-semibold text-zinc-950">${safeUser}</div>
          </div>
          <span class="shrink-0 rounded-full ${loc.isFuzzed ? 'bg-amber-100 text-amber-800' : 'bg-zinc-100 text-zinc-700'} px-2 py-0.5 text-[10px] font-semibold">${escapeHtml(privacyBadge)}</span>
        </div>
        ${contextHtml}
        <div class="text-[11px] text-zinc-500">Last seen ${escapeHtml(formatRelativeTime(loc.recordedAt))}</div>
        ${mapsRowHtml}
        ${detailsHtml}
      </div>
    `;
  }

  function buildSelfPopupHtml(fix: SelfLocationFix): string {
    const accLabel =
      typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy)
        ? `Accuracy ±${Math.round(fix.accuracy)} m`
        : 'Live browser GPS';
    const ctx = mapRef.current
      ? resolveHumanLocationContext(
          mapRef.current,
          fix.longitude,
          fix.latitude,
          placesRef.current,
          labelLanguageRef.current,
          false,
        )
      : null;
    const contextHtml = ctx
      ? `<div class="text-[11px] text-zinc-700">${escapeHtml(ctx.prefix)} <span class="font-medium text-zinc-950">${escapeHtml(ctx.label)}</span></div>`
      : '';
    const detailsHtml = buildPopupDetailsHtml({
      latitude: fix.latitude,
      longitude: fix.longitude,
      recordedAt: fix.recordedAt,
      extraLines: [accLabel],
    });
    const mapsRowHtml = buildExternalMapsPopupRowHtml(fix.latitude, fix.longitude, 'My Location');
    return `
      <div class="text-xs space-y-1 min-w-[185px]">
        <div class="font-semibold text-zinc-950">You (Live GPS)</div>
        ${contextHtml}
        <div class="text-[11px] text-zinc-500">Updated ${escapeHtml(formatRelativeTime(fix.recordedAt))}</div>
        ${mapsRowHtml}
        ${detailsHtml}
      </div>
    `;
  }

  function glideMarker(key: string, marker: maplibregl.Marker, targetLng: number, targetLat: number) {
    const frames = markerAnimFramesRef.current;
    const prevFrame = frames.get(key);
    if (prevFrame !== undefined) {
      cancelAnimationFrame(prevFrame);
      frames.delete(key);
    }

    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      marker.setLngLat([targetLng, targetLat]);
      return;
    }

    const start = marker.getLngLat();
    const dLng = targetLng - start.lng;
    const dLat = targetLat - start.lat;

    if (
      (Math.abs(dLng) < 1e-7 && Math.abs(dLat) < 1e-7) ||
      Math.abs(dLng) > 0.5 ||
      Math.abs(dLat) > 0.5
    ) {
      marker.setLngLat([targetLng, targetLat]);
      return;
    }

    const durationMs = 600;
    const startedAt = performance.now();

    const step = (now: number) => {
      const elapsed = now - startedAt;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      marker.setLngLat([start.lng + dLng * eased, start.lat + dLat * eased]);
      if (t < 1) {
        frames.set(key, requestAnimationFrame(step));
      } else {
        frames.delete(key);
      }
    };

    frames.set(key, requestAnimationFrame(step));
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const { tilesBase } = getServiceBaseUrls();
    syncCompositeEntries(tilesBase, regions);
    registerCompositePmtilesProtocol(tilesBase);

    const styleUrl = `${tilesBase}/tiles/style.json?v=7`;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: [13.405, 52.52],
      zoom: 13.2,
      attributionControl: false,
      transformRequest: (url) => {
        if (tilesBase && url.startsWith('pmtiles:///tiles/')) {
          return { url: `pmtiles://${tilesBase}${url.slice('pmtiles://'.length)}` };
        }
        if (tilesBase && url.startsWith('/tiles/')) {
          return { url: `${tilesBase}${url}` };
        }
        return { url };
      },
    });

    const emitViewport = () => {
      const center = map.getCenter();
      onViewportChangeRef.current?.({
        latitude: Number(center.lat.toFixed(6)),
        longitude: Number(center.lng.toFixed(6)),
        zoom: map.getZoom(),
      });
    };

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('load', () => {
      styleReadyRef.current = true;
      applyMapLabelLanguage(map, labelLanguageRef.current);
      applyMapTheme(map, mapThemeRef.current);
      emitViewport();
    });
    map.on('moveend', emitViewport);
    map.on('error', () => {
      if (!map.isStyleLoaded()) {
        map.setStyle({
          version: 8,
          sources: {},
          layers: [
            {
              id: 'fallback-bg',
              type: 'background',
              paint: {
                'background-color': mapThemeRef.current === 'dark' ? '#111318' : '#e9eff3',
              },
            },
          ],
        });
      }
    });

    map.on('click', (e) => {
      onSelectCoordsRef.current?.(
        Number(e.lngLat.lat.toFixed(6)),
        Number(e.lngLat.lng.toFixed(6)),
      );
    });

    mapRef.current = map;

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(() => {
            map.resize();
          })
        : null;
    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver?.disconnect();
      styleReadyRef.current = false;
      for (const frameId of markerAnimFramesRef.current.values()) {
        cancelAnimationFrame(frameId);
      }
      markerAnimFramesRef.current.clear();
      for (const entry of markersRef.current.values()) {
        entry.marker.remove();
      }
      markersRef.current.clear();
      for (const marker of placeMarkersRef.current.values()) {
        marker.remove();
      }
      placeMarkersRef.current.clear();
      draftPlaceMarkerRef.current?.remove();
      draftPlaceMarkerRef.current = null;
      selfMarkerRef.current?.remove();
      selfMarkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activeIds = new Set<string>();
    const bounds = new maplibregl.LngLatBounds();

    for (const loc of locations) {
      activeIds.add(loc.userId);
      bounds.extend([loc.longitude, loc.latitude]);

      const resolvedAvatar =
        loc.avatarUrl ?? (loc.userId === currentUserId ? currentUserAvatarUrl : null) ?? null;
      const safeAvatar = isSafeAvatarUrl(resolvedAvatar) ? resolvedAvatar : null;
      const rawHalo =
        loc.haloColor ?? (loc.userId === currentUserId ? currentUserHaloColor : null) ?? null;
      const resolvedHaloColor = isSafeHexColor(rawHalo)
        ? rawHalo
        : loc.isFuzzed
          ? DEFAULT_FUZZED_HALO_COLOR
          : DEFAULT_EXACT_HALO_COLOR;
      const hasCustomHalo = isSafeHexColor(rawHalo);
      const signature = `${loc.username}|${safeAvatar ?? ''}|${loc.isFuzzed ? '1' : '0'}|${resolvedHaloColor}`;
      const existing = markersRef.current.get(loc.userId);

      if (existing && existing.signature === signature) {
        existing.loc = loc;
        glideMarker(loc.userId, existing.marker, loc.longitude, loc.latitude);
        const popup = existing.marker.getPopup();
        if (popup?.isOpen()) {
          popup.setHTML(buildMemberPopupHtml(loc));
        }
      } else {
        existing?.marker.remove();

        const el = document.createElement('div');
        el.className = 'cursor-pointer select-none';

        const innerWrap = document.createElement('div');
        innerWrap.className =
          'lo-pin-drop flex flex-col items-center transition-transform duration-200 ease-out hover:scale-110';

        const pill = document.createElement('div');
        pill.className =
          'mb-1.5 rounded-lg border border-zinc-200/90 bg-white/95 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-950 shadow-md backdrop-blur';
        pill.textContent = loc.username;

        const haloShadow = `0 0 0 4px ${hexToRgba(
          resolvedHaloColor,
          hasCustomHalo || loc.isFuzzed ? 0.42 : 0.24,
        )}, 0 10px 18px rgba(9, 9, 11, 0.16)`;

        if (safeAvatar) {
          const avatarWrap = document.createElement('div');
          avatarWrap.className = 'relative h-10 w-10 rounded-full border-2 border-white bg-white';
          avatarWrap.style.boxShadow = haloShadow;

          const clip = document.createElement('div');
          clip.className =
            'flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-zinc-900 text-xs font-bold text-white';

          const img = document.createElement('img');
          img.src = safeAvatar;
          img.alt = loc.username;
          img.className = 'h-full w-full object-cover';
          img.onerror = () => {
            img.remove();
            clip.textContent = loc.username.slice(0, 1).toUpperCase();
          };
          clip.appendChild(img);

          const statusDot = document.createElement('span');
          statusDot.className = 'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white';
          statusDot.style.backgroundColor = resolvedHaloColor;

          avatarWrap.append(clip, statusDot);
          innerWrap.append(pill, avatarWrap);
        } else {
          const ring = document.createElement('div');
          ring.className = 'flex h-6 w-6 items-center justify-center rounded-full bg-white';
          ring.style.boxShadow = haloShadow;

          const core = document.createElement('div');
          core.className = 'h-3 w-3 rounded-full';
          core.style.backgroundColor = resolvedHaloColor;
          ring.appendChild(core);
          innerWrap.append(pill, ring);
        }

        el.appendChild(innerWrap);

        const popup = new maplibregl.Popup({ offset: 18 }).setHTML(buildMemberPopupHtml(loc));
        popup.on('open', () => {
          const latest = markersRef.current.get(loc.userId)?.loc ?? loc;
          popup.setHTML(buildMemberPopupHtml(latest));
        });

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([loc.longitude, loc.latitude])
          .setPopup(popup)
          .addTo(map);
        markersRef.current.set(loc.userId, { marker, signature, loc });
      }
    }

    for (const [uid, entry] of markersRef.current.entries()) {
      if (!activeIds.has(uid)) {
        const frameId = markerAnimFramesRef.current.get(uid);
        if (frameId !== undefined) {
          cancelAnimationFrame(frameId);
          markerAnimFramesRef.current.delete(uid);
        }
        entry.marker.remove();
        markersRef.current.delete(uid);
      }
    }

    if (selectedUserId) {
      const target = locations.find((l) => l.userId === selectedUserId);
      if (target) {
        hasAutoFramedRef.current = true;
        map.flyTo({
          center: [target.longitude, target.latitude],
          zoom: 13.5,
          duration: 850,
          curve: 1.35,
          essential: true,
        });
      }
    } else if (locations.length === 0) {
      hasAutoFramedRef.current = false;
    } else if (!hasAutoFramedRef.current) {
      hasAutoFramedRef.current = true;
      if (locations.length === 1) {
        map.flyTo({
          center: [locations[0].longitude, locations[0].latitude],
          zoom: 13.5,
          duration: 850,
          curve: 1.35,
          essential: true,
        });
      } else {
        map.fitBounds(bounds, { padding: 110, maxZoom: 14, duration: 800, essential: true });
      }
    }
  }, [locations, selectedUserId, currentUserId, currentUserAvatarUrl, currentUserHaloColor]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyFuzzedZonesLayer = () => {
      const features = locations
        .filter((loc) => loc.isFuzzed)
        .map((loc) => {
          const rawFuzzColor =
            loc.fuzzCircleColor ??
            (loc.userId === currentUserId ? currentUserFuzzCircleColor : null) ??
            null;
          const color = isSafeHexColor(rawFuzzColor) ? rawFuzzColor : DEFAULT_FUZZ_CIRCLE_COLOR;
          return {
            type: 'Feature' as const,
            geometry: {
              type: 'Polygon' as const,
              coordinates: [
                buildGeodesicCircleRing(loc.longitude, loc.latitude, FUZZED_AREA_RADIUS_METERS),
              ],
            },
            properties: {
              userId: loc.userId,
              username: loc.username,
              color,
            },
          };
        });

      const geojson = { type: 'FeatureCollection' as const, features };
      const existingSource = map.getSource(FUZZED_ZONES_SOURCE_ID) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (existingSource) {
        existingSource.setData(geojson);
        return;
      }

      map.addSource(FUZZED_ZONES_SOURCE_ID, { type: 'geojson', data: geojson });
      map.addLayer({
        id: FUZZED_ZONES_FILL_LAYER_ID,
        type: 'fill',
        source: FUZZED_ZONES_SOURCE_ID,
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.14,
        },
      });
      map.addLayer({
        id: FUZZED_ZONES_OUTLINE_LAYER_ID,
        type: 'line',
        source: FUZZED_ZONES_SOURCE_ID,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.75,
          'line-dasharray': [3, 2],
          'line-opacity': 0.65,
        },
      });
    };

    if (styleReadyRef.current || map.isStyleLoaded()) {
      applyFuzzedZonesLayer();
    } else {
      map.once('load', applyFuzzedZonesLayer);
    }
  }, [locations, currentUserId, currentUserFuzzCircleColor]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!selfLocation) {
      selfMarkerRef.current?.remove();
      selfMarkerRef.current = null;
      return;
    }

    const hasExactServerMarker = Boolean(
      currentUserId && locations.some((l) => l.userId === currentUserId && !l.isFuzzed),
    );

    // Rebuild cleanly when label visibility switches so exact server pin and self puck don't double-label
    selfMarkerRef.current?.remove();
    const el = document.createElement('div');
    el.className = 'cursor-pointer select-none z-10';

    const innerWrap = document.createElement('div');
    innerWrap.className =
      'lo-pin-drop flex flex-col items-center transition-transform duration-200 ease-out hover:scale-110';

    if (!hasExactServerMarker) {
      const pill = document.createElement('div');
      pill.className =
        'mb-1.5 rounded-full border border-zinc-900 bg-zinc-900 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-md';
      pill.textContent = 'You';
      innerWrap.appendChild(pill);
    }

    const safeSelfAvatar =
      !hasExactServerMarker && isSafeAvatarUrl(currentUserAvatarUrl) ? currentUserAvatarUrl : null;
    const selfHaloColor = isSafeHexColor(currentUserHaloColor)
      ? currentUserHaloColor
      : DEFAULT_EXACT_HALO_COLOR;
    const pulseWrap = document.createElement('div');
    pulseWrap.className = safeSelfAvatar
      ? 'relative flex h-10 w-10 items-center justify-center'
      : 'relative flex h-7 w-7 items-center justify-center';
    const halo = document.createElement('div');
    halo.className = 'absolute inset-0 animate-ping rounded-full';
    halo.style.backgroundColor = hexToRgba(selfHaloColor, 0.38);

    const selfShadow = `0 0 0 4px ${hexToRgba(selfHaloColor, 0.28)}, 0 10px 18px rgba(9, 9, 11, 0.18)`;

    if (safeSelfAvatar) {
      const puck = document.createElement('div');
      puck.className =
        'relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-zinc-950';
      puck.style.boxShadow = selfShadow;
      const img = document.createElement('img');
      img.src = safeSelfAvatar;
      img.alt = 'You';
      img.className = 'h-full w-full object-cover';
      puck.appendChild(img);
      pulseWrap.append(halo, puck);
    } else {
      const puck = document.createElement('div');
      puck.className =
        'relative flex h-5 w-5 items-center justify-center rounded-full border-2 border-white';
      puck.style.backgroundColor = selfHaloColor;
      puck.style.boxShadow = selfShadow;
      const dot = document.createElement('div');
      dot.className = 'h-2 w-2 rounded-full bg-white';
      puck.appendChild(dot);
      pulseWrap.append(halo, puck);
    }
    innerWrap.appendChild(pulseWrap);
    el.appendChild(innerWrap);

    const selfPopup = new maplibregl.Popup({ offset: 18 }).setHTML(buildSelfPopupHtml(selfLocation));
    selfPopup.on('open', () => {
      if (selfLocationRef.current) {
        selfPopup.setHTML(buildSelfPopupHtml(selfLocationRef.current));
      }
    });

    selfMarkerRef.current = new maplibregl.Marker({ element: el })
      .setLngLat([selfLocation.longitude, selfLocation.latitude])
      .setPopup(selfPopup)
      .addTo(map);
  }, [selfLocation, currentUserId, currentUserAvatarUrl, currentUserHaloColor, locations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusCoords) return;
    hasAutoFramedRef.current = true;
    map.flyTo({
      center: [focusCoords.longitude, focusCoords.latitude],
      zoom: focusCoords.zoom ?? 15,
      duration: 850,
      curve: 1.35,
      essential: true,
    });
  }, [focusCoords]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activePlaceIds = new Set<string>();
    for (const place of places) {
      activePlaceIds.add(place.id);
      const existing = placeMarkersRef.current.get(place.id);
      const safeName = escapeHtml(place.name);
      const placeMapsHtml = buildExternalMapsPopupRowHtml(
        place.latitude,
        place.longitude,
        place.name,
      );
      const popupHtml = `
        <div class="text-xs space-y-0.5 min-w-[180px]">
          <div class="font-semibold text-zinc-900">${safeName}</div>
          <div class="text-zinc-500">Geofence radius: ${Math.round(place.radiusMeters)} m</div>
          ${placeMapsHtml}
        </div>
      `;
      if (existing) {
        existing.setLngLat([place.longitude, place.latitude]);
        existing.getPopup()?.setHTML(popupHtml);
      } else {
        const el = document.createElement('div');
        el.className = 'cursor-pointer select-none';
        const innerWrap = document.createElement('div');
        innerWrap.className =
          'lo-pin-drop flex flex-col items-center transition-transform duration-200 ease-out hover:scale-110';
        const label = document.createElement('div');
        label.className =
          'rounded-lg border border-zinc-200/90 bg-white/95 px-2.5 py-0.5 text-[10px] font-semibold text-zinc-900 shadow-sm backdrop-blur';
        label.textContent = `${place.name} · ${Math.round(place.radiusMeters)}m`;
        const dot = document.createElement('div');
        dot.className =
          'mt-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-dashed border-zinc-800 bg-white/80 shadow';
        const inner = document.createElement('div');
        inner.className = 'h-1.5 w-1.5 rounded-full bg-zinc-900';
        dot.appendChild(inner);
        innerWrap.append(label, dot);
        el.appendChild(innerWrap);

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([place.longitude, place.latitude])
          .setPopup(new maplibregl.Popup({ offset: 14 }).setHTML(popupHtml))
          .addTo(map);
        placeMarkersRef.current.set(place.id, marker);
      }
    }

    for (const [pid, marker] of placeMarkersRef.current.entries()) {
      if (!activePlaceIds.has(pid)) {
        marker.remove();
        placeMarkersRef.current.delete(pid);
      }
    }

    if (selectedPlaceId) {
      const target = places.find((p) => p.id === selectedPlaceId);
      if (target) {
        map.flyTo({
          center: [target.longitude, target.latitude],
          zoom: 14,
          duration: 850,
          curve: 1.35,
          essential: true,
        });
      }
    }
  }, [places, selectedPlaceId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = pickingPlace ? 'crosshair' : '';
  }, [pickingPlace]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const validDraft =
      draftPlace &&
      Number.isFinite(draftPlace.latitude) &&
      Number.isFinite(draftPlace.longitude) &&
      draftPlace.latitude >= -90 &&
      draftPlace.latitude <= 90 &&
      draftPlace.longitude >= -180 &&
      draftPlace.longitude <= 180;

    if (!validDraft || !draftPlace) {
      draftPlaceMarkerRef.current?.remove();
      draftPlaceMarkerRef.current = null;
      return;
    }

    const labelText = draftPlace.name?.trim() || 'Selected place';
    const existing = draftPlaceMarkerRef.current;
    if (existing) {
      existing.setLngLat([draftPlace.longitude, draftPlace.latitude]);
      const pillEl = existing.getElement().querySelector('[data-draft-pill]');
      if (pillEl) {
        pillEl.textContent = labelText;
      }
      return;
    }

    const el = document.createElement('div');
    el.className = 'cursor-grab active:cursor-grabbing select-none z-20';

    const innerWrap = document.createElement('div');
    innerWrap.className = 'lo-pin-drop flex flex-col items-center';

    const pill = document.createElement('div');
    pill.setAttribute('data-draft-pill', 'true');
    pill.className =
      'mb-1 rounded-full border border-zinc-900 bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-md';
    pill.textContent = labelText;

    const pinWrap = document.createElement('div');
    pinWrap.className =
      'lo-bob relative flex flex-col items-center transition-transform duration-150 ease-out hover:scale-105';
    pinWrap.innerHTML = `
      <svg width="32" height="38" viewBox="0 0 32 38" fill="none" xmlns="http://www.w3.org/2000/svg" class="drop-shadow-[0_6px_10px_rgba(9,9,11,0.35)]">
        <path d="M16 2C8.82 2 3 7.82 3 15C3 24.4 16 36 16 36C16 36 29 24.4 29 15C29 7.82 23.18 2 16 2Z" fill="#09090b" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
        <circle cx="16" cy="14.5" r="4.5" fill="#ffffff"/>
      </svg>
      <span class="mt-0.5 h-2 w-2 rounded-full bg-zinc-950/35"></span>
    `;

    innerWrap.append(pill, pinWrap);
    el.appendChild(innerWrap);

    const marker = new maplibregl.Marker({
      element: el,
      anchor: 'bottom',
      draggable: true,
    })
      .setLngLat([draftPlace.longitude, draftPlace.latitude])
      .addTo(map);

    marker.on('dragstart', () => {
      pinWrap.classList.remove('lo-bob');
      pinWrap.classList.add('scale-105');
    });

    marker.on('dragend', () => {
      pinWrap.classList.remove('scale-105');
      pinWrap.classList.add('lo-bob');
      const lngLat = marker.getLngLat();
      onSelectCoordsRef.current?.(
        Number(lngLat.lat.toFixed(6)),
        Number(lngLat.lng.toFixed(6)),
      );
    });

    draftPlaceMarkerRef.current = marker;
  }, [draftPlace]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyTrailsLayer = () => {
      const features: Array<{
        type: 'Feature';
        geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] };
        properties: {
          username: string;
          pingCount?: number;
          firstRecordedAt?: string;
          lastRecordedAt?: string;
          isFuzzed?: boolean;
        };
      }> = [];

      if (showTrails && trails.length > 0) {
        const compacted = averageNearbyTrailPings(trails);
        for (const userTrail of compacted) {
          for (const stop of userTrail.stops) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [stop.longitude, stop.latitude] },
              properties: {
                username: stop.username,
                pingCount: stop.pingCount,
                firstRecordedAt: stop.firstRecordedAt,
                lastRecordedAt: stop.lastRecordedAt,
                isFuzzed: stop.isFuzzed,
              },
            });
          }
          if (userTrail.pathCoordinates.length >= 2) {
            features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: userTrail.pathCoordinates },
              properties: { username: userTrail.username },
            });
          }
        }
      }

      const geojson = { type: 'FeatureCollection' as const, features };
      const existingSource = map.getSource(TRAIL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (existingSource) {
        existingSource.setData(geojson);
        return;
      }
      map.addSource(TRAIL_SOURCE_ID, { type: 'geojson', data: geojson });
      map.addLayer({
        id: TRAIL_LINE_LAYER_ID,
        type: 'line',
        source: TRAIL_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': mapThemeRef.current === 'dark' ? '#f4f4f5' : '#18181b',
          'line-width': 2.5,
          'line-dasharray': [2, 1.5],
          'line-opacity': 0.75,
        },
      });
      map.addLayer({
        id: TRAIL_POINT_LAYER_ID,
        type: 'circle',
        source: TRAIL_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['>', ['coalesce', ['get', 'pingCount'], 1], 1], 5, 4],
          'circle-color': mapThemeRef.current === 'dark' ? '#09090b' : '#ffffff',
          'circle-stroke-color': mapThemeRef.current === 'dark' ? '#f4f4f5' : '#18181b',
          'circle-stroke-width': 1.5,
        },
      });
    };

    if (styleReadyRef.current || map.isStyleLoaded()) {
      applyTrailsLayer();
    } else {
      map.once('load', applyTrailsLayer);
    }
  }, [trails, showTrails]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (styleReadyRef.current || map.isStyleLoaded()) {
      applyMapLabelLanguage(map, labelLanguage);
    }
  }, [labelLanguage]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (styleReadyRef.current || map.isStyleLoaded()) {
      applyMapTheme(map, mapTheme);
    }
  }, [mapTheme]);

  useEffect(() => {
    for (const entry of markersRef.current.values()) {
      const popup = entry.marker.getPopup();
      if (popup?.isOpen()) {
        popup.setHTML(buildMemberPopupHtml(entry.loc));
      }
    }
    const selfPopup = selfMarkerRef.current?.getPopup();
    if (selfPopup?.isOpen() && selfLocationRef.current) {
      selfPopup.setHTML(buildSelfPopupHtml(selfLocationRef.current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, labelLanguage]);

  useEffect(() => {
    const { tilesBase } = getServiceBaseUrls();
    syncCompositeEntries(tilesBase, regions);
    const map = mapRef.current;
    if (!map || regionsRevision <= 0) return;

    const refreshSource = () => {
      const source = map.getSource('openmaptiles') as maplibregl.VectorTileSource | undefined;
      if (source && typeof source.setUrl === 'function') {
        source.setUrl(`pmtiles:///tiles/region.pmtiles?rev=${regionsRevision}`);
      }
    };

    if (styleReadyRef.current || map.isStyleLoaded()) {
      refreshSource();
    } else {
      map.once('load', refreshSource);
    }
  }, [regions, regionsRevision]);

  const resolvedClassName =
    className ??
    `relative h-full w-full overflow-hidden transition-colors duration-300 ${
      mapTheme === 'dark' ? 'bg-[#0c141d]' : 'bg-[#cfe3ee]'
    }`;

  return <div ref={containerRef} className={resolvedClassName} />;
}
