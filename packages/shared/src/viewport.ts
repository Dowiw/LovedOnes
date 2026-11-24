import { z } from 'zod';

export const SavedMapViewportSchema = z.object({
  center: z.tuple([z.number().min(-180).max(180), z.number().min(-85.0511).max(85.0511)]),
  zoom: z.number().min(0).max(22),
  bearing: z.number().min(-360).max(360).default(0),
  focusedUserId: z.string().min(1).max(128).nullable().default(null),
  activeGroupId: z.string().min(1).max(128).nullable().default(null),
  updatedAt: z.string().optional(),
});

export interface SavedMapViewport {
  center: [number, number];
  zoom: number;
  bearing: number;
  focusedUserId: string | null;
  activeGroupId: string | null;
  updatedAt: string;
}

/**
 * Normalizes a map bearing angle into [-180, 180) degrees.
 */
export function normalizeViewportBearing(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const wrapped = ((((raw + 180) % 360) + 360) % 360) - 180;
  return Number((Math.abs(wrapped) < 0.05 ? 0 : wrapped).toFixed(2));
}

/**
 * Parses and validates a persisted map viewport snapshot from a JSON string or
 * plain object, returning null if corrupted or out of bounds.
 */
export function parseSavedMapViewport(raw: unknown): SavedMapViewport | null {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      candidate = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  const rawBearing =
    typeof obj.bearing === 'number' && Number.isFinite(obj.bearing)
      ? normalizeViewportBearing(obj.bearing)
      : 0;
  const parsed = SavedMapViewportSchema.safeParse({
    ...obj,
    bearing: rawBearing,
  });
  if (!parsed.success) return null;
  const [lon, lat] = parsed.data.center;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(parsed.data.zoom)) {
    return null;
  }
  return {
    center: [Number(lon.toFixed(6)), Number(lat.toFixed(6))],
    zoom: Number(parsed.data.zoom.toFixed(3)),
    bearing: normalizeViewportBearing(parsed.data.bearing),
    focusedUserId: parsed.data.focusedUserId ?? null,
    activeGroupId: parsed.data.activeGroupId ?? null,
    updatedAt: parsed.data.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * Serializes a validated map viewport snapshot for client storage.
 */
export function serializeSavedMapViewport(viewport: {
  center: [number, number];
  zoom: number;
  bearing?: number;
  focusedUserId?: string | null;
  activeGroupId?: string | null;
  updatedAt?: string;
}): string | null {
  const normalized = parseSavedMapViewport({
    center: viewport.center,
    zoom: viewport.zoom,
    bearing: viewport.bearing ?? 0,
    focusedUserId: viewport.focusedUserId ?? null,
    activeGroupId: viewport.activeGroupId ?? null,
    updatedAt: viewport.updatedAt ?? new Date().toISOString(),
  });
  return normalized ? JSON.stringify(normalized) : null;
}
