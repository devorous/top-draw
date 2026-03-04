import { bench, run, group } from 'mitata';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { T } from '../shared/MessageTypes.js';
import { createCanvas } from 'canvas'; // Using node-canvas for dummy images

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = await protobuf.load(path.join(__dirname, '..', 'public', 'messages.proto'));
const Msg = root.lookupType('Msg');

/**
 * Generate a dummy stroke canvas with random content
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generateDummyStroke(width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Draw some random content to simulate a brush stroke
  ctx.fillStyle = `rgba(${Math.random() * 255}, ${Math.random() * 255}, ${Math.random() * 255}, 0.8)`;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) / 3, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toBuffer('image/png');
}

/**
 * Generate test dataset: array of stroke records
 * @param {number} count - Number of strokes
 * @param {number} avgSize - Average stroke size in pixels
 * @returns {Promise<Array>} Array of stroke objects
 */
async function generateStrokeDataset(count, avgSize = 100) {
  const strokes = [];

  for (let i = 0; i < count; i++) {
    const width = avgSize + Math.random() * 50 - 25;
    const height = avgSize + Math.random() * 50 - 25;
    const img = await generateDummyStroke(width, height);

    strokes.push({
      img,
      userId: Math.floor(Math.random() * 5), // 5 different users
      x: Math.floor(Math.random() * 1000),
      y: Math.floor(Math.random() * 1000),
      width: Math.floor(width),
      height: Math.floor(height),
      blendMode: Math.random() > 0.8 ? 'multiply' : 'source-over',
      timestamp: Date.now() + i,
      isRedo: false,
      redoBatch: 0
    });
  }

  return strokes;
}

// Pre-generate test datasets
console.log('Generating test datasets...');
const datasets = {
  small: await generateStrokeDataset(5, 80),    // 5 strokes, ~80px each
  medium: await generateStrokeDataset(20, 100), // 20 strokes, ~100px each
  large: await generateStrokeDataset(50, 120),  // 50 strokes, ~120px each
};
console.log('Datasets ready!');

/**
 * CURRENT SYNC: Send each stroke as individual SYNC_STROKE message
 */
function currentSyncMethod(strokes, layerIdx, targetUser) {
  const messages = [];

  for (const stroke of strokes) {
    const msg = Msg.create({
      t: T.SYNC_STROKE,
      img: stroke.img,
      u: stroke.userId,
      sx: stroke.x,
      sy: stroke.y,
      sw: stroke.width,
      sh: stroke.height,
      bm: stroke.blendMode,
      stroke_ts: stroke.timestamp,
      stroke_redo: stroke.isRedo,
      stroke_redo_batch: stroke.redoBatch,
      ly: layerIdx,
      tu: targetUser
    });

    const encoded = Msg.encode(msg).finish();
    messages.push(encoded);
  }

  return messages;
}

/**
 * NEW BATCHED SYNC: Pack all strokes into single SYNC_STROKE_BATCH message
 */
function batchedSyncMethod(strokes, layerIdx, targetUser) {
  // Map strokes to StrokeRecord format
  const strokeRecords = strokes.map(stroke => ({
    img: stroke.img,
    userId: stroke.userId,
    x: stroke.x,
    y: stroke.y,
    width: stroke.width,
    height: stroke.height,
    blendMode: stroke.blendMode,
    timestamp: stroke.timestamp,
    isRedo: stroke.isRedo,
    redoBatch: stroke.redoBatch,
    layerIdx: stroke.layerIdx || layerIdx  // Include per-stroke layer index
  }));

  // Create single batched message
  const msg = Msg.create({
    t: T.SYNC_STROKE_BATCH,
    strokes: strokeRecords,
    layerIdx: layerIdx,
    tu: targetUser
  });

  const encoded = Msg.encode(msg).finish();
  return [encoded]; // Single message
}

/**
 * Calculate total bytes for an array of encoded messages
 */
function totalBytes(messages) {
  return messages.reduce((sum, msg) => sum + msg.length, 0);
}

/**
 * Benchmark helper
 */
function benchmarkSync(name, strokes) {
  group(`Sync: ${name} (${strokes.length} strokes)`, () => {
    const layerIdx = 0;
    const targetUser = 1;

    bench('Current (Individual Messages)', () => {
      const messages = currentSyncMethod(strokes, layerIdx, targetUser);
      const bytes = totalBytes(messages);
      return { messages: messages.length, bytes };
    });

    bench('Batched (Single Message)', () => {
      const messages = batchedSyncMethod(strokes, layerIdx, targetUser);
      const bytes = totalBytes(messages);
      return { messages: messages.length, bytes };
    });

    // Summary comparison (run once to show stats)
    const currentMessages = currentSyncMethod(strokes, layerIdx, targetUser);
    const currentBytes = totalBytes(currentMessages);

    const batchedMessages = batchedSyncMethod(strokes, layerIdx, targetUser);
    const batchedBytes = totalBytes(batchedMessages);

    console.log(`\n📊 ${name} Stats:`);
    console.log(`  Current: ${currentMessages.length} messages, ${(currentBytes / 1024).toFixed(2)} KB`);
    console.log(`  Batched: ${batchedMessages.length} message, ${(batchedBytes / 1024).toFixed(2)} KB`);
    console.log(`  Savings: ${((1 - batchedBytes / currentBytes) * 100).toFixed(1)}%\n`);
  });
}

// Run benchmarks
benchmarkSync('Small Layer', datasets.small);
benchmarkSync('Medium Layer', datasets.medium);
benchmarkSync('Large Layer', datasets.large);

await run();
