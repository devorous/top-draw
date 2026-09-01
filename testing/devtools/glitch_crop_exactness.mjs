#!/usr/bin/env node
/**
 * @fileoverview Proves the cached-pixel crop path produces byte-identical glitch
 * output to the old per-stamp readback path.
 *
 * `_cropSnapshotRegion` no longer does a `drawImage` + `getImageData` per stamp;
 * it copies rows out of a full-board ImageData read back once per stroke. That
 * is a pixel-producing path, so "it's obviously the same pixels" is not good
 * enough — this draws the SAME deterministic stroke twice, once with the cache
 * populated and once with it cleared (which forces the old fallback branch),
 * and diffs the resulting layer.
 *
 * Usage:
 *   CDP_URL=http://127.0.0.1:9222 node testing/devtools/glitch_crop_exactness.mjs
 */

import puppeteer from 'puppeteer';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());
  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 120_000 });
    const room = `gx_${Date.now()}`;
    await page.evaluate((r) => { window.app.self.username = 'GX'; window.app.handleRoomSelected(r); }, room);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: 120_000 });
    await sleep(2500);

    const result = await page.evaluate(async () => {
      const app = window.app;
      const tool = app.toolManager.getTool('glitchBlur');
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
      const raf = () => new Promise((r) => requestAnimationFrame(r));

      // Deterministic path — no Math.random anywhere, so both runs stamp the
      // same points with the same radius.
      const stroke = async (tag) => {
        const ox = 300, oy = 300, span = 260, pts = 24;
        ev('pointermove', ox, oy); ev('pointerdown', ox, oy);
        for (let i = 1; i <= pts; i++) {
          const a = (i / pts) * Math.PI * 2;
          ev('pointermove', ox + span * 0.5 * (1 + Math.cos(a)), oy + span * 0.5 * (1 + Math.sin(a)));
          await raf();
        }
        ev('pointerup', ox + span * 0.5, oy + span);
        await raf(); await raf();
        await new Promise((r) => setTimeout(r, 400));
      };

      const layerPixels = () => {
        const lm = app.board.layerManager;
        const c = document.createElement('canvas'); c.width = bw; c.height = bh;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        lm.compositeLayerRange(ctx, 0, 1, null);
        return ctx.getImageData(0, 0, bw, bh).data;
      };

      // A fixed base image for the glitch to smear, identical for both runs.
      const paintBase = () => {
        app.board.clear();
        const lm = app.board.layerManager;
        const g = lm.layerGroups[0];
        const ctx = g.flatCtx;
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = `hsl(${(i * 37) % 360} 80% 55%)`;
          ctx.fillRect(200 + (i % 10) * 40, 200 + Math.floor(i / 10) * 40, 36, 36);
        }
        app.board.markCompositeFull();
        app.board.compositeAllLayers();
      };

      app.selectTool('glitchBlur');
      await new Promise((r) => setTimeout(r, 300));

      // Run A — cached-pixel path (current behaviour).
      paintBase();
      tool.__forceFallback = false;
      await stroke('cached');
      const a = layerPixels();

      // Run B — force the old per-stamp drawImage + getImageData branch by
      // emptying the pixel cache as soon as each snapshot is taken.
      paintBase();
      const origCapture = tool.captureSnapshot.bind(tool);
      tool.captureSnapshot = function (userId, layerIdx) {
        const out = origCapture(userId, layerIdx);
        tool.snapshotPixels.clear();
        return out;
      };
      await stroke('fallback');
      const b = layerPixels();
      tool.captureSnapshot = origCapture;

      let diff = 0, worst = 0, aNonZero = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { diff++; worst = Math.max(worst, Math.abs(a[i] - b[i])); }
      }
      for (let i = 3; i < a.length; i += 4) if (a[i] !== 0) aNonZero++;
      return { bytes: a.length, diff, worst, aNonZero, w: bw, h: bh };
    });

    console.log(`\n=== glitch crop exactness  ${result.w}x${result.h}`);
    console.log(`    non-transparent px after the glitch stroke: ${result.aNonZero}`);
    console.log(`    differing bytes: ${result.diff} of ${result.bytes}   worst channel delta: ${result.worst}`);
    if (result.aNonZero === 0) {
      console.log('\n    INCONCLUSIVE — the stroke deposited nothing, so the comparison is vacuous\n');
      process.exitCode = 1;
    } else if (result.diff === 0) {
      console.log('\n    PASS — cached-pixel crop is byte-identical to the per-stamp readback\n');
    } else {
      console.log('\n    FAIL — the crop paths disagree\n');
      process.exitCode = 1;
    }
  } finally {
    await browser.disconnect();
  }
})();
