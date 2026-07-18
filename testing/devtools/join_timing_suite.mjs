#!/usr/bin/env node
/**
 * @fileoverview Join-timing / mid-stroke sync suite.
 *
 * Verifies that observers who join a room at DIFFERENT times — before the
 * flood, mid-flood (guaranteed mid-stroke with 12 VUs drawing), after the
 * flood, or leaving and re-joining — all converge to the same board.
 *
 * With 12 VUs continuously stroking, any join lands mid-stroke for several
 * users at once, exercising the checkpoint + command-tail join sync and the
 * in-flight-stroke preamble reconstruction.
 *
 * Per scenario, at the end (while the bots are still registered users):
 *   1. STROKE COUNTS — every tab must agree on the total number of strokes
 *      (live strokeStack + baked), and ideally on the stack/baked split.
 *   2. PIXEL PARITY  — pairwise board diffs within ±tolerance (aliasing and
 *      sub-pixel rendering are non-deterministic across clients, so perfect
 *      parity is not expected; near-identical is the bar).
 *
 * Scenarios:
 *   late_join        A,B from start; C joins mid-flood
 *   staggered        A from start; B and C join at different mid-flood times
 *   rejoin_mid       A,B,C from start; C reloads + rejoins mid-flood
 *   late_after_idle  A,B from start; C joins after drawing stopped (pure
 *                    checkpoint join, bots still connected)
 *   join_during_undo undo/redo k6 traffic; C joins mid-flood
 *   join_mixed_tools eraser/blend/fill/text/selection churn; C joins mid-flood
 *
 * Usage:
 *   node testing/devtools/join_timing_suite.mjs
 *   node testing/devtools/join_timing_suite.mjs --headed --only=late_join
 *   node testing/devtools/join_timing_suite.mjs --vus=12
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
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
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   VUS = 12, STROKES = 18;
let   ONLY = null;

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--vus='))     VUS = parseInt(a.slice(6), 10);
  else if (a.startsWith('--strokes=')) STROKES = parseInt(a.slice(10), 10);
  else if (a.startsWith('--only='))    ONLY = a.slice(7).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const DDRAW_FEED = path.join(__dirname, '_k6_ddraw_feed.js');
const EDGE_FEED  = path.join(__dirname, '_k6_edge_feed.js');
const RUN_ID      = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `join_${RUN_ID}`);

// With STEP_MS=40 each stroke is ~10 wire steps ≈ 400ms; STROKES=18 keeps each
// VU drawing for ~8s after its ~1s warm-up, so mid-flood joins land mid-stroke.
const LIFETIME = 30_000;

// join schedule: ms after k6 launch (null = join before k6 starts)
const SCENARIOS = [
  { name: 'late_join',        feed: 'ddraw', joins: { A: null, B: null, C: 4_500 } },
  { name: 'staggered',        feed: 'ddraw', joins: { A: null, B: 3_000, C: 7_500 } },
  { name: 'rejoin_mid',       feed: 'ddraw', joins: { A: null, B: null, C: null }, rejoin: { label: 'C', at: 4_000 } },
  { name: 'late_after_idle',  feed: 'ddraw', joins: { A: null, B: null, C: 14_000 } },
  { name: 'join_during_undo', feed: 'edge',  scenario: 'undo_redo', joins: { A: null, B: null, C: 5_000 } },
  { name: 'join_mixed_tools', feed: 'edge',  scenario: 'mixed_tools', joins: { A: null, B: null, C: 5_000 } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tab lifecycle ───────────────────────────────────────────────────────────
async function spawnTab(browser, label) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[ERROR\]/i.test(txt)) process.stdout.write(`  [${label}] ${txt}\n`);
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));
  await page.evaluateOnNewDocument(() => {
    let seed = 12345;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  return { label, page };
}

async function joinRoom(tab, room) {
  await tab.page.evaluate((n, r) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, tab.label, room);
  await tab.page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done;
  }, { timeout: 60_000 });
}

/** Reload the page (drops the room) and rejoin — simulates a mid-flood refresh. */
async function reloadAndRejoin(tab, room) {
  await tab.page.reload({ waitUntil: 'networkidle2' });
  await tab.page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  await joinRoom(tab, room);
}

