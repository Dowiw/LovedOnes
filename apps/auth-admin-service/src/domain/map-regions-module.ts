import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PMTiles, Source } from 'pmtiles';
import {
  computeCityFallbackBbox,
  findCoveringRegions,
  isPointCoveredByRegions,
  MapDownloadJob,
  MapRegion,
  normalizeCityBbox,
  RequestMapDownloadInput,
  RequestMapDownloadSchema,
  slugifyCityName,
  WORLD_OVERVIEW_MAX_ZOOM,
  WORLD_OVERVIEW_REGION_ID,
} from '@loved-ones/shared';
import { DomainError } from '@loved-ones/shared/auth';

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

export interface CityLookupResult {
  cityName: string;
  displayName: string;
  countryCode: string | null;
  bbox: [number, number, number, number];
}

export interface CityResolver {
  resolve(
    latitude: number,
    longitude: number,
    explicitCityName?: string,
    radiusKm?: number,
  ): Promise<CityLookupResult>;
}

export interface TileExtractorContext {
  bbox: [number, number, number, number];
  outputPath: string;
  maxExtractBytes: number;
  maxZoom?: number;
  onProgress?: (pct: number, message: string) => void;
}

export interface TileExtractor {
  extract(ctx: TileExtractorContext): Promise<{ sourceBuild: string }>;
}

interface ManifestEntry {
  id: string;
  name: string;
  displayName?: string | null;
  countryCode?: string | null;
  filename: string;
  downloadedAt: string;
  sourceBuild?: string | null;
}

interface LoadedArchive {
  region: MapRegion;
  source: NodeFileSource;
  pmtiles: PMTiles;
}

export interface MapRegionsModuleOptions {
  tilesDir?: string;
  pmtilesBin?: string;
  protomapsSourceUrl?: string;
  protomapsBuildsUrl?: string;
  allowMemberDownloads?: boolean;
  maxExtractMb?: number;
  maxMapStorageMb?: number;
  getMaxMapStorageMb?: () => Promise<number>;
  minFreeDiskMb?: number;
  cityResolver?: CityResolver;
  tileExtractor?: TileExtractor;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export function tileZxyToBbox(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const n = 2 ** z;
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;
  const latRadSouth = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const latRadNorth = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const minLat = (latRadSouth * 180) / Math.PI;
  const maxLat = (latRadNorth * 180) / Math.PI;
  return [minLon, minLat, maxLon, maxLat];
}

function bboxesIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export class NominatimCityResolver implements CityResolver {
  async resolve(
    latitude: number,
    longitude: number,
    explicitCityName?: string,
    radiusKm?: number,
  ): Promise<CityLookupResult> {
    if (explicitCityName) {
      return {
        cityName: explicitCityName,
        displayName: explicitCityName,
        countryCode: null,
        bbox: computeCityFallbackBbox(latitude, longitude, radiusKm),
      };
    }

    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}&zoom=10&addressdetails=1`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'LovedOnes-SelfHosted/1.0 (+https://github.com/protomaps/PMTiles)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        throw new Error(`Nominatim HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        name?: string;
        display_name?: string;
        boundingbox?: [string, string, string, string];
        address?: Record<string, string | undefined>;
      };

