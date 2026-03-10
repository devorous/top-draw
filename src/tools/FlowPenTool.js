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
 * Flow Pen tool for pressure-sensitive strokes using circle stamping
 * Uses offscreen canvas to prevent opacity stacking when circles overlap
 *
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring perfect parity between local preview and remote rendering.
 */
export class FlowPenTool extends Tool {
  constructor(board) {
    super('flowPen', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.lastStampPos = null;
    this.userAlpha = 1.0;
    this.strokeColor = null;
    // Stamp buffer for remote sync — collects exact stamp positions as interleaved [x, y, r, ...], split on drain
    this.stampBuffer = [];
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
    this.ensureOffscreenCanvas();
  }

  ensureOffscreenCanvas() {
    const width = this.board.mainCanvas.width;
    const height = this.board.mainCanvas.height;

    if (!this.offscreenCanvas ||
        this.offscreenCanvas.width !== width ||
        this.offscreenCanvas.height !== height) {
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCanvas.width = width;
      this.offscreenCanvas.height = height;
      this.offscreenCtx = this.offscreenCanvas.getContext('2d');
    }
  }

  quantizePressure(pressure) {
    return Math.round(pressure * (this.pressureSteps - 1)) / (this.pressureSteps - 1);
  }

  getDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  onPointerDown(user, pos, e) {
    this.board.beginStroke(user);
    this.ensureOffscreenCanvas();

    // Clear offscreen canvas
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Store color at full opacity for offscreen canvas (RGB only)
    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.color = color; // Store for gradient
    this.offscreenCtx.fillStyle = this.strokeColor;

    // Store user's alpha and hardness for compositing
    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = colorAlpha * opacitySlider;
    
    // Standardize hardness: UI uses 0-100, tool expects 0.0-1.0
    const rawHardness = user.hardness !== undefined ? user.hardness : 100;
    this.userHardness = rawHardness > 1.0 ? rawHardness / 100.0 : rawHardness;
    if (this.userHardness > 1.0) this.userHardness = 1.0; // Cap at 1.0

    // Initialize dirty rect tracking before first stamp so the dot's bounds are recorded
    this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    // Position is already smoothed by InputBufferManager
    // Stamp first circle
    const pressure255 = Math.round(pressure * 255);
    this.stampCircle(pos.x, pos.y, radius, pressure255);
    this.lastStampPos = { x: pos.x, y: pos.y, radius, pressure255 };

    // Store points for reference
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];

    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    // Position is already smoothed by InputBufferManager
    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Adaptive spacing: 20% of average radius
    const avgRadius = (this.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const distance = this.getDistance(this.lastStampPos, pos);

    if (distance >= spacing) {
      // Interpolate circles along the path for smooth coverage
      const pressure255End = Math.round(pressure * 255);
      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = this.lastStampPos.x + (pos.x - this.lastStampPos.x) * t;
        const y = this.lastStampPos.y + (pos.y - this.lastStampPos.y) * t;
        const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
        const p255 = Math.round(this.lastStampPos.pressure255 + (pressure255End - this.lastStampPos.pressure255) * t);
        this.stampCircle(x, y, r, p255);
      }
      this.lastStampPos = { x: pos.x, y: pos.y, radius, pressure255: pressure255End };
      user.penPoints.push({ x: pos.x, y: pos.y, radius });
    }

    this.board.clearTop();
    this.drawPreview(user);
  }

  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

