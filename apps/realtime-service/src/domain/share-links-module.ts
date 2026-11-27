import crypto from 'node:crypto';
import {
  applyPrivacyFuzzing,
  CreateLocationShareLinkSchema,
  type GroupRole,
  GuestSharePingSchema,
  GuestShareStopSchema,
  type JwtUserPayload,
  type LocationShareLinkItem,
  type PrivacyMode,
  type PublicLocationShareSnapshot,
} from '@loved-ones/shared';
import { DomainError } from '@loved-ones/shared/auth';

export const SHARE_GUEST_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_GUESTS_PER_SHARE_LINK = 25;

export interface ShareLinkRecord {
  token: string;
  userId: string;
  groupId: string;
  groupName: string;
  label: string | null;
  allowGuestSharing: boolean;
  activeGuestCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface ShareGuestRecord {
  id: string;
  shareToken: string;
  guestSecret: string;
  displayName: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  updatedAt: string;
}

export interface ShareCreatorMembershipInfo {
  role: GroupRole;
  effectivePrivacy: PrivacyMode;
}

export interface ShareCreatorProfile {
  username: string;
  avatarUrl: string | null;
  haloColor: string | null;
  fuzzCircleColor: string | null;
}

export interface ShareCreatorLatestLocation {
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  batteryLevel: number | null;
  recordedAt: string;
}

export interface ShareLinkStore {
  getMembershipPrivacy(
    userId: string,
    groupId: string,
    now: Date,
  ): Promise<ShareCreatorMembershipInfo | null>;
  getCreatorProfile(userId: string): Promise<ShareCreatorProfile | null>;
  getCreatorLatestLocation(userId: string): Promise<ShareCreatorLatestLocation | null>;
  createShareLink(input: {
    token: string;
    userId: string;
    groupId: string;
    label: string | null;
    allowGuestSharing: boolean;
    expiresAt: Date;
    now: Date;
  }): Promise<ShareLinkRecord>;
  listActiveShareLinksForUser(
    userId: string,
    now: Date,
    guestActiveWindowMs: number,
  ): Promise<ShareLinkRecord[]>;
  getShareLinkByToken(token: string): Promise<ShareLinkRecord | null>;
  revokeShareLink(userId: string, token: string, now: Date): Promise<boolean>;
  listActiveGuests(shareToken: string, since: Date): Promise<ShareGuestRecord[]>;
  upsertGuest(input: {
    id: string;
    shareToken: string;
    guestSecret: string;
    displayName: string;
    latitude: number;
    longitude: number;
    accuracy: number | null;
    now: Date;
    staleCutoff: Date;
  }): Promise<'inserted' | 'updated' | 'forbidden'>;
  deleteGuest(input: { shareToken: string; guestId: string; guestSecret: string }): Promise<boolean>;
}

function isLocalhostUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Manages temporary guest share links and isolated mutual guest location sharing.
 * Guests on a link can only see the creator (under their active PrivacyMode) and
 * fellow guests on the exact same link token — never other group members.
 */
export class ShareLinksModule {
  private readonly store: ShareLinkStore;
  private readonly publicServerUrl: string;
  private readonly now: () => number;
  private readonly isShareLinksEnabled?: () => Promise<boolean>;

  constructor(deps: {
    store: ShareLinkStore;
    publicServerUrl?: string;
    now?: () => number;
    isShareLinksEnabled?: () => Promise<boolean>;
  }) {
    this.store = deps.store;
    this.publicServerUrl = (deps.publicServerUrl ?? '').trim().replace(/\/$/, '');
    this.now = deps.now ?? (() => Date.now());
    this.isShareLinksEnabled = deps.isShareLinksEnabled;
  }

  private resolveShareBaseUrl(requestOrigin?: string): string {
    if (this.publicServerUrl && !isLocalhostUrl(this.publicServerUrl)) {
      return this.publicServerUrl;
    }
    if (requestOrigin && requestOrigin !== 'null') {
      return requestOrigin.replace(/\/$/, '');
    }
    return this.publicServerUrl;
  }

