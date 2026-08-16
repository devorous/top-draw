#!/usr/bin/env node
/**
 * @fileoverview Multi-user replay SYNC + edge-case suite.
 *
 * Combines REAL server-relayed k6 traffic with THREE live Chrome observer tabs
 * so we can verify the two distinct guarantees a "replay sync test" actually
 * needs — neither of which a single tab can prove:
 *
 *   1. SYNC PARITY      — the live boards of three independent observers (A, B,
 *      C) converge to the same image while k6 VUs flood the room. Verified by
 *      pixel-tolerance diffs A↔B and A↔C (NOT hashes: rendering carries
 *      sub-pixel indeterminism, so we compare pixels within ±tolerance via the
 *      shared layerDiff oracle).
 *   2. REPLAY PARITY    — each observer's OWN recording, encoded to a real
 *      .ddraw and replayed in a fresh out-of-room tab, reproduces that
 *      observer's live snapshot. Catches recorder/ReplayEngine drift.
 *
 * The k6 VUs are the "users" performing the edge-case actions (render-
 * deterministic hard brush + shapes; undo/redo, selection, blend modes). The
 * one action guests can't drive over the wire — board CLEAR (mod-gated) — is
 * injected into every observer tab during a deliberate idle gap in the feed.
 *
 * Scenarios (see _k6_edge_feed.js): baseline, clear, join_leave, undo_redo,
 * selection_blend.
 *
 * Usage:
 *   node testing/devtools/replay_multiuser_edge_suite.mjs
 *   node testing/devtools/replay_multiuser_edge_suite.mjs --headed --only=clear,undo_redo
 *   node testing/devtools/replay_multiuser_edge_suite.mjs --vus=4 --strokes=6
 *
 * Env / flags:
 *   TARGET_URL  http://localhost:3000/go/   (browser)
 *   WS_URL      ws://127.0.0.1:8030         (k6 → server)
 *   HEADLESS    "false" / --headed
 *   --vus=N / --strokes=N / --only=a,b
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { T as MT } from '../../shared/MessageTypes.js';
import {
  PIXEL_TOLERANCE, PASS_PCT,
  captureLayerSnapshotsInPage,
  captureReplayLayerSnapshotsInPage,
  diffSnapshots,
  generateDiffPngInPage,
} from '../lib/layerDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   VUS = 3, STROKES = 5;
let   ONLY = null;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--vus='))     VUS = parseInt(a.slice(6), 10);
  else if (a.startsWith('--strokes=')) STROKES = parseInt(a.slice(10), 10);
  else if (a.startsWith('--only='))    ONLY = a.slice(7).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const FEED_SCRIPT = path.join(__dirname, '_k6_edge_feed.js');
const CODEC_URL = '/shared/ddrawCodec.js';
const RUN_ID      = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `edge_${RUN_ID}`);
const DDRAW_DIR   = path.join(__dirname, '..', 'ddraw');

const OBSERVERS = ['A', 'B', 'C'];

const SCENARIOS = [
  { name: 'baseline',        lifetime: 16000 },
  { name: 'clear',           lifetime: 18000 },
  { name: 'join_leave',      lifetime: 16000 },
  { name: 'undo_redo',       lifetime: 16000 },
  { name: 'selection_blend', lifetime: 16000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tab lifecycle ───────────────────────────────────────────────────────────
// Keep the tick loop RUNNING — remote k6 draws only render while it ticks.
async function spawnTab(browser, label, { room = null } = {}) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[ERROR\]|\[Recorder\]|\[TimeMachine\]|\[ddraw\]/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));

  // Pin Math.random for render determinism; do NOT freeze Date.now (the
  // Recorder stamps deltas with it and the replay seek slices the tape by it).
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
  }
  return { label, page };
}

// ─── Recorder bridge ─────────────────────────────────────────────────────────
async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder missing');
    window.app.recorder.start(window.app);
  });
}

/** Stop the recorder and encode the bundle to .ddraw bytes (base64) in-page. */
async function stopAndEncode(page, codecUrl) {
  return page.evaluate(async (url) => {
    const rec = window.app.recorder.stop();
    if (!rec) return null;
    const { encodeDdraw } = await import(url);
    const blob = await encodeDdraw(rec);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { b64: btoa(bin), size: buf.length, deltas: rec.deltas?.length ?? 0 };
  }, codecUrl);
}

