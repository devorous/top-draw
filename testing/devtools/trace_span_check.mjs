/**
 * Why is analyseTrace's span far shorter than the real measurement window?
 *
 * board_perf_suite derives spanMs from ph==='X' events only. If the trace ring
 * buffer overflowed, the retained events are a slice of the run rather than all
 * of it, and any percentage divided by that slice is measured over the wrong
 * denominator. This prints the span implied by several different event subsets
 * so the two can be told apart.
 *
 * Usage: node testing/devtools/trace_span_check.mjs <trace.json>
 */
import fs from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: trace_span_check.mjs <trace.json>'); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
console.log('total events:', events.length);

const span = (list, key = (e) => e.ts, end = (e) => e.ts + (e.dur || 0)) => {
  let t0 = Infinity; let t1 = -Infinity;
  for (const e of list) {
    const a = key(e); const b = end(e);
    if (!Number.isFinite(a)) continue;
    if (a < t0) t0 = a;
    if (b > t1) t1 = b;
  }
  return list.length ? +((t1 - t0) / 1e6).toFixed(2) : 0;
};

const withTs = events.filter((e) => Number.isFinite(e.ts) && e.ts > 0);
const complete = withTs.filter((e) => e.ph === 'X');
console.log('all events with ts   span:', span(withTs), 's  (n=' + withTs.length + ')');
console.log('ph=X (complete)      span:', span(complete), 's  (n=' + complete.length + ')');

// Phase mix -- which record types actually survived.
const byPh = {};
for (const e of withTs) byPh[e.ph] = (byPh[e.ph] || 0) + 1;
console.log('phase mix:', JSON.stringify(byPh));

// Per-thread span for the busiest threads. A ring-buffer overflow truncates
// every thread to roughly the same recent slice; a thread that simply stopped
// emitting shows a different pattern.
const procNames = {}; const threadNames = {};
for (const e of events) {
  if (e.name === 'process_name') procNames[e.pid] = e.args?.name;
  if (e.name === 'thread_name') threadNames[`${e.pid}:${e.tid}`] = e.args?.name;
}
const groups = new Map();
for (const e of complete) {
  const k = `${procNames[e.pid] || e.pid} / ${threadNames[`${e.pid}:${e.tid}`] || e.tid}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(e);
}
const rows = [...groups.entries()]
  .map(([k, list]) => {
    let busy = 0;
    for (const e of list) busy += e.dur || 0;
    return { k, n: list.length, span: span(list), busyS: +(busy / 1e6).toFixed(2) };
  })
  .sort((a, b) => b.n - a.n)
  .slice(0, 12);
console.log('\nthread                                              events    span(s)  busy(s)  busy%');
for (const r of rows) {
  const pct = r.span > 0 ? ((r.busyS / r.span) * 100).toFixed(1) : '-';
  console.log(
    r.k.padEnd(50).slice(0, 50),
    String(r.n).padStart(7),
    String(r.span).padStart(9),
    String(r.busyS).padStart(8),
    String(pct).padStart(6)
  );
}
