/**
 * @fileoverview Collection of tools for drawing basic shapes like lines, rectangles, and circles.
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
 * Line tool for drawing straight lines.
 */
export class LineTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('line', board);
    this.startPos = null;
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this._activeUser && this.startPos) {
      this.onPointerUp(this._activeUser, this.board.lastMousePos || this.startPos);
    }
    this.startPos = null;
    this._activeUser = null;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.board.beginStroke(user);
    this.startPos = { x: pos.x, y: pos.y };
    user.startPos = this.startPos; 
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(this.board.topCtx, user, this.startPos, pos);
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    const layerCtx = this.board.getActiveLayerContext();
    this.drawLine(layerCtx, user, this.startPos, pos);

    this.board.forEachMirrorRegion({ points: [this.startPos, pos] }, (region) => {
      this.board.withMirrorRegionClip(layerCtx, region, () => {
        this.drawLine(
          layerCtx,
          user,
          this.board.mirrorPointToRegion(this.startPos, region),
          this.board.mirrorPointToRegion(pos, region)
        );
      });
    });

    const radius = user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1.0 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    const safetyMargin = radius * 0.1;
    const margin = radius + blurAmount + safetyMargin + 2;

    const minX = Math.min(this.startPos.x, pos.x) - margin;
    const minY = Math.min(this.startPos.y, pos.y) - margin;
    const maxX = Math.max(this.startPos.x, pos.x) + margin;
    const maxY = Math.max(this.startPos.y, pos.y) + margin;

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    const width = Math.ceil(maxX) - x;
    const height = Math.ceil(maxY) - y;

    this.board.expandDirtyRect(user, x, y, width, height);

    this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
      const mirroredStart = this.board.mirrorPointToRegion(this.startPos, region);
      const mirroredEnd = this.board.mirrorPointToRegion(pos, region);
      const mirrorMinX = Math.min(mirroredStart.x, mirroredEnd.x) - margin;
      const mirrorMinY = Math.min(mirroredStart.y, mirroredEnd.y) - margin;
      const mirrorMaxX = Math.max(mirroredStart.x, mirroredEnd.x) + margin;
      const mirrorMaxY = Math.max(mirroredStart.y, mirroredEnd.y) + margin;
      this.board.expandDirtyRect(
        user,
        Math.floor(mirrorMinX),
        Math.floor(mirrorMinY),
        Math.ceil(mirrorMaxX) - Math.floor(mirrorMinX),
        Math.ceil(mirrorMaxY) - Math.floor(mirrorMinY)
      );
    });

    // Track tile ownership for the line
    const linePoints = [this.startPos, pos];
    this.board.markDirtyPath(user, linePoints, margin);
    this.board.forEachMirrorRegion({ points: linePoints }, (region) => {
      this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(linePoints, region), margin);
    });

    this.board.clearTop();
    this.startPos = null;

    this.board.endStroke(user);
  }

  /**
   * Draws a preview of the line.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawPreview(ctx, user, start, end) {
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      this.drawLine(ctx, user, start, end);

      this.board.forEachMirrorRegion({ points: [start, end] }, (region) => {
        this.board.withMirrorRegionClip(ctx, region, () => {
          this.drawLine(
            ctx,
            user,
            this.board.mirrorPointToRegion(start, region),
            this.board.mirrorPointToRegion(end, region)
          );
        });
      });
    });
  }

  /**
   * Draws the actual line onto the context.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawLine(ctx, user, start, end) {
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = (user.hardness !== undefined ? user.hardness : 100) / 100;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.size * 2;

    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      const offset = 100000;

      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user.getColorString();
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;

      ctx.save();
      ctx.translate(offset, 0);
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Rectangle tool for drawing rectangles.
 */
