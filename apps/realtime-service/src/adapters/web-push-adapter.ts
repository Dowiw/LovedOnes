import { createRequire } from 'node:module';
import pg from 'pg';
import type * as WebPushType from 'web-push';

const require = createRequire(import.meta.url);
// web-push ships a CommonJS export without an ESM default export on Node 22.
const webpush = require('web-push') as typeof WebPushType;
import {
  deletePushSubscription,
  deletePushSubscriptionByEndpoint,
  getOrCreatePushVapidConfig,
  listGroupMemberUserIds,
  listPushSubscriptionsForUsers,
  upsertPushSubscription,
} from '@loved-ones/db';
import type { WebPushNotificationPayload } from '@loved-ones/shared';
import type {
  PushSendResult,
  PushSubscriptionRecord,
  PushSubscriptionStore,
  PushTransport,
  VapidCredentials,
} from '../domain/push-notifications-module.js';

export class PostgresPushSubscriptionStore implements PushSubscriptionStore {
  private readonly pool: pg.Pool;
  private cachedCreds: VapidCredentials | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async getVapidCredentials(): Promise<VapidCredentials> {
    const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
    const envSubject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@lovedones.local';
    if (envPublic && envPrivate) {
      return {
        publicKey: envPublic,
        privateKey: envPrivate,
        subject: envSubject,
      };
    }

    if (this.cachedCreds) {
      return this.cachedCreds;
    }

    const stored = await getOrCreatePushVapidConfig(this.pool, () => {
      const generated = webpush.generateVAPIDKeys();
      return {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
        subject: envSubject,
      };
    });
    this.cachedCreds = stored;
    return stored;
  }

  upsertSubscription(input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }): Promise<void> {
    return upsertPushSubscription(this.pool, input);
  }

  deleteSubscription(userId: string, endpoint: string): Promise<boolean> {
    return deletePushSubscription(this.pool, userId, endpoint);
  }

  deleteSubscriptionByEndpoint(endpoint: string): Promise<void> {
    return deletePushSubscriptionByEndpoint(this.pool, endpoint);
  }

  listSubscriptionsForUsers(userIds: string[]): Promise<PushSubscriptionRecord[]> {
    return listPushSubscriptionsForUsers(this.pool, userIds);
  }

  listGroupMemberUserIds(groupId: string, excludeUserId?: string): Promise<string[]> {
    return listGroupMemberUserIds(this.pool, groupId, excludeUserId);
  }
}

export class WebPushTransport implements PushTransport {
  async send(
    subscription: PushSubscriptionRecord,
    payload: WebPushNotificationPayload,
    credentials: VapidCredentials,
  ): Promise<PushSendResult> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        JSON.stringify(payload),
        {
          TTL: 60 * 60,
          vapidDetails: {
            subject: credentials.subject,
            publicKey: credentials.publicKey,
            privateKey: credentials.privateKey,
          },
        },
      );
      return { ok: true };
    } catch (err) {
      const statusCode =
        typeof err === 'object' && err !== null && 'statusCode' in err
          ? Number((err as { statusCode?: unknown }).statusCode)
          : undefined;
      if (statusCode === 404 || statusCode === 410) {
        return { ok: false, gone: true };
      }
      return { ok: false };
    }
  }
}
