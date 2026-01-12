/**
 * DrawingEngine - Core drawing operations
 */

import { mirrorLine } from '../utils/math.js';

export class DrawingEngine {
  #canvasManager = null;

  /**
   * Create a DrawingEngine
   * @param {CanvasManager} canvasManager - Canvas manager instance
   */
  constructor(canvasManager) {
    this.#canvasManager = canvasManager;
  }

  /**
   * Draw a line array on a canvas context
   * @param {Array} points - Array of {x, y} points
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {Object} user - User state with color, pressure, size
   */
  drawLineArray(points, ctx, user) {
    if (!points || points.length === 0) return;

    ctx.strokeStyle = this.#formatColor(user.color);
    ctx.lineWidth = user.pressure * user.size * 2;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }

    ctx.stroke();
  }

  /**
   * Draw a line array with mirroring support
   * @param {Array} points - Array of {x, y} points
   * @param {CanvasRenderingContext2D} ctx - Canvas context
   * @param {Object} user - User state
   * @param {boolean} mirror - Whether to also draw mirrored
   */
  drawLineWithMirror(points, ctx, user, mirror = false) {
    this.drawLineArray(points, ctx, user);

    if (mirror) {
      const mirroredPoints = mirrorLine(points, this.#canvasManager.width);
      this.drawLineArray(mirroredPoints, ctx, user);
    }
  }

  /**
   * Erase at a position
   * @param {number} x1 - Start x
   * @param {number} y1 - Start y
   * @param {number} x2 - End x
   * @param {number} y2 - End y
   * @param {number} size - Eraser size
   */
  erase(x1, y1, x2, y2, size) {
    const ctx = this.#canvasManager.mainCtx;
    const prevComposite = ctx.globalCompositeOperation;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.globalCompositeOperation = prevComposite;
  }

  /**
   * Erase with mirroring support
   * @param {number} x1 - Start x
   * @param {number} y1 - Start y
   * @param {number} x2 - End x
   * @param {number} y2 - End y
   * @param {number} size - Eraser size
   * @param {boolean} mirror - Whether to also erase mirrored
   */
  eraseWithMirror(x1, y1, x2, y2, size, mirror = false) {
    this.erase(x1, y1, x2, y2, size);

    if (mirror) {
      const width = this.#canvasManager.width;
      this.erase(width - x1, y1, width - x2, y2, size);
    }
  }

  /**
   * Draw text at a position
   * @param {Object} user - User state with text, color, size, x, y
   */
  drawText(user) {
    const ctx = this.#canvasManager.mainCtx;
    const size = (user.size + 5).toString();
    const text = user.text.replace(/&nbsp;/g, ' ');

    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.fillStyle = this.#formatColor(user.color);
    ctx.font = `${size}px Newsreader, serif`;
    ctx.fillText(text, user.x + 5, user.y - 6 + user.size + 5);
  }

  /**
   * Draw a GIMP brush stamp
   * @param {Object} user - User state with gBrush, size, color, spaceIndex, spacing
   * @param {Object} pos - Position {x, y}
   */
  drawGimp(user, pos) {
    // Check spacing
    if (user.spacing !== 0) {
      if (user.spaceIndex !== 0) {
        user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
        return;
      }
      user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
    }

    const gBrush = user.gBrush;
    if (!gBrush) return;

    const ctx = this.#canvasManager.mainCtx;
    const size = user.size;

    let height, width, image;

    if (gBrush.type === 'gbr') {
      height = gBrush.height;
      width = gBrush.width;
      image = gBrush.image;
    } else if (gBrush.type === 'gih') {
      height = gBrush.cellheight;
      width = gBrush.cellwidth;
      image = gBrush.images[gBrush.index];
      // Increment animated brush index
      gBrush.index = (gBrush.index + 1) % gBrush.ncells;
    }

    if (!image) return;

    let ratioX = width / height;
    let ratioY = height / width;

    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

    ctx.beginPath();
    ctx.fillStyle = this.#formatColor(user.color);
    ctx.drawImage(
      image,
      pos.x - size * ratioX,
      pos.y - size * ratioY,
      size * 2 * ratioX,
      size * 2 * ratioY
    );
    ctx.stroke();
  }

  /**
   * Clear and redraw a preview line on the top canvas
   * @param {Array} points - Line points
   * @param {Object} user - User state
   * @param {boolean} mirror - Mirror mode
   */
  previewLine(points, user, mirror = false) {
    this.#canvasManager.clearTop();
    const ctx = this.#canvasManager.topCtx;
    ctx.beginPath();
    this.drawLineWithMirror(points, ctx, user, mirror);
  }

  /**
   * Commit the preview line to the main canvas
   * @param {Array} points - Line points
   * @param {Object} user - User state
   * @param {boolean} mirror - Mirror mode
   */
  commitLine(points, user, mirror = false) {
    const ctx = this.#canvasManager.mainCtx;
    this.drawLineWithMirror(points, ctx, user, mirror);
    this.#canvasManager.clearTop();
  }

  #formatColor(color) {
    if (typeof color === 'string') {
      return color;
    }
    if (Array.isArray(color)) {
      return `rgba(${color.join(',')})`;
    }
    if (color && typeof color === 'object') {
      const { r, g, b, a = 1 } = color;
      return `rgba(${r},${g},${b},${a})`;
    }
    return '#000000';
  }
}
