export interface GroupDataSnapshot<
  TLoc = unknown,
  TMsg = unknown,
  TPlace = unknown,
  TTransition = unknown,
  TReq = unknown,
> {
  locations?: TLoc[];
  messages?: TMsg[];
  places?: TPlace[];
  placeTransitions?: TTransition[];
  locationRequests?: TReq[];
  myPrivacyOverrideUntil?: string | null;
}

/**
 * Lightweight per-group client snapshot cache used by both Web and Mobile map views
 * so returning to a previously loaded group renders cached data immediately while
 * uncached group switches clear stale data and surface loading skeletons.
 */
export class GroupSnapshotCache<TSnapshot extends GroupDataSnapshot> {
  private readonly entries = new Map<string, TSnapshot>();

  get(groupId: string): TSnapshot | undefined {
    return this.entries.get(groupId);
  }

  hasSection<K extends keyof TSnapshot>(groupId: string, key: K): boolean {
    const entry = this.entries.get(groupId);
    return Boolean(entry && entry[key] !== undefined);
  }

  patch(groupId: string, partial: Partial<TSnapshot>): TSnapshot {
    const prev = this.entries.get(groupId) ?? ({} as TSnapshot);
    const next = { ...prev, ...partial } as TSnapshot;
    this.entries.set(groupId, next);
    return next;
  }

  delete(groupId: string): void {
    this.entries.delete(groupId);
  }

  clear(): void {
    this.entries.clear();
  }
}
