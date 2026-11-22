import { describe, expect, it } from 'vitest';
import {
  PushNotificationsModule,
  type PushSendResult,
  type PushSubscriptionRecord,
  type PushSubscriptionStore,
  type PushTransport,
  type VapidCredentials,
} from '../domain/push-notifications-module.js';
import type { WebPushNotificationPayload } from '@loved-ones/shared';

class InMemoryPushStore implements PushSubscriptionStore {
  private readonly creds: VapidCredentials = {
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    privateKey: 'test-private-key',
    subject: 'mailto:test@lovedones.local',
  };
  readonly subs = new Map<string, PushSubscriptionRecord>();
  readonly groupMembers = new Map<string, string[]>();

  async getVapidCredentials(): Promise<VapidCredentials> {
    return this.creds;
  }

  async upsertSubscription(input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<void> {
    this.subs.set(input.endpoint, {
      id: `sub_${this.subs.size + 1}`,
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    });
  }

  async deleteSubscription(userId: string, endpoint: string): Promise<boolean> {
    const existing = this.subs.get(endpoint);
    if (!existing || existing.userId !== userId) return false;
    this.subs.delete(endpoint);
    return true;
  }

  async deleteSubscriptionByEndpoint(endpoint: string): Promise<void> {
    this.subs.delete(endpoint);
  }

  async listSubscriptionsForUsers(userIds: string[]): Promise<PushSubscriptionRecord[]> {
    const allowed = new Set(userIds);
    return [...this.subs.values()].filter((s) => allowed.has(s.userId));
  }

  async listGroupMemberUserIds(groupId: string, excludeUserId?: string): Promise<string[]> {
    return (this.groupMembers.get(groupId) ?? []).filter((id) => id !== excludeUserId);
  }
}

describe('PushNotificationsModule', () => {
  it('stores subscriptions, routes chat/check-in/place alerts, and prunes 410 Gone endpoints', async () => {
    const store = new InMemoryPushStore();
    store.groupMembers.set('g1', ['u1', 'u2']);

    const sentPayloads: Array<{ endpoint: string; payload: WebPushNotificationPayload }> = [];
    const transport: PushTransport = {
      async send(sub, payload): Promise<PushSendResult> {
        if (sub.endpoint.includes('stale')) {
          return { ok: false, gone: true };
        }
        sentPayloads.push({ endpoint: sub.endpoint, payload });
        return { ok: true };
      },
    };

    const push = new PushNotificationsModule({ store, transport });
    const pubKey = await push.getPublicKey();
    expect(pubKey.length).toBeGreaterThan(20);

    await push.subscribe('u1', {
      endpoint: 'https://push.example.com/u1-active',
      keys: { p256dh: 'p256dh_key_value_0001', auth: 'auth_val_01' },
    });
    await push.subscribe('u2', {
      endpoint: 'https://push.example.com/u2-active',
      keys: { p256dh: 'p256dh_key_value_0002', auth: 'auth_val_02' },
    });
    await push.subscribe('u2', {
      endpoint: 'https://push.example.com/u2-stale',
      keys: { p256dh: 'p256dh_key_value_0003', auth: 'auth_val_03' },
    });

    await push.notifyChatMessage(
      {
        id: 'm1',
        groupId: 'g1',
        senderId: 'u1',
        senderUsername: 'Alice',
        content: 'On my way home!',
        createdAt: new Date().toISOString(),
      },
      'Family',
    );

    // u1 is excluded (sender), u2 stale is pruned, u2 active received payload
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.endpoint).toBe('https://push.example.com/u2-active');
    expect(sentPayloads[0]?.payload.tab).toBe('chat');
    expect(store.subs.has('https://push.example.com/u2-stale')).toBe(false);

    await push.notifyCheckInRequest(
      {
        id: 'req1',
        groupId: 'g1',
        requesterId: 'u2',
        requesterUsername: 'Bob',
        targetUserId: 'u1',
        targetUsername: 'Alice',
        status: 'pending',
        suggestedDurationMinutes: 15,
        message: 'Made it back?',
        expiresAt: new Date().toISOString(),
        respondedAt: null,
        createdAt: new Date().toISOString(),
      },
      'Family',
    );

    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1]?.endpoint).toBe('https://push.example.com/u1-active');
    expect(sentPayloads[1]?.payload.tab).toBe('requests');

    await push.notifyPlaceTransition(
      {
        id: 'evt1',
        groupId: 'g1',
        placeId: 'p1',
        placeName: 'Home',
        userId: 'u1',
        username: 'Alice',
        transition: 'enter',
        recordedAt: new Date().toISOString(),
      },
      'Family',
    );

    expect(sentPayloads).toHaveLength(3);
    expect(sentPayloads[2]?.endpoint).toBe('https://push.example.com/u2-active');
    expect(sentPayloads[2]?.payload.title).toBe('Alice arrived at Home');
    expect(sentPayloads[2]?.payload.tab).toBe('places');
  });

  it('rejects malformed subscription payloads and supports user unsubscribe', async () => {
    const store = new InMemoryPushStore();
    const transport: PushTransport = {
      async send() {
        return { ok: true };
      },
    };
    const push = new PushNotificationsModule({ store, transport });

    await expect(push.subscribe('u1', { endpoint: 'not-a-url' })).rejects.toThrow(
      'Invalid push subscription payload',
    );

    await push.subscribe('u1', {
      endpoint: 'https://push.example.com/sub-1',
      keys: { p256dh: 'p256dh_key_value_0001', auth: 'auth_val_01' },
    });
    expect(await push.unsubscribe('u1', { endpoint: 'https://push.example.com/sub-1' })).toEqual({
      unsubscribed: true,
    });
    expect(store.subs.size).toBe(0);
  });
});
