import {
  type ChatMessage,
  type LocationRequestItem,
  type PlaceTransitionEvent,
  PushSubscriptionInputSchema,
  PushUnsubscribeInputSchema,
  type WebPushNotificationPayload,
} from '@loved-ones/shared';
import { DomainError } from '@loved-ones/shared/auth';

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidCredentials {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushSubscriptionStore {
  getVapidCredentials(): Promise<VapidCredentials>;
  upsertSubscription(input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }): Promise<void>;
  deleteSubscription(userId: string, endpoint: string): Promise<boolean>;
  deleteSubscriptionByEndpoint(endpoint: string): Promise<void>;
  listSubscriptionsForUsers(userIds: string[]): Promise<PushSubscriptionRecord[]>;
  listGroupMemberUserIds(groupId: string, excludeUserId?: string): Promise<string[]>;
}

export interface PushSendResult {
  ok: boolean;
  gone?: boolean;
}

export interface PushTransport {
  send(
    subscription: PushSubscriptionRecord,
    payload: WebPushNotificationPayload,
    credentials: VapidCredentials,
  ): Promise<PushSendResult>;
}

function truncateText(text: string, max = 140): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Coordinates Web Push VAPID keys, subscription lifecycle, and background
 * notifications for chat messages, check-in requests, and geofence transitions.
 */
export class PushNotificationsModule {
  private readonly store: PushSubscriptionStore;
  private readonly transport: PushTransport;

  constructor(deps: { store: PushSubscriptionStore; transport: PushTransport }) {
    this.store = deps.store;
    this.transport = deps.transport;
  }

  async getPublicKey(): Promise<string> {
    const creds = await this.store.getVapidCredentials();
    return creds.publicKey;
  }

  async subscribe(
    userId: string,
    rawInput: unknown,
    userAgent?: string | null,
  ): Promise<{ subscribed: true }> {
    const parsed = PushSubscriptionInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid push subscription payload', parsed.error.flatten());
    }
    await this.store.upsertSubscription({
      userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent: userAgent ?? null,
    });
    return { subscribed: true };
  }

  async unsubscribe(userId: string, rawInput: unknown): Promise<{ unsubscribed: boolean }> {
    const parsed = PushUnsubscribeInputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new DomainError(400, 'Invalid push unsubscribe payload', parsed.error.flatten());
    }
    const unsubscribed = await this.store.deleteSubscription(userId, parsed.data.endpoint);
    return { unsubscribed };
  }

  async sendTestNotification(
    userId: string,
    username: string,
  ): Promise<{ sent: number; failed: number }> {
    return this.deliverToUsers([userId], {
      title: 'LovedOnes Push Ready',
      body: `Background alerts are active for ${username}.`,
      tag: `test:${userId}`,
      url: '/',
    });
  }

  async notifyChatMessage(message: ChatMessage, groupName: string): Promise<void> {
    const recipients = await this.store.listGroupMemberUserIds(message.groupId, message.senderId);
    if (recipients.length === 0) return;

    await this.deliverToUsers(recipients, {
      title: `${message.senderUsername} · ${groupName}`,
      body: truncateText(message.content, 160),
      tag: `chat:${message.groupId}`,
      url: `/?groupId=${encodeURIComponent(message.groupId)}&tab=chat`,
      groupId: message.groupId,
      tab: 'chat',
    });
  }

  async notifyCheckInRequest(request: LocationRequestItem, groupName: string): Promise<void> {
    const note = request.message ? ` — "${truncateText(request.message, 80)}"` : '';
    await this.deliverToUsers([request.targetUserId], {
      title: `Check-in request from ${request.requesterUsername}`,
      body: `${groupName}: share exact location for ${request.suggestedDurationMinutes}m${note}`,
      tag: `checkin:${request.id}`,
      url: `/?groupId=${encodeURIComponent(request.groupId)}&tab=requests`,
      groupId: request.groupId,
      tab: 'requests',
    });
  }

  async notifyCheckInResponse(request: LocationRequestItem, groupName: string): Promise<void> {
    const verb = request.status === 'accepted' ? 'accepted' : 'declined';
    await this.deliverToUsers([request.requesterId], {
      title: `${request.targetUsername} ${verb} your check-in`,
      body:
        request.status === 'accepted'
          ? `${groupName}: exact location shared for ${request.suggestedDurationMinutes}m`
          : `${groupName}: check-in request declined`,
      tag: `checkin-resp:${request.id}`,
      url: `/?groupId=${encodeURIComponent(request.groupId)}&tab=people`,
      groupId: request.groupId,
      tab: 'people',
    });
  }

  async notifyPlaceTransition(event: PlaceTransitionEvent, groupName: string): Promise<void> {
    const recipients = await this.store.listGroupMemberUserIds(event.groupId, event.userId);
    if (recipients.length === 0) return;

    const actionText = event.transition === 'enter' ? 'arrived at' : 'left';
    await this.deliverToUsers(recipients, {
      title: `${event.username} ${actionText} ${event.placeName}`,
      body: `${groupName} · ${new Date(event.recordedAt).toLocaleTimeString()}`,
      tag: `place:${event.placeId}:${event.userId}`,
      url: `/?groupId=${encodeURIComponent(event.groupId)}&tab=places`,
      groupId: event.groupId,
      tab: 'places',
    });
  }

  private async deliverToUsers(
    userIds: string[],
    payload: WebPushNotificationPayload,
  ): Promise<{ sent: number; failed: number }> {
    const subscriptions = await this.store.listSubscriptionsForUsers(userIds);
    if (subscriptions.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const creds = await this.store.getVapidCredentials();
    let sent = 0;
    let failed = 0;

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          const result = await this.transport.send(sub, payload, creds);
          if (result.ok) {
            sent += 1;
          } else {
            failed += 1;
            if (result.gone) {
              await this.store.deleteSubscriptionByEndpoint(sub.endpoint).catch(() => {});
            }
          }
        } catch {
          failed += 1;
        }
      }),
    );

    return { sent, failed };
  }
}
