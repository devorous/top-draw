#!/usr/bin/env node
/**
 * @fileoverview Throwaway probe (not an npm script) — proves server/r2.js's
 * new byte-agnostic uploadSnapshotFile/getSnapshotFile/deleteSnapshotFile and
 * server/snapshotCodec.js actually round-trip against REAL infrastructure
 * (S3 SDK -> MinIO, real Mongo insert/read), not just in-process functions.
 * testing/devtools/snapshot_format_roundtrip.mjs already covers the pure
 * encode/decode logic with no I/O; this fills the gap.
 *
 * Writes under roomId '_phase1_probe' (never a real room) and cleans up after
 * itself (R2 object + Mongo doc deleted at the end, pass or fail).
 *
 * SAFETY: refuses to run unless MONGODB_URI/R2_ENDPOINT point at
 * localhost/127.0.0.1 — this must never touch production.
 *
 * Run with the same env as `npm run server:local`, e.g.:
 *   MONGODB_URI=mongodb://127.0.0.1:27017 MONGODB_DB_NAME=Draw \
 *   R2_ENDPOINT=http://127.0.0.1:9000 R2_ACCESS_KEY_ID=minioadmin R2_SECRET_ACCESS_KEY=minioadmin \
 *   R2_BUCKET_NAME=gallery R2_FORCE_PATH_STYLE=true \
 *   R2_SNAPSHOTS_BUCKET=snapshots R2_SNAPSHOTS_ACCESS_KEY_ID=minioadmin R2_SNAPSHOTS_SECRET_ACCESS_KEY=minioadmin \
 *   node testing/devtools/_phase1_r2_integration_probe.mjs
 */
import { MongoClient } from 'mongodb';

function requireLocalOnly() {
  const mongoUri = process.env.MONGODB_URI || '';
  const r2Endpoint = process.env.R2_ENDPOINT || '';
  const isLocalMongo = /127\.0\.0\.1|localhost/.test(mongoUri);
  const isLocalR2 = /127\.0\.0\.1|localhost/.test(r2Endpoint);
  if (!isLocalMongo || !isLocalR2) {
    console.error(`Refusing to run: MONGODB_URI="${mongoUri}" R2_ENDPOINT="${r2Endpoint}" must both be localhost/127.0.0.1.`);
    process.exit(2);
  }
}

async function main() {
  requireLocalOnly();

  const { uploadSnapshotFile, getSnapshotFile, deleteSnapshotFile } = await import('../../server/r2.js');
  const { encodeSnapshotFile, decodeSnapshotFile } = await import('../../server/snapshotCodec.js');

  const roomId = '_phase1_probe';
  const snapshotId = `probe_${Date.now()}`;
  const r2Key = `snapshots/${roomId}/${snapshotId}.ddraw`;

  const layers = [
    new Uint8Array(Array.from({ length: 5000 }, (_, i) => i % 256)), // fake QOI-ish payload
    new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256)),
  ];
  const thumbnail = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0xff, 0xd9]); // fake JPEG

  let mongoClient = null;
  let ok = true;

  try {
    console.log(`[Probe] encoding + uploading real .ddraw to MinIO: ${r2Key}`);
    const fileBytes = await encodeSnapshotFile(layers, thumbnail);
    console.log(`[Probe] encoded ${fileBytes.length} bytes`);
    await uploadSnapshotFile(r2Key, fileBytes);
    console.log('[Probe] upload OK');

    console.log('[Probe] downloading it back from MinIO...');
    const fetched = await getSnapshotFile(r2Key);
    if (!fetched) throw new Error('getSnapshotFile returned null — upload did not stick');
    console.log(`[Probe] fetched ${fetched.length} bytes (matches upload: ${fetched.length === fileBytes.length})`);

    const decoded = await decodeSnapshotFile(fetched, 'ddraw');
    if (decoded.layers.length !== 2) throw new Error(`expected 2 layers, got ${decoded.layers.length}`);
    for (let i = 0; i < layers.length; i++) {
      const a = Buffer.from(decoded.layers[i]).toString('hex');
      const b = Buffer.from(layers[i]).toString('hex');
      if (a !== b) throw new Error(`layer ${i} bytes mismatch after real R2 round-trip`);
    }
    const thumbHex = Buffer.from(decoded.thumbnail).toString('hex');
    if (thumbHex !== Buffer.from(thumbnail).toString('hex')) throw new Error('thumbnail bytes mismatch after real R2 round-trip');
    console.log('[Probe] R2 round-trip bytes verified exactly ✅');

    console.log('[Probe] inserting + reading back a real room_snapshots doc (format: ddraw)...');
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DB_NAME || 'Draw');
    await db.collection('room_snapshots').insertOne({
      snapshotId, roomId, timestamp: Date.now(), issuer: 'phase1-probe',
      auto: true, seq: 12345, thumbnail, r2Key, format: 'ddraw', name: 'Phase 1 integration probe',
    });
    const doc = await db.collection('room_snapshots').findOne({ roomId, snapshotId });
    if (!doc || doc.format !== 'ddraw' || doc.r2Key !== r2Key) throw new Error('Mongo doc did not round-trip as expected');
    console.log('[Probe] Mongo doc round-trip verified ✅');

    // Simulate exactly what handleSnapshotRestore/handleSnapshotGet/getLatestSnapshotData do.
    const fileBytes2 = await getSnapshotFile(doc.r2Key);
    const decoded2 = await decodeSnapshotFile(fileBytes2, doc.format);
    if (decoded2.layers.length !== 2) throw new Error('doc-driven fetch+decode did not reproduce the layers');
    console.log('[Probe] full doc-driven fetch -> decode (the real restore/get code path) verified ✅');
  } catch (err) {
    ok = false;
    console.error('[Probe] FAILED:', err.message);
  } finally {
    // Cleanup — never leave probe data behind.
    try { await deleteSnapshotFile(r2Key); console.log('[Probe] cleaned up R2 object'); } catch (e) { console.warn('[Probe] R2 cleanup failed:', e.message); }
    if (mongoClient) {
      try {
        const db = mongoClient.db(process.env.MONGODB_DB_NAME || 'Draw');
        await db.collection('room_snapshots').deleteMany({ roomId });
        console.log('[Probe] cleaned up Mongo doc(s)');
      } catch (e) { console.warn('[Probe] Mongo cleanup failed:', e.message); }
      await mongoClient.close();
    }
  }

  console.log(ok ? '\n✅ Phase 1 real-infrastructure round-trip: PASS' : '\n❌ Phase 1 real-infrastructure round-trip: FAIL');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
