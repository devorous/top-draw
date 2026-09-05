#!/usr/bin/env node
/**
 * @fileoverview Two live clients in one room, one with layer 0's backing store
 * tiled and one without, drawing at each other.
 *
 * The tiled flag is per room, so in production both clients agree — but a
 * client that toggled locally (the debug panel tells you how to, and this is a
 * live toggle by design) is a legitimate divergence source, and it is the only
 * configuration in which the tiled and untiled code paths render the *same*
 * stroke stream side by side. If the two paths ever disagree, a mixed cohort is
 * where it shows.
 *
 * TWO THINGS THIS HARNESS LEARNED THE HARD WAY, both of which invalidate the
 * obvious version of it:
 *
 * 1. Byte-equality is the WRONG oracle across two clients. A stroke drawn
 *    locally and the same stroke reconstructed from wire points are not
 *    byte-identical — the control arm (both clients untiled, same strokes)
 *    measures ~6 differing pixels on a 1920x1080 board. So every arm is judged
 *    against that measured control, on exact integer per-block pixel counts,
 *    never against an assumed-zero or a percentage.
 * 2. Strokes do not reach `flatCanvas` — the only thing tiling changes — until
 *    a user exceeds MAX_STROKES_PER_USER (20). A short scripted session leaves
 *    every stroke in `strokeStack` and the tiled arm reports 0 allocated tiles,
 *    i.e. the test passes without executing one line of tiled code. Both
 *    clients therefore run with `eagerBakeUsers` set for every user, and the
 *    harness ASSERTS a non-zero tile count before believing any arm.
 *
 * A third trap: the server is authoritative for the tiled room setting and this
 * room's flag is off, so a ROOM_UPDATE (one arrives when a third client joins)
 * calls setTiledBackingStore(false) and silently ends the tiled arm. The arm is
 * locked and external toggles are counted.
 *
 * Phases:
 *   1. both untiled          - control. If this fails, the room is not settling
 *                              and nothing below means anything.
 *   2. A tiled, B untiled    - each draws; both boards must match.
 *   3. A untiled, B tiled    - the mirror image, so a one-sided bug cannot hide.
 *   4. undo / redo           - crossed with the tiled flag.
 *   5. late joiner           - C joins a room whose content was drawn by a
 *                              tiled client, and must land on the same board.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9223 node testing/devtools/tiled_mixed_cohort.mjs
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const SIZE = arg('size', '1080p');
const TOOL = arg('tool', 'brush');
const SETTLE = Number(arg('settle', 2500));
// Strokes per client in phase 4. Must exceed LayerManager.MAX_STROKES_PER_USER
// (20) so a prefix actually bakes into the tiled grid.
const OVERFLOW = Number(arg('overflow', 24));
// How long to wait for both clients' pixel counts to stop moving before judging
// an arm. A stroke still in flight is not a divergence.
const CONVERGE = Number(arg('converge', 20000));
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560], '4k': [2160, 3840]
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

  // Fixed coordinates, no randomness — the two clients must draw in disjoint
  // regions so a missing stroke is attributable.
  window.__drawAt = async function (ox, oy, span, pts) {
    const ev = evFor();
    const raf = () => new Promise(r => requestAnimationFrame(r));
    ev('pointermove', ox, oy); ev('pointerdown', ox, oy);
    for (let i = 1; i <= pts; i++) {
      const a = (i / pts) * Math.PI * 2;
      ev('pointermove', ox + span * 0.5 * (1 + Math.cos(a)), oy + span * 0.5 * (1 + Math.sin(a)));
      await raf();
    }
    ev('pointerup', ox + span * 0.5, oy + span);
    await raf(); await raf();
  };

  // Per-32px-block count of non-transparent pixels over the whole composited
  // board. Comparable across two clients (unlike a hash), still made of exact
  // integers (unlike a difference percentage), and a lost stroke shows as a
  // large delta over a contiguous run of blocks rather than a handful of
  // single-pixel antialiasing differences scattered along stroke edges.
  const BLOCK = 32;
  window.__boardBlocks = function () {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    lm.compositeLayerRange(ctx, 0, lm.getLayerCount(), null);
    const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
    const blocks = new Int32Array(bw * bh);
    let nz = 0;
    const strip = Math.max(1, Math.floor(4 * 1024 * 1024 / (w * 4) / BLOCK) * BLOCK);
    for (let y0 = 0; y0 < h; y0 += strip) {
      const sh = Math.min(strip, h - y0);
      const d = ctx.getImageData(0, y0, w, sh).data;
      for (let y = 0; y < sh; y++) {
        const brow = ((y0 + y) / BLOCK) | 0;
        const rowBase = y * w * 4 + 3;
        for (let x = 0; x < w; x++) {
          if (d[rowBase + x * 4] !== 0) { blocks[brow * bw + ((x / BLOCK) | 0)]++; nz++; }
        }
      }
    }
    c.width = 0; c.height = 0;
    const g0 = lm.layerGroups[0];
    return {
      blocks: Array.from(blocks), bw, bh, nz,
      tiled: !!g0.tiled,
      tiles: g0.tiled ? g0.flatCanvas.allocatedTileCount : -1,
      stack: lm.layerGroups.map((g) => g.strokeStack.length),
      users: app.users?.size ?? -1,
      blocked: window.__armBlocked
    };
  };

  // The server owns the room's tiled setting and this room has it off, so any
  // ROOM_UPDATE (one arrives when a third client joins) would call
  // setTiledBackingStore(false) and end a locally-set arm mid-measurement.
  // Block those and count them so contamination is visible rather than silent.
  window.__armBlocked = 0;
  window.__armSetting = false;
  window.__installArmLock = function () {
    const board = app.board;
    let lm = board.layerManager;
    const patch = (m) => {
      if (!m || m.__armLocked) return m;
      m.__armLocked = true;
      const orig = m.setTiledBackingStore.bind(m);
      m.setTiledBackingStore = (v, s) => {
        if (!window.__armSetting) { window.__armBlocked++; return; }
        return orig(v, s);
      };
      return m;
    };
    patch(lm);
    Object.defineProperty(board, 'layerManager', {
      configurable: true, get: () => lm, set: (v) => { lm = patch(v); }
    });
  };

  // Without this, nothing ever reaches flatCanvas in a short session and the
  // tiled arm executes no tiled code at all. eagerBakeUsers is a real
  // LayerManager feature (TimeMachine uses it) and it is applied identically to
  // both arms, so it cannot bias the comparison.
  window.__forceEagerBake = function () {
    const lm = app.board.layerManager;
    const ids = new Set();
    if (app.self?.id != null) ids.add(app.self.id);
    for (const id of app.users?.keys?.() ?? []) ids.add(id);
    lm.eagerBakeUsers = ids;
    return ids.size;
  };

  window.__setTiled = function (on) {
    window.__armSetting = true;
    try { app.board.layerManager.setTiledBackingStore(!!on); }
    finally { window.__armSetting = false; }
    return !!app.board.layerManager.layerGroups[0].tiled;
  };

  return true;
})()`;

/**
 * Compare two block-count grids. Returns exact integers only.
 */
