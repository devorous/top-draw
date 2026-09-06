#!/usr/bin/env node
/**
 * @fileoverview Guards the one regression Board._compositeUpperLayers' new
 * emptiness skip could cause: content on a layer ABOVE the one being drawn on
 * must keep rendering.
 *
 * The composite now skips the upper-layer pass entirely when
 * LayerManager.rangeHasRenderableContent() says nothing up there can paint. If
 * that test is ever wrong, the symptom is silent — upper layers simply vanish
 * while drawing — and neither test:parity nor test:concurrent covers it,
 * because both draw on a single layer.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/upper_layer_visibility_check.mjs
 */

import puppeteer from 'puppeteer';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `(() => {
  const app = window.app;

  // pointerdown on #board, move/up on window.
  window.__stroke = async function (x0, y0, x1, y1, steps = 12) {
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
    ev('pointermove', x0, y0); ev('pointerdown', x0, y0);
    for (let i = 1; i <= steps; i++) {
      ev('pointermove', x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps));
      await raf();
    }
    ev('pointerup', x1, y1);
    await raf(); await raf();
  };

  // Opaque pixels in a box on the visible main canvas.
  window.__inkAt = function (x, y, w, h) {
    const c = app.board.viewCanvas;
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  };

  window.__setLayer = function (i) {
    app.self.activeLayer = i;
    if (app.layerController?.setActiveLayer) app.layerController.setActiveLayer(i);
    return app.self.activeLayer;
  };

  window.__layerCount = () => app.board.layerManager.getLayerCount();
  return true;
})()`;

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '[32m✅ PASS[0m' : '[31m❌ FAIL[0m'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
  };

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(HELPERS);

    const room = `upvis_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'UPVIS'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await sleep(1500);

    const layers = await page.evaluate(() => window.__layerCount());
    console.log(`\n=== upper-layer visibility check   ${layers} layers, room ${room}\n`);
    if (layers < 2) throw new Error(`need >= 2 layers, room has ${layers}`);

    // Paint a marker on layer 1, well away from where we will erase on layer 0.
    await page.evaluate(() => { window.app.selectTool('brush'); window.__setLayer(1); });
    await page.evaluate(() => window.app.self.setSize?.(40) ?? (window.app.self.size = 40));
    await page.evaluate(() => window.__stroke(600, 120, 900, 120));
    await sleep(600);

    const markerBefore = await page.evaluate(() => window.__inkAt(600, 90, 300, 60));
    check('layer 1 marker painted', markerBefore > 0, `${markerBefore} px`);

    // Now erase on layer 0. Mid-stroke is exactly when the upper-layer composite
    // runs, so sample while the pointer is still down.
    await page.evaluate(() => { window.app.selectTool('erase'); window.__setLayer(0); });
    const during = await page.evaluate(async () => {
      const app = window.app;
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
      ev('pointermove', 200, 600); ev('pointerdown', 200, 600);
      for (let i = 1; i <= 20; i++) { ev('pointermove', 200 + i * 15, 600); await raf(); }
      await raf();
      const mid = window.__inkAt(600, 90, 300, 60);   // sampled WITH the pointer down
      ev('pointerup', 500, 600);
      await raf(); await raf();
      return mid;
    });
    check('layer 1 marker survives mid-erase on layer 0', during > 0, `${during} px (was ${markerBefore})`);

    await sleep(600);
    const after = await page.evaluate(() => window.__inkAt(600, 90, 300, 60));
    check('layer 1 marker survives after erase commits', after > 0, `${after} px`);

    // And the emptiness test itself: with content on layer 1, a range covering
    // it must report renderable; a range past the top must not.
    const flags = await page.evaluate(() => {
      const lm = window.app.board.layerManager;
      const n = lm.getLayerCount();
      return {
        coveringLayer1: lm.rangeHasRenderableContent(1, n),
        pastTop: lm.rangeHasRenderableContent(n, n)
      };
    });
    check('rangeHasRenderableContent(1, n) is true with content on layer 1', flags.coveringLayer1 === true);
    check('rangeHasRenderableContent(n, n) is false for an empty range', flags.pastTop === false);

    console.log(`\n${failures === 0 ? '[32mALL CHECKS PASSED[0m' : `[31m${failures} CHECK(S) FAILED[0m`}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await browser.disconnect();
  }
})();
