/**
 * @fileoverview PixelsWorkerClient - Main-thread wrapper for the pixels web worker.
 *
 * Provides a promise-based API for offloading pixel scanning and blur to the worker.
 * All ArrayBuffer transfers are zero-copy (transferred, not cloned).
 */

export class PixelsWorkerClient {
  constructor() {
    this._worker = new Worker(
      new URL('./pixels.worker.js', import.meta.url),
      { type: 'module' }
    );
    this._nextId = 0;
    this._pending = new Map();

    this._worker.onmessage = (e) => {
      const { id, result, error, buffer } = e.data;
      const pending = this._pending.get(id);
      if (!pending) return;
      this._pending.delete(id);

      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result, buffer);
      }
    };

    this._worker.onerror = (e) => {
      console.error('[PixelsWorkerClient] Worker error:', e.message);
    };
  }

  /**
   * Send a message to the worker and return a promise for the result.
   * @param {string} type - Message type
   * @param {Object} payload - Message payload (excluding id/type)
   * @param {Array} [transferables=[]] - Transferable objects
   * @returns {Promise<*>}
   * @private
   */
  _send(type, payload, transferables = []) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, type, ...payload }, transferables);
    });
  }

  /**
   * Check if a canvas has any non-transparent pixels.
   *
   * @param {Uint8ClampedArray} pixelData - RGBA pixel data (from getImageData().data)
   * @returns {Promise<boolean>}
   */
  hasContent(pixelData) {
    const buffer = pixelData.buffer.slice(0);
    return this._send('hasContent', {
      buffer,
      length: pixelData.length
    }, [buffer]);
  }

  /**
   * Find the tight bounding box of non-transparent pixels.
   *
   * @param {Uint8ClampedArray} pixelData - RGBA pixel data
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @returns {Promise<{x: number, y: number, width: number, height: number}|null>}
   */
  findContentBounds(pixelData, width, height) {
    const buffer = pixelData.buffer.slice(0);
    return this._send('findContentBounds', {
      buffer,
      width,
      height
    }, [buffer]);
  }

  /**
   * Find content bounds within a specific region of a canvas.
   *
   * @param {Uint8ClampedArray} pixelData - RGBA pixel data of the region
   * @param {number} width - Region width
   * @param {number} height - Region height
   * @param {number} regionX - Region X offset in full canvas
   * @param {number} regionY - Region Y offset in full canvas
   * @returns {Promise<{x: number, y: number, width: number, height: number}|null>}
   */
  findContentBoundsRegion(pixelData, width, height, regionX, regionY) {
    const buffer = pixelData.buffer.slice(0);
    return this._send('findContentBoundsRegion', {
      buffer,
      width,
      height,
      regionX,
      regionY,
      regionW: width,
      regionH: height
    }, [buffer]);
  }

  /**
   * Blur pixel data off the main thread using pre-multiplied alpha stackblur.
   * The buffer is transferred (zero-copy). Returns blurred pixel data in a
   * new Uint8ClampedArray backed by the transferred-back buffer.
   *
   * @param {Uint8ClampedArray} pixelData - RGBA pixel data
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {number} radius - Blur radius
   * @returns {Promise<Uint8ClampedArray>} Blurred pixel data
   */
  blur(pixelData, width, height, radius) {
    const buffer = pixelData.buffer.slice(0);
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve: (_result, returnedBuffer) => {
          resolve(new Uint8ClampedArray(returnedBuffer));
        },
        reject
      });
      this._worker.postMessage({ id, type: 'blur', buffer, width, height, radius }, [buffer]);
    });
  }

  /**
   * Terminate the worker. Call when no longer needed.
   */
  destroy() {
    this._worker.terminate();
    for (const { reject } of this._pending.values()) {
      reject(new Error('Worker terminated'));
    }
    this._pending.clear();
  }
}
