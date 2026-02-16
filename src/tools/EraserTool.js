/**
 * Base tool class
 */
class Tool {
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}
}

/**
 * Eraser tool
 */
export class EraserTool extends Tool {
  constructor(board) {
    super('erase', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'destination-out';
  }

  deactivate() {
    // Reset composite operation when switching away from eraser
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    this.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.erase(width - pos.x, pos.y, width - lastPos.x, lastPos.y, user.pressure * user.size * 2);
    }
  }

  erase(x1, y1, x2, y2, size) {
    const ctx = this.board.mainCtx;
    // Explicitly set all properties (remote users bypass activate())
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1.0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}
