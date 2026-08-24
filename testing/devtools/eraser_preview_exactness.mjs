#!/usr/bin/env node
/**
 * @fileoverview Asserts the eraser's background-colour preview is EXACT.
 *
 * That path skips publishing a destination-out preview into the layer stack and
 * skips the per-frame composite entirely, drawing a background-coloured stroke
 * on the preview surface instead. The algebra says the two are identical — for
 * an opaque pixel D over background B with eraser alpha a, destination-out
 * composites to D(1-a)+Ba and painting B over D at globalAlpha a gives
 * Ba+D(1-a) — but "identical in principle" is worth nothing if the surfaces are
 * stacked or blended differently in practice. So this compares the pixels the
 * user actually sees MID-STROKE against the pixels left AFTER the commit.
 *
 * Also checks the gate: erasing on a layer with content beneath it must fall
 * back to the destination-out path, because there the preview would paint
 * background over pixels that should be revealed.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/eraser_preview_exactness.mjs
 */

import puppeteer from 'puppeteer';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const READY_TIMEOUT = Number(process.env.READY_TIMEOUT || 120_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sampled from the on-screen stack, not from any single canvas: the point is to
// catch a preview that is correct in isolation but stacked or blended wrongly.
const HELPERS = `(() => {
  const app = window.app;

  window.__composited = function (x, y, w, h) {
    const board = app.board;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true });
    const bg = board.getCompositeBackgroundColor();
    octx.fillStyle = 'rgba(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ',' + (bg[3] ?? 1) + ')';
    octx.fillRect(0, 0, w, h);
    // Paint order as the browser sees it: main canvas, then the preview
    // surfaces, then the upper-layer canvas on top.
    for (const c of [board.mainCanvas, board.topCanvas, board.upperLayersCanvas]) {
      if (!c) continue;
      if (c.style && c.style.opacity === '0') continue;
      octx.drawImage(c, x, y, w, h, 0, 0, w, h);
    }
    return Array.from(octx.getImageData(0, 0, w, h).data);
  };

  window.__diff = function (a, b) {
    let worst = 0, differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i + k] - b[i + k]));
      if (d > 2) differing++;
      if (d > worst) worst = d;
    }
    return { worst, differing, total: a.length / 4 };
  };

  window.__setLayer = function (i) {
    app.self.activeLayer = i;
    app.layerController?.setActiveLayer?.(i);
    return app.self.activeLayer;
  };

  window.__brushStroke = async function (x0, y0, x1, y1) {
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
    for (let i = 1; i <= 14; i++) { ev('pointermove', x0 + (x1-x0)*(i/14), y0 + (y1-y0)*(i/14)); await raf(); }
    ev('pointerup', x1, y1);
    await raf(); await raf();
  };

  // Erase across a box, sampling the visible stack while the pointer is DOWN,
  // then again once the stroke has committed.
  window.__eraseAndCompare = async function (box) {
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

    const y = box.y + box.h / 2;
    ev('pointermove', box.x + 10, y); ev('pointerdown', box.x + 10, y);
    for (let i = 1; i <= 16; i++) { ev('pointermove', box.x + 10 + i * 14, y); await raf(); }
    await raf(); await raf();

    const usedBackgroundPreview =
      app.toolManager.getTool('erase')._canUseBackgroundPreview(app.self);
    const preview = window.__composited(box.x, box.y, box.w, box.h);

    ev('pointerup', box.x + 10 + 16 * 14, y);
    await raf(); await raf(); await raf();
    const committed = window.__composited(box.x, box.y, box.w, box.h);

    return { usedBackgroundPreview, ...window.__diff(preview, committed) };
  };
  return true;
})()`;

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '\x1b[32m✅ PASS\x1b[0m' : '\x1b[31m❌ FAIL\x1b[0m'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures++;
  };

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: READY_TIMEOUT });
    await page.evaluate(HELPERS);

    const room = `exact_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'EXACT'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: READY_TIMEOUT });
    await sleep(1500);
    console.log(`\n=== eraser preview exactness   room ${room}\n`);

    // --- Case 1: bottom layer, nothing beneath. The fast path must engage and
    // the preview must match the commit.
    await page.evaluate(() => { window.__setLayer(0); window.app.selectTool('brush'); window.app.self.size = 60; });
    await page.evaluate(() => window.__brushStroke(120, 300, 460, 300));
    await sleep(500);
    await page.evaluate(() => { window.app.selectTool('erase'); window.app.self.size = 26; });
    const bottom = await page.evaluate(() => window.__eraseAndCompare({ x: 100, y: 250, w: 360, h: 100 }));
    check('layer 0: background preview engaged', bottom.usedBackgroundPreview === true);
    check('layer 0: preview matches commit', bottom.differing === 0,
      `worst channel Δ ${bottom.worst}, ${bottom.differing}/${bottom.total} px differ`);

    // --- Case 2: partial opacity. The algebra claims exactness for every alpha,
    // not just 1.
    await page.evaluate(() => { window.__setLayer(0); window.app.selectTool('brush'); window.app.self.size = 60; });
    await page.evaluate(() => window.__brushStroke(120, 600, 460, 600));
    await sleep(500);
    await page.evaluate(() => { window.app.selectTool('erase'); window.app.self.size = 26; window.app.self.opacity = 0.45; });
    const partial = await page.evaluate(() => window.__eraseAndCompare({ x: 100, y: 550, w: 360, h: 100 }));
    check('opacity 0.45: background preview engaged', partial.usedBackgroundPreview === true);
    check('opacity 0.45: preview matches commit', partial.differing === 0,
      `worst channel Δ ${partial.worst}, ${partial.differing}/${partial.total} px differ`);
    await page.evaluate(() => { window.app.self.opacity = 1; });

    // --- Case 3: content on a layer BENEATH the stroke layer. Erasing should
    // reveal those pixels, so the fast path must refuse and fall back.
    const gate = await page.evaluate(() => {
      const lm = window.app.board.layerManager;
      window.__setLayer(1);
      return {
        belowHasContent: lm.rangeHasRenderableContent(0, 1),
        canFastPath: window.app.toolManager.getTool('erase')._canUseBackgroundPreview(window.app.self)
      };
    });
    check('layer 1: content below is detected', gate.belowHasContent === true);
    check('layer 1: background preview refused', gate.canFastPath === false);

    console.log(`\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await browser.disconnect();
  }
})();
