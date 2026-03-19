/**
 * @fileoverview Pixels Web Worker
 *
 * Handles expensive pixel scanning operations off the main thread.
 * Loads WASM (SIMD → standard → JS fallback) for has_content and find_content_bounds.
 * Uses zero-copy ArrayBuffer transfers for all pixel data.
 *
 * Messages IN:
 *   { id, type: 'hasContent',        buffer: ArrayBuffer, length: number }
 *   { id, type: 'findContentBounds', buffer: ArrayBuffer, width: number, height: number }
 *   { id, type: 'findContentBoundsRegion', buffer: ArrayBuffer, width: number, height: number,
 *         regionX: number, regionY: number, regionW: number, regionH: number }
 *
 * Messages OUT:
 *   { id, type, result, buffer: ArrayBuffer }     (buffer transferred back)
 *   { id, type, error: string }
 */

// --- JS fallback implementations ---

function js_has_content(data, length) {
  for (let i = 3; i < length; i += 4) {
    if (data[i] > 0) return 1;
  }
  return 0;
}

function js_find_content_bounds(data, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;

  // Scan top-to-bottom for minY
  for (let y = 0; y < height && minY === height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x * 4 + 3] > 0) {
        minY = y;
        break;
      }
    }
  }

  if (minY === height) return null;

  // Scan bottom-to-top for maxY
  for (let y = height - 1; y >= minY; y--) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x * 4 + 3] > 0) {
        maxY = y;
        break;
      }
    }
    if (maxY >= 0) break;
  }

  // Scan relevant rows for minX/maxX
  for (let y = minY; y <= maxY; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < minX; x++) {
      if (data[rowOff + x * 4 + 3] > 0) { minX = x; break; }
    }
    for (let x = width - 1; x > maxX; x--) {
      if (data[rowOff + x * 4 + 3] > 0) { maxX = x; break; }
    }
    if (minX === 0 && maxX === width - 1) break;
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// --- WASM loading ---

let wasmModule = null;
let useWasm = false;

async function initWasm() {
  // Try SIMD first, then standard
  const paths = ['/wasm/pixels-simd.js', '/wasm/pixels.js'];

  for (const path of paths) {
    try {
      importScripts(path);
      if (typeof createPixelsModule === 'function') {
        wasmModule = await createPixelsModule();
        useWasm = true;
        const tier = path.includes('simd') ? 'SIMD' : 'Standard';
        console.log(`[pixels.worker] ${tier} WASM loaded`);
        return;
      }
    } catch (_) {
      // Try next tier
    }
  }

  console.log('[pixels.worker] WASM unavailable, using JS fallback');
}

// Init WASM on startup (non-blocking — messages queue while this resolves)
const wasmReady = initWasm();

// --- WASM wrapper functions ---

function wasm_has_content(data, length) {
  const ptr = wasmModule._malloc(length);
  wasmModule.HEAPU8.set(data, ptr);
  const result = wasmModule._has_content(ptr, length);
  wasmModule._free(ptr);
  return result;
}

function wasm_find_content_bounds(data, width, height) {
  const byteLen = width * height * 4;
  const dataPtr = wasmModule._malloc(byteLen);
  const outPtr = wasmModule._malloc(16); // 4 ints * 4 bytes

  wasmModule.HEAPU8.set(data, dataPtr);
  wasmModule._find_content_bounds(dataPtr, width, height, outPtr);

  const result = new Int32Array(wasmModule.HEAPU8.buffer, outPtr, 4);
  const x = result[0], y = result[1], w = result[2], h = result[3];

  wasmModule._free(dataPtr);
  wasmModule._free(outPtr);

  if (x === -1) return null;
  return { x, y, width: w, height: h };
}

// --- Message handler ---

self.onmessage = async function(e) {
  const { id, type } = e.data;

  // Ensure WASM is loaded before processing
  await wasmReady;

  try {
    let result;
    let transferBack;

    switch (type) {
      case 'hasContent': {
        const { buffer, length } = e.data;
        const data = new Uint8ClampedArray(buffer);
        result = useWasm
          ? wasm_has_content(data, length) === 1
          : js_has_content(data, length) === 1;
        transferBack = buffer;
        break;
      }

      case 'findContentBounds': {
        const { buffer, width, height } = e.data;
        const data = new Uint8ClampedArray(buffer);
        result = useWasm
          ? wasm_find_content_bounds(data, width, height)
          : js_find_content_bounds(data, width, height);
        transferBack = buffer;
        break;
      }

      case 'findContentBoundsRegion': {
        const { buffer, width, height, regionX, regionY, regionW, regionH } = e.data;
        const data = new Uint8ClampedArray(buffer);
        // Scan only within the specified region
        result = useWasm
          ? wasm_find_content_bounds(data, width, height)
          : js_find_content_bounds(data, width, height);
        // Offset results back to full-canvas coords
        if (result) {
          result.x += regionX;
          result.y += regionY;
        }
        transferBack = buffer;
        break;
      }

      default:
        self.postMessage({ id, type, error: `Unknown message type: ${type}` });
        return;
    }

    // Transfer buffer back to main thread (zero-copy)
    self.postMessage({ id, type, result, buffer: transferBack }, [transferBack]);

  } catch (err) {
    self.postMessage({ id, type, error: err.message });
  }
};
