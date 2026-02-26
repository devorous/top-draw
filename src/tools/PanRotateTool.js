/**
 * PanTool - Pans the canvas viewport by dragging.
 * Left drag: pan
 * Scroll: zoom in/out
 */
export class PanTool {
  constructor(board) {
    this.name = 'pan';
    this.board = board;
  }

  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}
}