    // Stamp to the exact final position (unsmoothed) to close any gap
    if (this.lastStampPos) {
      const pressure = this.quantizePressure(user.pressure);
      const radius = pressure * user.size;

      // Calculate spacing for interpolation
      const avgRadius = (this.lastStampPos.radius + radius) / 2;
      const spacing = Math.max(1, avgRadius * 0.2);
      const distance = this.getDistance(this.lastStampPos, pos);

      // Interpolate stamps from last position to exact final position
      if (distance > 0.5) {
        const pressure255End = Math.round(pressure * 255);
        const steps = Math.max(1, Math.ceil(distance / spacing));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = this.lastStampPos.x + (pos.x - this.lastStampPos.x) * t;
          const y = this.lastStampPos.y + (pos.y - this.lastStampPos.y) * t;
          const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
          const p255 = Math.round(this.lastStampPos.pressure255 + (pressure255End - this.lastStampPos.pressure255) * t);
          this.stampCircle(x, y, r, p255);
        }
      }
    }

    // Composite offscreen canvas source-over into the sub-layer.
    // The sub-layer's blend mode is applied at composite time, not here.
    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.userAlpha;

    // Apply global blur using shadow injection technique
    this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;

    // Update dirty rect before clearing stroke
    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      // Expand by blur amount with 25% safety margin
      const brushRadius = user.size;
      const blurAmount = (1 - this.userHardness) * (20 + user.size * 0.2);
      const safetyMargin = brushRadius * 0.25; // 25% additional margin for blur/hardness
      const margin = blurAmount + safetyMargin + 2; // +2 for anti-aliasing

      const x = Math.floor(this.dirtyBounds.minX - margin);
      const y = Math.floor(this.dirtyBounds.minY - margin);
      const width = Math.ceil(this.dirtyBounds.maxX - this.dirtyBounds.minX + margin * 2);
      const height = Math.ceil(this.dirtyBounds.maxY - this.dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      // Mirror dirty rect if mirror mode is enabled
      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirrorX = Math.floor(boardWidth - this.dirtyBounds.maxX - margin);
        this.board.expandDirtyRect(user, mirrorX, y, width, height);
      }
    }

    this.clearStroke();
    user.penPoints = [];

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
    this.board.endStroke(user);
    this.board.clearTop();
  }

  stampCircle(x, y, radius, pressure255) {
    const ctx = this.offscreenCtx;

    // Draw hard stamps - blur will be applied globally during composite
    ctx.fillStyle = this.strokeColor;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    // Track dirty bounds
    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, x - radius);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, y - radius);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, x + radius);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, y + radius);
    }

    // Collect stamp position for remote sync (pressure as 0-255, not radius)
    this.stampBuffer.push(x, y, pressure255);
  }

  drawPreview(user) {
    if (!this.offscreenCanvas) return;

    const ctx = this.board.topCtx;
    ctx.globalAlpha = this.userAlpha;

    // Apply global blur using shadow injection technique
    this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;
  }

  /**
   * Composite offscreen canvas with optional global blur using shadow injection.
   * This applies hardness as a post-process effect to the entire stroke buffer.
   * Uses hybrid formula: base blur + size scaling for consistent softness across sizes.
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {HTMLCanvasElement} sourceCanvas - Source canvas to composite
   * @param {number} size - Brush size for blur scaling
   * @param {number} x - X offset for drawing
   * @param {number} y - Y offset for drawing
   */
  compositeWithHardness(ctx, sourceCanvas, size, x, y) {
    // Hybrid blur: 20px base + 20% of size gives consistent softness across all brush sizes
    const blurAmount = (1 - this.userHardness) * (20 + size * 0.2);

    if (blurAmount > 0) {
      // Shadow injection trick: draw way off-screen so only the shadow appears
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = this.strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(sourceCanvas, x + offset, y);
      ctx.restore();
    } else {
      // No blur needed - direct composite
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  drainStampBuffer() {
    const buf = this.stampBuffer;
    this.stampBuffer = [];
    // Split interleaved [x,y,r,...] into separate ps [x,y,...] and rs [r,...] arrays
    const ps = [];
    const rs = [];
    for (let i = 0; i < buf.length; i += 3) {
      ps.push(buf[i], buf[i + 1]);
      rs.push(buf[i + 2]);
    }
    return { ps, rs };
  }

  clearStroke() {
    if (this.offscreenCtx) {
      this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    this.lastStampPos = null;
    this.stampBuffer = [];
    this.dirtyBounds = null;
  }

  deactivate() {}
}