async function loadDdrawFromBase64(page, b64, codecUrl) {
  return page.evaluate(async (data, url) => {
    const bin = atob(data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const { decodeDdraw } = await import(url);
    const rec = await decodeDdraw(buf);
    if (!window.app?.TimeMachine?.loadFromRecording) throw new Error('TimeMachine.loadFromRecording missing');
    await window.app.TimeMachine.loadFromRecording(rec);
    return { deltas: rec.deltas?.length ?? 0 };
  }, b64, codecUrl);
}

async function teardownReplay(page) {
  await page.evaluate(() => window.app.TimeMachine?.stop?.());
}

/**
 * loadFromRecording paints a low-res preview and runs the full-resolution
 * seek(sessionEnd) in the BACKGROUND when the .ddraw carries baked visual
 * checkpoints. Wait for that to land before capturing.
 */
async function waitReplaySettled(page, timeoutMs = 20_000) {
  await page.waitForFunction(() => {
    const tm = window.app?.TimeMachine;
    return !!tm && tm.isOpen && tm._lastAppliedTimestamp === tm.sessionEnd && !tm._isSeeking;
  }, { timeout: timeoutMs, polling: 200 });
}

async function liveStrokeCount(page) {
  return page.evaluate(() => {
    const lm = window.app?.board?.layerManager;
    if (!lm?.layerGroups) return 0;
    return lm.layerGroups.reduce((n, g) => n + (g.strokeStack?.length || 0), 0);
  });
}

/**
 * Every stroke the board holds, baked ones included.
 *
 * The pass gate needs "did this scenario actually draw anything", which is NOT
 * what liveStrokeCount answers: it counts only the undoable live stack, and the
 * overflow bake drains that to 0 on a board that has settled. Gating on the live
 * count means a slower machine — one that finishes baking before the snapshot —
 * fails a scenario whose pixels are perfect. (Keep using liveStrokeCount for the
 * `clear` plateau detection, which genuinely wants the live stack.)
 */
async function totalStrokeCount(page) {
  return page.evaluate(() => {
    const lm = window.app?.board?.layerManager;
    if (!lm?.layerGroups) return 0;
    return lm.layerGroups.reduce((n, g) => {
      const baked = (g.bakedSequences || []).reduce(
        (m, b) => m + (Array.isArray(b.strokes) ? b.strokes.length : 1), 0);
      return n + (g.strokeStack?.length || 0) + (g.flatStrokeRecords?.length || 0) + baked;
    }, 0);
  });
}

/**
 * Guest-safe board clear + tape an outbound CLR so the replay re-applies it.
 *
 * Foreground the tab first. A hidden tab gets no rAF, so it has not drained its
 * input buffer — clearing it there wipes a DIFFERENT amount of content than the
 * tabs that are up to date, and the divergence is baked in from that moment on.
 * This is the same hidden-tab starvation waitLiveStable guards against, except
 * here it corrupts the run rather than just the measurement.
 */
async function injectClear(page) {
  await page.bringToFront().catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate((CLR) => {
    const app = window.app;
    app.board.clear();
    app.board.tileTracker?.clear();
    app.debugOverlay?.clearAll?.();
    app.recorder?.recordOutgoing?.({ t: CLR, u: app.sessionIndex });
  }, MT.CLR);
}

function paintedGroups(snaps) { return snaps.filter((s) => s.bbox).length; }

// ─── k6 driver ───────────────────────────────────────────────────────────────
function startK6(room, scenario, lifetime) {
  const args = [
    'run',
    '-e', `ROOM=${room}`,
    '-e', `TARGET_URL=${WS_URL}`,
    '-e', `VUS=${VUS}`,
    '-e', `STROKES=${STROKES}`,
    '-e', `SCENARIO=${scenario}`,
    '-e', `LIFETIME_MS=${lifetime}`,
    FEED_SCRIPT,
  ];
  const child = spawn('k6', args, { shell: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: () => out }));
  });
  return { child, done, out: () => out };
}

