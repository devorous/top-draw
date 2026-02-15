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
    // Smoothing buffer for stroke stabilization
    this.smoothBuffer = { x: 0, y: 0 };
    this.isFirstPoint = true;
    // Stillness timer
    this.stillnessTimer = null;
    this.lastTargetPos = null;
    this.currentUser = null;
    // Stamp buffer for remote sync — collects exact stamp positions as interleaved [x, y, r, ...], split on drain
    this.stampBuffer = [];
  }

  /**
   * Apply exponential moving average smoothing to position
   * Combines baseline smoothing (always-on) with user's smoothing setting
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

    const factor = 1 - totalSmoothing * 0.9;
    this.smoothBuffer.x += (targetX - this.smoothBuffer.x) * factor;
    this.smoothBuffer.y += (targetY - this.smoothBuffer.y) * factor;

    return {
      x: this.smoothBuffer.x,
      y: this.smoothBuffer.y
    };
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
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
    this.ensureOffscreenCanvas();
    this.isFirstPoint = true;

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
    this.userHardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Apply smoothing
    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    // Stamp first circle
    this.stampCircle(smoothedPos.x, smoothedPos.y, radius);
    this.lastStampPos = { x: smoothedPos.x, y: smoothedPos.y, radius };

    // Store points for reference
    user.penPoints = [{ x: smoothedPos.x, y: smoothedPos.y, radius }];

    // Store user and position for stillness timer
    this.currentUser = user;
    this.lastTargetPos = { x: pos.x, y: pos.y };
    this.resetStillnessTimer();

    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    // Update target position and reset stillness timer
    this.lastTargetPos = { x: pos.x, y: pos.y };
    this.currentUser = user;
    this.resetStillnessTimer();

    // Apply smoothing
    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Adaptive spacing: 20% of average radius
    const avgRadius = (this.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const distance = this.getDistance(this.lastStampPos, smoothedPos);

    if (distance >= spacing) {
      // Interpolate circles along the path for smooth coverage
      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = this.lastStampPos.x + (smoothedPos.x - this.lastStampPos.x) * t;
        const y = this.lastStampPos.y + (smoothedPos.y - this.lastStampPos.y) * t;
        const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
        this.stampCircle(x, y, r);
      }
      this.lastStampPos = { x: smoothedPos.x, y: smoothedPos.y, radius };
      user.penPoints.push({ x: smoothedPos.x, y: smoothedPos.y, radius });
    }

    this.board.clearTop();
    this.drawPreview(user);
  }

  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

    // Clear stillness timer
    this.clearStillnessTimer();

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
        const steps = Math.max(1, Math.ceil(distance / spacing));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = this.lastStampPos.x + (pos.x - this.lastStampPos.x) * t;
          const y = this.lastStampPos.y + (pos.y - this.lastStampPos.y) * t;
          const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
          this.stampCircle(x, y, r);
        }
      }
    }

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    // Composite offscreen canvas to main canvas with user's alpha
    const ctx = this.board.mainCtx;
    ctx.globalAlpha = this.userAlpha;
    ctx.drawImage(this.offscreenCanvas, 0, 0);

    if (this.board.mirror) {
      // Flip horizontally and draw mirrored
      ctx.save();
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.offscreenCanvas, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;

    this.clearStroke();
    user.penPoints = [];
  }

  stampCircle(x, y, radius) {
    const ctx = this.offscreenCtx;

    // Apply softness using shadow blur
    if (this.userHardness < 1.0) {
      const blurAmount = (1 - this.userHardness) * radius * 1.2;
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = this.strokeColor;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = this.strokeColor;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    // Collect stamp position for remote sync
    this.stampBuffer.push(x, y, radius);

    // Reset shadow
    ctx.shadowBlur = 0;
  }

  drawPreview(user) {
    if (!this.offscreenCanvas) return;

    const ctx = this.board.topCtx;

    // Draw offscreen canvas with user's alpha
    ctx.globalAlpha = this.userAlpha;
    ctx.drawImage(this.offscreenCanvas, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.offscreenCanvas, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;
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
    // Clear the preview from the top canvas as well
    this.board.clearTop();
  }

  resetStillnessTimer() {
    this.clearStillnessTimer();
    this.stillnessTimer = setTimeout(() => {
      this.stampAtTarget();
    }, 50); // 0.05 seconds
  }

  clearStillnessTimer() {
    if (this.stillnessTimer) {
      clearTimeout(this.stillnessTimer);
      this.stillnessTimer = null;
    }
  }

  stampAtTarget() {
    if (!this.currentUser || !this.lastTargetPos || !this.lastStampPos) return;
    if (!this.currentUser.mousedown || this.currentUser.panning) return;

    const pressure = this.quantizePressure(this.currentUser.pressure);
    const radius = pressure * this.currentUser.size;

    // Stamp at exact target position
    this.stampCircle(this.lastTargetPos.x, this.lastTargetPos.y, radius);
    this.lastStampPos = { x: this.lastTargetPos.x, y: this.lastTargetPos.y, radius };

    this.board.clearTop();
    this.drawPreview(this.currentUser);

    // Broadcast stamp positions to other users
    if (this.board.app && this.board.app.wsClient) {
      const { ps, rs } = this.drainStampBuffer();
      if (ps.length > 0) {
        this.board.app.wsClient.broadcastStampMove(ps, rs);
      }
    }
  }

  deactivate() {
    this.clearStillnessTimer();
  }
}
