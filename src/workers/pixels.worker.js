/**
 * @fileoverview Pixels Web Worker (ES module)
 *
 * Handles expensive pixel scanning and blur operations off the main thread.
 * Loads WASM (SIMD -> standard -> JS fallback) for has_content and find_content_bounds.
 * Uses zero-copy ArrayBuffer transfers for all pixel data.
 *
 * Messages IN:
 *   { id, type: 'hasContent',        buffer: ArrayBuffer, length: number }
 *   { id, type: 'findContentBounds', buffer: ArrayBuffer, width, height }
 *   { id, type: 'findContentBoundsRegion', buffer: ArrayBuffer, width, height,
 *         regionX, regionY, regionW, regionH }
 *   { id, type: 'blur',              buffer: ArrayBuffer, width, height, radius }
 *
 * Messages OUT:
 *   { id, type, result, buffer: ArrayBuffer }     (buffer transferred back)
 *   { id, type, error: string }
 */

import stackblur from 'stackblur';

// --- JS fallback implementations ---

function js_has_content(data, length) {
  for (let i = 3; i < length; i += 4) {
    if (data[i] > 0) return 1;
  }
  return 0;
}

function js_find_content_bounds(data, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height && minY === height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x * 4 + 3] > 0) { minY = y; break; }
    }
  }

  if (minY === height) return null;

  for (let y = height - 1; y >= minY; y--) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x * 4 + 3] > 0) { maxY = y; break; }
    }
    if (maxY >= 0) break;
  }

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

/**
 * Apply stackblur with pre-multiplied alpha to avoid dark fringes.
 * Operates in-place on the provided Uint8ClampedArray.
 */
function js_blur(data, width, height, radius) {
  // Pre-multiply alpha
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    data[i]     = data[i]     * alpha;
    data[i + 1] = data[i + 1] * alpha;
    data[i + 2] = data[i + 2] * alpha;
  }

  stackblur(data, width, height, radius);

  // Un-pre-multiply alpha
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha > 0) {
      data[i]     = data[i]     / alpha;
      data[i + 1] = data[i + 1] / alpha;
      data[i + 2] = data[i + 2] / alpha;
    }
  }
}

/**
 * Apply stackblur via WASM (includes pre-multiply/un-pre-multiply).
 * Operates in-place on the provided Uint8ClampedArray.
 */
function wasm_blur(data, width, height, radius) {
  const byteLen = data.length;
  const ptr = wasmModule._malloc(byteLen);
  wasmModule.HEAPU8.set(data, ptr);
  wasmModule._stackblur_rgba(ptr, width, height, radius);
  data.set(wasmModule.HEAPU8.subarray(ptr, ptr + byteLen));
  wasmModule._free(ptr);
}

// --- WASM loading ---

let wasmModule = null;
let useWasm = false;

async function initWasm() {
  const tiers = [
    { js: '/wasm/pixels-simd.js', label: 'SIMD' },
    { js: '/wasm/pixels.js',      label: 'Standard' },
  ];

  for (const { js, label } of tiers) {
    try {
      console.log(`[pixels.worker] Trying ${label} WASM: fetching ${js}`);
      const response = await fetch(js);
      if (!response.ok) {
        console.warn(`[pixels.worker] ${label} WASM fetch failed: HTTP ${response.status}`);
        continue;
      }
      console.log(`[pixels.worker] ${label} WASM JS glue fetched OK`);

      // Load via blob URL to avoid Vite's module resolver intercepting /public imports.
      // Append an ES module export since the Emscripten glue only has CJS/AMD exports,
      // which are undefined in ES module scope.
      const jsText = await response.text() + '\nexport default createPixelsModule;';
      const blob = new Blob([jsText], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);

      let mod;
      try {
        mod = await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      if (typeof mod.default !== 'function') {
        console.warn(`[pixels.worker] ${label} WASM: module.default is not a function (got ${typeof mod.default})`);
        continue;
      }

      console.log(`[pixels.worker] ${label} WASM: initialising module (fetching .wasm binary)...`);
      // Tell Emscripten where to fetch the .wasm binary from
      wasmModule = await mod.default({
        locateFile: (filename) => `/wasm/${filename}`,
        print: (msg) => console.log(`[pixels.wasm] ${msg}`),
        printErr: (msg) => console.warn(`[pixels.wasm] ${msg}`),
      });
      useWasm = true;

      const exports = ['_has_content', '_find_content_bounds', '_stackblur_rgba', '_malloc', '_free'];
      const missing = exports.filter(fn => typeof wasmModule[fn] !== 'function');
      if (missing.length) {
        console.warn(`[pixels.worker] ${label} WASM loaded but missing exports: ${missing.join(', ')}`);
      } else {
        console.log(`[pixels.worker] ${label} WASM ready. Exports verified: ${exports.join(', ')}`);
      }
      return;
    } catch (err) {
      console.warn(`[pixels.worker] ${label} WASM failed:`, err);
      // Try next tier
    }
  }

  console.warn('[pixels.worker] All WASM tiers failed — using JS fallback for all operations');
}

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
  const outPtr = wasmModule._malloc(16);

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

  await wasmReady;

  try {
    let result;
    let transferBack;

    switch (type) {
      case 'hasContent': {
        const { buffer, length } = e.data;
        const data = new Uint8ClampedArray(buffer);
        if (useWasm) {
          result = wasm_has_content(data, length) === 1;
          console.log(`[pixels.worker] hasContent via WASM → ${result}`);
        } else {
          result = js_has_content(data, length) === 1;
          console.log(`[pixels.worker] hasContent via JS fallback → ${result}`);
        }
        transferBack = buffer;
        break;
      }

      case 'findContentBounds': {
        const { buffer, width, height } = e.data;
        const data = new Uint8ClampedArray(buffer);
        if (useWasm) {
          result = wasm_find_content_bounds(data, width, height);
          console.log(`[pixels.worker] findContentBounds via WASM → ${JSON.stringify(result)}`);
        } else {
          result = js_find_content_bounds(data, width, height);
          console.log(`[pixels.worker] findContentBounds via JS fallback → ${JSON.stringify(result)}`);
        }
        transferBack = buffer;
        break;
      }

      case 'findContentBoundsRegion': {
        const { buffer, width, height, regionX, regionY } = e.data;
        const data = new Uint8ClampedArray(buffer);
        if (useWasm) {
          result = wasm_find_content_bounds(data, width, height);
          console.log(`[pixels.worker] findContentBoundsRegion via WASM → ${JSON.stringify(result)}`);
        } else {
          result = js_find_content_bounds(data, width, height);
          console.log(`[pixels.worker] findContentBoundsRegion via JS fallback → ${JSON.stringify(result)}`);
        }
        if (result) {
          result.x += regionX;
          result.y += regionY;
        }
        transferBack = buffer;
        break;
      }

      case 'blur': {
        const { buffer, width, height, radius } = e.data;
        const data = new Uint8ClampedArray(buffer);
        if (useWasm && wasmModule._stackblur_rgba) {
          console.log(`[pixels.worker] blur via WASM stackblur_rgba (${width}×${height}, r=${radius})`);
          wasm_blur(data, width, height, radius);
        } else {
          console.log(`[pixels.worker] blur via JS fallback (${width}×${height}, r=${radius})`);
          js_blur(data, width, height, radius);
        }
        result = true;
        transferBack = buffer;
        break;
      }

      default:
        self.postMessage({ id, type, error: `Unknown message type: ${type}` });
        return;
    }

    self.postMessage({ id, type, result, buffer: transferBack }, [transferBack]);

  } catch (err) {
    self.postMessage({ id, type, error: err.message });
  }
};
