import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { Compression, Header, PMTiles, Source } from 'pmtiles';
import {
  AveragedTrailStop,
  averageNearbyTrailPings,
  BoundingBox,
  DEFAULT_TRAIL_MAX_DISTANCE_METERS,
  DEFAULT_TRAIL_MAX_TIME_GAP_MS,
  DEFAULT_TRAIL_SPUR_THRESHOLD_METERS,
  haversineMeters,
  MatchedUserTrail,
  mergeTrailCoordinates,
  splitVisitsIntoTrips,
  TrailPathSegment,
  TrailPingLike,
  TrailStopVisit,
} from '@loved-ones/shared';

const METERS_PER_DEGREE_LAT = 111_320;
const MAX_SNAP_DISTANCE_METERS = 150;
const MAX_CANDIDATES_PER_STOP = 6;
const KIND_DIVERSITY_DISTANCE_METERS = 45;
const PARALLEL_RAIL_CROSSOVER_METERS = 10;
const MAX_TILES_PER_TRIP = 36;
const MAX_ASTAR_EXPANDED_NODES = 12_000;
const TARGET_ROAD_ZOOM = 14;
const NODE_MERGE_DISTANCE_METERS = 2.5;
const SEGMENT_GRID_CELL_METERS = 80;
const ARCHIVE_REFRESH_INTERVAL_MS = 15_000;
const EXCLUDED_ROAD_KINDS = new Set(['ferry']);
const MAX_COARSE_MOVING_ACCURACY_METERS = 85;

export interface RoadEdgeFeature {
  coords: [number, number][];
  kind: string;
}

export interface RoadTileProvider {
  getRevisionKey(): Promise<string>;
  getRoadFeaturesForBbox(bbox: BoundingBox): Promise<RoadEdgeFeature[]>;
}

class NodeFileSource implements Source {
  private fdPromise: Promise<fs.promises.FileHandle> | null = null;

  constructor(private readonly filePath: string) {}

  getKey(): string {
    return this.filePath;
  }

  private getHandle(): Promise<fs.promises.FileHandle> {
    if (!this.fdPromise) {
      this.fdPromise = fs.promises.open(this.filePath, 'r');
    }
    return this.fdPromise;
  }

  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const handle = await this.getHandle();
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return {
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead),
    };
  }

  async close(): Promise<void> {
    if (this.fdPromise) {
      const handle = await this.fdPromise.catch(() => null);
      this.fdPromise = null;
      await handle?.close().catch(() => {});
    }
  }
}

async function nodeDecompress(buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return buf;
  }
  const input = Buffer.from(buf);
  let out: Buffer;
  if (compression === Compression.Gzip) {
    out = zlib.gunzipSync(input);
  } else if (compression === Compression.Brotli) {
    out = zlib.brotliDecompressSync(input);
  } else if (compression === Compression.Zstd && typeof zlib.zstdDecompressSync === 'function') {
    out = zlib.zstdDecompressSync(input);
  } else {
    throw new Error(`Unsupported PMTiles compression algorithm: ${compression}`);
  }
  return Uint8Array.from(out).buffer;
}

function lonLatToTileXY(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  return { x, y };
}

function bboxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

function clipSegmentToTileBounds(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extent: number,
): [number, number, number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, x0],
    [dx, extent - x0],
    [-dy, y0],
    [dy, extent - y0],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

function mvtPointToLonLat(
  px: number,
  py: number,
  extent: number,
  z: number,
  tileX: number,
  tileY: number,
): [number, number] {
  const n = 2 ** z;
  const lon = ((tileX + px / extent) / n) * 360 - 180;
  const y2 = Math.PI * (1 - (2 * (tileY + py / extent)) / n);
  const lat = (Math.atan(Math.sinh(y2)) * 180) / Math.PI;
  return [lon, lat];
}

function decodeRoadsFromMvtTile(
  bytes: ArrayBuffer,
  z: number,
  x: number,
  y: number,
): RoadEdgeFeature[] {
  const tile = new VectorTile(new Pbf(new Uint8Array(bytes)));
  const roadsLayer = tile.layers.roads;
  if (!roadsLayer) return [];

  const features: RoadEdgeFeature[] = [];
  for (let i = 0; i < roadsLayer.length; i += 1) {
    const feat = roadsLayer.feature(i);
    if (feat.type !== 2) continue;
    const rawKind = feat.properties?.kind;
    const kind = typeof rawKind === 'string' ? rawKind : 'minor_road';
    if (EXCLUDED_ROAD_KINDS.has(kind)) continue;

    const extent = feat.extent || roadsLayer.extent || 4096;
    const lines = feat.loadGeometry();
    for (const line of lines) {
      if (line.length < 2) continue;
      let currentCoords: [number, number][] = [];
      let prevClippedEnd: [number, number] | null = null;

      for (let j = 0; j < line.length - 1; j += 1) {
        const a = line[j];
        const b = line[j + 1];
        const clipped = clipSegmentToTileBounds(a.x, a.y, b.x, b.y, extent);
        if (!clipped) {
          if (currentCoords.length >= 2) {
            features.push({ coords: currentCoords, kind });
          }
          currentCoords = [];
          prevClippedEnd = null;
          continue;
        }
        const [cx0, cy0, cx1, cy1] = clipped;
        const p0 = mvtPointToLonLat(cx0, cy0, extent, z, x, y);
        const p1 = mvtPointToLonLat(cx1, cy1, extent, z, x, y);
        const continued =
          prevClippedEnd !== null &&
          Math.abs(prevClippedEnd[0] - cx0) < 1e-6 &&
          Math.abs(prevClippedEnd[1] - cy0) < 1e-6;
        if (!continued) {
          if (currentCoords.length >= 2) {
            features.push({ coords: currentCoords, kind });
          }
          currentCoords = [p0, p1];
        } else {
          currentCoords.push(p1);
        }
        prevClippedEnd = [cx1, cy1];
      }

      if (currentCoords.length >= 2) {
        features.push({ coords: currentCoords, kind });
      }
    }
  }
  return features;
}

interface ArchiveHandle {
  filePath: string;
  mtimeMs: number;
  size: number;
  header: Header;
  bbox: BoundingBox;
  source: NodeFileSource;
  pmtiles: PMTiles;
}

/**
 * Reads road geometries directly from the local regional `.pmtiles` vector archives
 * in `TILES_DIR`, caching archive headers and decoded MVT road tiles in memory.
 */
export class PmtilesRoadTileProvider implements RoadTileProvider {
  private readonly tilesDir: string;
  private readonly tileCache = new Map<string, RoadEdgeFeature[]>();
  private readonly maxCachedTiles: number;
  private archives: ArchiveHandle[] = [];
  private lastScanAt = 0;
  private revisionKey = 'empty';
  private scanPromise: Promise<void> | null = null;

  constructor(options: { tilesDir?: string; maxCachedTiles?: number } = {}) {
    this.tilesDir = path.resolve(
      options.tilesDir ?? process.env.TILES_DIR ?? path.resolve(process.cwd(), '../../infra/tiles'),
    );
    this.maxCachedTiles = options.maxCachedTiles ?? 256;
  }

  private async ensureArchives(): Promise<ArchiveHandle[]> {
    const now = Date.now();
    if (now - this.lastScanAt < ARCHIVE_REFRESH_INTERVAL_MS && this.archives.length > 0) {
      return this.archives;
    }
    if (this.scanPromise) {
      await this.scanPromise;
      return this.archives;
    }
    this.scanPromise = this.scanArchives().finally(() => {
      this.scanPromise = null;
    });
    await this.scanPromise;
    return this.archives;
  }

  private async scanArchives(): Promise<void> {
    this.lastScanAt = Date.now();
    const candidates: string[] = [];
    const primary = path.join(this.tilesDir, 'region.pmtiles');
    if (fs.existsSync(primary)) {
      candidates.push(primary);
    }
    const regionsDir = path.join(this.tilesDir, 'regions');
    try {
      const entries = await fs.promises.readdir(regionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.pmtiles')) {
          candidates.push(path.join(regionsDir, entry.name));
        }
      }
    } catch {
      // regions directory may not exist yet
    }

