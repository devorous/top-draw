#!/usr/bin/env node
/**
 * @fileoverview k6 → .ddraw → replay-parity flow.
 *
 * End-to-end check of the recording pipeline against REAL server-relayed
 * traffic (rather than puppeteer-synthesised local input):
 *
 *   1. A browser tab (the "recorder") joins a room and starts app.recorder.
 *   2. k6 (_k6_ddraw_feed.js) floods that room with render-deterministic
 *      strokes from N virtual users. The recorder taps every inbound message.
 *   3. We snapshot the recorder's LIVE canvas, then stop the recorder and
 *      encode the bundle to a real .ddraw file via the production ddrawCodec
 *      (encodeDdraw) — exactly what the in-app "save replay" button writes.
 *   4. The saved file is read back from disk and replayed in several configs
 *      (fresh out-of-room tab, in-room tab). Each replay's canvas is diffed
 *      against the recorder's live canvas using the shared layerDiff oracle.
 *   5. As a portability smoke check, any pre-existing .ddraw files in
 *      testing/ddraw/ are also loaded + replayed (no live oracle — we just
 *      assert they decode and paint a non-blank canvas).
 *
 * Because parity compares a tab's own live canvas against a replay of its own
 * recording, the result is independent of k6's randomness — it isolates the
 * Recorder + ddrawCodec + ReplayEngine round-trip.
 *
 * Usage:
 *   node testing/devtools/k6_ddraw_parity.mjs
 *   node testing/devtools/k6_ddraw_parity.mjs --headed --vus=4 --strokes=8
 *
 * Env / flags:
 *   TARGET_URL       http://localhost:3000/go/   (browser)
 *   WS_URL           ws://127.0.0.1:8030         (k6 → server)
 *   HEADLESS         "false" / --headed
 *   --vus=N          k6 virtual users   (default 3)
 *   --strokes=N      strokes per VU     (default 6)
 *   --keep           keep generated .ddraw files (default: keep)
 */

import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
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

// ─── Config ──────────────────────────────────────────────────────────────────
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const WS_URL     = process.env.WS_URL     || 'ws://127.0.0.1:8030';
let   HEADLESS   = process.env.HEADLESS !== 'false';
let   VUS = 3, STROKES = 6, TOOLS = '', HARDNESS = '';

for (const a of process.argv.slice(2)) {
  if (a === '--headed') HEADLESS = false;
  else if (a.startsWith('--vus='))      VUS = parseInt(a.slice(6), 10);
  else if (a.startsWith('--strokes='))  STROKES = parseInt(a.slice(10), 10);
  else if (a.startsWith('--tools='))    TOOLS = a.slice(8);     // e.g. line,rectangle,circle
  else if (a.startsWith('--hardness=')) HARDNESS = a.slice(11); // e.g. 100
  else if (a === '--keep') { /* default */ }
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const FEED_SCRIPT = path.join(__dirname, '_k6_ddraw_feed.js');
const CODEC_URL = '/shared/ddrawCodec.js';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `k6ddraw_${RUN_ID}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tab lifecycle (keeps the tick loop running — remote draws need it) ──────
async function spawnTab(browser, label, { room = null } = {}) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[ERROR\]|\[Recorder\]|\[TimeMachine\]|\[ddraw\]/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERR] ${err.message}\n`));

  // Pin Math.random for determinism, but DO NOT freeze Date.now: the Recorder
  // stamps each delta with Date.now(), and the replay seek slices the tape by
  // those timestamps. A frozen clock would also push the seek-to-end target
  // before any real-timestamp tape (e.g. a pre-existing .ddraw), replaying 0
  // actions. The feeder uses render-deterministic tools, so wall-clock drift
  // never affects pixels.
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

/** Decode a .ddraw (base64) in-page and run it through TimeMachine. */
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
 * loadFromRecording's fast path (when the .ddraw carries baked visual
 * checkpoints) only paints a low-res preview and kicks off the full-resolution
 * seek(sessionEnd) in the BACKGROUND. Wait for that to land before capturing,
 * otherwise the replay LayerManager is still empty/partial. Settled =
 * _lastAppliedTimestamp has reached sessionEnd and no seek is in flight.
 */
async function waitReplaySettled(page, timeoutMs = 20_000) {
  await page.waitForFunction(() => {
    const tm = window.app?.TimeMachine;
    return !!tm && tm.isOpen && tm._lastAppliedTimestamp === tm.sessionEnd && !tm._isSeeking;
  }, { timeout: timeoutMs, polling: 200 });
}

