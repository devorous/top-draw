#!/usr/bin/env node

/**
 * @fileoverview Full-suite sync test for all drawing tools using Puppeteer.
 *
 * Spawns N browser bots in the same room, has one bot draw with each tool,
 * waits for propagation, then pixel-hashes every client's canvas and compares.
 * On mismatch, screenshots from all bots are saved to testing/sync_results/<run-id>/.
 * A pass/fail summary is printed at the end.
 *
 * Usage:
 *   node testing/tool_sync_suite.js
 *
 * Env vars:
 *   TARGET_URL   - Frontend URL         (default: http://localhost:3000/top-draw/)
 *   NUM_USERS    - Number of bots       (default: 3)
 *   HEADLESS     - false to show UI     (default: true)
 *   TOOLS        - Comma-sep tool names (default: all)
 *   PROPAGATION_MS - Wait after drawing (default: 4000)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const TARGET_URL    = process.env.TARGET_URL     || 'http://localhost:3000/go/';
const NUM_USERS     = parseInt(process.env.NUM_USERS || '2');
const HEADLESS      = process.env.HEADLESS !== 'false';
const PROPAGATION   = parseInt(process.env.PROPAGATION_MS || '4000');
const RUN_ID        = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR   = path.join(__dirname, 'sync_results', RUN_ID);
const SUMMARY_FILE  = path.join(RESULTS_DIR, 'summary.json');

// Filter to specific tools if provided
const TOOL_FILTER   = process.env.TOOLS ? process.env.TOOLS.split(',') : null;

// ─── Tool Definitions ──────────────────────────────────────────────────────

/**
 * Each entry describes one tool test case.
 *
 * needsBase  - draw a red filled rect first so the tool has pixels to work on
 * mockImage  - inject a 1x1 PNG as the imageBrush source before drawing
 * isShape    - tool is a single click-drag shape (no multi-point path needed)
 * concurrent - ALL bots draw at once instead of just bot 0
 */
const TOOL_SUITE = [
  { tool: 'brush',       label: 'Brush',         color: [220,  60,  60, 1] },
  { tool: 'flowPen',     label: 'Flow Pen',       color: [ 60, 180,  60, 1] },
  { tool: 'ink',         label: 'Ink',            color: [ 60,  60, 220, 1] },
  { tool: 'pixel',       label: 'Pixel Brush',    color: [200, 130,   0, 1] },
  { tool: 'line',        label: 'Line',           color: [160,   0, 200, 1], isShape: true },
  { tool: 'rectangle',   label: 'Rectangle',      color: [  0, 180, 200, 1], isShape: true },
  { tool: 'circle',      label: 'Circle',         color: [200,  80, 160, 1], isShape: true },
  { tool: 'erase',       label: 'Eraser',         color: [  0,   0,   0, 1], needsBase: true },
  { tool: 'fill',        label: 'Flood Fill',     color: [255, 200,   0, 1], needsBase: true },
  { tool: 'blur',        label: 'Blur',           color: [  0,   0,   0, 1], needsBase: true },
  { tool: 'circleBlur',  label: 'Circle Blur',    color: [  0,   0,   0, 1], needsBase: true },
  { tool: 'imageBrush',  label: 'Image Brush',    color: [  0, 100, 200, 1], mockImage: true },
  { tool: 'select',      label: 'Select + Move',  color: [255,   0,   0, 1], needsBase: true, isSelect: true },
  // concurrent draw — all bots draw simultaneously, the classic race condition
  { tool: 'brush',       label: 'Brush (concurrent)', color: [255, 100,   0, 1], concurrent: true },
  { tool: 'ink',         label: 'Ink (concurrent)',   color: [ 50, 200, 150, 1], concurrent: true },
];

const ACTIVE_SUITE = TOOL_FILTER
  ? TOOL_SUITE.filter(t => TOOL_FILTER.includes(t.tool))
  : TOOL_SUITE;

// ─── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Poll until all bots report the same canvas hash, or timeout.
 * Returns true if consensus was reached, false if timed out.
 */
