// POI chunks (data/pois/*.json) and the "look left / look right" list.
import { haversineKm, trackRelative } from './geo.js';

export const TYPE_ICON = { city: '🏙️', peak: '⛰️', lake: '💧', river: '〰️', glacier: '🧊', island: '🏝️', coast: '🌊', region: '🗺️' };
export const TYPE_COLOR = { city: '#e8a33d', peak: '#8a5a44', lake: '#2f80c9', river: '#3aa0d8', glacier: '#7fd3e6', island: '#3fae6a', coast: '#1b6fa8', region: '#9a7fc8' };

export class PoiStore {
  constructor(onError) {
    this.index = null;
    this.loaded = new Map(); // url -> pois[]
    this.loading = new Map();
    this.onError = onError;
  }

  async init() {
    const r = await fetch('data/pois/index.json');
    if (!r.ok) throw new Error(`data/pois/index.json: HTTP ${r.status}`);
    this.index = await r.json();
  }

  /** Load chunks whose bbox lies within ~rangeKm of the position (and the ones along route km ±). */
  async ensureNear(lat, lon, km, rangeKm = 450) {
    if (!this.index) return;
    const want = this.index.chunks.filter((c) => {
      if (km != null && c.km1 >= km - rangeKm && c.km0 <= km + rangeKm * 1.5) return true;
      const [w, s, e, n] = c.bbox;
      const clat = Math.max(s, Math.min(n, lat)), clon = Math.max(w, Math.min(e, lon));
      return haversineKm(lat, lon, clat, clon) < rangeKm;
    });
    await Promise.all(want.map((c) => this.load(c.url)));
    return want.length;
  }

  load(url) {
    if (this.loaded.has(url)) return Promise.resolve(this.loaded.get(url));
    if (this.loading.has(url)) return this.loading.get(url);
    const p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}${r.headers.get('X-WS-Missing') ? ' (not cached)' : ''}`);
      const j = await r.json();
      this.loaded.set(url, j.pois);
      return j.pois;
    }).catch((e) => { this.onError?.(e); throw e; }).finally(() => this.loading.delete(url));
    this.loading.set(url, p);
    return p;
  }

  all() { return [...this.loaded.values()].flat(); }

  featureCollection(highlight = new Map()) {
    return {
      type: 'FeatureCollection',
      features: this.all().map((p) => ({
        type: 'Feature', id: undefined,
        properties: { id: p.id, name: p.n, type: p.t, r: p.r, hl: highlight.get(p.id) ?? 0 },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })),
    };
  }

  byId(id) { return this.all().find((p) => p.id === id); }
}

/**
 * Next notable features to look at.
 * pos: {lat, lon}, heading deg, speedKmh (may be null).
 * Returns up to n items sorted by along-track distance:
 *   { poi, side: 'L'|'R', xt (km, abeam distance), at (km ahead), d (km now), eta (min|null) }
 */
export function lookList(pois, pos, heading, speedKmh, { n = 10, radiusKm = 250, horizonMin = 75, passedKm = 15 } = {}) {
  const v = speedKmh && speedKmh > 150 ? speedKmh : null;
  const horizonKm = (v || 850) * (horizonMin / 60);
  const cand = [];
  for (const p of pois) {
    if (Math.abs(p.lat - pos.lat) > 15) continue;
    const r = trackRelative(p.lat, p.lon, pos.lat, pos.lon, heading);
    if (Math.abs(r.xt) > radiusKm || r.at < -passedKm || r.at > horizonKm) continue;
    const eta = v ? (r.at / v) * 60 : null;
    // importance, discounted the further ahead and the further off-track it is
    const score = p.r - 0.6 * Math.max(0, r.at) / horizonKm - 0.4 * Math.abs(r.xt) / radiusKm;
    cand.push({ poi: p, side: r.xt >= 0 ? 'R' : 'L', xt: Math.abs(r.xt), at: r.at, d: r.d, eta, score });
  }
  cand.sort((a, b) => b.score - a.score);
  return cand.slice(0, n).sort((a, b) => a.at - b.at);
}
