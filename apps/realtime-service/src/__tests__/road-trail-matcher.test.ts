import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoundingBox, TrailPingLike } from '@loved-ones/shared';
import {
  PmtilesRoadTileProvider,
  RoadEdgeFeature,
  RoadTileProvider,
  RoadTrailMatcher,
} from '../domain/road-trail-matcher.js';

function createMemoryRoadProvider(
  edges: RoadEdgeFeature[],
  rev = 'test-rev-1',
): RoadTileProvider & { calls: number } {
  return {
    calls: 0,
    async getRevisionKey() {
      return rev;
    },
    async getRoadFeaturesForBbox(_bbox: BoundingBox) {
      this.calls += 1;
      return edges;
    },
  };
}

describe('RoadTrailMatcher', () => {
  it('snaps two stops around city blocks along streets and bridges >15m off-road stops with spurs', async () => {
    // 2x2 street grid around 52.5200..52.5240, 13.4000..13.4050 (~445m x 340m)
    const gridEdges: RoadEdgeFeature[] = [
      // South avenue (lat 52.5200)
      {
        kind: 'minor_road',
        coords: [
          [13.4, 52.52],
          [13.405, 52.52],
        ],
      },
      // East street (lon 13.4050)
      {
        kind: 'minor_road',
        coords: [
          [13.405, 52.52],
          [13.405, 52.524],
        ],
      },
      // North avenue (lat 52.5240)
      {
        kind: 'minor_road',
        coords: [
          [13.4, 52.524],
          [13.405, 52.524],
        ],
      },
      // West street (lon 13.4000)
      {
        kind: 'minor_road',
        coords: [
          [13.4, 52.52],
          [13.4, 52.524],
        ],
      },
      // Middle cross street (lat 52.5220)
      {
        kind: 'minor_road',
        coords: [
          [13.4, 52.522],
          [13.405, 52.522],
        ],
      },
    ];

    const provider = createMemoryRoadProvider(gridEdges);
    const matcher = new RoadTrailMatcher({ tileProvider: provider });

    // Start inside a building ~30m north of South Ave, end inside a building ~30m west of East St
    const pings: TrailPingLike[] = [
      {
        userId: 'u1',
        username: 'Alice',
        latitude: 52.52028, // ~31m north of 52.5200
        longitude: 13.4005,
        recordedAt: '2026-11-22T10:00:00.000Z',
        speed: 8,
      },
      {
        userId: 'u1',
        username: 'Alice',
        latitude: 52.5235,
        longitude: 13.40455, // ~30m west of 13.4050
        recordedAt: '2026-11-22T10:03:00.000Z',
        speed: 8,
      },
    ];

    const [matched] = await matcher.matchTrails(pings);
    expect(matched.hasRoadMatches).toBe(true);
    expect(matched.stops).toHaveLength(2);

    const roadSegs = matched.segments.filter((s) => s.kind === 'road');
    const spurSegs = matched.segments.filter((s) => s.kind === 'spur');
    const directSegs = matched.segments.filter((s) => s.kind === 'direct');

    expect(roadSegs).toHaveLength(1);
    expect(directSegs).toHaveLength(0);
    expect(spurSegs).toHaveLength(2);
    // Road path must turn at an intersection (>= 3 vertices), not a 2-point straight diagonal
    expect(roadSegs[0].coordinates.length).toBeGreaterThanOrEqual(3);

    // Second identical query hits result cache without calling provider again
    await matcher.matchTrails(pings);
    expect(provider.calls).toBe(1);
  });

  it('prefers footpaths for walking speeds and roads for driving speeds', async () => {
    // Two parallel links between (13.400, 52.520) and (13.405, 52.520):
    // - A direct park 'path' straight across
    // - A slightly longer 'major_road' detour via 52.5208
    const edges: RoadEdgeFeature[] = [
      {
        kind: 'path',
        coords: [
          [13.4, 52.52],
          [13.405, 52.52],
        ],
      },
      {
        kind: 'major_road',
        coords: [
          [13.4, 52.52],
          [13.4, 52.5208],
          [13.405, 52.5208],
          [13.405, 52.52],
        ],
      },
    ];

    const matcher = new RoadTrailMatcher({ tileProvider: createMemoryRoadProvider(edges) });

    const [walkMatch] = await matcher.matchTrails([
      {
        userId: 'walker',
        username: 'Walk',
        latitude: 52.52,
        longitude: 13.4,
        recordedAt: '2026-11-22T10:00:00.000Z',
        speed: 1.3,
      },
      {
        userId: 'walker',
        username: 'Walk',
        latitude: 52.52,
        longitude: 13.405,
        recordedAt: '2026-11-22T10:05:00.000Z',
        speed: 1.4,
      },
    ]);
    expect(walkMatch.segments[0].kind).toBe('road');
    expect(walkMatch.segments[0].roadKind).toBe('path');

    const [driveMatch] = await matcher.matchTrails([
      {
        userId: 'driver',
        username: 'Drive',
        latitude: 52.52,
        longitude: 13.4,
        recordedAt: '2026-11-22T10:00:00.000Z',
        speed: 14,
      },
      {
        userId: 'driver',
        username: 'Drive',
        latitude: 52.52,
        longitude: 13.405,
        recordedAt: '2026-11-22T10:00:30.000Z',
        speed: 14,
      },
    ]);
    expect(driveMatch.segments[0].kind).toBe('road');
    expect(driveMatch.segments[0].roadKind).toBe('major_road');
  });

  it('keeps FUZZED trails un-snapped, breaks >30m time gaps, and falls back to direct when off-road', async () => {
    const edges: RoadEdgeFeature[] = [
      {
        kind: 'minor_road',
        coords: [
          [13.4, 52.52],
          [13.405, 52.52],
        ],
      },
    ];
    const matcher = new RoadTrailMatcher({ tileProvider: createMemoryRoadProvider(edges) });

    // 1. FUZZED stays direct even when right on top of a road
    const [fuzzed] = await matcher.matchTrails([
      {
        userId: 'fuzzed-user',
        username: 'Fuzzed',
        latitude: 52.52,
        longitude: 13.4,
        recordedAt: '2026-11-22T10:00:00.000Z',
        isFuzzed: true,
      },
      {
        userId: 'fuzzed-user',
        username: 'Fuzzed',
        latitude: 52.52,
        longitude: 13.405,
        recordedAt: '2026-11-22T10:02:00.000Z',
        isFuzzed: true,
      },
    ]);
    expect(fuzzed.hasRoadMatches).toBe(false);
    expect(fuzzed.segments).toEqual([
      {
        kind: 'direct',
        coordinates: [
          [13.4, 52.52],
          [13.405, 52.52],
        ],
      },
    ]);

    // 2. Time gap > 30 min splits trip cleanly (no fabricated segment across the break)
    const [gapUser] = await matcher.matchTrails([
      {
        userId: 'gap-user',
        username: 'Gap',
        latitude: 52.52,
        longitude: 13.4,
        recordedAt: '2026-11-22T08:00:00.000Z',
      },
      {
        userId: 'gap-user',
        username: 'Gap',
        latitude: 52.52,
        longitude: 13.405,
        recordedAt: '2026-11-22T09:00:00.000Z',
      },
    ]);
    expect(gapUser.stops).toHaveLength(2);
    expect(gapUser.segments).toHaveLength(0);

    // 3. Off-road (>150m from any road) falls back to direct dashed segment
    const [offRoad] = await matcher.matchTrails([
      {
        userId: 'off-user',
        username: 'Off',
        latitude: 52.53,
        longitude: 13.4,
        recordedAt: '2026-11-22T10:00:00.000Z',
      },
      {
        userId: 'off-user',
        username: 'Off',
        latitude: 52.53,
        longitude: 13.405,
        recordedAt: '2026-11-22T10:04:00.000Z',
      },
    ]);
    expect(offRoad.hasRoadMatches).toBe(false);
    expect(offRoad.segments).toHaveLength(1);
    expect(offRoad.segments[0].kind).toBe('direct');
  });

  it('ignores placeholder/empty PMTiles archives and falls back cleanly to direct trails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovedones-pmtiles-empty-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'region.pmtiles'), Buffer.alloc(264, 0));
      const provider = new PmtilesRoadTileProvider({ tilesDir: tmpDir });
      const matcher = new RoadTrailMatcher({ tileProvider: provider });

      const [matched] = await matcher.matchTrails([
        {
          userId: 'u1',
          username: 'Alice',
          latitude: 52.52,
          longitude: 13.4,
          recordedAt: '2026-11-22T10:00:00.000Z',
        },
        {
          userId: 'u1',
          username: 'Alice',
          latitude: 52.522,
          longitude: 13.404,
          recordedAt: '2026-11-22T10:05:00.000Z',
        },
      ]);

      expect(matched.hasRoadMatches).toBe(false);
      expect(matched.segments).toEqual([
        {
          kind: 'direct',
          coordinates: [
            [13.4, 52.52],
            [13.404, 52.522],
          ],
        },
      ]);
      await matcher.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('snaps tram/transit speeds onto rail lines, skips noisy lateral moving spikes, and only emits spurs for real dwells', async () => {
    const edges: RoadEdgeFeature[] = [
      // Straight tram/rail line along 52.5200
      {
        kind: 'rail',
        coords: [
          [13.4, 52.52],
          [13.408, 52.52],
        ],
      },
      // Parallel side street south of the corridor with perpendicular spur street
      {
        kind: 'minor_road',
        coords: [
          [13.403, 52.52],
          [13.403, 52.5189],
        ],
      },
      {
        kind: 'minor_road',
        coords: [
          [13.4, 52.52],
          [13.408, 52.52],
        ],
      },
    ];

    const matcher = new RoadTrailMatcher({ tileProvider: createMemoryRoadProvider(edges) });
    const [tramMatch] = await matcher.matchTrails([
      {
        userId: 'tram-rider',
        username: 'Tram',
        latitude: 52.52,
        longitude: 13.4005,
        recordedAt: '2026-11-22T14:00:00.000Z',
        speed: 10,
        accuracy: 12,
        heading: 90,
      },
      {
        // Noisy coarse moving Wi-Fi jump ~110m south onto the side street (single 15s ping, not a dwell)
        userId: 'tram-rider',
        username: 'Tram',
        latitude: 52.519,
        longitude: 13.403,
        recordedAt: '2026-11-22T14:00:15.000Z',
        speed: 10,
        accuracy: 95,
      },
      {
        userId: 'tram-rider',
        username: 'Tram',
        latitude: 52.52,
        longitude: 13.406,
        recordedAt: '2026-11-22T14:00:35.000Z',
        speed: 10,
        accuracy: 12,
        heading: 90,
      },
    ]);

    expect(tramMatch.hasRoadMatches).toBe(true);
    // Moving noisy spike must NOT produce a spur or detour south to 52.5190
    expect(tramMatch.segments.filter((s) => s.kind === 'spur')).toHaveLength(0);
    const roadCoords = tramMatch.segments
      .filter((s) => s.kind === 'road')
      .flatMap((s) => s.coordinates);
    expect(roadCoords.length).toBeGreaterThanOrEqual(2);
    expect(roadCoords.every(([, lat]) => Math.abs(lat - 52.52) < 0.0002)).toBe(true);

    // Rail-only track matches at transit speed (> 4.5 m/s)
    const railOnlyMatcher = new RoadTrailMatcher({
      tileProvider: createMemoryRoadProvider([
        {
          kind: 'rail',
          coords: [
            [13.4, 52.52],
            [13.408, 52.52],
          ],
        },
      ]),
    });
    const [railSnap] = await railOnlyMatcher.matchTrails([
      {
        userId: 'tram-only',
        username: 'TramOnly',
        latitude: 52.52005,
        longitude: 13.401,
        recordedAt: '2026-11-22T14:10:00.000Z',
        speed: 11,
      },
      {
        userId: 'tram-only',
        username: 'TramOnly',
        latitude: 52.52005,
        longitude: 13.406,
        recordedAt: '2026-11-22T14:10:30.000Z',
        speed: 11,
      },
    ]);
    expect(railSnap.hasRoadMatches).toBe(true);
    expect(railSnap.segments[0]?.roadKind).toBe('rail');

    // Genuine >90s off-road dwell in a multi-ping trip emits a spur, while moving waypoints do not
    const dwellMatcher = new RoadTrailMatcher({
      tileProvider: createMemoryRoadProvider([
        {
          kind: 'minor_road',
          coords: [
            [13.4, 52.52],
            [13.408, 52.52],
          ],
        },
      ]),
    });
    const [dwellTrip] = await dwellMatcher.matchTrails([
      {
        userId: 'dwell-user',
        username: 'Dwell',
        latitude: 52.5204, // ~44m north of road, genuine 10m dwell
        longitude: 13.401,
        recordedAt: '2026-11-22T15:00:00.000Z',
        accuracy: 10,
      },
      {
        userId: 'dwell-user',
        username: 'Dwell',
        latitude: 52.52042,
        longitude: 13.40102,
        recordedAt: '2026-11-22T15:10:00.000Z',
        accuracy: 10,
      },
      {
        userId: 'dwell-user',
        username: 'Dwell',
        latitude: 52.52002,
        longitude: 13.404,
        recordedAt: '2026-11-22T15:12:00.000Z',
        speed: 8,
        accuracy: 10,
      },
      {
        userId: 'dwell-user',
        username: 'Dwell',
        latitude: 52.52002,
        longitude: 13.407,
        recordedAt: '2026-11-22T15:13:00.000Z',
        speed: 8,
        accuracy: 10,
      },
    ]);
    expect(dwellTrip.segments.filter((s) => s.kind === 'spur')).toHaveLength(1);

    // Off-angle triangle bounce is dropped purely from PMTiles road/rail alignment even when accuracy is reported crisp (15m),
    // while a real 90-degree street corner is preserved.
    const cornerVsSpikeMatcher = new RoadTrailMatcher({
      tileProvider: createMemoryRoadProvider([
        // East-west corridor
        { kind: 'major_road', coords: [[13.4, 52.52], [13.408, 52.52]] },
        // Intersecting north-south avenue at 13.408
        { kind: 'major_road', coords: [[13.408, 52.52], [13.408, 52.524]] },
      ]),
    });
    const [angleMatch] = await cornerVsSpikeMatcher.matchTrails([
      {
        userId: 'angle-user',
        username: 'Angle',
        latitude: 52.52,
        longitude: 13.4005,
        recordedAt: '2026-11-22T16:00:00.000Z',
        speed: 10,
        accuracy: 15,
      },
      {
        // Off-angle ~100m north bounce with misreported crisp 15m accuracy
        userId: 'angle-user',
        username: 'Angle',
        latitude: 52.5209,
        longitude: 13.4035,
        recordedAt: '2026-11-22T16:00:20.000Z',
        speed: 10,
        accuracy: 15,
      },
      {
        // Real corner at (52.52, 13.408)
        userId: 'angle-user',
        username: 'Angle',
        latitude: 52.52,
        longitude: 13.408,
        recordedAt: '2026-11-22T16:00:45.000Z',
        speed: 10,
        accuracy: 15,
      },
      {
        // Turning north along intersecting street
        userId: 'angle-user',
        username: 'Angle',
        latitude: 52.5235,
        longitude: 13.408,
        recordedAt: '2026-11-22T16:01:20.000Z',
        speed: 10,
        accuracy: 15,
      },
    ]);
    expect(angleMatch.visits).toHaveLength(3);
    expect(angleMatch.visits?.some((v) => v.latitude > 52.5205 && v.longitude < 13.406)).toBe(false);
    expect(angleMatch.visits?.[2]?.latitude).toBeCloseTo(52.5235, 3);

    // Parallel multi-track rail corridor (tracks 5.5m apart, plus 4 parallel footpaths crowding the station)
    // preserves category diversity and links parallel tracks without falling back to 'direct'.
    const parallelRailMatcher = new RoadTrailMatcher({
      tileProvider: createMemoryRoadProvider([
        // 4 closely spaced footpaths right at the station platform (0-2m from stop A)
        { kind: 'path', coords: [[13.4, 52.52000], [13.401, 52.52000]] },
        { kind: 'path', coords: [[13.4, 52.52001], [13.401, 52.52001]] },
        { kind: 'path', coords: [[13.4, 52.52002], [13.401, 52.52002]] },
        { kind: 'path', coords: [[13.4, 52.51999], [13.401, 52.51999]] },
        // Track 1 (west end at station A, ends at tile boundary 13.405)
        { kind: 'rail', coords: [[13.4, 52.52004], [13.405, 52.52004]] },
        // Track 2 (5.5m north of Track 1, continues from 13.405 to station B at 13.410)
        { kind: 'rail', coords: [[13.405, 52.52009], [13.410, 52.52009]] },
      ]),
    });
    const [railCorridorMatch] = await parallelRailMatcher.matchTrails([
      {
        userId: 'rail-user',
        username: 'Rail',
        latitude: 52.52001,
        longitude: 13.4002,
        recordedAt: '2026-11-22T17:00:00.000Z',
        speed: 14,
        accuracy: 12,
      },
      {
        userId: 'rail-user',
        username: 'Rail',
        latitude: 52.52009,
        longitude: 13.4095,
        recordedAt: '2026-11-22T17:00:45.000Z',
        speed: 14,
        accuracy: 12,
      },
    ]);
    expect(railCorridorMatch.hasRoadMatches).toBe(true);
    expect(railCorridorMatch.segments.some((s) => s.kind === 'road' && s.roadKind === 'rail')).toBe(true);
  });
});
