// Route model: the planned line with scheduled minutes at each station, plus helpers.
// The built-in route comes from data/route.json (pipeline/route.py). A track file imported on the
// phone (KML / GPX / CSV / GeoJSON) replaces it without any rebuild; it is kept in localStorage.
import { haversineKm, bearingDeg, gcInterpolate, destination } from './geo.js';

import { PREFIX } from './prefix.js';
const LS_KEY = `${PREFIX}-route-override`;

export class Route {
  constructor(json) {
    this.json = json;
    this.points = json.points; // [lat, lon, minutesAfterDeparture]
    this.departure = new Date(json.departure);
    this.wheelsUp = new Date(json.wheelsUp);
    this.landing = new Date(json.landing);
    this.cum = [0];
    for (let i = 1; i < this.points.length; i++) {
      const [a, b] = this.points[i - 1], [c, d] = this.points[i];
      this.cum.push(this.cum[i - 1] + haversineKm(a, b, c, d));
    }
    this.totalKm = this.cum[this.cum.length - 1];
    this.countries = json.countries || [];
  }

  get tStart() { return this.points[0][2]; }
  get tEnd() { return this.points[this.points.length - 1][2]; }

  /** Interpolated state at t minutes after scheduled departure. */
  atMinutes(t) {
    const P = this.points;
    if (t <= P[0][2]) return this._state(0, 0);
    if (t >= P[P.length - 1][2]) return this._state(P.length - 2, 1);
    let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m][2] <= t) lo = m; else hi = m; }
    const f = (t - P[lo][2]) / ((P[hi][2] - P[lo][2]) || 1);
    return this._state(lo, f);
  }

  _state(i, f) {
    const [a, b, ta] = this.points[i], [c, d, tb] = this.points[i + 1];
    const [lat, lon] = gcInterpolate(a, b, c, d, f);
    const segKm = this.cum[i + 1] - this.cum[i];
    // ground speed over ~±50 km of track: per-segment timestamps from a real track are jittery
    const a0 = Math.max(0, i - 5), b0 = Math.min(this.points.length - 1, i + 6);
    const speed = (this.cum[b0] - this.cum[a0]) / (((this.points[b0][2] - this.points[a0][2]) || 1) / 60);
    return { lat, lon, heading: bearingDeg(a, b, c, d), speedKmh: speed, km: this.cum[i] + f * segKm, t: ta + f * (tb - ta) };
  }

  atDate(date) { return this.atMinutes((date - this.departure) / 60000); }

  /** Nearest station to a position: { km, t, offKm }. Coarse scan then refine. */
  nearest(lat, lon) {
    const P = this.points;
    let best = 0, bd = Infinity;
    for (let i = 0; i < P.length; i += 5) {
      const d = haversineKm(lat, lon, P[i][0], P[i][1]);
      if (d < bd) { bd = d; best = i; }
    }
    for (let i = Math.max(0, best - 5); i < Math.min(P.length, best + 6); i++) {
      const d = haversineKm(lat, lon, P[i][0], P[i][1]);
      if (d < bd) { bd = d; best = i; }
    }
    return { km: this.cum[best], t: P[best][2], offKm: bd, index: best };
  }

  minutesAtKm(km) {
    let i = this.cum.findIndex((c) => c >= km);
    if (i <= 0) return this.points[0][2];
    const f = (km - this.cum[i - 1]) / ((this.cum[i] - this.cum[i - 1]) || 1);
    return this.points[i - 1][2] + f * (this.points[i][2] - this.points[i - 1][2]);
  }

  countryAtKm(km) {
    let name = null;
    for (const [k, n] of this.countries) { if (k <= km) name = n; else break; }
    return name;
  }

  lineGeoJSON() {
    // split where consecutive points jump across the antimeridian
    const lines = [[]];
    for (let i = 0; i < this.points.length; i++) {
      const [lat, lon] = this.points[i];
      const prev = lines[lines.length - 1].at(-1);
      if (prev && Math.abs(prev[0] - lon) > 180) lines.push([]);
      lines[lines.length - 1].push([lon, lat]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } };
  }

  corridorGeoJSON() {
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [this.json.corridor] } };
  }
}

export async function loadRoute() {
  const res = await fetch('data/route.json');
  if (!res.ok) throw new Error(`data/route.json: HTTP ${res.status}`);
  const base = await res.json();
  const ov = localStorage.getItem(LS_KEY);
  if (ov) {
    try { return { route: new Route(JSON.parse(ov)), base, overridden: true }; } catch { localStorage.removeItem(LS_KEY); }
  }
  return { route: new Route(base), base, overridden: false };
}

export function clearOverride() { localStorage.removeItem(LS_KEY); }

// --------------------------------------------------------------- track import

