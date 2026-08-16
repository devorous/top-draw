#!/usr/bin/env node
/**
 * @fileoverview Concurrent draw + undo parity suite.
 *
 * Every other harness in this directory drives ONE actor and checks that the
 * observers followed. That misses the whole class of bugs that only appears
 * when several users mutate the board at the same instant: seq ordering between
 * interleaved commits, undo racing another user's stroke, a stroke landing
 * above or below someone else's depending on who you ask.
 *
 * This suite runs N clients drawing SIMULTANEOUSLY — every round fires through
 * Promise.all so their MD/MM/MU streams genuinely interleave on the wire — with
 * a different tool AND a different LAYER per client per round, and periodic
 * undo/redo mixed in.
 *
 * The layer rotation matters more than it looks. Each layer group keeps its own
 * strokeStack, its own bake threshold and its own flatCanvas (only layer 0 gets
 * one at construction), and undo resolves through whichever group the stroke
 * landed in — so "undo racing another user's stroke" behaves differently when
 * the two users are on different layers. Until this rotation existed the suite
 * drew everything on layer 0 and none of that was reachable.
 *
 * TWO ORACLES, and reading them together is the point:
 *
 *   1. TAPE parity (testing/lib/tapeDiff.mjs) — every client records its own
 *      .ddraw and the tapes are diffed at the wire level. Exact, no tolerance:
 *      did every client receive the same messages, in the same per-sender
 *      order, with the same fields, and agree on what each commit seq was?
 *   2. PIXEL parity (testing/lib/layerDiff.mjs) — the usual tolerance-based
 *      per-layer comparison.
 *
 *   tapes agree + pixels agree  → converged.
 *   tapes agree + pixels differ → the bug is INSIDE a client: ordering, undo
 *                                 bookkeeping, blend/bake. Transport is fine.
 *   tapes differ                → the bug is in transport: sanitizer stripped a
 *                                 field, relay dropped a message, handler never
 *                                 fired. The pixel diff is just the symptom.
 *
 * That split is what makes a failure actionable. A pixel percentage alone can
 * never tell you which half of the stack to open.
 *
 * Usage:
 *   node testing/devtools/concurrent_draw_undo_suite.mjs
 *   node testing/devtools/concurrent_draw_undo_suite.mjs --clients=4 --rounds=8
 *   node testing/devtools/concurrent_draw_undo_suite.mjs --headed --undo-every=2
 *   node testing/devtools/concurrent_draw_undo_suite.mjs --no-undo   (draw only)
 *   node testing/devtools/concurrent_draw_undo_suite.mjs --tools=brush,line,eraser
 *
 * Requires `npm run dev` (vite :3000, ws server :8030).
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
const CODEC_URL = '/shared/ddrawCodec.js';
const VIEWPORT   = { width: 1280, height: 800 };

let HEADLESS   = process.env.HEADLESS !== 'false';
let CLIENTS    = 3;
let LAYERS     = null;
let ROUNDS     = 6;
let UNDO_EVERY = 3;      // rounds between undo passes; 0 disables
let REDO       = true;   // follow some undo passes with a redo
let KEEP_MM    = false;  // include cursor moves in the tape diff
let TOOLS      = null;
let LATE_JOIN  = true;   // spawn a joiner at the end and diff its rebuilt tape

const HELP = `
concurrent_draw_undo_suite.mjs — N clients drawing at once, with undo

  --clients=<n>      simultaneous drawers (default 3)
  --rounds=<n>       simultaneous draw rounds (default 6)
  --undo-every=<n>   undo pass every n rounds (default 3, 0 = never)
  --no-undo          draw only
  --no-redo          undo without ever redoing
  --tools=a,b,c      override the per-round tool rotation
  --layers=0,1,2     layers the clients rotate through (default all 3;
                     --layers=0 restores the old single-layer behaviour)
  --keep-mm          include MM cursor moves in the tape diff (noisy)
  --no-late-join     skip the joiner phase (sync/tape-rebuild check)
  --headed           show the browser windows
`;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--no-undo') UNDO_EVERY = 0;
  else if (a === '--no-redo') REDO = false;
  else if (a === '--keep-mm') KEEP_MM = true;
  else if (a === '--late-join') LATE_JOIN = true;
  else if (a === '--no-late-join') LATE_JOIN = false;
  else if (a.startsWith('--clients=')) CLIENTS = Number(a.slice(10));
  else if (a.startsWith('--rounds=')) ROUNDS = Number(a.slice(9));
  else if (a.startsWith('--undo-every=')) UNDO_EVERY = Number(a.slice(13));
  else if (a.startsWith('--tools=')) TOOLS = a.slice(8).split(',').map((s) => s.trim());
  else if (a.startsWith('--layers=')) LAYERS = a.slice(9);
  else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

// Tools that commit a normal undoable stroke through the MD/MM/MU path. Each
// client uses a different one each round so a round exercises several at once.
const DEFAULT_TOOLS = ['brush', 'pen', 'line', 'rectangle', 'circle', 'ink', 'eraser'];
const TOOL_ROTATION = TOOLS ?? DEFAULT_TOOLS;

// Layers the clients rotate through (LayerManager.initLayerGroups(3)).
// `--layers=0` restores the old single-layer behaviour for comparison.
const LAYER_ROTATION = LAYERS
  ? LAYERS.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 2)
  : [0, 1, 2];

// Per-client ink colour, so a stroke in a diff is traceable to its author.
const CLIENT_COLORS = [
  [220, 50, 50, 1], [50, 120, 220, 1], [60, 180, 90, 1],
  [230, 160, 40, 1], [160, 70, 200, 1], [40, 190, 200, 1],
];

const RUN_ID      = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `concurrent_${RUN_ID}`);
const TAPE_DIR    = path.join(RESULTS_DIR, 'tapes');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageErrors = [];

// ─── In-page helpers ─────────────────────────────────────────────────────────

function evLiteral() {
  return `((x, y, extra) => Object.assign({
    button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 1,
    offsetX: x, offsetY: y, clientX: x, clientY: y, pressure: 0.5,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {}
  }, extra || {}))`;
}

/**
 * Drive one gesture through the real App handlers, ticking the input buffer
 * between samples. The tick + settle is deliberate: driving faster than the
 * 60 TPS loop merges or drops samples and makes the committed board
 * nondeterministic.
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

async function setTool(page, tool, settings) {
  await page.evaluate((t, s) => {
    const app = window.app;
    app.selectTool(t);
    if (s.size !== undefined) app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined) app.handleColorInputChange(s.color);
    if (s.hardness !== undefined) app.handleHardnessChange({ target: { value: s.hardness } });
    if (s.blendMode !== undefined) app.handleBlendModeChange(s.blendMode);
  }, tool, settings);
}

async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder missing');
    // Disable the max-length auto-stop: an auto-stopped recorder returns null
    // from stop(), which loses the tape silently on a long run.
    window.app.recorder.configure?.({ maxLengthMs: 0 });
    window.app.recorder.start(window.app);
  });
}

/** Stop the recorder and encode the bundle to .ddraw bytes (base64) in-page. */
async function stopAndEncode(page) {
  return page.evaluate(async (url) => {
    const rec = window.app.recorder.stop();
    if (!rec) return null;
    const { encodeDdraw } = await import(url);
    const blob = await encodeDdraw(rec);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { b64: btoa(bin), size: buf.length, deltas: rec.deltas?.length ?? 0 };
  }, CODEC_URL);
}