// ─── Metrics ─────────────────────────────────────────────────────────────────
function captureStrokeCountsInPage() {
  const lm = window.app?.board?.layerManager;
  if (!lm?.layerGroups) return null;
  let stack = 0, baked = 0, flat = 0;
  for (const g of lm.layerGroups) {
    stack += g.strokeStack?.length || 0;
    baked += g.bakedSequences?.length || 0;
    flat  += g.flatStrokeRecords?.length || 0;
  }
  return { stack, baked, flat, total: stack + baked };
}

// Settle when every tab matches its OWN previous snapshot (no in-flight render).
async function waitLiveStable(tabs, { timeoutMs = 40_000 } = {}) {
  const prev = new Map();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    const snaps = {};
    let allStable = true;
    for (const t of tabs) {
      const snap = await t.page.evaluate(captureLayerSnapshotsInPage);
      snaps[t.label] = snap;
      const painted = snap.filter((s) => s.bbox).length;
      const p = prev.get(t.label);
      const stable = p && painted > 0 && (() => { const d = diffSnapshots(p, snap); return d.matchPct >= 99.99 && d.maxDelta === 0; })();
      if (!stable) allStable = false;
      prev.set(t.label, snap);
    }
    last = snaps;
    if (allStable) return snaps;
  }
  return last ?? {};
}

