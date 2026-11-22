import pg from 'pg';
import {
  createLocationShareLinkRecord,
  deleteShareGuestRecord,
  getGroupMembershipPrivacyInfo,
  getLatestUserLocation,
  getLocationShareLinkByToken,
  getUserPublicProfile,
  listActiveLocationShareLinksForUser,
  listActiveShareGuests,
  revokeLocationShareLinkRecord,
  upsertShareGuestRecord,
} from '@loved-ones/db';
import type {
  ShareCreatorLatestLocation,
  ShareCreatorMembershipInfo,
  ShareCreatorProfile,
  ShareGuestRecord,
  ShareLinkRecord,
  ShareLinkStore,
} from '../domain/share-links-module.js';

export class PostgresShareLinkStore implements ShareLinkStore {
  constructor(private readonly pool: pg.Pool) {}

  async getMembershipPrivacy(
    userId: string,
    groupId: string,
    now: Date,
  ): Promise<ShareCreatorMembershipInfo | null> {
    const info = await getGroupMembershipPrivacyInfo(this.pool, userId, groupId, now);
    if (!info) return null;
    return {
      role: info.role,
      effectivePrivacy: info.effectivePrivacy,
    };
  }

  getCreatorProfile(userId: string): Promise<ShareCreatorProfile | null> {
    return getUserPublicProfile(this.pool, userId);
  }

  async getCreatorLatestLocation(userId: string): Promise<ShareCreatorLatestLocation | null> {
    const latest = await getLatestUserLocation(this.pool, userId);
    if (!latest) return null;
    return {
      latitude: latest.latitude,
      longitude: latest.longitude,
      altitude: latest.altitude ?? null,
      speed: latest.speed ?? null,
      batteryLevel: latest.batteryLevel ?? null,
      recordedAt: latest.recordedAt,
    };
  }

  createShareLink(input: {
    token: string;
    userId: string;
    groupId: string;
    label: string | null;
    allowGuestSharing: boolean;
    expiresAt: Date;
    now: Date;
  }): Promise<ShareLinkRecord> {
    return createLocationShareLinkRecord(this.pool, input);
  }

  listActiveShareLinksForUser(
    userId: string,
    now: Date,
    guestActiveWindowMs: number,
  ): Promise<ShareLinkRecord[]> {
    return listActiveLocationShareLinksForUser(this.pool, userId, now, guestActiveWindowMs);
  }

  getShareLinkByToken(token: string): Promise<ShareLinkRecord | null> {
    return getLocationShareLinkByToken(this.pool, token);
  }

  revokeShareLink(userId: string, token: string, now: Date): Promise<boolean> {
    return revokeLocationShareLinkRecord(this.pool, userId, token, now);
  }

  listActiveGuests(shareToken: string, since: Date): Promise<ShareGuestRecord[]> {
    return listActiveShareGuests(this.pool, shareToken, since);
  }

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
  }): Promise<'inserted' | 'updated' | 'forbidden'> {
    return upsertShareGuestRecord(this.pool, input);
  }

  deleteGuest(input: {
    shareToken: string;
    guestId: string;
    guestSecret: string;
  }): Promise<boolean> {
    return deleteShareGuestRecord(this.pool, input);
  }
}
