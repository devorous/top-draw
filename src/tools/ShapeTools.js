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
 * Line tool for drawing straight lines
 */
export class LineTool extends Tool {
  constructor(board) {
    super('line', board);
    this.startPos = null;
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  onPointerDown(user, pos) {
    this.startPos = { x: pos.x, y: pos.y };
    user.startPos = this.startPos; // Store on user for remote sync
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(this.board.topCtx, user, this.startPos, pos);
  }

  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    this.drawLine(layerCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawLine(layerCtx, user, mirroredStart, mirroredEnd);
    }

    this.board.clearTop();
    this.startPos = null;

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
  }

  drawPreview(ctx, user, start, end) {
    this.drawLine(ctx, user, start, end);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - start.x, y: start.y };
      const mirroredEnd = { x: width - end.x, y: end.y };
      this.drawLine(ctx, user, mirroredStart, mirroredEnd);
    }
  }

  drawLine(ctx, user, start, end) {
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Use the layer's blend mode for layer context, source-over for preview
    const isPreview = ctx === this.board.topCtx;
    const blendMode = isPreview ? 'source-over' : this.board.getActiveLayerBlendMode();
    ctx.globalCompositeOperation = blendMode;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;

    // Apply softness using shadow blur
    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * user.size * 1.5;
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

    // Reset shadow and restore context if using soft brush
    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Rectangle tool for drawing rectangles
 */
export class RectangleTool extends Tool {
  constructor(board) {
    super('rectangle', board);
    this.startPos = null;
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  onPointerDown(user, pos) {
    this.startPos = { x: pos.x, y: pos.y };
    this.drawPreview(user, pos);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    this.drawRect(layerCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawRect(layerCtx, user, mirroredStart, mirroredEnd);
    }

    this.board.clearTop();
    this.startPos = null;

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
  }

  drawPreview(user, pos) {
    this.drawRect(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawRect(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  drawRect(ctx, user, start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Use the layer's blend mode for layer context, source-over for preview
    const isPreview = ctx === this.board.topCtx;
    const blendMode = isPreview ? 'source-over' : this.board.getActiveLayerBlendMode();
    ctx.globalCompositeOperation = blendMode;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;

    // Apply softness using shadow blur
    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * user.size * 1.5;
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

    // Reset shadow and restore context if using soft brush
    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Circle tool for drawing circles/ellipses
 */
export class CircleTool extends Tool {
  constructor(board) {
    super('circle', board);
    this.startPos = null;
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  onPointerDown(user, pos) {
    this.startPos = { x: pos.x, y: pos.y };
    this.drawPreview(user, pos);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    this.drawEllipse(layerCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawEllipse(layerCtx, user, mirroredStart, mirroredEnd);
    }

    this.board.clearTop();
    this.startPos = null;

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
  }

  drawPreview(user, pos) {
    this.drawEllipse(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawEllipse(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  drawEllipse(ctx, user, start, end) {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Use the layer's blend mode for layer context, source-over for preview
    const isPreview = ctx === this.board.topCtx;
    const blendMode = isPreview ? 'source-over' : this.board.getActiveLayerBlendMode();
    ctx.globalCompositeOperation = blendMode;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;

    // Apply softness using shadow blur
    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * user.size * 1.5;
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

    // Reset shadow and restore context if using soft brush
    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }
}