    const existingByKey = new Map<string, ArchiveHandle>();
    for (const arch of this.archives) {
      existingByKey.set(`${arch.filePath}:${arch.mtimeMs}:${arch.size}`, arch);
    }

    const nextArchives: ArchiveHandle[] = [];
    const keptKeys = new Set<string>();
    const revParts: string[] = [];

    for (const filePath of candidates.sort()) {
      try {
        const st = await fs.promises.stat(filePath);
        if (!st.isFile() || st.size < 512) continue;
        const key = `${filePath}:${st.mtimeMs}:${st.size}`;
        const reused = existingByKey.get(key);
        if (reused) {
          nextArchives.push(reused);
          keptKeys.add(key);
          revParts.push(key);
          continue;
        }
        const source = new NodeFileSource(filePath);
        const pmtiles = new PMTiles(source, undefined, nodeDecompress);
        const header = await pmtiles.getHeader();
        if (header.numTileEntries === 0 || header.maxZoom < header.minZoom) {
          await source.close();
          continue;
        }
        const bbox: BoundingBox = {
          minLon: header.minLon,
          minLat: header.minLat,
          maxLon: header.maxLon,
          maxLat: header.maxLat,
        };
        nextArchives.push({
          filePath,
          mtimeMs: st.mtimeMs,
          size: st.size,
          header,
          bbox,
          source,
          pmtiles,
        });
        revParts.push(key);
      } catch {
        // Skip placeholder or unreadable archives
      }
    }

    for (const [key, oldArch] of existingByKey.entries()) {
      if (!keptKeys.has(key)) {
        await oldArch.source.close().catch(() => {});
      }
    }

    this.archives = nextArchives;
    this.revisionKey = revParts.length > 0 ? revParts.join('|') : 'empty';
  }

  async getRevisionKey(): Promise<string> {
    await this.ensureArchives();
    return this.revisionKey;
  }

  private getCachedTile(key: string): RoadEdgeFeature[] | undefined {
    const hit = this.tileCache.get(key);
    if (!hit) return undefined;
    this.tileCache.delete(key);
    this.tileCache.set(key, hit);
    return hit;
  }

  private setCachedTile(key: string, features: RoadEdgeFeature[]): void {
    if (this.tileCache.has(key)) {
      this.tileCache.delete(key);
    } else if (this.tileCache.size >= this.maxCachedTiles) {
      const oldestKey = this.tileCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.tileCache.delete(oldestKey);
      }
    }
    this.tileCache.set(key, features);
  }

  async getRoadFeaturesForBbox(bbox: BoundingBox): Promise<RoadEdgeFeature[]> {
    const archives = await this.ensureArchives();
    const matching = archives.filter((a) => bboxesOverlap(a.bbox, bbox));
    if (matching.length === 0) return [];

    const results: RoadEdgeFeature[] = [];
    for (const arch of matching) {
      let z = Math.min(arch.header.maxZoom, TARGET_ROAD_ZOOM);
      z = Math.max(arch.header.minZoom, z);

      let minTile = lonLatToTileXY(bbox.minLon, bbox.maxLat, z);
      let maxTile = lonLatToTileXY(bbox.maxLon, bbox.minLat, z);
      let count = (maxTile.x - minTile.x + 1) * (maxTile.y - minTile.y + 1);
      while (count > MAX_TILES_PER_TRIP && z > arch.header.minZoom) {
        z -= 1;
        minTile = lonLatToTileXY(bbox.minLon, bbox.maxLat, z);
        maxTile = lonLatToTileXY(bbox.maxLon, bbox.minLat, z);
        count = (maxTile.x - minTile.x + 1) * (maxTile.y - minTile.y + 1);
      }
      if (count > MAX_TILES_PER_TRIP) continue;

      for (let x = minTile.x; x <= maxTile.x; x += 1) {
        for (let y = minTile.y; y <= maxTile.y; y += 1) {
          const cacheKey = `${arch.filePath}:${arch.mtimeMs}:${z}/${x}/${y}`;
          let decoded = this.getCachedTile(cacheKey);
          if (!decoded) {
            try {
              const resp = await arch.pmtiles.getZxy(z, x, y);
              decoded = resp?.data ? decodeRoadsFromMvtTile(resp.data, z, x, y) : [];
            } catch {
              decoded = [];
            }
            this.setCachedTile(cacheKey, decoded);
          }
          for (const feat of decoded) {
            results.push(feat);
          }
        }
      }
    }

    return results;
  }

  async close(): Promise<void> {
    for (const arch of this.archives) {
      await arch.source.close().catch(() => {});
    }
    this.archives = [];
    this.tileCache.clear();
  }
}

interface GraphNode {
  id: number;
  lat: number;
  lon: number;
}

interface GraphSegment {
  id: number;
  aNode: number;
  bNode: number;
  lengthMeters: number;
  kind: string;
}

interface GraphAdjacency {
  to: number;
  segmentId: number;
  lengthMeters: number;
  kind: string;
}

interface RoadGraph {
  nodes: GraphNode[];
  segments: GraphSegment[];
  adj: GraphAdjacency[][];
  segGrid: Map<string, number[]>;
  cellLatDeg: number;
  cellLonDeg: number;
}

