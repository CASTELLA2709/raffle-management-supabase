const CACHE_NAME = 'raffle-management-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) {
    payload = { title: '抽選管理', body: event.data?.text?.() || '通知があります。' };
  }

  const title = payload.title || '抽選管理';
  const options = {
    body: payload.body || '通知があります。',
    icon: payload.icon || './icon/icon-192.png',
    badge: payload.badge || './icon/icon-192.png',
    tag: payload.tag || 'raffle-management-notification',
    renotify: true,
    data: { url: payload.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        try { await client.navigate(target); } catch (_) {}
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
