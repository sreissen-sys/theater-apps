// Aufräumen: Unter dieser Adresse lief kurzzeitig versehentlich Doppelpult und hat seinen Offline-Baustein (sw.js) eingerichtet.
// Der Browser fragt diese Datei regelmäßig neu ab – sie löscht den Doppelpult-Vorrat, meldet sich ab und lädt die Seite neu,
// damit wieder die Live-Fassung (mit ihrem eigenen Baustein live-sw.js) erscheint.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('doppelpult')) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) { try { c.navigate(c.url); } catch (err) {} }
})()));
