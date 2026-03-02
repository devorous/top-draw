/**
 * Smoothing utilities for position interpolation
 *
 * This module provides the centralized smoothing logic used throughout the application
 * to ensure perfect parity between local preview and remote rendering.
 */

/**
 * Apply Exponential Moving Average (EMA) smoothing to a position
 *
 * This is the canonical smoothing implementation used by InputBufferManager
 * to smooth positions before both local rendering and network broadcast.
 *
 * Formula breakdown:
 * - Baseline: 12% (always applied, cannot be disabled)
 * - User factor: userSmoothing * 88% (additive range: 0-88%)
 * - Total range: 12% to 100% smoothing
 * - Lerp factor: 1 - totalSmoothing * 0.9 (higher smoothing = smaller factor = more lag)
 *
 * @param {Object} buffer - Smoothing buffer with {x, y, isFirst} properties
 * @param {number} targetX - Target X position (raw input)
 * @param {number} targetY - Target Y position (raw input)
 * @param {number} userSmoothing - User smoothing setting (0-1 range)
 * @param {number} baseline - Baseline smoothing factor (default: 0.12 = 12%)
 * @returns {Object} Smoothed position {x, y}
 *
 * @example
 * const buffer = { x: 0, y: 0, isFirst: true };
 * const smoothed = applySmoothingEMA(buffer, 100, 50, 0.3);
 * // buffer.isFirst is now false, buffer.x and buffer.y contain smoothed values
 * console.log(smoothed); // { x: 100, y: 50 } on first call (no smoothing)
 *
 * const smoothed2 = applySmoothingEMA(buffer, 120, 60, 0.3);
 * console.log(smoothed2); // { x: ~105, y: ~52.5 } with smoothing applied
 */
export function applySmoothingEMA(buffer, targetX, targetY, userSmoothing, baseline = 0.12) {
  // Calculate total smoothing: baseline (always on) + user contribution
  const totalSmoothing = baseline + userSmoothing * (1 - baseline);

  // First point: initialize buffer with target position (no smoothing)
  if (buffer.isFirst || totalSmoothing === 0) {
    buffer.x = targetX;
    buffer.y = targetY;
    buffer.isFirst = false;
    return { x: targetX, y: targetY };
  }

  // Calculate interpolation factor
  // Higher smoothing → smaller factor → more lag → smoother curve
  const factor = 1 - totalSmoothing * 0.9;

  // Apply exponential moving average: new = old + (target - old) * factor
  const dx = (targetX - buffer.x) * factor;
  const dy = (targetY - buffer.y) * factor;

  // Convergence: snap to target if the step is very small to prevent infinite approach
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
    buffer.x = targetX;
    buffer.y = targetY;
  } else {
    buffer.x += dx;
    buffer.y += dy;
  }

  return { x: buffer.x, y: buffer.y };
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
