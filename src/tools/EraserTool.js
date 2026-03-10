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
    this.userSize = 10;
    this.lastPos = null;
  }

  activate() {}
  deactivate() {}

  _eraseAllLayers() {
    return this.board.app?.eraseAllLayers ?? false;
  }

  onPointerDown(user, pos) {
    this.userSize = user.size;
    this.lastPos = { x: pos.x, y: pos.y };

    // Eraser always uses 1.0 opacity now
    if (this._eraseAllLayers()) {
      this.board.beginStrokeAllLayers(user, 'destination-out', 1.0);
    } else {
      this.board.beginStroke(user, 'destination-out', 1.0);
    }
    
    this._drawSegment(user, pos, pos);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this._drawSegment(user, this.lastPos, pos);
    this.lastPos = { x: pos.x, y: pos.y };
  }

  onPointerUp(user) {
    if (this._eraseAllLayers()) {
      this.board.endStrokeAllLayers(user);
    } else {
      this.board.endStroke(user);
    }
    this.lastPos = null;
  }

  /**
   * Draw a segment at 100% opacity into the active stroke canvas(es).
   */
  _drawSegment(user, p1, p2) {
    const size = user.pressure * this.userSize * 2;
    const userId = user.id;

    if (this._eraseAllLayers()) {
      const ctxs = this.board.getAllLayerContexts(userId);
      for (const ctx of ctxs) {
        this._renderSegmentToCtx(ctx, p1, p2, size);
      }
    } else {
      const ctx = this.board.getActiveLayerContext('destination-out');
      if (ctx) {
        this._renderSegmentToCtx(ctx, p1, p2, size);
      }
    }

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const m1 = { x: width - p1.x, y: p1.y };
      const m2 = { x: width - p2.x, y: p2.y };
      if (this._eraseAllLayers()) {
        const ctxs = this.board.getAllLayerContexts(userId);
        for (const ctx of ctxs) {
          this._renderSegmentToCtx(ctx, m1, m2, size);
        }
      } else {
        const ctx = this.board.getActiveLayerContext('destination-out');
        if (ctx) {
          this._renderSegmentToCtx(ctx, m1, m2, size);
        }
      }
    }

    // Update dirty rect for the drawn segment with 25% safety margin
    const radius = size / 2;
    const safetyMargin = radius * 0.25; // 25% additional margin
    const margin = radius + safetyMargin + 2; // +2 for anti-aliasing

    const minX = Math.min(p1.x, p2.x) - margin;
    const minY = Math.min(p1.y, p2.y) - margin;
    const maxX = Math.max(p1.x, p2.x) + margin;
    const maxY = Math.max(p1.y, p2.y) + margin;

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    const w = Math.ceil(maxX) - x;
    const h = Math.ceil(maxY) - y;

    if (this._eraseAllLayers()) {
      this.board.expandDirtyRectAllLayers(user, x, y, w, h);
    } else {
      this.board.expandDirtyRect(user, x, y, w, h);
    }

    // Also update mirrored dirty rect if mirror mode is enabled
    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirrorMinX = width - maxX;
      const mirrorX = Math.floor(mirrorMinX);
      if (this._eraseAllLayers()) {
        this.board.expandDirtyRectAllLayers(user, mirrorX, y, w, h);
      } else {
        this.board.expandDirtyRect(user, mirrorX, y, w, h);
      }
    }

    this.board.requestUpdate();
  }

  _renderSegmentToCtx(ctx, p1, p2, size) {
    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Remote drawing handler.
   * Also updates the active stroke's dirtyRect so commitUserStroke doesn't discard it.
   */
  eraseOnGroup(group, x1, y1, x2, y2, size, _opacity, userId) {
    const active = group.activeStrokeByUser?.get(userId);
    if (active?.ctx) {
      active.opacity = 1.0; // Force 1.0 for remote erasers too
      this._renderSegmentToCtx(active.ctx, { x: x1, y: y1 }, { x: x2, y: y2 }, size);
      // Track dirty rect so commitUserStroke doesn't discard this stroke as "empty"
      if (active.dirtyRect) {
        const radius = size / 2;
        const margin = radius * 1.25 + 2;
        const dr = active.dirtyRect;
        dr.minX = Math.min(dr.minX, Math.floor(Math.min(x1, x2) - margin));
        dr.minY = Math.min(dr.minY, Math.floor(Math.min(y1, y2) - margin));
        dr.maxX = Math.max(dr.maxX, Math.ceil(Math.max(x1, x2) + margin));
        dr.maxY = Math.max(dr.maxY, Math.ceil(Math.max(y1, y2) + margin));
      }
    }
  }
}
