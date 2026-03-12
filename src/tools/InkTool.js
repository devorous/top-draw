/**
 * @fileoverview Ink tool using perfect-freehand library.
 * Produces filled polygon outlines from input points with taper/calligraphy effects.
 */

import { getStroke } from 'perfect-freehand';

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Convert perfect-freehand outline points to an SVG path string for Path2D.
 * Uses quadratic bezier curves through midpoints for smooth results.
 * @param {Array<number[]>} stroke - Array of points representing the stroke outline.
 * @returns {string} - SVG path string.
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
 * Ink tool using perfect-freehand library.
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring parity between local preview and remote rendering.
 */
export class InkTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('ink', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.inputPoints = []; // Array of [x, y, pressure]
    this.userAlpha = 1.0;
    this.strokeColor = null;
    this._strokeSize = 10;
    this.pointBuffer = [];
  }

  /**
   * Activates the tool and ensures the offscreen canvas is ready.
   */
  activate() {
    this.ensureOffscreenCanvas();
  }

  /**
   * Ensures the offscreen canvas matches the main canvas dimensions.
   */
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
   * Quantizes pressure to a fixed number of steps for consistency.
   * @param {number} pressure - The input pressure (0-1).
   * @returns {number} - The quantized pressure.
   */
  quantizePressure(pressure) {
    return Math.round(pressure * (this.pressureSteps - 1)) / (this.pressureSteps - 1);
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {
    this.board.beginStroke(user);
    this.ensureOffscreenCanvas();

    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.offscreenCtx.fillStyle = this.strokeColor;

    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = colorAlpha * opacitySlider;
    this.userHardness = user.hardness !== undefined ? user.hardness : 100;

    this._strokeSize = user.size;

    const pressure = this.quantizePressure(user.pressure);

    this.inputPoints = [[pos.x, pos.y, pressure]];
    this.pointBuffer = [pos.x, pos.y, Math.round(pressure * 255)];

    this.dirtyBounds = { minX: pos.x, minY: pos.y, maxX: pos.x, maxY: pos.y };

    this.renderStroke(false);
    this.drawPreview();
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || this.inputPoints.length === 0) return;

    const pressure = this.quantizePressure(user.pressure);

    this.inputPoints.push([pos.x, pos.y, pressure]);
    this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y);
    }

    this.renderStroke(false);
    this.board.clearTop();
    this.drawPreview();
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas || this.inputPoints.length === 0) return;

    const pressure = this.quantizePressure(user.pressure);
    this.inputPoints.push([pos.x, pos.y, pressure]);
    this.pointBuffer.push(pos.x, pos.y, Math.round(pressure * 255));

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y);
    }

    this.renderStroke(true);
    this.board.clearTop();

    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.userAlpha;

    this.compositeWithHardness(ctx, this.offscreenCanvas, this._strokeSize, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      this.compositeWithHardness(ctx, this.offscreenCanvas, this._strokeSize, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const strokeRadius = this._strokeSize;
      const blurAmount = (1 - (this.userHardness / 100.0)) * (20 + this._strokeSize * 0.2);
      const safetyMargin = strokeRadius * 0.5; 
      const margin = strokeRadius + (blurAmount * 2.5) + safetyMargin + 15;

      const x = Math.floor(this.dirtyBounds.minX - margin);
      const y = Math.floor(this.dirtyBounds.minY - margin);
      const width = Math.ceil(this.dirtyBounds.maxX - this.dirtyBounds.minX + margin * 2);
      const height = Math.ceil(this.dirtyBounds.maxY - this.dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirrorX = Math.floor(boardWidth - this.dirtyBounds.maxX - margin);
        this.board.expandDirtyRect(user, mirrorX, y, width, height);
      }
    }

    this.clearStroke();
    this.board.compositeAllLayers();
    this.board.endStroke(user);
  }

  /**
   * Renders the stroke into the offscreen canvas.
   * @param {boolean} last - Whether this is the final segment of the stroke.
   */
  renderStroke(last) {
    if (this.inputPoints.length < 1) return;

    const ctx = this.offscreenCtx;
    ctx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    // perfect-freehand's visual radius is ~75% of the 'size' parameter.
    const isDot = this.inputPoints.length === 1 || 
                 (this.inputPoints.length === 2 && 
                  Math.abs(this.inputPoints[0][0] - this.inputPoints[1][0]) < 0.1 && 
                  Math.abs(this.inputPoints[0][1] - this.inputPoints[1][1]) < 0.1);

    if (isDot) {
      const [x, y] = this.inputPoints[0];
      ctx.fillStyle = this.strokeColor;
      ctx.beginPath();
      ctx.arc(x, y, this._strokeSize, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

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

  /**
   * Draws the current stroke preview on the top canvas.
   */
  drawPreview() {
    if (!this.offscreenCanvas) return;
    const ctx = this.board.topCtx;
    ctx.globalAlpha = this.userAlpha;
    this.compositeWithHardness(ctx, this.offscreenCanvas, this._strokeSize, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      this.compositeWithHardness(ctx, this.offscreenCanvas, this._strokeSize, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1.0;
  }

  /**
   * Composites the offscreen canvas with a hardness-based blur effect.
   * @param {CanvasRenderingContext2D} ctx - The target canvas context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   */
  compositeWithHardness(ctx, sourceCanvas, size, x, y) {
    const blurAmount = (1 - (this.userHardness / 100.0)) * (20 + size * 0.2);
    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = this.strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(sourceCanvas, x + offset, y);
      ctx.restore();
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  /**
   * Drains the point buffer for network synchronization.
   * @returns {Object} - An object containing ps (positions) and rs (pressures).
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

  /**
   * Clears the current stroke state and offscreen canvas.
   */
  clearStroke() {
    if (this.offscreenCtx) this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    this.inputPoints = [];
    this.pointBuffer = [];
    this.board.clearTop();
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {}
}
