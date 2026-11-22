import * as maplibregl from '../vendor/maplibre-gl.mjs';
import { Protocol } from '../vendor/pmtiles.mjs';
import { buildStyle, planeImage } from './style.js';
import { loadRoute, parseTrack, routeFromTrack, clearOverride } from './route.js';
import { PoiStore, lookList, TYPE_ICON } from './pois.js';
import { GpsSource, SimSource, ManualSource, Clock, MotionEstimator } from './gps.js';
import { OfflineCache, persistStorage, fmtMB } from './cache.js';
import { Timeline } from './timeline.js';
import { KeepAwake } from './wakelock.js';
import { nightPolygon, sunElevation, compass } from './geo.js';
import { PREFIX } from './prefix.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const prefs = JSON.parse(localStorage.getItem(`${PREFIX}-prefs`) || '{}');
const savePrefs = () => localStorage.setItem(`${PREFIX}-prefs`, JSON.stringify(prefs));

const S = {
  route: null, baseRoute: null, overridden: false,
  fix: null,            // last position (any source)
  lastGpsAt: null,      // ms (real time) of last real GPS fix
  gpsWaitSince: null,
  gpsError: null,
  source: 'manual',
  follow: true, trackUp: !!prefs.trackUp,
  look: [], highlight: new Map(),
  netCount: 0, misses: new Set(),
  flavor: null,
};
const clock = new Clock();
const motion = new MotionEstimator();
const pois = new PoiStore((e) => showError(`POI data: ${e.message}`));
let map, timeline, gps, sim, manual, cache, awake;

// ---------------------------------------------------------------- errors: always visible

const errors = new Map();
function showError(msg, key = msg) {
  errors.set(key, msg);
  const b = $('banner');
  b.textContent = [...errors.values()].slice(-4).join('\n');
  b.hidden = false;
}
function clearError(key) {
  errors.delete(key);
  if (!errors.size) $('banner').hidden = true; else $('banner').textContent = [...errors.values()].join('\n');
}
$('banner').addEventListener('click', () => { errors.clear(); $('banner').hidden = true; });
window.addEventListener('error', (e) => showError(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showError(`Error: ${e.reason?.message || e.reason}`));

// ---------------------------------------------------------------- service worker

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) { showError('This browser has no service workers: offline mode is impossible here.'); return false; }
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const d = ev.data || {};
    if (d.type === 'miss') {
      if (!S.misses.has(d.path)) { S.misses.add(d.path); log(`MISSING ${decodeURIComponent(d.path)}: ${d.why}`); }
      showError(`Not cached, offline: ${decodeURIComponent(d.path)}\nOpen ⚙︎ and run “Download missing” while online.`, 'miss');
    } else if (d.type === 'net') {
      S.netCount++; $('net-count').textContent = `${S.netCount} (last: ${decodeURIComponent(d.path)})`;
    } else if (d.type === 'install-progress') {
      $('sw-state').textContent = `installing shell ${d.done}/${d.total}`;
    }
  });
  const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) $('btn-update').hidden = false;
    });
  });
  if (reg.waiting && navigator.serviceWorker.controller) $('btn-update').hidden = false;
  $('btn-update').onclick = () => {
    (reg.waiting || reg.installing)?.postMessage({ type: 'skip-waiting' });
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  };
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    // first visit: the worker claims this page on activate; wait for it rather than reloading
    await new Promise((res) => {
      const t = setTimeout(res, 4000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res(); }, { once: true });
    });
  }
  if (!navigator.serviceWorker.controller) { location.reload(); return false; }
  $('sw-state').textContent = 'active';
  if (navigator.onLine) reg.update().catch(() => {});
  return true;
}

// ---------------------------------------------------------------- cache UI

// rolling download rate: bytes landed in the cache over the last ~10 s (files arrive 4 MB at a time,
// so an instantaneous figure would jump between 0 and huge)
const rate = { samples: [] };
function speedText(st) {
  const now = Date.now(), s = rate.samples;
  s.push([now, st.doneBytes]);
  while (s.length > 2 && now - s[0][0] > 10000) s.shift();
  if (s.length < 2 || now - s[0][0] < 2000) return ' · measuring speed…';
  const bps = (s.at(-1)[1] - s[0][1]) / ((now - s[0][0]) / 1000);
  if (bps <= 0) return ' · stalled? (tap Download missing to restart)';
  const left = (st.totalBytes - st.doneBytes) / bps;
  const eta = left < 90 ? `${Math.round(left)} s` : left < 5400 ? `${Math.round(left / 60)} min` : `${(left / 3600).toFixed(1)} h`;
  return ` · ${(bps / 1e6).toFixed(1)} MB/s · ~${eta} left`;
}