      const addr = data.address ?? {};
      const cityName =
        addr.city ??
        addr.town ??
        addr.village ??
        addr.municipality ??
        addr.city_district ??
        addr.county ??
        addr.state ??
        data.name ??
        `Area ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
      const countryCode = addr.country_code ? addr.country_code.toUpperCase() : null;
      const displayName =
        countryCode && !cityName.includes(countryCode) ? `${cityName}, ${countryCode}` : cityName;

      let rawBbox: [number, number, number, number] | null = null;
      if (Array.isArray(data.boundingbox) && data.boundingbox.length === 4) {
        // Nominatim returns [southLat, northLat, westLon, eastLon]
        const southLat = Number.parseFloat(data.boundingbox[0]);
        const northLat = Number.parseFloat(data.boundingbox[1]);
        const westLon = Number.parseFloat(data.boundingbox[2]);
        const eastLon = Number.parseFloat(data.boundingbox[3]);
        if (
          Number.isFinite(westLon) &&
          Number.isFinite(southLat) &&
          Number.isFinite(eastLon) &&
          Number.isFinite(northLat)
        ) {
          rawBbox = [westLon, southLat, eastLon, northLat];
        }
      }

      return {
        cityName,
        displayName,
        countryCode,
        bbox: normalizeCityBbox(latitude, longitude, rawBbox, radiusKm),
      };
    } catch {
      const fallbackLabel = `Region (${latitude.toFixed(2)}, ${longitude.toFixed(2)})`;
      return {
        cityName: fallbackLabel,
        displayName: fallbackLabel,
        countryCode: null,
        bbox: computeCityFallbackBbox(latitude, longitude, radiusKm),
      };
    }
  }
}

export class ProtomapsCliExtractor implements TileExtractor {
  private cachedLatestBuild: { key: string; url: string; fetchedAt: number } | null = null;

  constructor(
    private readonly pmtilesBin: string,
    private readonly sourceUrlOverride?: string,
    private readonly buildsUrl = 'https://build-metadata.protomaps.dev/builds.json',
  ) {}

  private async resolveSourceArchive(): Promise<{ key: string; url: string }> {
    if (this.sourceUrlOverride && this.sourceUrlOverride.trim().length > 0) {
      const clean = this.sourceUrlOverride.trim();
      const key = clean.split('/').pop() || clean;
      return { key, url: clean };
    }

    if (this.cachedLatestBuild && Date.now() - this.cachedLatestBuild.fetchedAt < 10 * 60 * 1000) {
      return { key: this.cachedLatestBuild.key, url: this.cachedLatestBuild.url };
    }

    const res = await fetch(this.buildsUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Protomaps builds catalog (HTTP ${res.status})`);
    }
    const builds = (await res.json()) as Array<{ key?: string }>;
    const latest = [...builds].reverse().find((b) => typeof b.key === 'string' && b.key.endsWith('.pmtiles'));
    if (!latest?.key) {
      throw new Error('Protomaps builds catalog contained no valid .pmtiles build');
    }

    const resolved = {
      key: latest.key,
      url: `https://build.protomaps.com/${latest.key}`,
      fetchedAt: Date.now(),
    };
    this.cachedLatestBuild = resolved;
    return { key: resolved.key, url: resolved.url };
  }

  async extract(ctx: TileExtractorContext): Promise<{ sourceBuild: string }> {
    ctx.onProgress?.(12, 'Resolving latest Protomaps basemap build…');
    const source = await this.resolveSourceArchive();
    ctx.onProgress?.(20, `Extracting city tiles from ${source.key}…`);

    const bboxArg = ctx.bbox.join(',');
    const maxZoom = Math.max(1, Math.min(15, Math.round(ctx.maxZoom ?? 15)));
    const args = [
      'extract',
      source.url,
      ctx.outputPath,
      `--bbox=${bboxArg}`,
      `--maxzoom=${maxZoom}`,
      '--download-threads=6',
      '--overfetch=0.05',
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.pmtilesBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let settled = false;
      let outputTail = '';
      let tickPct = 22;

      const failAndCleanup = (err: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(monitorTimer);
        clearTimeout(timeoutTimer);
        child.kill('SIGKILL');
        reject(err);
      };

      const appendOutput = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        outputTail = (outputTail + text).slice(-1200);
        const pctMatch = text.match(/(\d{1,3})\s*%/);
        if (pctMatch) {
          const parsedPct = Math.min(96, Math.max(20, Number.parseInt(pctMatch[1], 10)));
          tickPct = Math.max(tickPct, parsedPct);
          ctx.onProgress?.(tickPct, `Extracting tiles (${tickPct}%)…`);
        }
      };

      child.stdout?.on('data', appendOutput);
      child.stderr?.on('data', appendOutput);

      const monitorTimer = setInterval(() => {
        try {
          if (fs.existsSync(ctx.outputPath)) {
            const st = fs.statSync(ctx.outputPath);
            if (st.size > ctx.maxExtractBytes) {
              failAndCleanup(
                new Error(
                  `Extract exceeded maximum allowed size (${Math.round(ctx.maxExtractBytes / (1024 * 1024))} MB)`,
                ),
              );
              return;
            }
            const mb = (st.size / (1024 * 1024)).toFixed(1);
            tickPct = Math.min(92, tickPct + 2);
            ctx.onProgress?.(tickPct, `Downloading tiles (${mb} MB written)…`);
          }
        } catch {
          // ignore transient stat errors
        }
      }, 1500);

      const timeoutTimer = setTimeout(() => {
        failAndCleanup(new Error('Map download timed out after 15 minutes'));
      }, 15 * 60 * 1000);

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          failAndCleanup(
            new Error(
              `pmtiles CLI binary "${this.pmtilesBin}" is not installed on the server host`,
            ),
          );
          return;
        }
        failAndCleanup(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearInterval(monitorTimer);
        clearTimeout(timeoutTimer);
        if (code !== 0) {
          reject(
            new Error(
              `pmtiles extract exited with code ${code}: ${outputTail.trim() || 'unknown error'}`,
            ),
          );
          return;
        }
        resolve();
      });
    });

    return { sourceBuild: source.key };
  }
}

