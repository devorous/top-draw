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
 *
 * Each eraser gesture is stored as a single active stroke with blendMode
 * 'destination-out'. Eraser circles are drawn source-over into the active stroke
 * canvas; the destination-out effect is applied at composite time when that canvas
 * is drawn onto the target. This makes eraser gestures undoable.
 */
export class EraserTool extends Tool {
  constructor(board) {
    super('erase', board);
  }

  activate() {}
  deactivate() {}

  _eraseAllLayers() {
    return this.board.app?.eraseAllLayers ?? false;
  }

  onPointerDown(user, pos) {
    if (this._eraseAllLayers()) {
      this.board.beginStrokeAllLayers(user, 'destination-out');
    } else {
      this.board.beginStroke(user, 'destination-out');
    }
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

  onPointerUp(user) {
    if (this._eraseAllLayers()) {
      this.board.endStrokeAllLayers(user);
    } else {
      this.board.endStroke(user);
    }
  }

  /**
   * Erase on the active layer (or all layers if eraseAllLayers is set).
   * Draws source-over circles into the active stroke canvas(es), which have
   * blendMode 'destination-out' applied at composite time.
   */
  erase(x1, y1, x2, y2, size, opacity = 1.0) {
    if (this._eraseAllLayers()) {
      const userId = this.board.app?.self?.id ?? 0;
      const ctxs = this.board.getAllLayerContexts(userId, 'destination-out');
      for (const ctx of ctxs) {
        this._eraseOnCtx(ctx, x1, y1, x2, y2, size, opacity);
      }
    } else {
      const ctx = this.board.getActiveLayerContext('destination-out');
      if (ctx) {
        this._eraseOnCtx(ctx, x1, y1, x2, y2, size, opacity);
      }
    }
    this.board.compositeAllLayers();
  }

  /**
   * Erase on a specific layer group for a specific user.
   * Used by remote user drawing handler.
   * @param {Object} group - Layer group from LayerManager
   * @param {number} x1 - Start X
   * @param {number} y1 - Start Y
   * @param {number} x2 - End X
   * @param {number} y2 - End Y
   * @param {number} size - Eraser size
   * @param {number} opacity - Eraser opacity
   * @param {number} userId - User ID whose active stroke canvas to draw into
   */
  eraseOnGroup(group, x1, y1, x2, y2, size, opacity = 1.0, userId) {
    const active = group.activeStrokeByUser?.get(userId);
    if (active?.ctx) {
      this._eraseOnCtx(active.ctx, x1, y1, x2, y2, size, opacity);
    }
  }

  /**
   * Draw an eraser stroke into a context using source-over.
   * The destination-out effect is applied at composite time via the active stroke's blendMode.
   */
  _eraseOnCtx(ctx, x1, y1, x2, y2, size, opacity = 1.0) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }
}