function renderCache(st) {
  const line = $('cache-line'), dot = $('cache-dot');
  $('cache-progress').value = st.totalBytes ? st.doneBytes / st.totalBytes : 0;
  $('version').textContent = st.version || '—';
  const mb = `${fmtMB(st.doneBytes)} of ${fmtMB(st.totalBytes)} cached`;
  line.className = 'big';
  if (st.phase !== 'downloading') rate.samples = [];
  if (st.phase === 'ready') {
    line.textContent = `${mb}, ready for offline ✓`; line.classList.add('ready'); dot.className = 'badge ok';
  } else if (st.phase === 'downloading') {
    line.textContent = `${mb} (${st.doneFiles}/${st.totalFiles} files)${speedText(st)}`; dot.className = 'badge busy';
  } else if (st.phase === 'checking') {
    line.textContent = 'Checking cache…'; dot.className = 'badge busy';
  } else {
    line.textContent = `${mb}: NOT ready for offline (${st.missing.length} files missing)`; line.classList.add('bad'); dot.className = 'badge';
  }
  $('start-cache').textContent = line.textContent;
  const errKey = (st.errors || []).join('|');
  if (errKey && errKey !== rate.lastErr) log(st.errors.slice(-5).join('\n'));
  rate.lastErr = errKey;
}
const logLines = [];
function log(msg) { logLines.push(msg); $('cache-log').textContent = logLines.slice(-30).join('\n'); }

async function refreshStorage() {
  const p = await persistStorage();
  $('persist').textContent = p.persisted == null ? 'API not available' : p.persisted ? 'granted ✓ (won’t be evicted)' : 'not granted (may be evicted under pressure)';
  if (p.quota) $('quota').textContent = `${fmtMB(p.usage)} / ${fmtMB(p.quota)}`;
}

// ---------------------------------------------------------------- map

function overlayData() {
  return {
    night: nightFC(clock.now()),
    route: S.route.lineGeoJSON(),
    corridor: S.route.corridorGeoJSON(),
    pois: pois.featureCollection(S.highlight),
    plane: planeFC(),
  };
}
const nightFC = (d) => ({ type: 'FeatureCollection', features: [nightPolygon(d, 0), nightPolygon(d, -6)] });
function planeFC() {
  const f = S.fix;
  if (!f) return { type: 'FeatureCollection', features: [] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { heading: f.heading ?? 0, estimated: f.source === 'estimate' }, geometry: { type: 'Point', coordinates: [f.lon, Math.max(-85, Math.min(85, f.lat))] } }] };
}

function chooseFlavor() {
  const pref = prefs.flavor || 'auto';
  if (pref !== 'auto') return pref;
  const f = S.fix || S.route.atDate(clock.now());
  return sunElevation(f.lat, f.lon, clock.now()) > -4 ? 'light' : 'dark';
}

function applyStyle() {
  S.flavor = chooseFlavor();
  map.setStyle(buildStyle({ flavor: S.flavor, projection: prefs.proj || 'globe', overlays: overlayData() }));
}

