// Live-Fassung · dauerhafte Google-Anmeldung
// Die App holt bei Google einmal einen Code (Anmeldefenster). Diese Funktion tauscht ihn mit dem geheimen Clientschlüssel
// (Netlify-Variable GOOGLE_CLIENT_SECRET) gegen Zugangsdaten. Die Dauer-Anmeldung (Refresh-Token) bleibt verschlüsselt
// in einem nur für diese Adresse lesbaren Cookie auf dem Gerät – gespeichert wird hier nichts.
// Danach liefert die Funktion jederzeit frische Stunden-Zugänge, ohne Fenster.
const TOKEN = 'https://oauth2.googleapis.com/token', COOKIE = 'lf_rt', AGE = 180 * 24 * 3600;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = b => Buffer.from(b).toString('base64url'), unb64u = s => new Uint8Array(Buffer.from(s, 'base64url'));
const secret = () => (globalThis.Netlify?.env?.get?.('GOOGLE_CLIENT_SECRET') ?? process.env.GOOGLE_CLIENT_SECRET) || '';
async function key(s) { const h = await crypto.subtle.digest('SHA-256', enc.encode('lf-rt-v1|' + s)); return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(obj, s) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(s), enc.encode(JSON.stringify(obj)))); const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return b64u(out); }
async function open(str, s) { try { const b = unb64u(str); const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await key(s), b.slice(12)); return JSON.parse(dec.decode(pt)); } catch (e) { return null; } }
const cookieOf = req => { const m = /(?:^|;\s*)lf_rt=([^;]+)/.exec(req.headers.get('cookie') || ''); return m ? m[1] : null; };
const setCk = (v, age) => COOKIE + '=' + v + '; Path=/api/gauth; Max-Age=' + age + '; HttpOnly; Secure; SameSite=Strict';
const json = (o, st = 200, ck) => { const h = { 'content-type': 'application/json', 'cache-control': 'no-store' }; if (ck) h['set-cookie'] = ck; return new Response(JSON.stringify(o), { status: st, headers: h }); };
async function google(params) { const r = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }); let j = {}; try { j = await r.json(); } catch (e) {} return { ok: r.ok, j }; }

export default async (req) => {
  const s = secret();
  if (req.method === 'GET') return json({ ok: true, ready: !!s, has: !!cookieOf(req) });   // Prüfen, ob es die Funktion gibt
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const host = new URL(req.url).host, org = req.headers.get('origin');
  if (req.headers.get('x-lf') !== '1' || (org && new URL(org).host !== host)) return json({ error: 'origin' }, 403);   // nur die eigene Seite
  if (!s) return json({ error: 'not_configured' }, 503);
  let b = {}; try { b = await req.json(); } catch (e) {}
  const cid = String(b.clientId || '');
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(cid)) return json({ error: 'client' }, 400);
  if (b.op === 'code') {
    const { ok, j } = await google({ code: String(b.code || ''), client_id: cid, client_secret: s, redirect_uri: 'postmessage', grant_type: 'authorization_code' });
    if (!ok || !j.access_token) return json({ error: j.error || 'exchange', detail: j.error_description || '' }, 400);
    const ck = j.refresh_token ? setCk(await seal({ c: cid, r: j.refresh_token }, s), AGE) : null;
    return json({ access_token: j.access_token, expires_in: j.expires_in, scope: j.scope, keep: !!j.refresh_token }, 200, ck);
  }
  if (b.op === 'refresh') {
    const raw = cookieOf(req), o = raw && await open(raw, s);
    if (!o || o.c !== cid) return json({ error: 'no_session' }, 401, raw ? setCk('', 0) : null);
    const { ok, j } = await google({ refresh_token: o.r, client_id: cid, client_secret: s, grant_type: 'refresh_token' });
    if (!ok || !j.access_token) { const gone = j.error === 'invalid_grant'; return json({ error: j.error || 'refresh' }, gone ? 401 : 502, gone ? setCk('', 0) : null); }
    return json({ access_token: j.access_token, expires_in: j.expires_in, scope: j.scope }, 200, setCk(raw, AGE));   // Cookie-Laufzeit verlängern
  }
  if (b.op === 'logout') {
    const raw = cookieOf(req), o = raw && await open(raw, s);
    if (o?.r) { try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: o.r }) }); } catch (e) {} }
    return json({ ok: true }, 200, setCk('', 0));
  }
  return json({ error: 'op' }, 400);
};
export const config = { path: '/api/gauth' };