const ts = (s) => {
  if (s == null || s === '') return null;
  s = String(s).trim();
  if (/^\d{9,11}(\.\d+)?$/.test(s)) return Number(s) * 1000;
  if (/^\d{12,14}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

export function parseTrack(text, name) {
  const ext = name.toLowerCase().split('.').pop();
  let pts = [];
  if (ext === 'kml') {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const coords = [...doc.getElementsByTagName('gx:coord')];
    const whens = [...doc.getElementsByTagName('when')];
    if (coords.length >= 10) {
      pts = coords.map((c, i) => { const [lon, lat] = c.textContent.trim().split(/\s+/).map(Number); return [lat, lon, whens.length === coords.length ? ts(whens[i].textContent) : null]; });
    } else {
      for (const pm of doc.getElementsByTagName('Placemark')) {
        const pt = pm.getElementsByTagName('Point')[0];
        if (!pt) continue;
        const [lon, lat] = pt.getElementsByTagName('coordinates')[0].textContent.trim().split(',').map(Number);
        const w = pm.getElementsByTagName('when')[0];
        pts.push([lat, lon, w ? ts(w.textContent) : null]);
      }
      if (pts.length < 10) {
        let best = [];
        for (const ls of doc.getElementsByTagName('LineString')) {
          const cs = ls.getElementsByTagName('coordinates')[0].textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number));
          if (cs.length > best.length) best = cs;
        }
        pts = best.map(([lon, lat]) => [lat, lon, null]);
      }
    }
  } else if (ext === 'gpx') {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    pts = [...doc.getElementsByTagName('trkpt')].map((p) => [Number(p.getAttribute('lat')), Number(p.getAttribute('lon')), ts(p.getElementsByTagName('time')[0]?.textContent)]);
  } else if (ext === 'csv') {
    const lines = text.trim().split(/\r?\n/);
    const split = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, -1).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    const head = split(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (...n) => head.findIndex((h) => n.includes(h));
    const iPos = col('position'), iLat = col('lat', 'latitude'), iLon = col('lon', 'lng', 'longitude');
    const iT = col('timestamp', 'time', 'utc', 'when');
    for (const l of lines.slice(1)) {
      const c = split(l);
      let lat, lon;
      if (iPos >= 0) [lat, lon] = c[iPos].split(',').map(Number); else { lat = Number(c[iLat]); lon = Number(c[iLon]); }
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon, iT >= 0 ? ts(c[iT]) : null]);
    }
  } else {
    const data = JSON.parse(text);
    const feats = data.type === 'FeatureCollection' ? data.features : [data];
    for (const f of feats) {
      const g = f.geometry || f, p = f.properties || {};
      if (g.type === 'LineString') { const times = p.times || p.coordTimes || []; g.coordinates.forEach((c, i) => pts.push([c[1], c[0], ts(times[i])])); }
      else if (g.type === 'MultiLineString') g.coordinates.flat().forEach((c) => pts.push([c[1], c[0], null]));
      else if (g.type === 'Point') pts.push([g.coordinates[1], g.coordinates[0], ts(p.time || p.timestamp)]);
    }
  }
  return pts.filter((p, i) => i === 0 || haversineKm(p[0], p[1], pts[i - 1][0], pts[i - 1][1]) > 0.5);
}

/** Build a route.json-shaped object from raw fixes, keeping the built-in schedule. */
export function routeFromTrack(fixes, base, label) {
  const o = base.origin, d = base.destination;
  if (haversineKm(fixes[0][0], fixes[0][1], o.lat, o.lon) > 5) fixes.unshift([o.lat, o.lon, null]);
  if (haversineKm(fixes.at(-1)[0], fixes.at(-1)[1], d.lat, d.lon) > 5) fixes.push([d.lat, d.lon, null]);
  const cum = [0];
  for (let i = 1; i < fixes.length; i++) cum.push(cum[i - 1] + haversineKm(fixes[i - 1][0], fixes[i - 1][1], fixes[i][0], fixes[i][1]));
  const total = cum.at(-1);
  const n = Math.max(2, Math.round(total / 10) + 1);
  const at = (km) => {
    let i = cum.findIndex((c) => c >= km); if (i <= 0) i = 1;
    const f = (km - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    const [lat, lon] = gcInterpolate(fixes[i - 1][0], fixes[i - 1][1], fixes[i][0], fixes[i][1], Math.min(1, Math.max(0, f)));
    const t0 = fixes[i - 1][2], t1 = fixes[i][2];
    return [lat, lon, t0 != null && t1 != null ? t0 + f * (t1 - t0) : null];
  };
  const st = Array.from({ length: n }, (_, i) => at((total * i) / (n - 1)));
  // time profile: real timestamps if most fixes have them, else the built-in route's profile by fraction of distance
  const wheels = (new Date(base.wheelsUp) - new Date(base.departure)) / 60000;
  const air = (new Date(base.landing) - new Date(base.wheelsUp)) / 60000;
  const timed = st.filter((p) => p[2] != null).length > n * 0.8;
  const baseRoute = new Route(base);
  let tmin;
  if (timed) {
    const valid = st.filter((p) => p[2] != null);
    const t0 = valid[0][2], t1 = valid.at(-1)[2];
    let last = 0;
    tmin = st.map((p) => { const f = p[2] != null ? (p[2] - t0) / (t1 - t0) : last; last = f; return wheels + f * air; });
  } else {
    tmin = st.map((_, i) => baseRoute.minutesAtKm((baseRoute.totalKm * i) / (n - 1)));
  }
  const half = 150;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const j = Math.min(i, n - 2);
    const b = bearingDeg(st[j][0], st[j][1], st[j + 1][0], st[j + 1][1]);
    L.push(destination(st[i][0], st[i][1], b - 90, half));
    R.push(destination(st[i][0], st[i][1], b + 90, half));
  }
  const corridor = [...L.map(([a, b]) => [b, a]), ...R.reverse().map(([a, b]) => [b, a])];
  corridor.push(corridor[0]);
  const json = {
    ...base,
    source: `imported: ${label}`,
    timeProfile: timed ? 'from track timestamps' : 'built-in profile',
    totalKm: Math.round(total),
    points: st.map((p, i) => [+p[0].toFixed(4), +p[1].toFixed(4), +tmin[i].toFixed(1)]),
    corridor,
    countries: [],
  };
  localStorage.setItem(LS_KEY, JSON.stringify(json));
  return new Route(json);
}
