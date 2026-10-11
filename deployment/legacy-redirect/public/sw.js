/* Retire only this origin's Alert Disaster cache and move installed clients. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name.startsWith('alert-disaster-')) await caches.delete(name);
  }
  await self.clients.claim();
  for (const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})) {
    await client.navigate('https://alert-disaster-field-2026.web.app');
  }
  await self.registration.unregister();
})()));
