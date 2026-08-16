#!/usr/bin/env node
/**
 * @fileoverview Selection parity suite — every board-mutating Select operation,
 * checked for live parity across 3 clients AND for late-join parity.
 *
 * The Select tool is the widest surface in the app: it is the only tool that
 * lifts pixels off a layer, transforms them, and puts them back, and it does so
 * through a dozen different verbs (delete / cut / paste / clone / stamp / fill /
 * flip / merge / commit-after-move) each with its own wire message. Several of
 * those messages carry NO geometry — SEL_DELETE is literally `{t, ly}` — so the
 * receiving client rebuilds the affected region from cached SEL_PENDING /
 * SEL_LIFT state. That makes the whole family unusually easy to desync in ways
 * a single-client test can never see.
 *
 * Determinism is the point of this suite. Rather than fuzzing with k6 (which
 * finds *a* failure but not a reproducible one), every scenario drives fixed
 * client coordinates through the real pointer/tick pipeline and the real context
 * menu handlers, so a failure reproduces byte-for-byte on the next run and can be
 * bisected. Math.random is pinned per tab by spawnTab.
 *
 * Per scenario:
 *   1. Fresh room, tabs A (actor) + B, C (observers), all synced.
 *   2. A draws a fixed content pattern (and a second layer where the scenario
 *      needs one).
 *   3. A performs the selection operation.
 *   4. LIVE PARITY — A↔B and A↔C layer pixels within tolerance.
 *   5. LATE-JOIN PARITY — a 4th tab D joins afterwards and must converge to A.
 *
 * Steps 4 and 5 fail independently on purpose: live-only failures point at the
 * remote handler, join-only failures point at the strokeLog / StrokeTape / commit
 * ordering.
 *
 * Usage:
 *   node testing/devtools/selection_parity_suite.mjs
 *   node testing/devtools/selection_parity_suite.mjs --headed --only=delete_rect,move_commit
 *   node testing/devtools/selection_parity_suite.mjs --no-join      (skip late-join phase)
 *   node testing/devtools/selection_parity_suite.mjs --list
 *
 * Requires `npm run dev` running (vite :3000, ws server :8030).
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE, PASS_PCT,
  captureLayerSnapshotsInPage,
  diffSnapshots,
  generateDiffPngInPage,
} from '../lib/layerDiff.mjs';
import { loadTape, compareTapes, formatReport, joinVerdict } from '../lib/tapeDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   ONLY       = null;
let   DO_JOIN    = true;
let   LIST_ONLY  = false;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--no-join') DO_JOIN = false;
  else if (a === '--list') LIST_ONLY = true;
  else if (a.startsWith('--only=')) ONLY = a.slice(7).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

// A fixed viewport keeps client→board coordinate mapping identical between runs,
// which is what makes the scenarios reproducible rather than merely repeatable.
const VIEWPORT = { width: 1280, height: 800 };
const CODEC_URL = '/shared/ddrawCodec.js';

const RUN_ID      = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `selparity_${RUN_ID}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fixed geometry (client coords) ──────────────────────────────────────────
// Content sits well inside the viewport so no selection or move destination can
// clip against a board edge — an edge clip would look like a desync.
const CONTENT = {
  strokes: [
    { y: 200, color: [220, 40, 40, 1] },
    { y: 300, color: [40, 160, 220, 1] },
    { y: 400, color: [40, 190, 90, 1] },
  ],
  x0: 220, x1: 580, size: 18,
};
const SEL_FULL  = { x0: 200, y0: 150, x1: 600, y1: 450 };  // covers all three strokes
const SEL_LEFT  = { x0: 200, y0: 150, x1: 400, y1: 450 };  // covers their left half
const MOVE_TO   = { dx: 300, dy: 120 };

// ─── In-page helpers ─────────────────────────────────────────────────────────

/** Plain object matching what App's pointer handlers read off a PointerEvent. */
function evLiteral() {
  return `((x, y, extra) => Object.assign({
    button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    offsetX: x, offsetY: y, clientX: x, clientY: y, pressure: 0.5,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}
  }, extra || {}))`;
}

/**
 * Drive a pointer gesture through the real App handlers, ticking the input
 * buffer between samples. The tick + settle at each step is deliberate: driving
 * faster than the 60 TPS loop merges or drops samples and makes the committed
 * board nondeterministic.
 */
