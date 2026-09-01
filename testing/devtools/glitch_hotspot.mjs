#!/usr/bin/env node
/**
 * @fileoverview Attribution probe for GlitchBlurTool's remaining per-stamp cost.
 *
 * The per-stroke layer filter took glitch from 5.5 to 10.3 fps, but brush is
 * ~51 on the same box, so the single-layer path is still ~5x too expensive.
 * Renderer main is pinned, so a JS sampling profile names the canvas raster and
 * not the caller; this wraps the render-path methods with counters and timers
 * instead, the same approach eraser_hotspot.mjs uses.
 *
 * Splits `_computeGlitchStamp` into the crop half (canvas alloc + drawImage +
 * getImageData readback) and the remainder (WASM blur + putImageData), because
 * those two want completely different fixes.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/glitch_hotspot.mjs
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const STROKES = Number(arg('strokes', 4));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = { '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], big: [1800, 3200] };
const dims = BOARD_SIZES[SIZE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `(() => {
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

  const tool = app.toolManager.getTool('glitchBlur');
  const T = {};
  const mk = (name) => (T[name] = { n: 0, ms: 0, px: 0 });
  ['crop', 'computeStamp', 'applyStamp', 'captureSnapshot', 'findBounds'].forEach(mk);
  window.__T = T;

  const wrap = (obj, name, key, pxOf) => {
    const orig = obj[name].bind(obj);
    obj[name] = function (...a) {
      const t0 = performance.now();
      const out = orig(...a);
      const rec = T[key];
      rec.n++; rec.ms += performance.now() - t0;
      if (pxOf) rec.px += pxOf(out, a) || 0;
      return out;
    };
  };

  wrap(tool, '_cropSnapshotRegion', 'crop', (out) => (out ? out.cropW * out.cropH : 0));
  wrap(tool, '_computeGlitchStamp', 'computeStamp');
  wrap(tool, '_applyStampToCtx', 'applyStamp');
  wrap(tool, 'captureSnapshot', 'captureSnapshot');
  wrap(tool, '_findStrokeContentBounds', 'findBounds');

  window.__reset = () => { for (const k of Object.keys(T)) { T[k].n = 0; T[k].ms = 0; T[k].px = 0; } };
  window.__report = () => {
    const out = {};
    for (const [k, v] of Object.entries(T)) {
      out[k] = { calls: v.n, totalMs: +v.ms.toFixed(1), perCallMs: v.n ? +(v.ms / v.n).toFixed(3) : 0,
                 Mpx: +(v.px / 1e6).toFixed(2) };
    }
    // The WASM blur + putImageData is what computeStamp does that crop does not.
    out.blurAndUpload = {
      calls: T.computeStamp.n,
      totalMs: +(T.computeStamp.ms - T.crop.ms).toFixed(1),
      perCallMs: T.computeStamp.n ? +((T.computeStamp.ms - T.crop.ms) / T.computeStamp.n).toFixed(3) : 0,
      Mpx: 0
    };
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
    await page.evaluate(SETUP);
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `gh_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'GH'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    // Give the glitch something real to smear.
    await page.evaluate(() => window.app.selectTool('brush'));
    await page.evaluate((sp) => window.__drive({ strokes: 3, pts: 30, span: sp }), SPAN);
    await sleep(500);

    await page.evaluate(() => window.app.selectTool('glitchBlur'));
    const cfg = await page.evaluate(() => ({
      size: window.app.self.size,
      blurRadius: window.app.self.blurRadius,
      fastPreview: !!window.app.glitchFastPreview
    }));

    await page.evaluate((s, sp) => window.__drive({ strokes: 1, pts: 30, span: sp }), 1, SPAN); // warm
    await page.evaluate(() => window.__reset());
    const t0 = Date.now();
    await page.evaluate((s, sp) => window.__drive({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
    const wall = Date.now() - t0;
    const rep = await page.evaluate(() => window.__report());

    console.log(`\n=== glitchBlur hotspot  ${SIZE}  span=${SPAN}  ${STROKES} strokes  wall=${wall} ms`);
    console.log(`    brush size=${cfg.size}  blurRadius=${cfg.blurRadius}  fastPreview=${cfg.fastPreview}\n`);
    console.log('  stage                calls   total ms   per call ms    Mpx    % of wall');
    for (const [k, v] of Object.entries(rep)) {
      console.log(`  ${k.padEnd(18)}${String(v.calls).padStart(7)}${String(v.totalMs).padStart(11)}`
        + `${String(v.perCallMs).padStart(14)}${String(v.Mpx).padStart(8)}`
        + `${((v.totalMs / wall) * 100).toFixed(1).padStart(11)}`);
    }
    console.log('');
  } finally {
    await browser.disconnect();
  }
})();
