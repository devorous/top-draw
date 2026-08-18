#!/usr/bin/env node
/**
 * @fileoverview Move gallery time-lapse clips out of the images bucket into the
 * dedicated time-lapse bucket, rewriting the URLs the gallery docs point at.
 *
 * Clips were originally written alongside the stills in R2_BUCKET_NAME. They now
 * belong in R2_TIMELAPSE_BUCKET, served from R2_TIMELAPSE_PUBLIC_URL. A
 * clip's key encodes the owning gallery item's ObjectId, so the mapping is
 * `<id>_timelapse*.webm` in the old bucket -> the same key in the new one.
 *
 * Order matters: copy, verify the copy by size, rewrite Mongo, and only then
 * delete the source. A crash at any point leaves the site serving a real object
 * — either the old URL (not yet rewritten) or the new one (already copied).
 * Re-running is safe; already-migrated items are skipped.
 *
 *   npm run migrate:timelapses                       # dry run, changes nothing
 *   npm run migrate:timelapses -- --apply            # copy + rewrite + delete
 *   npm run migrate:timelapses -- --apply --keep-source   # leave originals
 *   npm run migrate:timelapses -- --apply --orphans       # also move unreferenced clips
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';
import {
  S3Client, ListObjectsV2Command, GetObjectCommand,
  PutObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';

const APPLY = process.argv.includes('--apply');
const KEEP_SOURCE = process.argv.includes('--keep-source');
const MOVE_ORPHANS = process.argv.includes('--orphans');

const SRC_BUCKET = process.env.R2_BUCKET_NAME || 'gallery';
const DST_BUCKET = process.env.R2_TIMELAPSE_BUCKET;
const DST_PUBLIC = (process.env.R2_TIMELAPSE_PUBLIC_URL || '').replace(/\/$/, '');

/** Build a client from a `R2_`/`R2_TIMELAPSE_` credential prefix, matching server/gallery.js. */
function client(prefix) {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env[`${prefix}ACCESS_KEY_ID`] || process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env[`${prefix}SECRET_ACCESS_KEY`]
        || process.env[`${prefix}SECRET_KEY`]
        || process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
}

const kb = (n) => `${(n / 1024).toFixed(1)}kb`;

async function collect(s3, Bucket) {
  const out = [];
  let ContinuationToken;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    out.push(...(r.Contents || []));
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

async function main() {
  if (!DST_BUCKET) throw new Error('R2_TIMELAPSE_BUCKET is not set');
  if (!DST_PUBLIC) throw new Error('R2_TIMELAPSE_PUBLIC_URL is not set');
  if (DST_BUCKET === SRC_BUCKET) throw new Error('Destination bucket matches the source bucket');

  const src = client('R2_');
  const dst = client('R2_TIMELAPSE_');

  const mongo = new MongoClient(process.env.MONGODB_URI);
  await mongo.connect();
  const gallery = mongo.db(process.env.MONGODB_DB || 'Draw').collection('gallery');

  const objects = (await collect(src, SRC_BUCKET)).filter((o) => /_timelapse.*\.webm$/i.test(o.Key));
  const docs = await gallery
    .find({ animatedUrl: { $exists: true, $ne: null } }, { projection: { animatedUrl: 1 } })
    .toArray();

  // Key -> doc, for the clips something actually points at.
  const byKey = new Map();
  for (const d of docs) byKey.set(d.animatedUrl.split('/').pop(), d);

  const planned = [];
  const orphans = [];
  for (const o of objects) {
    const doc = byKey.get(o.Key);
    if (doc) planned.push({ ...o, doc });
    else orphans.push(o);
  }

  // Docs already pointing at the new host need no work; docs pointing at a key
  // that isn't in the source bucket are broken and must not be rewritten.
  const alreadyMoved = docs.filter((d) => d.animatedUrl.startsWith(`${DST_PUBLIC}/`));
  const srcKeys = new Set(objects.map((o) => o.Key));
  const dangling = docs.filter(
    (d) => !d.animatedUrl.startsWith(`${DST_PUBLIC}/`) && !srcKeys.has(d.animatedUrl.split('/').pop())
  );

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}  ${SRC_BUCKET} -> ${DST_BUCKET}  (${DST_PUBLIC})`);
  console.log(`  clips in source bucket : ${objects.length}`);
  console.log(`  referenced by a doc    : ${planned.length}`);
  console.log(`  unreferenced (orphans) : ${orphans.length}${MOVE_ORPHANS ? ' — will move' : ' — will skip'}`);
  console.log(`  already on new host    : ${alreadyMoved.length}`);
  if (dangling.length) {
    console.log(`  DANGLING refs (no object, left alone): ${dangling.length}`);
    for (const d of dangling) console.log(`    ${d._id} -> ${d.animatedUrl}`);
  }
  console.log('');

  const queue = MOVE_ORPHANS ? [...planned, ...orphans.map((o) => ({ ...o, doc: null }))] : planned;
  let copied = 0;
  let bytes = 0;

  for (const entry of queue) {
    const tag = entry.doc ? String(entry.doc._id) : 'orphan';
    if (!APPLY) {
      console.log(`  would move ${entry.Key} (${kb(entry.Size)}) [${tag}]`);
      continue;
    }

    // 1. Copy. CopyObject can't cross credentials, so stream it through here.
    const got = await src.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: entry.Key }));
    const body = Buffer.from(await got.Body.transformToByteArray());
    await dst.send(new PutObjectCommand({
      Bucket: DST_BUCKET,
      Key: entry.Key,
      Body: body,
      ContentType: 'video/webm',
      CacheControl: 'public, max-age=31536000, immutable',
    }));

    // 2. Verify before anything becomes irreversible.
    const head = await dst.send(new HeadObjectCommand({ Bucket: DST_BUCKET, Key: entry.Key }));
    if (head.ContentLength !== entry.Size) {
      console.error(`  FAIL ${entry.Key}: copied ${head.ContentLength} != source ${entry.Size}, stopping`);
      break;
    }

    // 3. Point the doc at the new host.
    if (entry.doc) {
      await gallery.updateOne(
        { _id: entry.doc._id },
        { $set: { animatedUrl: `${DST_PUBLIC}/${entry.Key}` } }
      );
    }

    // 4. Source is now safe to drop.
    if (!KEEP_SOURCE) {
      await src.send(new DeleteObjectCommand({ Bucket: SRC_BUCKET, Key: entry.Key }));
    }

    copied += 1;
    bytes += entry.Size;
    console.log(`  moved ${entry.Key} (${kb(entry.Size)}) [${tag}]`);
  }

  console.log('');
  console.log(APPLY
    ? `Moved ${copied} clip(s), ${kb(bytes)}${KEEP_SOURCE ? ' (sources kept)' : ''}.`
    : `Would move ${queue.length} clip(s). Re-run with --apply.`);

  await mongo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