async function gesture(page, points, { settle = 18 } = {}) {
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

/** Draw the fixed content pattern on the given layer. */
async function drawContent(page, layer = 0, strokes = CONTENT.strokes) {
  await page.evaluate(async (layerIdx, strokeDefs, x0, x1, size, evSrc) => {
    const app = window.app;
    const ev = eval(evSrc);
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    if (app.self.activeLayer !== layerIdx) app.handleLayerSelect(layerIdx);
    await nap(60);
    app.selectTool('brush');
    app.handleSizeChange({ target: { value: size } });
    await nap(40);
    for (const s of strokeDefs) {
      app.handleColorInputChange(s.color);
      await nap(30);
      app.handlePointerDown(ev(x0, s.y));       app.inputBufferManager.tick(); await nap(18);
      app.handlePointerMove(ev((x0 + x1) / 2, s.y)); app.inputBufferManager.tick(); await nap(18);
      app.handlePointerMove(ev(x1, s.y));       app.inputBufferManager.tick(); await nap(18);
      app.handlePointerUp(ev(x1, s.y));         app.inputBufferManager.tick(); await nap(40);
    }
  }, layer, strokes, CONTENT.x0, CONTENT.x1, CONTENT.size, evLiteral());
}

/** Put the select tool in a known mode and clear any stale selection. */
async function armSelect(page, mode = 'rect', opts = {}) {
  await page.evaluate(async (m, o) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool('select');
    await nap(400);                       // SelectToolLoader loads the real tool lazily
    const rt = app.toolManager.getTool('select').realTool;
    rt.cancelSelection?.();
    rt.setMode(m);                        // default mode is 'lasso'; be explicit
    rt.toggleCopyAllLayers(!!o.allLayers);
    if (o.fitToContent !== undefined) rt.toggleFitToContent(!!o.fitToContent);
    await nap(80);
  }, mode, opts);
}

/** Rectangle selection by dragging corner to corner. */
async function selectRect(page, r) {
  await gesture(page, [[r.x0, r.y0], [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2], [r.x1, r.y1]]);
  await sleep(250);
}

/** Lasso selection around a rectangle's outline (a real closed polygon). */
async function selectLasso(page, r) {
  const pts = [
    [r.x0, r.y0], [(r.x0 + r.x1) / 2, r.y0], [r.x1, r.y0],
    [r.x1, (r.y0 + r.y1) / 2], [r.x1, r.y1],
    [(r.x0 + r.x1) / 2, r.y1], [r.x0, r.y1],
    [r.x0, (r.y0 + r.y1) / 2], [r.x0, r.y0],
  ];
  await gesture(page, pts);
  await sleep(250);
}

/** Drag from inside the selection to move it (lifts to a floating selection). */
async function moveSelection(page, from, dx, dy) {
  await gesture(page, [
    [from[0], from[1]],
    [from[0] + dx * 0.5, from[1] + dy * 0.5],
    [from[0] + dx, from[1] + dy],
  ]);
  await sleep(300);
}

/** Invoke a context-menu verb exactly as its click handler does. */
async function menu(page, verb, arg) {
  return page.evaluate(async (v, a) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const rt = app.toolManager.getTool('select').realTool;
    if (typeof rt[v] !== 'function') return { ok: false, missing: v };
    const out = a === undefined ? rt[v]() : rt[v](a);
    const res = out && typeof out.then === 'function' ? await out : out;
    app.inputBufferManager.tick();
    await nap(250);
    return { ok: true, result: res === undefined ? null : (typeof res === 'object' ? '[obj]' : res) };
  }, verb, arg);
}

/**
 * End a selection the way most users actually do: by picking another tool.
 *
 * This is a genuinely different code path from the Apply/deselect menu verbs
 * every other scenario uses. Here the commit comes from SelectTool.deactivate()
 * inside App.selectTool(), and the CT broadcast rides the same drain — so it is
 * the only scenario that exercises the CT-vs-SEL_COMMIT wire ordering. When CT
 * was queued first, remotes saw a tool change away from 'select', cancelled the
 * floating selection (DrawingHandlers 'ct' -> handleSelectionCancel) and then
 * dropped the SEL_COMMIT that followed, reverting the stamp on every peer while
 * the drawer kept it.
 */
async function switchTool(page, tool) {
  await page.evaluate(async (t) => {
    const app = window.app;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    app.selectTool(t);                    // the exact call the tool buttons make
    app.inputBufferManager.tick();
    await nap(300);
  }, tool);
  await sleep(250);
}

async function setColor(page, color) {
  await page.evaluate(async (c) => {
    window.app.handleColorInputChange(c);
    await new Promise((r) => setTimeout(r, 60));
  }, color);
}

async function snap(page) { return page.evaluate(captureLayerSnapshotsInPage); }

