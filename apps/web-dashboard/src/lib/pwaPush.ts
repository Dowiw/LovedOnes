import {
  apiFetchVapidPublicKey,
  apiSubscribeWebPush,
  apiUnsubscribeWebPush,
} from './api';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/**
 * Decodes a URL-safe base64 VAPID public key into a Uint8Array for PushManager.subscribe().
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * iOS Safari only exposes Web Push (PushManager) once the PWA is installed to the Home Screen.
 */
export function isIosSafariNeedingInstall(userAgent: string, isStandalone: boolean): boolean {
  if (isStandalone) return false;
  const ua = userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  return isIos;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function subscribeToWebPush(accessToken: string): Promise<PushSubscription> {
  if (!isWebPushSupported()) {
    throw new Error('Background push notifications are not supported in this browser.');
  }
  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await apiFetchVapidPublicKey(accessToken);
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Browser returned an incomplete push subscription.');
  }

  await apiSubscribeWebPush(accessToken, {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  });

  return subscription;
}

export async function unsubscribeFromWebPush(accessToken?: string): Promise<boolean> {
  const existing = await getExistingPushSubscription();
  if (!existing) return false;
  const endpoint = existing.endpoint;
  await existing.unsubscribe().catch(() => {});
  if (accessToken && endpoint) {
    await apiUnsubscribeWebPush(accessToken, endpoint).catch(() => {});
  }
  return true;
}