/** Compact per-tab state — detects convergence and explains failures. */
function stateInPage() {
  const app = window.app;
  const lm = app?.board?.layerManager;
  const summary = app?.wsClient?.strokeLog?.getSummary?.() ?? { count: 0, latestSeq: 0, rollingHash: 0 };
  let totalStack = 0;
  const seqZero = [];
  for (const g of (lm?.layerGroups || [])) {
    totalStack += g.strokeStack.length;
    for (const s of g.strokeStack) {
      if (!s.seq) seqZero.push({ u: s.userId, bm: s.blendMode, w: s.width, h: s.height });
    }
  }
  const perLayer = (lm?.layerGroups || []).map((g, i) => ({
    layer: i,
    strokes: g.strokeStack.length,
    baked: !!g.flatCanvas,
    stack: g.strokeStack.map((s) => ({ u: s.userId, seq: s.seq || 0, bm: s.blendMode, w: s.width, h: s.height })),
  }));
  const redoSizes = {};
  for (const [uid, stack] of (lm?.redoStackByUser ?? new Map())) redoSizes[uid] = stack.length;

  return {
    sessionIndex: app?.sessionIndex,
    logCount: summary.count,
    latestSeq: summary.latestSeq,
    rollingHash: summary.rollingHash >>> 0,
    totalStack, perLayer, redoSizes,
    seqZeroStrokes: seqZero,
  };
}

