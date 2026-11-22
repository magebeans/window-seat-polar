// Offline cache management, page side.
//
// The service worker precaches the small app shell at install. The big files (basemap parts, POI
// chunks, fonts) are downloaded from here, right after the worker activates, because:
//   * iOS may kill a service worker during a long install event, and a failed install throws away
//     the worker and leaves nothing usable; a page-driven loop is resumable file by file;
//   * the page can hold a wake lock and show progress while it runs.
// Every file is checked against the sha256 in precache.json before it is stored.

import { PREFIX } from './prefix.js';

const DATA = `${PREFIX}-data`;
const shellName = (v) => `${PREFIX}-shell-${v}`;
const MB = 1e6;

export class OfflineCache {
  constructor(onChange) {
    this.onChange = onChange;
    this.manifest = null;
    this.state = { phase: 'checking', doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, errors: [], missing: [] };
    this.running = false;
    this.lastProgress = 0;
  }

  emit(patch) { Object.assign(this.state, patch); this.onChange?.(this.state); }

  async loadManifest() {
    // Prefer the copy the active worker installed with (matches the shell we are running).
    const r = await fetch('precache.json');
    if (!r.ok) throw new Error(`precache.json: HTTP ${r.status}`);
    this.manifest = await r.json();
    const total = this.manifest.entries.reduce((s, e) => s + e.size, 0);
    this.emit({ totalBytes: total, totalFiles: this.manifest.entries.length, version: this.manifest.version });
    return this.manifest;
  }

  async status() {
    if (!this.manifest) await this.loadManifest();
    const shell = await caches.open(shellName(this.manifest.version));
    const data = await caches.open(DATA);
    const have = new Set();
    for (const c of [shell, data]) for (const req of await c.keys()) have.add(new URL(req.url).pathname);
    const base = new URL('./', location.href).pathname;
    let doneBytes = 0, doneFiles = 0;
    const missing = [];
    for (const e of this.manifest.entries) {
      if (have.has(base + e.url)) { doneBytes += e.size; doneFiles++; } else missing.push(e);
    }
    const phase = missing.length === 0 ? 'ready' : 'incomplete';
    this.emit({ phase, doneBytes, doneFiles, missing: missing.map((e) => e.url) });
    return { missing, phase };
  }

  /**
   * Fetch every missing file. Returns a short human-readable outcome.
   * Safe to call repeatedly: a run that is still making progress is left alone; one that has stalled
   * (iOS freezes fetches when the app is backgrounded, and they may never settle) is abandoned and a
   * fresh run starts. Every file has its own timeout, so a run cannot hang forever.
   */
  async download({ concurrency = 3, force = false } = {}) {
    const stalled = this.running && Date.now() - this.lastProgress > 30000;
    if (this.running && !stalled && !force) {
      return `Already downloading: ${this.state.doneFiles} of ${this.state.totalFiles} files`;
    }
    if (this.running) this.abort?.abort(); // abandon the stalled run
    const token = {};
    this.runToken = token;
    const ctl = new AbortController();
    this.abort = ctl;
    this.running = true;
    this.lastProgress = Date.now();
    const live = () => this.runToken === token;
    try {
      if (!this.manifest || force) await this.loadManifest();
      const { missing } = await this.status();
      if (!missing.length) return `Nothing missing: all ${this.manifest.entries.length} files are cached ✓`;
      this.emit({ phase: 'downloading', errors: [] });
      const shell = await caches.open(shellName(this.manifest.version));
      const data = await caches.open(DATA);
      const queue = [...missing];
      const errors = [];
      const one = async (e) => {
        for (let attempt = 0; attempt < 3 && live(); attempt++) {
          const t = new AbortController();
          const kill = () => t.abort();
          ctl.signal.addEventListener('abort', kill);
          const timer = setTimeout(kill, 60000 + e.size / 50); // 60 s + 50 kB/s floor
          try {
            const r = await fetch(e.url, { cache: 'no-store', headers: { 'x-ws-download': '1' }, signal: t.signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = await r.arrayBuffer();
            if (buf.byteLength !== e.size) throw new Error(`size ${buf.byteLength} != ${e.size}`);
            const hash = await sha256hex(buf);
            if (hash !== e.sha256) throw new Error('sha256 mismatch');
            if (!live()) return;
            const type = r.headers.get('Content-Type') || 'application/octet-stream';
            const res = new Response(buf, { headers: { 'Content-Type': type, 'Content-Length': String(e.size), 'X-SHA256': hash } });
            await (e.group === 'shell' ? shell : data).put(new URL(e.url, location.href).href, res);
            this.lastProgress = Date.now();
            this.emit({ doneBytes: this.state.doneBytes + e.size, doneFiles: this.state.doneFiles + 1 });
            return;
          } catch (err) {
            if (!live()) return;
            const why = err.name === 'AbortError' ? 'timed out' : err.message;
            if (attempt === 2) { errors.push(`${decodeURIComponent(e.url)}: ${why}`); this.emit({ errors: [...errors] }); }
            else await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          } finally {
            clearTimeout(timer);
            ctl.signal.removeEventListener('abort', kill);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length && live()) await one(queue.shift()); }));
      if (!live()) return 'Restarted';
      const st = await this.status();
      if (st.phase === 'ready') { await this.prune(); return 'Download complete: ready for offline ✓'; }
      return `${st.missing.length} files still missing${errors.length ? ` (${errors.length} failed; see log)` : ''}. Tap again to retry.`;
    } catch (err) {
      if (live()) this.emit({ phase: 'error', errors: [...this.state.errors, String(err.message || err)] });
      return `Download failed: ${err.message || err}`;
    } finally {
      if (live()) this.running = false;
    }
  }

  /** Remove data-cache entries no longer in the manifest (old basemap builds etc.). */
  async prune() {
    const data = await caches.open(DATA);
    const keep = new Set(this.manifest.entries.map((e) => new URL(e.url, location.href).href));
    let n = 0;
    for (const req of await data.keys()) if (!keep.has(req.url)) { await data.delete(req); n++; }
    return n;
  }

  /** Full check: every entry present, right size, right hash header; deep = re-hash the bytes. */
  async verify({ deep = false, onProgress } = {}) {
    if (!this.manifest) await this.loadManifest();
    const shell = await caches.open(shellName(this.manifest.version));
    const data = await caches.open(DATA);
    const bad = [];
    let i = 0;
    for (const e of this.manifest.entries) {
      const url = new URL(e.url, location.href).href;
      const r = (await shell.match(url)) || (await data.match(url));
      if (!r) bad.push(`${e.url}: missing`);
      else if (deep) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength !== e.size) bad.push(`${e.url}: size ${buf.byteLength} != ${e.size}`);
        else if ((await sha256hex(buf)) !== e.sha256) bad.push(`${e.url}: hash mismatch`);
      } else {
        const h = r.headers.get('X-SHA256');
        if (h && h !== e.sha256) bad.push(`${e.url}: stale (hash differs)`);
      }
      if (++i % 25 === 0) onProgress?.(i, this.manifest.entries.length);
    }
    return bad;
  }
}

export async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function persistStorage() {
  const out = { persisted: null, quota: null, usage: null };
  if (navigator.storage?.persist) {
    try { out.persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { out.persisted = false; }
  }
  if (navigator.storage?.estimate) {
    try { const e = await navigator.storage.estimate(); out.quota = e.quota; out.usage = e.usage; } catch { /* ignore */ }
  }
  return out;
}

export const fmtMB = (b) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