export class MapRegionsModule {
  readonly tilesDir: string;
  readonly regionsDir: string;
  readonly manifestPath: string;
  readonly allowMemberDownloads: boolean;
  private readonly maxExtractBytes: number;
  private readonly maxMapStorageMb: number;
  private readonly getMaxMapStorageMb?: () => Promise<number>;
  private readonly minFreeDiskBytes: number;
  private readonly cityResolver: CityResolver;
  private readonly tileExtractor: TileExtractor;
  private readonly onLog?: MapRegionsModuleOptions['onLog'];

  private readonly jobs = new Map<string, MapDownloadJob>();
  private loadedArchives: LoadedArchive[] | null = null;
  private extractionChain: Promise<void> = Promise.resolve();

  constructor(options: MapRegionsModuleOptions = {}) {
    this.tilesDir = path.resolve(
      options.tilesDir ?? process.env.TILES_DIR ?? path.resolve(process.cwd(), '../../infra/tiles'),
    );
    this.regionsDir = path.join(this.tilesDir, 'regions');
    this.manifestPath = path.join(this.regionsDir, 'manifest.json');
    this.allowMemberDownloads =
      options.allowMemberDownloads ?? process.env.ALLOW_MEMBER_MAP_DOWNLOADS !== 'false';
    const maxMb = options.maxExtractMb ?? (Number.parseInt(process.env.MAX_MAP_EXTRACT_MB ?? '1024', 10) || 1024);
    const minFreeMb =
      options.minFreeDiskMb ?? (Number.parseInt(process.env.MIN_FREE_DISK_MB ?? '500', 10) || 500);
    this.maxExtractBytes = maxMb * 1024 * 1024;
    this.maxMapStorageMb =
      options.maxMapStorageMb ?? (Number.parseFloat(process.env.MAX_MAP_STORAGE_MB ?? '0') || 0);
    this.getMaxMapStorageMb = options.getMaxMapStorageMb;
    this.minFreeDiskBytes = minFreeMb * 1024 * 1024;
    this.cityResolver = options.cityResolver ?? new NominatimCityResolver();
    this.tileExtractor =
      options.tileExtractor ??
      new ProtomapsCliExtractor(
        options.pmtilesBin ?? process.env.PMTILES_BIN ?? 'pmtiles',
        options.protomapsSourceUrl ?? process.env.PROTOMAPS_SOURCE_URL,
        options.protomapsBuildsUrl ?? process.env.PROTOMAPS_BUILDS_URL,
      );
    this.onLog = options.onLog;
  }

