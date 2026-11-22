// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, trackRelative, sunElevation, nightPolygon, subsolarPoint, bearingDeg } from '../web/js/geo.js';
import { lookList } from '../web/js/pois.js';
import { MotionEstimator } from '../web/js/gps.js';

test('haversine SEA-DOH ~11,900 km', () => {
  const d = haversineKm(47.449, -122.3093, 25.2731, 51.6081);
  assert.ok(d > 11800 && d < 12000, String(d));
});

test('trackRelative: east of a northbound track is right, ahead is positive', () => {
  const r = trackRelative(10.5, 0.5, 10, 0, 0);
  assert.ok(r.xt > 50 && r.xt < 60, `xt ${r.xt}`);
  assert.ok(r.at > 50 && r.at < 60, `at ${r.at}`);
  const l = trackRelative(9.5, -0.5, 10, 0, 0);
  assert.ok(l.xt < 0 && l.at < 0);
});

test('sun: June solstice noon at Tropic of Cancer is overhead', () => {
  const [lat] = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  assert.ok(Math.abs(lat - 23.44) < 0.2, String(lat));
  const e = sunElevation(23.44, -0.2, new Date('2026-06-21T12:00:00Z'));
  assert.ok(e > 88, String(e));
});

test('night polygon contains the antisolar point and not the subsolar point', () => {
  for (const iso of ['2026-12-05T20:00:00Z', '2026-06-21T03:00:00Z', '2026-03-20T12:00:00Z']) {
    const d = new Date(iso);
    const [slat, slon] = subsolarPoint(d);
    const ring = nightPolygon(d, 0).geometry.coordinates[0];
    const inside = (x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const alon = ((slon + 360) % 360) - 180;
    assert.ok(inside(alon, Math.max(-80, Math.min(80, -slat))), `antisolar inside ${iso}`);
    assert.ok(!inside(slon, slat), `subsolar outside ${iso}`);
  }
});

test('lookList: side, ordering, passed features dropped', () => {
  const pos = { lat: 50, lon: 10 };
  const pois = [
    { id: 'a', n: 'Right ahead', lat: 50.5, lon: 10.8, t: 'city', r: 5 },
    { id: 'b', n: 'Left ahead far', lat: 51.5, lon: 9.0, t: 'lake', r: 5 },
    { id: 'c', n: 'Behind', lat: 49.0, lon: 10.0, t: 'peak', r: 9 },
    { id: 'd', n: 'Too far off', lat: 50.5, lon: 14.0, t: 'peak', r: 9 },
  ];
  const out = lookList(pois, pos, 0, 900);
  assert.deepEqual(out.map((x) => x.poi.id), ['a', 'b']);
  assert.equal(out[0].side, 'R');
  assert.equal(out[1].side, 'L');
  assert.ok(out[0].eta > 2 && out[0].eta < 5, String(out[0].eta));
});

test('MotionEstimator derives heading/speed from fixes without device values', () => {
  const m = new MotionEstimator();
  let last;
  for (let i = 0; i < 10; i++) last = m.push({ lat: 50 + i * 0.0225, lon: 10, t: i * 10000, heading: null, speedKmh: null, source: 'gps' });
  assert.ok(Math.abs(last.heading - 0) < 1 || Math.abs(last.heading - 360) < 1, String(last.heading));
  assert.ok(last.speedKmh > 850 && last.speedKmh < 950, String(last.speedKmh));
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 1e-6);
});