function initMap() {
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  const start = S.route.points[0];
  S.flavor = chooseFlavor();
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle({ flavor: S.flavor, projection: prefs.proj || 'globe', overlays: overlayData() }),
    center: [start[1], start[0]], zoom: 6.5, maxZoom: 15, minZoom: 1,
    attributionControl: { compact: true },
    pitchWithRotate: false,
    fadeDuration: 0,
  });
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  // iOS home-screen apps do not always report size changes (rotation, status bar), leaving the
  // canvas at the old size with dark bands around it. Re-measure on every hint, twice.
  const refit = () => { map.resize(); setTimeout(() => map.resize(), 350); };
  for (const ev of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(ev, refit);
  window.visualViewport?.addEventListener('resize', refit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refit(); });
  new ResizeObserver(refit).observe(document.documentElement);
  map.on('styleimagemissing', (e) => { if (e.id === 'ws-plane' && !map.hasImage('ws-plane')) map.addImage('ws-plane', planeImage().data, { pixelRatio: 2 }); });
  map.on('error', (e) => {
    const m = e.error?.message || String(e.error || 'map error');
    if (/AbortError|aborted/i.test(m)) return;
    showError(`Map: ${m}`, `map:${m.slice(0, 60)}`);
  });
  map.on('click', () => { $('settings').hidden = true; });
  const stopFollow = () => { if (S.follow) { S.follow = false; $('btn-follow').classList.remove('on'); } };
  map.on('dragstart', stopFollow);
  map.on('click', 'ws-pois', (e) => { const id = e.features[0]?.properties.id; if (id) openInfo(id); });
  map.on('mouseenter', 'ws-pois', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'ws-pois', () => { map.getCanvas().style.cursor = ''; });
}

function setSource(id, data) { map?.getSource(`ws-${id}`)?.setData(data); }

// ---------------------------------------------------------------- positions

function onFix(raw) {
  if (raw.source === 'gps') {
    S.lastGpsAt = Date.now(); S.gpsError = null; clearError('gps');
    if (S.source !== 'gps') return; // simulating: ignore the real GPS
  }
  S.fix = raw.source === 'estimate' || raw.source === 'manual' ? raw : motion.push(raw);
  if (raw.source === 'manual') syncSlider();
  update();
}

function onGpsError(e) {
  S.gpsError = e;
  const msg = {
    1: 'Location permission denied. iPhone: Settings → Privacy & Security → Location Services → Safari Websites → “While Using the App”, Precise on. Then reopen the app.',
    2: 'Position unavailable. Move to the window, and give the GPS a few minutes (it gets no assistance data in airplane mode).',
    3: 'Still no GPS fix: keep waiting near the window.',
  }[e.code] || `GPS error: ${e.message}`;
  if (e.code === 1) showError(msg, 'gps'); else log(msg);
  renderGpsChip();
}

function estimateTick() {
  // with no fix (or a stale one) fall back to the schedule, clearly labelled
  if (S.source !== 'gps' || !$('opt-estimate').checked) return;
  const stale = !S.lastGpsAt || Date.now() - S.lastGpsAt > 90000;
  if (!stale) return;
  const now = clock.now();
  if (now < S.route.wheelsUp || now > S.route.landing) { renderGpsChip(); return; }
  const s = S.route.atDate(now);
  onFix({ lat: s.lat, lon: s.lon, acc: null, alt: null, heading: s.heading, speedKmh: s.speedKmh, t: now.getTime(), source: 'estimate' });
}

let lastLook = 0, lastFlavorCheck = 0;
function update() {
  const f = S.fix;
  renderGpsChip();
  if (!f) return;
  $('speed').textContent = f.speedKmh != null ? `${Math.round(f.speedKmh)} km/h` : '— km/h';
  $('heading').textContent = f.heading != null ? `${Math.round(f.heading)}° ${compass(f.heading)}` : '—°';
  $('alt').textContent = f.alt != null ? `${Math.round(f.alt * 3.28084).toLocaleString()} ft` : '—';
  const near = S.route.nearest(f.lat, f.lon);
  const country = S.route.countryAtKm(near.km);
  $('over').textContent = near.offKm > 400 ? `${Math.round(near.offKm)} km off the planned route` : country ? `Over ${country}` : '';

  setSource('plane', planeFC());
  if (map && S.follow) {
    // keep the plane in the middle of the part of the map not covered by the bottom panel
    const opts = { center: [f.lon, Math.max(-85, Math.min(85, f.lat))], duration: 600, padding: { top: 90, bottom: $('bottom').offsetHeight, left: 0, right: 0 } };
    if (S.trackUp && f.heading != null) opts.bearing = f.heading;
    map.easeTo(opts);
  }
  const now = Date.now();
  const tNow = (clock.now() - S.route.departure) / 60000;
  // progress along the route for real/simulated fixes; scheduled time for the estimate
  timeline.setCurrent(f.source === 'estimate' || near.offKm > 400 ? tNow : near.t);

  if (now - lastLook > (clock.simulated ? 700 : 2000)) {
    lastLook = now;
    refreshLook(f, near);
  }
  if (now - lastFlavorCheck > (clock.simulated ? 3000 : 30000)) {
    lastFlavorCheck = now;
    setSource('night', nightFC(clock.now()));
    if ((prefs.flavor || 'auto') === 'auto' && chooseFlavor() !== S.flavor) applyStyle();
  }
}

