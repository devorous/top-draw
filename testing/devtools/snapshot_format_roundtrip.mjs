#!/usr/bin/env node
/**
 * @fileoverview Server checkpoint storage format check (Phase 1 of
 * docs/ddraw_server_snapshots_plan.md) — no R2/DB required.
 *
 *   1. encodeSnapshotFile -> decodeSnapshotFile('ddraw') round-trips layers +
 *      thumbnail exactly (the new write path server/snapshotCodec.js drives).
 *   2. decodeSnapshotFile(bytes, undefined) still decodes a legacy protobuf
 *      `SnapshotBundle` correctly (the dual-format read path room_snapshots
 *      docs without a `format` field, or `format: 'bundle'`, rely on).
 *
 * Run: node testing/devtools/snapshot_format_roundtrip.mjs
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import protobuf from 'protobufjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = path.resolve(HERE, '..', '..');

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function testNewFormat(encodeSnapshotFile, decodeSnapshotFile) {
  const layers = [
    new Uint8Array([1, 1, 2, 3, 5, 8, 13]),
    new Uint8Array([21, 34, 55]),
  ];
  const thumbnail = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // fake JPEG SOI/EOI

  const bytes = await encodeSnapshotFile(layers, thumbnail);
  const decoded = await decodeSnapshotFile(bytes, 'ddraw');

  assertEq(decoded.layers.length, 2, 'layers.length');
  for (let i = 0; i < layers.length; i++) {
    assertEq(
      Buffer.from(decoded.layers[i]).toString('hex'),
      Buffer.from(layers[i]).toString('hex'),
      `layers[${i}] bytes`
    );
  }
  assertEq(
    Buffer.from(decoded.thumbnail).toString('hex'),
    Buffer.from(thumbnail).toString('hex'),
    'thumbnail bytes'
  );

  // No-thumbnail path (persistRestoredCheckpoint always passes null).
  const bytesNoThumb = await encodeSnapshotFile(layers, null);
  const decodedNoThumb = await decodeSnapshotFile(bytesNoThumb, 'ddraw');
  assertEq(decodedNoThumb.layers.length, 2, 'no-thumb layers.length');
  assertEq(decodedNoThumb.thumbnail, null, 'no-thumb thumbnail');

  return { bytes: bytes.length };
}

async function testLegacyFormat(decodeSnapshotFile) {
  const root = await protobuf.load(path.join(ROOT, 'public', 'messages.proto'));
  const SnapshotBundle = root.lookupType('SnapshotBundle');

  const layers = [new Uint8Array([9, 9, 9]), new Uint8Array([4, 2])];
  const thumbnail = new Uint8Array([1, 2, 3]);
  const message = SnapshotBundle.create({ layers, thumbnail });
  const legacyBytes = SnapshotBundle.encode(message).finish();

  // Legacy docs have no `format` field at all — must decode via the same
  // undefined-format path decodeSnapshotFile dispatches on.
  const decoded = await decodeSnapshotFile(legacyBytes, undefined);
  assertEq(decoded.layers.length, 2, 'legacy layers.length');
  assertEq(
    Buffer.from(decoded.layers[0]).toString('hex'),
    Buffer.from(layers[0]).toString('hex'),
    'legacy layers[0] bytes'
  );
  assertEq(
    Buffer.from(decoded.thumbnail).toString('hex'),
    Buffer.from(thumbnail).toString('hex'),
    'legacy thumbnail bytes'
  );

  return { bytes: legacyBytes.length };
}

async function main() {
  const { encodeSnapshotFile, decodeSnapshotFile } = await import(
    pathToFileURL(path.join(ROOT, 'server', 'snapshotCodec.js')).href
  );

  let newOk = true;
  let newInfo = null;
  try {
    newInfo = await testNewFormat(encodeSnapshotFile, decodeSnapshotFile);
  } catch (err) {
    newOk = false;
    console.error('New .ddraw format round-trip failed:', err.message);
  }
  console.log(`${newOk ? '✅ PASS' : '❌ FAIL'}  encodeSnapshotFile -> decodeSnapshotFile('ddraw') (${newInfo ? newInfo.bytes + ' bytes' : 'n/a'})`);

  let legacyOk = true;
  let legacyInfo = null;
  try {
    legacyInfo = await testLegacyFormat(decodeSnapshotFile);
  } catch (err) {
    legacyOk = false;
    console.error('Legacy SnapshotBundle decode failed:', err.message);
  }
  console.log(`${legacyOk ? '✅ PASS' : '❌ FAIL'}  decodeSnapshotFile(legacyBytes, undefined) (${legacyInfo ? legacyInfo.bytes + ' bytes' : 'n/a'})`);

  const ok = newOk && legacyOk;
  console.log(ok ? '\n✅ snapshot format round-trip: PASS' : '\n❌ snapshot format round-trip: FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
