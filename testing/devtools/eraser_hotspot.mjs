#!/usr/bin/env node
/**
 * @fileoverview Attributes the eraser's per-tick cost to individual canvas ops.
 *
 * board_perf_suite says the eraser is ~2x the brush solo at 1440p with the
 * renderer main thread at 98 % while ScriptDuration is only 33 %. That shape
 * means the time is inside canvas 2D raster calls, not in the JS around them,
 * so a JS sampling profile will not name the culprit. This wraps the specific
 * methods on the eraser's path with a call counter and a wall-clock accumulator
 * and drives the same synthetic strokes the perf suite uses.
 *
 * It also records the RECT AREA each op was handed, because the whole question
 * is whether a given call is doing dirty-rect work or full-board work.
 *
 * Usage (attach to the Chromebook through the ssh -L 9222 forward):
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/eraser_hotspot.mjs --tool=erase
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/eraser_hotspot.mjs --tool=brush
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const TOOL = arg('tool', 'erase');
const SIZE = arg('size', '1440p');
const STROKES = Number(arg('strokes', 10));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], 'big': [1800, 3200]
};
const dims = BOARD_SIZES[SIZE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same pointer driver as board_perf_suite: pointerdown on #board, move/up on
// window. Sending all three to one element commits nothing and reports perfect
// numbers, which is the most dangerous failure mode this rig has.
const DRIVER = `(() => {
  window.__lockBoardSize = function (h, w) {
    const board = window.app.board;
    board.resizeBoard([h, w]);
    window.app._bindLayerManagerDependencies?.();
    const orig = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => { if (!d || d[0] !== h || d[1] !== w) return; return orig(d); };
  };
  window.__drive = async function ({ strokes, pts = 30 }) {
    const app = window.app;
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    const span = 400;
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
  return true;
})()`;

// Wrap the methods on the eraser/brush render path. `area` is recorded as a
// fraction of the board so "full-board" vs "dirty-rect" is readable at a glance
// instead of having to be inferred from a millisecond total.
const INSTRUMENT = `(() => {
  const app = window.app;
  const [bh, bw] = app.board.dimensions;
  const boardArea = bh * bw;
  const S = window.__stats = new Map();

  const rec = (name, ms, area) => {
    let e = S.get(name);
    if (!e) { e = { calls: 0, ms: 0, fullBoard: 0, areaSum: 0 }; S.set(name, e); }
    e.calls++; e.ms += ms;
    if (area != null) { e.areaSum += area; if (area >= boardArea * 0.95) e.fullBoard++; }
  };

  const wrap = (obj, name, label, areaOf) => {
    if (!obj || typeof obj[name] !== 'function' || obj[name].__wrapped) return;
    const orig = obj[name];
    const fn = function (...a) {
      const t = performance.now();
      try { return orig.apply(this, a); }
      finally { rec(label, performance.now() - t, areaOf ? areaOf(a, this) : null); }
    };
    fn.__wrapped = true;
    obj[name] = fn;
  };

  const rectArea = (r) => (r && Number.isFinite(r.x) && r.width > 0 && r.height > 0)
    ? r.width * r.height : boardArea;   // null rect == unclipped == full board

  const eraser = app.toolManager.getTool('erase');
  const brush = app.toolManager.getTool('brush');
  const lm = app.board.layerManager;
  const board = app.board;

  if (eraser) {
    const P = Object.getPrototypeOf(eraser);
    wrap(P, 'drawPreview', 'Eraser.drawPreview', (a) => rectArea(a[1]));
    // _renderPreviewMask was the bg-colour tint pass; removed. wrap() no-ops on
    // a missing method, so this line stays harmless and marks what used to cost.
    wrap(P, '_renderPreviewMask', 'Eraser._renderPreviewMask', (a) => rectArea(a[2]));
    wrap(P, '_renderPreviewPath', 'Eraser._renderPreviewPath', (a) => rectArea(a[2]));
    wrap(P, '_publishPreviewStroke', 'Eraser._publishPreviewStroke', (a) => rectArea(a[2]));
    wrap(P, '_stampCircle', 'Eraser._stampCircle');
    wrap(P, '_stampPoint', 'Eraser._stampPoint');
    wrap(P, 'commitCurrentLine', 'Eraser.commitCurrentLine');
    wrap(P, 'eraseMaskOnGroup', 'Eraser.eraseMaskOnGroup');
    wrap(P, '_createStrokeState', 'Eraser._createStrokeState(ALLOC)');
  }
  if (brush) {
    const P = Object.getPrototypeOf(brush);
    wrap(P, 'drawPreview', 'Brush.drawPreview', (a) => rectArea(a[1]));
  }

  wrap(lm, 'setUserPreviewStroke', 'LM.setUserPreviewStroke', (a) => rectArea(a[4]));
  wrap(lm, '_copyPreviewSource', 'LM._copyPreviewSource', (a) => rectArea(a[2]));
  wrap(lm, 'compositeLayerRange', 'LM.compositeLayerRange', (a) => {
    const rects = a[4];
    if (!Array.isArray(rects) || rects.length === 0) return boardArea;
    return rects.reduce((s, r) => s + r.width * r.height, 0);
  });
  wrap(lm, '_compositeGroupIsolated', 'LM._compositeGroupIsolated');
  wrap(lm, '_compositeGroupWithFlatCanvas', 'LM._compositeGroupWithFlatCanvas');
  wrap(lm, '_compositeGroupSequential', 'LM._compositeGroupSequential(ALLOC)');
  wrap(lm, '_compositeGroupInto', 'LM._compositeGroupInto');
  wrap(lm, '_acquireCanvas', 'LM._acquireCanvas');

  wrap(board, 'compositeAllLayers', 'Board.compositeAllLayers');
  wrap(board, 'clearTop', 'Board.clearTop', (a) => rectArea(a[0]));
  wrap(board, '_compositeUpperLayers', 'Board._compositeUpperLayers');
  wrap(board, '_applyEraserPreviewToMain', 'Board._applyEraserPreviewToMain');

  window.__resetStats = () => S.clear();
  window.__readStats = () => [...S].map(([name, e]) => ({
    name, calls: e.calls, ms: +e.ms.toFixed(1),
    perCall: +(e.ms / e.calls).toFixed(3),
    fullBoardCalls: e.fullBoard,
    avgAreaPct: e.areaSum ? +((e.areaSum / e.calls / boardArea) * 100).toFixed(1) : null
  })).sort((a, b) => b.ms - a.ms);
  return true;
})()`;

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(DRIVER);
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `hot_${TOOL}_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'HOT'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(
      () => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT }
    );
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const got = await page.evaluate((t) => { window.app.selectTool(t); return window.app.self?.tool; }, TOOL);
    if (got !== TOOL) throw new Error(`tool did not take: ${got}`);

    await page.evaluate(INSTRUMENT);
    // One untimed stroke so first-call allocation and JIT land outside the
    // measured set rather than being reported as a steady-state per-call cost.
    await page.evaluate(() => window.__drive({ strokes: 1, pts: 20 }));
    await page.evaluate(() => window.__resetStats());

    const t0 = Date.now();
    await page.evaluate((s) => window.__drive({ strokes: s, pts: 30 }), STROKES);
    const wallMs = Date.now() - t0;

    const stats = await page.evaluate(() => window.__readStats());
    const committed = await page.evaluate(() =>
      window.app.board.layerManager.layerGroups.reduce((n, g) => n + g.strokeStack.length, 0));

    if (committed <= 0) throw new Error('0 strokes committed — pointer events never reached the app');

    console.log(`\n=== eraser_hotspot  tool=${TOOL}  ${SIZE} ${dims[1]}x${dims[0]}  ${STROKES} strokes  ${wallMs} ms wall\n`);
    console.log('  ' + 'method'.padEnd(38) + 'calls'.padStart(7) + 'total ms'.padStart(11)
      + 'per call'.padStart(10) + 'avg area%'.padStart(11) + 'fullboard'.padStart(11));
    for (const s of stats) {
      console.log('  ' + s.name.padEnd(38)
        + String(s.calls).padStart(7)
        + String(s.ms).padStart(11)
        + String(s.perCall).padStart(10)
        + String(s.avgAreaPct ?? '-').padStart(11)
        + String(s.fullBoardCalls || '').padStart(11));
    }
    const total = stats.reduce((n, s) => n + s.ms, 0);
    console.log(`\n  (totals nest — a parent's ms contains its children's)`);
    console.log(`  wall ${wallMs} ms, strokes committed ${committed}\n`);
  } finally {
    await browser.disconnect();
  }
})();
