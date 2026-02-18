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
    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'destination-out';
  }

  deactivate() {
    // Reset composite operation when switching away from eraser
    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'source-over';
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
    const ctx = this.board.getActiveLayerContext();
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

    // Composite after erasing
    this.board.compositeAllLayers();
  }

  /**
   * Erase on a specific layer context (for remote users)
   * @param {CanvasRenderingContext2D} ctx - Layer context to erase on
   * @param {number} x1 - Start X
   * @param {number} y1 - Start Y
   * @param {number} x2 - End X
   * @param {number} y2 - End Y
   * @param {number} size - Eraser size
   */
  eraseOnContext(ctx, x1, y1, x2, y2, size) {
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