/** Painted groups = groups that produced a non-null dirty bbox (covers baked). */
function paintedGroups(snaps) { return snaps.filter((s) => s.bbox).length; }

// ─── k6 driver (background — the feeder holds its sockets open via LIFETIME) ──
function startK6(room) {
  const args = [
    'run',
    '-e', `ROOM=${room}`,
    '-e', `TARGET_URL=${WS_URL}`,
    '-e', `VUS=${VUS}`,
    '-e', `STROKES=${STROKES}`,
    // Hold sockets open long enough that the observer can wait for the canvas to
    // stop changing (pixel-stability) while the bots are still registered users.
    '-e', 'LIFETIME_MS=16000',
    ...(TOOLS ? ['-e', `TOOLS=${TOOLS}`] : []),
    ...(HARDNESS ? ['-e', `HARDNESS=${HARDNESS}`] : []),
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

/** Sum live stroke counts on the recorder's board. */
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
  const room = `k6ddraw_${Date.now()}`;

  console.log(`\nTop Draw — k6 → .ddraw → replay parity`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`Browser:    ${TARGET_URL}`);
  console.log(`k6 → WS:    ${WS_URL}`);
  console.log(`Room:       ${room}`);
  console.log(`Feed:       VUS=${VUS} STROKES=${STROKES}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const results = { parity: [], smoke: [] };
  let savedFile = null;

  try {
    // ── 1. Recorder joins room, starts recording ──
    process.stdout.write('Spawning recorder tab … ');
    const recorder = await spawnTab(browser, 'recorder', { room });
    console.log('joined.');
    await startRecording(recorder.page);
    console.log('Recorder armed. Launching k6 feed …\n');

    // ── 2. k6 drives the room (background; feeder holds sockets open) ──
    const t0 = Date.now();
    const k6 = startK6(room);

    // ── 3. Wait for the live canvas to stop CHANGING, WHILE the bots are still
    //       connected. Stroke COUNT is not enough: the recorder commits a stroke
    //       (count++) before it finishes incrementally rendering that stroke's
    //       buffered points, so a count-stable canvas can still be half-painted
    //       under load. Settle on pixel-stability — two consecutive identical
    //       snapshots — which captures the true final frame the tape replays to. ──
    let prevSnap = null, snapsLive = null, live = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(800);
      const snap = await recorder.page.evaluate(captureLayerSnapshotsInPage);
      const painted = snap.filter((s) => s.bbox).length;
      live = await liveStrokeCount(recorder.page);
      if (prevSnap && painted > 0) {
        const d = diffSnapshots(prevSnap, snap);
        if (d.matchPct >= 99.99 && d.maxDelta === 0) { snapsLive = snap; break; }
      }
      prevSnap = snap;
    }
    snapsLive = snapsLive ?? prevSnap ?? [];
    const liveStrokes = live;
    console.log(`Live canvas pixel-stable at ${liveStrokes} strokes after ${Date.now() - t0}ms.`);
    await recorder.page.screenshot({ path: path.join(RESULTS_DIR, 'live_recorder.png') });

    const enc = await stopAndEncode(recorder.page, CODEC_URL);
    if (!enc) throw new Error('Recorder produced no bundle');
    savedFile = path.join(DDRAW_DIR, `k6_feed_${RUN_ID}.ddraw`);
    fs.writeFileSync(savedFile, Buffer.from(enc.b64, 'base64'));
    console.log(`Saved ${path.relative(process.cwd(), savedFile)} ` +
      `(${(enc.size / 1024).toFixed(1)} KB, ${enc.deltas} deltas, live strokes=${liveStrokes})\n`);

    if (liveStrokes === 0) {
      console.log('⚠️  Recorder captured an empty canvas — is the WS server up and the feed reaching the room?');
    }

    // Let k6 wind down (feeder sockets close at LIFETIME) before replaying.
    const k6res = await k6.done;
    fs.writeFileSync(path.join(RESULTS_DIR, 'k6_output.txt'), k6res.out());
    console.log(`k6 exited (${k6res.code}, ${Date.now() - t0}ms total).\n`);

    // ── 4. Replay the saved file in several configs, diff vs live ──
    const fileB64 = fs.readFileSync(savedFile).toString('base64');

    const configs = [
      { name: 'out_of_room',  room: null },
      { name: 'in_room',      room },        // joined room, then replay overrides
    ];

    console.log('Replay parity (saved .ddraw vs live canvas):');
    for (const cfg of configs) {
      process.stdout.write(`  ${cfg.name.padEnd(14)} … `);
      const tab = await spawnTab(browser, `replay_${cfg.name}`, { room: cfg.room });
      try {
        await loadDdrawFromBase64(tab.page, fileB64, CODEC_URL);
        await waitReplaySettled(tab.page);
        const snapsReplay = await tab.page.evaluate(captureReplayLayerSnapshotsInPage);
        const painted = paintedGroups(snapsReplay);
        const diff = diffSnapshots(snapsLive, snapsReplay);
        await tab.page.screenshot({ path: path.join(RESULTS_DIR, `replay_${cfg.name}.png`) });
        if (!diff.pass) {
          // Emit a side-by-side REF/REPLAY/DIFF triptych to localise the mismatch.
          const dataUrl = await tab.page.evaluate(generateDiffPngInPage, snapsLive, snapsReplay, PIXEL_TOLERANCE);
          fs.writeFileSync(path.join(RESULTS_DIR, `diff_${cfg.name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
        }
        await teardownReplay(tab.page);
        results.parity.push({ config: cfg.name, pass: diff.pass, matchPct: diff.matchPct, maxDelta: diff.maxDelta, paintedGroups: painted });
        console.log(`${diff.pass ? '✅ PASS' : '❌ FAIL'}  match ${diff.matchPct.toFixed(2)}%  maxΔ ${diff.maxDelta}  painted ${painted}g`);
      } catch (err) {
        results.parity.push({ config: cfg.name, pass: false, error: err.message });
        console.log(`💥 ${err.message}`);
      } finally {
        await tab.page.close().catch(() => {});
      }
    }

    // ── 5. Portability smoke: load any other .ddraw already on disk ──
    const others = fs.readdirSync(DDRAW_DIR)
      .filter((f) => f.endsWith('.ddraw') && path.join(DDRAW_DIR, f) !== savedFile);
    if (others.length) {
      console.log('\nPortability smoke (decode + replay pre-existing files):');
      const smokeTab = await spawnTab(browser, 'smoke', { room: null });
      for (const f of others) {
        process.stdout.write(`  ${f.padEnd(28)} … `);
        try {
          const b64 = fs.readFileSync(path.join(DDRAW_DIR, f)).toString('base64');
          const info = await loadDdrawFromBase64(smokeTab.page, b64, CODEC_URL);
          // Big archival files (e.g. big.ddraw: 17.6 MB / 83k deltas) need well
          // over the parity default to finish the background seek-to-end.
          await waitReplaySettled(smokeTab.page, 90_000);
          const snaps = await smokeTab.page.evaluate(captureReplayLayerSnapshotsInPage);
          const painted = paintedGroups(snaps);
          const ok = painted > 0;
          await teardownReplay(smokeTab.page);
          results.smoke.push({ file: f, ok, paintedGroups: painted, deltas: info.deltas });
          console.log(`${ok ? '✅' : '⚠️ '} decoded, ${info.deltas} deltas → ${painted} painted group(s)`);
        } catch (err) {
          results.smoke.push({ file: f, ok: false, error: err.message });
          console.log(`💥 ${err.message}`);
        }
      }
      await smokeTab.page.close().catch(() => {});
    }

    // ── Summary ──
    const parityPass = results.parity.filter((r) => r.pass).length;
    console.log('\n' + '─'.repeat(60));
    console.log(`PARITY: ${parityPass}/${results.parity.length} configs passed`);
    if (results.smoke.length) {
      const smokeOk = results.smoke.filter((r) => r.ok).length;
      console.log(`SMOKE:  ${smokeOk}/${results.smoke.length} files decoded + replayed`);
    }
    console.log('─'.repeat(60));

    fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify({
      runId: RUN_ID, room, ws: WS_URL, vus: VUS, strokes: STROKES,
      savedFile: path.relative(process.cwd(), savedFile),
      savedBytes: enc.size, deltas: enc.deltas, liveStrokes,
      pixelTolerance: PIXEL_TOLERANCE, passPct: PASS_PCT,
      parity: results.parity, smoke: results.smoke,
    }, null, 2));

    process.exitCode = parityPass === results.parity.length && liveStrokes > 0 ? 0 : 1;
  } catch (err) {
    console.error('\nFatal:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('Uncaught:', err); process.exit(1); });
