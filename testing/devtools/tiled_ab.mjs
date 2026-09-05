#!/usr/bin/env node
/**
 * @fileoverview Paired A/B for the tiled canvas backing store (layer 0's
 * flatCanvas as a grid of lazily-allocated tiles vs one full-board canvas).
 *
 * The seam is `LayerManager.setTiledBackingStore`, which is a live toggle by
 * design, so both arms run against the same build in one page session — no
 * variant monkey-patching, and no cross-session comparison (see
 * weak_client_perf_measurement_traps #4: session drift on this box is larger
 * than the effects being measured).
 *
 * Three phases:
 *   1. exactness  - the composited layer must be byte-identical across a
 *      full->tiled->full round trip, in both directions, with content on the
 *      board. This is a pixel-producing change and blank-tile skipping is
 *      exactly the kind of optimisation that silently drops artwork.
 *   2. memory     - allocated backing-store bytes and tile count. Deterministic,
 *      so it is reported directly rather than as a statistic.
 *   3. timings    - interleaved paired fps, Wilcoxon signed-rank.
 *
 * `--content=sparse` is the case the feature targets (a mostly-empty board).
 * `--content=dense` is the case it must not regress (every tile populated, so
 * tiled has the same bytes plus per-tile overhead and composites whole tiles
 * instead of exact dirty rects). Run BOTH before believing anything.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/tiled_ab.mjs \
 *     --reps=6 --content=sparse --size=1440p
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const REPS = Number(arg('reps', 6));
const STROKES = Number(arg('strokes', 6));
const SIZE = arg('size', '1440p');
const SPAN = Number(arg('span', 400));
const TOOL = arg('tool', 'brush');
const CONTENT = arg('content', 'sparse');
// Keep local strokes inside a box this many px wide/tall (0 = whole board).
const CONFINE = Number(arg('confine', 0));
// k6 bots run on THIS machine and connect to the dev server over the WS URL —
// only the observed client is on the Chromebook, so the bots do not consume its
// CPU. They still matter here: remote committed strokes bake into layer 0's
// flatCanvas, which is the exact surface being tiled.
const VUS = Number(arg('vus', 0));
const CLUSTERS = Number(arg('clusters', 4));
const K6_SCRIPT = arg('k6script', 'testing/medium_stress_test.js');
const K6_DURATION = arg('k6duration', '30m');
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

// Mirrors shared/boardSizes.js. The stress sizes are the interesting ones for
// this feature: the tiled win scales with board area, and 12k is 9x the area
// of 1440p.
const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  big: [1800, 3200], '4k': [2160, 3840], '8k': [4320, 7680], '12k': [6480, 11520]
};
const dims = BOARD_SIZES[SIZE];
if (!dims) throw new Error(`unknown --size=${SIZE}`);
if (!['sparse', 'dense'].includes(CONTENT)) throw new Error(`--content must be sparse|dense`);
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

  window.__drive = async function ({ strokes, pts = 30, span = 400, confine = 0 }) {
    const [bh, bw] = app.board.dimensions;
    const ev = evFor();
    const raf = () => new Promise(r => requestAnimationFrame(r));
    // confine>0 keeps the local client's strokes inside a box of that many
    // pixels. On a stress-size board, strokes scattered over the full area
    // would touch nearly every tile within a few reps and quietly convert the
    // sparse case into the dense one mid-run.
    const limW = confine > 0 ? Math.min(confine, bw) : bw;
    const limH = confine > 0 ? Math.min(confine, bh) : bh;
    for (let s = 0; s < strokes; s++) {
      const ox = 10 + Math.random() * Math.max(1, limW - span - 20);
      const oy = 10 + Math.random() * Math.max(1, limH - span - 20);
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

  // Deterministic base. Goes through withFlatCanvasContext so it works in both
  // arms, but __setArm always paints it while UNTILED so the two arms start
  // from a byte-identical raster and the toggle is the only difference.
  //   sparse - one cluster in a corner: most tiles stay blank, which is the
  //            regime the backing store exists for.
  //   dense  - a grid across the whole board: every tile populated, the
  //            worst case for tiling.
  window.__paintBase = function (mode) {
    // 'bots' — the k6 VUs are the content source. Clearing here would wipe
    // their work every measurement and destroy the very sparse-tile state the
    // run exists to measure, so leave the board alone.
    if (mode === 'bots') return;
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    app.board.clear();
    lm.withFlatCanvasContext(0, (ctx) => {
      if (mode === 'dense') {
        for (let i = 0; i < 400; i++) {
          const gx = i % 20, gy = Math.floor(i / 20);
          ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
          ctx.fillRect(Math.round(gx * (w / 20)) + 4, Math.round(gy * (h / 20)) + 4, 40, 40);
        }
      } else {
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
          ctx.fillRect(120 + (i % 10) * 40, 120 + Math.floor(i / 10) * 40, 36, 36);
        }
      }
    });
    app.board.markCompositeFull();
    app.board.compositeAllLayers();
  };

  // Per-band digest of the composited layer, instead of one giant ImageData.
  // A full-board readback is 132MB at 8k and 298MB at 12k, and the exactness
  // check needs TWO of them live at once to diff — enough to OOM the tab and
  // turn a correctness check into a crash. Banding keeps peak readback to one
  // strip while staying exact: identical digests over every band means
  // identical bytes (32-bit FNV per band; collision risk is negligible and a
  // real content loss would move the non-zero count too, which is also
  // compared).
  window.__layerDigest = function (bandPx) {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    lm.compositeLayerRange(ctx, 0, 1, null);

    const band = bandPx || Math.max(1, Math.floor(4 * 1024 * 1024 / (w * 4)));
    const bands = [];
    let nz = 0;
    for (let y = 0; y < h; y += band) {
      const bh = Math.min(band, h - y);
      const d = ctx.getImageData(0, y, w, bh).data;
      let hash = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) {
        hash ^= d[i];
        hash = (hash * 0x01000193) >>> 0;
      }
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nz++;
      bands.push(hash);
    }
    c.width = 0; c.height = 0;   // release the temp backing store immediately
    return { bands, nz };
  };

  window.__digestDiff = function (a, b) {
    if (a.bands.length !== b.bands.length) return -1;
    let n = 0;
    for (let i = 0; i < a.bands.length; i++) if (a.bands[i] !== b.bands[i]) n++;
    return n;
  };

  // Real backing-store bytes for layer 0, whichever arm is active.
  window.__flatMem = function () {
    const lm = app.board.layerManager;
    const g = lm.layerGroups[0];
    const fc = g.flatCanvas;
    if (!fc) return { tiled: false, bytes: 0, tiles: 0, totalTiles: 0 };
    if (g.tiled) {
      return {
        tiled: true,
        bytes: fc.allocatedBytes,
        tiles: fc.allocatedTileCount,
        totalTiles: fc.cols * fc.rows
      };
    }
    return { tiled: false, bytes: fc.width * fc.height * 4, tiles: 1, totalTiles: 1 };
  };

  window.__censusBytes = function () {
    try {
      const c = app.canvasCensus?.({ log: false }) ?? app.canvasCensus?.();
      return c?.totalBytes ?? c?.total ?? null;
    } catch { return null; }
  };

  // The server is authoritative for this setting and the room's server-side
  // flag is OFF (we force the arm client-side), so any ROOM_UPDATE carrying
  // roomTiledCanvas:false calls setTiledBackingStore(false) and silently ends
  // the tiled arm mid-measurement. A board resize also swaps the whole
  // LayerManager. Lock both out, and COUNT them so contamination is visible
  // rather than averaged into the result.
  window.__armBlocked = 0;
  window.__lmSwaps = 0;
  window.__armSetting = false;
  window.__installArmLock = function () {
    const board = app.board;
    let lm = board.layerManager;
    const patch = (m) => {
      if (!m || m.__armLocked) return m;
      m.__armLocked = true;
      const orig = m.setTiledBackingStore.bind(m);
      m.setTiledBackingStore = (v) => {
        if (!window.__armSetting) { window.__armBlocked++; return; }
        return orig(v);
      };
      return m;
    };
    patch(lm);
    Object.defineProperty(board, 'layerManager', {
      configurable: true,
      get: () => lm,
      set: (v) => { if (v !== lm) window.__lmSwaps++; lm = patch(v); }
    });
  };

  window.__setArm = function (which, mode) {
    const lm = app.board.layerManager;
    window.__armSetting = true;
    try { return window.__setArmInner(which, mode, lm); }
    finally { window.__armSetting = false; }
  };

  window.__setArmInner = function (which, mode, lm) {
    if (mode === 'bots') {
      // Bots own the content; just flip the arm. The toggle is byte-exact
      // (phase 1 proves it), so both arms of a rep see the same board.
      lm.setTiledBackingStore(which === 'tiled');
    } else {
      // Normalise to untiled, paint the identical base, then toggle. Painting
      // under the arm would let blank-tile skipping change what the base IS.
      lm.setTiledBackingStore(false);
      window.__paintBase(mode);
      if (which === 'tiled') lm.setTiledBackingStore(true);
    }
    return lm.layerGroups[0].tiled === (which === 'tiled');
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
    window.__setArm(cfg.arm, cfg.mode);
    const memBefore = window.__flatMem();
    const f = window.__frames;
    const before = window.__strokeCount;
    const blockedBefore = window.__armBlocked;
    const swapsBefore = window.__lmSwaps;
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    const ms = performance.now() - t0;
    f.on = false;
    const g = f.gaps.slice(2);
    const sorted = [...g].sort((a, b) => a - b);
    const pct = p => sorted[Math.floor(sorted.length * p)] || 0;
    const memAfter = window.__flatMem();
    return {
      committed: window.__strokeCount - before,
      frames: g.length,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(1), p99: +pct(0.99).toFixed(1),
      over20: g.filter(v => v > 20).length,
      over50: g.filter(v => v > 50).length,
      mb0: +(memBefore.bytes / 1048576).toFixed(2),
      mb1: +(memAfter.bytes / 1048576).toFixed(2),
      tiles0: memBefore.tiles, tiles1: memAfter.tiles,
      totalTiles: memAfter.totalTiles,
      blocked: window.__armBlocked - blockedBefore,
      swaps: window.__lmSwaps - swapsBefore,
      // Did the arm survive the whole measurement? A false here means the
      // sample is contaminated and must not be paired.
      armHeld: memAfter.tiled === (cfg.arm === 'tiled')
    };
  };
  return true;
})()`;

const med = (v) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : +(((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1));
};

const BOT_WARMUP = Number(arg('warmup', 45_000));
// With bots supplying content, never repaint a synthetic base.
const MODE = VUS > 0 ? 'bots' : CONTENT;

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 240_000
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  let k6 = null;
  try {
    // Close every other tab and foreground this one. rAF does not fire in a
    // background tab, and main.js calls startBackgroundBoot() from inside a
    // requestAnimationFrame — so a backgrounded tab never boots the app at
    // all: window.app stays undefined, no error is thrown anywhere, and every
    // wait below just times out. Chrome restoring tabs into a reused
    // --user-data-dir is enough to trigger it.
    for (const other of await browser.pages()) {
      if (other !== page) { try { await other.close(); } catch { /* already gone */ } }
    }
    await page.bringToFront();

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    const vis = await page.evaluate(() => document.visibilityState);
    if (vis !== 'visible') throw new Error(`page is ${vis} — rAF will not fire and the app will never boot`);
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP);
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not fatal */ }
    });

    const room = `tab_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'TAB'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);

    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board size did not take: wanted ${dims}, got ${actual}`);
    }
    const got = await page.evaluate((t) => { window.app.selectTool(t); return window.app.self?.tool; }, TOOL);
    if (got !== TOOL) throw new Error(`tool did not take: ${got}`);
    await page.evaluate(() => window.__installArmLock());

    const startBots = async () => {
      const k6Args = ['run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`,
        '-e', `BOARD_W=${actual[1]}`, '-e', `BOARD_H=${actual[0]}`,
        '-e', `CLUSTERS=${CLUSTERS}`,
        `--vus=${VUS}`, `--duration=${K6_DURATION}`, K6_SCRIPT];
      k6 = spawn('k6', k6Args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
      k6.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log(`  [k6] ${t.slice(0, 200)}`); });
      console.log(`\n  starting ${VUS} k6 VUs across ${CLUSTERS} clusters on ${actual[1]}x${actual[0]}, painting for ${BOT_WARMUP / 1000}s...`);
      await sleep(BOT_WARMUP);
      const peers = await page.evaluate(() => window.app?.users?.size ?? -1);
      if (peers <= 0) throw new Error('no bot peers joined — k6 is not reaching the server');
      console.log(`  ${peers} bot peers visible to the observed client`);
    };

    console.log(`\n=== tiled backing store A/B   ${SIZE} ${actual[1]}x${actual[0]}  content=${MODE}  tool=${TOOL}  span=${SPAN}`);

    // --- phase 1: exactness, both directions, with content ---------------
    const ex = await page.evaluate(async (mode) => {
      const lm = window.app.board.layerManager;
      // The arm lock is already installed, and it drops any toggle not made
      // through __setArm. Without this the toggles below are silently no-ops
      // and the whole exactness check passes vacuously by comparing the
      // untiled layer against itself.
      window.__armSetting = true;
      lm.setTiledBackingStore(false);
      window.__paintBase(mode);
      const a = window.__layerDigest();
      const memFull = window.__flatMem();

      lm.setTiledBackingStore(true);           // full -> tiled
      const b = window.__layerDigest();
      const memTiled = window.__flatMem();

      await window.__driveFixed();             // draw more while tiled
      const c = window.__layerDigest();
      const memDrawn = window.__flatMem();

      lm.setTiledBackingStore(false);          // tiled -> full
      const d = window.__layerDigest();
      window.__armSetting = false;

      return {
        bands: a.bands.length, nz: a.nz, nzc: c.nz,
        nzTiled: b.nz, nzBack: d.nz,
        toTiled: window.__digestDiff(a, b), backToFull: window.__digestDiff(c, d),
        memFull, memTiled, memDrawn
      };
    }, CONTENT);

    const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
    console.log(`\n  phase 1 — exactness (${ex.bands} banded digests over the composited layer)`);
    console.log(`    base has ${ex.nz} non-transparent px, after stroke ${ex.nzc}`);
    console.log(`    full -> tiled : ${ex.toTiled} bands differ, non-zero px ${ex.nz} -> ${ex.nzTiled}`);
    console.log(`    tiled -> full : ${ex.backToFull} bands differ, non-zero px ${ex.nzc} -> ${ex.nzBack}`);
    if (ex.nz === 0 || ex.nzc === 0) throw new Error('base or stroke deposited nothing — exactness check is vacuous');
    if (ex.nzTiled !== ex.nz || ex.nzBack !== ex.nzc) {
      console.log('    EXACTNESS FAIL — pixel count changed across the toggle (content lost or gained)\n');
      process.exitCode = 1;
      return;
    }
    if (ex.toTiled !== 0 || ex.backToFull !== 0) {
      console.log('    EXACTNESS FAIL — tiling changes the rendered layer; not proceeding\n');
      process.exitCode = 1;
      return;
    }
    console.log(`    exactness PASS — byte-identical in both directions`);

    console.log(`\n  phase 2 — layer 0 backing store, synthetic ${CONTENT} base`);
    console.log(`    untiled            ${mb(ex.memFull.bytes).padStart(9)}`);
    console.log(`    tiled              ${mb(ex.memTiled.bytes).padStart(9)}   ${ex.memTiled.tiles}/${ex.memTiled.totalTiles} tiles`);
    const saved = ex.memFull.bytes - ex.memTiled.bytes;
    console.log(`    saved              ${mb(saved).padStart(9)}   (${((saved / ex.memFull.bytes) * 100).toFixed(1)}% of the flat canvas)`);

    // --- bots: started AFTER exactness so their traffic cannot race the
    // before/after captures above ----------------------------------------
    if (VUS > 0) {
      await startBots();
      const m = await page.evaluate(() => {
        const lm = window.app.board.layerManager;
        window.__armSetting = true;
        lm.setTiledBackingStore(false); const full = window.__flatMem();
        lm.setTiledBackingStore(true); const tiled = window.__flatMem();
        window.__armSetting = false;
        return { full, tiled, peers: window.app?.users?.size ?? -1 };
      });
      const savedBots = m.full.bytes - m.tiled.bytes;
      console.log(`\n  phase 2b — layer 0 backing store, ${m.peers} bots painting ${CLUSTERS} clusters`);
      console.log(`    untiled            ${mb(m.full.bytes).padStart(9)}`);
      console.log(`    tiled              ${mb(m.tiled.bytes).padStart(9)}   ${m.tiled.tiles}/${m.tiled.totalTiles} tiles`);
      console.log(`    saved              ${mb(savedBots).padStart(9)}   (${((savedBots / m.full.bytes) * 100).toFixed(1)}% of the flat canvas)`);
    }

    // --- phase 3: interleaved paired timings -----------------------------
    console.log(`\n  phase 3 — ${REPS} reps x ${STROKES} strokes, interleaved, ${VUS > 0 ? VUS + ' k6 VUs' : 'solo'}\n`);
    const cold = await page.evaluate((s, sp, m, c) =>
      window.__measure({ arm: 'full', strokes: s, pts: 30, span: sp, mode: m, confine: c }), STROKES, SPAN, MODE, CONFINE);
    console.log('  rep  arm         fps     p50     p99   >20ms   >50ms   MB@end  tiles  blk swp  held');
    const row = (label, arm, r) => console.log(`  ${label.padStart(3)}  ${arm.padEnd(8)}`
      + `${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}${String(r.p99).padStart(8)}`
      + `${String(r.over20).padStart(8)}${String(r.over50).padStart(8)}`
      + `${String(r.mb1).padStart(9)}${String(r.tiles1 + '/' + r.totalTiles).padStart(8)}`
      + `${String(r.blocked).padStart(5)}${String(r.swaps).padStart(4)}${(r.armHeld ? '  ok' : '  DRIFT').padStart(6)}`);
    // Kept and labelled, not discarded: the first run of any batch is JIT/GPU-cold.
    row('c', 'full/cold', cold);

    const runs = { full: [], tiled: [] };
    let drifted = 0;
    for (let i = 0; i < REPS; i++) {
      const order = i % 2 === 0 ? ['full', 'tiled'] : ['tiled', 'full'];
      for (const arm of order) {
        const r = await page.evaluate((a, s, sp, m, c) =>
          window.__measure({ arm: a, strokes: s, pts: 30, span: sp, mode: m, confine: c }), arm, STROKES, SPAN, MODE, CONFINE);
        if (r.frames === 0) throw new Error('0 frames — display blanked, abort (see PowerDevil trap)');
        if (r.committed <= 0) throw new Error('0 strokes committed — pointer events not reaching the app');
        if (!r.armHeld) drifted++;
        runs[arm].push(r);
        row(String(i + 1), arm, r);
        await sleep(300);
      }
    }

    const totals = await page.evaluate(() => ({ blocked: window.__armBlocked, swaps: window.__lmSwaps }));
    console.log(`\n  arm integrity: ${drifted} of ${REPS * 2} measurements drifted;`
      + ` ${totals.blocked} external setTiledBackingStore calls blocked,`
      + ` ${totals.swaps} LayerManager swaps`);
    if (drifted) console.log('  WARNING — drifted reps are contaminated; treat paired stats below as unreliable');

    console.log('\n  medians:');
    console.log('  arm         fps     p50     p99   >20ms   >50ms   MB@end');
    for (const v of ['full', 'tiled']) {
      const R = runs[v];
      console.log(`  ${v.padEnd(8)}`
        + `${String(med(R.map(r => r.fps))).padStart(8)}`
        + `${String(med(R.map(r => r.p50))).padStart(8)}`
        + `${String(med(R.map(r => r.p99))).padStart(8)}`
        + `${String(med(R.map(r => r.over20))).padStart(8)}`
        + `${String(med(R.map(r => r.over50))).padStart(8)}`
        + `${String(med(R.map(r => r.mb1))).padStart(9)}`);
    }

    const oFps = runs.full.map(r => r.fps), nFps = runs.tiled.map(r => r.fps);
    const oMed = med(oFps), nMed = med(nFps);
    console.log(`\n  median fps ${oMed} -> ${nMed}  (${oMed ? (((nMed - oMed) / oMed) * 100).toFixed(1) : '?'} %)`);

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
    console.log(`  paired by rep: tiled wins ${wins} of ${pairs}`);
    console.log(`  per-rep delta: ${deltas.map((d) => (d > 0 ? '+' : '') + d + '%').join(', ')}`);
    console.log(`  median paired delta ${med(deltas) > 0 ? '+' : ''}${med(deltas)}%   sign-test p = ${pValue.toFixed(3)}`);

    const WILCOXON_CRIT_05 = { 6: 0, 7: 2, 8: 3, 9: 5, 10: 8, 11: 10, 12: 13, 13: 17, 14: 21, 15: 25 };
    const nzd = deltas.filter((d) => d !== 0);
    const ranked = nzd.map((d) => ({ d, abs: Math.abs(d) })).sort((a, b) => a.abs - b.abs);
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
    const crit = WILCOXON_CRIT_05[nzd.length];
    const verdict = crit === undefined
      ? (nzd.length < 6 ? 'n too small to reach significance' : 'no critical value for n > 15')
      : (W <= crit ? `SIGNIFICANT (W ${W} <= crit ${crit}, two-sided a=0.05)`
                   : `not significant (W ${W} > crit ${crit})`);
    console.log(`  wilcoxon signed-rank: W+ ${wPlus}, W- ${wMinus}, n ${nzd.length} -> ${verdict}`);

    const oStall = runs.full.map((r) => r.over50), nStall = runs.tiled.map((r) => r.over50);
    let stallWins = 0;
    for (let i = 0; i < pairs; i++) if (nStall[i] < oStall[i]) stallWins++;
    console.log(`  frames > 50 ms, paired: tiled lower in ${stallWins} of ${pairs} reps`
      + `   median ${med(oStall)} -> ${med(nStall)}\n`);
  } finally {
    if (k6) { try { k6.kill(); } catch { /* already gone */ } }
    await browser.disconnect();
  }
})();
