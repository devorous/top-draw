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

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawLine(layerCtx, user, mirroredStart, mirroredEnd);
    }

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

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirrorMinX = width - maxX;
      const x_mirrored = Math.floor(mirrorMinX);
      const y_mirrored = Math.floor(minY);
      const width_mirrored = Math.ceil(width - minX) - x_mirrored;
      const height_mirrored = Math.ceil(maxY) - y_mirrored;

      this.board.expandDirtyRect(user, x_mirrored, y_mirrored, width_mirrored, height_mirrored);
    }

    // Track tile ownership for the line
    const linePoints = [this.startPos, pos];
    this.board.markDirtyPath(user, linePoints, margin);
    if (this.board.mirror) {
      const boardWidth = this.board.getWidth();
      const mirroredPoints = linePoints.map(pt => ({ x: boardWidth - pt.x, y: pt.y }));
      this.board.markDirtyPath(user, mirroredPoints, margin);
    }

    this.board.clearTop();
    this.startPos = null;

    this.board.compositeAllLayers();
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
    this.drawLine(ctx, user, start, end);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - start.x, y: start.y };
      const mirroredEnd = { x: width - end.x, y: end.y };
      this.drawLine(ctx, user, mirroredStart, mirroredEnd);
    }
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

    const layerCtx = this.board.getActiveLayerContext();
    this.drawRect(layerCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawRect(layerCtx, user, mirroredStart, mirroredEnd);
    }

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

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirrorMinX = width - maxX;
      const x_mirrored = Math.floor(mirrorMinX);
      const y_mirrored = Math.floor(minY);
      const width_mirrored = Math.ceil(width - minX) - x_mirrored;
      const height_mirrored = Math.ceil(maxY) - y_mirrored;

      this.board.expandDirtyRect(user, x_mirrored, y_mirrored, width_mirrored, height_mirrored);
    }

    // Track tile ownership for the rectangle perimeter
    const rectPoints = [
      this.startPos,
      { x: pos.x, y: this.startPos.y },
      pos,
      { x: this.startPos.x, y: pos.y },
      this.startPos
    ];
    this.board.markDirtyPath(user, rectPoints, margin);
    if (this.board.mirror) {
      const boardWidth = this.board.getWidth();
      const mirroredPoints = rectPoints.map(pt => ({ x: boardWidth - pt.x, y: pt.y }));
      this.board.markDirtyPath(user, mirroredPoints, margin);
    }

    this.board.clearTop();
    this.startPos = null;

    this.board.compositeAllLayers();
    this.board.endStroke(user);
  }

  /**
   * Draws a preview of the rectangle.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  drawPreview(user, pos) {
    this.drawRect(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawRect(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  /**
   * Draws the actual rectangle onto the context.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawRect(ctx, user, start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);

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

    const layerCtx = this.board.getActiveLayerContext();
    this.drawEllipse(layerCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawEllipse(layerCtx, user, mirroredStart, mirroredEnd);
    }

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

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirrorMinX = width - maxX;
      const x_mirrored = Math.floor(mirrorMinX);
      const y_mirrored = Math.floor(minY);
      const width_mirrored = Math.ceil(width - minX) - x_mirrored;
      const height_mirrored = Math.ceil(maxY) - y_mirrored;

      this.board.expandDirtyRect(user, x_mirrored, y_mirrored, width_mirrored, height_mirrored);
    }

    // Track tile ownership for the ellipse perimeter
    const cx = (this.startPos.x + pos.x) / 2;
    const cy = (this.startPos.y + pos.y) / 2;
    const rx = Math.abs(pos.x - this.startPos.x) / 2;
    const ry = Math.abs(pos.y - this.startPos.y) / 2;
    const ellipsePoints = [];
    const steps = Math.max(16, Math.ceil(Math.max(rx, ry) / 8));
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      ellipsePoints.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    }
    this.board.markDirtyPath(user, ellipsePoints, margin);
    if (this.board.mirror) {
      const boardWidth = this.board.getWidth();
      const mirroredPoints = ellipsePoints.map(pt => ({ x: boardWidth - pt.x, y: pt.y }));
      this.board.markDirtyPath(user, mirroredPoints, margin);
    }

    this.board.clearTop();
    this.startPos = null;

    this.board.compositeAllLayers();
    this.board.endStroke(user);
  }

  /**
   * Draws a preview of the ellipse.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  drawPreview(user, pos) {
    this.drawEllipse(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawEllipse(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  /**
   * Draws the actual ellipse onto the context.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawEllipse(ctx, user, start, end) {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;

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