function buildRoadGraph(features: readonly RoadEdgeFeature[], refLat: number): RoadGraph {
  const cosLat = Math.max(0.15, Math.cos((Math.min(85, Math.abs(refLat)) * Math.PI) / 180));
  const nodeCellLat = NODE_MERGE_DISTANCE_METERS / METERS_PER_DEGREE_LAT;
  const nodeCellLon = nodeCellLat / cosLat;
  const nodeGrid = new Map<string, number[]>();
  const nodes: GraphNode[] = [];

  const getOrCreateNode = (lon: number, lat: number): number => {
    const cx = Math.floor(lat / nodeCellLat);
    const cy = Math.floor(lon / nodeCellLon);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = nodeGrid.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const nid of bucket) {
          const existing = nodes[nid];
          if (haversineMeters(lat, lon, existing.lat, existing.lon) <= NODE_MERGE_DISTANCE_METERS) {
            return nid;
          }
        }
      }
    }
    const id = nodes.length;
    nodes.push({ id, lat, lon });
    const key = `${cx}:${cy}`;
    const bucket = nodeGrid.get(key);
    if (bucket) bucket.push(id);
    else nodeGrid.set(key, [id]);
    return id;
  };

  const segments: GraphSegment[] = [];
  const adj: GraphAdjacency[][] = [];
  const edgeDedup = new Set<string>();

  const segCellLat = SEGMENT_GRID_CELL_METERS / METERS_PER_DEGREE_LAT;
  const segCellLon = segCellLat / cosLat;
  const segGrid = new Map<string, number[]>();

  const addSegToGrid = (segId: number, a: GraphNode, b: GraphNode) => {
    const minCx = Math.floor(Math.min(a.lat, b.lat) / segCellLat);
    const maxCx = Math.floor(Math.max(a.lat, b.lat) / segCellLat);
    const minCy = Math.floor(Math.min(a.lon, b.lon) / segCellLon);
    const maxCy = Math.floor(Math.max(a.lon, b.lon) / segCellLon);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = `${cx}:${cy}`;
        const list = segGrid.get(key);
        if (list) list.push(segId);
        else segGrid.set(key, [segId]);
      }
    }
  };

  const railNodeSet = new Set<number>();

  for (const feat of features) {
    for (let i = 0; i < feat.coords.length - 1; i += 1) {
      const [lonA, latA] = feat.coords[i];
      const [lonB, latB] = feat.coords[i + 1];
      if (!Number.isFinite(lonA) || !Number.isFinite(latA) || !Number.isFinite(lonB) || !Number.isFinite(latB)) {
        continue;
      }
      const aNode = getOrCreateNode(lonA, latA);
      const bNode = getOrCreateNode(lonB, latB);
      if (aNode === bNode) continue;

      const lo = Math.min(aNode, bNode);
      const hi = Math.max(aNode, bNode);
      const dedupKey = `${lo}:${hi}:${feat.kind}`;
      if (edgeDedup.has(dedupKey)) continue;
      edgeDedup.add(dedupKey);

      const nodeA = nodes[aNode];
      const nodeB = nodes[bNode];
      const lengthMeters = haversineMeters(nodeA.lat, nodeA.lon, nodeB.lat, nodeB.lon);
      if (lengthMeters < 0.2) continue;

      while (adj.length < nodes.length) adj.push([]);
      const segId = segments.length;
      segments.push({ id: segId, aNode, bNode, lengthMeters, kind: feat.kind });
      adj[aNode].push({ to: bNode, segmentId: segId, lengthMeters, kind: feat.kind });
      adj[bNode].push({ to: aNode, segmentId: segId, lengthMeters, kind: feat.kind });
      addSegToGrid(segId, nodeA, nodeB);
      if (feat.kind === 'rail') {
        railNodeSet.add(aNode);
        railNodeSet.add(bNode);
      }
    }
  }

  // Link adjacent parallel rail tracks (3-10m apart at stations, sidings, and tile boundaries)
  // by projecting each rail node onto nearby parallel rail segments in segGrid.
  if (railNodeSet.size > 1) {
    for (const rNodeId of railNodeSet) {
      const rNode = nodes[rNodeId];
      const cx = Math.floor(rNode.lat / segCellLat);
      const cy = Math.floor(rNode.lon / segCellLon);

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const segIds = segGrid.get(`${cx + dx}:${cy + dy}`);
          if (!segIds) continue;
          for (const segId of segIds) {
            const seg = segments[segId];
            if (seg.kind !== 'rail' || seg.aNode === rNodeId || seg.bNode === rNodeId) continue;
            const aNode = nodes[seg.aNode];
            const bNode = nodes[seg.bNode];
            const proj = projectPointOntoSegment(rNode.lat, rNode.lon, aNode, bNode);
            if (proj.distMeters > PARALLEL_RAIL_CROSSOVER_METERS) continue;

            const crossoverPenalty = proj.distMeters * 1.4 + 4;
            for (const [targetId, alongDist] of [
              [seg.aNode, proj.t * seg.lengthMeters],
              [seg.bNode, (1 - proj.t) * seg.lengthMeters],
            ] as const) {
              if (targetId === rNodeId) continue;
              const lo = Math.min(rNodeId, targetId);
              const hi = Math.max(rNodeId, targetId);
              const dedupKey = `${lo}:${hi}:rail`;
              if (edgeDedup.has(dedupKey)) continue;
              edgeDedup.add(dedupKey);
              const totalLen = alongDist + crossoverPenalty;
              const newSegId = segments.length;
              segments.push({ id: newSegId, aNode: rNodeId, bNode: targetId, lengthMeters: totalLen, kind: 'rail' });
              adj[rNodeId].push({ to: targetId, segmentId: newSegId, lengthMeters: totalLen, kind: 'rail' });
              adj[targetId].push({ to: rNodeId, segmentId: newSegId, lengthMeters: totalLen, kind: 'rail' });
            }
          }
        }
      }
    }
  }

  return {
    nodes,
    segments,
    adj,
    segGrid,
    cellLatDeg: segCellLat,
    cellLonDeg: segCellLon,
  };
}

interface SnapCandidate {
  segmentId: number;
  kind: string;
  t: number;
  lat: number;
  lon: number;
  distMeters: number;
  bearingDeg: number;
}

function segmentBearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.max(0.15, Math.cos(((aLat + bLat) * 0.5 * Math.PI) / 180));
  const dx = (bLon - aLon) * cosLat;
  const dy = bLat - aLat;
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return 0;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

function directedAngleDiffDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function undirectedAngleDiffDeg(a: number, b: number): number {
  const diff = Math.abs((a % 180) - (b % 180));
  return diff > 90 ? 180 - diff : diff;
}

function initialBearingDeg(coords: readonly [number, number][]): number | null {
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    if (haversineMeters(latA, lonA, latB, lonB) >= 2) {
      return segmentBearingDeg(latA, lonA, latB, lonB);
    }
  }
  return null;
}

function finalBearingDeg(coords: readonly [number, number][]): number | null {
  for (let i = coords.length - 1; i > 0; i -= 1) {
    const [lonA, latA] = coords[i - 1];
    const [lonB, latB] = coords[i];
    if (haversineMeters(latA, lonA, latB, lonB) >= 2) {
      return segmentBearingDeg(latA, lonA, latB, lonB);
    }
  }
  return null;
}

function projectPointOntoSegment(
  lat: number,
  lon: number,
  a: GraphNode,
  b: GraphNode,
): { t: number; lat: number; lon: number; distMeters: number } {
  const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  const ax = (a.lon - lon) * METERS_PER_DEGREE_LAT * cosLat;
  const ay = (a.lat - lat) * METERS_PER_DEGREE_LAT;
  const bx = (b.lon - lon) * METERS_PER_DEGREE_LAT * cosLat;
  const by = (b.lat - lat) * METERS_PER_DEGREE_LAT;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;

  const projLat = a.lat + t * (b.lat - a.lat);
  const projLon = a.lon + t * (b.lon - a.lon);
  return {
    t,
    lat: projLat,
    lon: projLon,
    distMeters: haversineMeters(lat, lon, projLat, projLon),
  };
}

function candidateCategory(kind: string): 'rail' | 'path' | 'road' {
  if (kind === 'rail') return 'rail';
  if (kind === 'path') return 'path';
  return 'road';
}

