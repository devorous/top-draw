#!/usr/bin/env node
/**
 * @fileoverview A/B harness for the inbound-queue bake deferral
 * (LayerManager.BAKE_DEFER_ENABLED), run under deliberate asymmetric lag.
 *
 * WHY A RUNNER AND NOT JUST TWO COMMANDS. The previous A/B reached the wrong
 * answer twice over, and both mistakes were procedural rather than analytical:
 *
 *   1. The arms were run in BLOCKS — every ON run, then every OFF run. The
 *      observer suite is bimodal on a timescale longer than one run (machine
 *      state, server bloat, which bot cohort a run lands in), so a block
 *      captures that drift as if it were the treatment. Blocked runs said the
 *      deferral was 1.5 points WORSE; interleaving the same command reversed the
 *      sign. This runner therefore ALTERNATES, always, with no flag to do
 *      otherwise — the discipline is in the code because relying on remembering
 *      it is precisely what failed.
 *   2. The oracle was a pixel percentage with less resolution than the effect.
 *      Runs of an identical command range 92.5–100.0%; the reported difference
 *      was 0.6. This runner leads with the bake ledger (exact integers) and
 *      reports pixels alongside it, not instead of it.
 *
 * It also refuses to report a result it cannot attribute: if the ON arm did not
 * actually have the deferral enabled, or the configured lag never materialised,
 * that is stated as a failure of the experiment rather than folded into a mean.
 *
 * Usage:
 *   node testing/devtools/bake_defer_ab.mjs --runs=4
 *   node testing/devtools/bake_defer_ab.mjs --runs=3 --lag=1,3,6,10 --vus=8 --duration=45s
 *   node testing/devtools/bake_defer_ab.mjs --runs=2 --no-lag        (control: no lag at all)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(__dirname, 'k6_lowstress_observers.mjs');

let RUNS = 3;
// Asymmetric but not extreme. Measured: at 4x throttling a client's inbound
// queue sits at p95 ~4500 messages, which means the deferral would hold every
// overflow bake until it hit BAKE_DEFER_STACK_CAP (200 live strokes) and then
// bake anyway — i.e. the treatment would spend the whole run pinned against its
// own safety valve, and the arm would not be testing what it claims to. 1-4x
// produces plainly divergent clients while leaving the queue drainable.
let LAG = '1,2,3,4';
let VUS = '8';
let DURATION = '30s';
let WAVES = '2';
let OBSERVERS = '4';
let EXTRA = [];
// Which suite flag the ON arm passes. Defaults to the inbound-queue deferral
// this runner was written for, but the interleaving discipline above is what
// makes it valuable and it applies to ANY bake treatment — so the arm is a
// parameter. e.g. --arm-flag=--server-bake
let ARM_FLAG = '--bake-defer';
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--arm-flag=')) ARM_FLAG = a.slice(11);
  else if (a.startsWith('--runs=')) RUNS = Math.max(1, Number(a.slice(7)));
  else if (a === '--no-lag') LAG = null;
  else if (a.startsWith('--lag=')) LAG = a.slice(6);
  else if (a.startsWith('--vus=')) VUS = a.slice(6);
  else if (a.startsWith('--duration=')) DURATION = a.slice(11);
  else if (a.startsWith('--waves=')) WAVES = a.slice(8);
  else if (a.startsWith('--observers=')) OBSERVERS = a.slice(12);
  else EXTRA.push(a);
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '—');

/** Run the observer suite once; return the parsed summary.json. */
function runOnce(deferOn, label) {
  const args = [
    SUITE,
    `--vus=${VUS}`, `--duration=${DURATION}`, `--waves=${WAVES}`, `--observers=${OBSERVERS}`,
    // The tape and replay oracles are not what this experiment measures and they
    // roughly double the wall time, so they are off by default here. Pass
    // --record / --replay-parity through EXTRA if a run needs them.
    '--no-record', '--no-replay-parity',
    ...(LAG ? [`--cpu-lag=${LAG}`] : []),
    ...(deferOn ? [ARM_FLAG] : []),
    ...EXTRA,
  ];
  return new Promise((resolve) => {
    const t0 = Date.now();
    process.stdout.write(`  ${label}  `);
    const child = spawn(process.execPath, args, { cwd: path.join(__dirname, '..', '..') });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      // The suite prints its results directory as the last thing it does; that
      // is the only handshake between the two processes.
      const m = out.match(/Results:\s*(.+)/);
      let summary = null;
      if (m) {
        const file = path.join(m[1].trim(), 'summary.json');
        try { summary = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* reported below */ }
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (!summary) {
        console.log(`FAILED to produce a summary (exit ${code}, ${secs}s)`);
        const tail = out.trim().split('\n').slice(-6).join('\n      ');
        console.log(`      ${tail}`);
      }
      resolve({ code, summary, secs, out });
    });
  });
}

