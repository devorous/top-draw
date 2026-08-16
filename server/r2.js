// server/r2.js
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from 'buffer'; // Node.js Buffer is globally available
import protobuf from 'protobufjs';

// Only needed to read pre-migration `.bundle` objects still sitting in R2 —
// see decodeLegacyBundle below and docs/ddraw_server_snapshots_plan.md.
const root = await protobuf.load("public/messages.proto");
const SnapshotBundle = root.lookupType("SnapshotBundle");

const SNAPSHOT_ENDPOINT = process.env.R2_ENDPOINT || '';
const SNAPSHOT_ACCESS_KEY_ID =
  process.env.R2_SNAPSHOTS_ACCESS_KEY_ID ||
  process.env.R2_ACCESS_KEY_ID ||
  '';
const SNAPSHOT_SECRET_ACCESS_KEY =
  process.env.R2_SNAPSHOTS_SECRET_ACCESS_KEY ||
  process.env.R2_SNAPSHOTS_SECRET_KEY ||
  process.env.R2_SECRET_ACCESS_KEY ||
  '';
const BUCKET_NAME =
  process.env.R2_SNAPSHOTS_BUCKET ||
  process.env.R2_BUCKET_NAME ||
  '';

const hasSnapshotStorageConfig = Boolean(
  SNAPSHOT_ENDPOINT &&
  BUCKET_NAME &&
  SNAPSHOT_ACCESS_KEY_ID &&
  SNAPSHOT_SECRET_ACCESS_KEY
);

if (!hasSnapshotStorageConfig) {
  const missing = [
    !SNAPSHOT_ENDPOINT && 'R2_ENDPOINT',
    !BUCKET_NAME && 'R2_SNAPSHOTS_BUCKET',
    !SNAPSHOT_ACCESS_KEY_ID && 'R2_SNAPSHOTS_ACCESS_KEY_ID',
    !SNAPSHOT_SECRET_ACCESS_KEY && 'R2_SNAPSHOTS_SECRET_KEY',
  ].filter(Boolean);
  console.warn(`[R2] Snapshot storage is not fully configured. Missing: ${missing.join(', ')}`);
}

const r2Client = hasSnapshotStorageConfig
  ? new S3Client({
      region: "auto",
      endpoint: SNAPSHOT_ENDPOINT,
      credentials: {
        accessKeyId: SNAPSHOT_ACCESS_KEY_ID,
        secretAccessKey: SNAPSHOT_SECRET_ACCESS_KEY,
      },
    })
  : null;

function requireSnapshotClient() {
  if (!r2Client) {
    throw new Error('Snapshot R2 storage is not configured. Set R2_ENDPOINT, R2_SNAPSHOTS_BUCKET, and snapshot or default R2 credentials.');
  }
  return r2Client;
}

/**
 * Uploads a snapshot file (raw bytes — a `.ddraw` container, format-agnostic)
 * to Cloudflare R2.
 * @param {string} r2Key - The object key (e.g., 'snapshots/roomId/snapshotId.ddraw').
 * @param {Uint8Array|Buffer} bytes - The encoded file bytes.
 * @returns {Promise<void>}
 */
export async function uploadSnapshotFile(r2Key, bytes) {
  const params = {
    Bucket: BUCKET_NAME,
    Key: r2Key,
    Body: Buffer.from(bytes),
    ContentType: 'application/x-ddraw-replay',
  };

  try {
    await requireSnapshotClient().send(new PutObjectCommand(params));
  } catch (error) {
    console.error(`Error uploading snapshot file to R2 (${r2Key}):`, error);
    throw error; // Re-throw to indicate failure
  }
}

/**
 * Retrieves a snapshot file's raw bytes from Cloudflare R2. Caller decodes —
 * this function doesn't know or care whether the bytes are `.ddraw` or a
 * legacy `.bundle` (see decodeLegacyBundle).
 * @param {string} r2Key - The object key for the snapshot file.
 * @returns {Promise<Buffer|null>} The raw bytes, or null if not found.
 */
export async function getSnapshotFile(r2Key) {
  const params = {
    Bucket: BUCKET_NAME,
    Key: r2Key,
  };

  try {
    const command = new GetObjectCommand(params);
    const { Body } = await requireSnapshotClient().send(command);

    if (!Body) {
      console.warn(`Snapshot file not found in R2: ${r2Key}`);
      return null;
    }

    const chunks = [];
    for await (const chunk of Body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      console.warn(`Snapshot file not found in R2 (NoSuchKey): ${r2Key}`);
      return null;
    }
    console.error(`Error retrieving snapshot file from R2 (${r2Key}):`, error);
    throw error; // Re-throw to indicate failure
  }
}

/**
 * Decodes a legacy protobuf `SnapshotBundle` (`.bundle`, pre-migration
 * format). Read-only — nothing writes this format anymore. See
 * docs/ddraw_server_snapshots_plan.md.
 * @param {Buffer|Uint8Array} bytes
 * @returns {{layers: Uint8Array[], thumbnail: Uint8Array|null}}
 */
export function decodeLegacyBundle(bytes) {
  return SnapshotBundle.toObject(SnapshotBundle.decode(bytes));
}

/**
 * Deletes a snapshot file from Cloudflare R2.
 * @param {string} r2Key - The object key for the snapshot file.
 * @returns {Promise<void>}
 */
export async function deleteSnapshotFile(r2Key) {
  if (!r2Key) return;

  const params = {
    Bucket: BUCKET_NAME,
    Key: r2Key,
  };

  try {
    await requireSnapshotClient().send(new DeleteObjectCommand(params));
  } catch (error) {
    console.error(`Error deleting snapshot file from R2 (${r2Key}):`, error);
    throw error;
  }
}
