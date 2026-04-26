import { BOARD_SIZE_PRESETS } from '../../shared/boardSizes.js';

export { BOARD_SIZE_PRESETS };

export function applyRoomBoardSize(app, boardSize, options = {}) {
  const newDimensions = BOARD_SIZE_PRESETS[boardSize];
  const board = app?.board;
  if (!board || !newDimensions) return false;

  const [curH, curW] = board.dimensions;
  const [nextH, nextW] = newDimensions;
  const changed = curH !== nextH || curW !== nextW;

  if (changed) {
    board.resizeBoard(newDimensions);
    app._bindLayerManagerDependencies?.();
    if (options.showToast !== false) {
      app.ui?.showToast?.(`Board resized to ${String(boardSize).toUpperCase()} (${nextW}x${nextH})`, 3000);
    }
  }

  if (app.currentRoomData) {
    app.currentRoomData.boardSize = boardSize;
  }

  return changed;
}
