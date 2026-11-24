import {
  parseSavedMapViewport,
  serializeSavedMapViewport,
  type SavedMapViewport,
} from '@loved-ones/shared';

const MAP_VIEWPORT_STORAGE_PREFIX = 'lovedones_map_viewport_v1:';

export function getMapViewportStorageKey(userId: string): string {
  return `${MAP_VIEWPORT_STORAGE_PREFIX}${userId}`;
}

export function readSavedMapViewport(
  userId: string | null | undefined,
  storage?: Pick<Storage, 'getItem'>,
): SavedMapViewport | null {
  if (!userId) return null;
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!store) return null;
  try {
    return parseSavedMapViewport(store.getItem(getMapViewportStorageKey(userId)));
  } catch {
    return null;
  }
}

export function writeSavedMapViewport(
  userId: string | null | undefined,
  viewport: {
    center: [number, number];
    zoom: number;
    bearing?: number;
    focusedUserId?: string | null;
    activeGroupId?: string | null;
    updatedAt?: string;
  },
  storage?: Pick<Storage, 'setItem'>,
): SavedMapViewport | null {
  if (!userId) return null;
  const serialized = serializeSavedMapViewport(viewport);
  if (!serialized) return null;
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (store) {
    try {
      store.setItem(getMapViewportStorageKey(userId), serialized);
    } catch {
      // Ignore quota / private browsing storage errors
    }
  }
  return parseSavedMapViewport(serialized);
}

export function clearSavedMapViewport(
  userId: string | null | undefined,
  storage?: Pick<Storage, 'removeItem'>,
): void {
  if (!userId) return;
  const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
  if (!store) return;
  try {
    store.removeItem(getMapViewportStorageKey(userId));
  } catch {
    // Ignore storage errors
  }
}