function findSnapCandidates(graph: RoadGraph, lat: number, lon: number): SnapCandidate[] {
  if (graph.segments.length === 0) return [];
  const radiusLatCells = Math.ceil(MAX_SNAP_DISTANCE_METERS / SEGMENT_GRID_CELL_METERS) + 1;
  const cx = Math.floor(lat / graph.cellLatDeg);
  const cy = Math.floor(lon / graph.cellLonDeg);

  const seenSegs = new Set<number>();
  const rawCandidates: SnapCandidate[] = [];

  for (let dx = -radiusLatCells; dx <= radiusLatCells; dx += 1) {
    for (let dy = -radiusLatCells; dy <= radiusLatCells; dy += 1) {
      const segIds = graph.segGrid.get(`${cx + dx}:${cy + dy}`);
      if (!segIds) continue;
      for (const segId of segIds) {
        if (seenSegs.has(segId)) continue;
        seenSegs.add(segId);
        const seg = graph.segments[segId];
        const aNode = graph.nodes[seg.aNode];
        const bNode = graph.nodes[seg.bNode];
        const proj = projectPointOntoSegment(lat, lon, aNode, bNode);
        if (proj.distMeters <= MAX_SNAP_DISTANCE_METERS) {
          rawCandidates.push({
            segmentId: segId,
            kind: seg.kind,
            t: proj.t,
            lat: proj.lat,
            lon: proj.lon,
            distMeters: proj.distMeters,
            bearingDeg: segmentBearingDeg(aNode.lat, aNode.lon, bNode.lat, bNode.lon),
          });
        }
      }
    }
  }

  rawCandidates.sort((a, b) => a.distMeters - b.distMeters);

  // Deduplicate abutting segments that share a graph vertex and project to essentially the same point (<= 2.2m)
  // or identical co-linear parallel footpaths within 3.5m, while keeping distinct parallel rail tracks.
  const deduped: SnapCandidate[] = [];
  for (const cand of rawCandidates) {
    const seg = graph.segments[cand.segmentId];
    const cat = candidateCategory(cand.kind);
    const isRedundant = deduped.some((existing) => {
      if (candidateCategory(existing.kind) !== cat) return false;
      const exSeg = graph.segments[existing.segmentId];
      const sharesNode =
        seg.aNode === exSeg.aNode ||
        seg.aNode === exSeg.bNode ||
        seg.bNode === exSeg.aNode ||
        seg.bNode === exSeg.bNode;
      const projDist = haversineMeters(existing.lat, existing.lon, cand.lat, cand.lon);
      if (sharesNode && projDist <= 2.2 && undirectedAngleDiffDeg(existing.bearingDeg, cand.bearingDeg) <= 12) {
        return true;
      }
      if (cat === 'path' && projDist <= 3.5 && undirectedAngleDiffDeg(existing.bearingDeg, cand.bearingDeg) <= 10) {
        return true;
      }
      return false;
    });
    if (!isRedundant) {
      deduped.push(cand);
    }
  }

  // Reserve up to 2 closest slots per distinct category ('rail', 'road', 'path') within 45m
  // so 6 parallel station rail tracks never crowd out the intersecting street or sidewalk.
  const selected: SnapCandidate[] = [];
  const selectedIds = new Set<number>();
  const categoryCounts = new Map<'rail' | 'path' | 'road', number>();

  for (const cand of deduped) {
    if (cand.distMeters > KIND_DIVERSITY_DISTANCE_METERS) break;
    const cat = candidateCategory(cand.kind);
    const count = categoryCounts.get(cat) ?? 0;
    if (count < 2) {
      categoryCounts.set(cat, count + 1);
      selected.push(cand);
      selectedIds.add(cand.segmentId);
      if (selected.length >= MAX_CANDIDATES_PER_STOP) break;
    }
  }

  for (const cand of deduped) {
    if (selected.length >= MAX_CANDIDATES_PER_STOP) break;
    if (!selectedIds.has(cand.segmentId)) {
      selected.push(cand);
      selectedIds.add(cand.segmentId);
    }
  }

  selected.sort((a, b) => a.distMeters - b.distMeters);
  return selected;
}

/**
 * Weights road and transit edges by Protomaps `kind` and implied trip speed so walking trips
 * use footpaths/side streets, driving uses roads, and transit speeds can follow rail/tram tracks.
 */
function roadCostFactor(kind: string, speedMps: number | null): number {
  if (speedMps !== null && speedMps <= 2.5) {
    if (kind === 'path') return 1.0;
    if (kind === 'rail') return 4.5;
    if (kind === 'highway') return 2.2;
    if (kind === 'major_road' || kind === 'medium_road') return 1.15;
    return 1.05;
  }
  if (speedMps !== null && speedMps > 4.5) {
    if (kind === 'highway') return 0.95;
    if (kind === 'major_road' || kind === 'medium_road') return 1.0;
    if (kind === 'rail') return 1.02;
    if (kind === 'path') return 3.5;
    return 1.15;
  }
  if (kind === 'highway') return 1.2;
  if (kind === 'path') return 1.35;
  if (kind === 'rail') return 1.8;
  return 1.0;
}

function emissionCost(
  cand: SnapCandidate,
  visit: TrailStopVisit,
  speedMps: number | null,
): number {
  const sigma =
    typeof visit.accuracyMeters === 'number' && Number.isFinite(visit.accuracyMeters)
      ? Math.max(12, Math.min(120, visit.accuracyMeters))
      : 22;
  const distTerm = cand.distMeters * (22 / sigma) * 1.35 + (cand.distMeters / sigma) ** 2 * 14;
  const roadPenalty = (roadCostFactor(cand.kind, speedMps) - 1) * 15;
  let headingPenalty = 0;
  if (
    typeof visit.headingDeg === 'number' &&
    Number.isFinite(visit.headingDeg) &&
    (visit.maxSpeedMps === null || visit.maxSpeedMps >= 1.5)
  ) {
    const angleDiff = undirectedAngleDiffDeg(visit.headingDeg, cand.bearingDeg);
    headingPenalty = (angleDiff / 90) * 12;
  }
  return distTerm + roadPenalty + headingPenalty;
}

interface AStarHeapNode {
  nodeId: number;
  f: number;
}

function pushAStar(heap: AStarHeapNode[], item: AStarHeapNode): void {
  heap.push(item);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (heap[parent].f <= item.f) break;
    heap[idx] = heap[parent];
    idx = parent;
  }
  heap[idx] = item;
}

function popAStar(heap: AStarHeapNode[]): AStarHeapNode | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    let idx = 0;
    const len = heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (left < len && heap[left].f < heap[smallest].f) smallest = left;
      if (right < len && heap[right].f < heap[smallest].f) smallest = right;
      if (smallest === idx) break;
      heap[idx] = heap[smallest];
      idx = smallest;
    }
    heap[idx] = last;
  }
  return top;
}

interface RoutedLegResult {
  cost: number;
  distanceMeters: number;
  coordinates: [number, number][];
  dominantRoadKind: string;
}

