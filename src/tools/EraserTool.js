/**
 * @fileoverview Eraser tool.
 * Each eraser gesture is stored as a single active stroke with blendMode 'destination-out'.
 */

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Eraser tool for removing content from layers.
 */
export class EraserTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('erase', board);
    this.userSize = 10;
    this.lastPos = null;
    // Track erased tile indices for ownership checking
    this._erasedTiles = null;
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this.lastPos && this._activeUser) {
      this.onPointerUp(this._activeUser);
    }
    this._activeUser = null;
  }

  /**
   * Checks if erasing should apply to all layers.
   * @private
   * @returns {boolean} - True if all layers should be erased.
   */
  _eraseAllLayers() {
    return this.board.app?.eraseAllLayers ?? false;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.userSize = user.size;
    this.lastPos = { x: pos.x, y: pos.y };
    // Initialize erased tiles tracking
    this._erasedTiles = new Set();

    if (this._eraseAllLayers()) {
      this.board.beginStrokeAllLayers(user, 'destination-out', 1.0);
    } else {
      this.board.beginStroke(user, 'destination-out', 1.0);
    }

    this._drawSegment(user, pos, pos);
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this._drawSegment(user, this.lastPos, pos);
    this.lastPos = { x: pos.x, y: pos.y };
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   */
  onPointerUp(user) {
    // Copy erased tiles to active stroke's affectedTiles before committing
    if (this._erasedTiles && this._erasedTiles.size > 0) {
      const activeLayer = user?.activeLayer ?? 0;
      const userId = user?.id ?? 0;

      if (this._eraseAllLayers()) {
        // For erase-all, add to all layers' active strokes
        const lm = this.board.layerManager;
        if (lm) {
          for (const group of lm.layerGroups) {
            const active = group.activeStrokeByUser.get(userId);
            if (active?.affectedTiles) {
              for (const idx of this._erasedTiles) active.affectedTiles.add(idx);
            }
          }
        }
      } else {
        const group = this.board.layerManager?.layerGroups[activeLayer];
        const active = group?.activeStrokeByUser.get(userId);
        if (active?.affectedTiles) {
          for (const idx of this._erasedTiles) active.affectedTiles.add(idx);
        }
      }
    }

    if (this._eraseAllLayers()) {
      this.board.endStrokeAllLayers(user);
    } else {
      this.board.endStroke(user);
    }

    // Check tile ownership after erase
    if (this._erasedTiles && this._erasedTiles.size > 0) {
      // Force composite so mainCtx reflects the erased state before checking
      this.board.compositeAllLayers();

      this.board.checkErasedTilesByIndices(this._erasedTiles);
    }

    this.lastPos = null;
    this._erasedTiles = null;
  }

  /**
   * Draw a segment at 100% opacity into the active stroke canvas(es).
   * @private
   * @param {Object} user - The user performing the action.
   * @param {Object} p1 - Start point of the segment.
   * @param {Object} p2 - End point of the segment.
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

    const radius = size / 2;
    const safetyMargin = radius * 0.25;
    const margin = radius + safetyMargin + 2;

    const minX = Math.min(p1.x, p2.x) - margin;
    const minY = Math.min(p1.y, p2.y) - margin;
    const maxX = Math.max(p1.x, p2.x) + margin;
    const maxY = Math.max(p1.y, p2.y) + margin;

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    const w = Math.ceil(maxX) - x;
    const h = Math.ceil(maxY) - y;

    // Track erased tiles along the stroke path
    if (this._erasedTiles && this.board.tileTracker) {
      this.board.tileTracker.collectTilesFromPath([p1, p2], radius, this._erasedTiles);
    }

    if (this._eraseAllLayers()) {
      this.board.expandDirtyRectAllLayers(user, x, y, w, h);
    } else {
      this.board.expandDirtyRect(user, x, y, w, h);
    }

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirrorMinX = width - maxX;
      const mirrorX = Math.floor(mirrorMinX);
      if (this._eraseAllLayers()) {
        this.board.expandDirtyRectAllLayers(user, mirrorX, y, w, h);
      } else {
        this.board.expandDirtyRect(user, mirrorX, y, w, h);
      }
      // Track mirror tiles
      if (this._erasedTiles && this.board.tileTracker) {
        const m1 = { x: width - p1.x, y: p1.y };
        const m2 = { x: width - p2.x, y: p2.y };
        this.board.tileTracker.collectTilesFromPath([m1, m2], radius, this._erasedTiles);
      }
    }

    this.board.requestUpdate();
  }

  /**
   * Renders a segment to the given context.
   * @private
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} p1 - Start point.
   * @param {Object} p2 - End point.
   * @param {number} size - Line width.
   */
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
   * Remote drawing handler for erasers.
   * @param {Object} group - The layer group.
   * @param {number} x1 - Start x.
   * @param {number} y1 - Start y.
   * @param {number} x2 - End x.
   * @param {number} y2 - End y.
   * @param {number} size - Eraser size.
   * @param {number} _opacity - Unused opacity.
   * @param {string} userId - ID of the user erasing.
   */
  eraseOnGroup(group, x1, y1, x2, y2, size, _opacity, userId) {
    const active = group.activeStrokeByUser?.get(userId);
    if (active?.ctx) {
      active.opacity = 1.0;
      this._renderSegmentToCtx(active.ctx, { x: x1, y: y1 }, { x: x2, y: y2 }, size);
      const radius = size / 2;
      if (active.dirtyRect) {
        const margin = radius * 1.25 + 2;
        const dr = active.dirtyRect;
        dr.minX = Math.min(dr.minX, Math.floor(Math.min(x1, x2) - margin));
        dr.minY = Math.min(dr.minY, Math.floor(Math.min(y1, y2) - margin));
        dr.maxX = Math.max(dr.maxX, Math.ceil(Math.max(x1, x2) + margin));
        dr.maxY = Math.max(dr.maxY, Math.ceil(Math.max(y1, y2) + margin));
      }
      // Track erased tiles for remote users (same as local eraser)
      if (active.affectedTiles && this.board.tileTracker) {
        this.board.tileTracker.collectTilesFromPath(
          [{ x: x1, y: y1 }, { x: x2, y: y2 }], radius, active.affectedTiles
        );
      }
    }
  }
}
