// Position sources: real GPS (watchPosition), simulated replay of the route, schedule estimate.
// All emit the same shape:
//   { lat, lon, acc (m), alt (m|null), heading (deg|null), speedKmh (number|null), t (ms), source }
import { haversineKm, bearingDeg, destination } from './geo.js';
import { PREFIX } from './prefix.js';

/** Derives heading and ground speed from successive fixes when the device does not report them. */
export class MotionEstimator {
  constructor() { this.hist = []; this.heading = null; this.speed = null; }
  reset() { this.hist = []; this.heading = null; this.speed = null; }

  push(fix) {
    const h = this.hist;
    h.push(fix);
    while (h.length > 2 && fix.t - h[0].t > 180000) h.shift(); // keep 3 minutes
    // the oldest fix at least 1.5 km away (and 15 s ago) gives a stable bearing at airliner speeds
    let ref = null;
    for (let i = h.length - 2; i >= 0; i--) {
      if (fix.t - h[i].t >= 15000 && haversineKm(h[i].lat, h[i].lon, fix.lat, fix.lon) >= 1.5) { ref = h[i]; break; }
    }
    let heading = fix.heading, speed = fix.speedKmh;
    if (ref) {
      const d = haversineKm(ref.lat, ref.lon, fix.lat, fix.lon);
      const v = d / ((fix.t - ref.t) / 3600000);
      if (speed == null || !Number.isFinite(speed)) speed = v;
      if (heading == null || !Number.isFinite(heading)) heading = bearingDeg(ref.lat, ref.lon, fix.lat, fix.lon);
    }
    if (heading != null && Number.isFinite(heading)) {
      if (this.heading == null) this.heading = heading;
      else {
        const diff = ((heading - this.heading + 540) % 360) - 180; // shortest way round
        this.heading = (this.heading + 0.5 * diff + 360) % 360;
      }
    }
    if (speed != null && Number.isFinite(speed)) this.speed = this.speed == null ? speed : 0.6 * this.speed + 0.4 * speed;
    return { ...fix, heading: this.heading, speedKmh: this.speed };
  }
}

export class GpsSource {
  constructor(onFix, onError) {
    this.onFix = onFix; this.onError = onError; this.id = null;
  }
  start() {
    if (!('geolocation' in navigator)) { this.onError({ code: 0, message: 'Geolocation API not available' }); return; }
    this.id = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        this.onFix({
          lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude,
          heading: Number.isFinite(c.heading) && c.speed > 5 ? c.heading : null,
          speedKmh: Number.isFinite(c.speed) && c.speed >= 0 ? c.speed * 3.6 : null,
          t: p.timestamp || Date.now(), source: 'gps',
        });
      },
      (e) => this.onError(e),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 120000 },
    );
  }
  stop() { if (this.id != null) navigator.geolocation.clearWatch(this.id); this.id = null; }
}

/** Replays the planned route as fake GPS. Owns a simulated clock so day/night and ETAs line up. */
export class SimSource {
  constructor(route, onFix, clock) {
    this.route = route; this.onFix = onFix; this.clock = clock;
    this.timer = null; this.speedup = 60;
  }
  start(atMinutes = this.route.tStart + 5) {
    this.clock.sim(new Date(this.route.departure.getTime() + atMinutes * 60000), this.speedup);
    this.stop(false);
    const tick = () => {
      const now = this.clock.now();
      const t = (now - this.route.departure) / 60000;
      const s = this.route.atMinutes(t);
      // realistic noise: ~10 m jitter, accuracy 5-30 m, no device heading half the time
      const [lat, lon] = destination(s.lat, s.lon, Math.random() * 360, Math.random() * 0.01);
      this.onFix({
        lat, lon, acc: 5 + Math.random() * 25, alt: t < this.route.tStart + 25 ? 4000 : 11000,
        heading: Math.random() < 0.5 ? s.heading : null, speedKmh: Math.random() < 0.5 ? s.speedKmh : null,
        t: now.getTime(), source: 'sim',
      });
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }
  setSpeed(x) { this.speedup = x; if (this.timer) this.clock.sim(this.clock.now(), x); }
  stop(resetClock = true) { clearInterval(this.timer); this.timer = null; if (resetClock) this.clock.real(); }
  get running() { return this.timer != null; }
}

/** Real time, or simulated time running at `speedup`× from an anchor. */
export class Clock {
  constructor() { this.anchor = null; }
  sim(date, speedup) { this.anchor = { sim: date.getTime(), real: Date.now(), speedup }; }
  real() { this.anchor = null; }
  get simulated() { return this.anchor != null; }
  now() {
    if (!this.anchor) return new Date();
    return new Date(this.anchor.sim + (Date.now() - this.anchor.real) * this.anchor.speedup);
  }
}

/**
 * Manual position: you set where along the route the plane is (slider), and it then advances on the
 * schedule at real speed, or stays put while paused. State survives reloads (localStorage), so a
 * relaunch mid-flight continues from where you left it, plus the time that has passed.
 */
export class ManualSource {
  static KEY = `${PREFIX}-manual`;
  constructor(route, onFix, clock) {
    this.route = route; this.onFix = onFix; this.clock = clock;
    this.timer = null; this.paused = false;
  }
  /** Minutes after departure the schedule says it is now. */
  scheduleT() { return (Date.now() - this.route.departure) / 60000; }
  /** Restore the last saved position, advanced by elapsed time unless it was paused. */
  restoredT() {
    try {
      const s = JSON.parse(localStorage.getItem(ManualSource.KEY));
      if (s && s.departure === this.route.departure.toISOString()) {
        this.paused = !!s.paused;
        return s.t + (s.paused ? 0 : (Date.now() - s.at) / 60000);
      }
    } catch { /* ignore */ }
    return null;
  }
  start(t = this.restoredT() ?? this.scheduleT()) {
    this.clock.sim(new Date(this.route.departure.getTime() + t * 60000), this.paused ? 0 : 1);
    clearInterval(this.timer);
    this.tick();
    this.timer = setInterval(() => this.tick(), 2000);
    this.save();
  }
  get t() { return (this.clock.now() - this.route.departure) / 60000; }
  tick() {
    const t = this.t;
    const s = this.route.atMinutes(t);
    const airborne = t > this.route.tStart && t < this.route.tEnd;
    this.onFix({
      lat: s.lat, lon: s.lon, acc: null, alt: airborne ? 11000 : 0,
      heading: s.heading, speedKmh: airborne ? s.speedKmh : 0, t: this.clock.now().getTime(), source: 'manual',
    });
  }
  setPaused(p) { this.paused = p; this.start(this.t); }
  save() {
    localStorage.setItem(ManualSource.KEY, JSON.stringify({ t: this.t, at: Date.now(), paused: this.paused, departure: this.route.departure.toISOString() }));
  }
  stop() { if (this.timer) this.save(); clearInterval(this.timer); this.timer = null; this.clock.real(); }
  get running() { return this.timer != null; }
}
