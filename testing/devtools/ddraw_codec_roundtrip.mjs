#!/usr/bin/env node
/**
 * @fileoverview `.ddraw` codec cross-runtime round-trip check.
 *
 * `shared/ddrawCodec.js` moved out of `src/replay/` so the server (Node) can
 * decode the same bytes the client encodes, for the room_snapshots ->
 * `.ddraw` migration (docs/ddraw_server_snapshots_plan.md, Phase 0/1). This
 * is a plain-Node check — no dev server, no browser — that:
 *
 *   1. Node encode -> Node decode round-trips a synthetic recording exactly,
 *      including a Uint8Array payload (exercises the custom JSON
 *      replacer/reviver) and a Blob-backed visualCheckpoint thumbnail
 *      (exercises the blob section — this is what Phase 1's degenerate
 *      `.ddraw` uses for the checkpoint thumbnail).
 *   2. Node can decode a handful of *real*, browser-encoded `.ddraw` fixtures
 *      already checked into testing/ddraw/ (produced by the client's
 *      Recorder + this same codec) without throwing and with sane shape —
 *      proof the two runtimes agree on the wire format, not just that Node
 *      can round-trip its own output.
 *
 * Run: node testing/devtools/ddraw_codec_roundtrip.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = path.resolve(HERE, '..', '..');
const DDRAW_DIR = path.join(ROOT, 'testing', 'ddraw');

// Real fixtures produced by the browser Recorder in prior suite runs — a
// small, cheap sample is enough to prove cross-runtime compatibility.
const FIXTURE_SAMPLE = [
  'two-users.ddraw',
  'big.ddraw',
  'undo_after_snapshot_2026-06-15T00-28-38-660Z.ddraw',
];

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function testNodeRoundTrip(encodeDdraw, decodeDdraw) {
  const thumbBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const layerBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const recording = {
    startedAt: 1755273600000,
    duration: 12345,
    openingSnapshot: {
      layerBaked: [layerBytes],
      history: [],
    },
    deltas: [
      { t: 11, ts: 0, x: 100, y: 200, extra: { nested: layerBytes } },
      { t: 12, ts: 16, x: 101, y: 201 },
    ],
    visualCheckpoints: [
      { ts: 0, blob: new Blob([thumbBytes], { type: 'image/webp' }) },
    ],
  };

  const encoded = await encodeDdraw(recording);
  if (!(encoded instanceof Blob)) throw new Error('encodeDdraw did not return a Blob under Node');
  const bytes = Buffer.from(await encoded.arrayBuffer());

  const decoded = await decodeDdraw(bytes);

  assertEq(decoded.startedAt, recording.startedAt, 'startedAt');
  assertEq(decoded.duration, recording.duration, 'duration');
  if (!(decoded.openingSnapshot.layerBaked[0] instanceof Uint8Array)) {
    throw new Error('layerBaked[0] did not decode back to a Uint8Array');
  }
  assertEq(
    Buffer.from(decoded.openingSnapshot.layerBaked[0]).toString('hex'),
    Buffer.from(layerBytes).toString('hex'),
    'layerBaked bytes'
  );
  assertEq(decoded.deltas.length, 2, 'deltas.length');
  if (!(decoded.deltas[0].extra.nested instanceof Uint8Array)) {
    throw new Error('nested Uint8Array inside deltas did not survive replacer/reviver');
  }
  assertEq(
    Buffer.from(decoded.deltas[0].extra.nested).toString('hex'),
    Buffer.from(layerBytes).toString('hex'),
    'nested Uint8Array bytes'
  );

  if (decoded.visualCheckpoints.length !== 1) {
    throw new Error(`expected 1 visualCheckpoint, got ${decoded.visualCheckpoints.length}`);
  }
  const decodedBlob = decoded.visualCheckpoints[0].blob;
  if (!(decodedBlob instanceof Blob)) throw new Error('visualCheckpoint blob did not decode back to a Blob');
  const decodedThumbBytes = new Uint8Array(await decodedBlob.arrayBuffer());
  assertEq(
    Buffer.from(decodedThumbBytes).toString('hex'),
    Buffer.from(thumbBytes).toString('hex'),
    'thumbnail blob bytes'
  );

  return { encodedSize: bytes.length };
}

async function testRealFixtures(decodeDdraw) {
  const results = [];
  for (const name of FIXTURE_SAMPLE) {
    const file = path.join(DDRAW_DIR, name);
    if (!fs.existsSync(file)) {
      results.push({ name, skipped: true });
      continue;
    }
    const bytes = new Uint8Array(fs.readFileSync(file));
    const recording = await decodeDdraw(bytes);
    if (!recording || typeof recording !== 'object') {
      throw new Error(`${name}: decode did not return an object`);
    }
    const deltaCount = Array.isArray(recording.deltas) ? recording.deltas.length : 0;
    results.push({ name, bytes: bytes.length, deltas: deltaCount, skipped: false });
  }
  return results;
}

async function main() {
  const { encodeDdraw, decodeDdraw } = await import(
    pathToFileURL(path.join(ROOT, 'shared', 'ddrawCodec.js')).href
  );

  let roundTripOk = true;
  let roundTripInfo = null;
  try {
    roundTripInfo = await testNodeRoundTrip(encodeDdraw, decodeDdraw);
  } catch (err) {
    roundTripOk = false;
    console.error('Node encode -> Node decode round-trip failed:', err.message);
  }
  console.log(
    `${roundTripOk ? '✅ PASS' : '❌ FAIL'}  Node encode -> Node decode ` +
      (roundTripInfo ? `(${roundTripInfo.encodedSize} bytes)` : '')
  );

  let fixturesOk = true;
  let fixtureResults = [];
  try {
    fixtureResults = await testRealFixtures(decodeDdraw);
  } catch (err) {
    fixturesOk = false;
    console.error('Browser-encoded fixture decode failed:', err.message);
  }
  for (const r of fixtureResults) {
    if (r.skipped) {
      console.log(`  (skip) ${r.name} — fixture not found`);
    } else {
      console.log(`  ✅ ${r.name}  ${r.bytes} bytes, ${r.deltas} deltas`);
    }
  }
  console.log(
    `${fixturesOk ? '✅ PASS' : '❌ FAIL'}  Browser-encoded fixtures decode cleanly under Node`
  );

  const ok = roundTripOk && fixturesOk;
  console.log(ok ? '\n✅ ddraw codec round-trip: PASS' : '\n❌ ddraw codec round-trip: FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
