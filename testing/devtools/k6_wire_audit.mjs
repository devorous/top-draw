#!/usr/bin/env node
/**
 * @fileoverview Static harness-fidelity audit. Two questions, both answered
 * without a server or a browser in ~50ms:
 *
 *   1. Does the k6 bot traffic look like real client traffic?
 *   2. Does the pixel oracle still delegate to the product's compositor?
 *
 * Both exist because the same failure mode bit twice: a harness that quietly
 * disagrees with the product reports GREEN, because it disagrees with it
 * consistently on every client at once.
 *
 * Every pixel/tape result in this tree is only as good as the premise that the
 * bots send what a human's browser sends. Nothing checked that premise, and it
 * turned out to be false in several places at once — a feed can send a field the
 * client silently ignores and every suite still reports green, because the bots
 * and the observers agree with each other about a message that does nothing.
 *
 * Four checks, all static:
 *
 *   1. T enum agreement       — testing/_k6_actions.js vs shared/MessageTypes.js
 *   2. Field-name agreement   — for each message type the helpers build, the
 *                               field names must be ones the client actually
 *                               reads for that type in WebSocketClient.js
 *   3. Encoder coverage       — every field name the helpers emit must be known
 *                               to _k6_proto.js buildMsg, or it is dropped on
 *                               the floor before it reaches the wire
 *   4. Oracle self-check      — testing/lib/layerDiff.mjs must call
 *                               compositeLayerRange rather than re-implementing
 *                               the compositor (it drifted twice when it did)
 *
 * Check 2 is the one that earned this file: `CSDM` was being sent with the
 * payload in `g`, while the client reads `data.sdm`. Shape draw mode had
 * therefore never been exercised by any k6 run, and the suites could not tell,
 * because a mode nobody applies is a mode everybody agrees on.
 *
 *   node testing/devtools/k6_wire_audit.mjs
 *   npm run test:k6audit
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const problems = [];
const notes = [];

// ── 1. T enum agreement ─────────────────────────────────────────────────────

function parseEnum(txt, declRe) {
  const m = txt.match(declRe);
  if (!m) return null;
  const out = {};
  for (const p of m[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) out[p[1]] = Number(p[2]);
  return out;
}

const realT = parseEnum(read('shared/MessageTypes.js'), /export const T\s*=\s*\{([\s\S]*?)\n\};/);
const k6T = parseEnum(read('testing/_k6_actions.js'), /export const T\s*=\s*\{([\s\S]*?)\n\};/);

if (!realT || !k6T) {
  problems.push('could not parse one of the T enums (shape changed?)');
} else {
  for (const [name, val] of Object.entries(k6T)) {
    if (realT[name] === undefined) problems.push(`T.${name}=${val} exists in k6 helpers but not in shared/MessageTypes.js`);
    else if (realT[name] !== val) problems.push(`T.${name}: k6 says ${val}, shared/MessageTypes.js says ${realT[name]}`);
  }
  notes.push(`T enum: ${Object.keys(k6T).length} k6 constants checked against ${Object.keys(realT).length} real ones`);
}

// ── 2. Field-name agreement, per message type ───────────────────────────────
//
// Parsed from the client's own decode switch: for `case T.X:` collect every
// `data.<field>` it reads before the next `case`. That is, by construction, the
// complete set of fields that can possibly affect a receiver for that type —
// anything else a bot sends is inert.

const wsClient = read('src/network/WebSocketClient.js');

/**
 * Per-type field reads from a `case T.X:` dispatch.
 *
 * Fall-through matters: in
 *
 *     case T.MU:
 *     case T.CLR:
 *     case T.CANCEL: { …reads data.foo… }
 *
 * the slice belonging to `T.MU` is empty, and treating that as "MU reads
 * nothing" would flag every field sent on an MU. Empty bodies therefore inherit
 * the next non-empty one, which is what fall-through actually means.
 *
 * @param {string} src        file contents
 * @param {string[]} varNames message-object identifiers to look for (`data`, `msg`, …)
 */