// ─── Pixel-stability across the three live observer tabs ─────────────────────
// Settle when every tab matches its OWN previous snapshot (no in-flight render),
// not when the tabs match each other — a real desync should still settle so we
// can REPORT the A↔B/A↔C mismatch instead of hanging.
async function waitLiveStable(tabs, { timeoutMs = 35_000 } = {}) {
  const prev = new Map();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    const snaps = {};
    let allStable = true;
    for (const t of tabs) {
      // This suite keeps the REAL tick loop running (remote k6 draws only render
      // while it ticks), unlike the sibling suites that drive tick() by hand. With
      // four pages open only one is ever the visible tab, and a hidden page gets no
      // rAF — so a background observer never drains its input buffer, never commits
      // the remote strokes, and ends up with a structurally-correct but PIXEL-EMPTY
      // layer stack. Give each tab the foreground before reading it.
      await t.page.bringToFront().catch(() => {});
      const snap = await t.page.evaluate(captureLayerSnapshotsInPage);
      snaps[t.label] = snap;
      const painted = paintedGroups(snap);
      const p = prev.get(t.label);
      const stable = p && painted > 0 && (() => { const d = diffSnapshots(p, snap); return d.matchPct >= 99.99 && d.maxDelta === 0; })();
      if (!stable) allStable = false;
      prev.set(t.label, snap);
    }
    last = snaps;
    if (allStable) return snaps;
  }
  // Timing out here is not cosmetic: the caller diffs whatever this returns, so
  // an observer whose capture is empty silently turns "A↔B" into "how much of A
  // is blank". Say so out loud instead.
  const shape = Object.entries(last ?? {})
    .map(([k, s]) => `${k}: groups=${s?.length ?? 0} painted=${paintedGroups(s ?? [])}`)
    .join('  ');
  process.stdout.write(
    `\n  ⚠ waitLiveStable TIMED OUT (${timeoutMs}ms) — ${shape}\n`
    + `    painted=0 means that observer's layers are pixel-empty, so every diff\n`
    + `    against it degenerates into "how much of the other board is blank".\n  `);
  return last ?? {};
}

