#!/usr/bin/env node
/**
 * @fileoverview Sweeps TiledLayerCanvas granularity against composite cost and
 * memory, interleaved, in one page session.
 *
 * The trade: smaller tiles skip more blank area (less memory) but put more
 * drawImage calls into every composite (more GPU command submission, which
 * prior work found to be the dominant term below the memory cliff). Bigger
 * tiles are the reverse. 512 was picked by assertion, never measured.
 *
 * PRIMARY METRIC IS COMPOSITE TIME, NOT FPS. On a 1440p board on a desktop the
 * rAF loop is vsync-capped at ~60, so frame rate physically cannot show this
 * difference — every arm reads ~58-60 and the comparison looks like a null
 * result no matter how large the real effect is. Forcing full composites and
 * timing them directly isolates exactly the work tile granularity changes.
 *
 * Arms are interleaved with a rotating order per rep because sequential runs on
 * a given machine drift by more than the effect being measured
 * (weak_client_perf_measurement_traps #4).
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9223 node testing/devtools/tile_size_sweep.mjs \
 *     --sizes=256,512,1024 --reps=5 --content=sparse
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const TILE_SIZES = String(arg('sizes', '256,512,1024')).split(',').map(Number);
const REPS = Number(arg('reps', 5));
const COMPOSITES = Number(arg('composites', 20));
const SIZE = arg('size', '1440p');
const CONTENT = arg('content', 'sparse');
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  big: [1800, 3200], '4k': [2160, 3840], '8k': [4320, 7680]
};
const dims = BOARD_SIZES[SIZE];
if (!dims) throw new Error(`unknown --size=${SIZE}`);
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

  window.__armSetting = false;
  window.__blocked = 0;
  window.__installArmLock = function () {
    const board = app.board;
    let lm = board.layerManager;
    const patch = (m) => {
      if (!m || m.__armLocked) return m;
      m.__armLocked = true;
      const orig = m.setTiledBackingStore.bind(m);
      m.setTiledBackingStore = (v, s) => {
        if (!window.__armSetting) { window.__blocked++; return; }
        return orig(v, s);
      };
      return m;
    };
    patch(lm);
    Object.defineProperty(board, 'layerManager', {
      configurable: true, get: () => lm, set: (v) => { lm = patch(v); }
    });
  };

  window.__paintBase = function (mode) {
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
        // Sparse but not degenerate: three separated clusters, roughly the
        // shape real users make, so the grid has both populated and empty
        // regions at every granularity under test.
        const spots = [[0.12, 0.15], [0.55, 0.30], [0.30, 0.70]];
        for (const [fx, fy] of spots) {
          for (let i = 0; i < 40; i++) {
            ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
            ctx.fillRect(Math.round(fx * w) + (i % 8) * 34, Math.round(fy * h) + Math.floor(i / 8) * 34, 30, 30);
          }
        }
      }
    });
    app.board.markCompositeFull();
    app.board.compositeAllLayers();
  };

  // Set the arm from a byte-identical starting raster every time: paint the
  // base while UNTILED, then tile it. Painting under the arm would let
  // blank-tile skipping change what the base actually is.
  window.__setArm = function (tileSize, mode) {
    const lm = app.board.layerManager;
    window.__armSetting = true;
    try {
      lm.setTiledBackingStore(false);
      window.__paintBase(mode);
      if (tileSize > 0) lm.setTiledBackingStore(true, tileSize);
    } finally { window.__armSetting = false; }
    const g = lm.layerGroups[0];
    return g.tiled === (tileSize > 0);
  };

  window.__mem = function () {
    const g = app.board.layerManager.layerGroups[0];
    const fc = g.flatCanvas;
    if (!g.tiled) {
      return { tiled: false, mb: +((fc.width * fc.height * 4) / 1048576).toFixed(2), tiles: 1, total: 1 };
    }
    return {
      tiled: true,
      mb: +(fc.allocatedBytes / 1048576).toFixed(2),
      tiles: fc.allocatedTileCount, total: fc.cols * fc.rows
    };
  };

  // Time forced FULL composites. markCompositeFull invalidates the dirty-rect
  // path so every call does the whole board — which is the work tile count
  // actually changes.
  window.__compositeMs = async function (n) {
    const board = app.board;
    const raf = () => new Promise(r => requestAnimationFrame(r));
    for (let i = 0; i < 5; i++) { board.markCompositeFull(); board.compositeAllLayers(); await raf(); }
    // Time a BATCH, not individual calls. One composite here is ~0.1ms, which
    // is the performance.now() resolution floor — per-call medians quantise to
    // 0.1/0.2 and a 2x difference reads as "+100%" that is really one clock
    // tick. Batching puts the total tens of ms above the floor.
    //
    // No rAF inside the batch: a frame wait is ~16ms and would swamp the
    // signal entirely. That does mean this measures main-thread command
    // SUBMISSION, not GPU rasterisation — which is the right target here,
    // since tile count changes the number of drawImage calls, and prior work
    // found submission to be the dominant term below the memory cliff.
    const reps = 3;
    const totals = [];
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { board.markCompositeFull(); board.compositeAllLayers(); }
      totals.push(performance.now() - t0);
      await raf();
    }
    totals.sort((a, b) => a - b);
    const best = totals[0];              // least interfered-with batch
    return {
      per: +(best / n).toFixed(4),
      batch: +best.toFixed(1),
      spread: +(totals[totals.length - 1] - totals[0]).toFixed(1)
    };
  };
  return true;
})()`;

const med = (v) => {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : +(((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(3));
};

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300_000
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    for (const other of await browser.pages()) {
      if (other !== page) { try { await other.close(); } catch { /* gone */ } }
    }
    await page.bringToFront();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    const vis = await page.evaluate(() => document.visibilityState);
    if (vis !== 'visible') throw new Error(`page is ${vis} — rAF will not fire and the app will never boot`);
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP);

    const room = `tss_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'TSS'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1200);
    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board size did not take: wanted ${dims}, got ${actual}`);
    }
    await page.evaluate(() => window.__installArmLock());

    // 0 is the untiled control arm.
    const arms = [0, ...TILE_SIZES];
    console.log(`\n=== tile size sweep   ${SIZE} ${actual[1]}x${actual[0]}   content=${CONTENT}`);
    console.log(`    ${REPS} reps x ${COMPOSITES} forced full composites per arm, interleaved\n`);
    console.log('  rep  tile      tiles      MB   us/composite   batch ms  spread');

    const runs = new Map(arms.map((a) => [a, []]));
    for (let i = 0; i < REPS; i++) {
      // Rotate arm order every rep so no arm keeps a favourable slot.
      const order = arms.slice(i % arms.length).concat(arms.slice(0, i % arms.length));
      for (const tile of order) {
        const ok = await page.evaluate((t, m) => window.__setArm(t, m), tile, CONTENT);
        if (!ok) throw new Error(`arm ${tile} did not engage`);
        const mem = await page.evaluate(() => window.__mem());
        const c = await page.evaluate((n) => window.__compositeMs(n), COMPOSITES);
        runs.get(tile).push({ ...c, ...mem });
        console.log(`  ${String(i + 1).padStart(3)}  ${(tile ? tile + 'px' : 'off').padEnd(6)}`
          + `${String(mem.tiled ? `${mem.tiles}/${mem.total}` : '—').padStart(9)}`
          + `${String(mem.mb).padStart(8)}`
          + `${String((c.per * 1000).toFixed(1)).padStart(13)}${String(c.batch).padStart(11)}${String(c.spread).padStart(8)}`);
      }
    }

    console.log('\n  medians across reps:');
    console.log('  tile      tiles      MB   us/composite   vs untiled');
    const baseline = med(runs.get(0).map((r) => r.per));
    for (const tile of arms) {
      const R = runs.get(tile);
      const m = med(R.map((r) => r.per));
      const delta = baseline ? ((m - baseline) / baseline) * 100 : 0;
      console.log(`  ${(tile ? tile + 'px' : 'off').padEnd(6)}`
        + `${String(R[0].tiled ? `${R[0].tiles}/${R[0].total}` : '—').padStart(9)}`
        + `${String(med(R.map((r) => r.mb))).padStart(8)}`
        + `${String((m * 1000).toFixed(1)).padStart(15)}`
        + `${(tile === 0 ? '  —' : `   ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`).padStart(12)}`);
    }

    const blocked = await page.evaluate(() => window.__blocked);
    console.log(`\n  [${blocked} external setTiledBackingStore calls blocked]\n`);
  } finally {
    await browser.disconnect();
  }
})();
