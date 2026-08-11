#!/usr/bin/env node
/**
 * @fileoverview Which tools actually commit a stroke through a driven gesture?
 *
 * Any suite that synthesises input (`app.handlePointerDown/Move/Up` +
 * `inputBufferManager.tick()`) is trusting that each tool commits exactly one
 * undoable stroke that way. `afk_idle_soak_suite` found that trust misplaced:
 * asked for 4 strokes (brush, pen, line, brush) it reliably got 3, on every
 * client, deterministically — so one tool silently drops.
 *
 * Guessing from the source cost two wrong answers elsewhere in this session, so
 * this measures instead: one client, one stroke per tool, and the live stroke
 * count read back after each. Prints a table of which tools commit and which
 * do not.
 *
 *   node testing/devtools/_gesture_commit_probe.mjs
 *   node testing/devtools/_gesture_commit_probe.mjs --tools=brush,pen,line
 *   node testing/devtools/_gesture_commit_probe.mjs --headed --settle=40
 */

import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';

let HEADLESS = process.env.HEADLESS !== 'false';
let SETTLE = 18;
let TOOLS = ['brush', 'pen', 'line', 'rectangle', 'circle', 'ink', 'eraser'];
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--tools=')) TOOLS = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a.startsWith('--settle=')) SETTLE = Number(a.slice(9));
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const ROOM = `gestureprobe_${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function evLiteral() {
  return `((x, y, extra) => Object.assign({
    button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    offsetX: x, offsetY: y, clientX: x, clientY: y, pressure: 0.5,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}
  }, extra || {}))`;
}

async function gesture(page, points, settle) {
  await page.evaluate(async (pts, settleMs, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.handlePointerDown(ev(pts[0][0], pts[0][1]));
    app.inputBufferManager.tick();
    await nap(settleMs);
    for (let i = 1; i < pts.length; i++) {
      app.handlePointerMove(ev(pts[i][0], pts[i][1]));
      app.inputBufferManager.tick();
      await nap(settleMs);
    }
    const last = pts[pts.length - 1];
    app.handlePointerUp(ev(last[0], last[1]));
    app.inputBufferManager.tick();
    await nap(settleMs * 2);
  }, points, settle, evLiteral());
}

/**
 * Everything a committed stroke could have become, counted per tool.
 *
 * Counting only `strokeStack` cannot distinguish "the tool committed nothing"
 * from "the tool committed somewhere this probe does not look" — and that
 * distinction is the whole open question: `concurrent_draw_undo_suite`'s
 * DEFAULT_TOOLS lists pen and eraser as tools that commit a normal undoable
 * stroke through MD/MM/MU, and the live-only measurement says they do not. If
 * the total moves while `live` does not, the probe was under-counting and that
 * suite is right; if nothing moves anywhere, the suite has been under-drawing.
 *
 * `active` catches the third possibility: a stroke that was begun and never
 * committed still sits in activeStrokeByUser, which is a different failure from
 * one that was never begun at all.
 */
const OWN_ACCOUNTING = `(() => {
  const app = window.app;
  const me = app?.self?.id;
  const g = app?.board?.layerManager?.layerGroups || [];
  let live = 0, flat = 0, baked = 0, active = 0;
  for (const x of g) {
    for (const s of (x.strokeStack || [])) if (s.userId === me) live++;
    for (const s of (x.flatStrokeRecords || [])) if (s.userId === me) flat++;
    for (const s of (x.bakedSequences || [])) if (s.userId === me) baked++;
    const m = x.activeStrokeByUser;
    if (m && typeof m.has === 'function' && m.has(me)) active++;
  }
  return { live, flat, baked, active, total: live + flat + baked };
})()`;

async function main() {
  console.log(`\nWhich tools commit a stroke through a driven gesture?`);
  console.log(`Room:  ${ROOM}`);
  console.log(`Tools: ${TOOLS.join(', ')}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => process.stderr.write(`  [ERR] ${e.message}\n`));
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
    await page.evaluate((r) => { window.app.self.username = 'GESTURE_PROBE'; window.app.handleRoomSelected(r); }, ROOM);
    await page.waitForFunction(() => window.app?.wsClient?.connected && window.app?.sessionIndex != null,
      { timeout: 60_000 });
    await page.evaluate(() => window.app?.landingPage?.hide?.());
    await page.waitForFunction(() => !window.app?.landingPage?.isVisible, { timeout: 10_000 });
    await sleep(500);

    const results = [];
    let prev = await page.evaluate(OWN_ACCOUNTING);
    for (const [i, tool] of TOOLS.entries()) {
      const y = 160 + i * 70;
      const x0 = 200;
      const path = [[x0, y], [x0 + 70, y + 24], [x0 + 150, y - 16], [x0 + 230, y + 10], [x0 + 300, y]];

      // Destructive tools need something to destroy. Erasing blank canvas
      // produces an empty stroke, which the layer manager correctly discards —
      // that would read as "eraser never commits" when it is the probe's fault.
      if (tool === 'eraser') {
        await page.evaluate(() => {
          window.app.selectTool('brush');
          window.app.handleSizeChange({ target: { value: 40 } });
          window.app.handleColorInputChange([40, 40, 200, 1]);
        });
        await sleep(200);
        await gesture(page, path, SETTLE);
        await sleep(600);
        prev = await page.evaluate(OWN_ACCOUNTING);   // don't credit the primer
      }

      await page.evaluate((t) => {
        window.app.selectTool(t);
        window.app.handleSizeChange({ target: { value: 26 } });
        window.app.handleColorInputChange([220, 60, 60, 1]);
      }, tool);
      await sleep(250);
      await gesture(page, path, SETTLE);
      await sleep(700);
      const now = await page.evaluate(OWN_ACCOUNTING);
      results.push({
        tool,
        live: now.live - prev.live,
        anywhere: now.total - prev.total,
        stuckActive: now.active,
        total: now.total,
      });
      prev = now;
    }

    console.log(`  tool          undoable(live)   committed anywhere   still in flight   running total`);
    for (const r of results) {
      const mark = r.live === 1 ? '✅'
        : r.live === 0 && r.anywhere > 0 ? `⚠ baked, not undoable`
        : r.live === 0 && r.stuckActive > 0 ? '❌ STUCK IN FLIGHT'
        : r.live === 0 ? '❌ DROPPED'
        : `⚠ ${r.live}`;
      console.log(`  ${r.tool.padEnd(12)}  ${String(r.live).padStart(8)}   ${String(r.anywhere).padStart(18)}   `
        + `${String(r.stuckActive).padStart(15)}   ${String(r.total).padStart(11)}   ${mark}`);
    }
    // Three distinguishable outcomes, and they mean different things for the
    // suites that depend on this: DROPPED means nothing was recorded at all;
    // BAKED means the stroke exists but is not undoable, so an undo assertion
    // fails while a pixel assertion passes; STUCK means it was begun and never
    // committed, which is what COMPRESS_USER_STROKES is designed to clean up.
    const dropped = results.filter((r) => r.live === 0 && r.anywhere === 0 && !r.stuckActive).map((r) => r.tool);
    const bakedOnly = results.filter((r) => r.live === 0 && r.anywhere > 0).map((r) => r.tool);
    const stuck = results.filter((r) => r.live === 0 && r.stuckActive > 0).map((r) => r.tool);
    const odd = results.filter((r) => r.live > 1).map((r) => `${r.tool}(${r.live})`);
    console.log('');
    if (dropped.length) {
      console.log(`  ❌ records NOTHING anywhere through a driven gesture: ${dropped.join(', ')}`);
      console.log(`     Suites that synthesise input must not count on these for stroke ownership,`);
      console.log(`     and any suite listing them as committing tools is under-drawing.`);
    }
    if (bakedOnly.length) {
      console.log(`  ⚠ commits but NOT into the undoable stack: ${bakedOnly.join(', ')}`);
      console.log(`     Pixels appear; per-user undo assertions will not hold.`);
    }
    if (stuck.length) console.log(`  ❌ begun and never committed (left in activeStrokeByUser): ${stuck.join(', ')}`);
    if (odd.length) console.log(`  ⚠ commits more than one stroke: ${odd.join(', ')}`);
    if (!dropped.length && !bakedOnly.length && !stuck.length && !odd.length) {
      console.log(`  ✅ every tool committed exactly one undoable stroke.`);
    }
    process.exitCode = (dropped.length || stuck.length) ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('Uncaught:', e); process.exit(2); });
