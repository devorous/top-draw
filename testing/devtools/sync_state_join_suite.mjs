#!/usr/bin/env node
/**
 * @fileoverview 3-user SYNC state suite — baked / undo / pending-redo + late join.
 *
 * The other sync harnesses prove that concurrent live traffic converges
 * (replay_multiuser_edge_suite) or that the stroke-log parity protocol detects
 * and repairs drift (parity_sync_test). Neither exercises the part of the sync
 * model that actually bites in practice: BOARD STATE that has crossed the
 * MAX_STROKES_PER_USER (20) bake threshold, combined with undo and a *pending*
 * (un-redone) redo stack, and then a fresh user joining into that state.
 *
 * That combination is the documented danger zone: once a user's oldest strokes
 * bake into flatCanvas they leave the live strokeStack, so a naive join-sync can
 * hand a joiner a baked image with an empty strokeStack — which silently breaks
 * remote undo/redo on the joiner (see memory: sync_checkpoint_join_bakes_undoable).
 *
 * What this suite verifies, per state (baked / undo / pending_redo):
 *
 *   1. BAKING ACTUALLY HAPPENED — at least one user exceeded 20 strokes and has
 *      baked content (flatCanvas / watermark), so we're really testing the baked
 *      path, not a trivial sub-threshold board.
 *   2. LIVE PARITY (A,B,C) — the three concurrently-connected peers converge on:
 *        • strokeLog summary (count / latestSeq / rollingHash)  — commit history
 *        • pixels (A↔B, A↔C within the shared layerDiff tolerance)
 *   3. LATE-JOIN PARITY — a 4th tab (D) joins AFTER the state exists and must
 *      converge to A's pixels.
 *   4. POST-JOIN REMOTE UNDO/REDO — A then performs undo/redo and D must mirror
 *      it (this is the exact operation the baked-join bug breaks).
 *
 * UNDO/REDO are not commit-typed, so they never enter the strokeLog; their only
 * cross-client signature is PIXELS + per-user stack/redo state. That's why this
 * suite leans on pixel parity rather than the rolling hash for the undo states.
 *
 * Usage:
 *   node testing/devtools/sync_state_join_suite.mjs
 *   node testing/devtools/sync_state_join_suite.mjs --headed --only=undo,pending_redo
 *   node testing/devtools/sync_state_join_suite.mjs --strokes=24
 *
 * Env / flags:
 *   TARGET_URL  http://localhost:3000/go/
 *   HEADLESS    "false" / --headed
 *   --strokes=N   strokes drawn per user (default 24, must exceed 20 to bake)
 *   --only=a,b    run only the named states
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   STROKES    = 24;   // per user; must be > MAX_STROKES_PER_USER (20) to bake
let   ONLY       = null;
let   LOBBY      = false;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a === '--lobby') LOBBY = true;
  else if (a.startsWith('--strokes=')) STROKES = parseInt(a.slice(10), 10);
  else if (a.startsWith('--only='))    ONLY = a.slice(7).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

// The server only mints baked checkpoints + truncates the stroke log in a
// PERSISTENT room (lobby or a registered room). In a fresh room a joiner always
// replays the full command tail, so it can't exercise the baked-snapshot-base
// join path (the documented sync_checkpoint_join_bakes_undoable danger zone).
// --lobby runs the states in the real 'lobby' room and waits past the server's
// 15s snapshot timer before the late join so the joiner receives a baked base +
// command tail. Opt-in because it writes strokes into the live lobby.
const SNAPSHOT_WAIT_MS = 22_000;

const RUN_ID      = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `statejoin_${RUN_ID}`);

// Each user paints in its own vertical band so strokes never overlap — that
// keeps cross-user z-order irrelevant to the final pixels (every user's strokes
// occupy disjoint regions), so a pixel diff isolates sync faults from ordering.
const BANDS = {
  A: { x0: 90,  x1: 410, color: [255, 0, 102, 1] },
  B: { x0: 470, x1: 790, color: [0, 153, 255, 1] },
  C: { x0: 850, x1: 1170, color: [255, 170, 0, 1] },
};

const STATES = [
  // op runs after the build phase; each entry: { undo/redo per user-label }.
  // Undo counts stay well under the post-bake live-per-user headroom (~6-7 with
  // round-robin build) so the undo can't bottom out on baked strokes.
  { name: 'baked',        ops: {} },
  { name: 'undo',         ops: { A: { undo: 3 }, B: { undo: 3 } } },
  { name: 'pending_redo', ops: { A: { undo: 3 } } },   // leave 3 redoable, do NOT redo
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── In-page helpers (serialized into the page) ──────────────────────────────

/**
 * Draw a single short stroke (the i-th of `total`) inside [x0,x1] at the row
 * for index i. Drawing one stroke per call lets the build phase round-robin
 * across the three users so every user's strokes are interleaved by sequence —
 * otherwise the user drawn first becomes the oldest and bakes entirely away,
 * leaving nothing live to undo.
 */
