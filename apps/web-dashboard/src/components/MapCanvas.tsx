'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { isSafeAvatarUrl, type GroupPlace, type LocationBroadcast } from '@loved-ones/shared';
import { getServiceBaseUrls } from '@/lib/api';

let pmtilesProtocolRegistered = false;

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
  showTrails?: boolean;
  selectedUserId?: string | null;
  selectedPlaceId?: string | null;
  currentUserId?: string | null;
  currentUserAvatarUrl?: string | null;
  selfLocation?: SelfLocationFix | null;
  focusCoords?: FocusCoordsRequest | null;
  draftPlace?: DraftPlaceCoords | null;
  pickingPlace?: boolean;
  labelLanguage?: MapLabelLanguage;
  onMapSelectCoords?: (latitude: number, longitude: number) => void;
  className?: string;
}

export function MapCanvas({
  locations,
  places = [],
  trails = [],
  showTrails = false,
  selectedUserId,
  selectedPlaceId,
  currentUserId = null,
  currentUserAvatarUrl = null,
  selfLocation = null,
  focusCoords = null,
  draftPlace = null,
  pickingPlace = false,
  labelLanguage = 'en',
  onMapSelectCoords,
  className = 'relative h-full w-full overflow-hidden bg-[#cfe3ee]',
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const markersRef = useRef<Map<string, { marker: maplibregl.Marker; signature: string }>>(new Map());
  const placeMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const draftPlaceMarkerRef = useRef<maplibregl.Marker | null>(null);
  const selfMarkerRef = useRef<maplibregl.Marker | null>(null);
  const hasAutoFramedRef = useRef(false);
  const labelLanguageRef = useRef<MapLabelLanguage>(labelLanguage);
  labelLanguageRef.current = labelLanguage;
  const onSelectCoordsRef = useRef(onMapSelectCoords);
  onSelectCoordsRef.current = onMapSelectCoords;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    if (!pmtilesProtocolRegistered) {
      const protocol = new Protocol();
      maplibregl.addProtocol('pmtiles', protocol.tile);
      pmtilesProtocolRegistered = true;
    }

    const { tilesBase } = getServiceBaseUrls();
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

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('load', () => {
      styleReadyRef.current = true;
      applyMapLabelLanguage(map, labelLanguageRef.current);
    });
    map.on('error', () => {
      if (!map.isStyleLoaded()) {
        map.setStyle({
          version: 8,
          sources: {},
          layers: [
            {
              id: 'fallback-bg',
              type: 'background',
              paint: { 'background-color': '#e9eff3' },
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

    return () => {
      styleReadyRef.current = false;
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
      const safeUser = escapeHtml(loc.username);
      const signature = `${loc.username}|${safeAvatar ?? ''}|${loc.isFuzzed ? '1' : '0'}`;
      const existing = markersRef.current.get(loc.userId);
      const popupAvatarHtml = safeAvatar
        ? `<img src="${escapeHtml(safeAvatar)}" alt="${safeUser}" class="h-7 w-7 rounded-full object-cover border border-zinc-200 shrink-0" />`
        : '';
      const popupHtml = `
        <div class="text-xs space-y-1">
          <div class="flex items-center gap-2">
            ${popupAvatarHtml}
            <div class="font-semibold text-zinc-900">${safeUser}</div>
          </div>
          <div class="text-zinc-600">${loc.privacyMode}${loc.isFuzzed ? ' · ~1 km area' : ' · Exact'}</div>
          ${loc.batteryLevel !== null && loc.batteryLevel !== undefined ? `<div class="text-zinc-500">Battery ${loc.batteryLevel}%</div>` : ''}
          <div class="font-mono text-[11px] text-zinc-500">${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}</div>
          <div class="text-[11px] text-zinc-400">${new Date(loc.recordedAt).toLocaleTimeString()}</div>
        </div>
      `;

      if (existing && existing.signature === signature) {
        existing.marker.setLngLat([loc.longitude, loc.latitude]);
        existing.marker.getPopup()?.setHTML(popupHtml);
      } else {
        existing?.marker.remove();

        const el = document.createElement('div');
        el.className = 'flex flex-col items-center cursor-pointer select-none';

        const pill = document.createElement('div');
        pill.className =
          'mb-1.5 rounded-full border border-slate-200/90 bg-white/95 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-900 shadow-md backdrop-blur';
        pill.textContent = loc.username;

        if (safeAvatar) {
          const avatarWrap = document.createElement('div');
          avatarWrap.className = `relative h-10 w-10 rounded-full border-2 border-white bg-white shadow-lg ring-4 ${
            loc.isFuzzed ? 'ring-amber-400/50' : 'ring-zinc-900/25'
          }`;

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
          statusDot.className = `absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${
            loc.isFuzzed ? 'bg-amber-500' : 'bg-zinc-950'
          }`;

          avatarWrap.append(clip, statusDot);
          el.append(pill, avatarWrap);
        } else {
          const ring = document.createElement('div');
          ring.className = `flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-lg ring-4 ${
            loc.isFuzzed ? 'ring-amber-400/35' : 'ring-zinc-900/20'
          }`;

          const core = document.createElement('div');
          core.className = `h-3 w-3 rounded-full ${
            loc.isFuzzed ? 'bg-amber-500' : 'bg-zinc-900'
          }`;
          ring.appendChild(core);
          el.append(pill, ring);
        }

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([loc.longitude, loc.latitude])
          .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml))
          .addTo(map);
        markersRef.current.set(loc.userId, { marker, signature });
      }
    }

    for (const [uid, entry] of markersRef.current.entries()) {
      if (!activeIds.has(uid)) {
        entry.marker.remove();
        markersRef.current.delete(uid);
      }
    }

    if (selectedUserId) {
      const target = locations.find((l) => l.userId === selectedUserId);
      if (target) {
        hasAutoFramedRef.current = true;
        map.flyTo({ center: [target.longitude, target.latitude], zoom: 13.5, duration: 700 });
      }
    } else if (locations.length === 0) {
      hasAutoFramedRef.current = false;
    } else if (!hasAutoFramedRef.current) {
      hasAutoFramedRef.current = true;
      if (locations.length === 1) {
        map.flyTo({ center: [locations[0].longitude, locations[0].latitude], zoom: 13.5, duration: 600 });
      } else {
        map.fitBounds(bounds, { padding: 110, maxZoom: 14, duration: 600 });
      }
    }
  }, [locations, selectedUserId, currentUserId, currentUserAvatarUrl]);

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
    const accLabel =
      typeof selfLocation.accuracy === 'number' && Number.isFinite(selfLocation.accuracy)
        ? `±${Math.round(selfLocation.accuracy)} m`
        : 'Live browser fix';
    const popupHtml = `
      <div class="text-xs space-y-1">
        <div class="font-semibold text-zinc-900">You (Live GPS)</div>
        <div class="text-zinc-600">${escapeHtml(accLabel)}</div>
        <div class="font-mono text-[11px] text-zinc-500">${selfLocation.latitude.toFixed(4)}, ${selfLocation.longitude.toFixed(4)}</div>
        <div class="text-[11px] text-zinc-400">${new Date(selfLocation.recordedAt).toLocaleTimeString()}</div>
      </div>
    `;

    // Rebuild cleanly when label visibility switches so exact server pin and self puck don't double-label
    selfMarkerRef.current?.remove();
    const el = document.createElement('div');
    el.className = 'flex flex-col items-center cursor-pointer select-none z-10';

    if (!hasExactServerMarker) {
      const pill = document.createElement('div');
      pill.className =
        'mb-1.5 rounded-full border border-zinc-900 bg-zinc-900 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-md';
      pill.textContent = 'You';
      el.appendChild(pill);
    }

    const safeSelfAvatar =
      !hasExactServerMarker && isSafeAvatarUrl(currentUserAvatarUrl) ? currentUserAvatarUrl : null;
    const pulseWrap = document.createElement('div');
    pulseWrap.className = safeSelfAvatar
      ? 'relative flex h-10 w-10 items-center justify-center'
      : 'relative flex h-7 w-7 items-center justify-center';
    const halo = document.createElement('div');
    halo.className = 'absolute inset-0 animate-ping rounded-full bg-zinc-900/35';

    if (safeSelfAvatar) {
      const puck = document.createElement('div');
      puck.className =
        'relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-zinc-950 shadow-lg ring-4 ring-zinc-900/25';
      const img = document.createElement('img');
      img.src = safeSelfAvatar;
      img.alt = 'You';
      img.className = 'h-full w-full object-cover';
      puck.appendChild(img);
      pulseWrap.append(halo, puck);
    } else {
      const puck = document.createElement('div');
      puck.className =
        'relative flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-zinc-950 shadow-lg ring-4 ring-zinc-900/20';
      const dot = document.createElement('div');
      dot.className = 'h-2 w-2 rounded-full bg-white';
      puck.appendChild(dot);
      pulseWrap.append(halo, puck);
    }
    el.appendChild(pulseWrap);

    selfMarkerRef.current = new maplibregl.Marker({ element: el })
      .setLngLat([selfLocation.longitude, selfLocation.latitude])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml))
      .addTo(map);
  }, [selfLocation, currentUserId, currentUserAvatarUrl, locations]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusCoords) return;
    hasAutoFramedRef.current = true;
    map.flyTo({
      center: [focusCoords.longitude, focusCoords.latitude],
      zoom: focusCoords.zoom ?? 15,
      duration: 750,
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
      const popupHtml = `
        <div class="text-xs space-y-0.5">
          <div class="font-semibold text-zinc-900">${safeName}</div>
          <div class="text-zinc-500">Geofence radius: ${Math.round(place.radiusMeters)} m</div>
        </div>
      `;
      if (existing) {
        existing.setLngLat([place.longitude, place.latitude]);
        existing.getPopup()?.setHTML(popupHtml);
      } else {
        const el = document.createElement('div');
        el.className = 'flex flex-col items-center cursor-pointer select-none';
        const label = document.createElement('div');
        label.className =
          'rounded-full border border-slate-200/90 bg-white/95 px-2.5 py-0.5 text-[10px] font-semibold text-zinc-800 shadow-sm backdrop-blur';
        label.textContent = `${place.name} · ${Math.round(place.radiusMeters)}m`;
        const dot = document.createElement('div');
        dot.className =
          'mt-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-dashed border-zinc-800 bg-white/80 shadow';
        const inner = document.createElement('div');
        inner.className = 'h-1.5 w-1.5 rounded-full bg-zinc-900';
        dot.appendChild(inner);
        el.append(label, dot);

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
        map.flyTo({ center: [target.longitude, target.latitude], zoom: 14, duration: 700 });
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
    el.className = 'flex flex-col items-center cursor-grab active:cursor-grabbing select-none z-20';

    const pill = document.createElement('div');
    pill.setAttribute('data-draft-pill', 'true');
    pill.className =
      'mb-1 rounded-full border border-zinc-900 bg-zinc-950 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-md';
    pill.textContent = labelText;

    const pinWrap = document.createElement('div');
    pinWrap.className = 'relative flex flex-col items-center';
    pinWrap.innerHTML = `
      <svg width="32" height="38" viewBox="0 0 32 38" fill="none" xmlns="http://www.w3.org/2000/svg" class="drop-shadow-[0_6px_10px_rgba(9,9,11,0.35)]">
        <path d="M16 2C8.82 2 3 7.82 3 15C3 24.4 16 36 16 36C16 36 29 24.4 29 15C29 7.82 23.18 2 16 2Z" fill="#09090b" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
        <circle cx="16" cy="14.5" r="4.5" fill="#ffffff"/>
      </svg>
      <span class="mt-0.5 h-2 w-2 rounded-full bg-zinc-950/35"></span>
    `;

    el.append(pill, pinWrap);

    const marker = new maplibregl.Marker({
      element: el,
      anchor: 'bottom',
      draggable: true,
    })
      .setLngLat([draftPlace.longitude, draftPlace.latitude])
      .addTo(map);

    marker.on('dragend', () => {
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
      const byUser = new Map<string, [number, number][]>();
      const features: Array<{
        type: 'Feature';
        geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] };
        properties: { username: string };
      }> = [];

      if (showTrails && trails.length > 0) {
        for (const pt of trails) {
          const arr = byUser.get(pt.userId) ?? [];
          arr.push([pt.longitude, pt.latitude]);
          byUser.set(pt.userId, arr);
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [pt.longitude, pt.latitude] },
            properties: { username: pt.username },
          });
        }
        for (const [userId, coords] of byUser.entries()) {
          if (coords.length < 2) continue;
          const uname = trails.find((t) => t.userId === userId)?.username ?? 'Member';
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: { username: uname },
          });
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
          'line-color': '#18181b',
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
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#18181b',
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

  return <div ref={containerRef} className={className} />;
}
