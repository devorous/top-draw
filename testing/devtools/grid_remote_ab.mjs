/**
 * End-to-end A/B: does scoping the remote-preview dirty rect help a weak client
 * that is WATCHING someone else draw?
 *
 * Arms are toggled at runtime inside ONE page session by stubbing
 * `RemoteUserHandler._activeStrokeDirtyRect` to return null, which reproduces
 * the pre-fix behaviour exactly (full-board clearRect + drawImage in
 * _copyPreviewSource, plus markCompositeFull). Interleaved A/B/A/B because this
 * box drifts downward across a session by more than the effect being measured.
 *
 *   node testing/devtools/grid_remote_ab.mjs
 *
 * Requires: the tunnel + Chrome running on `book` (CDP on 127.0.0.1:9222), and
 * a SECOND client drawing continuously in the same room.
 */
import puppeteer from 'puppeteer';

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const URL = 'http://localhost:3000/go/';
const SECONDS = Number(process.env.SECONDS || 8);
const REPEATS = Number(process.env.REPEATS || 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
const pages = await browser.pages();
let page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];

// Reload so the edited module is loaded fresh and no prior instrumentation survives.
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(3000);
await page.evaluate(() => {
  const box = document.querySelector('input[placeholder*="username" i], input[placeholder*="Pick" i]');
  if (box) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(box, 'weakobs');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const btn = [...document.querySelectorAll('button')].find(b => /join & draw/i.test(b.textContent));
  if (btn) btn.click();
});
await page.waitForFunction(() => window.app?.connected && window.app.board?.viewCanvas, { timeout: 90000 });
await sleep(4000);
// `/go/` picks a room for you, so two clients silently land in DIFFERENT rooms
// while both look healthy. Join an explicit one on both sides.
const ROOM = process.env.ROOM || 'perfroom';
await page.evaluate(r => window.app.handleRoomSelected(r), ROOM);
await page.waitForFunction(r => window.app?.connected && window.app.currentRoomId === r, { timeout: 60000 }, ROOM);
await sleep(4000);

const env = await page.evaluate(async () => {
  let wake = 'unavailable';
  try { await navigator.wakeLock.request('screen'); wake = 'held'; } catch (e) { wake = 'failed:' + e.name; }
  const a = window.app, h = a.remoteUserHandler;
  // Arm switch: null rect === exact pre-fix behaviour.
  window.__oldBehavior = false;
  if (h && typeof h._activeStrokeDirtyRect === 'function') {
    const orig = h._activeStrokeDirtyRect.bind(h);
    h._activeStrokeDirtyRect = (u, l) => (window.__oldBehavior ? null : orig(u, l));
  }
  // Composite classification + frame intervals.
  const g = a.board.compositeTileGrid, b = a.board;
  const P = window.__P = { full: 0, partial: 0, empty: 0, coverage: [],
    reset() { this.full = 0; this.partial = 0; this.empty = 0; this.coverage = []; } };
  const area = g.width * g.height;
  const oc = g.consumeDirtyRects.bind(g);
  g.consumeDirtyRects = (...x) => {
    const r = oc(...x);
    if (r === null) P.full++;
    else if (r.length === 0) P.empty++;
    else { P.partial++; let s = 0; for (const q of r) s += q.width * q.height; P.coverage.push(s / area); }
    return r;
  };
  window.__measure = (secs) => new Promise(res => {
    P.reset();
    const iv = []; let last = performance.now(); const t0 = last;
    const step = () => {
      const now = performance.now(); iv.push(now - last); last = now;
      if (now - t0 < secs * 1000) requestAnimationFrame(step);
      else {
        iv.shift();
        const dropped = iv.filter(v => v > 25).length;
        const total = iv.reduce((s, v) => s + v, 0);
        const sorted = [...iv].sort((x, y) => x - y);
        const q = p => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
        const cov = P.coverage.length ? P.coverage.reduce((s, v) => s + v, 0) / P.coverage.length : null;
        res({ frames: iv.length, droppedPct: +(100 * dropped / iv.length).toFixed(1),
              p95: q(0.95), p99: q(0.99), effFps: +(1000 * iv.length / total).toFixed(1),
              full: P.full, partial: P.partial,
              pctFullComposites: (P.full + P.partial) ? +(100 * P.full / (P.full + P.partial)).toFixed(1) : null,
              avgCoveragePct: cov != null ? +(100 * cov).toFixed(2) : null });
      }
    };
    requestAnimationFrame(step);
  });
  return { wake, cores: navigator.hardwareConcurrency, dims: a.board.dimensions.slice(),
           users: a.users.size, patched: typeof h?._activeStrokeDirtyRect === 'function' };
});
console.log('ENV', JSON.stringify(env));
if (env.users < 2) console.log('WARNING: only %d user(s) in room — start the second client drawing!', env.users);

const runs = [];
for (let i = 0; i < REPEATS; i++) {
  await page.evaluate(() => { window.__oldBehavior = true; });
  const before = await page.evaluate(s => window.__measure(s), SECONDS);
  await page.evaluate(() => { window.__oldBehavior = false; });
  const after = await page.evaluate(s => window.__measure(s), SECONDS);
  const peers = await page.evaluate(() => {
    let n = 0; window.app.users.forEach(u => { if (u.mousedown) n++; }); return { users: window.app.users.size, drawing: n };
  });
  if (before.frames === 0 || after.frames === 0) { console.error('ABORT: zero frames (display blanked)'); process.exit(2); }
  runs.push({ run: i, label: i === 0 ? 'cold' : 'steady', peers, before, after });
  console.log(`run ${i} (${i === 0 ? 'cold' : 'steady'}) users=${peers.users} drawing=${peers.drawing}`);
  console.log(`   OLD (full)    drop ${before.droppedPct}%  p95 ${before.p95}  effFps ${before.effFps}  fullComposites ${before.pctFullComposites}%  cov ${before.avgCoveragePct}%`);
  console.log(`   NEW (scoped)  drop ${after.droppedPct}%  p95 ${after.p95}  effFps ${after.effFps}  fullComposites ${after.pctFullComposites}%  cov ${after.avgCoveragePct}%`);
}

const steady = runs.filter(r => r.label === 'steady');
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
if (steady.length) {
  console.log('\nSTEADY MEDIANS');
  console.log(JSON.stringify({
    old: { droppedPct: med(steady.map(r => r.before.droppedPct)), p95: med(steady.map(r => r.before.p95)),
           effFps: med(steady.map(r => r.before.effFps)), pctFullComposites: med(steady.map(r => r.before.pctFullComposites)) },
    new: { droppedPct: med(steady.map(r => r.after.droppedPct)), p95: med(steady.map(r => r.after.p95)),
           effFps: med(steady.map(r => r.after.effFps)), pctFullComposites: med(steady.map(r => r.after.pctFullComposites)) },
  }, null, 2));
}
await browser.disconnect();