async function drawOneStroke(page, { x0, x1, color, size = 12 }, i, total) {
  await page.evaluate(async (x0, x1, color, size, i, total) => {
    const app = window.app;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ev = (x, y) => ({ button: 0, pointerType: 'mouse', offsetX: x, offsetY: y, clientX: x, clientY: y, preventDefault() {} });
    app.selectTool('brush');
    app.handleColorInputChange(color);
    app.handleSizeChange({ target: { value: size } });
    const top = 70, bottom = 690;
    const step = (bottom - top) / total;
    const y = top + i * step;
    // Deliberate: a tick + small wait at each phase so the stroke reliably opens,
    // extends, and commits as ONE stroke. Drawing too fast merges/drops strokes
    // and makes the committed board state nondeterministic.
    app.handlePointerDown(ev(x0, y));
    app.inputBufferManager.tick();
    await sleep(15);
    app.handlePointerMove(ev((x0 + x1) / 2, y + step * 0.4));
    app.inputBufferManager.tick();
    await sleep(15);
    app.handlePointerMove(ev(x1, y));
    app.inputBufferManager.tick();
    await sleep(15);
    app.handlePointerUp(ev(x1, y));
    app.inputBufferManager.tick();
    await sleep(15);
  }, x0, x1, color, size, i, total);
}

async function doUndo(page, n) {
  await page.evaluate(async (n) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < n; i++) { window.app.handleUndo(); window.app.inputBufferManager.tick(); await sleep(40); }
  }, n);
}
async function doRedo(page, n) {
  await page.evaluate(async (n) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < n; i++) { window.app.handleRedo(); window.app.inputBufferManager.tick(); await sleep(40); }
  }, n);
}

/** Snapshot of all the sync-relevant client state for one tab. */
function syncStateInPage() {
  const app = window.app;
  const lm = app?.board?.layerManager;
  const log = app?.wsClient?.strokeLog;
  const summary = log?.getSummary?.() ?? { count: 0, latestSeq: 0, rollingHash: 0 };
  const perUserStack = {};
  let totalStack = 0, anyBaked = false;
  for (const g of (lm?.layerGroups || [])) {
    if (g.flatCanvas) anyBaked = true;
    totalStack += g.strokeStack.length;
    for (const s of g.strokeStack) perUserStack[s.userId] = (perUserStack[s.userId] || 0) + 1;
  }
  const redoSizes = {};
  for (const [uid, batches] of (lm?.redoStackByUser || new Map())) {
    if (batches && batches.length) redoSizes[uid] = batches.length;
  }
  return {
    sessionIndex: app?.sessionIndex,
    usersSize: app?.users?.size ?? 0,
    logCount: summary.count,
    latestSeq: summary.latestSeq,
    rollingHash: summary.rollingHash >>> 0,
    totalStack,
    anyBaked,
    bakedWatermark: lm?.getBakedWatermarkSeq?.() ?? 0,
    perUserStack,
    redoSizes,
  };
}

async function getState(page) { return page.evaluate(syncStateInPage); }
async function snap(page) { return page.evaluate(captureLayerSnapshotsInPage); }

// ─── Tab lifecycle ───────────────────────────────────────────────────────────
async function spawnTab(browser, label, room) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));
  page.on('console', (msg) => {
    const t = msg.text();
    if (/\[ERROR\]|desync|parity/i.test(t)) process.stdout.write(`  [${label}] ${t}\n`);
  });

  // Pin Math.random for render determinism. Do NOT freeze Date.now (commit
  // timestamps order the strokeStack render).
  await page.evaluateOnNewDocument(() => {
    let seed = 0x2545f491;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, label, room);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });
  return { label, page };
}

/**
 * Wait until the whole trio AGREES — equal logCount, rollingHash and live
 * strokeStack — and that agreement holds across two consecutive reads, or time
 * out. Agreement (not an absolute stroke count) is the real sync invariant:
 * driving pointer events through the tick/input-buffer pipeline splits/merges
 * strokes so the absolute committed count is nondeterministic, but every peer
 * must still converge on whatever WAS committed. A generous timeout means a
 * lingering in-flight message settles rather than false-failing; if the trio
 * still disagrees when it expires, that's a genuine desync.
 *
 * @returns {{ states: object[], converged: boolean }}
 */
