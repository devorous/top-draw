/**
 * @fileoverview Pixel brush tool - draws filled square stamps
 */

/**
 * Brush tool that draws hard-edged square stamps using fillRect
 */
export class PixelBrushTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'pixel';
    this.board = board;
    this.lastStampPos = new Map(); // userId -> {x, y}
    this.tempCanvases = new Map(); // userId -> temp canvas for opacity handling
    this.stampBuffer = []; // [x, y, x, y, ...] accumulated stamp positions for broadcast
    this.strokePoints = []; // Track points for tile ownership
  }

  activate() {}

  deactivate() {
    if (this._activeUser && this.tempCanvases.has(this._activeUser.id)) {
      const lastStamp = this.lastStampPos.get(this._activeUser.id);
      this.onPointerUp(this._activeUser, lastStamp || { x: 0, y: 0 });
    }
    this.lastStampPos.clear();
    this.tempCanvases.clear();
    this._activeUser = null;
  }

  /**
   * Begin drawing
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerDown(user, pos, e) {
    this._activeUser = user;
    this.board.beginStroke(user);

    // Create temp canvas for this stroke (prevents opacity stacking)
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.board.getWidth();
    tempCanvas.height = this.board.getHeight();
    this.tempCanvases.set(user.id, tempCanvas);

    this.strokePoints = [{ x: pos.x, y: pos.y }];
    this.drawSquare(user, pos, true);
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
  }

  /**
   * Continue drawing
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Object} lastPos - Last position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this.drawSquare(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.requestUpdate();
      return;
    }

    const size = Math.max(1, Math.round((user.size || 5) * 2));

    // Special handling for size 1: draw every pixel along the line (no gaps)
    if (size === 1) {
      const linePoints = this.drawPixelLine(user, lastStamp, pos, true);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      for (const point of linePoints) {
        this.stampBuffer.push(point.x, point.y);
        this.strokePoints.push(point);
      }
    } else {
      const dx = pos.x - lastStamp.x;
      const dy = pos.y - lastStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Use spacing parameter (0-100 range)
      // 0 = very close (0.1x size), 50 = touching (1x size), 100 = far (5x size)
      const spacingPercent = user.spacing === 0 ? 0.1 : 0.1 + (user.spacing * 0.049);
      const minSpacing = Math.max(1, size * spacingPercent);

      if (distance >= minSpacing) {
        const steps = Math.max(1, Math.floor(distance / minSpacing));

        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const interpX = lastStamp.x + dx * t;
          const interpY = lastStamp.y + dy * t;
          this.drawSquare(user, { x: interpX, y: interpY }, true);
          this.stampBuffer.push(interpX, interpY);
          this.strokePoints.push({ x: interpX, y: interpY });
        }

        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      }
    }

    this.board.clearTop();
    this.drawPreview(user);
  }

  /**
   * Drains accumulated stamp positions for network broadcast.
   * @returns {{ps: number[], rs: number[]}}
   */
  drainStampBuffer() {
    const ps = this.stampBuffer;
    this.stampBuffer = [];
    // rs must be non-empty to trigger stamp mode on the remote side; values unused for pixel
    const rs = Array(ps.length / 2).fill(0);
    return { ps, rs };
  }

  /**
   * Applies pre-computed stamp positions received from the network (remote users).
   * Bypasses spacing recomputation entirely.
   * @param {Object} user - The remote user.
   * @param {number[]} ps - Flat [x, y, x, y, ...] stamp positions.
   */
  applyStamps(user, ps) {
    const points = [];
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      this.drawSquare(user, pos, true);
      points.push(pos);
    }
    // Track tile ownership for remote user
    if (points.length > 0) {
      const size = Math.max(1, Math.round((user.size || 5) * 2));
      this.board.markDirtyPath(user, points, size / 2);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), size / 2);
      });
    }
    this.board.clearTop();
    this.drawPreview(user);
  }

  /**
   * Draws a pixel-perfect line for size 1 (ensures no gaps)
   * @param {Object} user - The user performing the action
   * @param {Object} from - Start position {x, y}
   * @param {Object} to - End position {x, y}
   * @param {boolean} useTemp - Whether to draw to temp canvas
   */
  drawPixelLine(user, from, to, useTemp = false) {
    // Convert to integer pixel coordinates
    let x0 = Math.floor(from.x);
    let y0 = Math.floor(from.y);
    const x1 = Math.floor(to.x);
    const y1 = Math.floor(to.y);
    const points = [];

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    // Bresenham's line algorithm for pixel-perfect lines
    while (true) {
      const point = { x: x0, y: y0 };
      this.drawSquare(user, point, useTemp);
      points.push(point);

      if (x0 === x1 && y0 === y1) break;

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }

    return points;
  }

  /**
   * Clear the current stroke state (for cancellation)
   * @param {Object} user - User object (optional, defaults to clearing all)
   */
  clearStroke(user) {
    if (user) {
      this.tempCanvases.delete(user.id);
      this.lastStampPos.delete(user.id);
    } else {
      this.tempCanvases.clear();
      this.lastStampPos.clear();
    }
    this.strokePoints = [];
    this.stampBuffer = [];
    this.board.clearTop();
  }

  /**
   * End drawing
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerUp(user, pos, e) {
    if (user.panning) return;

    // Composite temp canvas to stroke canvas with opacity applied once
    const tempCanvas = this.tempCanvases.get(user.id);
    if (tempCanvas) {
      const ctx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
      if (ctx) {
        const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
        const finalAlpha = opacitySlider;

        ctx.globalAlpha = finalAlpha;
        ctx.drawImage(tempCanvas, 0, 0);
        ctx.globalAlpha = 1.0;

        // Mirror mode
        this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
          ctx.save();
          ctx.globalAlpha = finalAlpha;
          this.board.drawMirroredCanvas(ctx, tempCanvas, region, 0, 0);
          ctx.globalAlpha = 1.0;
          ctx.restore();
        });
      }
      this.tempCanvases.delete(user.id);
    }

    // Track tile ownership
    if (this.strokePoints.length > 0) {
      const size = Math.max(1, Math.round((user.size || 5) * 2));
      this.board.markDirtyPath(user, this.strokePoints, size / 2);
      this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(this.strokePoints, region), size / 2);
      });
    }
    this.strokePoints = [];

    this.board.clearTop();
    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
  }

  /**
   * Draws preview of current stroke to top canvas
   * @param {Object} user - The user performing the action
   */
  drawPreview(user) {
    const tempCanvas = this.tempCanvases.get(user.id);
    if (!tempCanvas) return;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    const finalAlpha = opacitySlider;

    const ctx = this.board.topCtx;
    if (!ctx) return;

    ctx.globalAlpha = finalAlpha;
    ctx.drawImage(tempCanvas, 0, 0);
    ctx.globalAlpha = 1.0;

    // Mirror mode
    this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
      ctx.save();
      ctx.globalAlpha = finalAlpha;
      this.board.drawMirroredCanvas(ctx, tempCanvas, region, 0, 0);
      ctx.globalAlpha = 1.0;
      ctx.restore();
    });
  }

  /**
   * Draws a single filled square at the given position
   * @param {Object} user - The user performing the action
   * @param {Object} pos - The position to draw the square
   * @param {boolean} useTemp - Whether to draw to temp canvas (prevents opacity stacking)
   */
  drawSquare(user, pos, useTemp = false) {
    // Round size to integer for pixel-perfect rendering (2x for proper cursor fill)
    const size = Math.max(1, Math.round((user.size || 5) * 2));

    // Get context - either temp canvas (full opacity) or stroke canvas (with opacity)
    let ctx;
    if (useTemp) {
      const tempCanvas = this.tempCanvases.get(user.id);
      if (!tempCanvas) return;
      ctx = tempCanvas.getContext('2d');
    } else {
      ctx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
      if (!ctx) return;
    }

    // Snap to pixel grid for hard edges (no anti-aliasing)
    const halfSize = Math.floor(size / 2);
    const x = Math.floor(pos.x - halfSize);
    const y = Math.floor(pos.y - halfSize);

    // Draw at full opacity to temp canvas (opacity applied once when compositing)
    const color = user.color.slice(0, 3);
    ctx.fillStyle = `rgb(${color.join(',')})`;
    ctx.fillRect(x, y, size, size);

    // Expand dirty rect (don't expand for mirror - handled in preview/composite)
    this.board.expandDirtyRect(user, x - 1, y - 1, size + 2, size + 2);
  }
}