async function getState(page) { return page.evaluate(stateInPage); }

/** Wait until every tab agrees on commit history, stable across two reads. */
async function waitConverged(tabs, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const sig = (s) => `${s.logCount}|${s.rollingHash}|${s.totalStack}`;
  let prev = null;
  let last = null;
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

  // Pin Math.random for render determinism (pattern/confetti jitter). Date.now
  // must stay real — commit timestamps order the strokeStack, and the Recorder
  // stamps deltas with it (a frozen clock breaks the tape's overlap window).
  await page.evaluateOnNewDocument(() => {
    let seed = 0x2545f491;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  // Arm BEFORE joining so the tape captures the whole sync serve: the joiner's
  // checkpoint + command tail is precisely what we want to compare.
  if (recordFromJoin) await startRecording(page);

  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, room);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });

  // handleRoomSelected() skips the landing page's own click handler, so the
  // overlay stays flagged visible — and KeyboardHandler.handleKeyDown returns
  // early on `app.landingPage?.isVisible`, silently killing every keyboard path.
  await page.evaluate(() => window.app?.landingPage?.hide?.());
  await page.waitForFunction(() => !window.app?.landingPage?.isVisible, { timeout: 10_000 });

  return { label, page };
}

// ─── Geometry ────────────────────────────────────────────────────────────────

/**
 * Two strokes per client per round, both fully determined by (client, round):
 *  - a "lane" stroke inside the client's own horizontal band, so each client's
 *    own history is legible in a diff image;
 *  - a "contention" stroke crossing the shared middle band, where every
 *    client's ink overlaps. Overlap is the point — z-order between interleaved
 *    commits is only observable where strokes cover the same pixels.
 */