// ─── Per-scenario run ────────────────────────────────────────────────────────
async function runScenario(browser, replayer, scenario) {
  const room = `edge_${scenario.name}_${Date.now()}`;
  const caseDir = path.join(RESULTS_DIR, scenario.name);
  fs.mkdirSync(caseDir, { recursive: true });

  // Fresh observer trio per scenario → guaranteed clean board, isolated room.
  const tabs = [];
  for (const label of OBSERVERS) tabs.push(await spawnTab(browser, label, { room }));

  // Wait for the trio to see each other.
  const seenDeadline = Date.now() + 30_000;
  while (Date.now() < seenDeadline) {
    const counts = await Promise.all(tabs.map((t) => t.page.evaluate(() => window.app?.users?.size ?? 0)));
    if (counts.every((c) => c >= OBSERVERS.length)) break;
    await sleep(250);
  }

  // Arm all three recorders before any traffic.
  await Promise.all(tabs.map((t) => startRecording(t.page)));

  // Launch the k6 feed for this scenario.
  const t0 = Date.now();
  const k6 = startK6(room, scenario.name, scenario.lifetime);

  // Clear scenario: wait for the wave-1 plateau (idle gap), then clear every
  // tab while nothing is in flight.
  let clearInjected = false;
  if (scenario.name === 'clear') {
    let prevCount = -1;
    const plateauDeadline = Date.now() + 15_000;
    while (Date.now() < plateauDeadline) {
      await sleep(500);
      const c = await liveStrokeCount(tabs[0].page);
      if (c > 0 && c === prevCount) {
        // Sequential, not Promise.all: injectClear foregrounds the tab, and only
        // one tab can hold the foreground, so racing them defeats the point.
        for (const t of tabs) await injectClear(t.page);
        clearInjected = true;
        break;
      }
      prevCount = c;
    }
    if (!clearInjected) {
      for (const t of tabs) await injectClear(t.page);
      clearInjected = true;
    }
  }

  // Settle on pixel-stability while the stayer bots are still connected.
  const liveSnaps = await waitLiveStable(tabs);
  const liveStrokes = await totalStrokeCount(tabs[0].page);
  for (const t of tabs) {
    await t.page.screenshot({ path: path.join(caseDir, `live_${t.label}.png`) }).catch(() => {});
  }

  // ── Live SYNC parity: A↔B, A↔C (pixel-tolerance) ──
  const snapA = liveSnaps['A'] ?? [];
  const liveDiffs = {};
  for (const label of ['B', 'C']) {
    const d = diffSnapshots(snapA, liveSnaps[label] ?? []);
    liveDiffs[label] = d;
    if (!d.pass) {
      try {
        const dataUrl = await tabs[0].page.evaluate(generateDiffPngInPage, snapA, liveSnaps[label] ?? [], PIXEL_TOLERANCE);
        fs.writeFileSync(path.join(caseDir, `livediff_A_${label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      } catch {}
    }
  }
  const syncPass = Object.values(liveDiffs).every((d) => d.pass);

  // ── Stop + encode each observer's tape ──
  const tapes = {};
  for (const t of tabs) {
    const enc = await stopAndEncode(t.page, CODEC_URL);
    if (!enc) throw new Error(`Recorder.stop() returned null for ${t.label}`);
    const file = path.join(DDRAW_DIR, `edge_${scenario.name}_${t.label}_${RUN_ID}.ddraw`);
    fs.writeFileSync(file, Buffer.from(enc.b64, 'base64'));
    tapes[t.label] = { enc, file, b64: enc.b64 };
  }

  // Let k6 wind down before replaying.
  const k6res = await k6.done;
  fs.writeFileSync(path.join(caseDir, 'k6_output.txt'), k6res.out());

  // ── REPLAY parity: each tape replayed (out of room) vs its OWN live snap ──
  const replayDiffs = {};
  for (const t of tabs) {
    try {
      await loadDdrawFromBase64(replayer.page, tapes[t.label].b64, CODEC_URL);
      await waitReplaySettled(replayer.page);
      const snapR = await replayer.page.evaluate(captureReplayLayerSnapshotsInPage);
      const d = diffSnapshots(liveSnaps[t.label] ?? [], snapR);
      replayDiffs[t.label] = d;
      if (!d.pass) {
        try {
          const dataUrl = await replayer.page.evaluate(generateDiffPngInPage, liveSnaps[t.label] ?? [], snapR, PIXEL_TOLERANCE);
          fs.writeFileSync(path.join(caseDir, `replaydiff_${t.label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
        } catch {}
      }
      await teardownReplay(replayer.page);
    } catch (err) {
      replayDiffs[t.label] = { pass: false, error: err.message, matchPct: 0, maxDelta: 255 };
      await teardownReplay(replayer.page).catch(() => {});
    }
  }
  const replayPass = Object.values(replayDiffs).every((d) => d.pass);

  // Close the observer trio.
  for (const t of tabs) await t.page.close().catch(() => {});

  const elapsed = Date.now() - t0;
  const pass = liveStrokes > 0 && syncPass && replayPass;
  return {
    name: scenario.name,
    elapsed,
    liveStrokes,
    clearInjected: scenario.name === 'clear' ? clearInjected : undefined,
    deltaCounts: Object.fromEntries(Object.entries(tapes).map(([k, v]) => [k, v.enc.deltas])),
    liveDiffs: Object.fromEntries(Object.entries(liveDiffs).map(([k, d]) => [k, { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta }])),
    replayDiffs: Object.fromEntries(Object.entries(replayDiffs).map(([k, d]) => [k, { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta, error: d.error }])),
    syncPass,
    replayPass,
    pass,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(DDRAW_DIR, { recursive: true });

  const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.name));
  if (!scenarios.length) { console.log('No scenarios match filter.'); return; }

  console.log(`\nTop Draw — Multi-user replay SYNC + edge-case suite`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}   (3 observer tabs + 1 replayer)`);
  console.log(`k6 → WS:    ${WS_URL}        (VUS=${VUS} STROKES=${STROKES})`);
  console.log(`Scenarios:  ${scenarios.map((s) => s.name).join(', ')}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match (pixels, not hashes)`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const results = [];
  try {
    const replayer = await spawnTab(browser, 'replayer', { room: null });

    for (const s of scenarios) {
      process.stdout.write(`  ${s.name.padEnd(16)} … `);
      try {
        const r = await runScenario(browser, replayer, s);
        results.push(r);
        const status = r.pass ? '✅ PASS' : '❌ FAIL';
        const sync = `sync ${Object.entries(r.liveDiffs).map(([k, d]) => `A↔${k} ${d.matchPct.toFixed(1)}%`).join(' ')}`;
        const rep  = `replay ${Object.entries(r.replayDiffs).map(([k, d]) => `${k} ${d.matchPct.toFixed(1)}%`).join('/')}`;
        const dc   = `Δ ${Object.values(r.deltaCounts).join('/')}`;
        console.log(`${status}  ${sync}  ${rep}  ${dc}  strokes ${r.liveStrokes}  (${r.elapsed}ms)`);
        if (!r.syncPass) {
          for (const [k, d] of Object.entries(r.liveDiffs)) if (!d.pass) console.log(`     sync A↔${k}: maxΔ ${d.maxDelta} match ${d.matchPct.toFixed(3)}%`);
        }
        if (!r.replayPass) {
          for (const [k, d] of Object.entries(r.replayDiffs)) if (!d.pass) console.log(`     replay ${k}: maxΔ ${d.maxDelta} match ${(d.matchPct ?? 0).toFixed(3)}%${d.error ? ' ' + d.error : ''}`);
        }
      } catch (err) {
        console.log(`💥 ERROR: ${err.message}`);
        results.push({ name: s.name, pass: false, error: err.message });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    console.log('\n' + '─'.repeat(64));
    console.log(`RESULTS: ${passed}/${results.length} scenarios passed`);
    console.log('─'.repeat(64));

    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
      runId: RUN_ID, ws: WS_URL, vus: VUS, strokes: STROKES,
      pixelTolerance: PIXEL_TOLERANCE, passPct: PASS_PCT,
      results,
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
