#!/usr/bin/env node
/**
 * One-off probe: measure LayerManager active-stroke canvas memory WHILE a
 * brush stroke is mid-drag (uncommitted), not after commit — board_perf_suite
 * measures post-commit, where every active canvas has already been released,
 * so it cannot see this specific effect. Not a permanent test, just a scratch
 * script for the LayerManager windowing perf check.
 *
 * Usage: CDP_URL=http://127.0.0.1:9222 TARGET_URL=http://localhost:3000/go/ \
 *   node testing/devtools/_brush_window_probe.mjs --label=x [--concurrent=6] [--path=short|long]
 */
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const LABEL = arg('label', 'probe');
const CONCURRENT = Number(arg('concurrent', 1));
const PATH_MODE = arg('path', 'short'); // short = localized stroke, long = spans board
const CDP_URL = process.env.CDP_URL || '';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = CDP_URL
  ? await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  : await puppeteer.launch({ headless: false, defaultViewport: null });

const page = (await browser.pages())[0] || (await browser.newPage());
await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: READY_TIMEOUT });
// Force a genuine hard reload — a reused page can carry over leftover
// window.app state (e.g. an earlier run's still-open active stroke) even
// after page.goto to the same URL. See chromebook_weak_client_rig memory:
// "Instrumentation persists across script runs on a reused page."
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle2', timeout: READY_TIMEOUT }),
  page.evaluate(() => location.reload())
]);
await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });

const room = `perf_${LABEL.replace(/[^a-z0-9]/gi, '')}_${Date.now()}`;
await page.evaluate((r) => { window.app.self.username = 'PROBE'; window.app.handleRoomSelected(r); }, room);
await page.waitForFunction(
  () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
  { timeout: READY_TIMEOUT }
);

await page.evaluate(() => {
  const board = window.app.board;
  board.resizeBoard([1440, 2560]);
  window.app._bindLayerManagerDependencies?.();
  const orig = board.resizeBoard.bind(board);
  board.resizeBoard = (d) => {
    if (!d || d[0] !== 1440 || d[1] !== 2560) return;
    return orig(d);
  };
});
await sleep(1000);

await page.evaluate(() => { window.app.selectTool('brush'); });

// Defensive cleanup: a stray leftover active stroke for `self` has been
// observed here (mousedown=false but LayerManager still holds a full-board
// active canvas with an empty dirtyRect — commitUserStroke was apparently
// never reached for it, unrelated to the windowing feature under test).
// Clear it so it doesn't pollute the census baseline.
const strayCleared = await page.evaluate(() => {
  const lm = window.app.board.layerManager;
  const selfId = window.app.self.id;
  let cleared = 0;
  for (let gi = 0; gi < lm.layerGroups.length; gi++) {
    if (lm.layerGroups[gi].activeStrokeByUser.has(selfId)) {
      lm.cancelUserStroke(gi, selfId);
      cleared++;
    }
  }
  return cleared;
});
if (strayCleared > 0) console.log(`  (cleared ${strayCleared} stray self active-stroke(s) before measuring)`);

