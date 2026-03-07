/**
 * RemotePenHandler - Handles pen/flowPen tool rendering for remote users
 * Uses offscreen canvas to avoid opacity stacking
 *
 * IMPORTANT: Position Smoothing
 * - Incoming stamp positions are already EMA-smoothed by sender's InputBufferManager
 * - Pen/flowPen stamps are discrete circles - no additional position smoothing needed
 * - Remote rendering matches sender's visual output exactly
 */
export class RemotePenHandler {
  constructor(board) {
    this.board = board;
  }

  ensurePenOffscreen(user) {
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (!user._penOffscreen || user._penOffscreen.width !== width || user._penOffscreen.height !== height) {
      user._penOffscreen = document.createElement('canvas');
      user._penOffscreen.width = width;
      user._penOffscreen.height = height;
      user._penOffscreenCtx = user._penOffscreen.getContext('2d');
    }
  }

  handlePenDown(user, pos) {
    this.ensurePenOffscreen(user);

    // Clear offscreen canvas
    user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    // Store color at FULL opacity for offscreen (RGB only)
    const color = user.color.slice(0, 3);
    user._penStrokeColor = `rgb(${color.join(',')})`;
    user._penOffscreenCtx.fillStyle = user._penStrokeColor;

    // Store alpha and hardness for compositing later
    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._penAlpha = colorAlpha * opacitySlider;
    user._penHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    // Draw initial hard stamp
    const ctx = user._penOffscreenCtx;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    user._penLastStampPos = { x: pos.x, y: pos.y, radius };
    user._penStrokeActive = true;
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];

    // Update preview
    this.updatePenPreview(user);
  }

  handlePenStamps(user, points, radii) {
    if (points.length < 2) return;

    // Lazy-init: if MD arrived before CT (tool change), handlePenDown was never called.
    // Also clears any junk brush points that handleMouseDown may have added.
    if (!user._penStrokeActive) {
      user.clearLine();
      this.handlePenDown(user, { x: points[0], y: points[1] });
    }

    const ctx = user._penOffscreenCtx;
    ctx.fillStyle = user._penStrokeColor;

    // Draw hard stamps - blur will be applied globally during composite
    // Stamp each point — convert pressure (0-255) to pixel radius
    for (let i = 0, ri = 0; i < points.length; i += 2, ri++) {
      const x = points[i];
      const y = points[i + 1];
      const pressure = radii[ri] / 255;
      const r = pressure * user.size;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
      // Track stamp positions for dirty rect calculation in handlePenUp
      if (user.penPoints) {
        user.penPoints.push({ x, y, radius: r });
      }
    }

    // Update last stamp pos and preview
    const lastPtIdx = points.length - 2;
    const lastPressure = radii[radii.length - 1] / 255;
    const lastR = lastPressure * user.size;
    user._penLastStampPos = { x: points[lastPtIdx], y: points[lastPtIdx + 1], radius: lastR };
    user.setPosition(points[lastPtIdx], points[lastPtIdx + 1]);
    this.updatePenPreview(user);
  }

  handlePenMove(user, pos) {
    if (!user._penLastStampPos || !user._penOffscreenCtx) return;

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    // Adaptive spacing
    const avgRadius = (user._penLastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const dx = pos.x - user._penLastStampPos.x;
    const dy = pos.y - user._penLastStampPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= spacing) {
      // Draw hard stamps - blur will be applied globally during composite
      const ctx = user._penOffscreenCtx;
      ctx.fillStyle = user._penStrokeColor;

      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = user._penLastStampPos.x + dx * t;
        const y = user._penLastStampPos.y + dy * t;
        const r = user._penLastStampPos.radius + (radius - user._penLastStampPos.radius) * t;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
        ctx.fill();
      }

      user._penLastStampPos = { x: pos.x, y: pos.y, radius };
      if (user.penPoints) {
        user.penPoints.push({ x: pos.x, y: pos.y, radius });
      }

      // Update preview
      this.updatePenPreview(user);
    }
  }

  handlePenUp(user) {
    if (!user._penLastStampPos || !user._penOffscreen) return;

    // Track dirty rect from pen stamp points to avoid expensive getImageData on commit
    if (user.penPoints && user.penPoints.length > 0) {
      const hardness = user._penHardness !== undefined ? user._penHardness : 1.0;
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of user.penPoints) {
        const r = pt.radius || user.size;
        if (pt.x - r < minX) minX = pt.x - r;
        if (pt.x + r > maxX) maxX = pt.x + r;
        if (pt.y - r < minY) minY = pt.y - r;
        if (pt.y + r > maxY) maxY = pt.y + r;
      }
      const margin = blurAmount + 2;
      const x = Math.floor(minX - margin);
      const y = Math.floor(minY - margin);
      const w = Math.ceil(maxX - minX + margin * 2);
      const h = Math.ceil(maxY - minY + margin * 2);
      this.board.expandDirtyRect(user, x, y, w, h);
      if (this.board.mirror) {
        const boardW = this.board.getWidth();
        this.board.expandDirtyRect(user, Math.floor(boardW - maxX - margin), y, w, h);
      }
    }

    // Composite offscreen source-over into the sub-layer; blend mode applied at composite time.
    const layerCtx = this.board.layerManager.getLayerContext(user.activeLayer, user.id);
    if (layerCtx) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._penAlpha;

      // Apply global blur using shadow injection
      this.compositeWithHardness(layerCtx, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, 0, 0);

      if (this.board.mirror) {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        layerCtx.translate(this.board.getWidth(), 0);
        layerCtx.scale(-1, 1);
        this.compositeWithHardness(layerCtx, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, 0, 0);
        layerCtx.restore();
      }

      layerCtx.globalAlpha = 1.0;

      // Composite all layers to visible canvas
      this.board.requestUpdate();
    }

    // Clean up per-user pen state
    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    user.penPoints = [];
  }

  updatePenPreview(user) {
    if (!user._penOffscreen) return;

    // Composite offscreen to user.context with alpha for preview
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.globalAlpha = user._penAlpha;

    // Apply global blur using shadow injection
    this.compositeWithHardness(user.context, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, 0, 0);

    if (this.board.mirror) {
      user.context.save();
      user.context.translate(this.board.getWidth(), 0);
      user.context.scale(-1, 1);
      this.compositeWithHardness(user.context, user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, 0, 0);
      user.context.restore();
    }

    user.context.globalAlpha = 1.0;
  }

  /**
   * Composite offscreen canvas with optional global blur using shadow injection.
   * Uses hybrid formula: base blur + size scaling for consistent softness across sizes.
   */
  compositeWithHardness(ctx, sourceCanvas, size, hardness, strokeColor, x, y) {
    const blurAmount = (1 - hardness) * (20 + size * 0.2);

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(sourceCanvas, x + offset, y);
      ctx.restore();
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }
}
