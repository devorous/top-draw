/**
 * Board size presets, shared by client and server.
 *
 * Dimensions are `[height, width]` — the order `Board.dimensions` uses.
 */

export const BOARD_SIZE_PRESETS = {
  '720p': [720, 1280],
  '1080p': [1080, 1920],
  '1440p': [1440, 2560],
  // Legacy: no longer offered in room settings, kept so rooms already set to it
  // still resolve instead of falling back to 1080p and clearing the canvas.
  'big': [1800, 3200],
  // Stress-test sizes. Not offered in the normal room settings dropdown — they
  // exist so board-area-scaling costs can be amplified until they are visible
  // on fast hardware, where 1440p is comfortably inside every budget. A 12k
  // board is 9x the area of 1440p, so anything O(area) shows up as a 9x line.
  '4k': [2160, 3840],
  '8k': [4320, 7680],
  '12k': [6480, 11520]
};

/**
 * Sizes that are safe to offer to ordinary users.
 *
 * The stress sizes are deliberately excluded: server-side QOI checkpoints, R2
 * snapshots and timelapse frames are all taken at board resolution, so a 12k
 * room would cost far more in storage and encode time than the drawing is
 * worth. They stay reachable for testing via `isStressBoardSize`.
 */
export const STRESS_BOARD_SIZES = new Set(['8k', '12k']);

export function isStressBoardSize(boardSize) {
  return STRESS_BOARD_SIZES.has(boardSize);
}

/** Every preset key the wire will accept. */
export const VALID_BOARD_SIZES = new Set(Object.keys(BOARD_SIZE_PRESETS));

export function isValidBoardSize(boardSize) {
  return VALID_BOARD_SIZES.has(boardSize);
}

export function getBoardDimensionsForSize(boardSize) {
  return BOARD_SIZE_PRESETS[boardSize] || BOARD_SIZE_PRESETS['1080p'];
}
