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
 */
export class BrushTool extends Tool {
  constructor(board) {
    super('brush', board);
    // Smoothing buffer for stroke stabilization
    this.smoothBuffer = { x: 0, y: 0 };
    this.isFirstPoint = true;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Apply exponential moving average smoothing to position
   * Combines baseline smoothing (always-on) with user's smoothing setting
   * @param {number} targetX - Target X position
   * @param {number} targetY - Target Y position
   * @param {number} userSmoothing - User's smoothing factor (0-1)
   */
  smoothPosition(targetX, targetY, userSmoothing) {
    // Combine baseline (12%) with user smoothing additively
    const baselineEma = 0.12;
    const totalSmoothing = baselineEma + userSmoothing * (1 - baselineEma);

    if (this.isFirstPoint || totalSmoothing === 0) {
      this.smoothBuffer.x = targetX;
      this.smoothBuffer.y = targetY;
      this.isFirstPoint = false;
      return { x: targetX, y: targetY };
    }

    // Higher smoothing = more lag/stabilization (lerp factor becomes smaller)
    const factor = 1 - totalSmoothing * 0.9;
    this.smoothBuffer.x += (targetX - this.smoothBuffer.x) * factor;
    this.smoothBuffer.y += (targetY - this.smoothBuffer.y) * factor;

    return {
      x: this.smoothBuffer.x,
      y: this.smoothBuffer.y
    };
  }

  onPointerDown(user, pos) {
    this.isFirstPoint = true;
    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    user.currentLine.push(smoothedPos);
    user.currentLine.push(smoothedPos);
    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    user.currentLine.push(smoothedPos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.topCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.topCtx, user);
    }

    user.lineLength += manhattanDistance(smoothedPos, lastPos);
  }

  onPointerUp(user) {
    if (user.panning) return;

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
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
      console.log(`[DrawDebug] LOCAL user=${user.id} draw #${user._mainCtxDrawCount} to mainCtx, ${points.length} points, lineWidth=${user.pressure * user.size * 2}`);
    }

    // Apply user opacity (independent of color alpha)
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Explicitly set ALL context properties to ensure consistency
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = user.pressure * user.size * 2;

    // Apply softness using shadow blur (hardness controls blur amount)
    // For soft brushes, draw off-screen and use shadow only
    if (hardness < 1.0) {
      // Calculate blur based on hardness
      const blurAmount = (1 - hardness) * user.size * 1.5;
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
  }

  commitCurrentLine(user) {
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
    user.currentLine.push({ x: user.x, y: user.y });
  }
}
