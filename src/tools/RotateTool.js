/**
 * RotateTool - Rotates the canvas viewport around the initial click point.
 * Left drag: rotate around the click point
 * Scroll: zoom in/out
 */
export class RotateTool {
  constructor(board) {
    this.name = 'rotate';
    this.board = board;
  }

  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}
}
