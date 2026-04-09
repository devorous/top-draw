// server/r2.js
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Buffer } from 'buffer'; // Node.js Buffer is globally available
import protobuf from 'protobufjs';

const root = await protobuf.load("public/messages.proto");
const SnapshotBundle = root.lookupType("SnapshotBundle");

// Initialize S3 client for Cloudflare R2
const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_SNAPSHOTS_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SNAPSHOTS_SECRET_KEY,
  },
});

const BUCKET_NAME = process.env.R2_SNAPSHOTS_BUCKET;

/**
 * Uploads a snapshot bundle to Cloudflare R2.
 * @param {string} r2Key - The object key for the snapshot bundle (e.g., 'snapshots/roomId/snapshotId.bundle').
 * @param {object} bundleData - The bundle data (e.g., { layers: [], thumbnail: Uint8Array }).
 * @returns {Promise<void>}
 */
export async function uploadSnapshotBundle(r2Key, bundleData) {
  const message = SnapshotBundle.create(bundleData);
  const bundleDataSerialized = SnapshotBundle.encode(message).finish();

  const params = {
    Bucket: BUCKET_NAME,
    Key: r2Key,
    Body: Buffer.from(bundleDataSerialized), // AWS SDK expects Buffer or Uint8Array
    ContentType: 'application/protobuf', // Set content type for proper handling
  };

  try {
    await r2Client.send(new PutObjectCommand(params));
    console.log(`Successfully uploaded snapshot bundle to R2: ${r2Key}`);
  } catch (error) {
    console.error(`Error uploading snapshot bundle to R2 (${r2Key}):`, error);
    throw error; // Re-throw to indicate failure
  }
}

/**
 * Retrieves a snapshot bundle from Cloudflare R2.
 * @param {string} r2Key - The object key for the snapshot bundle.
 * @returns {Promise<object|null>} The decoded bundle data or null if not found or error.
 */
export async function getSnapshotBundle(r2Key) {
  const params = {
    Bucket: BUCKET_NAME,
    Key: r2Key,
  };

  try {
    const command = new GetObjectCommand(params);
    const { Body } = await r2Client.send(command);

    if (!Body) {
      console.warn(`Snapshot bundle not found in R2: ${r2Key}`);
      return null;
    }

    const chunks = [];
    for await (const chunk of Body) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const decoded = SnapshotBundle.toObject(SnapshotBundle.decode(buffer));
    return decoded;
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      console.warn(`Snapshot bundle not found in R2 (NoSuchKey): ${r2Key}`);
      return null;
    }
    console.error(`Error retrieving snapshot bundle from R2 (${r2Key}):`, error);
    throw error; // Re-throw to indicate failure
  }
}

/**
 * Deletes a snapshot bundle from Cloudflare R2.
 * @param {string} r2Key - The object key for the snapshot bundle.
 * @returns {Promise<void>}
 */
export async function deleteSnapshotBundle(r2Key) {
  if (!r2Key) return;

  const params = {
    Bucket: BUCKET_NAME,
    Key: r2Key,
  };

  try {
    await r2Client.send(new DeleteObjectCommand(params));
    console.log(`Successfully deleted snapshot bundle from R2: ${r2Key}`);
  } catch (error) {
    console.error(`Error deleting snapshot bundle from R2 (${r2Key}):`, error);
    throw error;
  }
}
