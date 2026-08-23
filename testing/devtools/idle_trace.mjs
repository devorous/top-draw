/**
 * True-idle trace: join a room, touch nothing, and measure what the app burns.
 *
 * board_perf_suite always drives strokes, so it can never answer "what does
 * this cost when nobody is drawing" -- which is the question behind idle lag
 * and battery drain. This joins a room and then sits perfectly still for the
 * window while tracing. Board size comes from the server, so `--size` is a
 * request, not a guarantee; the result records the board actually measured.
 *
 * requestAnimationFrame is wrapped before the window starts so each scheduled
 * callback is attributed to its call site. A count alone would only confirm
 * that rAF fires; the call site says which loop is responsible.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/idle_trace.mjs \
 *     --size=1440p --seconds=30 --label=idle-1440p
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { BOARD_SIZE_PRESETS } from '../../shared/boardSizes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'perf-results');

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SIZE = arg('size', '1440p');
const SECONDS = Number(arg('seconds', 30));
const LABEL = arg('label', `idle-${SIZE}`);
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 240_000);

const dims = BOARD_SIZE_PRESETS[SIZE];
if (!dims) { console.error(`unknown --size=${SIZE}`); process.exit(1); }
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tracePath = path.join(RESULTS_DIR, `${LABEL}.trace.json`);
const room = `idle_${LABEL.replace(/[^a-z0-9]/gi, '')}_${Date.now()}`;

const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
const page = (await browser.pages()).find((p) => p.url().startsWith('http'))
  || (await browser.newPage());

// rAF does not fire in a hidden tab, so a backgrounded page measures 0 frames
// and ~0% CPU -- a clean-looking result that means nothing.
await page.bringToFront();

// KDE PowerDevil blanks the Chromebook's display on its own timer, which stops
// vsync and therefore rAF -- while document.visibilityState stays "visible", so
// nothing in the page gives the failure away. A screen wake lock keeps the
// display alive for the run.
await page.evaluate(async () => {
  try {
    window.__wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    console.warn('wake lock refused:', String(e));
  }
});

console.log(`\n=== idle_trace: ${LABEL}`);
console.log(`    board ${SIZE} (${dims[1]}x${dims[0]}), ${SECONDS}s of NO input, room ${room}`);

if (!page.url().startsWith(TARGET_URL)) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
}
await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });

await page.evaluate((r) => { window.app.self.username = 'IDLE'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(
  () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: READY_TIMEOUT }
);

// Settle FIRST: a new room's own board-size setting arrives from the server
// shortly after join, and locking before that lands just gets overwritten.
await sleep(4000);

await page.evaluate((h, w) => {
  const board = window.app.board;
  board.resizeBoard([h, w]);
  window.app._bindLayerManagerDependencies?.();
  const orig = board.resizeBoard.bind(board);
  board.resizeBoard = (d) => (!d || d[0] !== h || d[1] !== w ? undefined : orig(d));
}, dims[0], dims[1]);

// Let the resize itself finish so it is not counted as idle cost.
await sleep(3000);

// Wrap rAF and record the scheduling call site.
await page.evaluate(() => {
  window.__rafSpy = { bySite: {}, total: 0, frames: 0 };
  const orig = window.requestAnimationFrame.bind(window);
  window.__rafOriginal = orig;
  window.requestAnimationFrame = function (cb) {
    let site = 'unknown';
    const stack = new Error().stack;
    if (stack) {
      const lines = stack.split('\n').map((s) => s.trim());
      // [0] "Error", [1] this wrapper, [2] the actual scheduler.
      site = (lines[2] || lines[1] || 'unknown').replace(/^at\s+/, '');
      site = site.replace(/https?:\/\/[^/]+/, '').slice(0, 120);
    }
    const name = cb.name ? `${cb.name} @ ${site}` : site;
    return orig(function (t) {
      window.__rafSpy.bySite[name] = (window.__rafSpy.bySite[name] || 0) + 1;
      window.__rafSpy.total++;
      return cb(t);
    });
  };
  // Independent frame counter so rAF-per-frame can be computed.
  const tick = () => { window.__rafSpy.frames++; window.__rafOriginal(tick); };
  window.__rafOriginal(tick);
});

// Board size is assigned by the server (connectData.roomBoardSize), so a
// client-side resize does not hold. Report what we actually measured rather
// than the size that was asked for -- a mislabelled run is worse than an
// unexpected one. Idle cost is area-independent anyway: compositeAllLayers()
// is the only area-dependent work and the loop early-outs before reaching it.
const actualDims = await page.evaluate(() => window.app.board.dimensions);
if (actualDims[0] !== dims[0] || actualDims[1] !== dims[1]) {
  console.warn(
    `    NOTE: server gave ${actualDims[1]}x${actualDims[0]}, not the requested `
    + `${dims[1]}x${dims[0]} — reporting the actual board`
  );
}

const stateBefore = await page.evaluate(() => ({
  dims: window.app.board.dimensions,
  tickRate: window.app.inputBufferManager?.tickRate ?? null,
  targetFPS: window.app.board?.targetFPS ?? null,
  users: window.app.users?.size ?? 0,
}));
console.log(`    state: ${JSON.stringify(stateBefore)}`);

const cdp = await page.target().createCDPSession();
await cdp.send('Performance.enable');
const before = await cdp.send('Performance.getMetrics');

await page.tracing.start({
  path: tracePath,
  categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'gpu', 'toplevel',
    'viz', 'benchmark', 'v8']
});

console.log(`    idling ${SECONDS}s (no pointer events at all)...`);
await sleep(SECONDS * 1000);

const raf = await page.evaluate(() => ({
  total: window.__rafSpy.total,
  frames: window.__rafSpy.frames,
  bySite: Object.entries(window.__rafSpy.bySite).sort((a, b) => b[1] - a[1]).slice(0, 15),
}));

// Before tracing.stop(): the flush is slower than the measurement.
const after = await cdp.send('Performance.getMetrics');
await page.tracing.stop();
await cdp.detach().catch(() => {});

const asMap = (m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));
const a = asMap(before); const b = asMap(after);
const span = (b.Timestamp - a.Timestamp) || 1;
const pct = (k) => +((((b[k] ?? 0) - (a[k] ?? 0)) / span) * 100).toFixed(1);

const result = {
  label: LABEL, at: new Date().toISOString(), size: SIZE, requestedDims: dims, dims: actualDims, room,
  idleSeconds: SECONDS, state: stateBefore,
  spanSec: +span.toFixed(1),
  taskPct: pct('TaskDuration'), scriptPct: pct('ScriptDuration'),
  layoutPct: pct('LayoutDuration'), recalcStylePct: pct('RecalcStyleDuration'),
  layoutCount: (b.LayoutCount ?? 0) - (a.LayoutCount ?? 0),
  recalcStyleCount: (b.RecalcStyleCount ?? 0) - (a.RecalcStyleCount ?? 0),
  jsHeapMB: +((b.JSHeapUsedSize ?? 0) / 1048576).toFixed(1),
  raf: { total: raf.total, frames: raf.frames, perFrame: +(raf.total / (raf.frames || 1)).toFixed(2) },
  rafBySite: raf.bySite,
};

if (result.raf.frames === 0) {
  console.error(
    '\n  ABORT: 0 animation frames in the window — the tab was hidden or occluded, '
    + 'so rAF was suspended. Every number here would be a measurement of nothing.'
  );
  await browser.disconnect();
  process.exit(1);
}

console.log(`\n  span                  ${result.spanSec}s idle`);
console.log(`  main thread           ${result.taskPct}% task, ${result.scriptPct}% script, ${result.layoutPct}% layout, ${result.recalcStylePct}% style`);
console.log(`  layout/style          ${result.layoutCount} layouts, ${result.recalcStyleCount} style recalcs`);
console.log(`  frames while idle     ${result.raf.frames}  (${(result.raf.frames / result.spanSec).toFixed(1)} fps)`);
console.log(`  rAF callbacks         ${result.raf.total}  (${result.raf.perFrame} per frame)`);
console.log('\n  rAF schedulers (top):');
for (const [site, n] of raf.bySite) console.log(`    ${String(n).padStart(6)}  ${site}`);

fs.writeFileSync(path.join(RESULTS_DIR, `${LABEL}.json`), JSON.stringify(result, null, 2));
console.log(`\n  saved → perf-results/${LABEL}.json`);
await browser.disconnect();
