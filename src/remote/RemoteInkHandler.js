/** @fileoverview Handles the rendering of ink tool strokes for remote users using perfect-freehand. */

import { getStroke } from 'perfect-freehand';

/**
 * Converts perfect-freehand outline points to an SVG path string for Path2D.
 * @param {Array<number[]>} stroke - Array of points representing the stroke outline.
 * @returns {string} - The SVG path data string.
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
 * Handles ink tool rendering for remote users.
 * Uses an offscreen canvas and the perfect-freehand library for smooth, tapered strokes.
 */
export class RemoteInkHandler {
  /**
   * @param {Board} board - The main board instance.
   */
  constructor(board) {
    this.board = board;
  }

  /**
   * Ensures the user has a valid offscreen canvas for ink rendering.
   * @param {User} user - The remote user object.
   */
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

  /**
   * Initializes a new ink stroke for a remote user.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The starting coordinates {x, y}.
   */
  handleInkDown(user, pos) {
    this.ensureInkOffscreen(user);

    user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);

    const color = user.color.slice(0, 3);
    user._inkStrokeColor = `rgb(${color.join(',')})`;

    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._inkAlpha = colorAlpha * opacitySlider;
    user._inkHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    user._inkSize = user.size;

    const pressure = Math.round(user.pressure * 255) / 255;
    user._inkPoints = [[pos.x, pos.y, pressure]];
    user._inkStrokeActive = true;

    this.renderInkStroke(user, false);
    this.updateInkPreview(user);
  }

  /**
   * Processes incoming points and pressures for an active ink stroke.
   * @param {User} user - The remote user object.
   * @param {number[]} points - Flat array of [x, y, x, y, ...] coordinates.
   * @param {number[]} pressures - Array of pressure values (0-255).
   */
  handleInkPoints(user, points, pressures) {
    if (points.length < 2) return;

    if (!user._inkStrokeActive) {
      user.clearLine();
      this.handleInkDown(user, { x: points[0], y: points[1] });
    }

    for (let i = 0, pi = 0; i < points.length; i += 2, pi++) {
      const raw = pressures[pi] !== undefined ? pressures[pi] : user.pressure * 255;
      const pressure = raw / 255;
      user._inkPoints.push([points[i], points[i + 1], pressure]);
    }

    this.renderInkStroke(user, false);

    const lastIdx = points.length - 2;
    user.setPosition(points[lastIdx], points[lastIdx + 1]);
    this.updateInkPreview(user);
  }

  /**
   * Finalizes and commits an ink stroke to the board layers.
   * @param {User} user - The remote user object.
   */
  handleInkUp(user) {
    if (!user._inkStrokeActive || !user._inkOffscreen) return;

    this.renderInkStroke(user, true);

    // Track dirty rect from ink points to avoid expensive getImageData on commit
    if (user._inkPoints && user._inkPoints.length > 0) {
      const size = user._inkSize || user.size;
      const hardness = user._inkHardness !== undefined ? user._inkHardness : 1.0;
      const blurAmount = (1 - hardness) * (20 + size * 0.2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of user._inkPoints) {
        const r = pt[2] * size;
        if (pt[0] - r < minX) minX = pt[0] - r;
        if (pt[0] + r > maxX) maxX = pt[0] + r;
        if (pt[1] - r < minY) minY = pt[1] - r;
        if (pt[1] + r > maxY) maxY = pt[1] + r;
      }
      const margin = blurAmount + size * 0.5 + 2;
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

    const layerCtx = this.board.layerManager.getLayerContext(user.activeLayer, user.id);
    if (layerCtx) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._inkAlpha;

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
      this.board.requestUpdate();
    }

    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
  }

  /**
   * Renders the current ink points to the user's offscreen context.
   * @param {User} user - The remote user object.
   * @param {boolean} last - Whether this is the final segment of the stroke.
   */
  renderInkStroke(user, last) {
    if (!user._inkPoints || user._inkPoints.length < 1) return;

    const ctx = user._inkCtx;
    ctx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);

    const simulatePressure = user.simulatePressure !== undefined ? user.simulatePressure : true;
    const thinning = !simulatePressure ? 0.95 : (user.thinning !== undefined ? user.thinning : 0.5);

    const options = {
      size: Math.max(0.1, ((user._inkSize || user.size) * 2) / (1 + thinning)),
      thinning: thinning,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: simulatePressure,
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

  /**
   * Updates the user's preview canvas with the current ink stroke state.
   * @param {User} user - The remote user object.
   */
  updateInkPreview(user) {
    if (!user._inkOffscreen) return;

    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.globalAlpha = user._inkAlpha;

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
   * Composites an offscreen canvas to a context with hardness/blur application.
   * @param {CanvasRenderingContext2D} ctx - The destination context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} hardness - The hardness value (0.0 to 1.0).
   * @param {string} strokeColor - The RGB color string.
   * @param {number} x - Destination x-coordinate.
   * @param {number} y - Destination y-coordinate.
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
