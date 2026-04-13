/**
 * @fileoverview Smoothing utilities for position interpolation.
 * Provides Exponential Moving Average (EMA) smoothing for input positions.
 */

/**
 * Applies Exponential Moving Average (EMA) smoothing to a position and pressure.
 * Used by InputBufferManager to smooth inputs before local rendering and network broadcast.
 * @param {Object} buffer - Smoothing buffer with {x, y, p, isFirst}.
 * @param {number} targetX - Target X position (raw input).
 * @param {number} targetY - Target Y position (raw input).
 * @param {number} targetP - Target pressure (0-1).
 * @param {number} userSmoothing - User smoothing setting (0-50).
 * @param {number} [baseline=0.12] - Baseline smoothing factor (12% default).
 * @param {Object} [out] - Optional output object to write results into.
 * @returns {Object} - Smoothed position and pressure {x, y, p}.
 */
export function applySmoothingEMA(buffer, targetX, targetY, targetP, userSmoothing, baseline = 0.12, out) {
  // Calculate total smoothing: baseline (always on) + user contribution
  // userSmoothing is now 0-50 integer, so divide by 50.0 to get 0-1 range
  const totalSmoothing = baseline + (userSmoothing / 50.0) * (1 - baseline);

  // Use out object if provided, otherwise create a temporary one (for compatibility)
  const result = out || {};

  // First point: initialize buffer with target (no smoothing)
  if (buffer.isFirst || totalSmoothing === 0) {
    buffer.x = targetX;
    buffer.y = targetY;
    buffer.p = targetP !== undefined ? targetP : 1;
    buffer.isFirst = false;
    
    result.x = targetX;
    result.y = targetY;
    result.p = buffer.p;
    return result;
  }

  // Calculate interpolation factor
  // Higher smoothing → smaller factor → more lag → smoother curve
  const factor = 1 - totalSmoothing * 0.9;

  // Apply exponential moving average: new = old + (target - old) * factor
  const dx = (targetX - buffer.x) * factor;
  const dy = (targetY - buffer.y) * factor;
  const dp = ((targetP !== undefined ? targetP : 1) - (buffer.p !== undefined ? buffer.p : 1)) * factor;

  // Convergence: snap to target if the step is very small to prevent infinite approach
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
    buffer.x = targetX;
    buffer.y = targetY;
  } else {
    buffer.x += dx;
    buffer.y += dy;
  }

  if (Math.abs(dp) < 0.001) {
    buffer.p = targetP !== undefined ? targetP : 1;
  } else {
    buffer.p = (buffer.p !== undefined ? buffer.p : 1) + dp;
  }

  result.x = buffer.x;
  result.y = buffer.y;
  result.p = buffer.p;
  return result;
}

/**
 * Reset a smoothing buffer to initial state
 *
 * Call this when starting a new stroke or when smoothing state needs to be cleared.
 * The next call to applySmoothingEMA will treat the input as the first point.
 *
 * @param {Object} buffer - Smoothing buffer to reset
 *
 * @example
 * const buffer = { x: 100, y: 50, isFirst: false };
 * resetSmoothingBuffer(buffer);
 * console.log(buffer.isFirst); // true
 */
export function resetSmoothingBuffer(buffer) {
  buffer.isFirst = true;
}

/**
 * Create a new smoothing buffer with default values
 *
 * @returns {Object} New smoothing buffer {x: 0, y: 0, isFirst: true}
 *
 * @example
 * const buffer = createSmoothingBuffer();
 * const smoothed = applySmoothingEMA(buffer, 50, 50, 0.5);
 */
export function createSmoothingBuffer() {
  return { x: 0, y: 0, isFirst: true };
}
