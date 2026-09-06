#!/usr/bin/env node
/**
 * @fileoverview Measures the "only render what's on screen" side of the tiled
 * rendering system: Board.viewportCulling clipping composite dirty rects to
 * getVisibleBoardRect(), crossed with the tiled backing store, at several
 * zoom levels.
 *
 * At high zoom the visible board rect shrinks, so culling ON should submit
 * fewer tiles per composite (TiledLayerCanvas.lastCompositeTileCount) and,
 * on weak hardware, hold or improve fps vs a full every-tile composite.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 WS_URL=ws://127.0.0.1:8030 \
 *     TARGET_URL=http://localhost:3000/go/ node testing/devtools/tiled_zoom_probe.mjs
 */

import puppeteer from 'puppeteer';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8030';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = 120_000;
const ZOOMS = [1, 2, 4, 8];
const REPS = 3;
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

  window.__paintDense = function () {
    const lm = app.board.layerManager;
    const [h, w] = app.board.dimensions;
    app.board.clear();
    lm.withFlatCanvasContext(0, (ctx) => {
      for (let i = 0; i < 400; i++) {
        const gx = i % 20, gy = Math.floor(i / 20);
        ctx.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 80% 55%)';
        ctx.fillRect(Math.round(gx * (w / 20)) + 4, Math.round(gy * (h / 20)) + 4, 40, 40);
      }
    });
    app.board.markCompositeFull();
    app.board.compositeAllLayers();
  };

  // Centre the view on a board point at a given zoom, using the board's own
  // forward transform (screenX = boardX*zoom + panX) so the mapping is exact
  // regardless of rotation/flip state (both default off here).
  window.__setZoomCentered = function (zoom, bx, by) {
    const board = app.board;
    const rect = document.getElementById('boards').getBoundingClientRect();
    board.zoom = zoom;
    board.panX = rect.width / 2 - bx * zoom;
    board.panY = rect.height / 2 - by * zoom;
    board.applyTransform();
  };

  window.__drive = async function ({ strokes, pts = 24, span = 120, bx, by, zoom }) {
    const rect = document.getElementById('boards').getBoundingClientRect();
    const board = app.board;
    const toClient = (x, y) => ({
      clientX: rect.left + x * zoom + board.panX,
      clientY: rect.top + y * zoom + board.panY
    });
    const down = document.getElementById('board');
    const raf = () => new Promise(r => requestAnimationFrame(r));
    const fire = (type, x, y) => {
      const p = toClient(x, y);
      const e = new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true,
        cancelable: true, composed: true, clientX: p.clientX, clientY: p.clientY,
        buttons: type === 'pointerup' ? 0 : 1, button: 0,
        pressure: type === 'pointerup' ? 0 : 0.5
      });
      (type === 'pointerdown' ? down : window).dispatchEvent(e);
    };
    for (let s = 0; s < strokes; s++) {
      const ox = bx + (Math.random() - 0.5) * span, oy = by + (Math.random() - 0.5) * span;
      fire('pointermove', ox, oy); fire('pointerdown', ox, oy);
      for (let p = 1; p <= pts; p++) {
        const a = (p / pts) * Math.PI * 2;
        fire('pointermove', ox + span * 0.5 * Math.cos(a), oy + span * 0.5 * Math.sin(a));
        await raf();
      }
      fire('pointerup', ox + span * 0.5, oy);
      await raf(); await raf();
    }
  };

  window.__setCulling = function (on) {
    app.board.viewportCulling = !!on;
    if (!on) app.board.ensureFullComposite?.();
  };

  window.__setTiled = function (on) {
    app.board.layerManager.setTiledBackingStore(!!on);
  };

  window.__tileInfo = function () {
    const g = app.board.layerManager.layerGroups[0];
    const fc = g.flatCanvas;
    if (!g.tiled || !fc) return { tiled: false, lastComposite: null, total: null, allocated: null };
    return { tiled: true, lastComposite: fc.lastCompositeTileCount, total: fc.cols * fc.rows, allocated: fc.allocatedTileCount };
  };

  window.__measure = async function (cfg) {
    const f = window.__frames;
    f.gaps.length = 0; f.last = 0; f.on = true;
    const t0 = performance.now();
    await window.__drive(cfg);
    // one more composite so lastCompositeTileCount reflects the final view
    app.board.markCompositeFull(); app.board.compositeAllLayers();
    const ms = performance.now() - t0;
    f.on = false;
    const g = f.gaps.slice(2);
    const view = app.board.getVisibleBoardRect();
    return {
      frames: g.length,
      fps: +(g.length / (ms / 1000)).toFixed(1),
      tile: window.__tileInfo(),
      viewFrac: view ? +((view.width * view.height) / (app.board.getWidth() * app.board.getHeight())).toFixed(3) : 1
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
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null, protocolTimeout: 240_000 });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    for (const other of await browser.pages()) {
      if (other !== page) { try { await other.close(); } catch {} }
    }
    await page.bringToFront();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    const vis = await page.evaluate(() => document.visibilityState);
    if (vis !== 'visible') throw new Error(`page is ${vis} — rAF will not fire`);
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(SETUP);
    await page.evaluate(async () => {
      try { window.__wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    });

    const room = `zoomtab_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'ZOOM'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null, { timeout: READY_TIMEOUT });
    await page.evaluate((h, w) => window.__lockBoardSize(h, w), 1440, 2560);
    await sleep(1500);
    const actual = await page.evaluate(() => window.app.board.dimensions);
    console.log(`board ${actual[1]}x${actual[0]}`);
    await page.evaluate(() => window.app.selectTool('brush'));
    await page.evaluate(() => window.__paintDense());

    const bx = actual[1] / 2, by = actual[0] / 2;
    console.log('\n=== viewport culling x tiled x zoom, dense board, solo drawing near centre ===\n');
    console.log('zoom  tiled  cull   fps   viewFrac  tilesComposited/total');

    const results = [];
    for (const zoom of ZOOMS) {
      for (const tiled of [false, true]) {
        for (const cull of [false, true]) {
          await page.evaluate((z, bx, by) => window.__setZoomCentered(z, bx, by), zoom, bx, by);
          await page.evaluate((t) => window.__setTiled(t), tiled);
          await page.evaluate((c) => window.__setCulling(c), cull);
          await sleep(150);
          const runs = [];
          for (let i = 0; i < REPS; i++) {
            const r = await page.evaluate((bx, by, zoom) =>
              window.__measure({ strokes: 4, pts: 24, span: 60, bx, by, zoom }), bx, by, zoom);
            if (r.frames === 0) throw new Error('0 frames — display blanked, abort');
            runs.push(r);
          }
          const fps = med(runs.map((r) => r.fps));
          const last = runs[runs.length - 1];
          const tileStr = last.tile.tiled ? `${last.tile.lastComposite}/${last.tile.total}` : 'n/a (untiled)';
          console.log(`${String(zoom).padStart(4)}  ${String(tiled).padStart(5)}  ${String(cull).padStart(4)}  ${String(fps).padStart(5)}  ${String(last.viewFrac).padStart(8)}  ${tileStr}`);
          results.push({ zoom, tiled, cull, fps, viewFrac: last.viewFrac, tile: last.tile });
        }
      }
    }

    console.log('\n=== summary: does culling reduce tiles composited as zoom increases? (tiled arm only) ===');
    for (const zoom of ZOOMS) {
      const off = results.find((r) => r.zoom === zoom && r.tiled && !r.cull);
      const on = results.find((r) => r.zoom === zoom && r.tiled && r.cull);
      console.log(`  zoom ${zoom}x: cull off ${off.tile.lastComposite}/${off.tile.total} tiles, fps ${off.fps}   `
        + `cull on ${on.tile.lastComposite}/${on.tile.total} tiles, fps ${on.fps}`);
    }
  } finally {
    await browser.disconnect();
  }
})();
