#!/usr/bin/env node
/**
 * @fileoverview Paired A/B for BlurTool's per-stamp scratch canvas, with an
 * exactness check first.
 *
 * OLD is the shipped-until-2026-08-31 behaviour: `paintMask` called
 * `document.createElement('canvas')` on every stamp point. NEW reuses one
 * scratch canvas that grows to the largest crop.
 *
 * The seam is `_getBlurScratch`, so the OLD arm is produced by returning a fresh
 * canvas from it — the rest of `paintMask` is the current source in both arms.
 *
 * Phase 1 draws the same deterministic stroke under each arm and diffs the
 * resulting layer, because this is a pixel-producing path and a shared,
 * oversized scratch is exactly the kind of change that leaks stale pixels.
 * Phase 2 is the interleaved fps A/B.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/blur_ab.mjs --reps=3
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
// Which regression the OLD arm restores: both | snapshot | scratch.
const SEAM = arg('seam', 'both');
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

  const evFor = () => {
    const [bh, bw] = app.board.dimensions;
    const el = document.getElementById('boards');
    const rect = el.getBoundingClientRect();
    const sx = rect.width / bw, sy = rect.height / bh;
    const down = document.getElementById('board');
    return (type, x, y) => {
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
        cancelable: true, composed: true,
        clientX: rect.left + x * sx, clientY: rect.top + y * sy,
        buttons: type === 'pointerup' ? 0 : 1, button: 0,
        pressure: type === 'pointerup' ? 0 : 0.5
      });
      (type === 'pointerdown' ? down : window).dispatchEvent(e);
    };
  };

  window.__drive = async function ({ strokes, pts = 30, span = 400 }) {
    const [bh, bw] = app.board.dimensions;
    const ev = evFor();
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

  // Fixed stroke, no randomness, for the exactness comparison.
  window.__driveFixed = async function () {
    const ev = evFor();
    const raf = () => new Promise(r => requestAnimationFrame(r));
    const ox = 300, oy = 300, span = 260, pts = 24;
    ev('pointermove', ox, oy); ev('pointerdown', ox, oy);
    for (let i = 1; i <= pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      ev('pointermove', ox + span * 0.5 * (1 + Math.cos(a)), oy + span * 0.5 * (1 + Math.sin(a)));
      await raf();
    }
    ev('pointerup', ox + span * 0.5, oy + span);
    await raf(); await raf();
    await new Promise(r => setTimeout(r, 400));
  };

  window.__paintBase = function () {
    app.board.clear();
    const ctx = app.board.layerManager.layerGroups[0].flatCtx;
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
      ctx.fillRect(200 + (i % 10) * 40, 200 + Math.floor(i / 10) * 40, 36, 36);
    }
    app.board.markCompositeFull();
    app.board.compositeAllLayers();
  };

  window.__layerBytes = function () {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    lm.compositeLayerRange(ctx, 0, 1, null);
    return ctx.getImageData(0, 0, w, h).data;
  };

  const tool = app.toolManager.getTool(${JSON.stringify(TOOL)});
  if (!tool) throw new Error('tool not found');
  if (typeof tool._getBlurScratch !== 'function') {
    throw new Error('this build predates the reused blur scratch — nothing to A/B');
  }

  const NEW_scratch = tool._getBlurScratch.bind(tool);
  const NEW_acquire = tool._acquireSnapshotCanvas.bind(tool);
  const NEW_release = tool._releaseSnapshotCanvas.bind(tool);

  // OLD = both allocations restored: a crop-sized canvas per stamp point, and a
  // board-sized snapshot canvas per stroke (clearSnapshot used to throw it away,
  // and assigning canvas.width reallocates the backing store even on the cached
  // path). boardAllocs is the one that should matter - it is full-board.
  const OLD_scratch = (w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    window.__stats.allocs++;
    return { canvas, ctx: canvas.getContext('2d') };
  };
  const OLD_acquire = (w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    window.__stats.boardAllocs++;
    return canvas;
  };

  window.__stats = { allocs: 0, stamps: 0, boardAllocs: 0 };
  window.__setVariant = (which) => {
    tool._blurScratch = null;
    // dispose(), not reassignment: _snapshotPool is a SnapshotCanvasPool, and
    // overwriting it with an array made _acquireSnapshotCanvas throw, which
    // silently dropped the snapshot and made blur sample mainCanvas instead.
    // The exactness phase caught it as 20035 differing bytes.
    tool._snapshotPool?.dispose?.();
    tool.snapshotCanvases.clear();
    if (which === 'old') {
      // SEAM selects which regression the OLD arm restores, so the two fixes can
      // be attributed separately:
      //   both     - per-stamp scratch AND per-stroke full-board snapshot
      //   snapshot - only the full-board snapshot (scratch fix kept in both arms)
      //   scratch  - only the per-stamp scratch
      const seam = window.__seam || 'both';
      tool._getBlurScratch = (seam === 'snapshot')
        ? (w, h) => { window.__stats.stamps++; return NEW_scratch(w, h); }
        : (w, h) => { window.__stats.stamps++; return OLD_scratch(w, h); };
      if (seam === 'scratch') {
        tool._acquireSnapshotCanvas = (w, h) => { window.__stats.boardAllocs++; return NEW_acquire(w, h); };
        tool._releaseSnapshotCanvas = NEW_release;
      } else {
        tool._acquireSnapshotCanvas = OLD_acquire;
        tool._releaseSnapshotCanvas = () => {};
      }
    } else {
      tool._getBlurScratch = (w, h) => { window.__stats.stamps++; return NEW_scratch(w, h); };
      tool._acquireSnapshotCanvas = (w, h) => { window.__stats.boardAllocs++; return NEW_acquire(w, h); };
      tool._releaseSnapshotCanvas = NEW_release;
    }
    return which;
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
    // Fixed board state per measurement: blur samples what is beneath it, so an
    // empty board measures a blur with nothing to do, and a board that grows
    // across the run charges later arms for their slot.
    window.__paintBase();
    const f = window.__frames;
    const before = window.__strokeCount;
    window.__stats = { allocs: 0, stamps: 0, boardAllocs: 0 };
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
      allocs: window.__stats.allocs,
      stamps: window.__stats.stamps,
      boardAllocs: window.__stats.boardAllocs
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
    await page.evaluate((seam) => { window.__seam = seam; }, SEAM);
    console.log('  OLD arm restores: ' + SEAM);
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `bab_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'BAB'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const got = await page.evaluate((t) => { window.app.selectTool(t); return window.app.self?.tool; }, TOOL);
    if (got !== TOOL) throw new Error(`tool did not take: ${got}`);

    // --- phase 1: exactness --------------------------------------------
    const ex = await page.evaluate(async () => {
      window.__setVariant('new');
      window.__paintBase();
      await window.__driveFixed();
      const a = window.__layerBytes();

      window.__setVariant('old');
      window.__paintBase();
      await window.__driveFixed();
      const b = window.__layerBytes();

      let diff = 0, worst = 0, nz = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { diff++; worst = Math.max(worst, Math.abs(a[i] - b[i])); }
      }
      for (let i = 3; i < a.length; i += 4) if (a[i] !== 0) nz++;
      return { bytes: a.length, diff, worst, nz };
    });
    console.log(`\n=== ${TOOL} scratch A/B  ${SIZE}  span=${SPAN}`);
    console.log(`\n  exactness: ${ex.diff} of ${ex.bytes} bytes differ, worst delta ${ex.worst}`
      + `  (${ex.nz} non-transparent px)`);
    if (ex.nz === 0) throw new Error('the fixed stroke deposited nothing — exactness check is vacuous');
    if (ex.diff !== 0) {
      console.log('  EXACTNESS FAIL — reused scratch changes the output; not proceeding to timings\n');
      process.exitCode = 1;
      return;
    }
    console.log('  exactness PASS — reused scratch is byte-identical\n');

    // --- phase 2: interleaved timings ----------------------------------
    await page.evaluate(() => window.__setVariant('new'));
    const cold = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
    console.log(`  ${REPS} reps x ${STROKES} strokes, interleaved, solo\n`);
    console.log('  rep  variant     fps     p50     p99   >20ms   >50ms  allocs  stamps  boardAlloc');
    const row = (label, variant, r) => console.log(`  ${label.padStart(3)}  ${variant.padEnd(8)}`
      + `${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
      + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}`
      + `${String(r.allocs).padStart(8)}${String(r.stamps).padStart(8)}${String(r.boardAllocs).padStart(12)}`);
    row('c', 'new/cold', cold);

    const runs = { old: [], new: [] };
    for (let i = 0; i < REPS; i++) {
      const order = i % 2 === 0 ? ['old', 'new'] : ['new', 'old'];
      for (const variant of order) {
        await page.evaluate((v) => window.__setVariant(v), variant);
        await sleep(400);
        const r = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
        if (r.committed <= 0) throw new Error('0 strokes committed — pointer events not reaching the app');
        if (r.stamps <= 0) throw new Error('0 stamps — the blur path never ran');
        runs[variant].push(r);
        row(String(i + 1), variant, r);
      }
    }

    console.log('\n  medians:');
    console.log('  variant     fps     p50     p99   >20ms   >50ms  allocs  stamps  boardAlloc');
    for (const v of ['old', 'new']) {
      const R = runs[v];
      console.log(`  ${v.padEnd(8)}`
        + `${String(med(R.map(r => r.fps))).padStart(8)}`
        + `${String(med(R.map(r => r.p50))).padStart(8)}`
        + `${String(med(R.map(r => r.p99))).padStart(8)}`
        + `${String(med(R.map(r => r.over20))).padStart(8)}`
        + `${String(med(R.map(r => r.over50))).padStart(8)}`
        + `${String(med(R.map(r => r.allocs))).padStart(8)}`
        + `${String(med(R.map(r => r.stamps))).padStart(8)}`
        + `${String(med(R.map(r => r.boardAllocs))).padStart(12)}`);
    }
    const oFps = runs.old.map(r => r.fps); const nFps = runs.new.map(r => r.fps);
    const overlap = Math.min(...nFps) <= Math.max(...oFps) && Math.min(...oFps) <= Math.max(...nFps);
    const oMed = med(oFps), nMed = med(nFps);
    console.log(`\n  old fps range [${Math.min(...oFps)}, ${Math.max(...oFps)}]  `
      + `new fps range [${Math.min(...nFps)}, ${Math.max(...nFps)}]`);
    console.log(`  median fps ${oMed} -> ${nMed}  (${oMed ? (((nMed - oMed) / oMed) * 100).toFixed(1) : '?'} %)`);
    console.log(`  distributions ${overlap ? 'OVERLAP — not distinguishable at this rep count' : 'do NOT overlap'}\n`);

    // PAIRED comparison, which is the statistic this interleaved design actually
    // supports. Pooled ranges are the wrong test when an arm is bimodal or the
    // box drifts: both arms of a rep share whatever state that rep was in, so
    // compare WITHIN a rep and count wins. Overlapping pooled ranges with 8 of 9
    // paired wins is a real effect the range test would have thrown away.
    const pairs = Math.min(oFps.length, nFps.length);
    const deltas = [];
    let wins = 0;
    for (let i = 0; i < pairs; i++) {
      const d = ((nFps[i] - oFps[i]) / oFps[i]) * 100;
      deltas.push(+d.toFixed(1));
      if (nFps[i] > oFps[i]) wins++;
    }
    const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; };
    let tail = 0;
    const extreme = Math.max(wins, pairs - wins);
    for (let k = extreme; k <= pairs; k++) tail += choose(pairs, k);
    const pValue = Math.min(1, 2 * tail / Math.pow(2, pairs));
    console.log(`  paired by rep: new wins ${wins} of ${pairs}`);
    console.log(`  per-rep delta: ${deltas.map((d) => (d > 0 ? '+' : '') + d + '%').join(', ')}`);
    console.log(`  median paired delta ${med(deltas) > 0 ? '+' : ''}${med(deltas)}%`
      + `   sign-test p = ${pValue.toFixed(3)}`
      + `   ${pValue <= 0.05 ? '(significant)' : '(not significant)'}`);

    // Wilcoxon signed-rank. The sign test throws magnitude away, which matters
    // here: a run of small losses and large wins reads as a coin flip to it.
    // Critical values are the exact two-sided alpha=0.05 table; W <= critical
    // rejects. n < 6 cannot reach significance two-sided, so say so rather than
    // printing a verdict the test cannot support.
    const WILCOXON_CRIT_05 = { 6: 0, 7: 2, 8: 3, 9: 5, 10: 8, 11: 10, 12: 13, 13: 17, 14: 21, 15: 25 };
    const nz = deltas.filter((d) => d !== 0);
    const ranked = nz
      .map((d) => ({ d, abs: Math.abs(d) }))
      .sort((a, b) => a.abs - b.abs);
    // Average ranks over ties, so equal magnitudes cannot be ordered to taste.
    for (let i = 0; i < ranked.length;) {
      let j = i;
      while (j + 1 < ranked.length && ranked[j + 1].abs === ranked[i].abs) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranked[k].rank = avg;
      i = j + 1;
    }
    const wPlus = ranked.filter((r) => r.d > 0).reduce((a, r) => a + r.rank, 0);
    const wMinus = ranked.filter((r) => r.d < 0).reduce((a, r) => a + r.rank, 0);
    const W = Math.min(wPlus, wMinus);
    const crit = WILCOXON_CRIT_05[nz.length];
    const verdict = crit === undefined
      ? (nz.length < 6 ? 'n too small to reach significance' : 'no critical value for n > 15')
      : (W <= crit ? `SIGNIFICANT (W ${W} <= crit ${crit}, two-sided a=0.05)`
                   : `not significant (W ${W} > crit ${crit})`);
    console.log(`  wilcoxon signed-rank: W+ ${wPlus}, W- ${wMinus}, n ${nz.length} -> ${verdict}`);

    // Stall count is a far less noisy description of stutter than mean fps, and
    // it is the thing users actually report.
    const oStall = runs.old.map((r) => r.over50);
    const nStall = runs.new.map((r) => r.over50);
    let stallWins = 0;
    for (let i = 0; i < pairs; i++) if (nStall[i] < oStall[i]) stallWins++;
    console.log(`  frames > 50 ms, paired: new lower in ${stallWins} of ${pairs} reps`
      + `   median ${med(oStall)} -> ${med(nStall)}
`);
  } finally {
    await browser.disconnect();
  }
})();