  private async readManifest(): Promise<Record<string, ManifestEntry>> {
    try {
      const raw = await fs.promises.readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, ManifestEntry>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeManifest(manifest: Record<string, ManifestEntry>): Promise<void> {
    await fs.promises.mkdir(this.regionsDir, { recursive: true });
    const tmpPath = `${this.manifestPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, this.manifestPath);
  }

  async invalidateCache(): Promise<void> {
    const prev = this.loadedArchives;
    this.loadedArchives = null;
    if (prev) {
      await Promise.all(prev.map((a) => a.source.close()));
    }
  }

  async close(): Promise<void> {
    await this.invalidateCache();
  }

  private async loadArchiveFromDisk(params: {
    id: string;
    name: string;
    displayName?: string | null;
    countryCode?: string | null;
    filePath: string;
    url: string;
    isPrimary: boolean;
    downloadedAt?: string | null;
    sourceBuild?: string | null;
  }): Promise<LoadedArchive | null> {
    const stat = await fs.promises.stat(params.filePath).catch(() => null);
    if (!stat || !stat.isFile()) return null;

    const source = new NodeFileSource(params.filePath);
    const pmtiles = new PMTiles(source);
    try {
      const header = await pmtiles.getHeader();
      const isWorldOverview =
        params.id === WORLD_OVERVIEW_REGION_ID ||
        path.basename(params.filePath) === `${WORLD_OVERVIEW_REGION_ID}.pmtiles`;
      const isStub = header.numAddressedTiles === 0 || (!isWorldOverview && header.maxZoom < 12);
      return {
        source,
        pmtiles,
        region: {
          id: params.id,
          name: params.name,
          displayName: params.displayName ?? params.name,
          countryCode: params.countryCode ?? null,
          url: params.url,
          minLon: header.minLon,
          minLat: header.minLat,
          maxLon: header.maxLon,
          maxLat: header.maxLat,
          minZoom: header.minZoom,
          maxZoom: header.maxZoom,
          sizeBytes: stat.size,
          isStub,
          isPrimary: params.isPrimary,
          downloadedAt: params.downloadedAt ?? stat.mtime.toISOString(),
          sourceBuild: params.sourceBuild ?? null,
        },
      };
    } catch {
      await source.close();
      if (params.isPrimary && stat.size <= 4096) {
        return {
          source,
          pmtiles,
          region: {
            id: params.id,
            name: 'Placeholder Stub',
            displayName: 'Placeholder Stub (No map tiles)',
            countryCode: null,
            url: params.url,
            minLon: -180,
            minLat: -85,
            maxLon: 180,
            maxLat: 85,
            minZoom: 0,
            maxZoom: 0,
            sizeBytes: stat.size,
            isStub: true,
            isPrimary: true,
            downloadedAt: params.downloadedAt ?? stat.mtime.toISOString(),
            sourceBuild: null,
          },
        };
      }
      return null;
    }
  }

  private async ensureLoaded(): Promise<LoadedArchive[]> {
    if (this.loadedArchives) {
      return this.loadedArchives;
    }

    const manifest = await this.readManifest();
    const candidates: Array<Promise<LoadedArchive | null>> = [];

    const primaryPath = path.join(this.tilesDir, 'region.pmtiles');
    if (fs.existsSync(primaryPath)) {
      candidates.push(
        this.loadArchiveFromDisk({
          id: 'primary-region',
          name: 'Primary Region',
          displayName: 'Bundled Primary Map',
          filePath: primaryPath,
          url: '/tiles/region.pmtiles',
          isPrimary: true,
        }),
      );
    }

    if (fs.existsSync(this.regionsDir)) {
      const entries = await fs.promises.readdir(this.regionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.pmtiles')) continue;
        const meta = manifest[entry.name];
        const fallbackName = entry.name.replace(/\.pmtiles$/i, '').replace(/[-_]+/g, ' ');
        candidates.push(
          this.loadArchiveFromDisk({
            id: meta?.id ?? entry.name.replace(/\.pmtiles$/i, ''),
            name: meta?.name ?? fallbackName,
            displayName: meta?.displayName ?? meta?.name ?? fallbackName,
            countryCode: meta?.countryCode ?? null,
            filePath: path.join(this.regionsDir, entry.name),
            url: `/tiles/regions/${entry.name}`,
            isPrimary: false,
            downloadedAt: meta?.downloadedAt ?? null,
            sourceBuild: meta?.sourceBuild ?? null,
          }),
        );
      }
    }

    const loaded = (await Promise.all(candidates)).filter(
      (item): item is LoadedArchive => item !== null,
    );

    // Prefer smaller / newer extracted city archives ahead of wide/primary archives.
    loaded.sort((a, b) => {
      if (a.region.isPrimary !== b.region.isPrimary) {
        return a.region.isPrimary ? 1 : -1;
      }
      const areaA = Math.max(0.0001, (a.region.maxLon - a.region.minLon) * (a.region.maxLat - a.region.minLat));
      const areaB = Math.max(0.0001, (b.region.maxLon - b.region.minLon) * (b.region.maxLat - b.region.minLat));
      if (areaA !== areaB) return areaA - areaB;
      return (b.region.downloadedAt ?? '').localeCompare(a.region.downloadedAt ?? '');
    });

    this.loadedArchives = loaded;
    return loaded;
  }

  async listRegions(): Promise<MapRegion[]> {
    const loaded = await this.ensureLoaded();
    return loaded.map((a) => a.region);
  }

  async checkCoverage(latitude: number, longitude: number): Promise<{
    covered: boolean;
    regions: MapRegion[];
    matchingRegions: MapRegion[];
    activeJob: MapDownloadJob | null;
  }> {
    const regions = await this.listRegions();
    const matchingRegions = findCoveringRegions(latitude, longitude, regions);
    const activeJob = this.findActiveJobForPoint(latitude, longitude);
    return {
      covered: matchingRegions.length > 0,
      regions,
      matchingRegions,
      activeJob,
    };
  }

  listJobs(): MapDownloadJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getJob(jobId: string): MapDownloadJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new DomainError(404, 'Map download job not found');
    }
    return job;
  }

  private findActiveJobForPoint(lat: number, lon: number): MapDownloadJob | null {
    for (const job of this.jobs.values()) {
      if (job.status === 'completed' || job.status === 'failed') continue;
      const [minLon, minLat, maxLon, maxLat] = job.bbox;
      if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
        return job;
      }
    }
    return null;
  }

  async getMapStorageSummary(): Promise<{
    totalBytes: number;
    primaryBytes: number;
    regionsBytes: number;
    maxMapStorageBytes: number;
    regionCount: number;
  }> {
    const regions = await this.listRegions();
    let primaryBytes = 0;
    let regionsBytes = 0;
    for (const r of regions) {
      if (r.isPrimary) {
        primaryBytes += r.sizeBytes;
      }
    }
    // Sum actual .pmtiles file sizes in regions/ directly so disk quotas reflect real disk usage
    try {
      const entries = await fs.promises.readdir(this.regionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.pmtiles')) continue;
        const st = await fs.promises.stat(path.join(this.regionsDir, entry.name)).catch(() => null);
        if (st?.isFile()) regionsBytes += st.size;
      }
    } catch {
      for (const r of regions) {
        if (!r.isPrimary) regionsBytes += r.sizeBytes;
      }
    }
    const maxMb = this.getMaxMapStorageMb
      ? await this.getMaxMapStorageMb().catch(() => this.maxMapStorageMb)
      : this.maxMapStorageMb;
    const maxMapStorageBytes = Math.max(0, Math.round((maxMb || 0) * 1024 * 1024));
    return {
      totalBytes: primaryBytes + regionsBytes,
      primaryBytes,
      regionsBytes,
      maxMapStorageBytes,
      regionCount: regions.filter((r) => !r.isStub).length,
    };
  }

  private async ensureFreeDiskSpace(): Promise<void> {
    const summary = await this.getMapStorageSummary();
    if (summary.maxMapStorageBytes > 0 && summary.regionsBytes >= summary.maxMapStorageBytes) {
      throw new DomainError(
        507,
        'Server map extract storage allocation is full; ask the Host Admin to remove old regions or raise the map storage limit',
      );
    }
    await fs.promises.mkdir(this.regionsDir, { recursive: true });
    if (typeof fs.promises.statfs !== 'function') return;
    try {
      const stat = await fs.promises.statfs(this.regionsDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (Number.isFinite(freeBytes) && freeBytes < this.minFreeDiskBytes) {
        throw new DomainError(
          507,
          'Insufficient disk space available on the server to store additional map extracts',
        );
      }
    } catch (err) {
      if (err instanceof DomainError) throw err;
    }
  }

  async requestCityDownload(
    actor: { id: string; role: string },
    rawInput: unknown,
  ): Promise<{
    alreadyCovered: boolean;
    region?: MapRegion;
    regions?: MapRegion[];
    job?: MapDownloadJob;
  }> {
    const parsed = RequestMapDownloadSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid map download request payload', parsed.error.flatten());
    }
    const input: RequestMapDownloadInput = parsed.data;

    if (!this.allowMemberDownloads && actor.role !== 'HOST_ADMIN') {
      throw new DomainError(
        403,
        'Only Host Admins can trigger new server map downloads on this instance',
      );
    }

    const regions = await this.listRegions();
    if (isPointCoveredByRegions(input.latitude, input.longitude, regions)) {
      const matching = findCoveringRegions(input.latitude, input.longitude, regions);
      return {
        alreadyCovered: true,
        region: matching[0],
        regions,
      };
    }

    const existingJob = this.findActiveJobForPoint(input.latitude, input.longitude);
    if (existingJob) {
      return {
        alreadyCovered: false,
        job: existingJob,
      };
    }

    await this.ensureFreeDiskSpace();

    const cityInfo = await this.cityResolver.resolve(
      input.latitude,
      input.longitude,
      input.cityName,
      input.radiusKm,
    );

    // Re-check deduplication after async geocoding in case another request raced in.
    const existingAfterLookup = this.findActiveJobForPoint(input.latitude, input.longitude);
    if (existingAfterLookup) {
      return {
        alreadyCovered: false,
        job: existingAfterLookup,
      };
    }

    const slug = slugifyCityName(cityInfo.cityName, input.latitude, input.longitude);
    const filename = `${slug}.pmtiles`;
    const now = new Date().toISOString();
    const job: MapDownloadJob = {
      id: crypto.randomUUID(),
      cityName: cityInfo.cityName,
      displayName: cityInfo.displayName,
      bbox: cityInfo.bbox,
      status: 'queued',
      progressPct: 5,
      message: `Queued map extract for ${cityInfo.displayName}`,
      error: null,
      regionId: null,
      requestedBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);

    // Prune older finished jobs to keep memory bounded
    if (this.jobs.size > 40) {
      const oldFinished = this.listJobs()
        .filter((j) => j.status === 'completed' || j.status === 'failed')
        .slice(20);
      for (const item of oldFinished) {
        this.jobs.delete(item.id);
      }
    }

    const updateJob = (patch: Partial<MapDownloadJob>) => {
      const cur = this.jobs.get(job.id);
      if (!cur) return;
      Object.assign(cur, patch, { updatedAt: new Date().toISOString() });
    };

    this.extractionChain = this.extractionChain
      .catch(() => {})
      .then(async () => {
        const finalPath = path.join(this.regionsDir, filename);
        const tmpPath = path.join(this.regionsDir, `${filename}.${job.id}.tmp`);

        try {
          await fs.promises.mkdir(this.regionsDir, { recursive: true });
          updateJob({
            status: 'resolving',
            progressPct: 10,
            message: `Preparing tile bounds for ${cityInfo.displayName}…`,
          });

          const { sourceBuild } = await this.tileExtractor.extract({
            bbox: cityInfo.bbox,
            outputPath: tmpPath,
            maxExtractBytes: this.maxExtractBytes,
            onProgress: (pct, message) => {
              updateJob({ status: 'downloading', progressPct: pct, message });
            },
          });

          const verifySource = new NodeFileSource(tmpPath);
          const verifyArchive = new PMTiles(verifySource);
          let header;
          try {
            header = await verifyArchive.getHeader();
          } finally {
            await verifySource.close();
          }

          if (header.numAddressedTiles === 0) {
            throw new Error('Downloaded extract contained zero map tiles for that bounding box');
          }

          await fs.promises.rename(tmpPath, finalPath);

          const manifest = await this.readManifest();
          manifest[filename] = {
            id: slug,
            name: cityInfo.cityName,
            displayName: cityInfo.displayName,
            countryCode: cityInfo.countryCode,
            filename,
            downloadedAt: new Date().toISOString(),
            sourceBuild,
          };
          await this.writeManifest(manifest);
          await this.invalidateCache();
          await this.ensureLoaded();

          updateJob({
            status: 'completed',
            progressPct: 100,
            message: `Downloaded ${cityInfo.displayName} map tiles`,
            regionId: slug,
          });
          this.onLog?.('info', 'downloaded regional pmtiles extract', {
            jobId: job.id,
            regionId: slug,
            cityName: cityInfo.cityName,
            bbox: cityInfo.bbox,
            sourceBuild,
          });
        } catch (err) {
          await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
          const msg = err instanceof Error ? err.message : 'Failed to extract city map tiles';
          updateJob({
            status: 'failed',
            progressPct: 0,
            error: msg,
            message: msg,
          });
          this.onLog?.('error', 'failed regional pmtiles extract', {
            jobId: job.id,
            cityName: cityInfo.cityName,
            error: msg,
          });
        }
      });

    return {
      alreadyCovered: false,
      job,
    };
  }

  async requestWorldOverviewDownload(actor: { id: string; role: string }): Promise<{
    alreadyCovered: boolean;
    region?: MapRegion;
    regions?: MapRegion[];
    job?: MapDownloadJob;
  }> {
    if (actor.role !== 'HOST_ADMIN') {
      throw new DomainError(403, 'Only Host Admins can download the global world overview map');
    }

    const regions = await this.listRegions();
    const existing = regions.find((r) => !r.isStub && r.id === WORLD_OVERVIEW_REGION_ID);
    if (existing) {
      return {
        alreadyCovered: true,
        region: existing,
        regions,
      };
    }

    for (const j of this.jobs.values()) {
      if (
        j.cityName === 'World Overview (z0-z5)' &&
        j.status !== 'completed' &&
        j.status !== 'failed'
      ) {
        return { alreadyCovered: false, job: j };
      }
    }

    await this.ensureFreeDiskSpace();

    const filename = `${WORLD_OVERVIEW_REGION_ID}.pmtiles`;
    const worldBbox: [number, number, number, number] = [-180, -85, 180, 85];
    const now = new Date().toISOString();
    const job: MapDownloadJob = {
      id: crypto.randomUUID(),
      cityName: 'World Overview (z0-z5)',
      displayName: 'World Overview (z0–z5)',
      bbox: worldBbox,
      status: 'queued',
      progressPct: 5,
      message: 'Queued global world overview extract (z0–z5)…',
      error: null,
      regionId: null,
      requestedBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);

    const updateJob = (patch: Partial<MapDownloadJob>) => {
      const cur = this.jobs.get(job.id);
      if (!cur) return;
      Object.assign(cur, patch, { updatedAt: new Date().toISOString() });
    };

    this.extractionChain = this.extractionChain
      .catch(() => {})
      .then(async () => {
        const finalPath = path.join(this.regionsDir, filename);
        const tmpPath = path.join(this.regionsDir, `${filename}.${job.id}.tmp`);

        try {
          await fs.promises.mkdir(this.regionsDir, { recursive: true });
          updateJob({
            status: 'resolving',
            progressPct: 12,
            message: 'Resolving Protomaps build for global z0–z5 overview…',
          });

          const { sourceBuild } = await this.tileExtractor.extract({
            bbox: worldBbox,
            outputPath: tmpPath,
            maxExtractBytes: this.maxExtractBytes,
            maxZoom: WORLD_OVERVIEW_MAX_ZOOM,
            onProgress: (pct, message) => {
              updateJob({ status: 'downloading', progressPct: pct, message });
            },
          });

          const verifySource = new NodeFileSource(tmpPath);
          const verifyArchive = new PMTiles(verifySource);
          let header;
          try {
            header = await verifyArchive.getHeader();
          } finally {
            await verifySource.close();
          }

          if (header.numAddressedTiles === 0) {
            throw new Error('Downloaded world overview contained zero map tiles');
          }

          await fs.promises.rename(tmpPath, finalPath);

          const manifest = await this.readManifest();
          manifest[filename] = {
            id: WORLD_OVERVIEW_REGION_ID,
            name: 'World Overview',
            displayName: 'World Overview (z0–z5)',
            countryCode: null,
            filename,
            downloadedAt: new Date().toISOString(),
            sourceBuild,
          };
          await this.writeManifest(manifest);
          await this.invalidateCache();
          await this.ensureLoaded();

          updateJob({
            status: 'completed',
            progressPct: 100,
            message: 'Downloaded World Overview (z0–z5) tiles',
            regionId: WORLD_OVERVIEW_REGION_ID,
          });
          this.onLog?.('info', 'downloaded world overview pmtiles extract', {
            jobId: job.id,
            regionId: WORLD_OVERVIEW_REGION_ID,
            sourceBuild,
          });
        } catch (err) {
          await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
          const msg = err instanceof Error ? err.message : 'Failed to extract world overview tiles';
          updateJob({
            status: 'failed',
            progressPct: 0,
            error: msg,
            message: msg,
          });
          this.onLog?.('error', 'failed world overview pmtiles extract', {
            jobId: job.id,
            error: msg,
          });
        }
      });

    return {
      alreadyCovered: false,
      job,
    };
  }

  async deleteRegion(regionId: string): Promise<{ deleted: true; id: string }> {
    const loaded = await this.ensureLoaded();
    const target = loaded.find((a) => a.region.id === regionId);
    if (!target) {
      throw new DomainError(404, 'Map region not found');
    }
    if (target.region.isPrimary) {
      throw new DomainError(400, 'Cannot delete primary bundled region archive');
    }

    const filename = path.basename(target.region.url);
    const fullPath = path.join(this.regionsDir, filename);

    await this.invalidateCache();
    await fs.promises.rm(fullPath, { force: true });

    const manifest = await this.readManifest();
    if (manifest[filename]) {
      delete manifest[filename];
      await this.writeManifest(manifest);
    }

    await this.ensureLoaded();
    return { deleted: true, id: regionId };
  }

  async getCompositeTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    if (z < 0 || z > 16 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      return null;
    }
    const loaded = await this.ensureLoaded();
    const tileBox = tileZxyToBbox(z, x, y);

    for (const item of loaded) {
      const r = item.region;
      if (r.isStub || z < r.minZoom || z > r.maxZoom) continue;
      if (!bboxesIntersect(tileBox, [r.minLon, r.minLat, r.maxLon, r.maxLat])) continue;

      try {
        const res = await item.pmtiles.getZxy(z, x, y);
        if (res && res.data && res.data.byteLength > 0) {
          return new Uint8Array(res.data);
        }
      } catch {
        // try next covering archive
      }
    }
    return null;
  }
}