export class RectangleTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('rectangle', board);
    this.startPos = null;
    this.drawMode = 'corner-to-corner';
  }

  /**
   * Updates rectangle draw mode.
   * @param {string} mode - Draw mode value.
   */
  setDrawMode(mode) {
    this.drawMode = mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
  }

  /**
   * Returns whether Shift snapping is currently active.
   * @returns {boolean}
   */
  isSnapConstrained() {
    return !!this.board?.app?.isShiftModifierActive?.();
  }

  /**
   * Computes rectangle bounds for current draw mode.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   * @param {boolean} constrain - Whether to enforce square proportions.
   * @returns {{x:number, y:number, w:number, h:number}}
   */
  getRectBounds(start, end, constrain) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (this.drawMode === 'center-scaling') {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      const halfW = side;
      const halfH = side;

      return {
        x: start.x - halfW,
        y: start.y - halfH,
        w: halfW * 2,
        h: halfH * 2
      };
    }

    if (!constrain) {
      return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        w: Math.abs(dx),
        h: Math.abs(dy)
      };
    }

    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
    const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
    const x2 = start.x + sx * side;
    const y2 = start.y + sy * side;

    return {
      x: Math.min(start.x, x2),
      y: Math.min(start.y, y2),
      w: Math.abs(x2 - start.x),
      h: Math.abs(y2 - start.y)
    };
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this._activeUser && this.startPos) {
      this.onPointerUp(this._activeUser, this.board.lastMousePos || this.startPos);
    }
    this.startPos = null;
    this._activeUser = null;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.board.beginStroke(user);
    this.startPos = { x: pos.x, y: pos.y };
    this.drawPreview(user, pos);
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    const constrained = this.isSnapConstrained();
    const rectBounds = this.getRectBounds(this.startPos, pos, constrained);

    const layerCtx = this.board.getActiveLayerContext();
    this.drawRect(layerCtx, user, this.startPos, pos);

    this.board.forEachMirrorRegion({ points: [this.startPos, pos] }, (region) => {
      this.board.withMirrorRegionClip(layerCtx, region, () => {
        this.drawRect(
          layerCtx,
          user,
          this.board.mirrorPointToRegion(this.startPos, region),
          this.board.mirrorPointToRegion(pos, region)
        );
      });
    });

    const radius = user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1.0 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    const safetyMargin = radius * 0.1;
    const margin = radius + blurAmount + safetyMargin + 2;

    const minX = rectBounds.x - margin;
    const minY = rectBounds.y - margin;
    const maxX = rectBounds.x + rectBounds.w + margin;
    const maxY = rectBounds.y + rectBounds.h + margin;

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    const width = Math.ceil(maxX) - x;
    const height = Math.ceil(maxY) - y;

    this.board.expandDirtyRect(user, x, y, width, height);

    this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
      const mirroredStart = this.board.mirrorPointToRegion(this.startPos, region);
      const mirroredEnd = this.board.mirrorPointToRegion(pos, region);
      const mirroredBounds = this.getRectBounds(mirroredStart, mirroredEnd, constrained);
      const rx1 = mirroredBounds.x - margin;
      const ry1 = mirroredBounds.y - margin;
      const rx2 = mirroredBounds.x + mirroredBounds.w + margin;
      const ry2 = mirroredBounds.y + mirroredBounds.h + margin;
      this.board.expandDirtyRect(user, Math.floor(rx1), Math.floor(ry1), Math.ceil(rx2) - Math.floor(rx1), Math.ceil(ry2) - Math.floor(ry1));
    });

    // Track tile ownership for the rectangle perimeter
    const rectPoints = [
      { x: rectBounds.x, y: rectBounds.y },
      { x: rectBounds.x + rectBounds.w, y: rectBounds.y },
      { x: rectBounds.x + rectBounds.w, y: rectBounds.y + rectBounds.h },
      { x: rectBounds.x, y: rectBounds.y + rectBounds.h },
      { x: rectBounds.x, y: rectBounds.y }
    ];
    this.board.markDirtyPath(user, rectPoints, margin);
    this.board.forEachMirrorRegion({ points: rectPoints }, (region) => {
      this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(rectPoints, region), margin);
    });

    this.board.clearTop();
    this.startPos = null;

    this.board.endStroke(user);
  }

  /**
   * Draws a preview of the rectangle.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  drawPreview(user, pos) {
    const ctx = this.board.topCtx;
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      this.drawRect(ctx, user, this.startPos, pos);

      this.board.forEachMirrorRegion({ points: [this.startPos, pos] }, (region) => {
        this.board.withMirrorRegionClip(ctx, region, () => {
          this.drawRect(
            ctx,
            user,
            this.board.mirrorPointToRegion(this.startPos, region),
            this.board.mirrorPointToRegion(pos, region)
          );
        });
      });
    });
  }

  /**
   * Draws the actual rectangle onto the context.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawRect(ctx, user, start, end) {
    const constrain = this.isSnapConstrained();
    const { x, y, w, h } = this.getRectBounds(start, end, constrain);

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = (user.hardness !== undefined ? user.hardness : 100) / 100;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.size * 2;

    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      const offset = 100000;

      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user.getColorString();
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;

      ctx.save();
      ctx.translate(offset, 0);
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.stroke();

    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Circle tool for drawing circles/ellipses.
 */
