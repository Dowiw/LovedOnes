const CACHE_NAME = 'lovedones-pwa-v1';
const STATIC_ASSETS = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept live APIs, Socket.io, or PMTiles byte-range requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/tiles/')
  ) {
    return;
  }

  // Cache-first for static PWA icons and manifest
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {
    title: 'LovedOnes',
    body: 'New group activity',
    tag: 'lovedones-alert',
    url: '/',
    groupId: undefined,
    tab: undefined,
  };

  try {
    const parsed = event.data.json();
    if (parsed && typeof parsed === 'object') {
      payload = {
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : 'LovedOnes',
        body: typeof parsed.body === 'string' ? parsed.body : '',
        tag: typeof parsed.tag === 'string' && parsed.tag ? parsed.tag : 'lovedones-alert',
        url: typeof parsed.url === 'string' && parsed.url.startsWith('/') ? parsed.url : '/',
        groupId: typeof parsed.groupId === 'string' ? parsed.groupId : undefined,
        tab: typeof parsed.tab === 'string' ? parsed.tab : undefined,
      };
    }
  } catch {
    const text = event.data.text();
    if (text) payload.body = text;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: payload.tag,
      renotify: true,
      data: {
        url: payload.url,
        groupId: payload.groupId,
        tab: payload.tab,
      },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetPath = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          client.postMessage({
            type: 'LO_OPEN_NOTIFICATION',
            url: targetPath,
            groupId: data.groupId,
            tab: data.tab,
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
