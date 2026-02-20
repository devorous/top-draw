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
    // No blend mode setup needed; eraser uses destination-out per sub-layer.
  }

  deactivate() {}

  onPointerDown(user, pos) {
    this.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2, user.opacity);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2, user.opacity);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.erase(width - pos.x, pos.y, width - lastPos.x, lastPos.y, user.pressure * user.size * 2, user.opacity);
    }
  }

  /**
   * Erase on the local active layer group — clears all sub-layers at this position.
   */
  erase(x1, y1, x2, y2, size, opacity = 1.0) {
    const group = this.board.getActiveLayerGroup();
    if (group) {
      this.eraseOnGroup(group, x1, y1, x2, y2, size, opacity);
    }
    this.board.compositeAllLayers();
  }

  /**
   * Erase on every sub-layer of a layer group (for local and remote users).
   * @param {Object} group - Layer group from LayerManager
   * @param {number} x1 - Start X
   * @param {number} y1 - Start Y
   * @param {number} x2 - End X
   * @param {number} y2 - End Y
   * @param {number} size - Eraser size
   * @param {number} opacity - Eraser opacity
   */
  eraseOnGroup(group, x1, y1, x2, y2, size, opacity = 1.0) {
    for (const sub of group.subLayers) {
      this._eraseOnCtx(sub.context, x1, y1, x2, y2, size, opacity);
    }
  }

  _eraseOnCtx(ctx, x1, y1, x2, y2, size, opacity = 1.0) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = opacity;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
}