/** Compact per-tab state used to detect convergence and to explain failures. */
function stateInPage() {
  const app = window.app;
  const lm = app?.board?.layerManager;
  const log = app?.wsClient?.strokeLog;
  const summary = log?.getSummary?.() ?? { count: 0, latestSeq: 0, rollingHash: 0 };
  let totalStack = 0;
  const seqZero = [];
  for (const g of (lm?.layerGroups || [])) {
    totalStack += g.strokeStack.length;
    for (const s of g.strokeStack) {
      if (!s.seq) seqZero.push({ u: s.userId, bm: s.blendMode, w: s.width, h: s.height });
    }
  }
  // Per-layer ink + stroke shape. Pixel-diff percentages say two clients
  // disagree but not how; this says WHICH layer holds what, which separates
  // "content landed on the wrong layer" from "content rendered differently".
  const perLayer = (lm?.layerGroups || []).map((g, i) => {
    const stack = g.strokeStack.map((s) => ({
      u: s.userId, seq: s.seq || 0, bm: s.blendMode,
      w: s.width, h: s.height,
      // Undo batches by timestamp (undoLastStrokeGlobal picks the latest), so
      // when a tape-clean scenario still diverges on a joiner the timestamps are
      // the thing to look at: a lift-erase and its commit-stamp that tie, or
      // land in the wrong order, make one Ctrl+Z reverse the wrong half.
      ts: s.timestamp || 0,
      restore: !!s.selectionRestoreData,
      merge: !!s.isSelectionMerge, selErase: !!s.isSelectionErase,
    }));
    return { layer: i, strokes: stack.length, baked: !!g.flatCanvas, stack };
  });

  return {
    sessionIndex: app?.sessionIndex,
    mirror: !!app?.board?.mirror,
    logCount: summary.count,
    latestSeq: summary.latestSeq,
    rollingHash: summary.rollingHash >>> 0,
    totalStack,
    perLayer,
    // A committed stroke still sitting at seq 0 sorts to the TOP of the stack;
    // for a destination-out selection erase that is the "permanent white hole"
    // signature, so surface it even when the pixels happen to agree.
    seqZeroStrokes: seqZero,
  };
}
async function getState(page) { return page.evaluate(stateInPage); }

/** Wait until every tab agrees on commit history, stable across two reads. */
async function waitConverged(tabs, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const sig = (s) => `${s.logCount}|${s.rollingHash}|${s.totalStack}`;
  let prev = null, last = null;
  while (Date.now() < deadline) {
    await sleep(400);
    const states = await Promise.all(tabs.map((t) => getState(t.page)));
    last = states;
    const sigs = states.map(sig);
    const agree = sigs.every((x) => x === sigs[0]);
    if (agree && prev === sigs[0]) return { states, converged: true };
    prev = agree ? sigs[0] : null;
  }
  return { states: last, converged: false };
}

// ─── Recorder bridge ─────────────────────────────────────────────────────────
// The wire-level oracle (testing/lib/tapeDiff.mjs). For SELECTION verbs it is
// complementary to the pixel diff, not a replacement — several bugs in the
// original sweep (merge erasing nothing, expandDirtyRect on the wrong layer)
// delivered a perfectly correct message that the HANDLER then mishandled: tape
// clean, pixels red. But the reverse class — a field the sanitizer strips, a
// verb the server never relays — is invisible to pixels until it has already
// corrupted the board, and the tape names it exactly.
async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app?.recorder) return;
    // A recorder that hits its max length auto-stops and then stop() returns
    // null, losing the tape with no error.
    window.app.recorder.configure?.({ maxLengthMs: 0 });
    window.app.recorder.start(window.app);
  });
}

/** Stop the recorder and encode the bundle to .ddraw bytes (base64) in-page. */
async function stopAndEncode(page) {
  return page.evaluate(async (url) => {
    const rec = window.app?.recorder?.stop?.();
    if (!rec) return null;
    const { encodeDdraw } = await import(url);
    const blob = await encodeDdraw(rec);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { b64: btoa(bin), size: buf.length, deltas: rec.deltas?.length ?? 0 };
  }, CODEC_URL);
}

