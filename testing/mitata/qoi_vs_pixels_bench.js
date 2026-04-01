import { bench, run, group } from 'mitata';
import fs from 'fs';
import path from 'path';
import init, { has_content, qoi_encode_tile, qoi_decode_tile, qoi_has_content } from '../../src/wasm/ddraw_wasm.js';

// Load WASM in Node.js
const wasmPath = path.resolve('src/wasm/ddraw_wasm_bg.wasm');
const wasmBuffer = fs.readFileSync(wasmPath);
await init(wasmBuffer);

/**
 * Generate a 32x32 RGBA buffer with specified density.
 * @param {number} density - 0.0 to 1.0 (percent of pixels with Alpha > 0)
 * @returns {Uint8Array}
 */
function generateTile(density) {
  const data = new Uint8Array(4096);
  for (let i = 0; i < 1024; i++) {
    if (Math.random() < density) {
      data[i * 4] = 255;     // R
      data[i * 4 + 1] = 0;   // G
      data[i * 4 + 2] = 0;   // B
      data[i * 4 + 3] = 255; // A
    } else {
      data[i * 4 + 3] = 0;   // Transparent
    }
  }
  return data;
}

// Prepare Test Data
const emptyTile = new Uint8Array(4096); // All 0
const sparseTile = generateTile(0.01);  // 1% density
const denseTile = generateTile(0.8);    // 80% density

const emptyQoi = qoi_encode_tile(emptyTile);
const sparseQoi = qoi_encode_tile(sparseTile);
const denseQoi = qoi_encode_tile(denseTile);

console.log('--- Tile Sizes (Bytes) ---');
console.log(`Raw Buffer:  4096`);
console.log(`Empty QOI:   ${emptyQoi.length}`);
console.log(`Sparse QOI:  ${sparseQoi.length}`);
console.log(`Dense QOI:   ${denseQoi.length}`);
console.log('--------------------------\n');

group('Content Detection: Empty Tile', () => {
  bench('pixels.has_content (Raw Buffer)', () => {
    has_content(emptyTile);
  });

  bench('qoi.qoi_has_content (Compressed)', () => {
    qoi_has_content(emptyQoi);
  });
});

group('Content Detection: Sparse Tile (1%)', () => {
  bench('pixels.has_content (Raw Buffer)', () => {
    has_content(sparseTile);
  });

  bench('qoi.qoi_has_content (Compressed)', () => {
    qoi_has_content(sparseQoi);
  });
});

group('Content Detection: Dense Tile (80%)', () => {
  bench('pixels.has_content (Raw Buffer)', () => {
    has_content(denseTile);
  });

  bench('qoi.qoi_has_content (Compressed)', () => {
    qoi_has_content(denseQoi);
  });
});

group('Codec Performance: Full Cycle', () => {
  bench('QOI Encode (32x32)', () => {
    qoi_encode_tile(denseTile);
  });

  bench('QOI Decode (32x32)', () => {
    qoi_decode_tile(denseQoi);
  });
});

await run();
