// Service worker: keeps the app opening without internet, and shows the reminders.

const CACHE = 'fuzet-v1';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './format.js',
  './config.js',
  './vendor/supabase.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The app's own files come from the network when it answers within a few seconds, so updates
// arrive at once, and from the cache otherwise. Supabase requests are left alone.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromNetwork = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    const response = await Promise.race([fromNetwork.catch(() => undefined), timeout]);
    if (response) return response;
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    return cached ?? (request.mode === 'navigate' ? await cache.match('./index.html') : undefined) ?? fromNetwork;
  })());
});

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  // iOS stops delivering to a subscription that receives pushes without a notification shown.
  event.waitUntil(self.registration.showNotification(message.title || 'Füzet', {
    body: message.body || '',
    tag: message.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: message.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope);
  const day = target.searchParams.get('nap');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if (day) client.postMessage({ type: 'open-day', day });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
