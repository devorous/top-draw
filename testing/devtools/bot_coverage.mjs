#!/usr/bin/env node
/**
 * @fileoverview Sanity probe: do the k6 bots actually paint across the whole
 * board, and does the tiled backing store leave the untouched tiles
 * unallocated?
 *
 * Prints the tile occupancy grid directly, because that grid IS the claim.
 * A run whose bots all sit in the top-left corner produces a map that is
 * obviously wrong at a glance, whereas an aggregate "MB saved" number looks
 * fine either way — which is how a stress script hardcoded to 1920x1080
 * silently measured the corner of a 12k board.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9223 node testing/devtools/bot_coverage.mjs \
 *     --size=4k --vus=8 --clusters=0 --samples=4
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const SIZE = arg('size', '4k');
const VUS = Number(arg('vus', 8));
const CLUSTERS = Number(arg('clusters', 0));
// Coordinate space handed to the bots. Defaults to the real board, but the
// ROOM is still whatever the server thinks it is (a client-side resizeBoard
// does not change it), so this can be pinned lower to test whether
// out-of-range coords are what the server is dropping bots for.
const BOT_W = Number(arg('botw', 0));
const BOT_H = Number(arg('both', 0));
const SAMPLES = Number(arg('samples', 4));
const INTERVAL = Number(arg('interval', 20_000));
const K6_SCRIPT = arg('k6script', 'testing/medium_stress_test.js');
const K6_DURATION = arg('k6duration', '20m');
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  big: [1800, 3200], '4k': [2160, 3840], '8k': [4320, 7680], '12k': [6480, 11520]
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

  // The server is authoritative for the tiled setting and this room's flag is
  // off, so ROOM_UPDATEs would keep switching it back off mid-run.
  window.__armSetting = false;
  window.__blocked = 0;
  window.__installArmLock = function () {
    const board = app.board;
    let lm = board.layerManager;
    const patch = (m) => {
      if (!m || m.__armLocked) return m;
      m.__armLocked = true;
      const orig = m.setTiledBackingStore.bind(m);
      m.setTiledBackingStore = (v) => {
        if (!window.__armSetting) { window.__blocked++; return; }
        return orig(v);
      };
      return m;
    };
    patch(lm);
    Object.defineProperty(board, 'layerManager', {
      configurable: true, get: () => lm, set: (v) => { lm = patch(v); }
    });
  };
  window.__setTiled = function (on) {
    window.__armSetting = true;
    try { app.board.layerManager.setTiledBackingStore(on); }
    finally { window.__armSetting = false; }
    return app.board.layerManager.layerGroups[0].tiled;
  };

  window.__occupancy = function () {
    const g = app.board.layerManager.layerGroups[0];
    const fc = g.flatCanvas;
    if (!g.tiled) return null;
    const rows = [];
    for (let r = 0; r < fc.rows; r++) {
      let line = '';
      for (let c = 0; c < fc.cols; c++) line += fc.tiles[r * fc.cols + c] ? '#' : '.';
      rows.push(line);
    }
    // Tiles only appear once strokes BAKE into flatCanvas. Until a user hits
    // MAX_STROKES_PER_USER (20) their strokes sit in strokeStack and the tile
    // grid stays empty — so an all-dots map means "not baked yet", not
    // necessarily "bots painted nothing". Report both so the two are
    // distinguishable at a glance.
    let stackDepth = 0, activeStrokes = 0;
    for (const grp of app.board.layerManager.layerGroups) {
      stackDepth += grp.strokeStack?.length || 0;
      activeStrokes += grp.activeStrokeByUser?.size || 0;
    }
    return {
      rows, cols: fc.cols, rowCount: fc.rows,
      tiles: fc.allocatedTileCount, total: fc.cols * fc.rows,
      mb: +(fc.allocatedBytes / 1048576).toFixed(2),
      fullMb: +((fc.width * fc.height * 4) / 1048576).toFixed(2),
      peers: app.users?.size ?? -1,
      stackDepth, activeStrokes,
      blocked: window.__blocked
    };
  };
  return true;
})()`;

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300_000
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  let k6 = null;
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

    const room = `cov_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'COV'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);
    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board size did not take: wanted ${dims}, got ${actual}`);
    }
    await page.evaluate(() => window.__installArmLock());
    const on = await page.evaluate(() => window.__setTiled(true));
    if (!on) throw new Error('tiled backing store did not engage');

    console.log(`\n=== bot coverage   ${SIZE} ${actual[1]}x${actual[0]}   ${VUS} VUs   clusters=${CLUSTERS}   room ${room}`);

    const k6Args = ['run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`,
      '-e', `BOARD_W=${BOT_W || actual[1]}`, '-e', `BOARD_H=${BOT_H || actual[0]}`,
      '-e', `CLUSTERS=${CLUSTERS}`,
      `--vus=${VUS}`, `--duration=${K6_DURATION}`, K6_SCRIPT];
    k6 = spawn('k6', k6Args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
    k6.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log(`  [k6] ${t.slice(0, 160)}`); });

    for (let i = 1; i <= SAMPLES; i++) {
      await sleep(INTERVAL);
      const o = await page.evaluate(() => window.__occupancy());
      if (!o) throw new Error('layer 0 is not tiled — cannot report occupancy');
      console.log(`\n  t+${(i * INTERVAL / 1000).toFixed(0)}s   peers ${o.peers}   `
        + `tiles ${o.tiles}/${o.total}   ${o.mb}MB of ${o.fullMb}MB full-board   `
        + `(${(100 - (o.mb / o.fullMb) * 100).toFixed(1)}% saved)
`
        + `           strokeStack ${o.stackDepth}   active ${o.activeStrokes}   [${o.blocked} server overrides blocked]`);
      for (const line of o.rows) console.log(`    ${line}`);
    }

    const fin = await page.evaluate(() => window.__occupancy());
    const touchedCols = new Set(), touchedRows = new Set();
    fin.rows.forEach((line, r) => {
      [...line].forEach((ch, c) => { if (ch === '#') { touchedRows.add(r); touchedCols.add(c); } });
    });
    console.log(`\n  coverage: ${touchedCols.size}/${fin.cols} tile columns, ${touchedRows.size}/${fin.rowCount} tile rows touched`);
    if (fin.tiles === 0) {
      console.log(fin.stackDepth > 0
        ? `  NOTE — ${fin.stackDepth} strokes are live in strokeStack but none have baked into flatCanvas yet`
          + ' (prefix bake needs MAX_STROKES_PER_USER=20 per user). Run longer or force a bake.'
        : '  WARNING — no strokes reached this client at all; the bots are not painting.');
    } else if (touchedCols.size <= Math.ceil(fin.cols / 2) && CLUSTERS === 0) {
      console.log('  WARNING — free-roam bots touched only the left half; BOARD_W may not be reaching the k6 script');
    }
    console.log('');
  } finally {
    if (k6) { try { k6.kill(); } catch { /* gone */ } }
    await browser.disconnect();
  }
})();
