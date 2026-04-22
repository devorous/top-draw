/**
 * @fileoverview Flow Pen tool for pressure-sensitive strokes using circle stamping.
 * Uses an offscreen canvas to prevent opacity stacking when circles overlap.
 */

import { getRenderableStampRadius, getStampSpacing } from '../utils/drawing.js';

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
 * Flow Pen tool for pressure-sensitive strokes using circle stamping.
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring parity between local preview and remote rendering.
 */
export class FlowPenTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('flowPen', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.lastStampPos = null;
    this.userAlpha = 1.0;
    this.strokeColor = null;
    this.stampBuffer = [];
    this.previewDirtyBounds = null;
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
   * Calculates the distance between two points.
   * @param {Object} p1 - First point.
   * @param {Object} p2 - Second point.
   * @returns {number} - The distance between the points.
   */
  getDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {
    this._activeUser = user;
    this.board.beginStroke(user);
    this.ensureOffscreenCanvas();

    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.color = color; 
    this.offscreenCtx.fillStyle = this.strokeColor;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = opacitySlider;
    
    const rawHardness = user.hardness !== undefined ? user.hardness : 100;
    this.userHardness = rawHardness > 1.0 ? rawHardness / 100.0 : rawHardness;
    if (this.userHardness > 1.0) this.userHardness = 1.0;

    this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.previewDirtyBounds = null;
    this.stampBuffer = [];

    const pressure255 = Math.round(pressure * 255);
    this.stampCircle(pos.x, pos.y, radius, pressure255);
    this.lastStampPos = { x: pos.x, y: pos.y, radius, pressure255 };

    user.penPoints = [{ x: pos.x, y: pos.y, radius }];
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos, lastPos, e) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRender) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    const spacing = getStampSpacing(this.lastStampPos.radius, radius);
    const distance = this.getDistance(this.lastStampPos, pos);

    if (distance >= spacing) {
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

    if (shouldRender) {
      const rect = this.getPreviewDirtyRect(user);
      if (rect !== false) {
        this.board.clearTop(rect);
        this.drawPreview(user, rect);
      }
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

    if (this.lastStampPos) {
      const pressure = this.quantizePressure(user.pressure);
      const radius = pressure * user.size;

      const spacing = getStampSpacing(this.lastStampPos.radius, radius);
      const distance = this.getDistance(this.lastStampPos, pos);

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

    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.userAlpha;

    this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0);

    this.board.forEachMirrorRegion({ rect: this.dirtyBounds ? {
      x: this.dirtyBounds.minX,
      y: this.dirtyBounds.minY,
      width: this.dirtyBounds.maxX - this.dirtyBounds.minX,
      height: this.dirtyBounds.maxY - this.dirtyBounds.minY
    } : null }, (region) => {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      this.board.drawMirroredCanvas(ctx, this.offscreenCanvas, region, 0, 0);
      ctx.restore();
    });

    ctx.globalAlpha = 1.0;

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const brushRadius = user.size;
      const blurAmount = (1 - this.userHardness) * (20 + user.size * 0.2);
      const safetyMargin = brushRadius * 0.25;
      const margin = blurAmount + safetyMargin + 2;

      const x = Math.floor(this.dirtyBounds.minX - margin);
      const y = Math.floor(this.dirtyBounds.minY - margin);
      const width = Math.ceil(this.dirtyBounds.maxX - this.dirtyBounds.minX + margin * 2);
      const height = Math.ceil(this.dirtyBounds.maxY - this.dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.minX, y: this.dirtyBounds.minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.maxX, y: this.dirtyBounds.maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });
    }

    // Track tile ownership
    if (user.penPoints && user.penPoints.length > 0) {
      const maxRadius = Math.max(...user.penPoints.map(p => p.radius || user.size));
      this.board.markDirtyPath(user, user.penPoints, maxRadius);
      this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(user.penPoints, region), maxRadius);
      });
    }

    this.clearStroke();
    user.penPoints = [];

    this.board.endStroke(user);
    this.board.clearTop();
  }

  /**
   * Stamps a circle onto the offscreen canvas.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {number} radius - The radius of the circle.
   * @param {number} pressure255 - The pressure (0-255).
   */
  stampCircle(x, y, radius, pressure255) {
    const ctx = this.offscreenCtx;

    ctx.fillStyle = this.strokeColor;
    ctx.beginPath();
    ctx.arc(x, y, getRenderableStampRadius(radius), 0, Math.PI * 2);
    ctx.fill();

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, x - radius);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, y - radius);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, x + radius);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, y + radius);
    }

    this._expandPreviewDirtyBounds(x - radius, y - radius, x + radius, y + radius);

    this.stampBuffer.push(x, y, pressure255);
  }

  /**
   * Draws the current stroke preview on the top canvas.
   * @param {Object} user - The user performing the action.
   */
  drawPreview(user, rect = null) {
    if (!this.offscreenCanvas) return;

    const ctx = this.board.topCtx;
    ctx.globalAlpha = this.userAlpha;

    this.compositeWithHardness(ctx, this.offscreenCanvas, user.size, 0, 0, rect);

    this.board.forEachMirrorRegion({ rect: this.dirtyBounds ? {
      x: this.dirtyBounds.minX,
      y: this.dirtyBounds.minY,
      width: this.dirtyBounds.maxX - this.dirtyBounds.minX,
      height: this.dirtyBounds.maxY - this.dirtyBounds.minY
    } : null }, (region) => {
      this.board.drawMirroredCanvas(ctx, this.offscreenCanvas, region, 0, 0);
    });

    ctx.globalAlpha = 1.0;
    this.previewDirtyBounds = null;
  }

  /**
   * Composites the offscreen canvas with a hardness-based blur effect.
   * @param {CanvasRenderingContext2D} ctx - The target canvas context.
   * @param {HTMLCanvasElement} sourceCanvas - The source canvas to composite.
   * @param {number} size - The stroke size.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   */
  compositeWithHardness(ctx, sourceCanvas, size, x, y, rect = null) {
    const blurAmount = (1 - this.userHardness) * (20 + size * 0.2);
    const sourceRect = rect ? this._clampRectToCanvas(rect, sourceCanvas) : null;

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = this.strokeColor;
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;
      if (sourceRect) {
        ctx.drawImage(
          sourceCanvas,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          x + sourceRect.x + offset,
          y + sourceRect.y,
          sourceRect.width,
          sourceRect.height
        );
      } else {
        ctx.drawImage(sourceCanvas, x + offset, y);
      }
      ctx.restore();
    } else if (sourceRect) {
      ctx.drawImage(
        sourceCanvas,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        x + sourceRect.x,
        y + sourceRect.y,
        sourceRect.width,
        sourceRect.height
      );
    } else {
      ctx.drawImage(sourceCanvas, x, y);
    }
  }

  /**
   * Drains the stamp buffer for network synchronization.
   * @returns {Object} - An object containing ps (positions) and rs (pressures).
   */
  drainStampBuffer() {
    const buf = this.stampBuffer;
    this.stampBuffer = [];
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
    if (this.offscreenCtx) {
      this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    this.lastStampPos = null;
    // stampBuffer is NOT wiped here: onPointerUp generates final bridge stamps
    // into it before calling clearStroke(), and App.js drains them afterward.
    // Reset is handled in onPointerDown.
    this.dirtyBounds = null;
    this.previewDirtyBounds = null;
  }

  getPreviewDirtyRect(user = this._activeUser) {
    const bounds = this.previewDirtyBounds;
    if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return false;
    if (this.board.mirrorRegions?.length > 0) return null;

    const size = user?.size ?? 0;
    const blurAmount = (1 - this.userHardness) * (20 + size * 0.2);
    const margin = blurAmount + size * 0.25 + 2;
    return {
      x: Math.floor(bounds.minX - margin),
      y: Math.floor(bounds.minY - margin),
      width: Math.ceil(bounds.maxX - bounds.minX + margin * 2),
      height: Math.ceil(bounds.maxY - bounds.minY + margin * 2)
    };
  }

  _expandPreviewDirtyBounds(minX, minY, maxX, maxY) {
    if (!this.previewDirtyBounds) {
      this.previewDirtyBounds = { minX, minY, maxX, maxY };
      return;
    }

    this.previewDirtyBounds.minX = Math.min(this.previewDirtyBounds.minX, minX);
    this.previewDirtyBounds.minY = Math.min(this.previewDirtyBounds.minY, minY);
    this.previewDirtyBounds.maxX = Math.max(this.previewDirtyBounds.maxX, maxX);
    this.previewDirtyBounds.maxY = Math.max(this.previewDirtyBounds.maxY, maxY);
  }

  _clampRectToCanvas(rect, canvas) {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const right = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this.lastStampPos && this._activeUser) {
      this.onPointerUp(this._activeUser, this.lastStampPos);
    }
    this._activeUser = null;
  }
}