async function refreshLook(f, near) {
  await pois.ensureNear(f.lat, f.lon, near.offKm < 300 ? near.km : null).catch(() => {});
  let heading = f.heading, note = '';
  if (heading == null) { heading = S.route.atMinutes(near.t).heading; note = 'heading from route'; }
  const speed = f.speedKmh && f.speedKmh > 150 ? f.speedKmh : null;
  if (!speed) note = note ? `${note}; no speed yet` : 'no speed yet';
  if (f.source === 'estimate') note = 'schedule estimate, not GPS';
  S.look = lookList(pois.all(), f, heading, speed);
  $('look-note').textContent = note;
  S.highlight = new Map(S.look.map((x, i) => [x.poi.id, i + 1]));
  setSource('pois', pois.featureCollection(S.highlight));
  renderLook();
}

function fmtEta(it) {
  if (Math.abs(it.at) < 8) return { big: 'now', small: 'abeam', now: true };
  if (it.at < 0) return { big: 'passed', small: `${Math.round(-it.at)} km behind` };
  if (it.eta == null) return { big: `${Math.round(it.at)} km`, small: 'ahead' };
  const m = Math.round(it.eta);
  return { big: m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`, small: `${Math.round(it.at)} km ahead` };
}

function renderLook() {
  const ul = $('look-list');
  if (!S.look.length) {
    ul.innerHTML = `<li class="empty">${pois.loaded.size ? 'Nothing notable within 250 km ahead. Open ocean or ice, most likely.' : 'Loading features…'}</li>`;
    return;
  }
  ul.innerHTML = '';
  S.look.forEach((it, i) => {
    const p = it.poi, e = fmtEta(it);
    const li = document.createElement('li');
    const extra = p.pop ? ` · pop. ${p.pop >= 1e6 ? (p.pop / 1e6).toFixed(1) + 'M' : Math.round(p.pop / 1000) + 'k'}` : p.ele ? ` · ${p.ele.toLocaleString()} m` : '';
    li.innerHTML = `<div class="side ${it.side}">${it.side === 'L' ? '◀' : '▶'}<small>${it.side === 'L' ? 'LEFT' : 'RIGHT'}</small></div>
      <div class="name"><b>${i + 1}. ${TYPE_ICON[p.t] || ''} ${esc(p.n)}</b><span>${Math.round(it.xt)} km ${it.side === 'L' ? 'left' : 'right'} · now ${Math.round(it.d)} km away${extra}</span></div>
      <div class="when${e.now ? ' now' : ''}"><b>${e.big}</b>${e.small}</div>`;
    li.onclick = () => openInfo(p.id);
    ul.appendChild(li);
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderGpsChip() {
  const chip = $('gps-chip'), txt = $('gps-text');
  const f = S.fix;
  chip.className = 'chip';
  if (S.source === 'sim') { chip.classList.add('fix'); txt.textContent = `Fast replay · ${clock.now().toISOString().slice(11, 16)}Z`; return; }
  if (S.source === 'manual') {
    const d = manual ? Math.round(manual.t - manual.scheduleT()) : 0;
    chip.classList.add(manual?.paused ? 'stale' : 'fix');
    txt.textContent = manual?.paused ? 'Slider · paused' : Math.abs(d) < 2 ? 'Slider · on schedule' : `Slider · ${d > 0 ? 'ahead of' : 'behind'} schedule ${fmtDur(Math.abs(d))}`;
    return;
  }
  if (S.lastGpsAt && Date.now() - S.lastGpsAt < 30000 && f?.source === 'gps') {
    const acc = Math.round(f.acc);
    chip.classList.add(acc <= 100 ? 'fix' : 'weak');
    txt.textContent = `GPS ±${acc >= 1000 ? (acc / 1000).toFixed(1) + ' km' : acc + ' m'}`;
  } else if (S.lastGpsAt) {
    chip.classList.add('stale');
    txt.textContent = `Last fix ${Math.round((Date.now() - S.lastGpsAt) / 60000)} min ago${f?.source === 'estimate' ? ' · showing estimate' : ''}`;
  } else if (S.gpsError?.code === 1) {
    chip.classList.add('error'); txt.textContent = 'Location denied';
  } else if (f?.source === 'estimate') {
    chip.classList.add('estimate', 'nofix'); txt.textContent = 'No GPS fix · estimate from schedule';
  } else {
    chip.classList.add('nofix');
    const w = S.gpsWaitSince ? Math.round((Date.now() - S.gpsWaitSince) / 1000) : 0;
    txt.textContent = S.gpsWaitSince ? `No GPS fix yet (${w < 120 ? w + ' s' : Math.round(w / 60) + ' min'})` : 'GPS not started';
  }
}

// ---------------------------------------------------------------- POI info sheet

function openInfo(id) {
  const p = pois.byId(id);
  if (!p) return;
  const it = S.look.find((x) => x.poi.id === id);
  $('info-title').textContent = `${TYPE_ICON[p.t] || ''} ${p.n}`;
  const bits = [p.t];
  if (p.pop) bits.push(`population ${p.pop.toLocaleString()}`);
  if (p.ele) bits.push(`${p.ele.toLocaleString()} m`);
  if (it) bits.push(`${Math.round(it.xt)} km ${it.side === 'L' ? 'left' : 'right'}`, fmtEta(it).big === 'now' ? 'abeam now' : `abeam: ${fmtEta(it).big}`);
  $('info-meta').textContent = bits.join(' · ');
  $('info-text').textContent = p.s || '(No summary stored.)';
  $('info').hidden = false;
}

// ---------------------------------------------------------------- controls

const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}` : `${Math.round(m)} min`);
function stopSources() { gps.stop(); sim?.stop(); manual?.stop(); }

function syncSlider() {
  if (!manual || S.source !== 'manual') return;
  const t = manual.t, sl = $('pos-slider');
  if (!S.dragging) sl.value = String(Math.max(Number(sl.min), Math.min(Number(sl.max), t)));
  const r = S.route;
  const local = new Date(r.departure.getTime() + t * 60000);
  const where = t < r.tStart ? 'at the gate / taxiing' : t > r.tEnd ? 'landed' : `T+${fmtDur(t)} after departure`;
  $('pos-label').textContent = `${where} · ${local.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' })} Seattle · ${local.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Qatar' })} Doha`;
  $('btn-pause').textContent = manual.paused ? '▶' : '⏸';
}

function startManual(t) {
  stopSources();
  S.source = 'manual';
  manual.start(t);
  S.follow = true; $('btn-follow').classList.add('on');
  document.querySelector('input[name=src][value=manual]').checked = true;
  lastFlavorCheck = 0;
  setSource('night', nightFC(clock.now()));
}

function startGps() {
  stopSources();
  S.source = 'gps';
  $('pos-label').textContent = '';
  motion.reset();
  S.fix = null;
  S.gpsWaitSince = Date.now();
  gps.start();
  document.querySelector('input[name=src][value=gps]').checked = true;
  renderGpsChip();
}

function startSim(atMinutes) {
  stopSources();
  S.source = 'sim';
  $('pos-label').textContent = '';
  motion.reset();
  sim.setSpeed(Number($('sim-speed').value));
  const from = atMinutes ?? S.route.tStart + Number($('sim-from').value) * (S.route.tEnd - S.route.tStart);
  sim.start(from);
  S.follow = true; $('btn-follow').classList.add('on');
  document.querySelector('input[name=src][value=sim]').checked = true;
  setSource('night', nightFC(clock.now()));
  lastFlavorCheck = 0; // re-pick light/dark for the simulated time on the next fix
}

function begin(mode) {
  $('start').hidden = true;
  awake.start($('opt-video').checked).catch(() => {});
  refreshStorage();
  if (mode === 'sim') startSim(); else if (mode === 'gps') startGps(); else startManual();
}

function bindUI() {
  $('btn-start').onclick = () => begin('manual');
  const sl = $('pos-slider');
  sl.min = String(Math.floor(S.route.tStart)); sl.max = String(Math.ceil(S.route.tEnd));
  sl.addEventListener('pointerdown', () => { S.dragging = true; });
  sl.addEventListener('input', () => {
    if (S.source !== 'manual') startManual(Number(sl.value)); else manual.start(Number(sl.value));
    S.follow = true; $('btn-follow').classList.add('on');
    lastFlavorCheck = 0;
    setSource('night', nightFC(clock.now()));
  });
  sl.addEventListener('change', () => { S.dragging = false; manual.save(); });
  $('btn-pause').onclick = () => { if (S.source !== 'manual') startManual(); manual.setPaused(!manual.paused); syncSlider(); renderGpsChip(); };
  $('btn-now').onclick = () => { manual.paused = false; startManual(manual.scheduleT()); };
  $('btn-start-sim').onclick = () => begin('sim');
  $('btn-settings').onclick = $('btn-start-settings').onclick = () => { $('settings').hidden = false; cache.status(); refreshStorage(); };
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $(b.dataset.close).hidden = true; }; });
  $('btn-follow').classList.toggle('on', S.follow);
  $('btn-follow').onclick = () => { S.follow = true; $('btn-follow').classList.add('on'); update(); };
  $('btn-trackup').classList.toggle('on', S.trackUp);
  $('btn-trackup').onclick = () => {
    S.trackUp = !S.trackUp; prefs.trackUp = S.trackUp; savePrefs();
    $('btn-trackup').classList.toggle('on', S.trackUp);
    if (!S.trackUp) map.easeTo({ bearing: 0 }); else update();
  };
  // collapsed by default; remember the last choice
  const setLook = (open) => { $('look').classList.toggle('collapsed', !open); $('look-toggle').textContent = open ? '▾' : '▴'; };
  setLook(!!prefs.lookOpen);
  $('look-toggle').onclick = () => { prefs.lookOpen = $('look').classList.contains('collapsed'); savePrefs(); setLook(prefs.lookOpen); };
  document.querySelector('.look-head').addEventListener('click', (e) => { if (e.target.id !== 'look-toggle') $('look-toggle').click(); });

  $('btn-download').onclick = async () => {
    if (!navigator.onLine) { log('Offline: connect to Wi-Fi first (this downloads from the site).'); return; }
    log('Checking what is missing…');
    log(await cache.download());
  };
  // iOS freezes downloads in the background; pick up again when the app comes back
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine && cache && cache.state.phase !== 'ready') cache.download().catch(() => {});
  });
  $('btn-verify').onclick = async () => {
    log('Verifying…');
    const bad = await cache.verify();
    log(bad.length ? `Verify: ${bad.length} problems\n${bad.slice(0, 20).join('\n')}` : `Verify: all ${cache.manifest.entries.length} files present ✓`);
    cache.status();
  };
  $('btn-deep').onclick = async () => {
    log('Deep verify: re-hashing every cached file…');
    const bad = await cache.verify({ deep: true, onProgress: (i, n) => { $('cache-line').textContent = `Deep verify ${i}/${n}…`; } });
    log(bad.length ? `Deep verify: ${bad.length} problems\n${bad.slice(0, 20).join('\n')}` : 'Deep verify: every byte matches ✓');
    cache.status();
  };

  document.querySelectorAll('input[name=src]').forEach((r) => { r.onchange = () => (r.value === 'sim' ? startSim() : r.value === 'gps' ? startGps() : startManual()); });
  $('sim-speed').onchange = () => sim.setSpeed(Number($('sim-speed').value));
  const fromLabel = () => {
    const t = S.route.tStart + Number($('sim-from').value) * (S.route.tEnd - S.route.tStart);
    $('sim-from-label').textContent = `T+${Math.floor(t / 60)}h${String(Math.round(t % 60)).padStart(2, '0')}`;
  };
  $('sim-from').oninput = fromLabel;
  $('sim-from').onchange = () => { if (S.source === 'sim') startSim(); };
  fromLabel();

  $('opt-estimate').checked = prefs.estimate !== false;
  $('opt-estimate').onchange = () => { prefs.estimate = $('opt-estimate').checked; savePrefs(); };
  $('opt-flavor').value = prefs.flavor || 'auto';
  $('opt-flavor').onchange = () => { prefs.flavor = $('opt-flavor').value; savePrefs(); applyStyle(); };
  $('opt-proj').value = prefs.proj || 'globe';
  $('opt-proj').onchange = () => { prefs.proj = $('opt-proj').value; savePrefs(); applyStyle(); };
  $('opt-video').checked = !!prefs.video;
  $('opt-video').onchange = () => { prefs.video = $('opt-video').checked; savePrefs(); awake.start(prefs.video); };

  $('route-file').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const fixes = parseTrack(await file.text(), file.name);
      if (fixes.length < 10) throw new Error(`only ${fixes.length} usable points`);
      setRoute(routeFromTrack(fixes, S.baseRoute, file.name), true);
      log(`Imported ${file.name}: ${fixes.length} fixes, ${Math.round(S.route.totalKm)} km`);
    } catch (e) { showError(`Track import failed: ${e.message}`); }
  };
  $('btn-route-reset').onclick = async () => { clearOverride(); const r = await loadRoute(); setRoute(r.route, false); };

  const dm = matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'standalone (home screen) ✓' : 'browser tab: install to Home Screen for offline use';
  $('display-mode').textContent = dm;
}

