// End-to-end offline test in Chromium (Playwright).
//   node tests/e2e.mjs            full run (downloads the whole cache from a local server)
//   HEADED=1 node tests/e2e.mjs   watch it
//   BROWSER=webkit node tests/e2e.mjs   same in WebKit (Safari's engine; not iOS itself)
//
// 1. serve web/, open the app, wait for "ready for offline"
// 2. KILL the server (real offline, not emulation), reload
// 3. check: map renders vector tiles, SW range-serving is byte-exact across a part boundary,
//    the simulated flight fills the look list, POI summaries open, zero network fetches, no banner
import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const URL0 = `http://localhost:${PORT}/`;
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`); };

function serve() {
  const p = spawn(path.join(ROOT, '.venv/bin/python'), ['-I', path.join(ROOT, 'scripts/serve.py'), String(PORT), '--quiet'], { stdio: 'inherit' });
  return new Promise((res) => setTimeout(() => res(p), 800));
}

const server = await serve();
const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
console.log(`engine: ${engine.name()}`);
const browser = await engine.launch({ headless: !process.env.HEADED });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 }); // retina: requests the @2x sprite like an iPhone
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const failedRequests = [];
page.on('requestfailed', (r) => { const why = r.failure()?.errorText || ''; if (!/cancel|abort/i.test(why)) failedRequests.push(`${r.url()} (${why})`); });

try {
  // ---------------------------------------------------------------- online: install + download
  await page.goto(URL0);
  await page.waitForFunction(() => window.__ws?.cache(), null, { timeout: 30000 });
  await page.waitForFunction(() => /MB\/s · ~/.test(document.getElementById('cache-line').textContent), null, { timeout: 60000 }).catch(() => {});
  ok('download shows speed and time left', /MB\/s · ~/.test(await page.textContent('#cache-line')) || (await page.evaluate(() => window.__ws.cache().state.phase)) === 'ready', await page.textContent('#cache-line'));
  const t0 = Date.now();
  await page.waitForFunction(() => window.__ws.cache().state.phase === 'ready', null, { timeout: 600000, polling: 1000 });
  const st = await page.evaluate(() => window.__ws.cache().state);
  ok('cache reaches ready', st.phase === 'ready', `${(st.doneBytes / 1e6).toFixed(1)} MB, ${st.doneFiles} files in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await page.click('#btn-start-settings');
  ok('status line says ready', /ready for offline/.test(await page.textContent('#cache-line')), await page.textContent('#cache-line'));
  await page.waitForFunction(() => document.getElementById('persist').textContent !== '—');
  ok('persist() result shown', true, await page.textContent('#persist'));
  const bad = await page.evaluate(() => window.__ws.cache().verify());
  ok('verify: all present', bad.length === 0, bad.slice(0, 3).join('; '));

  // "Download missing" really restores deleted files, and says so when there is nothing to do
  await page.evaluate(async () => {
    const c = await caches.open((await caches.keys()).find((k) => k.endsWith('-data')));
    const keys = (await c.keys()).filter((r) => /tiles|fonts/.test(r.url)).slice(0, 8);
    for (const k of keys) await c.delete(k);
    await window.__ws.cache().status();
  });
  const before = await page.evaluate(() => window.__ws.cache().state.missing.length);
  await page.click('#btn-download');
  await page.waitForFunction(() => /Download complete/.test(document.getElementById('cache-log').textContent), null, { timeout: 120000 });
  const after = await page.evaluate(async () => (await window.__ws.cache().status()).missing.length);
  ok('Download missing restores deleted files', before === 8 && after === 0, `${before} missing -> ${after}`);
  await page.click('#btn-download');
  await page.waitForFunction(() => /Nothing missing/.test(document.getElementById('cache-log').textContent), null, { timeout: 30000 });
  ok('Download missing reports when nothing is missing', true);

  // ---------------------------------------------------------------- offline
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  const probe = await page.evaluate(() => fetch('http://localhost:8099/precache.json', { headers: { 'x-ws-fresh': '1' } }).then(() => 'reachable', () => 'unreachable'));
  ok('server is really down', probe === 'unreachable', probe);
  failedRequests.length = 0; consoleErrors.length = 0; // the probe above fails on purpose

  await page.goto(`${URL0}?sim&speed=60&at=640`);
  await page.waitForFunction(() => window.__ws?.map()?.loaded(), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__ws.map().areTilesLoaded(), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const feats = await page.evaluate(() => window.__ws.map().queryRenderedFeatures().filter((f) => f.source === 'protomaps').length);
  ok('vector tiles render offline', feats > 30, `${feats} rendered basemap features`);

  // labels must actually draw (glyphs served offline): placed text symbols from the basemap
  const labels = await page.evaluate(() => window.__ws.map().queryRenderedFeatures().filter((f) => f.source === 'protomaps' && f.layer.type === 'symbol' && f.layer.layout?.['text-field']).length);
  ok('basemap labels render offline', labels > 3, `${labels} labelled features`);

  // byte-exact Range across a 4 MiB part boundary vs the merged archive on disk
  const bm = JSON.parse(readFileSync(path.join(ROOT, 'web/data/basemap.json')));
  const start = bm.chunkSize - 37, len = 101;
  const got = await page.evaluate(async ([s, l]) => {
    const r = await fetch('data/basemap.pmtiles', { headers: { Range: `bytes=${s}-${s + l - 1}` } });
    return { status: r.status, cr: r.headers.get('Content-Range'), bytes: [...new Uint8Array(await r.arrayBuffer())] };
  }, [start, len]);
  const fd = openSync(path.join(ROOT, 'build/basemap/basemap.pmtiles'), 'r');
  const want = Buffer.alloc(len); readSync(fd, want, 0, len, start); closeSync(fd);
  ok('range across part boundary is byte-exact', got.status === 206 && Buffer.from(got.bytes).equals(want), `${got.status} ${got.cr}`);
  const tail = await page.evaluate(async (size) => {
    const r = await fetch('data/basemap.pmtiles', { headers: { Range: `bytes=${size - 10}-${size + 5000}` } });
    return { status: r.status, cr: r.headers.get('Content-Range'), n: (await r.arrayBuffer()).byteLength };
  }, bm.size);
  ok('range past EOF is clamped', tail.status === 206 && tail.n === 10, `${tail.cr}`);

  await page.waitForFunction(() => document.querySelectorAll('#look-list li:not(.empty)').length >= 3, null, { timeout: 20000 }).catch(() => {});
  const items = await page.$$eval('#look-list li:not(.empty)', (lis) => lis.map((li) => li.innerText.replace(/\s+/g, ' ')));
  ok('look list populated (sim at T+640 min)', items.length >= 3, `${items.length} items; first: ${items[0] || '-'}`);
  if (items.length) {
    if (await page.evaluate(() => document.getElementById('look').classList.contains('collapsed'))) await page.click('#look-toggle');
    await page.click('#look-list li:not(.empty)');
    const txt = await page.textContent('#info-text');
    ok('POI summary opens offline', txt && txt.length > 40, `${(await page.textContent('#info-title')).trim()}: ${txt.slice(0, 80)}…`);
    mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'build/e2e-info.png') });
    await page.click('[data-close=info]');
  }
  const net = await page.evaluate(() => window.__ws.S.netCount);
  const misses = await page.evaluate(() => [...window.__ws.S.misses]);
  ok('zero network fetches after reload', net === 0, `${net}`);
  ok('zero cache misses', misses.length === 0, misses.slice(0, 3).join(', '));
  const banner = await page.evaluate(() => !document.getElementById('banner').hidden && document.getElementById('banner').textContent);
  ok('no error banner', !banner, banner || '');

  // the only request allowed to fail offline is the service worker's own update check (sw.js)
  const unexpected = failedRequests.filter((u) => !/\/sw\.js(\?| |$)/.test(u));
  ok('no failed requests except the SW update check', unexpected.length === 0, `${failedRequests.length} failed: ${[...new Set(failedRequests)].slice(0, 4).join(', ')}`);
  const realErrors = consoleErrors.filter((m) => !/ERR_CONNECTION_REFUSED|Could not connect to the server|Failed to update a ServiceWorker/.test(m));
  ok('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  // slider mode (the default "Start"): drag to T+700 and the plane, list and labels follow
  await page.goto(URL0);
  await page.waitForFunction(() => window.__ws?.map()?.loaded(), null, { timeout: 30000 });
  await page.click('#btn-start');
  await page.evaluate(() => { const s = document.getElementById('pos-slider'); s.value = '700'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(3000);
  const man = await page.evaluate(() => ({ src: window.__ws.S.source, t: Math.round((window.__ws.clock.now() - new Date(window.__ws.S.route.json.departure)) / 60000), chip: document.getElementById('gps-text').textContent, label: document.getElementById('pos-label').textContent, look: document.querySelectorAll('#look-list li:not(.empty)').length }));
  ok('slider sets position (manual mode)', man.src === 'manual' && Math.abs(man.t - 700) <= 2 && man.look >= 3, `${man.chip} | ${man.label} | ${man.look} items`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith('-manual')))));
  ok('slider position is saved for relaunch', saved && Math.abs(saved.t - 700) < 3, JSON.stringify(saved));
  await page.screenshot({ path: path.join(ROOT, 'build/e2e-slider.png') });

  // a missing file must fail visibly
  await page.evaluate(() => fetch('data/definitely-not-cached.json'));
  await page.waitForTimeout(300);
  const banner2 = await page.evaluate(() => !document.getElementById('banner').hidden && document.getElementById('banner').textContent);
  ok('uncached file shows a visible error', /Not cached/.test(banner2 || ''), (banner2 || '').split('\n')[0]);
  await page.evaluate(() => document.getElementById('banner').click());

  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(ROOT, 'build/e2e-sim.png') });
} catch (e) {
  ok('test run', false, e.stack);
  console.log('console errors:', consoleErrors.slice(0, 10).join('\n  '));
  console.log('banner:', await page.evaluate(() => document.getElementById('banner')?.textContent).catch(() => '?'));
  await page.screenshot({ path: path.join(ROOT, 'build/e2e-fail.png') }).catch(() => {});
} finally {
  server.kill();
  await browser.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
