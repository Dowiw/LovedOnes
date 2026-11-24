import { describe, expect, it } from 'vitest';
import {
  clearSavedMapViewport,
  getMapViewportStorageKey,
  readSavedMapViewport,
  writeSavedMapViewport,
} from '../lib/mapViewport';

function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem(key) {
      return map.get(key) ?? null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

describe('web map viewport persistence', () => {
  it('saves, restores, isolates per user, and clears camera state cleanly', () => {
    const storage = createMemoryStorage();

    expect(readSavedMapViewport('user-a', storage)).toBeNull();

    const saved = writeSavedMapViewport(
      'user-a',
      {
        center: [13.405, 52.52],
        zoom: 15.2,
        bearing: 18.5,
        focusedUserId: 'member-2',
        activeGroupId: 'group-1',
      },
      storage,
    );
    expect(saved?.center).toEqual([13.405, 52.52]);
    expect(saved?.zoom).toBe(15.2);
    expect(saved?.bearing).toBe(18.5);
    expect(saved?.focusedUserId).toBe('member-2');
    expect(saved?.activeGroupId).toBe('group-1');

    expect(readSavedMapViewport('user-a', storage)).toEqual(saved);
    expect(readSavedMapViewport('user-b', storage)).toBeNull();

    clearSavedMapViewport('user-a', storage);
    expect(readSavedMapViewport('user-a', storage)).toBeNull();
  });

  it('returns null when stored viewport JSON is malformed or out of bounds', () => {
    const storage = createMemoryStorage();
    storage.setItem(getMapViewportStorageKey('user-a'), '{broken');
    expect(readSavedMapViewport('user-a', storage)).toBeNull();

    storage.setItem(
      getMapViewportStorageKey('user-a'),
      JSON.stringify({ center: [999, 52], zoom: 12 }),
    );
    expect(readSavedMapViewport('user-a', storage)).toBeNull();
  });
});