function routeBetweenCandidates(
  graph: RoadGraph,
  start: SnapCandidate,
  goal: SnapCandidate,
  speedMps: number | null,
  maxDetourMeters: number,
): RoutedLegResult | null {
  if (start.segmentId === goal.segmentId) {
    const dist = haversineMeters(start.lat, start.lon, goal.lat, goal.lon);
    return {
      cost: dist * roadCostFactor(start.kind, speedMps),
      distanceMeters: dist,
      coordinates: [
        [Number(start.lon.toFixed(6)), Number(start.lat.toFixed(6))],
        [Number(goal.lon.toFixed(6)), Number(goal.lat.toFixed(6))],
      ],
      dominantRoadKind: start.kind,
    };
  }

  const startSeg = graph.segments[start.segmentId];
  const goalSeg = graph.segments[goal.segmentId];
  const VIRTUAL_GOAL = -2;
  const VIRTUAL_START = -1;

  const gScore = new Map<number, number>();
  const distScore = new Map<number, number>();
  const parentNode = new Map<number, number>();
  const parentKind = new Map<number, string>();
  const closed = new Set<number>();
  const heap: AStarHeapNode[] = [];
  const maxAllowedCost = maxDetourMeters * 2.5;

  const hToGoal = (lat: number, lon: number) =>
    haversineMeters(lat, lon, goal.lat, goal.lon) * 0.95;

  const seedStartEndpoint = (nodeId: number, distFromSnap: number) => {
    const node = graph.nodes[nodeId];
    const edgeCost = distFromSnap * roadCostFactor(startSeg.kind, speedMps);
    const prev = gScore.get(nodeId);
    if (prev === undefined || edgeCost < prev) {
      gScore.set(nodeId, edgeCost);
      distScore.set(nodeId, distFromSnap);
      parentNode.set(nodeId, VIRTUAL_START);
      parentKind.set(nodeId, startSeg.kind);
      pushAStar(heap, { nodeId, f: edgeCost + hToGoal(node.lat, node.lon) });
    }
  };

  seedStartEndpoint(startSeg.aNode, start.t * startSeg.lengthMeters);
  seedStartEndpoint(startSeg.bNode, (1 - start.t) * startSeg.lengthMeters);

  let expanded = 0;
  while (heap.length > 0 && expanded < MAX_ASTAR_EXPANDED_NODES) {
    const cur = popAStar(heap)!;
    if (cur.nodeId === VIRTUAL_GOAL) {
      break;
    }
    if (closed.has(cur.nodeId)) continue;
    closed.add(cur.nodeId);
    expanded += 1;

    const curCost = gScore.get(cur.nodeId) ?? Infinity;
    const curDist = distScore.get(cur.nodeId) ?? Infinity;
    if (curCost > maxAllowedCost) continue;

    // If we reached an endpoint of goalSeg, try connecting directly to the goal projection
    if (cur.nodeId === goalSeg.aNode || cur.nodeId === goalSeg.bNode) {
      const remDist =
        cur.nodeId === goalSeg.aNode
          ? goal.t * goalSeg.lengthMeters
          : (1 - goal.t) * goalSeg.lengthMeters;
      const nextCost = curCost + remDist * roadCostFactor(goalSeg.kind, speedMps);
      const nextDist = curDist + remDist;
      const prevGoalCost = gScore.get(VIRTUAL_GOAL);
      if (nextDist <= maxDetourMeters && (prevGoalCost === undefined || nextCost < prevGoalCost)) {
        gScore.set(VIRTUAL_GOAL, nextCost);
        distScore.set(VIRTUAL_GOAL, nextDist);
        parentNode.set(VIRTUAL_GOAL, cur.nodeId);
        parentKind.set(VIRTUAL_GOAL, goalSeg.kind);
        pushAStar(heap, { nodeId: VIRTUAL_GOAL, f: nextCost });
      }
    }

    const edges = graph.adj[cur.nodeId] ?? [];
    for (const edge of edges) {
      if (closed.has(edge.to)) continue;
      const nextDist = curDist + edge.lengthMeters;
      if (nextDist > maxDetourMeters) continue;
      const nextCost = curCost + edge.lengthMeters * roadCostFactor(edge.kind, speedMps);
      if (nextCost > maxAllowedCost) continue;
      const prevCost = gScore.get(edge.to);
      if (prevCost === undefined || nextCost < prevCost) {
        gScore.set(edge.to, nextCost);
        distScore.set(edge.to, nextDist);
        parentNode.set(edge.to, cur.nodeId);
        parentKind.set(edge.to, edge.kind);
        const targetNode = graph.nodes[edge.to];
        pushAStar(heap, { nodeId: edge.to, f: nextCost + hToGoal(targetNode.lat, targetNode.lon) });
      }
    }
  }

  const finalCost = gScore.get(VIRTUAL_GOAL);
  const finalDist = distScore.get(VIRTUAL_GOAL);
  if (finalCost === undefined || finalDist === undefined) return null;

  const revCoords: [number, number][] = [
    [Number(goal.lon.toFixed(6)), Number(goal.lat.toFixed(6))],
  ];
  const kindCounts = new Map<string, number>();
  let walker = parentNode.get(VIRTUAL_GOAL);
  const goalEdgeKind = parentKind.get(VIRTUAL_GOAL);
  if (goalEdgeKind) {
    kindCounts.set(goalEdgeKind, (kindCounts.get(goalEdgeKind) ?? 0) + 1);
  }

  while (walker !== undefined && walker !== VIRTUAL_START) {
    const n = graph.nodes[walker];
    revCoords.push([Number(n.lon.toFixed(6)), Number(n.lat.toFixed(6))]);
    const k = parentKind.get(walker);
    if (k) kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
    walker = parentNode.get(walker);
  }
  revCoords.push([Number(start.lon.toFixed(6)), Number(start.lat.toFixed(6))]);
  revCoords.reverse();

  let dominantRoadKind = start.kind;
  let bestCount = -1;
  for (const [k, cnt] of kindCounts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt;
      dominantRoadKind = k;
    }
  }

  return {
    cost: finalCost,
    distanceMeters: finalDist,
    coordinates: mergeTrailCoordinates([revCoords]),
    dominantRoadKind,
  };
}

function estimateLegSpeedMps(prev: TrailStopVisit, curr: TrailStopVisit, distMeters: number): number | null {
  const speedSamples = [prev.maxSpeedMps, curr.maxSpeedMps].filter(
    (s): s is number => typeof s === 'number' && Number.isFinite(s) && s >= 0,
  );
  if (speedSamples.length > 0) {
    return Math.max(...speedSamples);
  }
  const exitMs = Date.parse(prev.lastRecordedAt);
  const enterMs = Date.parse(curr.firstRecordedAt);
  if (Number.isFinite(exitMs) && Number.isFinite(enterMs) && enterMs > exitMs) {
    return distMeters / ((enterMs - exitMs) / 1000);
  }
  return null;
}

function padBoundingBoxMeters(points: readonly { latitude: number; longitude: number }[], padMeters: number): BoundingBox {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const pt of points) {
    if (pt.latitude < minLat) minLat = pt.latitude;
    if (pt.latitude > maxLat) maxLat = pt.latitude;
    if (pt.longitude < minLon) minLon = pt.longitude;
    if (pt.longitude > maxLon) maxLon = pt.longitude;
  }
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.max(0.15, Math.cos((Math.min(85, Math.abs(midLat)) * Math.PI) / 180));
  const dLat = padMeters / METERS_PER_DEGREE_LAT;
  const dLon = dLat / cosLat;
  return {
    minLon: Math.max(-180, minLon - dLon),
    minLat: Math.max(-90, minLat - dLat),
    maxLon: Math.min(180, maxLon + dLon),
    maxLat: Math.min(90, maxLat + dLat),
  };
}

export interface RoadTrailMatcherOptions {
  tileProvider?: RoadTileProvider;
  tilesDir?: string;
  maxTimeGapMs?: number;
  maxDistanceMeters?: number;
  spurThresholdMeters?: number;
  maxCachedResults?: number;
}

/**
 * Matches averaged trail stop sequences onto vector road/path geometries from
 * regional `.pmtiles` archives using bounded A* + Viterbi map matching, while
 * leaving FUZZED trails direct and bridging >15 m off-road offsets with spurs.
 */
function visitCrossTrackMeters(a: TrailStopVisit, b: TrailStopVisit, c: TrailStopVisit): number {
  const cosLat = Math.max(0.15, Math.cos((a.latitude * Math.PI) / 180));
  const cx = (c.longitude - a.longitude) * METERS_PER_DEGREE_LAT * cosLat;
  const cy = (c.latitude - a.latitude) * METERS_PER_DEGREE_LAT;
  const bx = (b.longitude - a.longitude) * METERS_PER_DEGREE_LAT * cosLat;
  const by = (b.latitude - a.latitude) * METERS_PER_DEGREE_LAT;
  const lenSq = cx * cx + cy * cy;
  if (lenSq < 1e-6) return Math.hypot(bx, by);
  const t = Math.max(0, Math.min(1, (bx * cx + by * cy) / lenSq));
  return Math.hypot(bx - t * cx, by - t * cy);
}

/**
 * Anchors on stationary dwells and trip endpoints, removing intermediate
 * coarse moving waypoints that jump off the local corridor chord without
 * contributing genuine path progression toward the next anchor.
 */
function filterRelevantMovingVisits(visits: readonly TrailStopVisit[]): TrailStopVisit[] {
  if (visits.length < 3) return [...visits];
  const kept: TrailStopVisit[] = [visits[0]];
  for (let i = 1; i < visits.length - 1; i += 1) {
    const prev = kept[kept.length - 1];
    const curr = visits[i];
    const next = visits[i + 1];
    if (!curr.isDwell) {
      const acc = curr.accuracyMeters;
      const crossTrack = visitCrossTrackMeters(prev, curr, next);
      const dAB = haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
      const dBC = haversineMeters(curr.latitude, curr.longitude, next.latitude, next.longitude);
      const dAC = haversineMeters(prev.latitude, prev.longitude, next.latitude, next.longitude);
      const detour = dAB + dBC - dAC;
      if (typeof acc === 'number' && Number.isFinite(acc) && acc >= 65 && crossTrack > 70 && detour > 55) {
        continue;
      }
    }
    kept.push(curr);
  }
  kept.push(visits[visits.length - 1]);
  return kept;
}