const blockDiff = (a, b) => {
  if (!a || !b || a.bw !== b.bw || a.bh !== b.bh) return { shape: false };
  let differing = 0, sumAbs = 0, maxAbs = 0, maxAt = -1;
  for (let i = 0; i < a.blocks.length; i++) {
    const d = Math.abs(a.blocks[i] - b.blocks[i]);
    if (d === 0) continue;
    differing++;
    sumAbs += d;
    if (d > maxAbs) { maxAbs = d; maxAt = i; }
  }
  return { shape: true, differing, sumAbs, maxAbs, maxAt, nzDelta: Math.abs(a.nz - b.nz) };
};

async function boot(page, room, name) {
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  const vis = await page.evaluate(() => document.visibilityState);
  if (vis !== 'visible') throw new Error(`${name}: page is ${vis} — rAF will not fire and the app will never boot`);
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
  await page.evaluate(SETUP);
  await page.evaluate((r, n) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, room, name);
  await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
    { timeout: READY_TIMEOUT });
  await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
  await page.evaluate((t) => window.app.selectTool(t), TOOL);
  await page.evaluate(() => window.__installArmLock());
}

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300_000
  });
  const fails = [];
  const pages = [];
  try {
    for (const other of await browser.pages()) { try { await other.close(); } catch { /* gone */ } }
    const a = await browser.newPage();
    const b = await browser.newPage();
    pages.push(a, b);

    const room = `tmix_${Date.now()}`;
    // Both tabs must stay foregrounded-enough to run rAF. Chrome throttles a
    // fully hidden tab, so bring each to front around its own drawing turn.
    await a.bringToFront(); await boot(a, room, 'MIX_A');
    await b.bringToFront(); await boot(b, room, 'MIX_B');
    await sleep(SETTLE);

    console.log(`\n=== tiled mixed cohort   room ${room}   ${dims[1]}x${dims[0]}   tool ${TOOL}\n`);

    const blocks = async (p) => p.evaluate(() => window.__boardBlocks());
    const setTiled = async (p, on) => p.evaluate((v) => window.__setTiled(v), on);
    const draw = async (p, ox, oy) => {
      await p.bringToFront();
      await p.evaluate((x, y) => window.__drawAt(x, y, 220, 24), ox, oy);
    };

    console.log(`  eager-bake users: A ${await a.evaluate(() => window.__forceEagerBake())}`
      + `, B ${await b.evaluate(() => window.__forceEagerBake())}`);

    // The control establishes what "identical" actually measures between two
    // live clients. Every later arm is judged against it.
    let control = null;
    const check = async (label, expectA, expectB) => {
      await sleep(SETTLE);
      // Wait until BOTH clients are quiescent — two consecutive samples with an
      // unchanged pixel count — before judging. Without this, a stroke still in
      // flight reads as a whole-stroke block delta (measured: 1010px in one
      // block, ~2050px of stroke, with the very next sample agreeing to within
      // 7px), and a settling artifact is indistinguishable from data loss.
      //
      // Note this deliberately does NOT wait for equal `strokeStack` lengths.
      // Two clients legitimately bake different-length prefixes — that is the
      // documented benign `prefixDelta` — so stack equality never arrives and
      // waiting on it just burns the timeout (measured: A 41 vs B 40, stable).
      let da = await blocks(a);
      let db = await blocks(b);
      let waited = 0;
      let quiet = false;
      while (waited < CONVERGE) {
        await sleep(1000);
        waited += 1000;
        const na = await blocks(a);
        const nb = await blocks(b);
        if (na.nz === da.nz && nb.nz === db.nz) { da = na; db = nb; quiet = true; break; }
        da = na; db = nb;
      }
      if (!quiet) fails.push(`${label}: boards never went quiescent within ${SETTLE + waited}ms`);
      const converged = quiet;
      const d = blockDiff(da, db);
      if (!control) control = d;
      console.log(`  ${label.padEnd(26)}${converged ? "" : " [NOT QUIESCENT]"} A[tiled=${String(da.tiled).padEnd(5)} tiles=${String(da.tiles).padStart(4)} nz=${String(da.nz).padStart(7)} stack=${da.stack.join('/')} blk=${da.blocked}]`);
      console.log(`  ${''.padEnd(26)} B[tiled=${String(db.tiled).padEnd(5)} tiles=${String(db.tiles).padStart(4)} nz=${String(db.nz).padStart(7)} stack=${db.stack.join('/')} blk=${db.blocked}]`);
      console.log(`  ${''.padEnd(26)} diff: ${d.differing} blocks, sum ${d.sumAbs}px, worst block ${d.maxAbs}px, nz delta ${d.nzDelta}`
        + `   (control: ${control.differing} blocks / worst ${control.maxAbs}px)`);

      if (da.tiled !== expectA) fails.push(`${label}: A tiled flag is ${da.tiled}, expected ${expectA} (${da.blocked} external toggles blocked)`);
      if (db.tiled !== expectB) fails.push(`${label}: B tiled flag is ${db.tiled}, expected ${expectB} (${db.blocked} external toggles blocked)`);
      if ((expectA && da.tiles <= 0) || (expectB && db.tiles <= 0)) {
        fails.push(`${label}: the tiled arm has 0 allocated tiles — nothing reached flatCanvas, the arm is vacuous`);
      }
      // A lost or misplaced stroke is a whole-block-sized delta, orders of
      // magnitude above the antialiasing floor the control measures.
      const ceiling = Math.max(control.maxAbs * 4, 64);
      if (d.maxAbs > ceiling) {
        fails.push(`${label}: worst block differs by ${d.maxAbs}px, far above the control's ${control.maxAbs}px (ceiling ${ceiling})`);
      }
      return d;
    };

    // --- phase 1: control, both untiled ------------------------------------
    await draw(a, 120, 120);
    await draw(b, 900, 120);
    await check('1 both untiled (control)', false, false);

    // --- phase 2: A tiled ---------------------------------------------------
    console.log(`  A -> tiled: ${await setTiled(a, true)}`);
    await draw(a, 120, 480);
    await draw(b, 900, 480);
    await check('2 A tiled, B untiled', true, false);

    // --- phase 3: swap ------------------------------------------------------
    console.log(`  A -> untiled: ${await setTiled(a, false)}   B -> tiled: ${await setTiled(b, true)}`);
    await draw(a, 400, 120);
    await draw(b, 1300, 120);
    await check('3 A untiled, B tiled', false, true);

    // --- phase 4: undo/redo across the mixed cohort -------------------------
    // Eager bake has to come OFF first: it flattens every stroke into
    // flatCanvas immediately, so strokeStack is empty and there is nothing left
    // to undo — with it on, handleUndo() is a no-op and the arm is vacuous
    // (measured: nz identical across undo and redo). Instead push past
    // MAX_STROKES_PER_USER so a prefix bakes into the tiled grid while a live
    // undoable tail remains, which is the real configuration anyway.
    await a.evaluate(() => { window.app.board.layerManager.eagerBakeUsers = null; });
    await b.evaluate(() => { window.app.board.layerManager.eagerBakeUsers = null; });
    console.log(`  eager bake off; drawing ${OVERFLOW} quick strokes on each client to force a prefix bake`);
    for (let i = 0; i < OVERFLOW; i++) {
      await a.bringToFront();
      await a.evaluate((x, y) => window.__drawAt(x, y, 40, 5), 200 + (i % 11) * 45, 800 + Math.floor(i / 11) * 45);
      await b.bringToFront();
      await b.evaluate((x, y) => window.__drawAt(x, y, 40, 5), 1200 + (i % 11) * 45, 800 + Math.floor(i / 11) * 45);
    }
    const pre = await check('4 after overflow strokes', false, true);
    const stacks = await Promise.all([blocks(a), blocks(b)]);
    if (stacks[0].stack[0] === 0 || stacks[1].stack[0] === 0) {
      fails.push(`4: no undoable tail left (stacks ${stacks[0].stack[0]}/${stacks[1].stack[0]}) — the undo arms below are vacuous`);
    }
    void pre;

    await a.bringToFront();
    await a.evaluate(() => window.app.handleUndo());
    await check('4a A undo', false, true);
    await a.evaluate(() => window.app.handleRedo());
    await check('4b A redo', false, true);
    await b.bringToFront();
    await b.evaluate(() => window.app.handleUndo());
    await check('4c B(tiled) undo', false, true);
    await b.evaluate(() => window.app.handleRedo());
    await check('4d B(tiled) redo', false, true);

    // --- phase 5: late joiner ----------------------------------------------
    // B is tiled and has been drawing; C joins cold and must reach the same
    // board through the join/sync path.
    const c = await browser.newPage();
    pages.push(c);
    await c.bringToFront();
    await boot(c, room, 'MIX_C');
    await c.evaluate(() => window.__forceEagerBake());
    await sleep(SETTLE * 2);
    const dc = await blocks(c);
    const db2 = await blocks(b);
    const dj = blockDiff(db2, dc);
    console.log(`\n  5 late joiner            B[tiled=${db2.tiled} tiles=${db2.tiles} nz=${db2.nz} stack=${db2.stack.join('/')} blk=${db2.blocked}]`);
    console.log(`  ${''.padEnd(24)} C[tiled=${dc.tiled} tiles=${dc.tiles} nz=${dc.nz} stack=${dc.stack.join('/')}]`);
    console.log(`  ${''.padEnd(24)} diff: ${dj.differing} blocks, sum ${dj.sumAbs}px, worst block ${dj.maxAbs}px, nz delta ${dj.nzDelta}`
      + `   (control: ${control.differing} blocks / worst ${control.maxAbs}px)`);
    if (dj.maxAbs > Math.max(control.maxAbs * 4, 64)) {
      fails.push(`5 late joiner: worst block differs by ${dj.maxAbs}px vs control ${control.maxAbs}px`);
    }
    if (!db2.tiled) fails.push(`5 late joiner: host B lost its tiled arm before the joiner arrived (${db2.blocked} external toggles blocked)`);

    // And the same joiner, after it toggles itself tiled.
    await c.evaluate(() => window.__setTiled(true));
    const dc2 = await blocks(c);
    const dj2 = blockDiff(db2, dc2);
    console.log(`  5b joiner toggles tiled  C[tiled=${dc2.tiled} tiles=${dc2.tiles} nz=${dc2.nz}]`);
    console.log(`  ${''.padEnd(24)} diff: ${dj2.differing} blocks, sum ${dj2.sumAbs}px, worst block ${dj2.maxAbs}px, nz delta ${dj2.nzDelta}`);
    if (dj2.maxAbs > Math.max(control.maxAbs * 4, 64)) {
      fails.push(`5b: joiner worst block differs by ${dj2.maxAbs}px after toggling itself tiled`);
    }
    if (dc2.tiled && dc2.tiles <= 0) fails.push('5b: joiner toggled tiled but allocated 0 tiles — its baked content did not reach the grid');

    console.log(`\n  ${fails.length} failure(s)`);
    for (const f of fails) console.log(`    - ${f}`);
    if (fails.length) process.exitCode = 1;
  } finally {
    // Leave ONE page alive. Closing every tab of a CDP-attached Chrome exits
    // the browser, which takes the debugging port with it and breaks every
    // later harness run until someone relaunches it by hand.
    for (const p of pages.slice(1)) { try { await p.close(); } catch { /* gone */ } }
    try { await pages[0]?.goto('about:blank'); } catch { /* gone */ }
    await browser.disconnect();
  }
})();
