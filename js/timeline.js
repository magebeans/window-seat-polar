// Daylight strip for the whole flight: colour = sun elevation at the plane's scheduled position.
import { sunElevation } from './geo.js';

const COLORS = [
  [-90, [22, 28, 52]], [-12, [30, 38, 74]], [-6, [70, 62, 120]], [-2, [190, 110, 120]],
  [0, [240, 170, 90]], [6, [250, 214, 120]], [90, [252, 232, 160]],
];
function colorFor(e) {
  for (let i = 1; i < COLORS.length; i++) {
    if (e <= COLORS[i][0]) {
      const [e0, c0] = COLORS[i - 1], [e1, c1] = COLORS[i];
      const f = (e - e0) / (e1 - e0);
      return `rgb(${c0.map((c, k) => Math.round(c + f * (c1[k] - c))).join(',')})`;
    }
  }
  return 'rgb(252,232,160)';
}

export class Timeline {
  constructor(canvas, label, onSeek) {
    this.canvas = canvas; this.label = label; this.onSeek = onSeek;
    this.route = null; this.samples = null; this.current = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('click', (ev) => {
      if (!this.route || !this.onSeek) return;
      const r = canvas.getBoundingClientRect();
      const f = (ev.clientX - r.left) / r.width;
      this.onSeek(this.route.tStart + f * (this.route.tEnd - this.route.tStart));
    });
  }

  setRoute(route) {
    this.route = route;
    const n = 400;
    this.samples = Array.from({ length: n }, (_, i) => {
      const t = route.tStart + (i / (n - 1)) * (route.tEnd - route.tStart);
      const s = route.atMinutes(t);
      return { t, e: sunElevation(s.lat, s.lon, new Date(route.departure.getTime() + t * 60000)) };
    });
    this.draw();
  }

  setCurrent(t) { this.current = t; this.draw(); this.describe(); }

  draw() {
    const c = this.canvas, r = this.route;
    if (!r || !this.samples) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const n = this.samples.length;
    for (let i = 0; i < n; i++) {
      g.fillStyle = colorFor(this.samples[i].e);
      g.fillRect((i / n) * w, 0, w / n + 1, h);
    }
    // hour ticks (elapsed since departure) and local clock at both ends
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = '10px -apple-system, system-ui, sans-serif';
    g.textBaseline = 'bottom';
    const span = r.tEnd - r.tStart;
    for (let hr = 2; hr * 60 < r.tEnd; hr += 2) {
      const x = ((hr * 60 - r.tStart) / span) * w;
      g.fillRect(x, h - 5, 1, 5);
      g.fillText(`${hr}h`, x + 2, h - 1);
    }
    if (this.current != null) {
      const x = Math.max(0, Math.min(w, ((this.current - r.tStart) / span) * w));
      g.fillStyle = '#ff3b30';
      g.fillRect(x - 1, 0, 3, h);
      g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 6, 0); g.lineTo(x + 0.5, 6); g.fill();
    }
  }

  describe() {
    if (!this.label || !this.samples || this.current == null) return;
    const s = this.samples;
    const cur = s.find((x) => x.t >= this.current) || s.at(-1);
    const isDay = cur.e > -2;
    const next = s.find((x) => x.t > this.current && (x.e > -2) !== isDay);
    const fmt = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m` : `${Math.round(m)} min`);
    if (this.current < this.route.tStart) this.label.textContent = 'Before take-off';
    else if (this.current > this.route.tEnd) this.label.textContent = 'Landed';
    else if (next) this.label.textContent = isDay ? `Daylight for ${fmt(next.t - this.current)}` : `Next daylight in ${fmt(next.t - this.current)}`;
    else this.label.textContent = isDay ? 'Daylight to landing' : 'Dark to landing';
  }
}
