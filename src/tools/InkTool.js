import { getStroke } from 'perfect-freehand';

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
 * Ink tool using perfect-freehand library
 * Produces filled polygon outlines from input points with taper/calligraphy effects
 * Uses offscreen canvas pattern (like FlowPenTool) to prevent opacity stacking
 *
 * Pressure is quantized to 256 levels (0-255) for this tool, matching
 * perfect-freehand's expected granularity.
 */
export class InkTool extends Tool {
  constructor(board) {
    super('ink', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.inputPoints = []; // Array of [x, y, pressure] where pressure is 0-1 quantized to 1/255
    this.userAlpha = 1.0;
    this.strokeColor = null;
    this._strokeSize = 10; // Locked at stroke start, does not change mid-stroke
    // Buffer for network sync: collects raw input points as [x, y, pressure255, ...]
    this.pointBuffer = [];
  }

  activate() {
    const ctx = this.board.getActiveLayerContext();
    const blendMode = this.board.app?.self?.blendMode || 'source-over';
    ctx.globalCompositeOperation = blendMode;
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

  /**
   * Quantize pressure to 256 levels (0-255 mapped back to 0-1)
   */
  quantizePressure(pressure) {
    return Math.round(pressure * (this.pressureSteps - 1)) / (this.pressureSteps - 1);
  }

  onPointerDown(user, pos, e) {
    this.ensureOffscreenCanvas();

    // Clear offscreen canvas
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    // Store color at full opacity for offscreen canvas (RGB only)
    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.offscreenCtx.fillStyle = this.strokeColor;

    // Store user's alpha for compositing
    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = colorAlpha * opacitySlider;

    // Lock size at stroke start — does not change mid-stroke
    this._strokeSize = user.size;

    const pressure = this.quantizePressure(user.pressure);

    // Initialize points array with first point
    this.inputPoints = [[pos.x, pos.y, pressure]];

    // Clear point buffer
    this.pointBuffer = [];

    // Add first point to buffer for network sync
    this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));

    // Render initial stroke
    this.renderStroke(false);
    this.drawPreview();
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || this.inputPoints.length === 0) return;

    const pressure = this.quantizePressure(user.pressure);

    // Add point
    this.inputPoints.push([pos.x, pos.y, pressure]);

    // Buffer for network sync — send pressure as 0-255 integer
    this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));

    // Re-render the entire stroke
    this.renderStroke(false);

    this.board.clearTop();
    this.drawPreview();
  }

  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas || this.inputPoints.length === 0) return;

    const pressure = this.quantizePressure(user.pressure);

    // Add final point
    this.inputPoints.push([pos.x, pos.y, pressure]);
    this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));

    // Final render with last=true for tapered end
    this.renderStroke(true);

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    // Composite offscreen canvas to active layer with user's alpha and blend mode
    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = user.blendMode || 'source-over';
    ctx.globalAlpha = this.userAlpha;
    ctx.drawImage(this.offscreenCanvas, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.globalCompositeOperation = user.blendMode || 'source-over';
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.offscreenCanvas, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;

    this.clearStroke();

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
  }

  /**
   * Render the current stroke to the offscreen canvas
   * @param {boolean} last - Whether this is the final render (enables end taper)
   */
  renderStroke(last) {
    if (this.inputPoints.length < 1) return;

    const ctx = this.offscreenCtx;
    ctx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    // Size is the base stroke diameter, locked at stroke start.
    // Per-point pressure in the input array modulates width via thinning.
    // simulatePressure only when all points have pressure=1 (mouse input).
    const allMaxPressure = this.inputPoints.every(p => p[2] === 1);
    const options = {
      size: (this._strokeSize * 2) / 1.5,
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: allMaxPressure,
      last
    };

    const outlinePoints = getStroke(this.inputPoints, options);

    if (outlinePoints.length < 3) return;

    const pathData = getSvgPathFromStroke(outlinePoints);
    if (!pathData) return;

    const path = new Path2D(pathData);
    ctx.fillStyle = this.strokeColor;
    ctx.fill(path);
  }

  drawPreview() {
    if (!this.offscreenCanvas) return;

    const ctx = this.board.topCtx;
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

  /**
   * Drain the point buffer for network sync
   * Returns {ps, rs} where ps is [x1,y1,x2,y2,...] and rs is [pressure0-255, ...]
   */
  drainPointBuffer() {
    const buf = this.pointBuffer;
    this.pointBuffer = [];

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
    this.inputPoints = [];
    this.pointBuffer = [];
    this.board.clearTop();
  }

  deactivate() {}
}
