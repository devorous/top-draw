#!/usr/bin/env node
/**
 * tape_compare.mjs — diff the .ddraw tapes recorded by several clients in the
 * same room, at the WIRE level rather than the pixel level.
 *
 *     node testing/devtools/tape_compare.mjs A.ddraw B.ddraw C.ddraw
 *     node testing/devtools/tape_compare.mjs captures/            # a whole dir
 *     node testing/devtools/tape_compare.mjs *.ddraw --baseline=A --verbose
 *
 * Capture the tapes by hand: in every window hit Record → Start, draw, then
 * Stop → Save. Every client must be recording over the same wall-clock window;
 * the tool clips the comparison to the overlap and tells you if there isn't one.
 *
 * WHY THIS AND NOT A PIXEL DIFF
 * -----------------------------
 * Two clients never render bit-identically — antialiasing, soft-brush falloff
 * and blend rounding drift a channel or two — so board_state_compare.py must
 * score agreement with a tolerance and can only conclude "close enough". A tape
 * holds the *input* to rendering: the exact message stream that client saw.
 * That admits an exact answer, and when it fails it names the message instead
 * of a bounding box.
 *
 * Read the two results together:
 *   tapes agree + pixels differ  → renderer/ordering bug inside one client
 *   tapes differ                 → transport bug (sanitizer, relay, handler);
 *                                  the pixel diff is just the symptom
 *
 * The oracle itself lives in testing/lib/tapeDiff.mjs so this CLI and the
 * concurrent-draw suite ship the same guarantee.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadTape, compareTapes, formatReport, WIRE_PRECISION } from '../lib/tapeDiff.mjs';

const USAGE = `
tape_compare.mjs — wire-level diff of .ddraw tapes recorded by several clients

  node testing/devtools/tape_compare.mjs <fileOrDir> [more...] [flags]

Flags
  --baseline=<label>     compare every tape against this one (default: first)
  --only-types=MD,MU     restrict the comparison to these message types
  --ignore-types=MM      exclude these types (MM is high-volume cursor noise
                         when you only care about commits)
  --late-join            don't clip to a wall-clock overlap. Use when one tape
                         is a LATE JOINER's: it tapes the room's command tail at
                         application time, not origin time, so a clip would
                         throw the whole tail away. The tail is meant to
                         reproduce the live stream, so compare it unclipped.
  --precision=<n>        decimal places floats are rounded to (default 1 —
                         the wire's own precision; see tapeDiff.WIRE_PRECISION)
  --max-diffs=<n>        stop printing a stream's diff after n entries
  --no-coverage          skip the per-type count table
  --json=<file>          also write the structured result
  -v, --verbose          print full payloads for differing messages
`;

function parseArgs(argv) {
  const opts = {
    inputs: [], baseline: null, verbose: false, maxDiffs: 25,
    precision: WIRE_PRECISION, ignoreTypes: new Set(), onlyTypes: null,
    showCoverage: true, json: null, help: false, clipToWindow: true
  };
  for (const arg of argv) {
    if (arg.startsWith('--baseline=')) opts.baseline = arg.slice(11);
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--no-coverage') opts.showCoverage = false;
    else if (arg === '--late-join') opts.clipToWindow = false;
    else if (arg.startsWith('--json=')) opts.json = arg.slice(7);
    else if (arg.startsWith('--max-diffs=')) opts.maxDiffs = Number(arg.slice(12));
    else if (arg.startsWith('--precision=')) opts.precision = Number(arg.slice(12));
    else if (arg.startsWith('--ignore-types=')) {
      for (const t of arg.slice(15).split(',')) opts.ignoreTypes.add(t.trim().toUpperCase());
    } else if (arg.startsWith('--only-types=')) {
      opts.onlyTypes = new Set(arg.slice(13).split(',').map((t) => t.trim().toUpperCase()));
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else opts.inputs.push(arg);
  }
  return opts;
}

function collectFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`no such file or directory: ${input}`);
    if (fs.statSync(resolved).isDirectory()) {
      for (const name of fs.readdirSync(resolved).sort()) {
        if (/\.(ddraw|json)$/i.test(name)) files.push(path.join(resolved, name));
      }
    } else {
      files.push(resolved);
    }
  }
  return files;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.inputs.length === 0) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }

  const files = collectFiles(opts.inputs);
  if (files.length < 2) {
    console.error(`Need at least 2 tapes to compare — found ${files.length}.`);
    process.exit(1);
  }

  const tapes = [];
  for (const file of files) tapes.push(await loadTape(file));

  const result = await compareTapes(tapes, {
    baselineLabel: opts.baseline,
    precision: opts.precision,
    ignoreTypes: opts.ignoreTypes,
    onlyTypes: opts.onlyTypes,
    clipToWindow: opts.clipToWindow
  });

  console.log(formatReport(result, {
    verbose: opts.verbose,
    maxDiffs: opts.maxDiffs,
    showCoverage: opts.showCoverage
  }));

  if (opts.json) {
    // Strip the event bodies — a structured dump of every canon payload is
    // enormous and the report already names what differs.
    const slim = {
      ...result,
      streams: result.streams.map((s) => ({
        ...s,
        ops: (s.ops ?? []).map((o) => ({ op: o.op, typeName: o.event.typeName, user: o.event.user, canon: o.event.canon }))
      })),
      seq: result.seq.map((s) => ({
        ...s,
        mismatches: s.mismatches.map((m) => ({ seq: m.seq, a: m.a.canon, b: m.b.canon }))
      }))
    };
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify(slim, null, 2));
    console.log(`\nStructured result → ${opts.json}`);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(2);
});
