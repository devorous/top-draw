#!/usr/bin/env node
/**
 * @fileoverview Generic per-stage attribution for a drawing tool.
 *
 * Wraps the tool's own paint entry point plus the Board/LayerManager composite
 * methods with counters and timers, then drives a fixed stroke workload. Answers
 * the first question you need before optimising anything: is the cost inside the
 * tool's stamp, or in the compositing the stamp triggers?
 *
 * Renderer main is pinned during these workloads, so a JS sampling profile
 * attributes the time to canvas raster rather than to the caller — hence
 * explicit wrappers. Same approach as eraser_hotspot.mjs and glitch_hotspot.mjs.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/tool_stage_probe.mjs --tool=blur
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const TOOL = arg('tool', 'blur');
const STROKES = Number(arg('strokes', 6));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = { '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], big: [1800, 3200] };
const dims = BOARD_SIZES[SIZE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tool entry points worth timing, per tool. Anything absent is skipped.
const TOOL_METHODS = {
  blur: ['paintMask', '_moveStroke', 'captureSnapshot'],
  circleBlur: ['paintMask', '_moveStroke', 'captureSnapshot'],
  glitchBlur: ['_stampGlitchAtPoint', '_cropSnapshotRegion', 'captureSnapshot'],
  pattern: ['_stampMask', '_buildPatternComposite', '_drawPreview'],
  erase: ['drawPreview', '_stampPoint'],
  brush: ['drawPreview'],
  ink: ['drawPreview'],
  pixel: ['drawPreview']
};

const SETUP = (tool, methods) => `(() => {
  const app = window.app;

  window.__lockBoardSize = function (h, w) {
    const board = app.board;
    board.resizeBoard([h, w]);
    app._bindLayerManagerDependencies?.();
    const orig = board.resizeBoard.bind(board);
    board.resizeBoard = (d) => { if (!d || d[0] !== h || d[1] !== w) return; return orig(d); };
  };

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

  const T = {};
  window.__T = T;
  // Nesting-aware: a wrapped method that calls another wrapped method would
  // otherwise have the inner time counted twice and percentages over 100.
  let depth = 0;
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return false;
    T[label] = { n: 0, ms: 0, selfMs: 0 };
    const orig = obj[name].bind(obj);
    let childMs = 0;
    obj[name] = function (...a) {
      const parentChild = childMs;
      childMs = 0;
      const t0 = performance.now();
      const out = orig(...a);
      const dt = performance.now() - t0;
      const rec = T[label];
      rec.n++; rec.ms += dt; rec.selfMs += dt - childMs;
      childMs = parentChild + dt;
      return out;
    };
    return true;
  };

  const tool = app.toolManager.getTool(${JSON.stringify(tool)});
  if (!tool) throw new Error('tool not found');
  const wrapped = [];
  for (const m of ${JSON.stringify(methods)}) {
    if (wrap(tool, m, 'tool.' + m)) wrapped.push(m);
  }
  window.__wrapped = wrapped;

  // Re-armed per run: resizeBoard() replaces the LayerManager instance.
  window.__armBoard = function () {
    const board = app.board;
    const lm = board.layerManager;
    if (!board.__stageHooked) {
      board.__stageHooked = true;
      wrap(board, 'compositeAllLayers', 'board.compositeAllLayers');
      wrap(board, 'requestUpdate', 'board.requestUpdate');
    }
    if (lm && !lm.__stageHooked) {
      lm.__stageHooked = true;
      wrap(lm, 'compositeLayerRange', 'lm.compositeLayerRange');
      wrap(lm, 'commitUserStroke', 'lm.commitUserStroke');
    }
  };

  window.__reset = () => { for (const k of Object.keys(T)) { T[k].n = 0; T[k].ms = 0; T[k].selfMs = 0; } };
  window.__report = () => {
    const out = {};
    for (const [k, v] of Object.entries(T)) {
      out[k] = { calls: v.n, totalMs: +v.ms.toFixed(1), selfMs: +v.selfMs.toFixed(1),
                 perCallMs: v.n ? +(v.ms / v.n).toFixed(3) : 0 };
    }
    return out;
  };
  return true;
})()`;

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP(TOOL, TOOL_METHODS[TOOL] || []));
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `sp_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'SP'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);
    await page.evaluate(() => window.__armBoard());

    // Something for a sampling tool to work on.
    await page.evaluate(() => window.app.selectTool('brush'));
    await page.evaluate((sp) => window.__drive({ strokes: 3, pts: 30, span: sp }), SPAN);
    await sleep(400);

    const got = await page.evaluate((t) => { window.app.selectTool(t); return window.app.self?.tool; }, TOOL);
    if (got !== TOOL) throw new Error(`tool did not take: ${got}`);
    await page.evaluate((sp) => window.__drive({ strokes: 1, pts: 30, span: sp }), SPAN); // warm

    await page.evaluate(() => window.__reset());
    const t0 = Date.now();
    await page.evaluate((s, sp) => window.__drive({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
    const wall = Date.now() - t0;
    const rep = await page.evaluate(() => window.__report());
    const wrapped = await page.evaluate(() => window.__wrapped);

    console.log(`\n=== ${TOOL} stage probe  ${SIZE}  span=${SPAN}  ${STROKES} strokes  wall=${wall} ms`);
    console.log(`    tool methods wrapped: ${wrapped.join(', ') || '(none)'}\n`);
    console.log('  stage                          calls   total ms    self ms   per call   % wall (self)');
    const rows = Object.entries(rep).sort((a, b) => b[1].selfMs - a[1].selfMs);
    for (const [k, v] of rows) {
      console.log(`  ${k.padEnd(28)}${String(v.calls).padStart(7)}${String(v.totalMs).padStart(11)}`
        + `${String(v.selfMs).padStart(11)}${String(v.perCallMs).padStart(11)}`
        + `${((v.selfMs / wall) * 100).toFixed(1).padStart(14)}`);
    }
    console.log('');
  } finally {
    await browser.disconnect();
  }
})();
