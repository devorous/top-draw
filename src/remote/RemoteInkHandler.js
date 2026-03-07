import { getStroke } from 'perfect-freehand';

/**
 * Convert perfect-freehand outline points to an SVG path string for Path2D.
 * Uses quadratic bezier curves through midpoints for smooth results.
 */
function getSvgPathFromStroke(stroke) {
  if (!stroke.length) return '';

  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ['M', ...stroke[0], 'Q']
  );

  d.push('Z');
  return d.join(' ');
}

/**
 * RemoteInkHandler - Handles ink tool rendering for remote users
 * Uses offscreen canvas with perfect-freehand library for smooth strokes
 *
 * IMPORTANT: Position Smoothing vs Visual Smoothing
 * - Incoming points are already EMA-smoothed by sender's InputBufferManager
 * - The `smoothing: 0.5` parameter in perfect-freehand options is VISUAL curve smoothing
 *   (internal to the library), NOT position smoothing
 * - This visual smoothing is separate from the EMA position smoothing and is applied
 *   during stroke outline generation
 */
export class RemoteInkHandler {
  constructor(board) {
    this.board = board;
  }

  ensureInkOffscreen(user) {
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (!user._inkOffscreen || user._inkOffscreen.width !== width || user._inkOffscreen.height !== height) {
      user._inkOffscreen = document.createElement('canvas');
      user._inkOffscreen.width = width;
      user._inkOffscreen.height = height;
      user._inkCtx = user._inkOffscreen.getContext('2d');
    }
  }

  handleInkDown(user, pos) {
    this.ensureInkOffscreen(user);

    // Clear offscreen canvas
    user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);

    // Store color at FULL opacity for offscreen (RGB only)
    const color = user.color.slice(0, 3);
    user._inkStrokeColor = `rgb(${color.join(',')})`;

    // Store alpha and hardness for compositing later
    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._inkAlpha = colorAlpha * opacitySlider;
    user._inkHardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Lock size at stroke start
    user._inkSize = user.size;

    // Initialize points with first point (pressure quantized to 1/255)
    const pressure = Math.round(user.pressure * 255) / 255;
    user._inkPoints = [[pos.x, pos.y, pressure]];
    user._inkStrokeActive = true;

    // Render initial stroke
    this.renderInkStroke(user, false);
    this.updateInkPreview(user);
  }

  handleInkPoints(user, points, pressures) {
    if (points.length < 2) return;

    // Lazy-init if MD arrived before CT
    if (!user._inkStrokeActive) {
      user.clearLine();
      this.handleInkDown(user, { x: points[0], y: points[1] });
    }

    // Add points with pressure — rs values are 0-255, convert back to 0-1
    for (let i = 0, pi = 0; i < points.length; i += 2, pi++) {
      const raw = pressures[pi] !== undefined ? pressures[pi] : user.pressure * 255;
      const pressure = raw / 255;
      user._inkPoints.push([points[i], points[i + 1], pressure]);
    }

    // Re-render the entire stroke
    this.renderInkStroke(user, false);

    // Update position and preview
    const lastIdx = points.length - 2;
    user.setPosition(points[lastIdx], points[lastIdx + 1]);
    this.updateInkPreview(user);
  }

  handleInkUp(user) {
    if (!user._inkStrokeActive || !user._inkOffscreen) return;

    // Final render with last=true for tapered end
    this.renderInkStroke(user, true);

    // Track dirty rect from ink points to avoid expensive getImageData on commit
    if (user._inkPoints && user._inkPoints.length > 0) {
      const size = user._inkSize || user.size;
      const hardness = user._inkHardness !== undefined ? user._inkHardness : 1.0;
      const blurAmount = (1 - hardness) * (20 + size * 0.2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of user._inkPoints) {
        const r = pt[2] * size; // pressure * size
        if (pt[0] - r < minX) minX = pt[0] - r;
        if (pt[0] + r > maxX) maxX = pt[0] + r;
        if (pt[1] - r < minY) minY = pt[1] - r;
        if (pt[1] + r > maxY) maxY = pt[1] + r;
      }
      const margin = blurAmount + size * 0.5 + 2; // Extra margin for perfect-freehand outline expansion
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
      layerCtx.globalAlpha = user._inkAlpha;

      // Apply global blur using shadow injection
      this.compositeWithHardness(layerCtx, user._inkOffscreen, user._inkSize || user.size, user._inkHardness, user._inkStrokeColor, 0, 0);

      if (this.board.mirror) {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        layerCtx.translate(this.board.getWidth(), 0);
        layerCtx.scale(-1, 1);
        this.compositeWithHardness(layerCtx, user._inkOffscreen, user._inkSize || user.size, user._inkHardness, user._inkStrokeColor, 0, 0);
        layerCtx.restore();
      }

      layerCtx.globalAlpha = 1.0;

      // Composite all layers to visible canvas
      this.board.requestUpdate();
    }

    // Clean up per-user ink state
    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
  }

  renderInkStroke(user, last) {
    if (!user._inkPoints || user._inkPoints.length < 1) return;

    const ctx = user._inkCtx;
    ctx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);

    // Size is the base stroke diameter, locked at stroke start.
    // Per-point pressure modulates width via thinning.
    const allMaxPressure = user._inkPoints.every(p => p[2] === 1);
    const options = {
      // 1.33x diameter results in a 1.0x visual radius.
      // Use Math.max to prevent perfect-freehand from collapsing at extremely small sizes.
      size: Math.max(0.1, ((user._inkSize || user.size) * 2) / 1.5),
      thinning: 0.5,
      smoothing: 0.5,      // perfect-freehand's VISUAL curve smoothing (not position EMA)
      streamline: 0.5,
      simulatePressure: allMaxPressure,
      last
    };

    const outlinePoints = getStroke(user._inkPoints, options);

    if (outlinePoints.length < 3) return;

    const pathData = getSvgPathFromStroke(outlinePoints);
    if (!pathData) return;

    const path = new Path2D(pathData);
    ctx.fillStyle = user._inkStrokeColor;
    ctx.fill(path);
  }

  updateInkPreview(user) {
    if (!user._inkOffscreen) return;

    // Composite offscreen to user.context with alpha for preview
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.globalAlpha = user._inkAlpha;

    // Apply global blur using shadow injection
    this.compositeWithHardness(user.context, user._inkOffscreen, user._inkSize || user.size, user._inkHardness, user._inkStrokeColor, 0, 0);

    if (this.board.mirror) {
      user.context.save();
      user.context.translate(this.board.getWidth(), 0);
      user.context.scale(-1, 1);
      this.compositeWithHardness(user.context, user._inkOffscreen, user._inkSize || user.size, user._inkHardness, user._inkStrokeColor, 0, 0);
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
