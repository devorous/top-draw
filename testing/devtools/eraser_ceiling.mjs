#!/usr/bin/env node
/**
 * @fileoverview Bounds the win available from each stage of the eraser pipeline.
 *
 * After the preview copy-chain fix the eraser still runs ~35 fps against the
 * brush's ~50 on the Chromebook, and the wrapped-method timings account for
 * only ~13 % of wall — so the limiter is not visible in JS self-time, and two
 * plausible-looking fixes (copy chain, upper-layer dirty rects) moved GPU work
 * a lot and fps either some or not at all.
 *
 * Rather than write a third speculative optimisation, this DELETES one stage at
 * a time and measures the resulting fps. A stage whose removal does not move
 * fps cannot be worth optimising, however expensive it looks. Variants are
 * interleaved inside one page session because this rig drifts downward over a
 * session by more than the effects being measured.
 *
 * Every variant except `baseline` and `brush` renders incorrectly on purpose.
 * These are ceilings, not candidate behaviour.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/eraser_ceiling.mjs --reps=3
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const REPS = Number(arg('reps', 3));
const STROKES = Number(arg('strokes', 8));
const SIZE = arg('size', '1440p');
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = { '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], 'big': [1800, 3200] };
const dims = BOARD_SIZES[SIZE];
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

  window.__drive = async function ({ strokes, pts = 30 }) {
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

  const board = app.board;
  const lm = board.layerManager;
  const eraser = app.toolManager.getTool('erase');
  const EP = Object.getPrototypeOf(eraser);

  // Capture the real implementations once, before anything is stubbed.
  const orig = {
    compositeAllLayers: board.compositeAllLayers.bind(board),
    publishPreviewStroke: EP._publishPreviewStroke,
    renderPreviewPath: EP._renderPreviewPath,
    drawPreview: EP.drawPreview,
    setUserPreviewStroke: lm.setUserPreviewStroke.bind(lm),
    copyPreviewSource: lm._copyPreviewSource.bind(lm),
    stampPoint: EP._stampPoint,
    compositeUpper: board._compositeUpperLayers.bind(board),
    groupWithFlat: lm._compositeGroupWithFlatCanvas.bind(lm)
  };

  const restoreAll = () => {
    board.compositeAllLayers = orig.compositeAllLayers;
    EP._publishPreviewStroke = orig.publishPreviewStroke;
    EP._renderPreviewPath = orig.renderPreviewPath;
    EP.drawPreview = orig.drawPreview;
    lm.setUserPreviewStroke = orig.setUserPreviewStroke;
    lm._copyPreviewSource = orig.copyPreviewSource;
    EP._stampPoint = orig.stampPoint;
    board._compositeUpperLayers = orig.compositeUpper;
    lm._compositeGroupWithFlatCanvas = orig.groupWithFlat;
  };

  const noop = () => {};

  // Each variant removes exactly one stage. All of them except baseline/brush
  // render wrongly; they exist only to bound the available win.
  const VARIANTS = {
    baseline:      () => { app.selectTool('erase'); },
    brush:         () => { app.selectTool('brush'); },
    'no-composite':      () => { app.selectTool('erase'); board.compositeAllLayers = noop; },
    'no-upperlayers':    () => { app.selectTool('erase'); board._compositeUpperLayers = noop; },
    'no-publish':        () => { app.selectTool('erase'); EP._publishPreviewStroke = noop; },
    'no-previewcopy':    () => { app.selectTool('erase'); lm._copyPreviewSource = noop; },
    'no-previewblit':    () => { app.selectTool('erase'); EP._renderPreviewPath = noop; },
    'no-drawpreview':    () => { app.selectTool('erase'); EP.drawPreview = noop; },
    'no-stamp':          () => { app.selectTool('erase'); EP._stampPoint = noop; },
    // Ceiling for "cache the group's base composite and only re-apply the
    // preview": skips the group buffer, the strokeStack replay and every active
    // stroke, blitting the baked flatCanvas alone. Renders without any live
    // stroke, so it is an upper bound on that idea and nothing more.
    'flat-only':         () => {
      app.selectTool('erase');
      lm._compositeGroupWithFlatCanvas = (targetCtx, group, bg, rects) => {
        targetCtx.globalCompositeOperation = 'source-over';
        if (group.flatCanvas) lm._drawCanvasRegion(targetCtx, group.flatCanvas, rects);
      };
    }
  };

  window.__variants = Object.keys(VARIANTS);
  window.__setVariant = (name) => {
    restoreAll();
    VARIANTS[name]();
    board._upperLayersCompositeStart = null;
    board._upperLayersCompositeEnd = null;
    board.markCompositeFull();
    return name;
  };

  window.__measure = async function (cfg) {
    const f = window.__frames;
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    const ms = performance.now() - t0;
    f.on = false;
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    return {
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p99: +pct(0.99).toFixed(1),
      over20: g.filter(v => v > 20).length,
      frames: g.length
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

    const room = `ceil_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'CEIL'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const all = await page.evaluate(() => window.__variants);
    const variants = ONLY.length ? all.filter((v) => ONLY.includes(v)) : all;

    await page.evaluate(() => window.__setVariant('baseline'));
    await page.evaluate(() => window.__drive({ strokes: 2, pts: 20 }));

    const runs = Object.fromEntries(variants.map((v) => [v, []]));
    console.log(`\n=== eraser_ceiling  ${SIZE}  ${REPS} reps x ${STROKES} strokes, interleaved`);
    console.log(`    every variant but baseline/brush renders WRONG on purpose — these are ceilings\n`);

    for (let i = 0; i < REPS; i++) {
      // Reverse the order on alternate reps so no variant always benefits from
      // (or pays for) being first while the session is warm.
      const order = i % 2 === 0 ? variants : [...variants].reverse();
      for (const v of order) {
        await page.evaluate((n) => window.__setVariant(n), v);
        await sleep(400);
        const r = await page.evaluate((s) => window.__measure({ strokes: s, pts: 30 }), STROKES);
        runs[v].push(r);
        process.stdout.write(`  rep ${i + 1}  ${v.padEnd(16)} ${String(r.fps).padStart(6)} fps\n`);
      }
    }

    const base = med(runs.baseline.map((r) => r.fps));
    console.log('\n  variant             fps    vs baseline      p99   >20ms');
    for (const v of variants) {
      const f = med(runs[v].map((r) => r.fps));
      const d = base ? (((f - base) / base) * 100).toFixed(0) : '—';
      console.log(`  ${v.padEnd(18)}${String(f).padStart(6)}`
        + `${(v === 'baseline' ? '—' : (d >= 0 ? '+' : '') + d + ' %').padStart(15)}`
        + `${String(med(runs[v].map((r) => r.p99))).padStart(9)}`
        + `${String(med(runs[v].map((r) => r.over20))).padStart(8)}`);
    }
    console.log('\n  A stage whose removal does not move fps is not worth optimising.\n');
  } finally {
    await browser.disconnect();
  }
})();