async function waitForConsensus(bots, timeoutMs = 10_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hashes = await Promise.all(bots.map(b => captureHash(b.page)));
    if (hashes.every(h => h === hashes[0])) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Hash the composite canvas pixels with a simple djb2-style accumulator.
 * Returns a signed 32-bit integer as a hex string.
 */
async function captureHash(page) {
  return page.evaluate(() => {
    const canvas = window.app.board.mainCanvas;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let h = 5381;
    for (let i = 0; i < data.length; i++) {
      h = ((h << 5) + h) ^ data[i];
      h |= 0;
    }
    return h.toString(16);
  });
}

/** Save a PNG screenshot of every bot's viewport. */
async function saveScreenshots(bots, label) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  for (const bot of bots) {
    const safe = label.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const file = path.join(RESULTS_DIR, `${safe}_${bot.name}.png`);
    await bot.page.screenshot({ path: file });
  }
}

/**
 * Build a mock event object that App.handlePointer* accepts.
 */
function mockEv(x, y) {
  return { button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault: () => {} };
}

/**
 * Draw a simple diagonal stroke on one page.
 * For shape tools (line/rect/circle) this is one click-drag.
 * For brush-type tools this emits 10 intermediate move events.
 */
async function drawStroke(page, opts = {}) {
  const { sx = 200, sy = 200, ex = 420, ey = 350, isShape = false, steps = 10 } = opts;
  await page.evaluate(async (sx, sy, ex, ey, isShape, steps) => {
    const app = window.app;
    const ev = (x, y) => ({ button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault: () => {} });

    app.handlePointerDown(ev(sx, sy));
    app.inputBufferManager?.tick();

    if (!isShape) {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        app.handlePointerMove(ev(sx + (ex - sx) * t, sy + (ey - sy) * t));
        app.inputBufferManager?.tick();
        await new Promise(r => setTimeout(r, 16));
      }
    }

    app.handlePointerUp(ev(ex, ey));
    app.inputBufferManager?.tick();
  }, sx, sy, ex, ey, isShape, steps);
}

/**
 * Draw thick brush strokes so erase/blur/fill/select have real pixels to work on.
 * Draws three overlapping strokes in different colors forming a visible X+bar.
 */
async function drawBase(page) {
  await page.evaluate(async () => {
    const app = window.app;
    const ev = (x, y) => ({ button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault: () => {} });

    async function stroke(color, pts) {
      app.selectTool('brush');
      app.handleColorInputChange(color);
      app.handleSizeChange({ target: { value: 40 } });
      app.handlePointerDown(ev(pts[0][0], pts[0][1]));
      app.inputBufferManager?.tick();
      for (let i = 1; i < pts.length; i++) {
        app.handlePointerMove(ev(pts[i][0], pts[i][1]));
        app.inputBufferManager?.tick();
        await new Promise(r => setTimeout(r, 16));
      }
      app.handlePointerUp(ev(pts[pts.length-1][0], pts[pts.length-1][1]));
      app.inputBufferManager?.tick();
      await new Promise(r => setTimeout(r, 100));
    }

    // Three thick strokes: diagonal, reverse diagonal, horizontal bar
    await stroke([220, 80,  50, 1], [[180, 180], [250, 240], [320, 260], [400, 340]]);
    await stroke([ 50, 120, 220, 1], [[400, 180], [320, 240], [250, 260], [180, 340]]);
    await stroke([ 50, 180,  80, 1], [[160, 260], [240, 255], [320, 260], [440, 258]]);
  });
  await sleep(500);
}

/**
 * Inject a tiny 1x1 PNG as the imageBrush source and activate it.
 */
async function setupImageBrush(page) {
  await page.evaluate(async () => {
    const MOCK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQI12NkYGD4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg==';
    const img = new Image();
    await new Promise(res => { img.onload = res; img.src = MOCK_PNG; });
    window.app.handleBrushSelect({ type: 'image', fileName: 'mock.png', gimpUrl: MOCK_PNG, brushName: 'mock', width: 8, height: 8, image: img });
  });
}

// ─── Bot Management ────────────────────────────────────────────────────────