// ─── Tab lifecycle ───────────────────────────────────────────────────────────
async function spawnTab(browser, label, room, { recordFromJoin = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (err) => {
    process.stderr.write(`  [${label} PAGEERROR] ${err.message}\n`);
    pageErrors.push({ label, message: err.message });
  });
  page.on('console', (msg) => {
    const t = msg.text();
    if (/is not a function|TypeError|desync|\[ERROR\]/i.test(t)) {
      process.stdout.write(`  [${label}] ${t}\n`);
      pageErrors.push({ label, message: t });
    }
  });

  // Pin Math.random for render determinism (confetti/pattern jitter). Date.now
  // must stay real — commit timestamps order the strokeStack.
  await page.evaluateOnNewDocument(() => {
    let seed = 0x2545f491;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  // Arm BEFORE joining so the tape captures the whole sync serve — the
  // checkpoint + command tail is exactly what a join-only failure is about.
  if (recordFromJoin) await startRecording(page);

  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, room);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });

  // Joining via handleRoomSelected() skips the landing page's own click handler,
  // so the overlay stays flagged visible — and KeyboardHandler.handleKeyDown
  // returns early on `app.landingPage?.isVisible`. Without this every keyboard
  // scenario silently does nothing and looks like a product bug.
  await page.evaluate(() => window.app?.landingPage?.hide?.());
  await page.waitForFunction(() => !window.app?.landingPage?.isVisible, { timeout: 10_000 });

  return { label, page };
}

let pageErrors = [];