  private toItem(row: ShareLinkRecord, requestOrigin?: string): LocationShareLinkItem {
    const baseUrl = this.resolveShareBaseUrl(requestOrigin);
    return {
      token: row.token,
      groupId: row.groupId,
      groupName: row.groupName,
      label: row.label,
      allowGuestSharing: row.allowGuestSharing,
      activeGuestCount: row.activeGuestCount,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      shareUrl: baseUrl ? `${baseUrl}/share/${row.token}` : `/share/${row.token}`,
    };
  }

  async createShareLink(
    caller: JwtUserPayload,
    rawInput: unknown,
    requestOrigin?: string,
  ): Promise<LocationShareLinkItem> {
    if (this.isShareLinksEnabled && !(await this.isShareLinksEnabled())) {
      throw new DomainError(403, 'Public share links are disabled by the Host Admin');
    }

    const parsed = CreateLocationShareLinkSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid share link payload', parsed.error.flatten());
    }

    const nowDate = new Date(this.now());
    const membership = await this.store.getMembershipPrivacy(
      caller.id,
      parsed.data.groupId,
      nowDate,
    );
    if (!membership) {
      throw new DomainError(403, 'Not a member of this group');
    }
    if (membership.role === 'SPECTATOR') {
      throw new DomainError(403, 'Spectators cannot create location share links');
    }

    const token = `shr_${crypto.randomBytes(20).toString('hex')}`;
    const expiresAt = new Date(nowDate.getTime() + parsed.data.durationMinutes * 60_000);
    const created = await this.store.createShareLink({
      token,
      userId: caller.id,
      groupId: parsed.data.groupId,
      label: parsed.data.label ?? null,
      allowGuestSharing: parsed.data.allowGuestSharing,
      expiresAt,
      now: nowDate,
    });

    return this.toItem(created, requestOrigin);
  }

  async listShareLinks(
    caller: JwtUserPayload,
    requestOrigin?: string,
  ): Promise<LocationShareLinkItem[]> {
    const nowDate = new Date(this.now());
    const rows = await this.store.listActiveShareLinksForUser(
      caller.id,
      nowDate,
      SHARE_GUEST_ACTIVE_WINDOW_MS,
    );
    return rows.map((row) => this.toItem(row, requestOrigin));
  }

  async revokeShareLink(caller: JwtUserPayload, token: string): Promise<{ revoked: true }> {
    const trimmed = token.trim();
    if (!/^shr_[a-f0-9]{16,80}$/.test(trimmed)) {
      throw new DomainError(400, 'Invalid share link token');
    }
    const revoked = await this.store.revokeShareLink(caller.id, trimmed, new Date(this.now()));
    if (!revoked) {
      throw new DomainError(404, 'Share link not found or already revoked');
    }
    return { revoked: true };
  }

  private async requireActiveLink(token: string): Promise<ShareLinkRecord> {
    const trimmed = token.trim();
    if (!/^shr_[a-f0-9]{16,80}$/.test(trimmed)) {
      throw new DomainError(404, 'Share link not found');
    }
    const link = await this.store.getShareLinkByToken(trimmed);
    if (!link) {
      throw new DomainError(404, 'Share link not found');
    }
    if (link.revokedAt) {
      throw new DomainError(410, 'This share link was revoked');
    }
    if (Date.parse(link.expiresAt) <= this.now()) {
      throw new DomainError(410, 'This share link has expired');
    }
    return link;
  }