async function waitTrioConverged(tabs, { timeoutMs = 25_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const sig = (s) => `${s.logCount}|${s.rollingHash}|${s.totalStack}`;
  let prevSig = null;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(400);
    const states = await Promise.all(tabs.map((t) => getState(t.page)));
    last = states;
    const sigs = states.map(sig);
    const agree = sigs.every((x) => x === sigs[0]);
    if (agree && prevSig === sigs[0]) return { states, converged: true };
    prevSig = agree ? sigs[0] : null;
  }
  return { states: last ?? (await Promise.all(tabs.map((t) => getState(t.page)))), converged: false };
}

/** Wait until a tab's own pixels stop changing across two reads. */
async function waitPixelStable(page, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  while (Date.now() < deadline) {
    await sleep(500);
    const s = await snap(page);
    if (prev) {
      const d = diffSnapshots(prev, s);
      if (d.matchPct >= 99.99 && d.maxDelta === 0) return s;
    }
    prev = s;
  }
  return prev ?? [];
}

// ─── Assertion plumbing ──────────────────────────────────────────────────────
function makeRecorder() {
  const checks = [];
  return {
    checks,
    assert(label, cond, detail = '') {
      checks.push({ label, pass: !!cond, detail });
    },
  };
}

// ─── Per-state run ───────────────────────────────────────────────────────────
async function runState(browser, state) {
  const room = LOBBY ? 'lobby' : `statejoin_${state.name}_${Date.now()}`;
  const caseDir = path.join(RESULTS_DIR, state.name);
  fs.mkdirSync(caseDir, { recursive: true });
  const rec = makeRecorder();

  // ── Spawn the live trio ──
  const tabs = [];
  for (const label of ['A', 'B', 'C']) tabs.push(await spawnTab(browser, label, room));
  const byLabel = Object.fromEntries(tabs.map((t) => [t.label, t]));

  // Wait for the trio to see each other.
  const seenDeadline = Date.now() + 30_000;
  while (Date.now() < seenDeadline) {
    const counts = await Promise.all(tabs.map((t) => t.page.evaluate(() => window.app?.users?.size ?? 0)));
    if (counts.every((c) => c >= 3)) break;
    await sleep(250);
  }

  // ── BUILD: round-robin a stroke per user per round, sequentially. Sequential
  //    (not concurrent) keeps each stroke a clean single commit while still
  //    interleaving seqs A,B,C,A,B,C… so every user keeps live undoable strokes
  //    after the bake threshold. (Concurrency isn't what's under test here —
  //    undo/redo SYNC is — so we remove it as a source of build nondeterminism.)
  for (let i = 0; i < STROKES; i++) {
    for (const t of tabs) await drawOneStroke(t.page, BANDS[t.label], i, STROKES);
  }

  // ── Settle: trio must converge on the committed board, then pixel-stabilize ──
  const buildConv = await waitTrioConverged(tabs);
  for (const t of tabs) await waitPixelStable(t.page);
  const built = buildConv.states;
  rec.assert('trio converged after build', buildConv.converged,
    `log=${built.map((s) => s.logCount).join('/')} stack=${built.map((s) => s.totalStack).join('/')} hash=${built.map((s) => s.rollingHash.toString(16)).join('/')}`);

  // Live-per-user headroom right after build (before ops) — guards the undo
  // counts against bottoming out on baked strokes.
  const liveByUser = built[0]?.perUserStack || {};

  // ── Apply state ops (undo / pending redo) ──
  for (const [label, op] of Object.entries(state.ops)) {
    if (op.undo) await doUndo(byLabel[label].page, op.undo);
    if (op.redo) await doRedo(byLabel[label].page, op.redo);
  }

  // ── Settle after ops: the undo/redo must propagate so the trio re-converges ──
  const opConv = await waitTrioConverged(tabs);
  for (const t of tabs) await waitPixelStable(t.page);
  rec.assert('trio re-converged after undo/redo ops', opConv.converged,
    `log=${opConv.states.map((s) => s.logCount).join('/')} stack=${opConv.states.map((s) => s.totalStack).join('/')} hash=${opConv.states.map((s) => s.rollingHash.toString(16)).join('/')}`);

  // ── Gather state + snapshots ──
  const states = {};
  const snaps = {};
  for (const t of tabs) { states[t.label] = await getState(t.page); snaps[t.label] = await snap(t.page); }
  for (const t of tabs) await t.page.screenshot({ path: path.join(caseDir, `live_${t.label}.png`) }).catch(() => {});

  // 1. Baking actually happened.
  const maxPerUser = Math.max(...Object.values(states.A.perUserStack), 0);
  rec.assert('baking occurred (some user baked / watermark>0)',
    states.A.anyBaked || states.A.bakedWatermark > 0,
    `anyBaked=${states.A.anyBaked} watermark=${states.A.bakedWatermark} maxLiveStack/user=${maxPerUser}`);
  rec.assert('build exceeded bake threshold (drew > 20/user)', STROKES > 20, `strokes=${STROKES}`);

  // 2. Live parity — commit history (strokeLog).
  const sA = states.A, sB = states.B, sC = states.C;
  rec.assert('A,B,C agree on log count', sA.logCount === sB.logCount && sB.logCount === sC.logCount,
    `A=${sA.logCount} B=${sB.logCount} C=${sC.logCount}`);
  rec.assert('A,B,C agree on latestSeq', sA.latestSeq === sB.latestSeq && sB.latestSeq === sC.latestSeq,
    `A=${sA.latestSeq} B=${sB.latestSeq} C=${sC.latestSeq}`);
  rec.assert('A,B,C agree on rollingHash', sA.rollingHash === sB.rollingHash && sB.rollingHash === sC.rollingHash,
    `A=${sA.rollingHash.toString(16)} B=${sB.rollingHash.toString(16)} C=${sC.rollingHash.toString(16)}`);

  // 2b. Live parity — pixels (the only signature undo/redo leaves cross-client).
  for (const label of ['B', 'C']) {
    const d = diffSnapshots(snaps.A, snaps[label]);
    rec.assert(`live pixels A↔${label} (${d.matchPct.toFixed(2)}%)`, d.pass,
      `match=${d.matchPct.toFixed(3)}% maxΔ=${d.maxDelta}`);
    if (!d.pass) await dumpDiff(byLabel.A.page, snaps.A, snaps[label], path.join(caseDir, `livediff_A_${label}.png`));
  }

  // 2c. Live parity — per-user undo/redo machinery state.
  rec.assert('A,B,C agree on total live strokeStack', sA.totalStack === sB.totalStack && sB.totalStack === sC.totalStack,
    `A=${sA.totalStack} B=${sB.totalStack} C=${sC.totalStack}`);
  rec.assert('A,B,C agree on per-user redo sizes',
    JSON.stringify(sA.redoSizes) === JSON.stringify(sB.redoSizes) && JSON.stringify(sB.redoSizes) === JSON.stringify(sC.redoSizes),
    `A=${JSON.stringify(sA.redoSizes)} B=${JSON.stringify(sB.redoSizes)} C=${JSON.stringify(sC.redoSizes)}`);

  // 2d. The undo ops were NOT no-ops — each operated user's redo stack grew by
  //     exactly the undo count, replicated on every peer. Without this, an undo
  //     that silently hit baked (un-undoable) strokes would pass everything above.
  for (const [label, op] of Object.entries(state.ops)) {
    if (!op.undo) continue;
    const sid = states[label].sessionIndex;
    const expect = op.undo - (op.redo || 0);
    for (const [peer, st] of Object.entries(states)) {
      rec.assert(`undo moved ${label}'s strokes to redo, seen by ${peer} (redo[${label}]=${expect})`,
        (st.redoSizes[sid] || 0) === expect,
        `redo[${sid}]=${st.redoSizes[sid] || 0} expected=${expect} liveBefore=${liveByUser[sid] || 0}`);
    }
  }

  // ── 3. LATE JOIN: D joins into the existing state ──
  // In the lobby, wait past the 15s snapshot timer so the server mints a baked
  // checkpoint + truncates the log BEFORE D joins — that's what makes D receive
  // a baked snapshot base + command tail rather than the full replay.
  if (LOBBY) {
    process.stdout.write(`(waiting ${SNAPSHOT_WAIT_MS / 1000}s for snapshot mint) `);
    await sleep(SNAPSHOT_WAIT_MS);
  }
  const D = await spawnTab(browser, 'D', room);
  // Wait for D to see the trio + settle its pixels.
  const dDeadline = Date.now() + 30_000;
  while (Date.now() < dDeadline) {
    const u = await D.page.evaluate(() => window.app?.users?.size ?? 0);
    if (u >= 4) break;
    await sleep(250);
  }
  await waitPixelStable(D.page);
  const stateD = await getState(D.page);
  const snapD = await snap(D.page);
  await D.page.screenshot({ path: path.join(caseDir, `late_D.png`) }).catch(() => {});
  // Informational: did the joiner come in on a baked base with a (possibly
  // truncated) tail rather than the full command replay?
  rec.assert('late joiner D has content (non-empty render)', !!snapD.length && snapD.some((g) => g.bbox),
    `groups=${snapD.length} baked=${stateD.anyBaked} stackD=${stateD.totalStack} logD=${stateD.logCount} (A stack=${sA.totalStack} log=${sA.logCount})`);
  const dDiff = diffSnapshots(snaps.A, snapD);
  rec.assert(`late-join pixels D↔A (${dDiff.matchPct.toFixed(2)}%)`, dDiff.pass,
    `match=${dDiff.matchPct.toFixed(3)}% maxΔ=${dDiff.maxDelta}`);
  if (!dDiff.pass) await dumpDiff(D.page, snaps.A, snapD, path.join(caseDir, `latediff_D_A.png`));

  // ── 4. POST-JOIN remote undo/redo: A operates, D must mirror ──
  // This is the operation the baked-join bug silently breaks on the joiner.
  let postOp = 'none';
  if (state.name === 'pending_redo') { await doRedo(byLabel.A.page, 2); postOp = 'A redo×2'; }
  else { await doUndo(byLabel.A.page, 2); await doRedo(byLabel.A.page, 1); postOp = 'A undo×2 redo×1'; }
  await sleep(900);
  await waitPixelStable(byLabel.A.page);
  await waitPixelStable(D.page);
  const snapA2 = await snap(byLabel.A.page);
  const snapD2 = await snap(D.page);
  const postDiff = diffSnapshots(snapA2, snapD2);
  rec.assert(`post-join remote op D mirrors A [${postOp}] (${postDiff.matchPct.toFixed(2)}%)`, postDiff.pass,
    `match=${postDiff.matchPct.toFixed(3)}% maxΔ=${postDiff.maxDelta}`);
  if (!postDiff.pass) await dumpDiff(D.page, snapA2, snapD2, path.join(caseDir, `postdiff_D_A.png`));
  await byLabel.A.page.screenshot({ path: path.join(caseDir, `post_A.png`) }).catch(() => {});
  await D.page.screenshot({ path: path.join(caseDir, `post_D.png`) }).catch(() => {});

  // Tear down tabs.
  for (const t of [...tabs, D]) await t.page.close().catch(() => {});

  const pass = rec.checks.every((c) => c.pass);
  return { name: state.name, pass, checks: rec.checks, built, states, postOp };
}

