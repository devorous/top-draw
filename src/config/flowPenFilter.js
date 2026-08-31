/**
 * @fileoverview Input filter configuration for the fluid brush (flowPen).
 *
 * flowPen is the one stroke tool whose local point list is byte-for-byte what
 * goes on the wire: it is absent from REDUCE_BEFORE_RENDER_TOOLS and present in
 * _shouldPreserveStampPayload, so no Douglas-Peucker reduction ever runs on it
 * and stamp points land roughly a pixel apart.
 *
 * Stock smoothing for it is applySmoothingEMA, a fixed-lag exponential average.
 * Its lag is identical at every speed and every scale, so it attenuates genuine
 * fine detail exactly as hard as it attenuates sensor jitter — which is why
 * turning smoothing up rounds off small features.
 *
 * The deadband replaces that for flowPen: movement below a small spatial
 * threshold is dropped outright, and anything above it passes through
 * UNCHANGED. Jitter disappears; shape does not move at all. There is no lag and
 * therefore no corner rounding, at the cost of ~radius px of positional
 * quantisation.
 *
 * Set `enabled: false` to A/B against stock EMA behaviour.
 *
 * Radius range is chosen against InputBufferManager.subPixelCulling, which
 * already discards raw samples that moved less than 1 board px unless pressure
 * moved with them. The deadband therefore only has room to work just above that
 * floor — and deliberately stays close to it, because a large radius stops
 * being jitter rejection and starts being distance-based point reduction, which
 * can swallow a real feature whose whole amplitude is under the radius. These
 * two numbers are the first thing to turn if the feel is wrong.
 */
export const FLOWPEN_DEADBAND = {
  /**
   * Master switch — false restores the stock EMA path for flowPen.
   *
   * Defaulted OFF: this filter has not been evaluated by feel yet, only
   * measured. Turn it on to try it.
   */
  enabled: false,

  /** Deadband radius in board px at user smoothing 0 (slider minimum). */
  minRadius: 0.5,

  /** Deadband radius in board px at user smoothing 50 (slider maximum). */
  maxRadius: 2.5
};

/**
 * Maps the user's smoothing slider (0-50) onto a deadband radius in board px.
 * @param {number} userSmoothing - Smoothing setting, 0-50.
 * @returns {number} Deadband radius in board pixels.
 */
export function flowPenDeadbandRadius(userSmoothing) {
  const s = Math.max(0, Math.min(50, userSmoothing || 0)) / 50;
  const { minRadius, maxRadius } = FLOWPEN_DEADBAND;
  return minRadius + (maxRadius - minRadius) * s;
}
