#!/usr/bin/env node
/**
 * @fileoverview Finds the bot count at which the observed client actually
 * starts to struggle, so a subsequent A/B is run in a regime where the thing
 * being measured can matter at all.
 *
 * Bots are added CUMULATIVELY — each step spawns another k6 process whose VUs
 * join and stay — rather than restarting k6 at a higher count. Restarting
 * tears down every peer and re-runs the join storm, which is its own
 * (large, transient) cost and would swamp the steady-state signal we want.
 *
 * Reports achieved rAF interval, not mean fps: the signature of this kind of
 * pressure is a stall, not a uniform slowdown (see board_lag_measurement_harness
 * trap 3 — median 5.6ms with p99 at 200ms).
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9223 node testing/devtools/load_ramp.mjs \
 *     --steps=10,20,40,60,80 --size=1440p
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const STEPS = String(arg('steps', '10,20,40,60,80')).split(',').map(Number);
const SIZE = arg('size', '1440p');
const CLUSTERS = Number(arg('clusters', 4));
const SETTLE = Number(arg('settle', 25_000));
const STROKES = Number(arg('strokes', 5));
const SPAN = Number(arg('span', 400));
const K6_SCRIPT = arg('k6script', 'testing/medium_stress_test.js');
const K6_DURATION = arg('k6duration', '40m');
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9223';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);

const BOARD_SIZES = {
  '720p': [720, 1280], '1080p': [1080, 1920], '1440p': [1440, 2560],
  big: [1800, 3200], '4k': [2160, 3840]
};
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

  // Real canvas bytes the app is holding, across every bucket — the per-remote
  // -user canvases are the term that scales with bot count.
  window.__censusMB = function () {
    try {
      const lm = app.board.layerManager;
      let bytes = 0;
      const add = (c) => {
        if (!c) return;
        if (Array.isArray(c.tiles) && typeof c.allocatedBytes === 'number') { bytes += c.allocatedBytes; return; }
        bytes += (c.width | 0) * (c.height | 0) * 4;
      };
      for (const g of lm.layerGroups) {
        add(g.flatCanvas);
        for (const s of g.bakedSequences || []) add(s.canvas);
        for (const s of g.strokeStack || []) add(s.canvas);
        for (const [, a] of g.activeStrokeByUser || []) add(a.canvas);
      }
      add(app.board.viewCanvas); add(app.board.topCanvas);
      for (const el of document.querySelectorAll('canvas.userBoard')) add(el);
      for (const [, u] of (app.users || new Map())) { add(u._inkOffscreen); add(u._penOffscreen); }
      return +(bytes / 1048576).toFixed(1);
    } catch { return -1; }
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
      frames: g.length,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1),
      max: +Math.max(0, ...g).toFixed(0),
      over50: g.filter(v => v > 50).length,
      over100: g.filter(v => v > 100).length,
      peers: app.users?.size ?? -1,
      mb: window.__censusMB()
    };
  };
  return true;
})()`;

(async () => {
  const browser = await puppeteer.connect({
    browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 300_000
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const k6s = [];
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

    const room = `ramp_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'RAMP'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), dims[0], dims[1]);
    await sleep(1500);
    const actual = await page.evaluate(() => window.app.board.dimensions);
    if (actual[0] !== dims[0] || actual[1] !== dims[1]) {
      throw new Error(`board size did not take: wanted ${dims}, got ${actual}`);
    }
    await page.evaluate(() => window.app.selectTool('brush'));

    console.log(`\n=== load ramp   ${SIZE} ${actual[1]}x${actual[0]}   clusters=${CLUSTERS}   room ${room}`);
    console.log(`    looking for the bot count where the observed client starts to stall\n`);
    console.log('  bots  peers     fps     p50     p95     p99     max  >50ms >100ms   canvasMB');

    const row = (label, peers, r) => console.log(`  ${String(label).padStart(4)}`
      + `${String(peers).padStart(7)}${String(r.fps).padStart(8)}${String(r.p50).padStart(8)}`
      + `${String(r.p95).padStart(8)}${String(r.p99).padStart(8)}${String(r.max).padStart(8)}`
      + `${String(r.over50).padStart(7)}${String(r.over100).padStart(7)}${String(r.mb).padStart(11)}`);

    const base = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
    row(0, base.peers, base);

    let running = 0;
    for (const target of STEPS) {
      const add = target - running;
      if (add > 0) {
        const k6Args = ['run', '-e', `ROOM=${room}`, '-e', `TARGET_URL=${WS_URL}`,
          '-e', `BOARD_W=${actual[1]}`, '-e', `BOARD_H=${actual[0]}`,
          '-e', `CLUSTERS=${CLUSTERS}`,
          `--vus=${add}`, `--duration=${K6_DURATION}`, K6_SCRIPT];
        const k6 = spawn('k6', k6Args, { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' });
        k6.stderr.on('data', (d) => { const t = String(d).trim(); if (t) console.log(`  [k6] ${t.slice(0, 160)}`); });
        k6s.push(k6);
        running = target;
      }
      await sleep(SETTLE);
      const r = await page.evaluate((s, sp) => window.__measure({ strokes: s, pts: 30, span: sp }), STROKES, SPAN);
      if (r.frames === 0) throw new Error('0 frames — page not rendering, abort');
      row(target, r.peers, r);
      // Stop climbing once it is clearly struggling: more headroom past this
      // point only risks losing the tab, and the A/B wants the knee, not the
      // far side of it.
      if (r.fps < 20 || r.over100 > 10) {
        console.log(`\n  struggling at ${target} bots (fps ${r.fps}, ${r.over100} frames >100ms) — stopping ramp`);
        break;
      }
    }
    console.log('');
  } finally {
    for (const k of k6s) { try { k.kill(); } catch { /* gone */ } }
    await browser.disconnect();
  }
})();
