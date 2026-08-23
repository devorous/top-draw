/**
 * Sampling CPU profile while drawing -- names the JS that eats the frame.
 *
 * board_perf_suite's trace shows that V8 ran and for how long, never which
 * function. This attaches the Profiler domain (the DevTools "Performance ->
 * Bottom-Up" instrument), drives real strokes, and aggregates self time by
 * function so the ~9.5ms/frame of JS can be attributed.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/profile_draw.mjs --seconds=12
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'perf-results');
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SECONDS = Number(arg('seconds', 12));
const LABEL = arg('label', 'profile-draw');
const TOP = Number(arg('top', 30));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
const page = (await browser.pages()).find((p) => p.url().startsWith('http'))
  || (await browser.newPage());
await page.bringToFront();
await page.evaluate(async () => {
  try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
});

// ALWAYS load fresh. vite does not hot-swap App.js, so a reused page can still
// be running the build from before the edit under test -- which measures the
// old code and reports "no change" for a fix that was never loaded. Reloading
// also clears any instrumentation a previous run left installed.
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 240_000 });

const room = `prof_${Date.now()}`;
await page.evaluate((r) => { window.app.self.username = 'PROF'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(
  () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: 240_000 }
);
await sleep(4000);

// Events are dispatched ON THE BOARD ELEMENT and allowed to bubble to the
// window listeners, because dispatchEvent sets `target` to whatever you dispatch
// on: firing moves at `window` gives every handler `e.target === window`, which
// no real pointer event ever has. Code that reads e.target (App.isPointerOverBoard,
// _isPointerOnUiControl) then takes a path real users never take.
// board_perf_suite warns that one-element dispatch can commit nothing, so the
// stroke count is asserted below rather than trusted.
await page.evaluate(() => {
  window.__drawLoop = async function (seconds) {
    const strokeCount = () => (window.app.board.layerManager?.layerGroups || [])
      .reduce((n, g) => n + (g.strokeStack?.length || 0), 0);
    const before = strokeCount();
    const [bh, bw] = window.app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw; const sy = rect.height / bh;
    const down = document.getElementById('board');
    const ev = (type, x, y, target) => {
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: rect.left + x * sx, clientY: rect.top + y * sy, pressure: 0.5,
      });
      target.dispatchEvent(e);
    };
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < seconds * 1000) {
      const ox = 200 + (n % 5) * 150; const oy = 200 + (n % 3) * 150;
      ev('pointerdown', ox, oy, down);
      for (let i = 1; i <= 30; i++) {
        ev('pointermove', ox + i * 8, oy + Math.sin(i / 4) * 40, down);
        await raf();
      }
      ev('pointerup', ox + 240, oy, down);
      await raf();
      n++;
    }
    return { strokes: n, committed: strokeCount() - before };
  };
});

const cdp = await page.target().createCDPSession();
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); // microseconds
await cdp.send('Profiler.start');

const driven = await page.evaluate((s) => window.__drawLoop(s), SECONDS);
const { profile } = await cdp.send('Profiler.stop');
await cdp.detach().catch(() => {});

// Fail loud rather than profiling an app that received events but drew nothing.
if (!driven.committed) {
  console.error(
    `\n  ABORT: drove ${driven.strokes} strokes but 0 committed — pointer events `
    + 'are not reaching the drawing path. Every number below would be an idle app.'
  );
  await browser.disconnect();
  process.exit(1);
}
const strokes = driven.strokes;

// Aggregate self time by function. Profiler gives per-node hit counts; each hit
// is one sampling interval of self time.
const byId = new Map();
for (const node of profile.nodes) byId.set(node.id, node);
const totals = new Map();
let totalHits = 0;
for (const node of profile.nodes) {
  const hits = node.hitCount || 0;
  if (!hits) continue;
  totalHits += hits;
  const f = node.callFrame;
  const name = f.functionName || '(anonymous)';
  const url = (f.url || '').replace(/^https?:\/\/[^/]+/, '');
  const key = `${name} ${url}:${f.lineNumber + 1}`;
  totals.set(key, (totals.get(key) || 0) + hits);
}
const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
const msPerHit = 0.1;

console.log(`\n=== ${LABEL}: ${strokes} strokes over ${SECONDS}s`);
console.log(`    ${totalHits} samples, ${(totalHits * msPerHit).toFixed(0)} ms of JS self time\n`);
console.log('   self_ms   share  function');
for (const [key, hits] of rows) {
  const ms = hits * msPerHit;
  console.log(
    String(ms.toFixed(0)).padStart(9),
    String(((hits / totalHits) * 100).toFixed(1) + '%').padStart(6),
    ' ' + key
  );
}

fs.writeFileSync(path.join(RESULTS_DIR, `${LABEL}.cpuprofile`), JSON.stringify(profile));
console.log(`\n  saved → perf-results/${LABEL}.cpuprofile  (loadable in DevTools)`);
await browser.disconnect();