function minCandidateBearingError(
  bearingDeg: number,
  candidates: readonly SnapCandidate[],
  maxDistMeters = Infinity,
): number | null {
  if (candidates.length === 0) return null;
  let best = Infinity;
  for (const c of candidates) {
    if (c.distMeters > maxDistMeters) continue;
    const err = undirectedAngleDiffDeg(bearingDeg, c.bearingDeg);
    if (err < best) best = err;
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * Uses the PMTiles road/rail vector bearings at (A, B, C) to drop off-angle
 * triangle spikes even when GPS `accuracy` is missing or misreported: if chord
 * A->C aligns closely with the underlying road/rail graph at both ends while B
 * juts off-corridor and legs A->B / B->C cut across map geometry, B is noise.
 */
function filterOffAngleTriangleVisits(
  visits: readonly TrailStopVisit[],
  candidatesByStop: readonly SnapCandidate[][],
): { visits: TrailStopVisit[]; candidatesByStop: SnapCandidate[][] } {
  if (visits.length < 3) {
    return { visits: [...visits], candidatesByStop: [...candidatesByStop] };
  }

  const keptVisits: TrailStopVisit[] = [visits[0]];
  const keptCands: SnapCandidate[][] = [candidatesByStop[0]];

  for (let i = 1; i < visits.length - 1; i += 1) {
    const prev = keptVisits[keptVisits.length - 1];
    const prevCands = keptCands[keptCands.length - 1];
    const curr = visits[i];
    const currCands = candidatesByStop[i];
    const next = visits[i + 1];
    const nextCands = candidatesByStop[i + 1];

    if (!curr.isDwell) {
      const crossTrack = visitCrossTrackMeters(prev, curr, next);
      if (crossTrack > 55) {
        const bearingAB = segmentBearingDeg(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
        const bearingBC = segmentBearingDeg(curr.latitude, curr.longitude, next.latitude, next.longitude);
        const bearingAC = segmentBearingDeg(prev.latitude, prev.longitude, next.latitude, next.longitude);
        const turnAngleAtB = directedAngleDiffDeg(bearingAB, bearingBC);

        const chordAlignA = minCandidateBearingError(bearingAC, prevCands, 25);
        const chordAlignC = minCandidateBearingError(bearingAC, nextCands, 25);
        const legABAlign = minCandidateBearingError(bearingAB, currCands, 25);
        const legBCAlign = minCandidateBearingError(bearingBC, currCands, 25);

        const chordMatchesRoad =
          chordAlignA !== null && chordAlignC !== null && chordAlignA <= 18 && chordAlignC <= 18;
        const legsCutAcrossMap =
          (legABAlign ?? 90) > 25 && (legBCAlign ?? 90) > 25;
        const sharpOffAngleReversal =
          turnAngleAtB >= 80 && ((legABAlign ?? 90) > 22 || (legBCAlign ?? 90) > 22);

        if (chordMatchesRoad && turnAngleAtB >= 35 && (legsCutAcrossMap || sharpOffAngleReversal)) {
          continue;
        }
      }
    }

    keptVisits.push(curr);
    keptCands.push(currCands);
  }

  keptVisits.push(visits[visits.length - 1]);
  keptCands.push(candidatesByStop[visits.length - 1]);
  return { visits: keptVisits, candidatesByStop: keptCands };
}

export class RoadTrailMatcher {
  private readonly tileProvider: RoadTileProvider;
  private readonly ownsProvider: boolean;
  private readonly maxTimeGapMs: number;
  private readonly maxDistanceMeters: number;
  private readonly spurThresholdMeters: number;
  private readonly maxCachedResults: number;
  private readonly resultCache = new Map<string, MatchedUserTrail[]>();

  constructor(options: RoadTrailMatcherOptions = {}) {
    if (options.tileProvider) {
      this.tileProvider = options.tileProvider;
      this.ownsProvider = false;
    } else {
      this.tileProvider = new PmtilesRoadTileProvider({ tilesDir: options.tilesDir });
      this.ownsProvider = true;
    }
    this.maxTimeGapMs = options.maxTimeGapMs ?? DEFAULT_TRAIL_MAX_TIME_GAP_MS;
    this.maxDistanceMeters = options.maxDistanceMeters ?? DEFAULT_TRAIL_MAX_DISTANCE_METERS;
    this.spurThresholdMeters = options.spurThresholdMeters ?? DEFAULT_TRAIL_SPUR_THRESHOLD_METERS;
    this.maxCachedResults = options.maxCachedResults ?? 128;
  }

  private async matchSingleTrip(rawVisits: readonly TrailStopVisit[]): Promise<{
    segments: TrailPathSegment[];
    visits: TrailStopVisit[];
    hasRoadMatches: boolean;
  }> {
    const visits = filterRelevantMovingVisits(rawVisits);
    if (visits.length < 2) {
      return { segments: [], visits: [...visits], hasRoadMatches: false };
    }

    // Never road-snap FUZZED (~1 km grid) trails; render straight dashed lines instead.
    if (visits.some((v) => v.isFuzzed)) {
      return {
        segments: [
          {
            kind: 'direct',
            coordinates: visits.map((v) => [v.longitude, v.latitude] as [number, number]),
          },
        ],
        visits: [...visits],
        hasRoadMatches: false,
      };
    }

    const paddedBbox = padBoundingBoxMeters(visits, 500);
    const roadFeatures = await this.tileProvider.getRoadFeaturesForBbox(paddedBbox);
    if (roadFeatures.length === 0) {
      return {
        segments: [
          {
            kind: 'direct',
            coordinates: visits.map((v) => [v.longitude, v.latitude] as [number, number]),
          },
        ],
        visits: [...visits],
        hasRoadMatches: false,
      };
    }

    const midLat = (paddedBbox.minLat + paddedBbox.maxLat) / 2;
    const graph = buildRoadGraph(roadFeatures, midLat);
    const rawCandidatesByStop = visits.map((v) => findSnapCandidates(graph, v.latitude, v.longitude));
    const pruned = filterOffAngleTriangleVisits(visits, rawCandidatesByStop);
    const activeVisits = pruned.visits;
    const candidatesByStop = pruned.candidatesByStop;

    if (activeVisits.length < 2) {
      return { segments: [], visits: activeVisits, hasRoadMatches: false };
    }

    // Viterbi DP across candidate snaps per stop, supporting turn-angle penalties and 1-step outlier skipping.
    const chosenCandidate: Array<SnapCandidate | null> = new Array(activeVisits.length).fill(null);
    const skippedVisit = new Array<boolean>(activeVisits.length).fill(false);
    const legRoutes: Array<{ route: RoutedLegResult; nextIdx: number } | null> = new Array(
      activeVisits.length,
    ).fill(null);

    let chainStart = 0;
    while (chainStart < activeVisits.length) {
      if (candidatesByStop[chainStart].length === 0) {
        chainStart += 1;
        continue;
      }

      let chainEnd = chainStart;
      while (chainEnd + 1 < activeVisits.length && candidatesByStop[chainEnd + 1].length > 0) {
        chainEnd += 1;
      }

      if (chainEnd === chainStart) {
        chosenCandidate[chainStart] = candidatesByStop[chainStart][0];
        chainStart += 1;
        continue;
      }

      const dpCost: number[][] = [];
      const dpPrevCand: number[][] = [];
      const dpPrevStepOffset: number[][] = [];
      const dpRoute: Array<Array<RoutedLegResult | null>> = [];
      const dpBearing: Array<Array<number | null>> = [];

      const firstCands = candidatesByStop[chainStart];
      const firstVisit = activeVisits[chainStart];
      const secondVisit = activeVisits[chainStart + 1];
      const firstStraightDist = haversineMeters(
        firstVisit.latitude,
        firstVisit.longitude,
        secondVisit.latitude,
        secondVisit.longitude,
      );
      const firstDepartureSpeedMps =
        firstVisit.maxSpeedMps !== null && firstVisit.maxSpeedMps > 0.5
          ? firstVisit.maxSpeedMps
          : estimateLegSpeedMps(firstVisit, secondVisit, firstStraightDist);
      dpCost.push(firstCands.map((c) => emissionCost(c, firstVisit, firstDepartureSpeedMps)));
      dpPrevCand.push(firstCands.map(() => -1));
      dpPrevStepOffset.push(firstCands.map(() => 0));
      dpRoute.push(firstCands.map(() => null));
      dpBearing.push(firstCands.map(() => null));

      let brokenAt: number | null = null;
      for (let idx = chainStart + 1; idx <= chainEnd; idx += 1) {
        const currVisit = activeVisits[idx];
        const currCands = candidatesByStop[idx];
        const prevRow = dpCost[dpCost.length - 1];
        const prevBearings = dpBearing[dpBearing.length - 1];

        const prevVisit = activeVisits[idx - 1];
        const straightDist = haversineMeters(
          prevVisit.latitude,
          prevVisit.longitude,
          currVisit.latitude,
          currVisit.longitude,
        );
        const speedMps = estimateLegSpeedMps(prevVisit, currVisit, straightDist);
        const maxDetour = Math.max(800, straightDist * 3.5 + 500);
        const prevCands = candidatesByStop[idx - 1];

        // Allow skipping 1 non-dwell moving waypoint when it forces an unnatural side-street loop/U-turn
        const canSkipPrev =
          idx >= chainStart + 2 &&
          !prevVisit.isDwell &&
          !activeVisits[idx - 2].isDwell;
        const skipPrevVisit = canSkipPrev ? activeVisits[idx - 2] : null;
        const skipStraightDist = skipPrevVisit
          ? haversineMeters(
              skipPrevVisit.latitude,
              skipPrevVisit.longitude,
              currVisit.latitude,
              currVisit.longitude,
            )
          : 0;
        const skipSpeedMps = skipPrevVisit
          ? estimateLegSpeedMps(skipPrevVisit, currVisit, skipStraightDist)
          : null;
        const skipMaxDetour = Math.max(800, skipStraightDist * 3.5 + 500);
        const skipCands = canSkipPrev ? candidatesByStop[idx - 2] : [];
        const skipRow = canSkipPrev ? dpCost[dpCost.length - 2] : [];
        const skipBearings = canSkipPrev ? dpBearing[dpBearing.length - 2] : [];
        const prevAcc =
          typeof prevVisit.accuracyMeters === 'number' && Number.isFinite(prevVisit.accuracyMeters)
            ? prevVisit.accuracyMeters
            : 35;
        const skipPenalty = 45 + Math.max(0, 65 - prevAcc) * 0.55;

        const nextRow: number[] = [];
        const nextPrevCand: number[] = [];
        const nextStepOffset: number[] = [];
        const nextRoutes: Array<RoutedLegResult | null> = [];
        const nextBearings: Array<number | null> = [];
        let anyConnected = false;

        for (let ci = 0; ci < currCands.length; ci += 1) {
          const currCand = currCands[ci];
          const emission = emissionCost(currCand, currVisit, speedMps);
          let bestTotal = Infinity;
          let bestPrevIdx = -1;
          let bestStepOffset = 1;
          let bestRoute: RoutedLegResult | null = null;
          let bestEndBearing: number | null = null;

          for (let pi = 0; pi < prevCands.length; pi += 1) {
            if (!Number.isFinite(prevRow[pi])) continue;
            const prevCand = prevCands[pi];
            let routed = routeBetweenCandidates(
              graph,
              prevCand,
              currCand,
              speedMps,
              maxDetour,
            );
            let modeTransferPenalty = 0;
            if (!routed && (prevCand.kind === 'rail') !== (currCand.kind === 'rail')) {
              // Station-to-street or street-to-station transfer at prevVisit: pick the lowest-cost co-located candidate
              let bestAltScore = Infinity;
              for (let altIdx = 0; altIdx < prevCands.length; altIdx += 1) {
                const altCand = prevCands[altIdx];
                if ((altCand.kind === 'rail') !== (currCand.kind === 'rail')) continue;
                const transferDist = haversineMeters(prevCand.lat, prevCand.lon, altCand.lat, altCand.lon);
                if (transferDist > 45) continue;
                const altRouted = routeBetweenCandidates(graph, altCand, currCand, speedMps, maxDetour);
                if (altRouted) {
                  const altDetour = Math.max(0, altRouted.distanceMeters + transferDist - straightDist);
                  const altScore = altRouted.cost * 0.35 + altDetour * 0.35 + transferDist * 1.3;
                  if (altScore < bestAltScore) {
                    bestAltScore = altScore;
                    routed = {
                      cost: altRouted.cost + transferDist * 1.5,
                      distanceMeters: altRouted.distanceMeters + transferDist,
                      coordinates: mergeTrailCoordinates([
                        [[Number(prevCand.lon.toFixed(6)), Number(prevCand.lat.toFixed(6))]],
                        altRouted.coordinates,
                      ]),
                      dominantRoadKind: altRouted.dominantRoadKind,
                    };
                    modeTransferPenalty = 45 + transferDist * 0.8;
                  }
                }
              }
            }
            if (!routed) continue;
            const detourPenalty = Math.max(0, routed.distanceMeters - straightDist) * 0.35;
            let turnPenalty = 0;
            const prevB = prevBearings[pi];
            const depB = initialBearingDeg(routed.coordinates);
            if (prevB !== null && depB !== null && !prevVisit.isDwell && routed.distanceMeters >= 12) {
              const turnDeg = directedAngleDiffDeg(prevB, depB);
              if (turnDeg > 135) turnPenalty = 55;
              else if (turnDeg > 75) turnPenalty = (turnDeg - 75) * 0.3;
            }
            const total =
              prevRow[pi] +
              routed.cost * 0.35 +
              detourPenalty +
              turnPenalty +
              modeTransferPenalty +
              emission;
            if (total < bestTotal) {
              bestTotal = total;
              bestPrevIdx = pi;
              bestStepOffset = 1;
              bestRoute = routed;
              bestEndBearing = finalBearingDeg(routed.coordinates) ?? prevB;
            }
          }

          if (canSkipPrev) {
            const skipEmission = emissionCost(currCand, currVisit, skipSpeedMps);
            for (let ppi = 0; ppi < skipCands.length; ppi += 1) {
              if (!Number.isFinite(skipRow[ppi])) continue;
              const routed = routeBetweenCandidates(
                graph,
                skipCands[ppi],
                currCand,
                skipSpeedMps,
                skipMaxDetour,
              );
              if (!routed) continue;
              const detourPenalty = Math.max(0, routed.distanceMeters - skipStraightDist) * 0.35;
              let turnPenalty = 0;
              const prevB = skipBearings[ppi];
              const depB = initialBearingDeg(routed.coordinates);
              if (prevB !== null && depB !== null && routed.distanceMeters >= 12) {
                const turnDeg = directedAngleDiffDeg(prevB, depB);
                if (turnDeg > 135) turnPenalty = 55;
                else if (turnDeg > 75) turnPenalty = (turnDeg - 75) * 0.3;
              }
              const total =
                skipRow[ppi] +
                routed.cost * 0.35 +
                detourPenalty +
                turnPenalty +
                skipEmission +
                skipPenalty;
              if (total < bestTotal) {
                bestTotal = total;
                bestPrevIdx = ppi;
                bestStepOffset = 2;
                bestRoute = routed;
                bestEndBearing = finalBearingDeg(routed.coordinates) ?? prevB;
              }
            }
          }

          nextRow.push(bestTotal);
          nextPrevCand.push(bestPrevIdx);
          nextStepOffset.push(bestStepOffset);
          nextRoutes.push(bestRoute);
          nextBearings.push(bestEndBearing);
          if (bestPrevIdx !== -1) anyConnected = true;
        }

        if (!anyConnected) {
          brokenAt = idx;
          break;
        }
        dpCost.push(nextRow);
        dpPrevCand.push(nextPrevCand);
        dpPrevStepOffset.push(nextStepOffset);
        dpRoute.push(nextRoutes);
        dpBearing.push(nextBearings);
      }

      const resolvedEnd = brokenAt !== null ? brokenAt - 1 : chainEnd;
      const lastRowIdx = resolvedEnd - chainStart;
      let bestCandIdx = 0;
      let bestScore = Infinity;
      for (let ci = 0; ci < dpCost[lastRowIdx].length; ci += 1) {
        if (dpCost[lastRowIdx][ci] < bestScore) {
          bestScore = dpCost[lastRowIdx][ci];
          bestCandIdx = ci;
        }
      }

      let step = lastRowIdx;
      let cursor = bestCandIdx;
      while (step >= 0 && cursor >= 0) {
        const stopIdx = chainStart + step;
        chosenCandidate[stopIdx] = candidatesByStop[stopIdx][cursor];
        if (step === 0) break;
        const offset = dpPrevStepOffset[step][cursor];
        const prevCursor = dpPrevCand[step][cursor];
        const route = dpRoute[step][cursor];
        if (offset === 2) {
          skippedVisit[stopIdx - 1] = true;
        }
        if (route) {
          legRoutes[stopIdx - offset] = { route, nextIdx: stopIdx };
        }
        step -= offset;
        cursor = prevCursor;
      }

      chainStart = resolvedEnd + 1;
    }

    const segments: TrailPathSegment[] = [];
    const emittedSpurs = new Set<string>();
    let pendingRoadCoords: [number, number][][] = [];
    let pendingRoadKind: string | undefined;
    let hasRoadMatches = false;

    const flushRoad = () => {
      if (pendingRoadCoords.length === 0) return;
      const merged = mergeTrailCoordinates(pendingRoadCoords);
      if (merged.length >= 2) {
        segments.push({
          kind: 'road',
          coordinates: merged,
          ...(pendingRoadKind ? { roadKind: pendingRoadKind } : {}),
        });
        hasRoadMatches = true;
      }
      pendingRoadCoords = [];
      pendingRoadKind = undefined;
    };

    const maybeAddSpur = (visit: TrailStopVisit, snapped: SnapCandidate | null) => {
      if (!snapped || (!visit.isDwell && activeVisits.length > 2)) return;
      const offset = haversineMeters(visit.latitude, visit.longitude, snapped.lat, snapped.lon);
      if (offset <= this.spurThresholdMeters) return;
      const sLon = Number(snapped.lon.toFixed(6));
      const sLat = Number(snapped.lat.toFixed(6));
      const key = `${visit.longitude},${visit.latitude}->${sLon},${sLat}`;
      if (emittedSpurs.has(key)) return;
      emittedSpurs.add(key);
      segments.push({
        kind: 'spur',
        coordinates: [
          [visit.longitude, visit.latitude],
          [sLon, sLat],
        ],
      });
    };

    let i = 0;
    while (i < activeVisits.length - 1) {
      if (skippedVisit[i]) {
        i += 1;
        continue;
      }
      const legEntry = legRoutes[i];
      if (legEntry && legEntry.route.coordinates.length >= 2) {
        maybeAddSpur(activeVisits[i], chosenCandidate[i]);
        pendingRoadCoords.push(legEntry.route.coordinates);
        pendingRoadKind = pendingRoadKind ?? legEntry.route.dominantRoadKind;
        maybeAddSpur(activeVisits[legEntry.nextIdx], chosenCandidate[legEntry.nextIdx]);
        i = legEntry.nextIdx;
      } else {
        flushRoad();
        let nextIdx = i + 1;
        while (nextIdx < activeVisits.length - 1 && skippedVisit[nextIdx]) {
          nextIdx += 1;
        }
        const a = activeVisits[i];
        const b = activeVisits[nextIdx];
        segments.push({
          kind: 'direct',
          coordinates: [
            [a.longitude, a.latitude],
            [b.longitude, b.latitude],
          ],
        });
        i = nextIdx;
      }
    }
    flushRoad();

    const keptVisits: TrailStopVisit[] = [];
    for (let idx = 0; idx < activeVisits.length; idx += 1) {
      if (skippedVisit[idx]) continue;
      const v = activeVisits[idx];
      const snapped = chosenCandidate[idx];
      if (snapped && !v.isDwell) {
        keptVisits.push({
          ...v,
          latitude: Number(snapped.lat.toFixed(6)),
          longitude: Number(snapped.lon.toFixed(6)),
        });
      } else {
        keptVisits.push(v);
      }
    }

    return { segments, visits: keptVisits, hasRoadMatches };
  }

  async matchTrails(rawPings: readonly TrailPingLike[]): Promise<MatchedUserTrail[]> {
    if (rawPings.length === 0) return [];

    const rev = await this.tileProvider.getRevisionKey();
    const sig = createHash('sha256')
      .update(rev)
      .update('\n')
      .update(
        rawPings
          .map(
            (p) =>
              `${p.userId}:${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}:${p.recordedAt}:${p.isFuzzed ? 1 : 0}:${p.accuracy ?? ''}:${p.heading ?? ''}`,
          )
          .join('|'),
      )
      .digest('hex');

    const cached = this.resultCache.get(sig);
    if (cached) {
      this.resultCache.delete(sig);
      this.resultCache.set(sig, cached);
      return cached;
    }

    // Pre-filter ultra-coarse moving pings when higher-confidence fixes exist in the same user's stream
    const hasPreciseByUser = new Map<string, boolean>();
    for (const p of rawPings) {
      if (
        !p.isFuzzed &&
        typeof p.accuracy === 'number' &&
        Number.isFinite(p.accuracy) &&
        p.accuracy <= 60
      ) {
        hasPreciseByUser.set(p.userId, true);
      }
    }
    const filteredPings = rawPings.filter((p) => {
      if (p.isFuzzed) return true;
      if (
        hasPreciseByUser.get(p.userId) &&
        typeof p.accuracy === 'number' &&
        Number.isFinite(p.accuracy) &&
        p.accuracy > MAX_COARSE_MOVING_ACCURACY_METERS
      ) {
        return false;
      }
      return true;
    });

    const compacted = averageNearbyTrailPings(filteredPings.length > 0 ? filteredPings : rawPings);
    const matched: MatchedUserTrail[] = [];

    for (const userTrail of compacted) {
      const visits: TrailStopVisit[] =
        userTrail.visits && userTrail.visits.length > 0
          ? userTrail.visits
          : userTrail.stops.map((s: AveragedTrailStop, idx: number) => ({
              stopIndex: idx,
              latitude: s.latitude,
              longitude: s.longitude,
              firstRecordedAt: s.firstRecordedAt,
              lastRecordedAt: s.lastRecordedAt,
              isFuzzed: s.isFuzzed,
              maxSpeedMps: null,
            }));

      const trips = splitVisitsIntoTrips(visits, {
        maxTimeGapMs: this.maxTimeGapMs,
        maxDistanceMeters: this.maxDistanceMeters,
      });

      const userSegments: TrailPathSegment[] = [];
      const userVisits: TrailStopVisit[] = [];
      let userHasRoadMatches = false;

      for (const trip of trips) {
        const res = await this.matchSingleTrip(trip);
        for (const seg of res.segments) {
          userSegments.push(seg);
        }
        for (const kv of res.visits) {
          userVisits.push(kv);
        }
        if (res.hasRoadMatches) userHasRoadMatches = true;
      }

      matched.push({
        userId: userTrail.userId,
        username: userTrail.username,
        stops: userTrail.stops,
        visits: userVisits,
        segments: userSegments,
        hasRoadMatches: userHasRoadMatches,
      });
    }

    if (this.resultCache.size >= this.maxCachedResults) {
      const oldestKey = this.resultCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.resultCache.delete(oldestKey);
      }
    }
    this.resultCache.set(sig, matched);
    return matched;
  }

  async close(): Promise<void> {
    this.resultCache.clear();
    if (this.ownsProvider && this.tileProvider instanceof PmtilesRoadTileProvider) {
      await this.tileProvider.close();
    }
  }
}