async function spawnBot(browser, index, room) {
  const name = `bot_${index}`;
  const page = await browser.newPage();

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('[SYNC]') || txt.includes('[ERROR]')) {
      process.stdout.write(`  [${name}] ${txt}\n`);
    }
  });
  page.on('pageerror', err => process.stderr.write(`  [${name} ERROR] ${err.message}\n`));

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app !== undefined, { timeout: 30_000 });

  await page.evaluate((n, r) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, name, room);

  await page.waitForFunction(() =>
    window.app?.wsClient?.connected &&
    window.app?.syncClient?.hasCompletedSync === true,
    { timeout: 60_000 }
  );

  return { name, page };
}

// ─── Per-Tool Test ─────────────────────────────────────────────────────────

// Per-bot stroke layouts: different positions and colors so each bot's
// contribution is visually distinct and non-overlapping.
const BOT_STROKES = [
  { color: [220,  60,  60, 1], sx: 180, sy: 200, ex: 380, ey: 320 },  // red,   top-left  → mid
  { color: [ 50,  80, 220, 1], sx: 420, sy: 200, ex: 220, ey: 340 },  // blue,  top-right → mid
  { color: [ 40, 180,  60, 1], sx: 180, sy: 360, ex: 420, ey: 200 },  // green, bot-left  → top
];

/**
 * Run one tool test case.
 * Both bots draw with the same tool but at different positions/colors,
 * then we wait for full propagation and compare their canvases.
 * @returns {{ pass: boolean, hashes: string[], elapsed: number }}
 */
async function runToolTest(bots, testCase) {
  const { tool, color, needsBase, mockImage, isShape, isSelect, concurrent } = testCase;
  const t0 = Date.now();

  // Clear from bot 0 then give all bots time to process it
  await bots[0].page.evaluate(() => window.app.handleClear());
  await sleep(2000);

  // Draw base content from bot 0 and wait for it to propagate before the tool test
  if (needsBase) {
    await drawBase(bots[0].page);
    await sleep(2000);
  }

  if (mockImage) {
    for (const bot of bots) await setupImageBrush(bot.page);
  }

  if (isSelect) {
    // Only bot 0 does select+move (it's not a drawing tool for bot 1)
    await runSelectMove(bots[0].page);
  } else {
    // Every bot draws its own distinct stroke simultaneously
    const drawers = concurrent ? bots : bots;  // always all bots
    await Promise.all(drawers.map((bot, i) => drawBotStroke(bot.page, tool, i, isShape)));
  }

  // Wait for full propagation
  await sleep(PROPAGATION);

  const hashes = await Promise.all(bots.map(b => captureHash(b.page)));
  const pass = hashes.every(h => h === hashes[0]);
  return { pass, hashes, elapsed: Date.now() - t0 };
}

/** Draw a per-bot stroke with its assigned color and position. */
async function drawBotStroke(page, tool, botIndex, isShape) {
  const { color, sx, sy, ex, ey } = BOT_STROKES[botIndex % BOT_STROKES.length];
  await page.evaluate((t, c) => {
    window.app.selectTool(t);
    window.app.handleColorInputChange(c);
    window.app.handleSizeChange({ target: { value: 18 } });
  }, tool, color);
  await drawStroke(page, { sx, sy, ex, ey, isShape });
}