/** Pull the handful of numbers the decision turns on out of a run summary. */
function extract(summary) {
  if (!summary) return null;
  const bl = summary.bakeLedger || {};
  const totals = bl.totals || {};
  const costs = Object.values(summary.bakeCost || {}).filter(Boolean);
  const diffs = Object.values(summary.diffs || {});
  const lag = summary.lagReport || {};
  const viol = Object.values(summary.bakeViolations || {}).filter(Boolean);
  return {
    // exact oracle
    verdict: bl.verdict ?? 'UNKNOWN',
    inversions: totals.inversions ?? null,
    zInversions: totals.zInversions ?? null,
    prefixDelta: totals.prefixDelta ?? null,
    worstPrefixDelta: totals.worstPrefixDelta ?? null,
    // The deferral gates the overflow bake ONLY. Departure (`cleanup`) bakes run
    // through the same code with no gate, and in a lagged run they are the
    // majority — so these two are the arm the treatment can actually move, and
    // the pair the verdict is decided on.
    overflowInversions: totals.overflowInversions ?? null,
    overflowPrefixDelta: totals.overflowPrefixDelta ?? null,
    cleanupShare: (totals.inversions && totals.overflowInversions != null)
      ? Number((1 - totals.overflowInversions / totals.inversions).toFixed(2))
      : null,
    bakedTotal: Object.values(bl.perObserver || {}).reduce((n, o) => n + (o.baked || 0), 0),
    // pixel oracle
    worstPixel: diffs.length ? Math.min(...diffs.map((d) => d.matchPct)) : null,
    // cost
    peakStack: costs.length ? Math.max(...costs.map((c) => c.peakStack ?? 0)) : null,
    peakHeapMB: costs.length ? Math.max(...costs.map((c) => c.peakHeapMB ?? 0)) : null,
    cap: costs[0]?.cap ?? null,
    deferEnabled: costs[0]?.deferEnabled ?? null,
    // attribution
    lagVerified: lag.verified ?? null,
    lagRequested: lag.requested ?? false,
    skewMaxMs: lag.skew?.maxMs ?? null,
    queueMax: Object.values(lag.observers || {}).reduce((n, o) => Math.max(n, o.qMax || 0), 0),
    violations: viol.reduce((n, v) => n + (v.total || 0), 0),
  };
}

function summarise(name, rows) {
  const ok = rows.filter(Boolean);
  if (!ok.length) return { name, n: 0 };
  const pick = (k) => ok.map((r) => r[k]).filter((v) => v != null);
  return {
    name,
    n: ok.length,
    prefixDelta: pick('prefixDelta'),
    inversions: pick('inversions'),
    zInversions: pick('zInversions'),
    overflowInversions: pick('overflowInversions'),
    overflowPrefixDelta: pick('overflowPrefixDelta'),
    pixel: pick('worstPixel'),
    peakStack: pick('peakStack'),
    peakHeapMB: pick('peakHeapMB'),
    violations: pick('violations'),
    capEngaged: ok.filter((r) => r.cap != null && r.peakStack >= r.cap).length,
  };
}

const dist = (xs, d = 0) => (xs.length
  ? `${fmt(Math.min(...xs), d)} / ${fmt(median(xs), d)} / ${fmt(Math.max(...xs), d)}`
  : '—');

