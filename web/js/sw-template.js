/* Service worker for Window Seat. Generated as /sw.js by pipeline/assets.py (VERSION baked in).
 *
 * Caches
 *   ws-shell-<VERSION>  app shell (html/js/css/vendor/icons/route/indexes). Precached at install.
 *   ws-data             big content-addressed files (basemap parts, POI chunks, fonts). Downloaded by
 *                       the page right after install (see js/cache.js), resumable, kept across versions.
 *
 * The basemap is one PMTiles archive that pmtiles.js reads with HTTP Range requests. The Cache API
 * cannot answer Range requests, and reading one ~300 MB cached body into memory to slice it is what gets
 * a tab killed on iOS. So the archive is stored as 4 MiB parts (data/tiles/<tag>/pNNNNN.bin) and this
 * worker serves the virtual URL data/basemap.pmtiles by reading only the part(s) a range touches,
 * with a small LRU of parts in memory.
 *
 * Nothing here goes to the network if the file is cached. If it is not cached and the network is
 * down, the response is a 504 and every open page is told which file was missing.
 */
const VERSION = '__VERSION__';
const PREFIX = '__PREFIX__'; // cache namespace; lets two builds share an origin
const SHELL = `${PREFIX}-shell-${VERSION}`;
const DATA = `${PREFIX}-data`;
const SCOPE = new URL(self.registration.scope);
const LRU_PARTS = 6;

let manifestPromise = null;
const partCache = new Map(); // index -> Promise<ArrayBuffer>

function rel(url) {
  const u = new URL(url);
  return u.pathname.startsWith(SCOPE.pathname) ? u.pathname.slice(SCOPE.pathname.length) : null;
}
const abs = (p) => new URL(p, SCOPE).href;

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage(msg);
}

function getManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const r = await caches.open(SHELL).then((c) => c.match(abs('precache.json')));
      if (r) return r.json();
      const n = await fetch(abs('precache.json'), { cache: 'no-store' });
      if (!n.ok) throw new Error(`precache.json: HTTP ${n.status}`);
      return n.json();
    })().catch((e) => { manifestPromise = null; throw e; });
  }
  return manifestPromise;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const res = await fetch(abs('precache.json'), { cache: 'no-store' });
    if (!res.ok) throw new Error(`precache.json: HTTP ${res.status}`);
    const m = await res.clone().json();
    const cache = await caches.open(SHELL);
    await cache.put(abs('precache.json'), res);
    const shell = m.entries.filter((e) => e.group === 'shell');
    let done = 0;
    // a few at a time; Safari dislikes hundreds of parallel fetches in a worker
    const queue = [...shell];
    async function worker() {
      while (queue.length) {
        const e = queue.shift();
        const r = await fetch(abs(e.url), { cache: 'no-store' });
        if (!r.ok) throw new Error(`${e.url}: HTTP ${r.status}`);
        await cache.put(abs(e.url), r);
        done++;
        broadcast({ type: 'install-progress', done, total: shell.length });
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    await cache.put(abs('./'), (await cache.match(abs('index.html'))).clone());
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith(`${PREFIX}-shell-`) && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
    broadcast({ type: 'activated', version: VERSION });
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'skip-waiting') self.skipWaiting();
  if (d.type === 'version') event.source?.postMessage({ type: 'version', version: VERSION });
});

function missing(path, why) {
  broadcast({ type: 'miss', path, why });
  return new Response(`Not available offline: ${path}\n${why}`, {
    status: 504, headers: { 'Content-Type': 'text/plain', 'X-WS-Missing': '1' },
  });
}

async function fromCaches(path) {
  // try the URL as requested and with reserved characters percent-encoded (a build once stored
  // "light%402x.png" while MapLibre asks for "light@2x.png"; the Cache API compares raw strings)
  const variants = [...new Set([path, path.replace(/@/g, '%40'), path.replace(/%40/g, '@')])];
  const s = await caches.open(SHELL);
  const d = await caches.open(DATA);
  for (const v of variants) {
    const r = (await s.match(abs(v), { ignoreSearch: true })) || (await d.match(abs(v), { ignoreSearch: true }));
    if (r) return r;
  }
  return null;
}

