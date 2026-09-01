#!/usr/bin/env node
/**
 * @fileoverview Paired A/B for the PatternTool composite path.
 *
 * OLD is the shipped-until-2026-08-31 behaviour: `_buildPatternComposite`
 * allocated a brand-new full-board canvas via `document.createElement` on EVERY
 * preview tick, then did a full-board pattern fill, a full-board
 * `destination-in` and a full-board blit onto the target. NEW pools one surface
 * per stroke and clips every pass to the stroke's accumulated bounding box.
 *
 * Both arms run the CURRENT source; the OLD arm is produced by swapping two
 * seams on the live tool instance:
 *   - `_boundsToRect`        -> always the whole board (undoes the clipping)
 *   - `_getCompositeSurface` -> a fresh full-board canvas per call (undoes the
 *     pooling). Its `clearRect` is stubbed out because the old code allocated an
 *     already-transparent canvas and never cleared it — charging OLD an extra
 *     full-board clear the shipped code never did would flatter NEW.
 * That reproduces the old cost profile without re-pasting a copy of the old
 * implementation, which would have needed the module-private
 * `getPatternDrawScale` the tool imports.
 *
 * Interleaved inside ONE page session, alternating which arm leads: sequential
 * runs on the Chromebook drift downward across a session by more than the
 * effect being measured (see [[chromebook_weak_client_rig]]).
 *
 * Run SOLO (no k6 bots) — the local preview path carries the same per-tick
 * allocation as the remote one, and the box is unusable under bot load.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/pattern_ab.mjs --reps=4
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const REPS = Number(arg('reps', 4));
const TOOL = arg('tool', 'pattern');
const STROKES = Number(arg('strokes', 8));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = { '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], big: [1800, 3200] };
const dims = BOARD_SIZES[SIZE];
if (!dims) throw new Error(`unknown --size=${SIZE}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `(() => {
  const app = window.app;

  window.__frames = { on: false, gaps: [], last: 0 };
  (function tick(now) {
    const f = window.__frames;
    if (f.on) { if (f.last) f.gaps.push(now - f.last); f.last = now; } else f.last = 0;
    requestAnimationFrame(tick);
  })(performance.now());

  window.__lockBoardSize = function (h, w) {
    const board = app.board;
    board.resizeBoard([h, w]);
    app._bindLayerManagerDependencies?.();
    const orig = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => { if (!d || d[0] !== h || d[1] !== w) return; return orig(d); };
  };

  // pointerdown on #board, move/up on window — sending all three to one element
  // commits nothing and reports perfect frame times.
  window.__drive = async function ({ strokes, pts = 30, span = 400 }) {
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    const ev = (type, x, y) => {
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
        cancelable: true, composed: true,
        clientX: rect.left + x * sx, clientY: rect.top + y * sy,
        buttons: type === 'pointerup' ? 0 : 1, button: 0,
        pressure: type === 'pointerup' ? 0 : 0.5
      });
      (type === 'pointerdown' ? down : window).dispatchEvent(e);
    };
    const raf = () => new Promise(r => requestAnimationFrame(r));
    for (let s = 0; s < strokes; s++) {
      const ox = 10 + Math.random() * Math.max(1, bw - span - 20);
      const oy = 10 + Math.random() * Math.max(1, bh - span - 20);
      ev('pointermove', ox, oy); ev('pointerdown', ox, oy);
      for (let p = 1; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        ev('pointermove', ox + span * 0.5 * (1 + Math.cos(a)), oy + span * 0.5 * (1 + Math.sin(a)));
        await raf();
      }
      ev('pointerup', ox + span * 0.5, oy + span);
      await raf(); await raf();
    }
  };

  const tool = app.toolManager.getTool('pattern');
  if (!tool) throw new Error('pattern tool not found');
  if (typeof tool._boundsToRect !== 'function' || typeof tool._getCompositeSurface !== 'function') {
    throw new Error('this build predates the pooled/clipped composite — nothing to A/B');
  }

  const NEW_boundsToRect = tool._boundsToRect.bind(tool);
  const NEW_getSurface = tool._getCompositeSurface.bind(tool);

  const OLD_boundsToRect = (bounds, w, h) => ({ x: 0, y: 0, w, h });
  const OLD_getSurface = (user, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Fresh canvases are already transparent; the pre-change code never cleared.
    ctx.clearRect = () => {};
    window.__stats.allocs++;
    return { canvas, ctx };
  };

  // Mechanism counters, so a null result can be told apart from "the arms did
  // the same work". Reset by __measure.
  window.__stats = { builds: 0, allocs: 0, px: 0 };
  const rawBuild = tool._buildPatternComposite.bind(tool);
  tool._buildPatternComposite = function (...args) {
    const out = rawBuild(...args);
    window.__stats.builds++;
    if (out?.rect) window.__stats.px += out.rect.w * out.rect.h;
    return out;
  };

  window.__setVariant = (which) => {
    tool._boundsToRect = which === 'old' ? OLD_boundsToRect : NEW_boundsToRect;
    tool._getCompositeSurface = which === 'old' ? OLD_getSurface : NEW_getSurface;
    // Neither arm may inherit the other's held or pooled surfaces.
    tool._compositeSurfaces.clear();
    tool._compositePool.length = 0;
    app.board.markCompositeFull();
    return which;
  };

  // Guard the trap that would make every number meaningless: with no pattern
  // brush loaded, _getPatternTile returns null, _buildPatternComposite bails
  // before doing any work, and both arms report a clean idle board.
  window.__patternReady = () => {
    const tile = tool._getPatternTile(app.self);
    return !!(tile && tile.width > 0 && tile.height > 0);
  };

  window.__measure = async function (cfg) {
    const f = window.__frames;
    const before = app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
    window.__stats = { builds: 0, allocs: 0, px: 0 };
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    const ms = performance.now() - t0;
    f.on = false;
    const after = app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0);
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    const s = window.__stats;
    return {
      committed: after - before,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1),
      over20: g.filter(v => v > 20).length,
      over50: g.filter(v => v > 50).length,
      frames: g.length,
      builds: s.builds,
      allocs: s.allocs,
      mpx: +(s.px / 1e6).toFixed(1)
    };
  };
  return true;
})()`;

const med = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : +(((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1));
};

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP);
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `pab_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'PAB'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board is ${actual} not ${dims} — the room overrode the local resize`);
    }

    const got = await page.evaluate((t) => { window.app.selectTool(t); return window.app.self?.tool; }, TOOL);
    if (got !== TOOL) throw new Error(`tool did not take: ${got}`);

    // The default circle pattern is built from a data: URL, so the Image decode
    // is async. Without a tile there is no composite and no cost to measure.
    await page.waitForFunction(() => window.__patternReady(), { timeout: 30_000 });

    console.log(`\n=== pattern A/B  tool=${TOOL}  ${SIZE} (${actual[1]}x${actual[0]})  span=${SPAN}`
      + `  ${REPS} reps x ${STROKES} strokes, interleaved, solo\n`);

    // Cold arm: JIT and first-touch allocation land here. Reported, not discarded.
    await page.evaluate(() => window.__setVariant('new'));
    const cold = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
    console.log('  rep  variant     fps     p50     p99   >20ms   >50ms  builds  allocs    Mpx');
    const row = (label, r) => console.log(`  ${label.padEnd(3)}  ${String(r.variant ?? '').padEnd(8)}`
      + `${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
      + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}`
      + `${String(r.builds).padStart(8)}${String(r.allocs).padStart(8)}${String(r.mpx).padStart(7)}`);
    row('c', { ...cold, variant: 'new/cold' });

    const runs = { old: [], new: [] };
    for (let i = 0; i < REPS; i++) {
      // Alternate the leading arm each rep so any within-rep warming is shared.
      const order = i % 2 === 0 ? ['old', 'new'] : ['new', 'old'];
      for (const variant of order) {
        await page.evaluate((v) => window.__setVariant(v), variant);
        await sleep(400);
        const r = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
        if (r.committed <= 0) throw new Error('0 strokes committed — pointer events not reaching the app');
        if (r.builds <= 0) throw new Error('0 composites built — the pattern path never ran');
        runs[variant].push(r);
        row(String(i + 1), { ...r, variant });
      }
    }

    console.log('\n  medians:');
    console.log('  variant     fps     p50     p99   >20ms   >50ms  builds  allocs    Mpx');
    for (const v of ['old', 'new']) {
      const R = runs[v];
      console.log(`  ${v.padEnd(8)}`
        + `${String(med(R.map(r => r.fps))).padStart(8)}`
        + `${String(med(R.map(r => r.p50))).padStart(8)}`
        + `${String(med(R.map(r => r.p99))).padStart(8)}`
        + `${String(med(R.map(r => r.over20))).padStart(8)}`
        + `${String(med(R.map(r => r.over50))).padStart(8)}`
        + `${String(med(R.map(r => r.builds))).padStart(8)}`
        + `${String(med(R.map(r => r.allocs))).padStart(8)}`
        + `${String(med(R.map(r => r.mpx))).padStart(7)}`);
    }
    const oFps = runs.old.map(r => r.fps); const nFps = runs.new.map(r => r.fps);
    const overlap = Math.min(...nFps) <= Math.max(...oFps) && Math.min(...oFps) <= Math.max(...nFps);
    const oMed = med(oFps), nMed = med(nFps);
    console.log(`\n  old fps range [${Math.min(...oFps)}, ${Math.max(...oFps)}]  `
      + `new fps range [${Math.min(...nFps)}, ${Math.max(...nFps)}]`);
    console.log(`  median fps ${oMed} -> ${nMed}  (${oMed ? (((nMed - oMed) / oMed) * 100).toFixed(1) : '?'} %)`);
    console.log(`  distributions ${overlap ? 'OVERLAP — not distinguishable at this rep count' : 'do NOT overlap'}\n`);
  } finally {
    await browser.disconnect();
  }
})();
