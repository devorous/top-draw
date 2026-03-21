/**
 * @fileoverview FillWorkerClient - Main-thread wrapper for the fill web worker.
 *
 * Provides a promise-based API for offloading flood-fill computation.
 * Supports generation counters for interactive mode (stale results rejected).
 */

export class FillWorkerClient {
  constructor() {
    this._worker = new Worker(
      new URL('./fill.worker.js', import.meta.url),
      { type: 'module' }
    );
    this._nextId = 0;
    this._generation = 0;
    this._pending = new Map();

    this._worker.onmessage = (e) => {
      const { id, result, error, stale, generation } = e.data;
      const pending = this._pending.get(id);
      if (!pending) return;
      this._pending.delete(id);

      if (error) {
        pending.reject(new Error(error));
      } else if (stale) {
        // Stale result from a superseded generation — resolve with null
        pending.resolve(null);
      } else {
        // Reconstruct Uint8Array from transferred buffer
        if (result && result.maskBuffer) {
          result.mask = new Uint8Array(result.maskBuffer);
          delete result.maskBuffer;
        }
        pending.resolve(result);
      }
    };

    this._worker.onerror = (e) => {
      console.error('[FillWorkerClient] Worker error:', e.message);
    };
  }

  /**
   * Compute a flood fill with optional expansion/erosion.
   * The imageData buffer is transferred (zero-copy).
   *
   * @param {Uint8ClampedArray} pixelData - RGBA pixel data from getImageData
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @param {number} sx - Seed X
   * @param {number} sy - Seed Y
   * @param {number} tolerance - Color tolerance
   * @param {number} [expansion=0] - Dilation (>0) or erosion (<0)
   * @param {Array|null} [regionRects=null] - Optional region constraint [{x,y,width,height}]
   * @returns {Promise<{mask: Uint8Array, minX, minY, maxX, maxY, width, height}|null>}
   */
  computeFill(pixelData, width, height, sx, sy, tolerance, expansion = 0, regionRects = null) {
    const buffer = pixelData.buffer.slice(0);
    const generation = ++this._generation;
    const id = this._nextId++;

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({
        id, type: 'computeFill',
        buffer, width, height, sx, sy, tolerance, expansion,
        regionRects, generation
      }, [buffer]);
    });
  }

  /**
   * Bump the generation counter so any in-flight requests are marked stale.
   * Use when the user cancels an interactive fill or changes parameters.
   */
  invalidate() {
    this._generation++;
    this._worker.postMessage({ type: 'setGeneration', generation: this._generation });
  }

  /**
   * Terminate the worker.
   */
  destroy() {
    this._worker.terminate();
    for (const { reject } of this._pending.values()) {
      reject(new Error('Worker terminated'));
    }
    this._pending.clear();
  }
}
