export const BOARD_SIZE_PRESETS = {
  '720p': [720, 1280],
  '1080p': [1080, 1920],
  '1440p': [1440, 2560],
  '4k': [2160, 3840]
};

export function getBoardDimensionsForSize(boardSize) {
  return BOARD_SIZE_PRESETS[boardSize] || BOARD_SIZE_PRESETS['1080p'];
}
