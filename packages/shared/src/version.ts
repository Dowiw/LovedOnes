import { z } from 'zod';

export const DEFAULT_APP_VERSION = '0.1.0';
export const MOBILE_DEFAULT_DOWNLOAD_URL =
  'https://github.com/Dowiw/LovedOnes/releases/latest';

export const AppPlatformSchema = z.enum(['android', 'ios', 'web']);
export type AppPlatform = z.infer<typeof AppPlatformSchema>;

export const AppVersionInfoSchema = z.object({
  serverVersion: z.string(),
  minSupportedVersion: z.string(),
  latestMobileVersion: z.string(),
  updateAvailable: z.boolean(),
  updateRequired: z.boolean(),
  downloadUrl: z.string().nullable().optional(),
  releaseNotes: z.string().nullable().optional(),
});
export type AppVersionInfo = z.infer<typeof AppVersionInfoSchema>;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/**
 * Parses a loose semver string (e.g. "0.1.0", "v1.2", "1.4.2-rc.1") into comparable components.
 */
export function normalizeSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, '').split('+')[0]?.trim() ?? '';
  if (!cleaned) return null;
  const dashIdx = cleaned.indexOf('-');
  const corePart = dashIdx === -1 ? cleaned : cleaned.slice(0, dashIdx);
  const prerelease = dashIdx === -1 ? null : cleaned.slice(dashIdx + 1) || null;
  const segments = corePart.split('.');
  if (segments.length === 0 || segments.length > 3) return null;

  const nums = segments.map((s) => {
    if (!/^\d+$/.test(s)) return Number.NaN;
    return Number.parseInt(s, 10);
  });
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease,
  };
}

/**
 * Compares two semantic version strings.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = normalizeSemver(a);
  const pb = normalizeSemver(b);
  if (!pa || !pb) {
    return a.localeCompare(b);
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease.localeCompare(pb.prerelease);
}

export interface EvaluateClientVersionInput {
  clientVersion?: string | null;
  platform?: AppPlatform | string | null;
  serverVersion: string;
  latestMobileVersion?: string;
  minSupportedVersion?: string;
  downloadUrl?: string | null;
  releaseNotes?: string | null;
}

/**
 * Evaluates whether a connected mobile (APK/IPA) or web client should be notified
 * to update based on the server and latest release versions.
 */
export function evaluateClientVersion(input: EvaluateClientVersionInput): AppVersionInfo {
  const serverVersion = input.serverVersion || DEFAULT_APP_VERSION;
  const latestMobileVersion = input.latestMobileVersion || serverVersion;
  const minSupportedVersion = input.minSupportedVersion || DEFAULT_APP_VERSION;
  const targetVersion =
    input.platform === 'web' ? serverVersion : latestMobileVersion;

  const trimmedClient = input.clientVersion?.trim();
  const hasValidClient = Boolean(trimmedClient && normalizeSemver(trimmedClient));

  const updateAvailable = hasValidClient
    ? compareSemver(trimmedClient!, targetVersion) < 0
    : false;
  const updateRequired = hasValidClient
    ? compareSemver(trimmedClient!, minSupportedVersion) < 0
    : false;

  return {
    serverVersion,
    minSupportedVersion,
    latestMobileVersion,
    updateAvailable: updateAvailable || updateRequired,
    updateRequired,
    downloadUrl: input.downloadUrl ?? MOBILE_DEFAULT_DOWNLOAD_URL,
    releaseNotes: input.releaseNotes ?? null,
  };
}
