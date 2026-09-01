#!/usr/bin/env node
/**
 * @fileoverview Ceiling probe for BlurTool — bounds the available win BEFORE
 * writing an optimisation, the way eraser_ceiling.mjs did.
 *
 * `tool_stage_probe.mjs --tool=blur` accounts for only ~22 % of wall in JS
 * (paintMask 20.4 %, composites 1.7 %), so ~78 % is canvas raster issued from
 * main and invisible to a sampling profile. The suspect is the per-stamp
 * `ctx.filter = blur(...)` draw: 2334 of them for 6 strokes.
 *
 * Arms (each a seam on the scratch context, so paintMask itself is untouched):
 *   baseline  - current source
 *   nofilter  - the `filter` setter is a no-op, so the self-draw still happens
 *               but with no filter pipeline. Bounds the filter's share.
 *   nostamp   - paintMask's whole draw block is skipped (bounds update only).
 *               The absolute ceiling for anything done inside paintMask.
 *
 * nofilter and nostamp CHANGE THE OUTPUT and exist only to size the prize.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/blur_ceiling.mjs --reps=3
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const REPS = Number(arg('reps', 3));
const STROKES = Number(arg('strokes', 6));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const TOOL = arg('tool', 'blur');
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = { '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], big: [1800, 3200] };
const dims = BOARD_SIZES[SIZE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARMS = ['baseline', 'nofilter', 'nostamp'];

const SETUP = (tool) => `(() => {
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

  const tool = app.toolManager.getTool(${JSON.stringify(tool)});
  if (!tool) throw new Error('tool not found');

  const REAL_scratch = tool._getBlurScratch?.bind(tool);
  const REAL_paint = tool.paintMask.bind(tool);
  if (!REAL_scratch) throw new Error('no _getBlurScratch seam on this build');

  // nofilter: hand paintMask a context whose filter setter does nothing.
  // Everything else about the stamp is unchanged.
  const neuteredCache = new WeakSet();
  const neuter = (pair) => {
    if (!neuteredCache.has(pair.ctx)) {
      Object.defineProperty(pair.ctx, 'filter', {
        configurable: true, get: () => 'none', set: () => {}
      });
      neuteredCache.add(pair.ctx);
    }
    return pair;
  };

  // Deterministic content UNDER the stroke, repainted before every arm.
  // Without it blur reads ~51 fps here while the per-tool ranking reads 25 on a
  // board that other tools had drawn on: blur samples what is beneath it, so an
  // empty board measures a blur that has nothing to do. Every arm must see the
  // same base or the comparison is between boards, not between arms.
  window.__paintBase = function () {
    app.board.clear();
    const ctx = app.board.layerManager.layerGroups[0].flatCtx;
    const [bh, bw] = app.board.dimensions;
    for (let i = 0; i < 600; i++) {
      ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
      ctx.fillRect((i % 30) * (bw / 30), Math.floor(i / 30) * (bh / 20), bw / 30 - 4, bh / 20 - 4);
    }
    app.board.markCompositeFull();
    app.board.compositeAllLayers();
  };

  window.__stats = { stamps: 0 };
  window.__setArm = (arm) => {
    tool._blurScratch = null;
    if (arm === 'nostamp') {
      tool._getBlurScratch = REAL_scratch;
      tool.paintMask = function (x, y, size, user, maskCtx) {
        window.__stats.stamps++;
        // Bounds bookkeeping only — no source draw, no filter, no mask draw.
        const blurRadius = user.blurRadius || 10;
        const margin = Math.ceil(blurRadius * 2);
        const left = Math.floor(x - size - margin);
        const top = Math.floor(y - size - margin);
        const width = Math.ceil((size + margin) * 2);
        const height = Math.ceil((size + margin) * 2);
        this.board.expandDirtyRect(user, left, top, width, height);
        if (user.blurBounds) {
          user.blurBounds.minX = Math.min(user.blurBounds.minX, left);
          user.blurBounds.minY = Math.min(user.blurBounds.minY, top);
          user.blurBounds.maxX = Math.max(user.blurBounds.maxX, left + width);
          user.blurBounds.maxY = Math.max(user.blurBounds.maxY, top + height);
        }
      };
      return arm;
    }
    tool.paintMask = function (...a) { window.__stats.stamps++; return REAL_paint(...a); };
    tool._getBlurScratch = arm === 'nofilter'
      ? (w, h) => neuter(REAL_scratch(w, h))
      : REAL_scratch;
    return arm;
  };

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
    if (cfg.base) window.__paintBase();
    const f = window.__frames;
    const before = window.__strokeCount;
    window.__stats = { stamps: 0 };
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
      stamps: window.__stats.stamps
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
    await page.evaluate(SETUP(TOOL));
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `bc_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'BC'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const got = await page.evaluate((t) => { window.app.selectTool(t); return window.app.self?.tool; }, TOOL);
    if (got !== TOOL) throw new Error(`tool did not take: ${got}`);

    console.log(`\n=== ${TOOL} ceiling  ${SIZE}  span=${SPAN}  ${REPS} reps x ${STROKES} strokes, interleaved, solo`);
    console.log('    nofilter/nostamp change the OUTPUT — they size the prize, they are not fixes\n');

    await page.evaluate(() => window.__setArm('baseline'));
    const cold = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp, base: true }), STROKES, SPAN);
    console.log('  rep  arm            fps     p50     p99   >20ms   >50ms  stamps');
    const row = (label, arm, r) => console.log(`  ${label.padStart(3)}  ${arm.padEnd(10)}`
      + `${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
      + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}${String(r.stamps).padStart(8)}`);
    row('c', 'base/cold', cold);

    const runs = Object.fromEntries(ARMS.map((a) => [a, []]));
    for (let i = 0; i < REPS; i++) {
      const rot = ARMS.slice(i % ARMS.length).concat(ARMS.slice(0, i % ARMS.length));
      for (const arm of rot) {
        await page.evaluate((a) => window.__setArm(a), arm);
        await sleep(400);
        const r = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp, base: true }), STROKES, SPAN);
        if (r.stamps <= 0) throw new Error('0 stamps — the blur path never ran');
        runs[arm].push(r);
        row(String(i + 1), arm, r);
      }
    }

    const base = med(runs.baseline.map((r) => r.fps));
    console.log('\n  medians:');
    console.log('  arm            fps   vs base     p50     p99   >20ms   >50ms   fps range');
    for (const arm of ARMS) {
      const R = runs[arm];
      const f = med(R.map((r) => r.fps));
      console.log(`  ${arm.padEnd(10)}${String(f).padStart(8)}`
        + `${(base ? '+' + (((f - base) / base) * 100).toFixed(1) + '%' : '?').padStart(10)}`
        + `${String(med(R.map((r) => r.p50))).padStart(8)}`
        + `${String(med(R.map((r) => r.p99))).padStart(8)}`
        + `${String(med(R.map((r) => r.over20))).padStart(8)}`
        + `${String(med(R.map((r) => r.over50))).padStart(8)}`
        + `   [${Math.min(...R.map((r) => r.fps))}, ${Math.max(...R.map((r) => r.fps))}]`);
    }
    console.log('');
  } finally {
    await browser.disconnect();
  }
})();