function setRoute(route, overridden) {
  S.route = route; S.overridden = overridden;
  sim = new SimSource(route, onFix, clock);
  manual?.stop();
  manual = new ManualSource(route, onFix, clock);
  $('pos-slider').min = String(Math.floor(route.tStart)); $('pos-slider').max = String(Math.ceil(route.tEnd));
  if (S.source === 'manual') startManual();
  timeline.setRoute(route);
  setSource('route', route.lineGeoJSON());
  setSource('corridor', route.corridorGeoJSON());
  renderRouteInfo();
}

function renderRouteInfo() {
  const r = S.route, j = r.json;
  const fmt = (d) => d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  $('route-info').textContent = `${j.flight} ${j.origin.iata}→${j.destination.iata} · ${Math.round(r.totalKm).toLocaleString()} km · departs ${fmt(r.departure)} · route: ${j.source} · timing: ${j.timeProfile}`;
  $('start-flight').textContent = `${j.flight} ${j.origin.iata} → ${j.destination.iata}, ${fmt(r.departure)}`;
}

// ---------------------------------------------------------------- boot

async function boot() {
  const ok = await setupServiceWorker();
  if (!ok) return;
  cache = new OfflineCache(renderCache);
  awake = new KeepAwake((m) => { $('wake').textContent = m; });

  const r = await loadRoute();
  S.route = r.route; S.baseRoute = r.base; S.overridden = r.overridden;
  timeline = new Timeline($('timeline'), $('timeline-label'), (t) => { if (S.source === 'sim') startSim(t); });
  timeline.setRoute(S.route);
  sim = new SimSource(S.route, onFix, clock);
  manual = new ManualSource(S.route, onFix, clock);
  gps = new GpsSource(onFix, onGpsError);
  renderRouteInfo();
  bindUI();
  await pois.init();
  initMap();
  timeline.setCurrent((clock.now() - S.route.departure) / 60000);

  try {
    await cache.loadManifest();
    const { phase } = await cache.status();
    if (phase !== 'ready' && navigator.onLine) cache.download();
    if (phase !== 'ready' && !navigator.onLine) showError(`Offline and the cache is incomplete (${cache.state.missing.length} files missing). Parts of the map or features will be blank.`, 'incomplete');
  } catch (e) { showError(`Cache check failed: ${e.message}`); }

  setInterval(() => { if (cache.state.phase === 'downloading') renderCache(cache.state); }, 2000);
  setInterval(() => { renderGpsChip(); estimateTick(); if (S.source === 'manual' && manual.running) manual.save(); }, 5000);
  setInterval(() => { if (!clock.simulated) setSource('night', nightFC(clock.now())); }, 60000);
  setInterval(() => { if (clock.simulated) setSource('night', nightFC(clock.now())); }, 2000);

  if (params.has('sim')) {
    const sp = Number(params.get('speed')); if (sp) $('sim-speed').value = String(sp);
    const at = params.get('at'); // minutes after departure, e.g. ?sim&at=600
    begin('sim');
    if (at) startSim(Number(at));
  }
  window.__ws = { S, map: () => map, cache: () => cache, clock, pois };
}

boot().catch((e) => showError(`Startup failed: ${e.message}`));
