export const BOARD_SIZE_PRESETS = {
  '720p': [720, 1280],
  '1080p': [1080, 1920],
  '1440p': [1440, 2560],
  '4k': [2160, 3840]
};

export function applyRoomBoardSize(app, boardSize, options = {}) {
  const newDimensions = BOARD_SIZE_PRESETS[boardSize];
  const board = app?.board;
  if (!board || !newDimensions) return false;

  const [curH, curW] = board.dimensions;
  const [nextH, nextW] = newDimensions;
  const changed = curH !== nextH || curW !== nextW;

  if (changed) {
    board.resizeBoard(newDimensions);
    if (options.showToast !== false) {
      app.ui?.showToast?.(`Board resized to ${String(boardSize).toUpperCase()} (${nextW}x${nextH})`, 3000);
    }
  }

  if (app.currentRoomData) {
    app.currentRoomData.boardSize = boardSize;
  }

  return changed;
}