export class CircleTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('circle', board);
    this.startPos = null;
    this.drawMode = 'corner-to-corner';
  }

  /**
   * Updates circle draw mode.
   * @param {string} mode - Draw mode value.
   */
  setDrawMode(mode) {
    this.drawMode = mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
  }

  /**
   * Returns whether Shift snapping is currently active.
   * @returns {boolean}
   */
  isSnapConstrained() {
    return !!this.board?.app?.isShiftModifierActive?.();
  }

  /**
   * Computes ellipse geometry for current draw mode.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   * @param {boolean} constrain - Whether to enforce circle proportions.
   * @returns {{cx:number, cy:number, rx:number, ry:number}}
   */
  getEllipseParams(start, end, constrain) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (this.drawMode === 'center-scaling') {
      const radius = Math.hypot(dx, dy);
      return {
        cx: start.x,
        cy: start.y,
        rx: radius,
        ry: radius
      };
    }

    if (!constrain) {
      return {
        cx: (start.x + end.x) / 2,
        cy: (start.y + end.y) / 2,
        rx: Math.abs(dx) / 2,
        ry: Math.abs(dy) / 2
      };
    }

    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
    const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
    const x2 = start.x + sx * side;
    const y2 = start.y + sy * side;

    return {
      cx: (start.x + x2) / 2,
      cy: (start.y + y2) / 2,
      rx: Math.abs(x2 - start.x) / 2,
      ry: Math.abs(y2 - start.y) / 2
    };
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this._activeUser && this.startPos) {
      this.onPointerUp(this._activeUser, this.board.lastMousePos || this.startPos);
    }
    this.startPos = null;
    this._activeUser = null;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this.board.beginStroke(user);
    this.startPos = { x: pos.x, y: pos.y };
    this.drawPreview(user, pos);
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    const constrained = this.isSnapConstrained();
    const ellipse = this.getEllipseParams(this.startPos, pos, constrained);

    const layerCtx = this.board.getActiveLayerContext();
    this.drawEllipse(layerCtx, user, this.startPos, pos);

    this.board.forEachMirrorRegion({ points: [this.startPos, pos] }, (region) => {
      this.board.withMirrorRegionClip(layerCtx, region, () => {
        this.drawEllipse(
          layerCtx,
          user,
          this.board.mirrorPointToRegion(this.startPos, region),
          this.board.mirrorPointToRegion(pos, region)
        );
      });
    });

    const radius = user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1.0 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    const safetyMargin = radius * 0.1;
    const margin = radius + blurAmount + safetyMargin + 2;

    const minX = (ellipse.cx - ellipse.rx) - margin;
    const minY = (ellipse.cy - ellipse.ry) - margin;
    const maxX = (ellipse.cx + ellipse.rx) + margin;
    const maxY = (ellipse.cy + ellipse.ry) + margin;

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    const width = Math.ceil(maxX) - x;
    const height = Math.ceil(maxY) - y;

    this.board.expandDirtyRect(user, x, y, width, height);

    this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
      const mirroredStart = this.board.mirrorPointToRegion(this.startPos, region);
      const mirroredEnd = this.board.mirrorPointToRegion(pos, region);
      const mirroredEllipse = this.getEllipseParams(mirroredStart, mirroredEnd, constrained);
      const ex1 = (mirroredEllipse.cx - mirroredEllipse.rx) - margin;
      const ey1 = (mirroredEllipse.cy - mirroredEllipse.ry) - margin;
      const ex2 = (mirroredEllipse.cx + mirroredEllipse.rx) + margin;
      const ey2 = (mirroredEllipse.cy + mirroredEllipse.ry) + margin;
      this.board.expandDirtyRect(user, Math.floor(ex1), Math.floor(ey1), Math.ceil(ex2) - Math.floor(ex1), Math.ceil(ey2) - Math.floor(ey1));
    });

    // Track tile ownership for the ellipse perimeter
    const ellipsePoints = [];
    const steps = Math.max(16, Math.ceil(Math.max(ellipse.rx, ellipse.ry) / 8));
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      ellipsePoints.push({ x: ellipse.cx + ellipse.rx * Math.cos(angle), y: ellipse.cy + ellipse.ry * Math.sin(angle) });
    }
    this.board.markDirtyPath(user, ellipsePoints, margin);
    this.board.forEachMirrorRegion({ points: ellipsePoints }, (region) => {
      this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(ellipsePoints, region), margin);
    });

    this.board.clearTop();
    this.startPos = null;

    this.board.endStroke(user);
  }

  /**
   * Draws a preview of the ellipse.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  drawPreview(user, pos) {
    const ctx = this.board.topCtx;
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      this.drawEllipse(ctx, user, this.startPos, pos);

      this.board.forEachMirrorRegion({ points: [this.startPos, pos] }, (region) => {
        this.board.withMirrorRegionClip(ctx, region, () => {
          this.drawEllipse(
            ctx,
            user,
            this.board.mirrorPointToRegion(this.startPos, region),
            this.board.mirrorPointToRegion(pos, region)
          );
        });
      });
    });
  }

  /**
   * Draws the actual ellipse onto the context.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawEllipse(ctx, user, start, end) {
    const constrain = this.isSnapConstrained();
    const { cx, cy, rx, ry } = this.getEllipseParams(start, end, constrain);

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = (user.hardness !== undefined ? user.hardness : 100) / 100;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.size * 2;

    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      const offset = 100000;

      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user.getColorString();
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;

      ctx.save();
      ctx.translate(offset, 0);
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }
}