async function cacheFirst(request, path) {
  const hit = await fromCaches(path);
  if (hit) return hit;
  const glyph = /^fonts\/.+\/\d+-\d+\.pbf$/.test(decodeURIComponent(path));
  try {
    const r = await fetch(request);
    broadcast({ type: 'net', path, status: r.status });
    if (r.ok || !glyph) return r;
  } catch (e) {
    if (!glyph) return missing(path, 'not in cache and the network is unreachable');
  }
  // A glyph range we cannot get (a script the fonts do not cover, or offline before the fonts were
  // downloaded): an empty PBF means "no glyphs here", so those labels are skipped instead of erroring.
  // Only after trying the network: answering empty first would blank every label while the fonts
  // are still downloading, and MapLibre keeps that answer for the rest of the session.
  broadcast({ type: 'miss', path, why: 'glyph range not cached; labels in it are skipped' });
  return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/x-protobuf' } });
}

// ------------------------------------------------------------- PMTiles range serving

async function getPart(m, i) {
  if (partCache.has(i)) {
    const p = partCache.get(i);
    partCache.delete(i); partCache.set(i, p); // LRU bump
    return p;
  }
  const url = `data/tiles/${m.basemap.tag}/p${String(i).padStart(5, '0')}.bin`;
  const p = (async () => {
    let r = await fromCaches(url);
    if (!r) {
      try {
        r = await fetch(abs(url), { cache: 'no-store' });
        broadcast({ type: 'net', path: url, status: r.status });
      } catch (e) {
        throw Object.assign(new Error('not cached and offline'), { path: url });
      }
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { path: url });
      // opportunistic: keep what we fetched
      const copy = r.clone();
      caches.open(DATA).then((c) => c.put(abs(url), copy)).catch(() => {});
    }
    return r.arrayBuffer();
  })();
  partCache.set(i, p);
  p.catch(() => partCache.delete(i));
  while (partCache.size > LRU_PARTS) partCache.delete(partCache.keys().next().value);
  return p;
}

async function rangeResponse(request) {
  let m;
  try { m = await getManifest(); } catch (e) { return missing('precache.json', String(e)); }
  if (!m.basemap) return missing('data/basemap.pmtiles', 'manifest has no basemap');
  const { size, chunkSize, tag } = m.basemap;
  const range = request.headers.get('range');
  const mm = range && /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!mm) {
    return new Response('Range header required', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const start = Number(mm[1]);
  const end = Math.min(size - 1, mm[2] === '' ? size - 1 : Number(mm[2]));
  if (start >= size || end < start) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const out = new Uint8Array(end - start + 1);
  try {
    for (let i = Math.floor(start / chunkSize); i <= Math.floor(end / chunkSize); i++) {
      const buf = new Uint8Array(await getPart(m, i));
      const p0 = i * chunkSize;
      const a = Math.max(start, p0) - p0;
      const b = Math.min(end, p0 + buf.length - 1) - p0;
      out.set(buf.subarray(a, b + 1), Math.max(start, p0) - start);
    }
  } catch (e) {
    return missing(e.path || 'data/basemap.pmtiles', e.message);
  }
  return new Response(out, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(out.length),
      'Accept-Ranges': 'bytes',
      'ETag': `"${tag}"`,
      'Cache-Control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const path = rel(req.url);
  if (path === null || new URL(req.url).origin !== SCOPE.origin) return; // never proxy other origins
  if (req.headers.get('x-ws-download')) return; // page-driven bulk download goes straight to the network
  if (path === 'data/basemap.pmtiles') { event.respondWith(rangeResponse(req)); return; }
  if (req.mode === 'navigate') {
    event.respondWith((async () => (await fromCaches('index.html')) || cacheFirst(req, 'index.html'))());
    return;
  }
  if (path === 'precache.json' && req.headers.get('x-ws-fresh')) return; // update check: network
  event.respondWith(cacheFirst(req, path || 'index.html'));
});
