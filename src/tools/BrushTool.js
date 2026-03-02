import { manhattanDistance, mirrorLine, calcCatmullRomCurve } from '../utils/drawing.js';

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
 * Brush tool for drawing lines
 *
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring perfect parity between local preview and remote rendering.
 */
export class BrushTool extends Tool {
  constructor(board) {
    super('brush', board);
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  onPointerDown(user, pos) {
    this.board.beginStroke(user);

    // Position is already smoothed by InputBufferManager
    user.currentLine.push(pos);
    user.currentLine.push(pos);
    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    // Position is already smoothed by InputBufferManager
    user.currentLine.push(pos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.topCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.topCtx, user);
    }

    user.lineLength += manhattanDistance(pos, lastPos);
  }

  onPointerUp(user) {
    if (user.panning) return;

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    this.drawLineArray(user.currentLine, layerCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, layerCtx, user);
    }

    user.clearLine();

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
    this.board.endStroke(user);
  }

  drawPreview(user) {
    this.drawLineArray(user.currentLine, this.board.topCtx, user);
  }

  drawLineArray(points, ctx, user) {
    if (points.length === 0) return;

    // Debug: Track draws to mainCtx
    const isMainCtx = ctx === this.board.mainCtx;
    if (isMainCtx) {
      user._mainCtxDrawCount = (user._mainCtxDrawCount || 0) + 1;
    }

    // Check if we're drawing to the active layer (not a preview)
    const isActiveLayer = ctx !== this.board.topCtx && ctx !== this.board.mainCtx && ctx !== this.board.upperLayersCtx;

    // Apply user opacity (independent of color alpha)
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Strokes are always drawn source-over into sub-layers; the blend mode is applied
    // at composite time when the sub-layer is composited onto the main canvas.
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = user.pressure * user.size * 2;

    // Apply softness using shadow blur (hardness controls blur amount)
    // For soft brushes, draw off-screen and use shadow only
    if (hardness < 1.0) {
      // Hybrid blur: 20px base + 20% of size gives consistent softness across all brush sizes
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      const offset = 100000; // Draw way off-screen

      ctx.strokeStyle = user.getColorString();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user.getColorString();
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;

      // Save context and translate to draw off-screen
      ctx.save();
      ctx.translate(offset, 0);
    } else {
      ctx.strokeStyle = user.getColorString();
      ctx.shadowBlur = 0;
    }

    // Apply Level 2 smoothing (Catmull-Rom) if enabled
    const smoothing = user.smoothing || 0; // 0-1 range

    if (smoothing > 0 && points.length >= 3) {
      // Use Catmull-Rom curves for smooth rendering
      const tension = smoothing; // 0.0 to 1.0
      const smoothedPoints = calcCatmullRomCurve(points, tension);

      // Draw as bezier curves
      ctx.beginPath();
      ctx.moveTo(smoothedPoints[0].x, smoothedPoints[0].y);

      // smoothedPoints format: [p1, cp1, cp2, p2, cp1, cp2, p3, ...]
      for (let i = 1; i < smoothedPoints.length - 2; i += 3) {
        const cp1 = smoothedPoints[i];
        const cp2 = smoothedPoints[i + 1];
        const end = smoothedPoints[i + 2];
        ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
      }
      ctx.stroke();
    } else {
      // Original linear rendering for low/no smoothing
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }

    // Reset shadow and restore context if using soft brush
    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;

    // Update dirty rect if drawing to active layer
    if (isActiveLayer && points.length > 0) {
      // Calculate bounding box of all points
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }

      // Expand by brush radius plus blur, with 25% safety margin
      const radius = user.pressure * user.size;
      const blurAmount = hardness < 1.0 ? (1 - hardness) * (20 + user.size * 0.2) : 0;
      const safetyMargin = radius * 0.25; // 25% additional margin for blur/hardness
      const margin = radius + blurAmount + safetyMargin + 2; // +2 for anti-aliasing

      const x = Math.floor(minX - margin);
      const y = Math.floor(minY - margin);
      const width = Math.ceil(maxX - minX + margin * 2);
      const height = Math.ceil(maxY - minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);
    }
  }

  commitCurrentLine(user, newPressure, newSize) {
    this.board.clearTop();
    this.board.topCtx.beginPath();

    // Old segment draws with current user.pressure (still the old value
    // because callers commit BEFORE calling setPressure)
    const oldRadius = user.pressure * user.size;
    const newRadius = (newPressure ?? user.pressure) * (newSize ?? user.size);

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    this.drawLineArray(user.currentLine, layerCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, layerCtx, user);
    }

    // Save last smoothed position (where old segment visually ends)
    const lastSmoothedPos = user.currentLine.length > 0
      ? user.currentLine[user.currentLine.length - 1]
      : { x: user.x, y: user.y };

    // Bridge the gap between old segment end and new segment start
    // using interpolated filled circles (flow-pen style)
    if (user.currentLine.length > 0) {
      const from = lastSmoothedPos;
      this.bridgeGap(layerCtx, from, lastSmoothedPos, oldRadius, newRadius, user);
      if (this.board.mirror) {
        const w = this.board.getWidth();
        this.bridgeGap(layerCtx,
          { x: w - from.x, y: from.y },
          { x: w - lastSmoothedPos.x, y: lastSmoothedPos.y },
          oldRadius, newRadius, user);
      }
    }

    user.clearLine();
    user.currentLine.push(lastSmoothedPos);

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
  }

  /** Bridge gap between two points with interpolated filled circles (flow-pen style) */
  bridgeGap(ctx, from, to, fromRadius, toRadius, user) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Check if we're drawing to the active layer (not a preview)
    const isActiveLayer = ctx !== this.board.topCtx && ctx !== this.board.mainCtx && ctx !== this.board.upperLayersCtx;

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Strokes always drawn source-over into sub-layers; blend applied at composite time.
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = user.getColorString();

    if (hardness < 1.0) {
      // Hybrid blur: 20px base + 20% of size gives consistent softness across all brush sizes
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      const offset = 100000;
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user.getColorString();
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.translate(offset, 0);
    }

    if (dist < 0.5) {
      const r = Math.max(fromRadius, toRadius);
      ctx.beginPath();
      ctx.arc(from.x, from.y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Adaptive spacing (20% of average radius, like flow pen)
      const avgRadius = (fromRadius + toRadius) / 2;
      const step = Math.max(1, avgRadius * 0.2);
      const steps = Math.ceil(dist / step);

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + dx * t;
        const y = from.y + dy * t;
        const r = fromRadius + (toRadius - fromRadius) * t;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Update dirty rect if drawing to active layer
    if (isActiveLayer) {
      const maxRadius = Math.max(fromRadius, toRadius);
      const blurAmount = hardness < 1.0 ? (1 - hardness) * (20 + user.size * 0.2) : 0;
      const safetyMargin = maxRadius * 0.25; // 25% additional margin for blur/hardness
      const margin = maxRadius + blurAmount + safetyMargin + 2; // +2 for anti-aliasing

      const minX = Math.min(from.x, to.x) - margin;
      const minY = Math.min(from.y, to.y) - margin;
      const maxX = Math.max(from.x, to.x) + margin;
      const maxY = Math.max(from.y, to.y) + margin;

      const x = Math.floor(minX);
      const y = Math.floor(minY);
      const width = Math.ceil(maxX - minX);
      const height = Math.ceil(maxY - minY);

      this.board.expandDirtyRect(user, x, y, width, height);
    }

    ctx.restore();
  }
}
