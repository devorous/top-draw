#!/usr/bin/env node
/**
 * @fileoverview Undo-after-snapshot replay regression (the dcd3bbf "snapshot
 * layers" fix).
 *
 * The bug: a replay checkpoint used to be a flat-composite PNG. Rebuilding a
 * seek from such a checkpoint produced an EMPTY strokeStack, so any UNDO
 * replayed *after* the checkpoint had nothing to pop — the undone stroke stayed
 * on the board. The fix (layerStateCodec) makes checkpoints carry the full
 * undoable layer state (baked base + live strokeStack + redo, QOI-encoded), so
 * a rebuild has genuine records to pop.
 *
 * This harness reproduces exactly that timeline and verifies it through a REAL
 * .ddraw file round-trip:
 *
 *   Tab A (drawer, records its own session):
 *     1. draw strokes 1..3
 *     2. FORCE an intra-checkpoint  ← "the snapshot"; captures strokes 1..3
 *        into the checkpoint's strokeStack
 *     3. draw stroke 4
 *     4. UNDO  (pops stroke 4 — a post-checkpoint stroke)
 *     5. UNDO  (pops stroke 3 — a stroke that lives INSIDE the checkpoint;
 *               this is the case the fix exists for)
 *     → live board now shows strokes 1 + 2
 *
 *   The recorder bundle is encoded to a real .ddraw (production ddrawCodec),
 *   written to testing/ddraw/, read back, and replayed in a fresh out-of-room
 *   tab. loadFromRecording seeks to sessionEnd; because the checkpoint carries
 *   layer state, the engine rebuilds from the nearest checkpoint and replays the
 *   post-checkpoint tail (stroke 4 + the two UNDOs).
 *
 *   PASS = replayed board == live board (strokes 1 + 2). A regression where the
 *   second UNDO can't pop the checkpoint-resident stroke 3 shows up as a clear
 *   pixel mismatch.
 *
 * Requires the dev server (vite :3000) and WS server (:8030) up — same as
 * test:k6parity. Run:  node testing/devtools/replay_undo_after_snapshot.mjs
 * Flags: --headed   show the browser
 *        --keep     keep the generated .ddraw (default: keep)
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE, PASS_PCT,
  captureLayerSnapshotsInPage,
  captureReplayLayerSnapshotsInPage,
  diffSnapshots,
  generateDiffPngInPage,
} from '../lib/layerDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDRAW_DIR = path.join(__dirname, '..', 'ddraw');
const CODEC_URL = '/shared/ddrawCodec.js';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
let HEADLESS = process.env.HEADLESS !== 'false';
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--keep') { /* default */ }
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `undosnap_${RUN_ID}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tab lifecycle ───────────────────────────────────────────────────────────
// NOTE: unlike the parity suite we pin ONLY Math.random — NOT Date.now. The
// recorder stamps deltas and checkpoints with Date.now(), and the seek path
// orders the forced checkpoint between the strokes and the undos by timestamp.
// A frozen clock would collapse every event to the same ts and defeat the test.
async function spawnTab(browser, label, { room = null } = {}) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[ERROR\]|\[Recorder\]|\[TimeMachine\]|\[ddraw\]|\[layerStateCodec\]/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));

  await page.evaluateOnNewDocument(() => {
    let seed = 12345;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });

  if (room) {
    await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, room);
    await page.waitForFunction(() => {
      const app = window.app;
      const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
      return app?.wsClient?.connected && done;
    }, { timeout: 60_000 });
    // Drive the tick loop manually so each stroke flushes deterministically.
    await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
  }
  return { label, page };
}

// ─── Local drawing helpers (mirrors replay_parity_suite.mjs) ─────────────────
async function selectTool(page, tool) {
  await page.evaluate((t) => window.app.selectTool(t), tool);
}
async function setToolSettings(page, s) {
  await page.evaluate((st) => {
    const app = window.app;
    if (st.size !== undefined)     app.handleSizeChange({ target: { value: st.size } });
    if (st.color !== undefined)    app.handleColorInputChange(st.color);
    if (st.hardness !== undefined) app.handleHardnessChange({ target: { value: st.hardness } });
  }, s);
}
async function getClientCoords(page, boardX, boardY) {
  return page.evaluate((bx, by) => {
    const board = window.app.board;
    const containerRect = board.container.getBoundingClientRect();
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let rx = bx * board.zoom;
    let ry = by * board.zoom;
    if (board.canvasFlipped) rx = (board.getWidth() - bx) * board.zoom;
    const rxr = rx * cos + ry * sin;
    const ryr = -rx * sin + ry * cos;
    return { clientX: rxr + board.panX + containerRect.left, clientY: ryr + board.panY + containerRect.top };
  }, boardX, boardY);
}
async function drawPath(page, points) {
  const clientPoints = [];
  for (const p of points) clientPoints.push(await getClientCoords(page, p.x, p.y));
  await page.evaluate(async (pts) => {
    const app = window.app;
    const ev = (c) => ({ button: 0, pointerType: 'mouse', clientX: c.clientX, clientY: c.clientY, preventDefault: () => {} });
    app.handlePointerDown(ev(pts[0]));
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      for (let s = 1; s <= 4; s++) {
        const t = s / 4;
        app.handlePointerMove(ev({ clientX: a.clientX + (b.clientX - a.clientX) * t, clientY: a.clientY + (b.clientY - a.clientY) * t }));
        app.inputBufferManager?.tick();
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    app.handlePointerUp(ev(pts[pts.length - 1]));
    app.inputBufferManager?.tick();
  }, clientPoints);
  await sleep(200);
}
async function undo(page) {
  await page.evaluate(() => { window.app.handleUndo?.(); window.app.inputBufferManager?.tick(); });
  await sleep(200);
}

// ─── Recorder bridge ─────────────────────────────────────────────────────────
async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder missing');
    window.app.recorder.start(window.app);
  });
}
/** Force an intra-checkpoint right now (this is "the snapshot"). */
async function forceCheckpoint(page) {
  return page.evaluate(() => {
    const rec = window.app.recorder;
    if (typeof rec._captureIntraCheckpoint !== 'function') throw new Error('_captureIntraCheckpoint missing');
    const before = rec.recording.intraCheckpoints.length;
    rec._captureIntraCheckpoint();
    const cps = rec.recording.intraCheckpoints;
    const cp = cps[cps.length - 1];
    const snap = cp?.snapshot;
    const histStrokes = Array.isArray(snap?.history)
      ? snap.history.reduce((n, layer) => n + (Array.isArray(layer) ? layer.length : 0), 0)
      : 0;
    return { added: cps.length - before, totalCheckpoints: cps.length, carriesLayerState: !!(snap && (snap.history || snap.layerBaked)), histStrokes };
  });
}
async function stopAndEncode(page) {
  return page.evaluate(async (url) => {
    const rec = window.app.recorder.stop();
    if (!rec) return null;
    const { encodeDdraw } = await import(url);
    const blob = await encodeDdraw(rec);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return {
      b64: btoa(bin), size: buf.length,
      deltas: rec.deltas?.length ?? 0,
      checkpoints: rec.intraCheckpoints?.length ?? 0,
    };
  }, CODEC_URL);
}

// ─── Replay bridge ───────────────────────────────────────────────────────────
async function loadDdrawFromBase64(page, b64) {
  return page.evaluate(async (data, url) => {
    const bin = atob(data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const { decodeDdraw } = await import(url);
    const rec = await decodeDdraw(buf);
    if (!window.app?.TimeMachine?.loadFromRecording) throw new Error('TimeMachine.loadFromRecording missing');
    await window.app.TimeMachine.loadFromRecording(rec);
    return { deltas: rec.deltas?.length ?? 0, checkpoints: rec.intraCheckpoints?.length ?? 0 };
  }, b64, CODEC_URL);
}
async function waitReplaySettled(page, timeoutMs = 20_000) {
  await page.waitForFunction(() => {
    const tm = window.app?.TimeMachine;
    return !!tm && tm.isOpen && tm._lastAppliedTimestamp === tm.sessionEnd && !tm._isSeeking;
  }, { timeout: timeoutMs, polling: 150 });
}
async function teardownReplay(page) {
  await page.evaluate(() => window.app.TimeMachine?.stop?.());
}
async function liveStrokeCount(page) {
  return page.evaluate(() => {
    const lm = window.app?.board?.layerManager;
    if (!lm?.layerGroups) return 0;
    return lm.layerGroups.reduce((n, g) => n + (g.strokeStack?.length || 0), 0);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(DDRAW_DIR, { recursive: true });
  const room = `undosnap_${Date.now()}`;

  console.log(`\nTop Draw — undo-after-snapshot replay regression`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}`);
  console.log(`Room:       ${room}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  let exitCode = 1;
  try {
    // ── Build the scenario on the drawer tab ──
    process.stdout.write('Spawning drawer tab … ');
    const drawer = await spawnTab(browser, 'drawer', { room });
    console.log('joined.');
    await startRecording(drawer.page);

    // strokes 1..3 — distinct colours / positions so each is independently visible
    await selectTool(drawer.page, 'brush');
    const strokes = [
      { color: [220, 60, 60, 1],  size: 34, y: 300 },
      { color: [60, 200, 60, 1],  size: 30, y: 450 },
      { color: [60, 80, 230, 1],  size: 38, y: 600 }, // stroke 3 — lands inside the checkpoint
    ];
    for (const s of strokes) {
      await setToolSettings(drawer.page, { color: s.color, size: s.size, hardness: 100 });
      await drawPath(drawer.page, [{ x: 350, y: s.y }, { x: 900, y: s.y + 60 }, { x: 1450, y: s.y }]);
    }
    await sleep(300);

    // ── THE SNAPSHOT — force an intra-checkpoint capturing strokes 1..3 ──
    const cp = await forceCheckpoint(drawer.page);
    console.log(`Forced checkpoint: carriesLayerState=${cp.carriesLayerState} ` +
      `strokesInCheckpoint=${cp.histStrokes} (expected 3)`);
    await sleep(300);

    // stroke 4 (post-checkpoint), then two undos
    await setToolSettings(drawer.page, { color: [240, 160, 0, 1], size: 30, hardness: 100 });
    await drawPath(drawer.page, [{ x: 350, y: 760 }, { x: 900, y: 800 }, { x: 1450, y: 760 }]);
    await sleep(200);
    await undo(drawer.page); // pop stroke 4 (post-checkpoint)
    await undo(drawer.page); // pop stroke 3 (lives inside the checkpoint) ← the fix
    await sleep(400);

    const liveStrokes = await liveStrokeCount(drawer.page);
    console.log(`Live board after 2 undos: ${liveStrokes} strokes (expected 2 — strokes 1 + 2).`);
    const snapsLive = await drawer.page.evaluate(captureLayerSnapshotsInPage);
    await drawer.page.screenshot({ path: path.join(RESULTS_DIR, 'live_drawer.png') });

    // ── Encode the real .ddraw and write it to disk ──
    const enc = await stopAndEncode(drawer.page);
    if (!enc) throw new Error('Recorder produced no bundle');
    const savedFile = path.join(DDRAW_DIR, `undo_after_snapshot_${RUN_ID}.ddraw`);
    fs.writeFileSync(savedFile, Buffer.from(enc.b64, 'base64'));
    console.log(`Saved ${path.relative(process.cwd(), savedFile)} ` +
      `(${(enc.size / 1024).toFixed(1)} KB, ${enc.deltas} deltas, ${enc.checkpoints} checkpoints)\n`);

    // ── Replay the saved file in a fresh out-of-room tab ──
    process.stdout.write('Replaying saved .ddraw (fresh tab) … ');
    const replay = await spawnTab(browser, 'replay', { room: null });
    const fileB64 = fs.readFileSync(savedFile).toString('base64');
    await loadDdrawFromBase64(replay.page, fileB64);
    await waitReplaySettled(replay.page);
    const snapsReplay = await replay.page.evaluate(captureReplayLayerSnapshotsInPage);
    await replay.page.screenshot({ path: path.join(RESULTS_DIR, 'replay.png') });

    const diff = diffSnapshots(snapsLive, snapsReplay);
    if (!diff.pass) {
      const dataUrl = await replay.page.evaluate(generateDiffPngInPage, snapsLive, snapsReplay, PIXEL_TOLERANCE);
      fs.writeFileSync(path.join(RESULTS_DIR, 'diff.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
    await teardownReplay(replay.page);
    console.log(`${diff.pass ? '✅ PASS' : '❌ FAIL'}  match ${diff.matchPct.toFixed(2)}%  maxΔ ${diff.maxDelta}`);

    // ── Verdict ──
    const checkpointOk = cp.carriesLayerState && cp.histStrokes === 3;
    const liveOk = liveStrokes === 2;
    console.log('\n' + '─'.repeat(60));
    console.log(`Checkpoint carried layer state (3 strokes): ${checkpointOk ? '✅' : '❌'}`);
    console.log(`Live board correct after undo (2 strokes):  ${liveOk ? '✅' : '❌'}`);
    console.log(`Replay == live after undo-after-snapshot:   ${diff.pass ? '✅' : '❌'}`);
    console.log('─'.repeat(60));

    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
      runId: RUN_ID, room, savedFile: path.relative(process.cwd(), savedFile),
      checkpoint: cp, liveStrokes, deltas: enc.deltas, checkpoints: enc.checkpoints,
      diff: { pass: diff.pass, matchPct: diff.matchPct, maxDelta: diff.maxDelta },
    }, null, 2));

    exitCode = (checkpointOk && liveOk && diff.pass) ? 0 : 1;
  } catch (err) {
    console.error('\nFatal:', err);
    exitCode = 1;
  } finally {
    await browser.close();
  }
  process.exitCode = exitCode;
}

main().catch((err) => { console.error('Uncaught:', err); process.exit(1); });