function readsByType(src, varNames = ['data']) {
  const marks = [...src.matchAll(/case T\.([A-Z_0-9]+):/g)].map((m) => ({ type: m[1], at: m.index }));
  const raw = [];
  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    const fields = new Set();
    for (const v of varNames) {
      for (const f of body.matchAll(new RegExp(`\\b${v}\\??\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) fields.add(f[1]);
    }
    raw.push({ type: marks[i].type, fields, empty: fields.size === 0 });
  }
  // Walk backwards so an empty (fall-through) case adopts the block it falls into.
  let carry = new Set();
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i].empty) raw[i].fields = new Set(carry);
    else carry = raw[i].fields;
  }
  const map = {};
  for (const r of raw) map[r.type] = new Set([...(map[r.type] || []), ...r.fields]);
  return map;
}

function clientReadsByType() {
  return readsByType(wsClient, ['data']);
}

// What the helpers build, per type: scan buildMsg({...}) literals for `t: T.X`
// and collect the sibling keys.
function k6SendsByType(file) {
  const txt = read(file);
  const map = {};
  for (const m of txt.matchAll(/buildMsg\(\s*(\{[\s\S]*?\})\s*\)/g)) {
    const lit = m[1];
    const tm = lit.match(/\bt:\s*T\.([A-Z_0-9]+)/);
    if (!tm) continue;
    const type = tm[1];
    const fields = new Set();
    // Top-level keys only; good enough for these flat literals.
    for (const k of lit.matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) fields.add(k[1]);
    fields.delete('t');
    map[type] = new Set([...(map[type] || []), ...fields]);
  }
  // Also catch the `const msg = {...}` + `msg.x = ...` construction style.
  for (const m of txt.matchAll(/const (msg|ct|m)\s*=\s*\{([\s\S]*?)\};([\s\S]{0,900})/g)) {
    const tm = m[2].match(/\bt:\s*T\.([A-Z_0-9]+)/);
    if (!tm) continue;
    const type = tm[1];
    const fields = new Set(map[type] || []);
    for (const k of m[2].matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) fields.add(k[1]);
    const varName = m[1];
    for (const k of m[3].matchAll(new RegExp(`\\b${varName}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=`, 'g'))) fields.add(k[1]);
    fields.delete('t');
    map[type] = fields;
  }
  return map;
}

// Fields that are meaningful without appearing as `data.<x>` in the decode
// switch: the transport/base layer consumes them, not the per-type case.
const UNIVERSAL = new Set([
  'u',    // session index — read generically as data.u by every case
  'seq',  // server-assigned
  'strokeTs', // latency instrumentation only, stripped before handlers
]);

// A helper's key is NOT the wire name. `buildMsg` maps its own key (often
// snake_case, matching the .proto) to a field NUMBER, and protobufjs then
// surfaces that number to the client under the proto field's camelCase name —
// so `text_id` on the helper side is `data.textId` on the client side and the
// two are the same field. Comparing the raw keys reports every snake_case field
// as a mismatch, which is noise that buries the real ones.
function helperKeyToFieldNumber() {
  const map = {};
  // The value argument is sometimes wrapped (`String(fields.text_id)`), so skip
  // over any wrapper before the `fields.` reference.
  for (const m of protoSrcForMap.matchAll(/push\w+\(parts,\s*(\d+),\s*(?:[A-Za-z_$][\w$]*\()?\s*fields\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    map[m[2]] = Number(m[1]);
  }
  return map;
}

/** field number -> camelCase JS name, for the TOP-LEVEL Msg fields only. */
function protoNumberToJsName() {
  const src = read('public/messages.proto');
  const start = src.indexOf('message Msg {');
  const out = {};
  let depth = 0;
  for (const line of src.slice(start).split('\n')) {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    // Only take fields at depth 1 — nested messages (U, tiles, …) restart
    // numbering and would otherwise overwrite real Msg entries.
    if (depth === 1) {
      const f = line.match(/^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)\s*;/);
      if (f) out[Number(f[2])] = f[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    }
    depth += opens - closes;
  }
  return out;
}

// ReplayEngine has its OWN per-type switch and reads fields straight off the
// raw message (`msg?.cbt`), so a field absent from the live decode switch can
// still be load-bearing — for replay, which is half of what these suites
// measure. This must stay per-type: a global "does ReplayEngine mention this
// field anywhere" set excuses everything, because short names like `c` and `s`
// appear under some type or other. That leniency hid the real FILL finding on
// the first pass of this audit.
function replayReadsByType() {
  const txt = read('src/timebar/ReplayEngine.js');
  const map = {};
  const marks = [...txt.matchAll(/case T\.([A-Z_0-9]+):/g)].map((m) => ({ type: m[1], at: m.index }));
  for (let i = 0; i < marks.length; i++) {
    const body = txt.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : txt.length);
    const fields = new Set(map[marks[i].type] || []);
    for (const f of body.matchAll(/\bmsg\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) fields.add(f[1]);
    map[marks[i].type] = fields;
  }
  // Helpers called from those cases (e.g. the selection-corner reader) live
  // outside the switch; fold their reads into every type rather than lose them.
  const shared = new Set();
  for (const f of txt.matchAll(/_ensureArray\(msg\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) shared.add(f[1]);
  return { map, shared };
}

const protoSrcForMap = read('testing/_k6_proto.js');
const keyToNum = helperKeyToFieldNumber();
const numToJs = protoNumberToJsName();
const { map: replayByType, shared: replaySharedReads } = replayReadsByType();

/**
 * What the SERVER reads, per message type — for client→server-only fields whose
 * consumer is the server, like CONNECT's username.
 *
 * Per-type, not a global set, for exactly the reason the ReplayEngine check is:
 * a global "does the server mention this field anywhere" set forgives
 * everything. `g` alone is read server-side under a dozen types, so a global set
 * silently excused `CSDM {g: mode}` — the very bug this tool exists to catch.
 * Confirmed by reintroducing that bug and checking the audit fails; it did not,
 * until this became per-type.
 */
const serverReadsByType = (() => {
  const map = {};
  for (const rel of ['server/index.js', 'server/validation.js', 'server/SessionManager.js', 'server/StrokeTape.js']) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    for (const [type, fields] of Object.entries(readsByType(read(rel), ['data', 'msg', 'decoded']))) {
      map[type] = new Set([...(map[type] || []), ...fields]);
    }
  }
  return map;
})();

// Every file that builds wire messages, not just the shared helpers — the
// per-suite feeds compose their own step objects and can drift independently.
const SOURCES = [
  'testing/_k6_actions.js',
  'testing/low_stress_test.js',
  'testing/devtools/_k6_edge_feed.js',
  'testing/devtools/_k6_ddraw_feed.js',
  'testing/devtools/_k6_confetti_feed.js',
];

const reads = clientReadsByType();
const sends = {};
for (const src of SOURCES) {
  if (!fs.existsSync(path.join(ROOT, src))) continue;
  for (const [type, fields] of Object.entries(k6SendsByType(src))) {
    sends[type] = new Set([...(sends[type] || []), ...fields]);
  }
}
notes.push(`sources: ${SOURCES.filter((s) => fs.existsSync(path.join(ROOT, s))).length} k6 files scanned`);

for (const [type, fields] of Object.entries(sends)) {
  const known = reads[type];
  if (!known) {
    notes.push(`(no decode case found for T.${type} — server-consumed or relay-only, skipped)`);
    continue;
  }
  for (const f of fields) {
    const num = keyToNum[f];
    const js = num !== undefined ? (numToJs[num] ?? f) : f;
    if (UNIVERSAL.has(js) || UNIVERSAL.has(f)) continue;
    if (known.has(js) || known.has(f)) continue;
    const rep = replayByType[type];
    if ((rep && (rep.has(js) || rep.has(f))) || replaySharedReads.has(js)) {
      notes.push(`T.${type}.${f} → data.${js}: not read live, but ReplayEngine's case T.${type} reads it (replay-only field)`);
      continue;
    }
    // Some types are client→SERVER only (CONNECT's username, for one), so the
    // consumer is the server and the client's decode switch legitimately never
    // reads the field. Checking only the client would report those as dead.
    const srv = serverReadsByType[type];
    if (srv && (srv.has(js) || srv.has(f))) {
      notes.push(`T.${type}.${f} → data.${js}: consumed server-side, not by the client (outbound-only field)`);
      continue;
    }
    problems.push(
      `T.${type}: bots send '${f}' (field ${num ?? '?'} → data.${js}), but neither `
      + `WebSocketClient's case T.${type} nor ReplayEngine ever reads it `
      + `(case reads: ${[...known].filter((x) => !UNIVERSAL.has(x)).sort().join(', ') || 'nothing'})`
    );
  }
}

// ── 3. Encoder coverage ─────────────────────────────────────────────────────

const encoderKnows = new Set([...protoSrcForMap.matchAll(/fields\.([A-Za-z_][A-Za-z0-9_]*)\s*!==\s*undefined/g)].map((m) => m[1]));
const allSent = new Set();
for (const fields of Object.values(sends)) for (const f of fields) allSent.add(f);
for (const f of allSent) {
  if (f === 't') continue;
  if (!encoderKnows.has(f)) {
    problems.push(`field '${f}' is set by an action helper but buildMsg() in _k6_proto.js does not encode it — it never reaches the wire`);
  }
}
notes.push(`encoder: ${encoderKnows.size} field names supported by buildMsg`);

// ── 4. Oracle self-check: layerDiff must not re-hand-roll the compositor ────
//
// Both bugs ever found in the pixel oracle came from the same root: it contained
// a SECOND implementation of the compositor, which drifted from the real one
// silently and only on paths nothing exercised (it sorted the live stack by
// `timestamp` instead of `seq`, and it never read `bakedSequences` at all, so a
// fully-compressed layer looked empty and two boards "agreed" on a layer neither
// was comparing). It now calls `compositeLayerRange`, the same entry point
// `Board.compositeAllLayers` uses.
//
// This is a cheap guard against that regressing: the capture must call the
// product's compositor, and must not walk `strokeStack` drawing canvases itself.

const oracleSrc = read('testing/lib/layerDiff.mjs');
const CAPTURES = ['captureLayerSnapshotsInPage', 'captureReplayLayerSnapshotsInPage'];

// One `compositeLayerRange` call per capture function, plus the whole-board one.
const compositeCalls = (oracleSrc.match(/compositeLayerRange\(/g) || []).length;
if (compositeCalls < CAPTURES.length) {
  problems.push(
    `layerDiff.mjs calls compositeLayerRange ${compositeCalls}x but has ${CAPTURES.length} capture `
    + `functions — a capture that does not call the product compositor is re-deriving it`
  );
} else {
  notes.push(`oracle: ${compositeCalls} compositeLayerRange call(s) — capture delegates to the product`);
}

// The tell-tale of a hand-rolled composite: iterating the stroke stack and
// drawing each stroke's canvas. `layerStructure` legitimately READS the stack to
// report it, so only flag drawing.
if (/for\s*\(\s*const\s+\w+\s+of\s+sorted\s*\)[\s\S]{0,200}drawImage\(/.test(oracleSrc)) {
  problems.push(
    'layerDiff.mjs draws strokeStack entries itself — that is a second compositor, '
    + 'and it has silently drifted from the real one twice. Call compositeLayerRange.'
  );
}

// `bakedSequences` must be considered when deciding a group is empty, or a fully
// compressed layer is skipped and scores a meaningless 100%.
if (!/bakedSequences/.test(oracleSrc)) {
  problems.push(
    'layerDiff.mjs never mentions bakedSequences — a layer whose strokes were all '
    + 'compressed by _compressStrokesToGroup will look empty and be skipped'
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log('\nHarness fidelity audit — bots speak the protocol, oracle uses the compositor\n');
for (const n of notes) console.log(`  · ${n}`);
console.log('');
if (problems.length === 0) {
  console.log('  ✅ every field the bots send is one the client reads, and the pixel');
  console.log('     oracle delegates to the product compositor.\n');
  process.exitCode = 0;
} else {
  for (const p of problems) console.log(`  ❌ ${p}`);
  console.log(`\n  ${problems.length} problem(s). Every one of these fails SILENTLY: a bot field the`);
  console.log(`  client ignores, or an oracle that disagrees with the renderer, is wrong`);
  console.log(`  identically on every client — so the suites report agreement, not failure.\n`);
  process.exitCode = 1;
}
