'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { GroupPlace, LocationBroadcast } from '@loved-ones/shared';
import { getServiceBaseUrls } from '@/lib/api';

let pmtilesProtocolRegistered = false;

interface MapCanvasProps {
  locations: LocationBroadcast[];
  places?: GroupPlace[];
  selectedUserId?: string | null;
  selectedPlaceId?: string | null;
  onMapSelectCoords?: (latitude: number, longitude: number) => void;
}

export function MapCanvas({
  locations,
  places = [],
  selectedUserId,
  selectedPlaceId,
  onMapSelectCoords,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const placeMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
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
    const styleUrl = `${tilesBase}/tiles/style.json`;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: [2.3522, 48.8566],
      zoom: 3,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('error', () => {
      // Fall back to a minimal blank style if tile server style.json is unreachable
      if (!map.isStyleLoaded()) {
        map.setStyle({
          version: 8,
          sources: {},
          layers: [
            {
              id: 'fallback-bg',
              type: 'background',
              paint: { 'background-color': '#0f172a' },
            },
          ],
        });
      }
    });

    mapRef.current = map;
    map.on('click', (e) => {
      onSelectCoordsRef.current?.(
        Number(e.lngLat.lat.toFixed(6)),
        Number(e.lngLat.lng.toFixed(6)),
      );
    });

    return () => {
      for (const marker of markersRef.current.values()) {
        marker.remove();
      }
      markersRef.current.clear();
      for (const marker of placeMarkersRef.current.values()) {
        marker.remove();
      }
      placeMarkersRef.current.clear();
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

      const existing = markersRef.current.get(loc.userId);
      const popupHtml = `
        <div class="text-xs space-y-1">
          <div class="font-semibold text-white">${loc.username}</div>
          <div class="text-slate-300">Mode: ${loc.privacyMode}${loc.isFuzzed ? ' (~1km)' : ''}</div>
          ${loc.batteryLevel !== null && loc.batteryLevel !== undefined ? `<div class="text-slate-400">Battery: ${loc.batteryLevel}%</div>` : ''}
          <div class="text-slate-400">Lat: ${loc.latitude.toFixed(4)}, Lon: ${loc.longitude.toFixed(4)}</div>
          <div class="text-slate-500">${new Date(loc.recordedAt).toLocaleTimeString()}</div>
        </div>
      `;

      if (existing) {
        existing.setLngLat([loc.longitude, loc.latitude]);
        existing.getPopup()?.setHTML(popupHtml);
      } else {
        const el = document.createElement('div');
        el.className = 'flex flex-col items-center cursor-pointer';
        el.innerHTML = `
          <div class="px-2 py-0.5 mb-1 rounded-full text-[11px] font-semibold shadow ${
            loc.isFuzzed
              ? 'bg-amber-500/90 text-slate-950'
              : 'bg-emerald-500/90 text-slate-950'
          }">${loc.username}</div>
          <div class="h-4 w-4 rounded-full border-2 border-white shadow-lg ${
            loc.isFuzzed ? 'bg-amber-400 ring-8 ring-amber-400/25' : 'bg-emerald-400'
          }"></div>
        `;
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([loc.longitude, loc.latitude])
          .setPopup(new maplibregl.Popup({ offset: 18 }).setHTML(popupHtml))
          .addTo(map);
        markersRef.current.set(loc.userId, marker);
      }
    }

    for (const [uid, marker] of markersRef.current.entries()) {
      if (!activeIds.has(uid)) {
        marker.remove();
        markersRef.current.delete(uid);
      }
    }

    if (selectedUserId) {
      const target = locations.find((l) => l.userId === selectedUserId);
      if (target) {
        map.flyTo({ center: [target.longitude, target.latitude], zoom: 13, duration: 700 });
      }
    } else if (locations.length === 1) {
      map.flyTo({ center: [locations[0].longitude, locations[0].latitude], zoom: 12, duration: 600 });
    } else if (locations.length > 1) {
      map.fitBounds(bounds, { padding: 70, maxZoom: 14, duration: 600 });
    }
  }, [locations, selectedUserId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const activePlaceIds = new Set<string>();
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

    for (const place of places) {
      activePlaceIds.add(place.id);
      const existing = placeMarkersRef.current.get(place.id);
      const safeName = escapeHtml(place.name);
      const popupHtml = `
        <div class="text-xs space-y-0.5">
          <div class="font-semibold text-sky-300">${safeName}</div>
          <div class="text-slate-400">Radius: ${Math.round(place.radiusMeters)} m</div>
        </div>
      `;
      if (existing) {
        existing.setLngLat([place.longitude, place.latitude]);
        existing.getPopup()?.setHTML(popupHtml);
      } else {
        const el = document.createElement('div');
        el.className = 'flex flex-col items-center cursor-pointer';
        const label = document.createElement('div');
        label.className =
          'rounded border border-sky-400/70 bg-slate-900/90 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 shadow';
        label.textContent = `${place.name} (${Math.round(place.radiusMeters)}m)`;
        const dot = document.createElement('div');
        dot.className =
          'mt-0.5 h-3 w-3 rounded-full border-2 border-dashed border-sky-400 bg-sky-400/30';
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

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-slate-700/80 bg-slate-900/90 px-3 py-1.5 text-xs text-slate-300 backdrop-blur">
        PMTiles Vector Renderer · {locations.length} active marker{locations.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}