// ─── Scenarios ───────────────────────────────────────────────────────────────
// Each `run(A)` performs the operation on tab A. Content is drawn beforehand
// per `layers`. Keep every scenario's geometry fixed — no randomness.
const SCENARIOS = [
  {
    name: 'delete_rect',
    desc: 'rect-select over content, Clear',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'delete_lasso',
    desc: 'lasso-select over content, Clear',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'delete_key',
    desc: 'rect-select, real Delete keypress (loader proxy path)',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await page.evaluate(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete', code: 'Delete', keyCode: 46, which: 46, bubbles: true, cancelable: true,
        }));
        window.app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 300));
      });
    },
  },
  {
    name: 'move_commit',
    desc: 'rect-select, drag to a new spot, Apply (commit)',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'move_commit_toolswitch',
    desc: 'rect-select, drag, then pick the brush — deactivate() commits, no Apply click',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await switchTool(page, 'brush');
    },
  },
  {
    name: 'paste_commit_toolswitch',
    desc: 'copy/paste, then pick the brush — the pasted stamp must survive on peers',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'cut');
      await sleep(300);
      await menu(page, 'paste');
      await sleep(400);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await switchTool(page, 'brush');
    },
  },
  {
    name: 'move_cancel',
    expectRestore: true,
    desc: 'rect-select, drag, Cancel — content must return to origin',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'cancelSelection');
    },
  },
  {
    name: 'lasso_move_commit',
    desc: 'lasso-select, drag, Apply',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'cut_paste',
    desc: 'rect-select, Cut, Paste, move the pasted float, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'cut');
      await sleep(300);
      await menu(page, 'paste');
      await sleep(400);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'clone_commit',
    desc: 'rect-select, Clone, move the duplicate, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'clone');
      await sleep(400);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'fill',
    desc: 'rect-select, Fill with a solid colour',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await setColor(page, [128, 0, 200, 1]);
      await menu(page, 'fillSelection');
    },
  },
  {
    name: 'fill_lasso',
    desc: 'lasso-select, Fill (lasso-masked fill)',
    async run(page) {
      await armSelect(page, 'lasso');
      await selectLasso(page, SEL_LEFT);
      await setColor(page, [200, 120, 0, 1]);
      await menu(page, 'fillSelection');
    },
  },
  {
    name: 'flip_commit',
    desc: 'rect-select, Flip horizontal, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'flipHorizontal');
      await sleep(300);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'stamp',
    desc: 'rect-select, move, Stamp (leaves the float live), then Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'stamp');
      await sleep(400);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'select_all_move',
    desc: 'Select All, drag, Apply',
    async run(page) {
      await armSelect(page, 'rect');
      await menu(page, 'selectAll');
      await sleep(300);
      await moveSelection(page, [400, 300], 120, 80);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'delete_all_layers',
    desc: 'all-layers mode: rect-select, Clear (must clear every layer)',
    layers: [0, 1],
    async run(page) {
      await armSelect(page, 'rect', { allLayers: true });
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
  {
    name: 'move_all_layers',
    desc: 'all-layers mode: rect-select, drag, Apply',
    layers: [0, 1],
    async run(page) {
      await armSelect(page, 'rect', { allLayers: true });
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
    },
  },
  {
    name: 'merge_down',
    desc: 'two layers, rect-select, Merge Down',
    layers: [0, 1],
    async run(page) {
      await page.evaluate(async () => {
        window.app.handleLayerSelect(1);
        await new Promise((r) => setTimeout(r, 120));
      });
      await armSelect(page, 'rect');
      await selectRect(page, SEL_FULL);
      await menu(page, 'mergeDown');
    },
  },
  {
    name: 'merge_all',
    desc: 'two layers, rect-select, Merge All',
    layers: [0, 1],
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_FULL);
      await menu(page, 'mergeAll');
    },
  },
  {
    name: 'delete_then_undo',
    expectRestore: true,
    desc: 'rect-select, Clear, then Ctrl+Z (erase must come back everywhere)',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
      await sleep(500);
      await page.evaluate(async () => {
        window.app.handleUndo();
        window.app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 400));
      });
    },
  },
  {
    name: 'move_commit_then_undo',
    expectRestore: true,
    desc: 'rect-select, move, Apply, then Ctrl+Z',
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await moveSelection(page, [300, 300], MOVE_TO.dx, MOVE_TO.dy);
      await menu(page, 'deselect');
      await sleep(500);
      await page.evaluate(async () => {
        window.app.handleUndo();
        window.app.inputBufferManager.tick();
        await new Promise((r) => setTimeout(r, 400));
      });
    },
  },
  {
    name: 'delete_mirrored',
    desc: 'global mirror on: rect-select, Clear (mirrored half must clear too)',
    // Mirror goes on BEFORE the content is drawn so the mirrored half actually
    // holds ink and the clear has something to remove there. Toggling it after
    // drawing instead tests MIR ordering in the join tail, which is a separate
    // concern from whether a selection clear mirrors.
    async beforeContent(page) {
      await page.evaluate(async () => {
        const app = window.app;
        const m = app.board.toggleMirror();
        app.ui.updateMirrorDisplay(m);
        app.wsClient.broadcastMirror();
        await new Promise((r) => setTimeout(r, 400));
      });
    },
    async run(page) {
      await armSelect(page, 'rect');
      await selectRect(page, SEL_LEFT);
      await menu(page, 'deleteSelection');
    },
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────
async function runScenario(browser, scenario) {
  const room = `selparity_${Date.now()}_${scenario.name}`;
  pageErrors = [];
  const tabs = [];
  const notes = [];
  let live = null, joinRes = null, effect = null, tapeRes = null, joinTapeOk = null, ok = true;

  try {
    for (const label of ['A', 'B', 'C']) tabs.push(await spawnTab(browser, label, room));
    const A = tabs[0];

    if (scenario.beforeContent) {
      await scenario.beforeContent(A.page);
      await sleep(400);
    }

    for (const layer of (scenario.layers || [0])) {
      await drawContent(A.page, layer);
      await sleep(300);
    }
    // Always end on layer 0 unless the scenario re-selects, so 'activeLayer' is
    // a known quantity for the ops that read it.
    if ((scenario.layers || [0]).length > 1) {
      await A.page.evaluate(async () => {
        window.app.handleLayerSelect(0);
        await new Promise((r) => setTimeout(r, 120));
      });
    }
    const pre = await waitConverged(tabs);
    if (!pre.converged) notes.push('content did not converge before the operation');

    // Baseline of the ACTOR's own board. Without this a scenario whose operation
    // silently no-ops (a missing method, a selection that landed on blank
    // canvas) still "passes" parity — three clients agreeing on an unchanged
    // board proves nothing. Every scenario must either change A's board or, for
    // the restore scenarios, provably return it to this baseline.
    const preSnapA = await snap(A.page);

    // Arm the tapes around the OPERATION only. Scoping them this tightly is what
    // makes the diff readable: the content-drawing phase would otherwise bury one
    // selection message under hundreds of MD/MM, and the join tail served to the
    // last tab to spawn would show up as messages the others "never received".
    await Promise.all(tabs.map((t) => startRecording(t.page)));
    await sleep(200);

    await scenario.run(A.page);
    await sleep(800);

    const post = await waitConverged(tabs);
    if (!post.converged) notes.push('did not converge after the operation');

    // Live parity
    const [sA, sB, sC] = await Promise.all(tabs.map((t) => snap(t.page)));
    const dAB = diffSnapshots(sA, sB, PIXEL_TOLERANCE);
    const dAC = diffSnapshots(sA, sC, PIXEL_TOLERANCE);
    live = { AB: dAB, AC: dAC };
    if (!dAB.pass || !dAC.pass) ok = false;

    // Did the operation do anything? (see preSnapA)
    const selfDiff = diffSnapshots(preSnapA, sA, PIXEL_TOLERANCE);
    effect = { matchPct: selfDiff.matchPct, restored: scenario.expectRestore === true };
    if (scenario.expectRestore) {
      // cancel / undo scenarios: the board must come BACK to its pre-op state.
      if (!selfDiff.pass) {
        ok = false;
        notes.push(`expected restore to baseline, but A differs from pre-op by ${(100 - selfDiff.matchPct).toFixed(2)}%`);
      }
    } else if (selfDiff.matchPct > 99.99) {
      ok = false;
      notes.push('OPERATION HAD NO EFFECT on the actor\'s board — scenario is vacuous, not passing');
    }

    // On failure, dump each tab's per-layer stroke stack side by side.
    if (!dAB.pass || !dAC.pass) {
      for (let i = 0; i < post.states.length; i++) {
        const st = post.states[i];
        const line = (st.perLayer || []).map((L) =>
          `L${L.layer}:${L.strokes}${L.baked ? '*' : ''}[${L.stack.map((x) =>
            `${x.bm === 'destination-out' ? 'E' : 'S'}${x.seq}${x.merge ? 'm' : ''}`).join(' ')}]`).join('  ');
        notes.push(`stack ${tabs[i].label}: mirror=${st.mirror} ${line}`);
      }
    }

    const zeroSeq = post.states.flatMap((s, i) =>
      s.seqZeroStrokes.map((z) => ({ tab: tabs[i].label, ...z })));
    if (zeroSeq.length) {
      notes.push(`seq-0 committed strokes present: ${JSON.stringify(zeroSeq).slice(0, 240)}`);
    }

    // Wire parity. Read WITH the pixel diff: tapes agree + pixels differ points
    // at the remote handler; tapes differ points at the sanitizer/relay and the
    // pixel result is merely downstream of it.
    const bundles = [];
    for (const t of tabs) {
      const enc = await stopAndEncode(t.page).catch(() => null);
      if (!enc) continue;
      const dir = path.join(RESULTS_DIR, 'tapes', scenario.name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${t.label}.ddraw`);
      fs.writeFileSync(file, Buffer.from(enc.b64, 'base64'));
      bundles.push({ label: t.label, file });
    }
    if (bundles.length >= 2) {
      const loaded = [];
      for (const b of bundles) {
        const tape = await loadTape(b.file);
        tape.label = b.label;
        loaded.push(tape);
      }
      tapeRes = await compareTapes(loaded, { ignoreTypes: new Set(['MM']) });
      if (!tapeRes.ok) {
        ok = false;
        for (const st of tapeRes.streams) {
          if (st.ok) continue;
          const detail = (st.ops ?? []).slice(0, 4).map((o) =>
            `${o.op === 'missing' ? '-' + st.pair[0] : '+' + st.pair[1]} ${o.event.typeName}` +
            `${JSON.stringify(o.event.canon).slice(0, 90)}`).join('  ');
          notes.push(`TAPE ${st.pair.join('↔')} u${st.user}: ${st.countA} vs ${st.countB} — ${detail}`);
        }
        for (const sq of tapeRes.seq) {
          if (sq.ok) continue;
          notes.push(`TAPE seq ${sq.pair.join('↔')}: ${sq.mismatches.length}/${sq.shared} disagree`);
        }
      }
    }

    // Late-join parity
    if (DO_JOIN) {
      const D = await spawnTab(browser, 'D', room, { recordFromJoin: true });
      tabs.push(D);
      await sleep(1500);
      await waitConverged(tabs, { timeoutMs: 20_000 });
      const [sA2, sD] = await Promise.all([snap(A.page), snap(D.page)]);
      joinRes = diffSnapshots(sA2, sD, PIXEL_TOLERANCE);
      if (!joinRes.pass) {
        ok = false;
        // A join-only failure is the joiner's own rebuild, so the live trio's
        // stacks say nothing — print A against D, with timestamps.
        const [stA, stD] = await Promise.all([getState(A.page), getState(D.page)]);
        for (const [label, st] of [['A', stA], ['D', stD]]) {
          const line = (st.perLayer || []).map((L) =>
            `L${L.layer}:${L.strokes}${L.baked ? '*' : ''}[${L.stack.map((x) =>
              `${x.bm === 'destination-out' ? 'E' : 'S'}${x.seq}@${x.ts % 100000}${x.restore ? 'r' : ''}`).join(' ')}]`).join('  ');
          notes.push(`join stack ${label}: ${line}`);
        }
        notes.push(`join redo sizes: A=${JSON.stringify(stA.redoSizes ?? {})} D=${JSON.stringify(stD.redoSizes ?? {})}`);
      }

      // SEQ parity for the joiner — pixels alone cannot see this.
      //
      // A commit that rebuilds at seq 0 on the joiner renders identically to one
      // at its real seq whenever it happens to be the newest stroke: both orders
      // put it on top. It only becomes visible once something is drawn AFTER it,
      // because _sortStrokeStack floats seq 0 to MAX_SAFE_INTEGER — by which
      // time the stack has usually baked and the divergence is permanent. So a
      // green pixel diff here is NOT evidence the rebuild was faithful.
      //
      // Compare against a LIVE OBSERVER (B), not the drawer: the drawer holds
      // its own strokes outside the layer stacks until they bake, so A vs D
      // differs by bookkeeping even when both are correct. B and D are both
      // observers and must agree seq-for-seq.
      //
      // This is the assertion that catches the class where a remote handler
      // drops `seq` while re-queueing itself behind an async image decode — the
      // joiner requeues every time (the sync tail replays synchronously), a live
      // client never does. Found exactly that in handleSelectionCommit.
      const [stB2, stD2] = await Promise.all([getState(tabs[1].page), getState(D.page)]);
      const seqSig = (st) => (st.perLayer || [])
        .map((L) => `L${L.layer}[${L.stack.map((x) => `${x.bm === 'destination-out' ? 'E' : 'S'}${x.seq}`).join(' ')}]`)
        .join('  ');
      const sigB = seqSig(stB2);
      const sigD = seqSig(stD2);
      if (sigB !== sigD) {
        ok = false;
        notes.push('JOIN SEQ MISMATCH — joiner rebuilt commits with different seqs than a live observer');
        notes.push(`   live B : ${sigB}`);
        notes.push(`   join D : ${sigD}`);
      }
      const joinZero = (stD2.seqZeroStrokes || []);
      if (joinZero.length) {
        ok = false;
        notes.push(`JOINER holds ${joinZero.length} seq-0 committed stroke(s) — these sort to the TOP of the `
          + `stack and will land above any later work: ${JSON.stringify(joinZero).slice(0, 200)}`);
      }

      // Compare the JOINER's rebuilt tail against A's live stream. The live
      // `tape` verdict above covers A/B/C only — their recorders stop before D
      // exists — so without this a join-only failure has no wire evidence at
      // all. Unclipped: D tapes the tail at APPLICATION time, not origin time.
      const encD = await stopAndEncode(D.page).catch(() => null);
      if (encD) {
        const dir = path.join(RESULTS_DIR, 'tapes', scenario.name);
        fs.mkdirSync(dir, { recursive: true });
        const fileD = path.join(dir, 'D.ddraw');
        fs.writeFileSync(fileD, Buffer.from(encD.b64, 'base64'));
        const incumbent = bundles.find((b) => b.label === 'A');
        if (incumbent) {
          const tA = await loadTape(incumbent.file); tA.label = 'A';
          const tD = await loadTape(fileD); tD.label = 'D';
          const jr = await compareTapes([tA, tD], {
            ignoreTypes: new Set(['MM']), clipToWindow: false,
          });
          // The verdict is SUBSEQUENCE, not equality. A's recorder is armed just
          // before the operation, while D tapes the room's whole replayed
          // history from its join — so D holding far more messages ('+D' ops) is
          // correct, not a fault. What must never happen is a 'missing' op:
          // something A sent that D's rebuilt tail does not contain.
          // Subsequence verdict from the shared oracle — extras are expected
          // (D replays the room's whole history), only a missing board-state
          // message is a fault. See tapeDiff.joinVerdict.
          const verdict = joinVerdict(jr);
          const dropped = verdict.dropped;
          if (verdict.compacted.length) {
            const byType = {};
            for (const c of verdict.compacted) byType[c.event.typeName] = (byType[c.event.typeName] || 0) + 1;
            notes.push(`join tail compacted (expected): ${JSON.stringify(byType)}`);
          }
          // Reported, not failed: the joiner holds these, just at another
          // position (selection preambles replay bundled before their commit).
          // Surfaced so a sudden change in the reorder set is still visible.
          if (verdict.reordered?.length) {
            const byType = {};
            for (const c of verdict.reordered) byType[c.event.typeName] = (byType[c.event.typeName] || 0) + 1;
            notes.push(`join tail reordered (present, bundled before commit): ${JSON.stringify(byType)}`);
          }
          joinTapeOk = verdict.ok;
          if (!joinTapeOk) {
            ok = false;
            const byType = {};
            for (const d of dropped) byType[d.event.typeName] = (byType[d.event.typeName] || 0) + 1;
            notes.push(`JOIN TAPE: ${dropped.length} message(s) A sent are ABSENT from the joiner's `
              + `rebuilt tail — ${JSON.stringify(byType)}`);
            for (const d of dropped.slice(0, 6)) {
              notes.push(`   missing u${d.user} ${d.event.typeName} ${JSON.stringify(d.event.canon).slice(0, 110)}`);
            }
          }
        }
      }
    }

    // Save a diff image for whichever comparison failed worst.
    if (!ok) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const worst = [['AB', dAB], ['AC', dAC], ['AD', joinRes]]
        .filter(([, d]) => d && !d.pass)
        .sort((a, b) => a[1].matchPct - b[1].matchPct)[0];
      if (worst) {
        const other = worst[0] === 'AB' ? tabs[1] : worst[0] === 'AC' ? tabs[2] : tabs[3];
        const png = await A.page.evaluate(
          generateDiffPngInPage, await snap(A.page), await snap(other.page), PIXEL_TOLERANCE);
        if (png) {
          fs.writeFileSync(
            path.join(RESULTS_DIR, `diff_${scenario.name}_A_vs_${worst[0].slice(1)}.png`),
            Buffer.from(png.split(',')[1], 'base64'));
        }
      }
    }
  } catch (err) {
    ok = false;
    notes.push(`threw: ${err.message}`);
  } finally {
    for (const t of tabs) { try { await t.page.close(); } catch {} }
  }

  const errs = pageErrors.slice(0, 6);
  if (errs.length) { ok = false; notes.push(`page errors: ${errs.map((e) => `${e.label}: ${e.message}`).join(' | ')}`); }

  return { scenario, ok, live, joinRes, effect, tape: tapeRes && { ok: tapeRes.ok, failures: tapeRes.failures }, joinTapeOk, notes };
}

