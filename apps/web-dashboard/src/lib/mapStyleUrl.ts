import type { StyleSpecification } from 'maplibre-gl';

/**
 * Rewrites root-relative and `pmtiles:///` style URLs against an absolute origin.
 * MapLibre GL v5 requires absolute URLs for `sprite` (calling `new URL(sprite)`),
 * and absolute `glyphs` / `pmtiles://` URLs also keep Web Worker fetches consistent.
 */
export function resolveAbsoluteStyleUrl(url: string, origin: string): string {
  const cleanOrigin = origin.trim().replace(/\/+$/, '');
  if (!cleanOrigin) return url;
  if (url.startsWith('pmtiles:///')) {
    return `pmtiles://${cleanOrigin}${url.slice('pmtiles://'.length)}`;
  }
  if (url.startsWith('/')) {
    return `${cleanOrigin}${url}`;
  }
  return url;
}

export function normalizeMapStyleUrls(
  style: StyleSpecification,
  origin: string,
): StyleSpecification {
  const cleanOrigin = origin.trim().replace(/\/+$/, '');
  if (!cleanOrigin) return style;

  const next: StyleSpecification = { ...style };

  if (typeof style.sprite === 'string') {
    next.sprite = resolveAbsoluteStyleUrl(style.sprite, cleanOrigin);
  } else if (Array.isArray(style.sprite)) {
    next.sprite = style.sprite.map((entry) => ({
      ...entry,
      url: resolveAbsoluteStyleUrl(entry.url, cleanOrigin),
    }));
  }

  if (typeof style.glyphs === 'string') {
    next.glyphs = resolveAbsoluteStyleUrl(style.glyphs, cleanOrigin);
  }

  if (style.sources && typeof style.sources === 'object') {
    const nextSources: StyleSpecification['sources'] = {};
    for (const [sourceId, rawSource] of Object.entries(style.sources)) {
      if (!rawSource || typeof rawSource !== 'object') {
        nextSources[sourceId] = rawSource;
        continue;
      }
      const cloned = { ...rawSource } as Record<string, unknown>;
      if (typeof cloned.url === 'string') {
        cloned.url = resolveAbsoluteStyleUrl(cloned.url, cleanOrigin);
      }
      if (Array.isArray(cloned.tiles)) {
        cloned.tiles = cloned.tiles.map((tileUrl) =>
          typeof tileUrl === 'string' ? resolveAbsoluteStyleUrl(tileUrl, cleanOrigin) : tileUrl,
        );
      }
      nextSources[sourceId] = cloned as StyleSpecification['sources'][string];
    }
    next.sources = nextSources;
  }

  return next;
}
