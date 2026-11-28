import { describe, expect, it } from 'vitest';
import type { JwtUserPayload, PrivacyMode } from '@loved-ones/shared';
import {
  ShareLinksModule,
  type ShareCreatorLatestLocation,
  type ShareCreatorMembershipInfo,
  type ShareCreatorProfile,
  type ShareGuestRecord,
  type ShareLinkRecord,
  type ShareLinkStore,
} from '../domain/share-links-module.js';

class InMemoryShareLinkStore implements ShareLinkStore {
  readonly memberships = new Map<string, ShareCreatorMembershipInfo>();
  readonly profiles = new Map<string, ShareCreatorProfile>();
  readonly locations = new Map<string, ShareCreatorLatestLocation>();
  readonly links = new Map<string, ShareLinkRecord>();
  readonly guests = new Map<string, ShareGuestRecord>();

  async getMembershipPrivacy(userId: string, groupId: string) {
    return this.memberships.get(`${userId}:${groupId}`) ?? null;
  }

  async getCreatorProfile(userId: string) {
    return this.profiles.get(userId) ?? null;
  }

  async getCreatorLatestLocation(userId: string) {
    return this.locations.get(userId) ?? null;
  }

  async createShareLink(input: {
    token: string;
    userId: string;
    groupId: string;
    label: string | null;
    allowGuestSharing: boolean;
    expiresAt: Date;
    now: Date;
  }): Promise<ShareLinkRecord> {
    const rec: ShareLinkRecord = {
      token: input.token,
      userId: input.userId,
      groupId: input.groupId,
      groupName: 'Family',
      label: input.label,
      allowGuestSharing: input.allowGuestSharing,
      activeGuestCount: 0,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
      createdAt: input.now.toISOString(),
    };
    this.links.set(rec.token, rec);
    return rec;
  }

  async listActiveShareLinksForUser(userId: string, now: Date, guestActiveWindowMs: number) {
    const cutoff = now.getTime() - guestActiveWindowMs;
    return [...this.links.values()]
      .filter((l) => l.userId === userId && !l.revokedAt && Date.parse(l.expiresAt) > now.getTime())
      .map((l) => ({
        ...l,
        activeGuestCount: [...this.guests.values()].filter(
          (g) => g.shareToken === l.token && Date.parse(g.updatedAt) >= cutoff,
        ).length,
      }));
  }

  async getShareLinkByToken(token: string) {
    return this.links.get(token) ?? null;
  }

  async revokeShareLink(userId: string, token: string, now: Date) {
    const existing = this.links.get(token);
    if (!existing || existing.userId !== userId || existing.revokedAt) return false;
    existing.revokedAt = now.toISOString();
    for (const [gid, g] of this.guests.entries()) {
      if (g.shareToken === token) this.guests.delete(gid);
    }
    return true;
  }

  async listActiveGuests(shareToken: string, since: Date) {
    return [...this.guests.values()].filter(
      (g) => g.shareToken === shareToken && Date.parse(g.updatedAt) >= since.getTime(),
    );
  }

  async upsertGuest(input: {
    id: string;
    shareToken: string;
    guestSecret: string;
    displayName: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    now: Date;
  }): Promise<'inserted' | 'updated' | 'forbidden'> {
    const existing = this.guests.get(input.id);
    if (existing) {
      if (existing.guestSecret !== input.guestSecret) return 'forbidden';
      existing.displayName = input.displayName;
      existing.latitude = input.latitude;
      existing.longitude = input.longitude;
      existing.accuracy = input.accuracy;
      existing.updatedAt = input.now.toISOString();
      return 'updated';
    }
    this.guests.set(input.id, {
      id: input.id,
      shareToken: input.shareToken,
      guestSecret: input.guestSecret,
      displayName: input.displayName,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy,
      updatedAt: input.now.toISOString(),
    });
    return 'inserted';
  }

  async deleteGuest(input: { shareToken: string; guestId: string; guestSecret: string }) {
    const existing = this.guests.get(input.guestId);
    if (!existing || existing.shareToken !== input.shareToken || existing.guestSecret !== input.guestSecret) {
      return false;
    }
    this.guests.delete(input.guestId);
    return true;
  }
}

