#!/usr/bin/env node
/**
 * @fileoverview Attribute frame stalls in a Chrome trace, across every process.
 *
 * Written for the board-size lag investigation, where every previous instrument
 * pointed the wrong way. JS self-time said 2% load while frames were visibly
 * dropping, because the cost was never on the renderer main thread. A trace is
 * the only instrument that sees the GPU process, and the number that matters is
 * buried in an event argument no profiler UI surfaces:
 *
 *   GPUTask.args.data.used_bytes  →  GPU process memory actually in use
 *
 * That is the ground truth the canvas census can only estimate. The census sums
 * `width * height * 4` over canvases the app can reach from JS; `used_bytes` is
 * what the GPU process really holds, including everything the compositor
 * allocates on its own behalf. When the two diverge, the census is the one that
 * is wrong.
 *
 * Usage:
 *   node testing/devtools/trace_gpu_report.mjs <trace.json> [--top=25]
 */

import fs from 'fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const TOP = Number(args.find((a) => a.startsWith('--top='))?.slice(6)) || 25;

if (!file) {
  console.error('usage: trace_gpu_report.mjs <trace.json> [--top=N]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = raw.traceEvents || raw;

const threadNames = {};
const processNames = {};
for (const e of events) {
  if (e.name === 'thread_name' && e.args?.name) threadNames[`${e.pid}:${e.tid}`] = e.args.name;
  if (e.name === 'process_name' && e.args?.name) processNames[e.pid] = e.args.name;
}
const where = (e) => `${processNames[e.pid] || '?'} | ${threadNames[`${e.pid}:${e.tid}`] || e.tid}`;

const complete = events.filter((e) => e.ph === 'X' && e.dur > 0);
// Reduced rather than spread: a busy trace runs to hundreds of thousands of
// events and `Math.min(...arr)` overflows the call stack well before that.
let t0 = Infinity;
let t1 = -Infinity;
for (const e of complete) {
  if (e.ts < t0) t0 = e.ts;
  if (e.ts + e.dur > t1) t1 = e.ts + e.dur;
}
const spanMs = (t1 - t0) / 1000;

// ── GPU memory ─────────────────────────────────────────────────────────────
// The headline. Reported as a range because it climbs under load, and the
// climb is as diagnostic as the absolute figure: a board that is merely large
// sits flat, while one that is churning full-board allocations ratchets up.
const usedBytes = [];
for (const e of events) {
  const u = e.args?.data?.used_bytes;
  if (typeof u === 'number' && u > 0) usedBytes.push({ ts: e.ts, u });
}
usedBytes.sort((a, b) => a.ts - b.ts);

const MB = (b) => (b / 1048576).toFixed(0);
console.log(`\n=== ${file}`);
console.log(`span ${spanMs.toFixed(0)} ms, ${events.length} events\n`);

if (usedBytes.length) {
  const first = usedBytes[0].u;
  const last = usedBytes[usedBytes.length - 1].u;
  let peak = 0; for (const x of usedBytes) if (x.u > peak) peak = x.u;
  console.log('GPU process memory (GPUTask used_bytes)');
  console.log(`  start ${MB(first)} MB   end ${MB(last)} MB   peak ${MB(peak)} MB   drift ${last >= first ? '+' : ''}${MB(last - first)} MB`);
  console.log(`  samples: ${usedBytes.length}\n`);
} else {
  console.log('GPU process memory: no used_bytes samples (trace lacks GPU process events)\n');
}

// ── Stalls, wherever they live ─────────────────────────────────────────────
// Grouped by thread rather than by event name: the question this answers is
// "which thread is blocking", and a 54 ms GPUTask and a 54 ms RunTask on the
// same thread are the same stall counted twice.
const STALL_MS = 16;
const stalls = complete
  .filter((e) => e.dur > STALL_MS * 1000)
  .sort((a, b) => b.dur - a.dur);

const byThread = new Map();
for (const e of stalls) {
  const k = where(e);
  if (!byThread.has(k)) byThread.set(k, { n: 0, worst: 0, total: 0 });
  const r = byThread.get(k);
  r.n++; r.total += e.dur; r.worst = Math.max(r.worst, e.dur);
}
console.log(`Stalls over ${STALL_MS} ms, by thread`);
for (const [k, r] of [...byThread].sort((a, b) => b[1].worst - a[1].worst)) {
  console.log(`  ${(r.worst / 1000).toFixed(1).padStart(7)} ms worst  ${String(r.n).padStart(4)} stalls  ${(r.total / 1000).toFixed(0).padStart(6)} ms total   ${k}`);
}

// ── Busiest threads ────────────────────────────────────────────────────────
// Vsync threads spend their whole life in a blocking wait and will always top
// a raw total, so they are flagged rather than filtered — silently dropping a
// thread is how a real cost gets missed.
const agg = new Map();
for (const e of complete) {
  const k = `${where(e)} | ${e.name}`;
  if (!agg.has(k)) agg.set(k, { n: 0, tot: 0, max: 0 });
  const r = agg.get(k);
  r.n++; r.tot += e.dur; r.max = Math.max(r.max, e.dur);
}
console.log(`\nBusiest (total ms, share of ${spanMs.toFixed(0)} ms wall)`);
console.log('  total_ms   share  count   max_ms  where');
for (const [k, r] of [...agg].sort((a, b) => b[1].tot - a[1].tot).slice(0, TOP)) {
  const note = /VSync/i.test(k) ? '  (blocking wait, not work)' : '';
  console.log(
    `  ${(r.tot / 1000).toFixed(0).padStart(8)}  ${((r.tot / 1000 / spanMs) * 100).toFixed(0).padStart(5)}%  ${String(r.n).padStart(5)}  ${(r.max / 1000).toFixed(1).padStart(7)}  ${k}${note}`
  );
}
console.log();
