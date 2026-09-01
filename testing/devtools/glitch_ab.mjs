#!/usr/bin/env node
/**
 * @fileoverview Paired A/B for GlitchBlurTool's per-stroke layer selection.
 *
 * OLD is the shipped-until-2026-08-31 behaviour: every glitch stroke targeted
 * ALL three candidate layers unconditionally — a full-board snapshot canvas plus
 * a `compositeLayerRange` per layer at pointerDown, then a crop canvas +
 * `getImageData` readback + WASM blur + `putImageData` upload per stamp point
 * per layer. On the usual board (content on layer 0, nothing above) two thirds
 * of that was provably wasted.
 *
 * NEW filters the set through `LayerManager.rangeHasRenderableContent` once, at
 * pointerDown. The OLD arm is reproduced by swapping `_computeStrokeLayers` back
 * to the unfiltered list — the seam is one function, so both arms run the rest
 * of the current source.
 *
 * `--content=upper` also puts a stroke on layer 1 before measuring, which is the
 * case the filter CANNOT skip: it verifies the fix costs nothing when the layers
 * really are occupied, i.e. that the win is not just "we stopped drawing".
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/glitch_ab.mjs --reps=3
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/glitch_ab.mjs --content=upper
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const REPS = Number(arg('reps', 3));
const STROKES = Number(arg('strokes', 4));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const CONTENT = arg('content', 'layer0'); // layer0 | upper
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
  if (!tool) throw new Error('glitchBlur tool not found');
  if (typeof tool._computeStrokeLayers !== 'function') {
    throw new Error('this build predates the per-stroke layer filter — nothing to A/B');
  }

  const NEW_compute = tool._computeStrokeLayers.bind(tool);
  const OLD_compute = function (user, userId) {
    const all = tool._getTargetLayers();
    tool.strokeLayersByUser.set(userId, all);
    window.__stats.layers += all.length;
    return all;
  };
  const COUNTED_NEW = function (user, userId) {
    const out = NEW_compute(user, userId);
    window.__stats.layers += out.length;
    return out;
  };

  window.__stats = { layers: 0, strokes: 0 };

  window.__setVariant = (which) => {
    tool._computeStrokeLayers = which === 'old' ? OLD_compute : COUNTED_NEW;
    return which;
  };

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

  // Put real content on layer 1 so the filter has nothing to skip. Drawn
  // directly onto the layer's baked surface, which is what
  // rangeHasRenderableContent keys on.
  window.__seedUpperLayer = function () {
    const lm = app.board.layerManager;
    const group = lm.layerGroups[1];
    if (!group) return false;
    const [bh, bw] = app.board.dimensions;
    if (!group.flatCanvas) {
      const c = document.createElement('canvas');
      c.width = bw; c.height = bh;
      group.flatCanvas = c;
      group.flatCtx = c.getContext('2d');
    }
    group.flatCtx.fillStyle = 'rgba(120,200,255,0.9)';
    group.flatCtx.fillRect(0, 0, bw, bh);
    app.board.markCompositeFull();
    return lm.rangeHasRenderableContent(1, 2);
  };

  window.__layersUsed = () => {
    const probe = tool._getTargetLayers();
    const lm = app.board.layerManager;
    return probe.filter((i) => i === 0 || lm.rangeHasRenderableContent(i, i + 1)).length;
  };

  window.__measure = async function (cfg) {
    window.__ensureCommitHook();
    const f = window.__frames;
    const before = window.__strokeCount;
    window.__stats = { layers: 0, strokes: 0 };
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    const ms = performance.now() - t0;
    f.on = false;
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    return {
      committed: window.__strokeCount - before,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(1), p99: +pct(0.99).toFixed(1),
      over20: g.filter(v => v > 20).length,
      over50: g.filter(v => v > 50).length,
      layers: window.__stats.layers
    };
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

    const room = `gab_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'GAB'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board is ${actual} not ${dims} — the room overrode the local resize`);
    }

    if (CONTENT === 'upper') {
      const seeded = await page.evaluate(() => window.__seedUpperLayer());
      if (!seeded) throw new Error('could not seed layer 1 — the "no win available" arm would be a lie');
    }

    const got = await page.evaluate(() => { window.app.selectTool('glitchBlur'); return window.app.self?.tool; });
    if (got !== 'glitchBlur') throw new Error(`tool did not take: ${got}`);
    const layersUsed = await page.evaluate(() => window.__layersUsed());

    console.log(`\n=== glitchBlur A/B  ${SIZE} (${actual[1]}x${actual[0]})  span=${SPAN}  content=${CONTENT}`
      + `  ${REPS} reps x ${STROKES} strokes, interleaved, solo`);
    console.log(`    NEW should target ${layersUsed} layer(s) per stroke, OLD always 3\n`);

    await page.evaluate(() => window.__setVariant('new'));
    const cold = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
    console.log('  rep  variant     fps     p50     p99   >20ms   >50ms  layers  strokes');
    const row = (label, variant, r) => console.log(`  ${label.padStart(3)}  ${variant.padEnd(8)}`
      + `${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
      + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}`
      + `${String(r.layers).padStart(8)}${String(r.committed).padStart(9)}`);
    row('c', 'new/cold', cold);

    const runs = { old: [], new: [] };
    for (let i = 0; i < REPS; i++) {
      const order = i % 2 === 0 ? ['old', 'new'] : ['new', 'old'];
      for (const variant of order) {
        await page.evaluate((v) => window.__setVariant(v), variant);
        await sleep(400);
        const r = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
        if (r.committed <= 0) throw new Error('0 strokes committed — pointer events not reaching the app');
        if (r.layers <= 0) throw new Error('0 layers targeted — the glitch path never ran');
        runs[variant].push(r);
        row(String(i + 1), variant, r);
      }
    }

    console.log('\n  medians:');
    console.log('  variant     fps     p50     p99   >20ms   >50ms  layers');
    for (const v of ['old', 'new']) {
      const R = runs[v];
      console.log(`  ${v.padEnd(8)}`
        + `${String(med(R.map(r => r.fps))).padStart(8)}`
        + `${String(med(R.map(r => r.p50))).padStart(8)}`
        + `${String(med(R.map(r => r.p99))).padStart(8)}`
        + `${String(med(R.map(r => r.over20))).padStart(8)}`
        + `${String(med(R.map(r => r.over50))).padStart(8)}`
        + `${String(med(R.map(r => r.layers))).padStart(8)}`);
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
