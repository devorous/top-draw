import 'dotenv/config';
import { connectDB } from '../db.js';

function parseArgs(argv) {
  const args = { dryRun: false, roomId: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--room') {
      args.roomId = argv[i + 1] || null;
      i += 1;
    }
  }

  return args;
}

const { dryRun, roomId } = parseArgs(process.argv.slice(2));
const db = await connectDB();
const noR2Key = { $or: [{ r2Key: { $exists: false } }, { r2Key: null }, { r2Key: '' }] };
const skipInitial = { initial: { $ne: true } };
const filter = roomId
  ? { roomId, ...noR2Key, ...skipInitial }
  : { ...noR2Key, ...skipInitial };

const legacyDocs = await db.collection('room_snapshots')
  .find(filter)
  .project({ _id: 1, roomId: 1, snapshotId: 1, timestamp: 1 })
  .toArray();

if (legacyDocs.length === 0) {
  console.log('[Snapshot Cleanup] No legacy snapshots without r2Key were found.');
  process.exit(0);
}

console.log(`[Snapshot Cleanup] Found ${legacyDocs.length} legacy snapshot(s) without r2Key.`);
for (const doc of legacyDocs) {
  console.log(`- room=${doc.roomId} snapshot=${doc.snapshotId} timestamp=${doc.timestamp}`);
}

if (dryRun) {
  console.log('[Snapshot Cleanup] Dry run only; no documents deleted.');
  process.exit(0);
}

const result = await db.collection('room_snapshots').deleteMany({ _id: { $in: legacyDocs.map((doc) => doc._id) } });
console.log(`[Snapshot Cleanup] Deleted ${result.deletedCount} legacy snapshot(s).`);
