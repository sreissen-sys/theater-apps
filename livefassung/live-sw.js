// Live-Fassung: Offline-Baustein (nur wenn Live allein läuft; in Doppelpult übernimmt das dessen Baustein)
const CACHE = 'livefassung-app-3', IMG = 'livebilder-1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(['./', 'google.json'].map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
const imgTrim = async c => { const ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - 600))) await c.delete(k); };
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (/(^|\.)googleusercontent\.com$/.test(u.hostname)) {   // Bilder der Fassung: ohne Netz aus dem Vorrat
    e.respondWith(caches.open(IMG).then(async c => {
      try { const res = await fetch(r); if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()).then(() => imgTrim(c)).catch(() => {}); return res; }
      catch (err) { return (await c.match(r, { ignoreVary: true })) || Response.error(); }
    }));
    return;
  }
  if (u.origin !== self.location.origin || r.cache === 'no-store') return;
  if (r.mode === 'navigate') {                              // Seite selbst: mit Netz die neueste (höchstens 3 s warten), ohne Netz die gespeicherte
    e.respondWith(caches.open(CACHE).then(async c => {
      try { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000); const res = await fetch(r, { signal: ctl.signal }); clearTimeout(t); if (res.ok && !res.redirected) c.put('./', res.clone()); return res; }
      catch (err) { return (await c.match('./')) || (await c.match(r, { ignoreSearch: true })) || Response.error(); }
    }));
    return;
  }
  if (/\/regie\.js$/.test(u.pathname)) {                     // Regie-Modus: mit Netz immer der neueste, ohne Netz der gespeicherte
    e.respondWith(caches.open(CACHE).then(async c => { try { const res = await fetch(r, { cache: 'no-cache' }); if (res.ok) c.put(r, res.clone()).catch(() => {}); return res; } catch (err) { return (await c.match(r, { ignoreSearch: true })) || Response.error(); } }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {        // Schriften, Bausteine: aus dem Vorrat, sonst holen und vormerken
    const hit = await c.match(r, { ignoreSearch: true }); if (hit) return hit;
    const res = await fetch(r); if (res.ok) c.put(r, res.clone()).catch(() => {}); return res;
  }));
});
