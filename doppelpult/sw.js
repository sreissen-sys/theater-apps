// Doppelpult: Offline-Baustein. Stand d71655ce
const CACHE = 'doppelpult-d71655ce';
const FILES = [
 "./",
 "fonts/sofia-sans-extra-condensed-latin-600-normal.woff2",
 "fonts/sofia-sans-extra-condensed-latin-700-normal.woff2",
 "fonts/sofia-sans-extra-condensed-latin-ext-600-normal.woff2",
 "fonts/sofia-sans-extra-condensed-latin-ext-700-normal.woff2",
 "fonts/sofia-sans-latin-400-normal.woff2",
 "fonts/sofia-sans-latin-600-normal.woff2",
 "fonts/sofia-sans-latin-700-normal.woff2",
 "fonts/sofia-sans-latin-ext-400-normal.woff2",
 "fonts/sofia-sans-latin-ext-600-normal.woff2",
 "fonts/sofia-sans-latin-ext-700-normal.woff2",
 "google.json",
 "icons/icon-180.png",
 "icons/icon-192.png",
 "icons/icon-512-maskable.png",
 "icons/icon-512.png",
 "index.html",
 "live.html",
 "manifest.webmanifest",
 "vendor/fontkit.umd.min.js",
 "vendor/pdf-lib.min.js",
 "vendor/pdf.min.js",
 "vendor/pdf.worker.min.js",
 "vendor/pdffonts/lit-b.ttf",
 "vendor/pdffonts/lit-bi.ttf",
 "vendor/pdffonts/lit-i.ttf",
 "vendor/pdffonts/lit-r.ttf",
 "vendor/pdffonts/sof-b.ttf",
 "vendor/pdffonts/sof-r.ttf",
 "vendor/pdffonts/sofc-b.ttf",
 "vendor/standard_fonts/FoxitDingbats.pfb",
 "vendor/standard_fonts/FoxitFixed.pfb",
 "vendor/standard_fonts/FoxitFixedBold.pfb",
 "vendor/standard_fonts/FoxitFixedBoldItalic.pfb",
 "vendor/standard_fonts/FoxitFixedItalic.pfb",
 "vendor/standard_fonts/FoxitSerif.pfb",
 "vendor/standard_fonts/FoxitSerifBold.pfb",
 "vendor/standard_fonts/FoxitSerifBoldItalic.pfb",
 "vendor/standard_fonts/FoxitSerifItalic.pfb",
 "vendor/standard_fonts/FoxitSymbol.pfb",
 "vendor/standard_fonts/LiberationSans-Bold.ttf",
 "vendor/standard_fonts/LiberationSans-BoldItalic.ttf",
 "vendor/standard_fonts/LiberationSans-Italic.ttf",
 "vendor/standard_fonts/LiberationSans-Regular.ttf"
];
const CORE = ['./', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js'];
self.addEventListener('install', e => {
  // Jede Datei einzeln holen: Fehlt beim Anbieter eine Nebensache (etwa eine Ersatzschrift), läuft die App trotzdem ohne Netz.
  e.waitUntil(caches.open(CACHE).then(async c => {
    await Promise.all(FILES.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => null)));
    for (const f of CORE) if (!(await c.match(f))) throw new Error('Doppelpult: ' + f + ' fehlt');
    return self.skipWaiting();
  }));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('doppelpult-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Bilder der Live-Fassung (von Google): mit Netz frisch holen und vormerken, ohne Netz aus dem Vorrat. Eigener Vorrat, bleibt bei Updates erhalten.
const IMG = 'livebilder-1';
const imgTrim = async c => { const ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - 600))) await c.delete(k); };
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method === 'GET' && /(^|\.)googleusercontent\.com$/.test(new URL(r.url).hostname)) {
    e.respondWith(caches.open(IMG).then(async c => {
      try { const res = await fetch(r); if (res && (res.ok || res.type === 'opaque')) { c.put(r, res.clone()).then(() => imgTrim(c)).catch(() => {}); } return res; }
      catch (err) { return (await c.match(r, { ignoreVary: true })) || Response.error(); }
    }));
    return;
  }
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin || r.cache === 'no-store' || /version\.txt$/.test(new URL(r.url).pathname)) return;   // Versionsabfrage immer direkt ans Netz
  const path = new URL(r.url).pathname, home = r.mode === 'navigate' && /\/(index\.html)?$/.test(path);
  // Anmeldung beim Anbieter (z. B. Netlify-Schutz): Startseite mit ?login unverändert ans Netz durchreichen, damit die Anmeldeseite erscheint
  if (home && /[?&]login=/.test(new URL(r.url).search)) return;
  if (home) {
    // Startseite: mit Netz immer die neueste Fassung holen (höchstens 3 Sekunden warten), ohne Netz die gespeicherte
    e.respondWith(caches.open(CACHE).then(async c => {
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000);
        const res = await fetch(new Request('./', { cache: 'no-store' }), { signal: ctl.signal }); clearTimeout(t);
        // nur übernehmen, was wirklich Doppelpult ist: keine Anmelde- oder Fehlerseite des Anbieters in den Vorrat legen
        if (res.ok && !res.redirected) { const txt = await res.clone().text(); if (txt.includes('<meta name="doppelpult"')) { c.put('./', res.clone()); return res; } }
      } catch (err) {}
      return (await c.match('./')) || fetch(r);
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => (await c.match(r, { ignoreSearch: true })) || fetch(r)));
});