async function main() {
  console.log('Top Draw — bake-deferral A/B (interleaved, never blocked)');
  console.log(`  runs per arm: ${RUNS}   vus ${VUS}   duration ${DURATION}   waves ${WAVES}   observers ${OBSERVERS}`);
  console.log(`  cpu lag: ${LAG || 'NONE (control run — expect the deferral to be a no-op)'}`);
  console.log('');

  const on = [];
  const off = [];
  const raw = [];
  for (let i = 0; i < RUNS; i++) {
    // Alternate, and flip which arm leads each round so neither arm is
    // systematically first (the machine is measurably warmer on the second run
    // of a pair, and that warmth is not the treatment).
    const order = i % 2 === 0 ? [true, false] : [false, true];
    for (const deferOn of order) {
      const tag = deferOn ? 'ON ' : 'OFF';
      const r = await runOnce(deferOn, `run ${i + 1} ${tag}`);
      const e = extract(r.summary);
      raw.push({ round: i + 1, arm: tag.trim(), ...(e || {}), failed: !e });
      if (e) {
        console.log(`bake ${String(e.verdict).padEnd(12)} prefixΔ ${String(e.prefixDelta).padStart(5)}`
          + `  inv ${String(e.inversions).padStart(4)}  pixel ${fmt(e.worstPixel)}%`
          + `  peak ${e.peakStack}/${e.peakHeapMB}MB  q${e.queueMax} skew ${e.skewMaxMs}ms  (${r.secs}s)`);
        (deferOn ? on : off).push(e);
        // Attribution guards. Either of these makes the run uninterpretable, and
        // silently averaging it in is how the last A/B produced a confident
        // number for a condition that never existed.
        if (deferOn && e.deferEnabled !== true) {
          console.log('      ⚠ ON arm reported BAKE_DEFER_ENABLED=false — the flag did not take');
        }
        if (!deferOn && e.deferEnabled === true) {
          console.log('      ⚠ OFF arm reported BAKE_DEFER_ENABLED=true — arms are contaminated');
        }
        if (e.lagRequested && !e.lagVerified) {
          console.log('      ⚠ configured lag did not materialise — this run is not attributable');
        }
      }
    }
  }

  const A = summarise('ON', on);
  const B = summarise('OFF', off);
  console.log('\n' + '─'.repeat(72));
  console.log('min / median / max per arm');
  const row = (label, a, b, d = 0) => console.log(`  ${label.padEnd(20)} ON ${dist(a, d).padEnd(24)} OFF ${dist(b, d)}`);
  row('OVERFLOW prefixΔ', A.overflowPrefixDelta || [], B.overflowPrefixDelta || []);
  row('OVERFLOW inversions', A.overflowInversions || [], B.overflowInversions || []);
  row('prefix delta (all)', A.prefixDelta || [], B.prefixDelta || []);
  row('bake inversions (all)', A.inversions || [], B.inversions || []);
  row('z-order inversions', A.zInversions || [], B.zInversions || []);
  row('worst pixel %', A.pixel || [], B.pixel || [], 3);
  row('peak live stack', A.peakStack || [], B.peakStack || []);
  row('peak heap MB', A.peakHeapMB || [], B.peakHeapMB || []);
  row('bake violations', A.violations || [], B.violations || []);
  console.log(`  cap engaged          ON ${A.capEngaged || 0}/${A.n} runs        OFF ${B.capEngaged || 0}/${B.n} runs`);

  // Paired comparison. Each round ran one of each back to back, so differencing
  // within a round removes most of the between-round drift that wrecked the
  // blocked experiment.
  console.log('\npaired within round (ON − OFF; negative = deferral better)');
  const pairs = [];
  for (let i = 0; i < Math.min(on.length, off.length); i++) {
    // Differences are taken on the OVERFLOW arm, because that is the only bake
    // path _shouldDeferBakeForInbound gates. The all-bakes figures are carried
    // along for context but must not decide the verdict — they include departure
    // bakes the treatment cannot influence in either direction.
    const dPrefix = on[i].overflowPrefixDelta - off[i].overflowPrefixDelta;
    const dInv = on[i].overflowInversions - off[i].overflowInversions;
    const dAllInv = on[i].inversions - off[i].inversions;
    const dPix = on[i].worstPixel - off[i].worstPixel;
    const dStack = on[i].peakStack - off[i].peakStack;
    pairs.push({ dPrefix, dInv, dAllInv, dPix, dStack });
    console.log(`  round ${i + 1}: overflow prefixΔ ${dPrefix >= 0 ? '+' : ''}${dPrefix}`
      + `   overflow inv ${dInv >= 0 ? '+' : ''}${dInv}`
      + `   allInv ${dAllInv >= 0 ? '+' : ''}${dAllInv}`
      + `   pixel ${dPix >= 0 ? '+' : ''}${fmt(dPix)}   peakStack ${dStack >= 0 ? '+' : ''}${dStack}`);
  }

  console.log('\n' + '─'.repeat(72));
  if (!pairs.length) {
    console.log('VERDICT: no comparable pairs — the experiment did not run.');
    process.exitCode = 2;
    return;
  }
  const consistentPrefix = pairs.every((p) => p.dPrefix < 0) || pairs.every((p) => p.dPrefix > 0);
  const consistentInv = pairs.every((p) => p.dInv < 0) || pairs.every((p) => p.dInv > 0);
  const medPrefix = median(pairs.map((p) => p.dPrefix));
  const medInv = median(pairs.map((p) => p.dInv));
  const medStack = median(pairs.map((p) => p.dStack));

  // "The sign is consistent across every round" is the bar, because that is
  // exactly the property the previous A/B failed: its sign flipped with run
  // order. A median that points one way over rounds that disagree is not a
  // result, and must not be reported as one.
  // The gated path improving is NOT on its own a reason to ship. The deferral can
  // only hold strokes in the live stack; it cannot stop them being flattened
  // later by an UNGATED path (`deepCleanupUserState` on user departure). So a run
  // where overflow inversions fall to zero while TOTAL inversions rise is the
  // mechanism working and being net-harmful at the same time, and a verdict that
  // reported only the first half would be the same overstatement this harness was
  // built to prevent.
  const medAllInv = median(pairs.map((p) => p.dAllInv));
  const consistentAll = pairs.every((p) => p.dAllInv < 0) || pairs.every((p) => p.dAllInv > 0);
  const gatedWon = consistentInv && medInv < 0;
  const totalLost = consistentAll && medAllInv > 0;

  if (gatedWon && totalLost) {
    console.log(`VERDICT: SPLIT — works on its own path, net-negative overall. DO NOT SHIP AS IS.`);
    console.log(`         Overflow-path inversions ${medInv} per round (the deferral's own arm),`);
    console.log(`         but TOTAL inversions +${medAllInv} — it does not prevent the flattening,`);
    console.log(`         it displaces it into the ungated departure path (deepCleanupUserState),`);
    console.log(`         which bakes in departure order with no seq gate at all.`);
    console.log(`         Cost: peak live stack ${medStack >= 0 ? '+' : ''}${medStack} strokes.`);
    console.log(`         Enabling it is justified only once departure bakes are gated too.`);
  } else if (medPrefix === 0 && medInv === 0) {
    console.log('VERDICT: NULL — the deferral changed neither what was flattened nor its order.');
  } else if (gatedWon && !totalLost) {
    console.log(`VERDICT: the deferral reduced bake-order inversions in every round (median ${medInv})`);
    console.log(`         with no total regression. Cost: peak live stack ${medStack >= 0 ? '+' : ''}${medStack}.`);
  } else if (consistentPrefix && medPrefix < 0) {
    console.log(`VERDICT: the deferral REDUCED prefix divergence in every round (median ${medPrefix}).`);
    console.log(`         Cost: peak live stack ${medStack >= 0 ? '+' : ''}${medStack} strokes.`);
  } else if (consistentPrefix || consistentInv || consistentAll) {
    console.log('VERDICT: consistent sign, but AGAINST the deferral — it made things worse.');
  } else {
    console.log('VERDICT: INCONCLUSIVE — the sign is not consistent across rounds, which is the');
    console.log('         same failure mode as the original blocked A/B. Do not ship on this.');
  }
  const unattributable = raw.filter((r) => r.lagRequested && r.lagVerified === false).length;
  if (unattributable) {
    console.log(`         ⚠ ${unattributable} run(s) had no verified lag — treat the whole result as suspect.`);
  }

  const outFile = path.join(__dirname, '..', 'sync_results', `bake_defer_ab_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ config: { RUNS, LAG, VUS, DURATION, WAVES, OBSERVERS, EXTRA }, raw, pairs }, null, 2));
  console.log(`\nRaw: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