// ─── k6 driver ───────────────────────────────────────────────────────────────
function startK6(room, feed, scenario) {
  const args = [
    'run',
    '-e', `ROOM=${room}`,
    '-e', `TARGET_URL=${WS_URL}`,
    '-e', `VUS=${VUS}`,
    '-e', `STROKES=${STROKES}`,
    '-e', `LIFETIME_MS=${LIFETIME}`,
    // Hard strokes only: soft (hardness<100) rendering is cadence-dependent
    // and would mask genuine join-sync mismatches behind render divergence.
    ...(feed === 'ddraw' ? ['-e', 'HARDNESS=100'] : []),
    ...(scenario ? ['-e', `SCENARIO=${scenario}`] : []),
    feed === 'ddraw' ? DDRAW_FEED : EDGE_FEED,
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

// ─── Per-scenario run ────────────────────────────────────────────────────────
async function runScenario(browser, sc) {
  const room = `join_${sc.name}_${Date.now()}`;
  const caseDir = path.join(RESULTS_DIR, sc.name);
  fs.mkdirSync(caseDir, { recursive: true });

  // Spawn all tabs up-front (page load out of the timing path); join per schedule.
  const tabs = [];
  for (const label of Object.keys(sc.joins)) tabs.push(await spawnTab(browser, label));
  const byLabel = Object.fromEntries(tabs.map((t) => [t.label, t]));

  // Pre-feed joiners.
  for (const t of tabs) if (sc.joins[t.label] == null) await joinRoom(t, room);

  const t0 = Date.now();
  const k6 = startK6(room, sc.feed, sc.scenario);

  // Timed joins / rejoins while the flood is running.
  const timed = [];
  for (const [label, at] of Object.entries(sc.joins)) {
    if (at != null) {
      timed.push((async () => {
        await sleep(at);
        await joinRoom(byLabel[label], room);
        process.stdout.write(`[+${at}ms ${label} joined] `);
      })());
    }
  }
  if (sc.rejoin) {
    timed.push((async () => {
      await sleep(sc.rejoin.at);
      await reloadAndRejoin(byLabel[sc.rejoin.label], room);
      process.stdout.write(`[+${sc.rejoin.at}ms ${sc.rejoin.label} rejoined] `);
    })());
  }
  await Promise.all(timed);

  // Settle on pixel-stability while the bots are still connected.
  const liveSnaps = await waitLiveStable(tabs);
  const counts = {};
  for (const t of tabs) {
    counts[t.label] = await t.page.evaluate(captureStrokeCountsInPage);
    await t.page.screenshot({ path: path.join(caseDir, `live_${t.label}.png`) }).catch(() => {});
  }

  // Let k6 wind down.
  const k6res = await k6.done;
  fs.writeFileSync(path.join(caseDir, 'k6_output.txt'), k6res.out());

  // ── Assertions ──
  // 1. Stroke counts: all tabs agree on total (stack+baked); report the split.
  const totals = tabs.map((t) => counts[t.label]?.total ?? -1);
  const stacks = tabs.map((t) => counts[t.label]?.stack ?? -1);
  const totalsEqual = totals.every((v) => v === totals[0] && v >= 0);
  const stacksEqual = stacks.every((v) => v === stacks[0] && v >= 0);

  // 2. Pixel parity, pairwise vs A.
  //    Same-cohort pairs (both tabs watched every stroke live) must match at
  //    the strict suite threshold. Mid-flood joiner pairs keep a slightly
  //    relaxed bar for residual sub-pixel AA fringe on tail-reconstructed
  //    strokes. (The old 96% allowance was hiding a real bug: tool-state
  //    frames broadcast in the join-suppression window for a not-yet-started
  //    stroke were lost, rendering whole strokes with stale color/size on the
  //    joiner. Fixed 2026-07-17 via SyncCoordinator tool-state resend —
  //    joiners now measure ≥99.96%, so keep this tight.)
  const JOINER_PASS_PCT = 99.5;
  const isMidFloodJoiner = (label) =>
    sc.joins[label] != null || sc.rejoin?.label === label;
  const diffs = {};
  const ref = liveSnaps['A'] ?? [];
  for (const t of tabs) {
    if (t.label === 'A') continue;
    const d = diffSnapshots(ref, liveSnaps[t.label] ?? []);
    const threshold = isMidFloodJoiner(t.label) ? JOINER_PASS_PCT : PASS_PCT;
    d.pass = d.matchPct >= threshold;
    d.threshold = threshold;
    diffs[`A↔${t.label}`] = d;
    if (!d.pass) {
      try {
        const dataUrl = await byLabel['A'].page.evaluate(generateDiffPngInPage, ref, liveSnaps[t.label] ?? [], PIXEL_TOLERANCE);
        fs.writeFileSync(path.join(caseDir, `livediff_A_${t.label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      } catch {}
    }
  }
  const pixelPass = Object.values(diffs).every((d) => d.pass);
  const drewSomething = totals[0] > 0;

  for (const t of tabs) await t.page.close().catch(() => {});

  const pass = drewSomething && totalsEqual && pixelPass;
  return {
    name: sc.name,
    elapsed: Date.now() - t0,
    counts,
    totalsEqual,
    stacksEqual,
    diffs: Object.fromEntries(Object.entries(diffs).map(([k, d]) => [k, { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta }])),
    pixelPass,
    pass,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.name));
  if (!scenarios.length) { console.log('No scenarios match filter.'); return; }

  console.log(`\nTop Draw — Join-timing / mid-stroke sync suite`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}`);
  console.log(`k6 → WS:    ${WS_URL}   (VUS=${VUS} STROKES=${STROKES} hard strokes)`);
  console.log(`Scenarios:  ${scenarios.map((s) => s.name).join(', ')}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const results = [];
  try {
    for (const sc of scenarios) {
      process.stdout.write(`  ${sc.name.padEnd(17)} … `);
      try {
        const r = await runScenario(browser, sc);
        results.push(r);
        const countStr = Object.entries(r.counts)
          .map(([k, c]) => `${k}:${c ? `${c.total}(${c.stack}+${c.baked})` : '?'}`).join(' ');
        const diffStr = Object.entries(r.diffs)
          .map(([k, d]) => `${k} ${d.matchPct.toFixed(2)}%`).join('  ');
        console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'}  strokes ${countStr}${r.totalsEqual ? '' : '  ⚠ totals differ'}${r.stacksEqual ? '' : '  ⚠ stack split differs'}  |  ${diffStr}  (${r.elapsed}ms)`);
      } catch (err) {
        results.push({ name: sc.name, pass: false, error: err.message });
        console.log(`💥 ${err.message}`);
      }
    }

    const passed = results.filter((r) => r.pass).length;
    console.log('\n' + '─'.repeat(64));
    console.log(`RESULTS: ${passed}/${results.length} scenarios passed`);
    console.log('─'.repeat(64));
    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'),
      JSON.stringify({ runId: RUN_ID, vus: VUS, strokes: STROKES, results }, null, 2));
    process.exitCode = passed === results.length ? 0 : 1;
  } catch (err) {
    console.error('\nFatal:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('Uncaught:', err); process.exit(1); });
