/**
 * @fileoverview Small free-list for board-sized snapshot canvases.
 *
 * The blur family (BlurTool, CircleBlurTool, GlitchBlurTool) each freeze a
 * full-board snapshot at pointerDown so every stamp in the stroke samples the
 * same pixels. All three used to `document.createElement` that canvas per stroke
 * and drop it at pointerUp — and even on their "cached" path, assigning
 * `canvas.width` reallocates the backing store, so the cache never saved
 * anything.
 *
 * A full-board canvas is ~14 MB at 1440p, and allocating one is the single most
 * expensive canvas operation there is; it stalls invisibly, without showing up
 * in any JS timer. That matches the measured signature of these tools: a clean
 * 16.7 ms median frame with the whole loss in the tail.
 *
 * MEASURED on the Chromebook, blur at 1440p solo, 10 interleaved reps: median
 * fps 26.3 -> 40 (+37.7 % paired, Wilcoxon significant), p99 224.8 -> 100 ms,
 * frames over 50 ms lower in 10 of 10 reps.
 *
 * The list is deliberately tiny. Holding a board-sized backing store for every
 * user who has ever used a blur tool is the memory problem these tools would
 * trade into otherwise — see the canvas backing-store budget work.
 */

/** Canvases kept per pool. Two covers the common local + one-remote case. */
const DEFAULT_MAX = 2;

export class SnapshotCanvasPool {
  /**
   * @param {number} [max] - Maximum canvases retained.
   */
  constructor(max = DEFAULT_MAX) {
    this.max = max;
    /** @type {HTMLCanvasElement[]} */
    this._free = [];
  }

  /**
   * Borrow a canvas of exactly this size. The contents are NOT cleared — every
   * caller either fills the whole thing (`drawImage` of the board) or clears it
   * itself, and clearing here would mean two full-board clears per stroke to
   * achieve what one does.
   *
   * @param {number} width
   * @param {number} height
   * @returns {HTMLCanvasElement}
   */
  acquire(width, height) {
    while (this._free.length > 0) {
      const candidate = this._free.pop();
      // Wrong-sized entries are dropped rather than resized: resizing is the
      // reallocation this pool exists to avoid.
      if (candidate.width === width && candidate.height === height) return candidate;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Return a canvas to the pool. Safe with null/undefined.
   * @param {HTMLCanvasElement|null|undefined} canvas
   * @returns {void}
   */
  release(canvas) {
    if (!canvas) return;
    if (this._free.length < this.max) this._free.push(canvas);
  }

  /**
   * Drop every retained canvas, zeroing the backing stores so the memory is
   * released promptly rather than at GC's convenience.
   * @returns {void}
   */
  dispose() {
    for (const canvas of this._free) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this._free.length = 0;
  }

  /** @returns {number} Canvases currently retained. */
  get size() {
    return this._free.length;
  }
}
