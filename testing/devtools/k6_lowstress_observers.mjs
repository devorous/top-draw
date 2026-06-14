#!/usr/bin/env node
/**
 * @fileoverview "Do all users see the k6 bot strokes identically?" check.
 *
 * Spins up THREE independent live observer browsers in the same room, then runs
 * the real `testing/low_stress_test.js` k6 script (8 VUs, full random tool mix:
 * brushes, pen, shapes, text, selection transforms, flood fill, confetti/pattern
 * brushes, undo) flooding that room. After the feed winds down it pixel-diffs
 * the three observers against each other with the shared layerDiff oracle.
 *
 * Each observer is its OWN browser process (not background tabs in one browser)
 * so none gets background-throttled — every tab keeps ticking, which is required
 * for remote draws to render. Math.random is pinned to the same seed in all
 * three so RNG-driven render jitter (soft edges, etc.) can't masquerade as a
 * sync fault.
 *
 * Run the rate-limit-free server first (8 VUs trip the normal limits):
 *   npm run dev:stress
 *   node testing/devtools/k6_lowstress_observers.mjs
 *   node testing/devtools/k6_lowstress_observers.mjs --headed --vus=4 --duration=40s
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

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   VUS = null, DURATION = null;
for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--vus='))      VUS = a.slice(6);
  else if (a.startsWith('--duration=')) DURATION = a.slice(11);
}

const FEED = path.join(__dirname, '..', 'low_stress_test.js');
const ROOM = `lowstress_obs_${Date.now()}`;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `lowstress_${RUN_ID}`);
const OBSERVERS = ['A', 'B', 'C'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnObserver(label) {
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 760 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));
  // Pin Math.random to the same seed across all observers — isolates message
  // delivery from RNG render jitter.
  await page.evaluateOnNewDocument(() => {
    let seed = 0x1f2e3d4c;
    Math.random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  });
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app && window.app.self != null, { timeout: 60_000 });
  await page.evaluate((n, r) => { window.app.self.username = n; window.app.handleRoomSelected(r); }, `OBS_${label}`, ROOM);
  await page.waitForFunction(() => {
    const app = window.app;
    const done = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
    return app?.wsClient?.connected && done && app?.sessionIndex != null;
  }, { timeout: 60_000 });
  return { label, browser, page };
}

async function snap(page) { return page.evaluate(captureLayerSnapshotsInPage); }
function painted(s) { return s.filter((g) => g.bbox).length; }

/** Settle when a tab matches its own previous snapshot (no in-flight render). */
async function waitStable(page, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  while (Date.now() < deadline) {
    await sleep(800);
    const s = await snap(page);
    if (prev && painted(s) > 0) {
      const d = diffSnapshots(prev, s);
      if (d.matchPct >= 99.99 && d.maxDelta === 0) return s;
    }
    prev = s;
  }
  return prev ?? [];
}

function startK6() {
  const args = ['run', '-e', `ROOM=${ROOM}`, '-e', `TARGET_URL=${WS_URL}`];
  if (VUS) args.push('--vus', VUS);
  if (DURATION) args.push('--duration', DURATION);
  args.push(FEED);
  const child = spawn('k6', args, { shell: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { done: new Promise((res, rej) => { child.on('error', rej); child.on('close', (code) => res({ code, out })); }) };
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`\nTop Draw — k6 low_stress bot-stroke observer parity`);
  console.log(`Room:       ${ROOM}`);
  console.log(`Browser:    ${TARGET_URL}   (3 independent observer browsers)`);
  console.log(`k6 feed:    ${path.relative(process.cwd(), FEED)} → ${WS_URL}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match\n`);

  const obs = [];
  for (const label of OBSERVERS) { obs.push(await spawnObserver(label)); }

  // Wait for the trio (+ they'll also see bots as they connect) to see each other.
  const seenDeadline = Date.now() + 30_000;
  while (Date.now() < seenDeadline) {
    const counts = await Promise.all(obs.map((o) => o.page.evaluate(() => window.app?.users?.size ?? 0)));
    if (counts.every((c) => c >= 3)) break;
    await sleep(250);
  }

  console.log('  observers joined; launching k6 feed…');
  const k6 = startK6();
  const k6res = await k6.done;
  fs.writeFileSync(path.join(RESULTS_DIR, 'k6_output.txt'), k6res.out);
  const connMatch = k6res.out.match(/✓ Connected[\s\S]*?(\d+)\s*\/\s*(\d+)/);
  console.log(`  k6 finished (exit ${k6res.code})`);

  // Let buffered tails drain, then settle each observer's own canvas.
  await sleep(1500);
  const snaps = {};
  for (const o of obs) {
    snaps[o.label] = await waitStable(o.page);
    await o.page.screenshot({ path: path.join(RESULTS_DIR, `obs_${o.label}.png`) }).catch(() => {});
  }

  const userCounts = await Promise.all(obs.map((o) => o.page.evaluate(() => ({
    users: window.app?.users?.size ?? 0,
    strokes: (window.app?.board?.layerManager?.layerGroups || []).reduce((n, g) => n + (g.strokeStack?.length || 0), 0),
    baked: (window.app?.board?.layerManager?.layerGroups || []).some((g) => !!g.flatCanvas),
  }))));
  obs.forEach((o, i) => console.log(`  ${o.label}: paintedGroups=${painted(snaps[o.label])} liveStrokes=${userCounts[i].strokes} baked=${userCounts[i].baked}`));

  // Pixel parity A↔B, A↔C.
  let allPass = true;
  const diffs = {};
  for (const label of ['B', 'C']) {
    const d = diffSnapshots(snaps.A, snaps[label]);
    diffs[label] = d;
    if (!d.pass) {
      allPass = false;
      try {
        const dataUrl = await obs[0].page.evaluate(generateDiffPngInPage, snaps.A, snaps[label], PIXEL_TOLERANCE);
        fs.writeFileSync(path.join(RESULTS_DIR, `diff_A_${label}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
      } catch {}
    }
    console.log(`  ${d.pass ? '✅' : '❌'} A↔${label}: match ${d.matchPct.toFixed(3)}%  maxΔ ${d.maxDelta}`);
  }

  fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
    runId: RUN_ID, room: ROOM, pixelTolerance: PIXEL_TOLERANCE, passPct: PASS_PCT,
    diffs: Object.fromEntries(Object.entries(diffs).map(([k, d]) => [k, { pass: d.pass, matchPct: d.matchPct, maxDelta: d.maxDelta }])),
  }, null, 2));

  console.log('\n' + '─'.repeat(56));
  console.log(allPass ? 'RESULT: all observers see bot strokes identically ✅' : 'RESULT: observer divergence detected ❌ (see diff_*.png)');
  console.log(`Results: ${RESULTS_DIR}`);
  console.log('─'.repeat(56));

  for (const o of obs) await o.browser.close().catch(() => {});
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error('Uncaught:', err); process.exit(2); });