describe('ShareLinksModule', () => {
  const alice: JwtUserPayload = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'alice@example.com',
    username: 'Alice',
    role: 'USER',
  };
  const groupId = '22222222-2222-4222-8222-222222222222';
  const otherGroupMemberId = '33333333-3333-4333-8333-333333333333';

  function setup(privacy: PrivacyMode = 'EXACT') {
    let clock = Date.UTC(2026, 10, 21, 20, 0, 0);
    const store = new InMemoryShareLinkStore();
    store.memberships.set(`${alice.id}:${groupId}`, { role: 'MEMBER', effectivePrivacy: privacy });
    store.memberships.set(`${otherGroupMemberId}:${groupId}`, { role: 'MEMBER', effectivePrivacy: 'EXACT' });
    store.profiles.set(alice.id, {
      username: 'Alice',
      avatarUrl: null,
      haloColor: '#0ea5e9',
      fuzzCircleColor: null,
    });
    store.locations.set(alice.id, {
      latitude: 52.520008,
      longitude: 13.404954,
      altitude: 34,
      speed: 1.5,
      batteryLevel: 88,
      recordedAt: new Date(clock).toISOString(),
    });
    store.locations.set(otherGroupMemberId, {
      latitude: 48.8566,
      longitude: 2.3522,
      altitude: null,
      speed: null,
      batteryLevel: 70,
      recordedAt: new Date(clock).toISOString(),
    });

    const mod = new ShareLinksModule({
      store,
      publicServerUrl: 'https://track.example.com',
      now: () => clock,
    });

    return { store, mod, advanceMs: (ms: number) => { clock += ms; } };
  }

  it('creates isolated share links where multiple guests see each other and creator, never other group members', async () => {
    const { mod } = setup('EXACT');

    const link = await mod.createShareLink(alice, {
      groupId,
      durationMinutes: 60,
      label: 'Festival Meetup',
      allowGuestSharing: true,
    });
    expect(link.shareUrl).toBe(`https://track.example.com/share/${link.token}`);

    // Guest 1 (Maya) and Guest 2 (Leo) share their locations onto the same link
    const maya = await mod.upsertGuestPing(link.token, {
      displayName: 'Maya',
      latitude: 52.521,
      longitude: 13.406,
      accuracy: 12,
    });
    const leo = await mod.upsertGuestPing(link.token, {
      displayName: 'Leo',
      latitude: 52.522,
      longitude: 13.407,
    });

    const snapshot = await mod.getPublicShareSnapshot(link.token);
    expect(snapshot.creator.username).toBe('Alice');
    expect(snapshot.creator.latitude).toBeCloseTo(52.520008);
    expect(snapshot.guests.map((g) => g.displayName).sort()).toEqual(['Leo', 'Maya']);
    // Must not expose any other group member (e.g., Paris coordinates of otherGroupMemberId)
    expect(JSON.stringify(snapshot)).not.toContain('48.8566');

    // Guest secret prevents spoofing another guest's pin
    await expect(
      mod.upsertGuestPing(link.token, {
        displayName: 'Mallory',
        latitude: 52.5,
        longitude: 13.4,
        guestId: maya.guestId,
        guestSecret: 'wrong-secret-value-0000',
      }),
    ).rejects.toThrow('Guest session credentials did not match');

    // Stopping guest share removes only that guest
    await mod.stopGuestPing(link.token, {
      guestId: leo.guestId,
      guestSecret: leo.guestSecret,
    });
    const afterStop = await mod.getPublicShareSnapshot(link.token);
    expect(afterStop.guests.map((g) => g.displayName)).toEqual(['Maya']);
  });

  it('enforces creator FUZZED and GHOST privacy modes, expiration, and revocation', async () => {
    const { store, mod, advanceMs } = setup('FUZZED');

    const link = await mod.createShareLink(alice, {
      groupId,
      durationMinutes: 30,
      allowGuestSharing: false,
    });

    const fuzzedSnap = await mod.getPublicShareSnapshot(link.token);
    expect(fuzzedSnap.creator.isFuzzed).toBe(true);
    expect(fuzzedSnap.creator.hidden).toBe(false);
    expect(fuzzedSnap.creator.latitude).not.toBe(52.520008);

    // Switching creator to GHOST hides coordinates on the live share link
    store.memberships.set(`${alice.id}:${groupId}`, { role: 'MEMBER', effectivePrivacy: 'GHOST' });
    const ghostSnap = await mod.getPublicShareSnapshot(link.token);
    expect(ghostSnap.creator.hidden).toBe(true);
    expect(ghostSnap.creator.latitude).toBeNull();
    expect(ghostSnap.creator.longitude).toBeNull();

    // Guest pinging is blocked when allowGuestSharing is false
    await expect(
      mod.upsertGuestPing(link.token, {
        displayName: 'Sam',
        latitude: 52.52,
        longitude: 13.4,
      }),
    ).rejects.toThrow('Guest location sharing is disabled');

    // Advancing past expiry returns 410
    advanceMs(31 * 60_000);
    await expect(mod.getPublicShareSnapshot(link.token)).rejects.toThrow('expired');

    // Revoking active link returns 410 as well
    const second = await mod.createShareLink(alice, { groupId, durationMinutes: 60 });
    await mod.revokeShareLink(alice, second.token);
    await expect(mod.getPublicShareSnapshot(second.token)).rejects.toThrow('revoked');
  });

  it('blocks creating new share links when Host Admin disables shareLinksEnabled (#55)', async () => {
    const store = new InMemoryShareLinkStore();
    store.memberships.set(`${alice.id}:${groupId}`, { role: 'MEMBER', effectivePrivacy: 'EXACT' });
    let enabled = true;
    const mod = new ShareLinksModule({
      store,
      publicServerUrl: 'https://track.example.com',
      isShareLinksEnabled: async () => enabled,
    });

    const created = await mod.createShareLink(alice, { groupId, durationMinutes: 60 });
    expect(created.token).toMatch(/^shr_/);

    enabled = false;
    await expect(mod.createShareLink(alice, { groupId, durationMinutes: 60 })).rejects.toMatchObject({
      statusCode: 403,
    });

    // Listing & revoking existing links still works when creation is disabled
    const existing = await mod.listShareLinks(alice);
    expect(existing).toHaveLength(1);
    await expect(mod.revokeShareLink(alice, created.token)).resolves.toEqual({ revoked: true });
  });
});
