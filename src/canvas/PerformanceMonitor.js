/**
 * @fileoverview Measures render performance: RAF FPS, composite rate, frame time, input latency, memory.
 */

export class PerformanceMonitor {
  constructor() {
      /** @type {number[]} Composite timestamps, rolling 1s window */
    this._compositeTimestamps = [];
    /** @type {number[]} Duration of each composite in ms */
    this._frameTimes = [];
    /** @type {number} performance.now() at start of current composite */
    this._t0 = 0;
    /** @type {number} performance.now() when the last input was pushed to the buffer */
    this._lastInputTime = 0;
    /** @type {number} Latency in ms from last input push to last composite end */
    this.lastLatency = 0;
  }

  /**
   * Call at the very start of compositeAllLayers().
   */
  recordCompositeStart() {
    this._t0 = performance.now();
  }

  /**
   * Call at the very end of compositeAllLayers().
   */
  recordCompositeEnd() {
    const now = performance.now();
    const frameTime = now - this._t0;

    this._compositeTimestamps.push(now);
    this._frameTimes.push(frameTime);

    if (this._lastInputTime > 0) {
      this.lastLatency = now - this._lastInputTime;
    }

    const cutoff = now - 1000;
    while (this._compositeTimestamps.length && this._compositeTimestamps[0] < cutoff) {
      this._compositeTimestamps.shift();
      this._frameTimes.shift();
    }
  }

  /**
   * Call when a pointer event pushes coordinates into the input buffer.
   */
  recordInput() {
    this._lastInputTime = performance.now();
  }

  /**
   * How many composites actually ran in the last 1s.
   * @returns {number}
   */
  getCompositeRate() {
    return this._compositeTimestamps.length;
  }

  /**
   * Average composite duration in ms over the last 1s window.
   * @returns {number}
   */
  getAvgFrameTime() {
    if (!this._frameTimes.length) return 0;
    return this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
  }

  /**
   * JS heap memory in bytes (Chrome only). Returns null on unsupported browsers.
   * @returns {number|null}
   */
  getMemory() {
    return performance.memory?.usedJSHeapSize ?? null;
  }
}
