#!/usr/bin/env node
/**
 * @fileoverview Per-tool frame-cost baseline on a real weak client, solo.
 *
 * The existing per-tool ranking ([[per_tool_cost_ranking]]) was taken on the
 * fast dev box with 6 k6 bots, so it ranks the REMOTE render path. This one
 * runs solo on the Chromebook and ranks what the drawing user's own machine
 * pays — which is the regime the stutter reports come from (1-2 users).
 *
 * Drift is the enemy here: sequential runs on that box slide downward across a
 * session by more than the differences between tools. So every tool is measured
 * once per rep, the rotation is offset each rep so no tool keeps a favourable
 * slot, and `brush` is carried in every rep as a drift control — read the
 * ratio of each tool to the brush in ITS OWN rep, not the raw fps.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/tools_baseline.mjs \
 *     --reps=3 --strokes=6 --tools=brush,pattern,erase,blur,ink
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const DEFAULT_TOOLS = [
  'brush', 'flowPen', 'ink', 'pixel', 'erase',
  'pattern', 'imageBrush', 'confetti', 'blur', 'circleBlur', 'glitchBlur',
  'line', 'rectangle', 'circle'
];

const REPS = Number(arg('reps', 3));
const STROKES = Number(arg('strokes', 6));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const CONTROL = arg('control', 'brush');
const TOOLS = (arg('tools', null)?.split(',').map((t) => t.trim()).filter(Boolean)) || DEFAULT_TOOLS;
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

  window.__selectTool = async function (name) {
    app.selectTool(name);
    // Pattern and imageBrush lazily build a default brush from a data: URL, so
    // the decode is async; with no tile/image the tool bails before doing any
    // work and reports a clean idle board.
    const needsImage = name === 'pattern' || name === 'imageBrush';
    if (needsImage) {
      const t0 = performance.now();
      while (performance.now() - t0 < 15000) {
        const tool = app.toolManager.getTool(name);
        const ok = name === 'pattern'
          ? !!tool._getPatternTile?.(app.self)?.width
          : !!(app.self.imageBrush?.image?.width || app.self.imageBrush?.gBrushes?.length);
        if (ok) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    return app.self?.tool;
  };

  // Stroke COUNTER, not strokeStack.length. The stack prefix-bakes at
  // MAX_STROKES_PER_USER (20), so after ~20 strokes in a room its length stops
  // growing and a length-delta check reports "0 strokes committed" for a tool
  // that drew perfectly well. That produced two bogus SKIPs before it was
  // caught, and a SKIP is indistinguishable from a real failure in the output.
  // Count LayerManager.commitUserStroke, not board.endStroke. Two reasons:
  // strokeStack.length prefix-bakes at MAX_STROKES_PER_USER (20) so a length
  // delta reports "0 committed" for a tool that drew fine, and glitchBlur never
  // calls board.endStroke at all — it commits per target layer directly. Both
  // produced bogus SKIPs before this was caught, and a SKIP is indistinguishable
  // from a real failure in the output.
  // Re-armed before every measurement, not installed once: resizeBoard() calls
  // _createLayerManager() and hands back a BRAND NEW LayerManager, so a hook
  // installed during setup is silently discarded by the board-size lock and the
  // counter reads zero forever after.
  window.__strokeCount = 0;
  window.__ensureCommitHook = function () {
    const lm = app.board.layerManager;
    if (!lm || lm.__commitHooked) return;
    lm.__commitHooked = true;
    const orig = lm.commitUserStroke.bind(lm);
    lm.commitUserStroke = function (...a) { window.__strokeCount++; return orig(...a); };
  };

  window.__measure = async function (cfg) {
    window.__ensureCommitHook();
    window.__resetBoard();
    const f = window.__frames;
    const before = window.__strokeCount;
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    const ms = performance.now() - t0;
    f.on = false;
    const after = window.__strokeCount;
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    return {
      committed: after - before,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(1), p99: +pct(0.99).toFixed(1),
      over20: g.filter(v => v > 20).length,
      over50: g.filter(v => v > 50).length,
      frames: g.length,
      // Tools share the User object, so one tool can leave state that makes the
      // NEXT tool slower. Reported per row so an outlier can be traced to the
      // knob that caused it rather than blamed on the tool.
      st: {
        size: +Number(app.self.size).toFixed(1),
        spacing: app.self.spacing,
        blurRadius: app.self.blurRadius,
        smoothing: app.self.smoothing,
        opacity: +Number(app.self.opacity ?? 1).toFixed(2),
        pressure: +Number(app.self.pressure ?? 1).toFixed(2)
      }
    };
  };

  /**
   * Put the board in ONE fixed state before every tool measurement.
   *
   * Clearing once per rep is not enough and actively misleads. Tools whose cost
   * depends on what is already on the board (blur samples beneath itself; every
   * tool pays the per-frame composite of the live strokeStack) get charged for
   * their SLOT in the rotation rather than for themselves — and rotating by one
   * slot per rep only decorrelates that if reps >= tools. Measured: blur read
   * 25-39 fps late in a rotation and 50.2 (0.98x brush) with the board reset,
   * which is a completely different conclusion about the same tool.
   *
   * A painted base rather than an empty board, because an empty board measures
   * a blur that has nothing to do.
   */
  window.__resetBoard = function () {
    try {
      // board.clear() directly, not app.handleClear() — that one is
      // moderator-gated and broadcasts.
      app.board.clear();
      app.board.tileTracker?.clear?.();
      const ctx = app.board.layerManager.layerGroups[0].flatCtx;
      const [bh, bw] = app.board.dimensions;
      for (let i = 0; i < 600; i++) {
        ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
        ctx.fillRect((i % 30) * (bw / 30), Math.floor(i / 30) * (bh / 20), bw / 30 - 4, bh / 20 - 4);
      }
      app.board.markCompositeFull();
      app.board.compositeAllLayers();
    } catch { /* best effort */ }
  };
  return true;
})()`;

const med = (v) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
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

    const room = `tb_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'TB'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board is ${actual} not ${dims} — the room overrode the local resize`);
    }

    // The control must be present in every rep or the drift normalisation has
    // nothing to key on.
    const order = TOOLS.includes(CONTROL) ? [...TOOLS] : [CONTROL, ...TOOLS];

    console.log(`\n=== per-tool baseline  ${SIZE} (${actual[1]}x${actual[0]})  span=${SPAN}`
      + `  ${REPS} reps x ${STROKES} strokes, solo, rotated order, control=${CONTROL}\n`);

    const results = new Map(order.map((t) => [t, []]));
    const skipped = [];

    // Cold rep: JIT and first-touch allocation land here. Reported, not discarded.
    console.log('  rep  tool             fps     p50     p99   >20ms   >50ms  commits   size  spac  blurR  smoo   opac');
    for (let i = 0; i < REPS + 1; i++) {
      const cold = i === 0;
      // Offset the rotation each rep so no tool keeps a favourable slot.
      const rot = order.slice(i % order.length).concat(order.slice(0, i % order.length));
      for (const tool of rot) {
        if (skipped.includes(tool)) continue;
        const got = await page.evaluate((t) => window.__selectTool(t), tool);
        if (got !== tool) {
          console.log(`  ${cold ? 'c' : String(i)}    ${tool.padEnd(12)}  SKIPPED — selectTool gave "${got}"`);
          skipped.push(tool);
          continue;
        }
        await sleep(250);
        const r = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
        if (r.committed <= 0) {
          console.log(`  ${cold ? 'c' : String(i)}    ${tool.padEnd(12)}  SKIPPED — 0 strokes committed`);
          skipped.push(tool);
          continue;
        }
        if (!cold) results.get(tool).push(r);
        console.log(`  ${(cold ? 'c' : String(i)).padStart(3)}  ${tool.padEnd(12)}`
          + `${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
          + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}${String(r.committed).padStart(9)}`
          + `${String(r.st.size).padStart(7)}${String(r.st.spacing).padStart(6)}`
          + `${String(r.st.blurRadius).padStart(7)}${String(r.st.smoothing).padStart(6)}`
          + `${String(r.st.opacity).padStart(7)}`);
      }
      await sleep(300);
    }

    const controlFps = med((results.get(CONTROL) || []).map((r) => r.fps));
    const rows = [...results.entries()]
      .filter(([, R]) => R.length)
      .map(([tool, R]) => ({
        tool,
        fps: med(R.map((r) => r.fps)),
        p50: med(R.map((r) => r.p50)),
        p99: med(R.map((r) => r.p99)),
        over20: med(R.map((r) => r.over20)),
        over50: med(R.map((r) => r.over50)),
        lo: Math.min(...R.map((r) => r.fps)),
        hi: Math.max(...R.map((r) => r.fps))
      }))
      .sort((a, b) => a.fps - b.fps);

    console.log(`\n  medians, worst first (control ${CONTROL} = ${controlFps} fps):`);
    console.log('  tool             fps   vs ctl     p50     p99   >20ms   >50ms   fps range');
    for (const r of rows) {
      const ratio = controlFps ? (r.fps / controlFps).toFixed(2) : '?';
      console.log(`  ${r.tool.padEnd(12)}${String(r.fps).padStart(8)}${String(ratio).padStart(9)}`
        + `${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
        + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}`
        + `   [${r.lo}, ${r.hi}]`);
    }
    if (skipped.length) console.log(`\n  skipped (no strokes committed / tool did not take): ${skipped.join(', ')}`);
    console.log('');
  } finally {
    await browser.disconnect();
  }
})();