async function main() {
  const list = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.name)) : SCENARIOS;

  if (LIST_ONLY) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(24)} ${s.desc}`);
    return 0;
  }
  if (!list.length) { console.error('No scenarios matched --only'); return 2; }

  console.log('\nTop Draw — Selection parity suite (3 live clients + late joiner)');
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match (pixels, not hashes)`);
  console.log(`Late join:  ${DO_JOIN ? 'yes' : 'skipped'}`);
  console.log(`Scenarios:  ${list.map((s) => s.name).join(', ')}`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    defaultViewport: VIEWPORT,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  try {
    for (const s of list) {
      process.stdout.write(`  ${s.name.padEnd(24)} … `);
      const r = await runScenario(browser, s);
      results.push(r);
      const pct = (d) => (d ? `${d.matchPct.toFixed(1)}%` : 'n/a');
      const tag = r.ok ? '✅ PASS' : '❌ FAIL';
      // `tape` is the wire verdict; the percentages are the pixel verdict. tape
      // ✗ means the clients were fed different messages, so the pixel numbers
      // are a symptom — fix the tape first.
      // `tape` is A↔B↔C (live); `jtape` is the JOINER's rebuilt tail vs A. They
      // are separate verdicts: the live recorders stop before D joins.
      const tapeTag = r.tape ? (r.tape.ok ? 'tape ✓' : 'tape ✗') : 'tape –'
        + '';
      const jtag = r.joinTapeOk == null ? '' : (r.joinTapeOk ? '  jtape ✓' : '  jtape ✗');
      console.log(`${tag}  A↔B ${pct(r.live?.AB)}  A↔C ${pct(r.live?.AC)}  A↔D ${pct(r.joinRes)}  ${tapeTag}${jtag}`);
      for (const n of r.notes) console.log(`       ${n}`);
      if (!r.ok && r.live) {
        for (const [k, d] of [['A↔B', r.live.AB], ['A↔C', r.live.AC], ['A↔D', r.joinRes]]) {
          if (d && !d.pass) {
            const bad = d.perGroup.filter((g) => !g.pass)
              .map((g) => `L${g.groupIdx} ${g.matchPct.toFixed(1)}% maxΔ${g.maxDelta}`).join(', ');
            console.log(`       ${k} failing layers: ${bad}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log('\n' + '─'.repeat(72));
  console.log(`RESULTS: ${passed}/${results.length} scenarios passed`);
  console.log('─'.repeat(72));
  if (passed !== results.length) {
    console.log('\nFailing scenarios:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  • ${r.scenario.name} — ${r.scenario.desc}`);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'report.json'), JSON.stringify(
    results.map((r) => ({
      name: r.scenario.name, desc: r.scenario.desc, ok: r.ok, notes: r.notes,
      AB: r.live?.AB && { matchPct: r.live.AB.matchPct, maxDelta: r.live.AB.maxDelta },
      AC: r.live?.AC && { matchPct: r.live.AC.matchPct, maxDelta: r.live.AC.maxDelta },
      AD: r.joinRes && { matchPct: r.joinRes.matchPct, maxDelta: r.joinRes.maxDelta },
      effect: r.effect,
    })), null, 2));

  return passed === results.length ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
