#!/usr/bin/env node
/**
 * @fileoverview Triple-Recorder Parity Suite — three tabs in the same room
 * each run their own local Recorder while one of them draws. All three stop
 * simultaneously and we compare the resulting bundles:
 *
 *   1. Delta histogram parity     (each tab should have observed the same
 *      set of T-typed messages — drawer as outbound, others as inbound).
 *   2. Opening-snapshot pixel parity (they joined a freshly-cleared board, so
 *      every tab's openingSnapshot.canvasData should match).
 *   3. Replay pixel parity        (load each bundle into a dedicated replayer
 *      tab and diff the final replay-engine pixels via the shared layerDiff
 *      helpers).
 *
 * The script also saves each bundle as JSON next to a summary, so failed runs
 * can be inspected by hand.
 *
 * Usage:
 *   node testing/devtools/triple_recorder_parity.mjs
 *   node testing/devtools/triple_recorder_parity.mjs --headed
 *   node testing/devtools/triple_recorder_parity.mjs --only=brush_simple
 *
 * Env vars:
 *   TARGET_URL       http://localhost:3000/go/
 *   HEADLESS         "false" to show the browser windows
 *   PROPAGATION_MS   3500
 *   REPLAY_SETTLE_MS 1500
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  PIXEL_TOLERANCE,
  PASS_PCT,
  captureLayerSnapshotsInPage,
  captureReplayLayerSnapshotsInPage,
  diffSnapshots,
} from '../lib/layerDiff.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const TARGET_URL       = process.env.TARGET_URL    || 'http://localhost:3000/go/';
const HEADLESS         = process.env.HEADLESS !== 'false';
const PROPAGATION_MS   = parseInt(process.env.PROPAGATION_MS   || '3500', 10);
const REPLAY_SETTLE_MS = parseInt(process.env.REPLAY_SETTLE_MS || '1500', 10);

const args = process.argv.slice(2);
let NAME_FILTER = null;
for (const a of args) {
  if (a === '--headed') process.env.HEADLESS = 'false';
  else if (a.startsWith('--only=')) NAME_FILTER = a.slice('--only='.length).split(',').map((s) => s.trim());
  else if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(2); }
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULTS_DIR = path.join(__dirname, '..', 'sync_results', `triple_${RUN_ID}`);

// ─── Test matrix (small — pace one new feature at a time) ──────────────────

const TEST_CASES = [
  {
    name: 'brush_simple',
    action: async (page) => {
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 30, color: [220, 60, 60, 1], hardness: 100 });
      await drawPath(page, [{ x: 300, y: 300 }, { x: 700, y: 400 }, { x: 1100, y: 350 }]);
    },
  },
  {
    name: 'brush_multi_stroke',
    action: async (page) => {
      await selectTool(page, 'brush');
      const variations = [
        { color: [255, 0, 0, 1], size: 20 },
        { color: [0, 200, 60, 1], size: 35 },
        { color: [40, 80, 220, 1], size: 25 },
      ];
      for (let i = 0; i < variations.length; i++) {
        await setToolSettings(page, { ...variations[i], hardness: 100 });
        const y = 280 + i * 120;
        await drawPath(page, [{ x: 320, y }, { x: 760, y: y + 50 }, { x: 1200, y }]);
      }
    },
  },
  // Concurrent-draw — every tab draws at once. Strongest cross-bundle parity
  // test we can write: every recorder should observe every other tab's strokes
  // (inbound) AND its own (outbound, stamped with sessionIndex), so the three
  // bundles must end up byte-identical at the (t, u) level.
  {
    name: 'concurrent_brush',
    concurrent: true,
    perTabAction: async (page, idx) => {
      const zones = [
        { color: [220, 60, 60, 1], y: 280 },
        { color: [50, 80, 220, 1], y: 480 },
        { color: [40, 180, 60, 1], y: 680 },
      ];
      const zone = zones[idx] ?? zones[0];
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 25, color: zone.color, hardness: 100 });
      await drawPath(page, [
        { x: 300, y: zone.y },
        { x: 700, y: zone.y + 40 },
        { x: 1100, y: zone.y },
      ]);
    },
  },
];

// ─── Page helpers ──────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function selectTool(page, tool) {
  await page.evaluate((t) => window.app.selectTool(t), tool);
}

async function setToolSettings(page, settings) {
  await page.evaluate((s) => {
    const app = window.app;
    if (s.size !== undefined)     app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined)    app.handleColorInputChange(s.color);
    if (s.hardness !== undefined) app.handleHardnessChange({ target: { value: s.hardness } });
  }, settings);
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
    return {
      clientX: rxr + board.panX + containerRect.left,
      clientY: ryr + board.panY + containerRect.top,
    };
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
      const steps = 4;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cur = {
          clientX: a.clientX + (b.clientX - a.clientX) * t,
          clientY: a.clientY + (b.clientY - a.clientY) * t,
        };
        app.handlePointerMove(ev(cur));
        app.inputBufferManager?.tick();
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    app.handlePointerUp(ev(pts[pts.length - 1]));
    app.inputBufferManager?.tick();
  }, clientPoints);
  await sleep(250);
}

async function reseedRandom(page, seedValue = 12345) {
  await page.evaluate((s) => {
    let seed = s;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }, seedValue);
}

async function clearCanvas(page) {
  await page.evaluate(() => {
    const app = window.app;
    app.board?.clear?.();
    app.board?.tileTracker?.clear?.();
    app.debugOverlay?.clearAll?.();
  });
}

async function stopTickLoop(page) {
  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
}

// ─── Tab lifecycle ─────────────────────────────────────────────────────────

async function spawnTab(browser, label, room, { joinRoom = true } = {}) {
  const page = await browser.newPage();

  page.on('console', (msg) => {
    const txt = msg.text();
    if (/\[ERROR\]|\[Recorder\]|\[TimeMachine\]/i.test(txt)) {
      process.stdout.write(`  [${label}] ${txt}\n`);
    }
  });
  page.on('pageerror', (err) => process.stderr.write(`  [${label} ERROR] ${err.message}\n`));

  await page.evaluateOnNewDocument(() => {
    let seed = 12345;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const fixedDate = new Date('2026-05-22T12:00:00Z').getTime();
    Date.now = () => fixedDate;
  });

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app !== undefined && window.app.self != null, { timeout: 60_000 });

  if (joinRoom) {
    await page.evaluate((n, r) => {
      window.app.self.username = n;
      window.app.handleRoomSelected(r);
    }, label, room);

    await page.waitForFunction(() => {
      const app = window.app;
      const syncDone = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
      return app?.wsClient?.connected && syncDone;
    }, { timeout: 60_000 });

    await stopTickLoop(page);
  }

  return { label, page };
}

// ─── Recorder bridge ───────────────────────────────────────────────────────

async function startRecording(page) {
  await page.evaluate(() => {
    if (!window.app.recorder) throw new Error('app.recorder not present');
    window.app.recorder.start(window.app);
  });
}

async function stopRecording(page) {
  return page.evaluate(() => {
    const rec = window.app.recorder.stop();
    if (!rec) return null;
    return {
      version: rec.version,
      roomId: rec.roomId,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      openingSnapshot: rec.openingSnapshot,
      deltas: rec.deltas,
      intraCheckpoints: rec.intraCheckpoints,
      assets: rec.assets instanceof Map ? Object.fromEntries(rec.assets) : (rec.assets ?? {}),
    };
  });
}

async function loadBundleIntoReplayer(page, bundle) {
  await page.evaluate(async (b) => {
    if (!window.app?.TimeMachine?.loadFromRecording) {
      throw new Error('TimeMachine.loadFromRecording not present');
    }
    const rec = { ...b, assets: new Map(Object.entries(b.assets || {})) };
    await window.app.TimeMachine.loadFromRecording(rec);
  }, bundle);
}

async function teardownReplayer(page) {
  await page.evaluate(() => window.app.TimeMachine.stop?.());
}

// ─── Bundle analysis ───────────────────────────────────────────────────────

function deltaHistogram(bundle) {
  const hist = {};
  for (const d of bundle.deltas ?? []) {
    const key = String(d?.msg?.t ?? 'unknown');
    hist[key] = (hist[key] ?? 0) + 1;
  }
  return hist;
}

function histogramEquals(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

function diffHistogram(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => Number(x) - Number(y));
  const rows = [];
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av !== bv) rows.push({ t: k, ref: av, other: bv });
  }
  return rows;
}

// Compare openingSnapshot.canvasData dataURLs (cheap byte-equal).
function openingSnapshotEqual(refBundle, otherBundle) {
  return refBundle?.openingSnapshot?.canvasData === otherBundle?.openingSnapshot?.canvasData;
}

// ─── Per-case run ──────────────────────────────────────────────────────────

async function runCase(tabs, testCase) {
  const t0 = Date.now();
  const { drawer, obs1, obs2, replayer } = tabs;
  const recorders = [drawer, obs1, obs2];

  // Reset every tab to a clean board with deterministic RNG.
  for (const t of recorders) await clearCanvas(t.page);
  await sleep(400);
  for (const t of [...recorders, replayer]) await reseedRandom(t.page);
  await sleep(150);

  // Start all three recorders in parallel.
  await Promise.all(recorders.map((t) => startRecording(t.page)));

  if (testCase.concurrent && testCase.perTabAction) {
    // Every tab draws simultaneously.
    await Promise.all(recorders.map((t, i) => testCase.perTabAction(t.page, i)));
  } else {
    // The drawer performs the action; the others sit idle and just observe.
    await testCase.action(drawer.page);
  }
  await sleep(PROPAGATION_MS);

  // Live oracle: drawer↔obs1 pixel parity (sanity that the broadcast path works).
  const liveDrawer = await drawer.page.evaluate(captureLayerSnapshotsInPage);
  const liveObs1   = await obs1.page.evaluate(captureLayerSnapshotsInPage);
  const liveDiff   = diffSnapshots(liveDrawer, liveObs1);

  // Stop all three recorders simultaneously (the user's core ask).
  const bundles = await Promise.all(recorders.map((t) => stopRecording(t.page)));
  const [bDrawer, bObs1, bObs2] = bundles;
  for (const b of bundles) if (!b) throw new Error('Recorder.stop() returned null');

  // Bundle-level comparison.
  const histDrawer = deltaHistogram(bDrawer);
  const histObs1   = deltaHistogram(bObs1);
  const histObs2   = deltaHistogram(bObs2);
  const histPass   = histogramEquals(histDrawer, histObs1) && histogramEquals(histDrawer, histObs2);
  const openingPass = openingSnapshotEqual(bDrawer, bObs1) && openingSnapshotEqual(bDrawer, bObs2);

  // Replay-pixel parity: load each bundle into the dedicated replayer tab and
  // diff against the live drawer's pixels (the same oracle replay_parity_suite
  // uses).
  const replayDiffs = [];
  for (const b of bundles) {
    await loadBundleIntoReplayer(replayer.page, b);
    await sleep(REPLAY_SETTLE_MS);
    const snap = await replayer.page.evaluate(captureReplayLayerSnapshotsInPage);
    replayDiffs.push(diffSnapshots(liveDrawer, snap));
    await teardownReplayer(replayer.page);
  }

  // Persist bundles for hand-inspection on failure.
  const caseDir = path.join(RESULTS_DIR, testCase.name);
  fs.mkdirSync(caseDir, { recursive: true });
  for (let i = 0; i < bundles.length; i++) {
    const label = recorders[i].label;
    // Skip the dataURL blob from disk dumps; it bloats the file and is the same
    // across tabs by definition when openingPass = true.
    const minimal = {
      ...bundles[i],
      openingSnapshot: {
        ...bundles[i].openingSnapshot,
        canvasData: bundles[i].openingSnapshot?.canvasData ? '[omitted from disk dump]' : null,
        topCanvasData: bundles[i].openingSnapshot?.topCanvasData ? '[omitted from disk dump]' : null,
      },
    };
    fs.writeFileSync(path.join(caseDir, `${label}.bundle.json`), JSON.stringify(minimal, null, 2));
  }

  const elapsed = Date.now() - t0;
  const pass =
    liveDiff.pass &&
    histPass &&
    openingPass &&
    replayDiffs.every((d) => d.pass);

  return {
    name: testCase.name,
    elapsed,
    pass,
    liveDiff,
    histDrawer,
    histObs1,
    histObs2,
    histPass,
    histDiffs: {
      drawerVsObs1: diffHistogram(histDrawer, histObs1),
      drawerVsObs2: diffHistogram(histDrawer, histObs2),
    },
    openingPass,
    replayDiffs,
    deltaCounts: bundles.map((b) => b.deltas.length),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const roomName = `triple_${Date.now()}`;

  console.log(`\nTop Draw — Triple-Recorder Parity Suite`);
  console.log(`Run:        ${RUN_ID}`);
  console.log(`URL:        ${TARGET_URL}`);
  console.log(`Room:       ${roomName}`);
  console.log(`Tolerance:  ±${PIXEL_TOLERANCE}px, ≥${PASS_PCT}% match`);
  console.log(`Results:    ${RESULTS_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const tabs = {};
  const results = [];

  try {
    process.stdout.write('Spawning tabs ');
    tabs.drawer   = await spawnTab(browser, 'drawer',   roomName, { joinRoom: true });   process.stdout.write('A ');
    tabs.obs1     = await spawnTab(browser, 'obs1',     roomName, { joinRoom: true });   process.stdout.write('B ');
    tabs.obs2     = await spawnTab(browser, 'obs2',     roomName, { joinRoom: true });   process.stdout.write('C ');
    tabs.replayer = await spawnTab(browser, 'replayer', null,     { joinRoom: false });  process.stdout.write('D\n');

    // Wait for all three live tabs to see each other.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const counts = await Promise.all(
        [tabs.drawer, tabs.obs1, tabs.obs2].map((t) =>
          t.page.evaluate(() => window.app?.users?.size ?? 0),
        ),
      );
      if (counts.every((c) => c >= 3)) break;
      await sleep(250);
    }
    console.log('Live trio connected.\n');

    const cases = TEST_CASES.filter((tc) => !NAME_FILTER || NAME_FILTER.includes(tc.name));
    for (const tc of cases) {
      process.stdout.write(`  ${tc.name.padEnd(28)} ... `);
      try {
        const r = await runCase(tabs, tc);
        results.push(r);
        const status = r.pass ? '✅ PASS' : '❌ FAIL';
        const live = `live ${r.liveDiff.matchPct.toFixed(2)}%`;
        const hist = r.histPass ? 'hist ✓' : 'hist ✗';
        const open = r.openingPass ? 'open ✓' : 'open ✗';
        const replay = r.replayDiffs.map((d) => d.matchPct.toFixed(1)).join('/');
        const deltas = `Δ ${r.deltaCounts.join('/')}`;
        console.log(`${status}  ${live}  ${hist}  ${open}  replay ${replay}%  ${deltas}  (${r.elapsed}ms)`);

        if (!r.histPass) {
          if (r.histDiffs.drawerVsObs1.length) {
            console.log(`     hist drawer↕obs1: ${r.histDiffs.drawerVsObs1.map((x) => `t${x.t}:${x.ref}vs${x.other}`).join(' ')}`);
          }
          if (r.histDiffs.drawerVsObs2.length) {
            console.log(`     hist drawer↕obs2: ${r.histDiffs.drawerVsObs2.map((x) => `t${x.t}:${x.ref}vs${x.other}`).join(' ')}`);
          }
        }
        if (!r.openingPass) console.log('     opening snapshots diverge between tabs');
        r.replayDiffs.forEach((d, i) => {
          if (!d.pass) console.log(`     replay[${recorders(i)}] maxΔ ${d.maxDelta} match ${d.matchPct.toFixed(3)}%`);
        });
      } catch (err) {
        console.log(`💥 ERROR: ${err.message}`);
        results.push({ name: tc.name, pass: false, error: err.message });
      }
    }

    const passed = results.filter((r) => r.pass).length;
    console.log('\n' + '─'.repeat(60));
    console.log(`RESULTS: ${passed}/${results.length} passed`);
    console.log('─'.repeat(60));

    fs.writeFileSync(
      path.join(RESULTS_DIR, 'summary.json'),
      JSON.stringify(
        {
          runId: RUN_ID,
          url: TARGET_URL,
          pixelTolerance: PIXEL_TOLERANCE,
          passPct: PASS_PCT,
          passed,
          total: results.length,
          results: results.map((r) => ({
            name: r.name,
            pass: r.pass,
            elapsed: r.elapsed,
            deltaCounts: r.deltaCounts,
            histDrawer: r.histDrawer,
            histObs1: r.histObs1,
            histObs2: r.histObs2,
            histPass: r.histPass,
            openingPass: r.openingPass,
            liveMatchPct: r.liveDiff?.matchPct,
            replayMatchPcts: r.replayDiffs?.map((d) => d.matchPct),
            error: r.error,
          })),
        },
        null,
        2,
      ),
    );

    process.exitCode = passed === results.length ? 0 : 1;
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exitCode = 1;
  } finally {
    for (const t of Object.values(tabs)) await t.page.close().catch(() => {});
    await browser.close();
  }
}

function recorders(i) { return ['drawer', 'obs1', 'obs2'][i] ?? `#${i}`; }

main().catch((err) => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