// Simulate CONCURRENT synthetic REMOTE users mid-stroke, entirely client-side
// (no network bots — RemoteUserHandler.handleMouseDown/Move take a plain user
// object). This is what makes the windowing effect visible: it only shows up
// while strokes are ACTIVE/uncommitted.
const result = await page.evaluate(async ({ concurrent, pathMode }) => {
  const app = window.app;
  const board = app.board;
  const rh = app.remoteUserHandler;
  const { collectCanvasCensus } = await import('/src/utils/canvasCensus.js');

  const census = (c) => {
    const bucket = c.buckets.find((b) => b.label === 'layers.activeStroke');
    return {
      totalMB: +c.totalMB.toFixed(2),
      activeStrokeMB: bucket ? +bucket.mb.toFixed(2) : 0,
      activeStrokeCount: bucket ? bucket.count : 0,
      activeStrokeFullBoard: bucket ? bucket.fullBoard : 0,
      fullBoardCount: c.fullBoardCount
    };
  };

  const before = census(collectCanvasCensus(app));

  // Fabricate `concurrent` synthetic remote users (App.ensureRemoteUser gives
  // each a real board/context canvas, same as a real join) and drive real
  // MD/MM traffic for each through the same code path a real remote brush
  // stroke uses.
  const fakeUsers = [];
  for (let i = 0; i < concurrent; i++) {
    const id = 90000 + i;
    const user = app.ensureRemoteUser(id);
    user.username = `PROBE_BOT_${i}`;
    user.color = [Math.floor(Math.random() * 255), Math.floor(Math.random() * 255), Math.floor(Math.random() * 255), 1];
    user.tool = 'brush';
    user.size = 24;
    user.pressure = 1;
    user.hardness = 100;
    user.activeLayer = 0;
    user.blendMode = 'source-over';
    fakeUsers.push(user);
  }

  const dims = board.dimensions; // [h, w]
  for (let i = 0; i < fakeUsers.length; i++) {
    const user = fakeUsers[i];
    // Spread starting points around the board so windows don't all overlap.
    const cx = 150 + (i % 5) * 400;
    const cy = 150 + Math.floor(i / 5) * 300;
    rh.handleMouseDown(user, { ps: [cx, cy], layerIndex: 0, blendMode: 'source-over' });
    // A handful of move points forming a short localized squiggle, or (long
    // mode) a diagonal sweep most of the way across the board — drive them
    // through the REAL handleMouseMove (not by poking currentLine directly),
    // since _previewDirtyBounds (what the windowing bounds hint is built
    // from) is only expanded by handleMouseMove/handleMouseDown, not by
    // addToLine on its own.
    const pts = 12;
    if (pathMode === 'long') {
      const targetX = Math.min(dims[1] - 100, cx + dims[1] * 0.7);
      const targetY = Math.min(dims[0] - 100, cy + dims[0] * 0.5);
      for (let p = 1; p <= pts; p++) {
        const t = p / pts;
        const x = cx + (targetX - cx) * t;
        const y = cy + (targetY - cy) * t;
        rh.handleMouseMove(user, { ps: [x, y] });
      }
    } else {
      const span = 60;
      for (let p = 1; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        const x = cx + span * 0.5 * Math.cos(a);
        const y = cy + span * 0.5 * Math.sin(a);
        rh.handleMouseMove(user, { ps: [x, y] });
      }
    }
    // Force an actual mid-stroke commit (mirrors a real CP/CS pressure/size
    // tick) so the active canvas has real drawn content and its window has
    // actually grown, rather than sitting at MD's initial small allocation.
    rh.commitLine(user, user.pressure, user.size);
  }

  // Mid-drag: strokes are open (MD + a commitLine tick happened) but NOT yet
  // finished (no MU) — this is the state that matters.
  const mid = census(collectCanvasCensus(app));

  // Commit every stroke (MU) so the page is left clean.
  for (const user of fakeUsers) {
    user.mousedown = true;
    rh.handleMouseUp(user, 0);
  }
  const after = census(collectCanvasCensus(app));

  return { before, mid, after, concurrent };
}, { concurrent: CONCURRENT, pathMode: PATH_MODE });

console.log(`\n=== brush-window-probe: ${LABEL} (concurrent=${CONCURRENT}, path=${PATH_MODE})`);
if (result.before.activeStrokeCount > 0) {
  console.log(`  !! CONTAMINATED: before-idle already shows ${result.before.activeStrokeCount} active stroke(s) — discard this run.`);
}
console.log('  before (idle):        ', JSON.stringify(result.before));
console.log('  mid-drag (uncommitted):', JSON.stringify(result.mid));
console.log('  after commit:          ', JSON.stringify(result.after));

await browser.disconnect();