async function dumpDiff(page, a, b, file) {
  try {
    const dataUrl = await page.evaluate(generateDiffPngInPage, a, b, PIXEL_TOLERANCE);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const states = STATES.filter((s) => !ONLY || ONLY.includes(s.name));
  if (!states.length) { console.log('No states match filter.'); return; }

  console.log(`\nTop Draw — 3-user SYNC state suite (baked / undo / pending-redo + late join)`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}   (3 live tabs + 1 late joiner per state)`);
  console.log(`Strokes:    ${STROKES}/user  (bake threshold = 20)`);
  console.log(`States:     ${states.map((s) => s.name).join(', ')}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });

  const results = [];
  try {
    for (const s of states) {
      process.stdout.write(`  ${s.name.padEnd(14)} … `);
      try {
        const r = await runState(browser, s);
        results.push(r);
        console.log(r.pass ? '✅ PASS' : '❌ FAIL');
        for (const c of r.checks) {
          if (!c.pass) console.log(`       ✗ ${c.label}  ${c.detail}`);
        }
        // One-line state digest.
        const a = r.states.A;
        console.log(`       state: log=${a.logCount} stack=${a.totalStack} baked=${a.anyBaked} watermark=${a.bakedWatermark} redo=${JSON.stringify(a.redoSizes)}`);
      } catch (err) {
        console.log(`💥 ERROR: ${err.message}`);
        results.push({ name: s.name, pass: false, error: err.message, checks: [] });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    console.log('\n' + '─'.repeat(64));
    console.log(`RESULTS: ${passed}/${results.length} states passed`);
    console.log('─'.repeat(64));

    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
      runId: RUN_ID, strokes: STROKES, pixelTolerance: PIXEL_TOLERANCE, passPct: PASS_PCT, results,
    }, null, 2));

    process.exitCode = passed === results.length ? 0 : 1;
  } catch (err) {
    console.error('\nFatal:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('Uncaught:', err); process.exit(1); });
