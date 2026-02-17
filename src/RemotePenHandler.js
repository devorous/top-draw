/**
 * RemotePenHandler - Handles pen/flowPen tool rendering for remote users
 * Uses offscreen canvas to avoid opacity stacking
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
    user._penHardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Apply softness using shadow blur
    const ctx = user._penOffscreenCtx;
    if (user._penHardness < 1.0) {
      const blurAmount = (1 - user._penHardness) * radius * 1.2;
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user._penStrokeColor;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    } else {
      ctx.shadowBlur = 0;
    }

    // Stamp first circle to offscreen
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    // Reset shadow
    ctx.shadowBlur = 0;

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

    // rs values are 0-255 pressure — convert to pixel radius using user.size
    // Apply softness
    if (user._penHardness < 1.0) {
      const avgPressure = (radii[0] || 255) / 255;
      const avgR = avgPressure * user.size;
      const blurAmount = (1 - user._penHardness) * avgR * 1.2;
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user._penStrokeColor;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    } else {
      ctx.shadowBlur = 0;
    }

    // Stamp each point — convert pressure (0-255) to pixel radius
    for (let i = 0, ri = 0; i < points.length; i += 2, ri++) {
      const x = points[i];
      const y = points[i + 1];
      const pressure = radii[ri] / 255;
      const r = pressure * user.size;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.shadowBlur = 0;

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
      // Stamp circles to offscreen
      const ctx = user._penOffscreenCtx;
      ctx.fillStyle = user._penStrokeColor;

      // Apply softness using shadow blur
      if (user._penHardness < 1.0) {
        const blurAmount = (1 - user._penHardness) * radius * 1.2;
        ctx.shadowBlur = blurAmount;
        ctx.shadowColor = user._penStrokeColor;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      } else {
        ctx.shadowBlur = 0;
      }

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

      // Reset shadow
      ctx.shadowBlur = 0;

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

    // Clear preview FIRST to prevent double opacity (preview + final stacking)
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    // Composite offscreen to mainCtx with alpha
    const mainCtx = this.board.mainCtx;
    mainCtx.globalCompositeOperation = 'source-over';
    mainCtx.globalAlpha = user._penAlpha;
    mainCtx.drawImage(user._penOffscreen, 0, 0);

    if (this.board.mirror) {
      mainCtx.save();
      mainCtx.globalCompositeOperation = 'source-over';
      mainCtx.translate(this.board.getWidth(), 0);
      mainCtx.scale(-1, 1);
      mainCtx.drawImage(user._penOffscreen, 0, 0);
      mainCtx.restore();
    }

    mainCtx.globalAlpha = 1.0;

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
    user.context.drawImage(user._penOffscreen, 0, 0);

    if (this.board.mirror) {
      user.context.save();
      user.context.translate(this.board.getWidth(), 0);
      user.context.scale(-1, 1);
      user.context.drawImage(user._penOffscreen, 0, 0);
      user.context.restore();
    }

    user.context.globalAlpha = 1.0;
  }
}