function strokesFor(clientIdx, round, clientCount) {
  const laneH = Math.floor(520 / clientCount);
  const laneY = 140 + clientIdx * laneH + (round % 3) * 12;
  const x0 = 180 + (round % 4) * 40;
  const x1 = x0 + 320;

  const contendY = 420 + ((clientIdx + round) % 5) * 14;
  const cx0 = 300 + clientIdx * 30;
  const cx1 = cx0 + 380;

  return [
    [[x0, laneY], [x0 + 110, laneY + 18], [x0 + 220, laneY - 14], [x1, laneY]],
    [[cx0, contendY - 40], [cx0 + 130, contendY + 30], [cx1 - 120, contendY - 25], [cx1, contendY + 35]],
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(TAPE_DIR, { recursive: true });

  const room = `concurrent_${Date.now().toString(36)}`;
  const labels = Array.from({ length: CLIENTS }, (_, i) => String.fromCharCode(65 + i));

  console.log('Top Draw — concurrent draw + undo parity suite');
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Room:       ${room}`);
  console.log(`Clients:    ${CLIENTS} (${labels.join(', ')}) drawing simultaneously`);
  console.log(`Rounds:     ${ROUNDS}, 2 strokes each per round`);
  console.log(`Layers:     rotating ${LAYER_ROTATION.join(',')} (clients land on different layers each round)`);
  console.log(`Undo:       ${UNDO_EVERY > 0 ? `every ${UNDO_EVERY} rounds${REDO ? ' (with redo)' : ''}` : 'disabled'}`);
  console.log(`Tools:      ${TOOL_ROTATION.join(', ')}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match (pixels) | exact (tape)`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1300,860'],
  });

  const summary = { runId: RUN_ID, room, clients: CLIENTS, rounds: ROUNDS, undoEvery: UNDO_EVERY };
  let exitCode = 0;

  try {
    process.stdout.write('Spawning clients … ');
    const tabs = [];
    for (const label of labels) tabs.push(await spawnTab(browser, label, room));
    console.log(`${tabs.length} joined`);

    // Let the join settle BEFORE arming recorders. The last client to join is
    // served a checkpoint + command tail that ends with a tool-state resend for
    // every user already in the room; the clients that were already there never
    // see it. Taped, it reads as "C received 36 messages A and B did not" — a
    // real difference, but a join artifact, not a desync. Waiting for the tail
    // to drain first keeps it out of the comparison window.
    const joined = await waitConverged(tabs, { timeoutMs: 20_000 });
    if (!joined.converged) console.log('  ⚠ clients had not converged before recording started');
    await sleep(1200);

    // Arm every recorder BEFORE any drawing, so all tapes share a window.
    await Promise.all(tabs.map((t) => startRecording(t.page)));
    console.log('Recorders armed\n');
    await sleep(300);

    const timeline = [];

    for (let round = 0; round < ROUNDS; round++) {
      const tools = tabs.map((_, i) => TOOL_ROTATION[(round + i) % TOOL_ROTATION.length]);
      // Rotate layers as well as tools, so in any given round the clients are
      // drawing on DIFFERENT layers and the interleaved seqs have to order
      // correctly across layer groups, not just within one.
      //
      // This suite drew everything on layer 0 until now, which quietly excluded
      // the layer-specific machinery from the only oracle that reproduces
      // byte-for-byte: each group keeps its own strokeStack, its own bake
      // threshold and its own flatCanvas (only layer 0 gets one at
      // construction), and undo resolves through the group the stroke landed
      // in. A concurrent-undo suite that never leaves layer 0 cannot see any of
      // that go wrong.
      const layers = tabs.map((_, i) => LAYER_ROTATION[(round + i) % LAYER_ROTATION.length]);
      process.stdout.write(`  round ${round + 1}/${ROUNDS}  [${tools.map((t, i) => `${t}@L${layers[i]}`).join(' ')}] … `);

      await Promise.all(tabs.map((tab, i) =>
        tab.page.evaluate((l) => window.app.handleLayerSelect(l), layers[i])));

      await Promise.all(tabs.map((tab, i) => setTool(tab.page, tools[i], {
        size: 14 + (i * 4) + (round % 3) * 3,
        color: CLIENT_COLORS[i % CLIENT_COLORS.length],
        // Hard edges: soft falloff is where observer/replay renders legitimately
        // drift, and this suite is about ordering, not antialiasing.
        hardness: 100,
      })));

      // THE POINT OF THE SUITE: all clients draw at the same instant, so their
      // MD/MM/MU streams interleave on the wire and the server assigns seqs
      // across authors rather than in tidy per-author blocks.
      await Promise.all(tabs.map(async (tab, i) => {
        for (const stroke of strokesFor(i, round, CLIENTS)) {
          await gesture(tab.page, stroke);
        }
      }));

      const conv = await waitConverged(tabs);
      timeline.push({ round, tools, kind: 'draw', converged: conv.converged });
      console.log(conv.converged ? 'converged' : 'DID NOT CONVERGE');

      const doUndo = UNDO_EVERY > 0 && (round + 1) % UNDO_EVERY === 0 && round < ROUNDS - 1;
      if (!doUndo) continue;

      // Every client undoes at once — the case where one user's undo has to be
      // ordered against another user's in-flight stroke.
      process.stdout.write(`  round ${round + 1} undo (all clients) … `);
      await Promise.all(tabs.map((t) => t.page.evaluate(() => window.app.handleUndo())));
      const undoConv = await waitConverged(tabs);
      timeline.push({ round, kind: 'undo', converged: undoConv.converged });
      console.log(undoConv.converged ? 'converged' : 'DID NOT CONVERGE');

      if (!REDO) continue;
      // Redo on half the clients only, so the redo stacks legitimately diverge
      // per user and every client still has to agree on the resulting board.
      const redoers = tabs.filter((_, i) => i % 2 === 0);
      process.stdout.write(`  round ${round + 1} redo (${redoers.map((t) => t.label).join(',')}) … `);
      await Promise.all(redoers.map((t) => t.page.evaluate(() => window.app.handleRedo())));
      const redoConv = await waitConverged(tabs);
      timeline.push({ round, kind: 'redo', redoers: redoers.map((t) => t.label), converged: redoConv.converged });
      console.log(redoConv.converged ? 'converged' : 'DID NOT CONVERGE');
    }

    summary.timeline = timeline;

    // ── Settle, then capture both oracles ─────────────────────────────────
    console.log('\nSettling …');
    await sleep(1500);
    const final = await waitConverged(tabs, { timeoutMs: 30_000 });
    summary.converged = final.converged;
    summary.states = final.states;
    if (!final.converged) {
      console.log('  ⚠ clients never agreed on commit history — see summary.json');
      exitCode = 1;
    }

    // Pixels
    console.log('\nPixel parity (layerDiff)');
    const snaps = [];
    for (const tab of tabs) snaps.push(await tab.page.evaluate(captureLayerSnapshotsInPage));
    for (const tab of tabs) {
      await tab.page.screenshot({ path: path.join(RESULTS_DIR, `board_${tab.label}.png`) });
    }
    summary.pixel = [];
    for (let i = 1; i < tabs.length; i++) {
      const diff = diffSnapshots(snaps[0], snaps[i]);
      const pass = diff.pass;
      if (!pass) exitCode = 1;
      const bad = (diff.perGroup ?? []).filter((g) => !g.pass)
        .map((g) => `L${g.groupIdx} ${g.matchPct.toFixed(1)}% maxΔ${g.maxDelta}`).join('  ');
      summary.pixel.push({ pair: [tabs[0].label, tabs[i].label], ...diff });
      console.log(`  ${pass ? '✅' : '❌'} ${tabs[0].label}↔${tabs[i].label}  ${(diff.matchPct ?? 0).toFixed(2)}%`
        + (bad ? `   ${bad}` : ''));
      if (!pass) {
        try {
          const png = await tabs[0].page.evaluate(
            generateDiffPngInPage, snaps[0], snaps[i], PIXEL_TOLERANCE);
          if (png) {
            fs.writeFileSync(
              path.join(RESULTS_DIR, `diff_${tabs[0].label}_${tabs[i].label}.png`),
              Buffer.from(png.split(',')[1], 'base64'));
          }
        } catch { /* the diff image is a nicety, not the verdict */ }
      }
    }

    // Tapes
    console.log('\nStopping recorders …');
    const bundles = [];
    for (const tab of tabs) {
      const enc = await stopAndEncode(tab.page);
      if (!enc) { console.log(`  ⚠ ${tab.label}: recorder returned no bundle`); continue; }
      const file = path.join(TAPE_DIR, `${tab.label}.ddraw`);
      fs.writeFileSync(file, Buffer.from(enc.b64, 'base64'));
      bundles.push({ label: tab.label, file, deltas: enc.deltas, size: enc.size });
      console.log(`  ${tab.label}: ${enc.deltas} deltas, ${(enc.size / 1024).toFixed(1)} KiB → ${path.relative(process.cwd(), file)}`);
    }
    summary.tapes = bundles;

    if (bundles.length >= 2) {
      console.log('');
      const tapes = [];
      for (const b of bundles) {
        const tape = await loadTape(b.file);
        tape.label = b.label;   // label by client, not by filename
        tapes.push(tape);
      }
      const ignoreTypes = KEEP_MM ? new Set() : new Set(['MM']);
      const tapeResult = await compareTapes(tapes, { ignoreTypes });
      console.log(formatReport(tapeResult, { maxDiffs: 12 }));
      summary.tape = {
        ok: tapeResult.ok,
        failures: tapeResult.failures,
        streams: tapeResult.streams.map((s) => ({
          pair: s.pair, user: s.user, countA: s.countA, countB: s.countB, ok: s.ok,
          ops: (s.ops ?? []).slice(0, 40).map((o) => ({ op: o.op, type: o.event.typeName, canon: o.event.canon })),
        })),
        seq: tapeResult.seq.map((s) => ({
          pair: s.pair, shared: s.shared, ok: s.ok,
          mismatches: s.mismatches.slice(0, 40).map((m) => ({ seq: m.seq, a: m.a.canon, b: m.b.canon })),
        })),
      };
      if (!tapeResult.ok) exitCode = 1;

      // The two oracles read together — this is the actionable line.
      console.log('');
      const pixelOk = summary.pixel.every((p) => p.pass);
      if (tapeResult.ok && pixelOk) {
        console.log('VERDICT: converged. Same input, same output.');
      } else if (tapeResult.ok && !pixelOk) {
        console.log('VERDICT: every client received identical input but rendered differently —');
        console.log('         the bug is INSIDE a client (stroke ordering, undo bookkeeping, blend/bake),');
        console.log('         not in transport. Start from the per-layer stroke stacks in summary.json.');
      } else {
        console.log('VERDICT: the clients received DIFFERENT input — the bug is in transport');
        console.log('         (validation sanitizer, server relay, or a message handler).');
        console.log('         Fix the tape diff first; the pixel diff is downstream of it.');
      }
    }

    // ── Late-join / sync tape rebuild ─────────────────────────────────────
    // A joiner is served a checkpoint plus the room's command tail, and that
    // tail is SUPPOSED to reproduce the live stream the incumbents already saw.
    // So the joiner's own tape should contain the same per-sender messages, in
    // the same order — which makes "was the tape rebuilt correctly by sync?" an
    // exact question rather than a pixel percentage.
    //
    // Compared with clipToWindow:false. The joiner tapes the tail at APPLICATION
    // time, not origin time, so a wall-clock overlap clip would discard all of
    // it. Caveat when reading a failure: anything folded into a checkpoint is
    // baked into an image rather than replayed, so a missing PREFIX may be a
    // checkpoint rather than a bug. Fresh rooms are not persistent, so this run
    // gets the full tail.
    if (LATE_JOIN) {
      console.log('');
      console.log('Late join (sync tape rebuild)');
      const joiner = await spawnTab(browser, 'J', room, { recordFromJoin: true });
      await sleep(2500);
      const joinConv = await waitConverged([...tabs, joiner], { timeoutMs: 30_000 });
      console.log(`  joiner ${joinConv.converged ? 'converged' : 'DID NOT CONVERGE'}`);
      if (!joinConv.converged) exitCode = 1;

      const [snapA2, snapJ] = await Promise.all([
        tabs[0].page.evaluate(captureLayerSnapshotsInPage),
        joiner.page.evaluate(captureLayerSnapshotsInPage),
      ]);
      const jDiff = diffSnapshots(snapA2, snapJ);
      summary.lateJoinPixel = jDiff;
      if (!jDiff.pass) exitCode = 1;
      console.log(`  ${jDiff.pass ? '✅' : '❌'} pixels ${tabs[0].label}↔J  ${(jDiff.matchPct ?? 0).toFixed(2)}%`);
      await joiner.page.screenshot({ path: path.join(RESULTS_DIR, 'board_J.png') }).catch(() => {});

      const encJ = await stopAndEncode(joiner.page).catch(() => null);
      if (encJ) {
        const fileJ = path.join(TAPE_DIR, 'J.ddraw');
        fs.writeFileSync(fileJ, Buffer.from(encJ.b64, 'base64'));
        console.log(`  J: ${encJ.deltas} deltas, ${(encJ.size / 1024).toFixed(1)} KiB (checkpoint + replayed tail)`);

        const incumbent = bundles.find((b) => b.label === tabs[0].label);
        if (incumbent) {
          const tapeA = await loadTape(incumbent.file); tapeA.label = tabs[0].label;
          const tapeJ = await loadTape(fileJ); tapeJ.label = 'J';
          const jRes = await compareTapes([tapeA, tapeJ], {
            ignoreTypes: KEEP_MM ? new Set() : new Set(['MM']),
            clipToWindow: false,
          });
          // Subsequence verdict, not equality — see joinVerdict(). The joiner
          // replays the room's whole history while A recorded one window, so
          // extras are expected; only a MISSING board-state message is a fault.
          const verdict = joinVerdict(jRes);
          summary.lateJoinTape = { ok: verdict.ok, droppedByType: verdict.droppedByType };
          console.log(`  ${verdict.ok ? '✅' : '❌'} tape A↔J  `
            + `${verdict.dropped.length} board-state message(s) missing from the rebuilt tail`
            + (verdict.compacted.length ? `  (${verdict.compacted.length} compacted, expected)` : ''));
          if (!verdict.ok) {
            exitCode = 1;
            console.log(`     missing: ${JSON.stringify(verdict.droppedByType)}`);
            for (const d of verdict.dropped.slice(0, 8)) {
              console.log(`     - u${d.user} ${d.event.typeName} ${JSON.stringify(d.event.canon).slice(0, 110)}`);
            }
          }
          console.log(verdict.ok
            ? 'VERDICT (join): sync rebuilt the joiner tape faithfully.'
            : 'VERDICT (join): the rebuilt tail is MISSING board-state messages — see above.');
        }
      } else {
        console.log('  ⚠ joiner recorder returned no bundle');
      }
      await joiner.page.close().catch(() => {});
    }

    if (pageErrors.length) {
      console.log(`\n⚠ ${pageErrors.length} page error(s) — see summary.json`);
      summary.pageErrors = pageErrors;
      exitCode = 1;
    }
  } finally {
    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\nsummary.json → ${path.relative(process.cwd(), path.join(RESULTS_DIR, 'summary.json'))}`);
    await browser.close();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(2);
});
