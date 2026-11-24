import { describe, expect, it } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { normalizeMapStyleUrls, resolveAbsoluteStyleUrl } from '../lib/mapStyleUrl';

describe('mapStyleUrl helpers (MapLibre v5 absolute URL normalization)', () => {
  it('resolves root-relative and pmtiles:/// URLs against origin while preserving absolute URLs', () => {
    expect(resolveAbsoluteStyleUrl('/tiles/sprites/maki', 'https://maps.example.com/')).toBe(
      'https://maps.example.com/tiles/sprites/maki',
    );
    expect(
      resolveAbsoluteStyleUrl('pmtiles:///tiles/region.pmtiles', 'https://maps.example.com'),
    ).toBe('pmtiles://https://maps.example.com/tiles/region.pmtiles');
    expect(
      resolveAbsoluteStyleUrl('https://cdn.example.com/sprite', 'https://maps.example.com'),
    ).toBe('https://cdn.example.com/sprite');
  });

  it('normalizes sprite, glyphs, and vector source URLs inside a MapLibre style specification', () => {
    const rawStyle: StyleSpecification = {
      version: 8,
      sprite: '/tiles/sprites/maki',
      glyphs: '/tiles/fonts/{fontstack}/{range}.pbf',
      sources: {
        openmaptiles: {
          type: 'vector',
          url: 'pmtiles:///tiles/region.pmtiles',
        },
        customTiles: {
          type: 'vector',
          tiles: ['/api/maps/tiles/{z}/{x}/{y}.pbf'],
        },
      },
      layers: [],
    };

    const normalized = normalizeMapStyleUrls(rawStyle, 'https://maps.example.com');
    expect(normalized.sprite).toBe('https://maps.example.com/tiles/sprites/maki');
    expect(normalized.glyphs).toBe('https://maps.example.com/tiles/fonts/{fontstack}/{range}.pbf');
    expect(normalized.sources.openmaptiles).toEqual({
      type: 'vector',
      url: 'pmtiles://https://maps.example.com/tiles/region.pmtiles',
    });
    expect(normalized.sources.customTiles).toEqual({
      type: 'vector',
      tiles: ['https://maps.example.com/api/maps/tiles/{z}/{x}/{y}.pbf'],
    });
  });

  it('supports array-based multi-sprite specifications', () => {
    const rawStyle: StyleSpecification = {
      version: 8,
      sprite: [{ id: 'default', url: '/tiles/sprites/maki' }],
      sources: {},
      layers: [],
    };
    const normalized = normalizeMapStyleUrls(rawStyle, 'https://maps.example.com');
    expect(normalized.sprite).toEqual([
      { id: 'default', url: 'https://maps.example.com/tiles/sprites/maki' },
    ]);
  });
});
