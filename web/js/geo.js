// Spherical geometry + sun. Mirrors pipeline/geo.py.
export const R_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(lat, lon, brg, km) {
  const d = km / R_KM, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

export function gcInterpolate(lat1, lon1, lat2, lon2, f) {
  const p1 = rad(lat1), l1 = rad(lon1), p2 = rad(lat2), l2 = rad(lon2);
  const d = haversineKm(lat1, lon1, lat2, lon2) / R_KM;
  if (d === 0) return [lat1, lon1];
  const a = Math.sin((1 - f) * d) / Math.sin(d), b = Math.sin(f * d) / Math.sin(d);
  const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
  const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
  const z = a * Math.sin(p1) + b * Math.sin(p2);
  return [deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))];
}

/** Position of P relative to a track through A on bearing brg.
 *  xt: signed cross-track km (+ = right of track), at: along-track km (+ = ahead). */
export function trackRelative(lat, lon, latA, lonA, brg) {
  const d13 = haversineKm(latA, lonA, lat, lon) / R_KM;
  const t13 = rad(bearingDeg(latA, lonA, lat, lon));
  const dxt = Math.asin(Math.sin(d13) * Math.sin(t13 - rad(brg)));
  const cosAt = Math.cos(d13) / Math.cos(dxt);
  let at = Math.acos(Math.max(-1, Math.min(1, cosAt)));
  if (Math.cos(t13 - rad(brg)) < 0) at = -at;
  return { xt: dxt * R_KM, at: at * R_KM, d: d13 * R_KM };
}

// ------------------------------------------------------------------ sun

export function subsolarPoint(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = rad((357.528 + 0.9856003 * n) % 360);
  const lam = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const eps = rad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const lon = ((deg(ra) - gmst + 540) % 360 + 360) % 360 - 180;
  return [deg(dec), lon];
}

export function sunElevation(lat, lon, date) {
  const [slat, slon] = subsolarPoint(date);
  return 90 - deg(haversineKm(lat, lon, slat, slon) / R_KM);
}

export const lightClass = (e) => (e > 0 ? 'day' : e > -6 ? 'twilight' : 'night');

/** Polygon of the area where the sun is below `h` degrees, as GeoJSON (lon/lat, clamped to Mercator). */
export function nightPolygon(date, h = 0) {
  const [dec, slon] = subsolarPoint(date).map(rad);
  const sinH = Math.sin(rad(h));
  const LIM = 85;
  // the dark pole is opposite the subsolar latitude; the polygon runs from the boundary to it
  const pole = dec > 0 ? -LIM : LIM;
  const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const pts = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const H = rad(lon) - slon;
    // sin(elev) = A sin(lat) + B cos(lat) = R sin(lat + alpha)
    const A = Math.sin(dec), B = Math.cos(dec) * Math.cos(H);
    const R = Math.hypot(A, B), alpha = Math.atan2(B, A);
    let lat;
    if (sinH >= R) lat = -pole;          // whole meridian below h
    else if (sinH <= -R) lat = pole;     // whole meridian above h
    else {
      const s = Math.asin(sinH / R);
      const c = [norm(s - alpha), norm(Math.PI - s - alpha)].filter((x) => Math.abs(x) <= Math.PI / 2 + 1e-9);
      // of the (usually one) valid crossing, take the one nearest the dark pole
      lat = c.length ? deg(pole < 0 ? Math.min(...c) : Math.max(...c)) : pole;
    }
    pts.push([lon, Math.max(-LIM, Math.min(LIM, lat))]);
  }
  const ring = [...pts, [180, pole], [-180, pole], pts[0]];
  return { type: 'Feature', properties: { h }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function compass(b) {
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(b / 22.5) % 16];
}