/** Select a region and drag it — only run on one bot. */
async function runSelectMove(page) {
  // Step 1: drag select a rectangle
  await page.evaluate(async () => {
    const app = window.app;
    const ev = (x, y) => ({ button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault: () => {} });
    app.selectTool('select');
    app.handlePointerDown(ev(175, 175));
    app.inputBufferManager?.tick();
    for (const [x, y] of [[220,200],[280,230],[340,270],[400,320],[415,335]]) {
      app.handlePointerMove(ev(x, y));
      app.inputBufferManager?.tick();
      await new Promise(r => setTimeout(r, 16));
    }
    app.handlePointerUp(ev(420, 345));
    app.inputBufferManager?.tick();
  });
  await sleep(500);
  // Step 2: drag the selection ~130px right + down
  await page.evaluate(async () => {
    const app = window.app;
    const ev = (x, y) => ({ button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault: () => {} });
    app.handlePointerDown(ev(300, 260));
    app.inputBufferManager?.tick();
    for (const [x, y] of [[320,270],[350,285],[390,310],[420,330],[435,350]]) {
      app.handlePointerMove(ev(x, y));
      app.inputBufferManager?.tick();
      await new Promise(r => setTimeout(r, 16));
    }
    app.handlePointerUp(ev(435, 350));
    app.inputBufferManager?.tick();
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const roomName = `sync_suite_${Date.now()}`;
  console.log(`\nTop Draw — Tool Sync Suite`);
  console.log(`Run:  ${RUN_ID}`);
  console.log(`URL:  ${TARGET_URL}`);
  console.log(`Room: ${roomName}`);
  console.log(`Bots: ${NUM_USERS}  |  Propagation wait: ${PROPAGATION}ms`);
  console.log(`Results: ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 720 },
  });

  let bots = [];
  try {
    // Spawn all bots
    process.stdout.write('Spawning bots...');
    for (let i = 0; i < NUM_USERS; i++) {
      bots.push(await spawnBot(browser, i, roomName));
      process.stdout.write(` ${i + 1}`);
    }
    console.log('\n');

    // Wait for all bots to see each other (skip if solo)
    if (NUM_USERS > 1) {
      for (const bot of bots) {
        await bot.page.waitForFunction(
          n => window.app.users.size >= n,
          { timeout: 15_000 },
          NUM_USERS
        );
      }
    }
    console.log('All bots connected and synced.\n');

    // ── Run each tool test ──
    const results = [];

    for (const testCase of ACTIVE_SUITE) {
      const label = testCase.label.padEnd(24);
      process.stdout.write(`  Testing ${label} ... `);

      let result;
      try {
        result = await runToolTest(bots, testCase);
      } catch (err) {
        result = { pass: false, hashes: [], elapsed: 0, error: err.message };
      }

      const icon = result.pass ? '✅ PASS' : '❌ FAIL';
      console.log(`${icon}  (${result.elapsed}ms)`);

      const screenshotLabel = `${result.pass ? 'pass' : 'fail'}_${testCase.tool}${testCase.concurrent ? '_concurrent' : ''}`;
      await saveScreenshots(bots, screenshotLabel);
      if (!result.pass) {
        if (result.error) console.log(`     Error: ${result.error}`);
        else {
          const hashList = result.hashes.map((h, i) => `${bots[i].name}=${h}`).join('  ');
          console.log(`     Hashes: ${hashList}`);
          console.log(`     Screenshots → ${RESULTS_DIR}/${screenshotLabel}_*.png`);
        }
      }

      results.push({ ...testCase, ...result });
    }

    // ── Summary ──
    const passed  = results.filter(r => r.pass).length;
    const total   = results.length;

    console.log('\n' + '─'.repeat(52));
    console.log(`RESULTS: ${passed}/${total} tools pass sync`);
    console.log('─'.repeat(52));
    for (const r of results) {
      const icon  = r.pass ? '✅' : '❌';
      const label = r.label.padEnd(26);
      const ms    = r.pass ? `${r.elapsed}ms` : `${r.elapsed}ms  ← investigate`;
      console.log(`  ${icon} ${label} ${ms}`);
    }
    console.log('─'.repeat(52) + '\n');

    // Save machine-readable summary
    const summary = {
      runId: RUN_ID,
      url: TARGET_URL,
      bots: NUM_USERS,
      propagationMs: PROPAGATION,
      passed,
      total,
      results: results.map(r => ({
        tool:      r.tool,
        label:     r.label,
        concurrent: r.concurrent || false,
        pass:      r.pass,
        elapsed:   r.elapsed,
        hashes:    r.hashes,
        error:     r.error || null,
      })),
    };
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
    console.log(`Summary saved → ${SUMMARY_FILE}\n`);

    process.exitCode = passed === total ? 0 : 1;

  } finally {
    for (const bot of bots) await bot.page.close().catch(() => {});
    await browser.close();
  }
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
