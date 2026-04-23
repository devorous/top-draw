#!/usr/bin/env node
/**
 * Extract PNG layers and thumbnail files from a Top Draw snapshot bundle.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import protobuf from 'protobufjs';
import sharp from 'sharp';

const QOI_MAGIC = 'qoif';
const QOI_OP_INDEX = 0x00;
const QOI_OP_DIFF = 0x40;
const QOI_OP_LUMA = 0x80;
const QOI_OP_RUN = 0xc0;
const QOI_OP_RGB = 0xfe;
const QOI_OP_RGBA = 0xff;
const QOI_MASK_2 = 0xc0;

function printUsage() {
  console.log('Usage: node scripts/extract_snapshot_bundle.mjs <bundle...> [-o outputDir] [--no-composite]');
}

function parseArgs(argv) {
  const bundles = [];
  let outputDir = null;
  let noComposite = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--out') {
      outputDir = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--no-composite') {
      noComposite = true;
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      bundles.push(arg);
    }
  }

  if (!bundles.length) {
    printUsage();
    process.exit(1);
  }

  return { bundles, outputDir, noComposite };
}

function qoiColorHash(r, g, b, a) {
  return (r * 3 + g * 5 + b * 7 + a * 11) % 64;
}

function qoiDecode(buffer) {
  if (buffer.length < 22) {
    throw new Error('QOI buffer is too short');
  }
  if (buffer.subarray(0, 4).toString('ascii') !== QOI_MAGIC) {
    throw new Error('Invalid QOI magic');
  }

  const width = buffer.readUInt32BE(4);
  const height = buffer.readUInt32BE(8);
  const channels = buffer[12];
  if (channels !== 3 && channels !== 4) {
    throw new Error(`Unsupported QOI channel count: ${channels}`);
  }

  const pixelCount = width * height;
  const out = Buffer.alloc(pixelCount * 4);
  const index = Array.from({ length: 64 }, () => [0, 0, 0, 0]);

  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  let src = 14;
  let written = 0;

  while (written < pixelCount) {
    if (src >= buffer.length) {
      throw new Error('Unexpected end of QOI data');
    }

    const byte = buffer[src++];

    if (byte === QOI_OP_RGB) {
      r = buffer[src++];
      g = buffer[src++];
      b = buffer[src++];
    } else if (byte === QOI_OP_RGBA) {
      r = buffer[src++];
      g = buffer[src++];
      b = buffer[src++];
      a = buffer[src++];
    } else {
      const tag = byte & QOI_MASK_2;
      if (tag === QOI_OP_INDEX) {
        [r, g, b, a] = index[byte & 0x3f];
      } else if (tag === QOI_OP_DIFF) {
        r = (r + ((byte >> 4) & 0x03) - 2 + 256) & 0xff;
        g = (g + ((byte >> 2) & 0x03) - 2 + 256) & 0xff;
        b = (b + (byte & 0x03) - 2 + 256) & 0xff;
      } else if (tag === QOI_OP_LUMA) {
        const byte2 = buffer[src++];
        const dg = (byte & 0x3f) - 32;
        const dr = ((byte2 >> 4) & 0x0f) - 8;
        const db = (byte2 & 0x0f) - 8;
        r = (r + dg + dr + 512) & 0xff;
        g = (g + dg + 512) & 0xff;
        b = (b + dg + db + 512) & 0xff;
      } else if (tag === QOI_OP_RUN) {
        const run = (byte & 0x3f) + 1;
        for (let i = 0; i < run; i += 1) {
          const dst = written * 4;
          out[dst] = r;
          out[dst + 1] = g;
          out[dst + 2] = b;
          out[dst + 3] = a;
          written += 1;
        }
        index[qoiColorHash(r, g, b, a)] = [r, g, b, a];
        continue;
      } else {
        throw new Error('Unsupported QOI opcode');
      }
    }

    const dst = written * 4;
    out[dst] = r;
    out[dst + 1] = g;
    out[dst + 2] = b;
    out[dst + 3] = a;
    index[qoiColorHash(r, g, b, a)] = [r, g, b, a];
    written += 1;
  }

  return { width, height, rgba: out };
}

function compositeLayers(decodedLayers) {
  const { width, height } = decodedLayers[0];
  const composite = Buffer.alloc(width * height * 4);

  for (const layer of decodedLayers) {
    if (layer.width !== width || layer.height !== height) {
      throw new Error('Layer dimensions do not match');
    }

    const src = layer.rgba;
    for (let i = 0; i < composite.length; i += 4) {
      const sr = src[i];
      const sg = src[i + 1];
      const sb = src[i + 2];
      const sa = src[i + 3];
      if (sa === 0) continue;

      const dr = composite[i];
      const dg = composite[i + 1];
      const db = composite[i + 2];
      const da = composite[i + 3];

      const srcA = sa / 255;
      const dstA = da / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) {
        composite[i] = 0;
        composite[i + 1] = 0;
        composite[i + 2] = 0;
        composite[i + 3] = 0;
        continue;
      }

      composite[i] = Math.max(0, Math.min(255, Math.round((sr * srcA + dr * dstA * (1 - srcA)) / outA)));
      composite[i + 1] = Math.max(0, Math.min(255, Math.round((sg * srcA + dg * dstA * (1 - srcA)) / outA)));
      composite[i + 2] = Math.max(0, Math.min(255, Math.round((sb * srcA + db * dstA * (1 - srcA)) / outA)));
      composite[i + 3] = Math.max(0, Math.min(255, Math.round(outA * 255)));
    }
  }

  return { width, height, rgba: composite };
}

async function saveRgbaAsPng(filePath, image) {
  await sharp(image.rgba, {
    raw: {
      width: image.width,
      height: image.height,
      channels: 4
    }
  }).png().toFile(filePath);
}

async function loadSnapshotBundle(bundlePath) {
  const root = await protobuf.load(path.resolve('public/messages.proto'));
  const SnapshotBundle = root.lookupType('SnapshotBundle');
  const file = await fs.readFile(bundlePath);
  return SnapshotBundle.decode(file);
}

async function extractBundle(bundlePath, outputDir, noComposite) {
  const bundle = await loadSnapshotBundle(bundlePath);
  const decodedLayers = [];

  await fs.mkdir(outputDir, { recursive: true });

  if (bundle.thumbnail?.length) {
    await fs.writeFile(path.join(outputDir, 'thumbnail.jpg'), bundle.thumbnail);
  }

  const layers = Array.isArray(bundle.layers) ? bundle.layers : [];
  for (let i = 0; i < layers.length; i += 1) {
    const decoded = qoiDecode(Buffer.from(layers[i]));
    decodedLayers.push(decoded);
    await saveRgbaAsPng(path.join(outputDir, `layer_${String(i).padStart(2, '0')}.png`), decoded);
  }

  if (decodedLayers.length && !noComposite) {
    const composite = compositeLayers(decodedLayers);
    await saveRgbaAsPng(path.join(outputDir, 'composite.png'), composite);
  }

  return decodedLayers.length;
}

async function main() {
  const { bundles, outputDir, noComposite } = parseArgs(process.argv.slice(2));
  for (const bundlePath of bundles) {
    const absBundle = path.resolve(bundlePath);
    const baseName = path.basename(bundlePath, path.extname(bundlePath));
    const outDir = outputDir
      ? path.resolve(outputDir, baseName)
      : path.join(path.dirname(absBundle), `${baseName}_extracted`);
    const layerCount = await extractBundle(absBundle, outDir, noComposite);
    console.log(`Extracted ${layerCount} layer(s) from ${bundlePath} -> ${outDir}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