  async getPublicShareSnapshot(token: string): Promise<PublicLocationShareSnapshot> {
    const link = await this.requireActiveLink(token);
    const nowDate = new Date(this.now());
    const guestCutoff = new Date(nowDate.getTime() - SHARE_GUEST_ACTIVE_WINDOW_MS);

    const [membership, profile, latest, guests] = await Promise.all([
      this.store.getMembershipPrivacy(link.userId, link.groupId, nowDate),
      this.store.getCreatorProfile(link.userId),
      this.store.getCreatorLatestLocation(link.userId),
      link.allowGuestSharing
        ? this.store.listActiveGuests(link.token, guestCutoff)
        : Promise.resolve([]),
    ]);

    const effectivePrivacy: PrivacyMode = membership?.effectivePrivacy ?? 'GHOST';
    const hidden = effectivePrivacy === 'GHOST' || !membership || !latest;
    const isFuzzed = !hidden && effectivePrivacy === 'FUZZED';

    let latitude: number | null = null;
    let longitude: number | null = null;
    if (!hidden && latest) {
      if (isFuzzed) {
        const fuzzed = applyPrivacyFuzzing(
          latest.latitude,
          latest.longitude,
          effectivePrivacy,
          link.userId,
          this.now(),
        );
        latitude = fuzzed.latitude;
        longitude = fuzzed.longitude;
      } else {
        latitude = latest.latitude;
        longitude = latest.longitude;
      }
    }

    return {
      token: link.token,
      label: link.label,
      allowGuestSharing: link.allowGuestSharing,
      expiresAt: link.expiresAt,
      creator: {
        userId: link.userId,
        username: profile?.username ?? 'Member',
        avatarUrl: profile?.avatarUrl ?? null,
        haloColor: profile?.haloColor ?? null,
        fuzzCircleColor: profile?.fuzzCircleColor ?? null,
        privacyMode: effectivePrivacy,
        isFuzzed,
        hidden,
        latitude,
        longitude,
        altitude: hidden || isFuzzed ? null : (latest?.altitude ?? null),
        speed: hidden || isFuzzed ? null : (latest?.speed ?? null),
        batteryLevel: hidden ? null : (latest?.batteryLevel ?? null),
        recordedAt: hidden ? null : (latest?.recordedAt ?? null),
      },
      guests: guests.map((g) => ({
        id: g.id,
        displayName: g.displayName,
        latitude: g.latitude,
        longitude: g.longitude,
        accuracy: g.accuracy,
        updatedAt: g.updatedAt,
      })),
    };
  }

  async upsertGuestPing(
    token: string,
    rawInput: unknown,
  ): Promise<{ guestId: string; guestSecret: string; snapshot: PublicLocationShareSnapshot }> {
    const link = await this.requireActiveLink(token);
    if (!link.allowGuestSharing) {
      throw new DomainError(403, 'Guest location sharing is disabled for this link');
    }

    const parsed = GuestSharePingSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid guest ping payload', parsed.error.flatten());
    }
    if (Math.abs(parsed.data.latitude) < 1e-6 && Math.abs(parsed.data.longitude) < 1e-6) {
      throw new DomainError(400, 'Invalid coordinates (Null Island rejected)');
    }

    const nowDate = new Date(this.now());
    const staleCutoff = new Date(nowDate.getTime() - SHARE_GUEST_ACTIVE_WINDOW_MS);

    const existingGuests = await this.store.listActiveGuests(link.token, staleCutoff);
    const hasExistingCredentials = Boolean(parsed.data.guestId && parsed.data.guestSecret);
    const isKnownGuest =
      hasExistingCredentials && existingGuests.some((g) => g.id === parsed.data.guestId);
    if (!isKnownGuest && existingGuests.length >= MAX_GUESTS_PER_SHARE_LINK) {
      throw new DomainError(429, 'This share link has reached the maximum active guest limit');
    }

    const guestId = parsed.data.guestId ?? crypto.randomUUID();
    const guestSecret = parsed.data.guestSecret ?? crypto.randomBytes(24).toString('hex');

    const status = await this.store.upsertGuest({
      id: guestId,
      shareToken: link.token,
      guestSecret,
      displayName: parsed.data.displayName,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      accuracy: parsed.data.accuracy ?? null,
      now: nowDate,
      staleCutoff,
    });

    if (status === 'forbidden') {
      throw new DomainError(403, 'Guest session credentials did not match');
    }

    const snapshot = await this.getPublicShareSnapshot(link.token);
    return { guestId, guestSecret, snapshot };
  }

  async stopGuestPing(
    token: string,
    rawInput: unknown,
  ): Promise<{ stopped: boolean; snapshot: PublicLocationShareSnapshot }> {
    const link = await this.requireActiveLink(token);
    const parsed = GuestShareStopSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid guest stop payload', parsed.error.flatten());
    }
    const stopped = await this.store.deleteGuest({
      shareToken: link.token,
      guestId: parsed.data.guestId,
      guestSecret: parsed.data.guestSecret,
    });
    const snapshot = await this.getPublicShareSnapshot(link.token);
    return { stopped, snapshot };
  }
}
