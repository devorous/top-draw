/** @fileoverview Handles pen and flowPen tool rendering for remote users using offscreen canvasing. */

import { getRenderableStampRadius, getStampSpacing } from '../utils/drawing.js';

/**
 * Handles pen/flowPen tool rendering for remote users.
 * Uses an offscreen canvas to prevent opacity stacking during a single stroke.
 */
export class RemotePenHandler {
  /**
   * @param {Board} board - The main board instance.
   */
  constructor(board) {
    this.board = board;
    this.hardnessCanvas = null;
    this.hardnessCtx = null;
  }

  /**
   * Ensures the user has a valid offscreen canvas for pen rendering.
   * @param {User} user - The remote user object.
   */
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

  /**
   * Initializes a new pen stroke for a remote user.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The starting coordinates {x, y}.
   */
  handlePenDown(user, pos) {
    this.ensurePenOffscreen(user);

    user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    const color = user.color.slice(0, 3);
    user._penStrokeColor = `rgb(${color.join(',')})`;
    user._penOffscreenCtx.fillStyle = user._penStrokeColor;

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._penAlpha = opacitySlider;
    user._penHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    const ctx = user._penOffscreenCtx;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, getRenderableStampRadius(radius), 0, Math.PI * 2);
    ctx.fill();

    user._penLastStampPos = { x: pos.x, y: pos.y, radius, pressure255: Math.round(pressure * 255) };
    user._penStrokeActive = true;
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];
    user._penDirtyBounds = { minX: pos.x - radius, minY: pos.y - radius, maxX: pos.x + radius, maxY: pos.y + radius };
    user._penPreviewDirtyBounds = { ...user._penDirtyBounds };

    this.updatePenPreview(user);
  }

  /**
   * Processes incoming stamp points and radii for an active pen stroke.
   * @param {User} user - The remote user object.
   * @param {number[]} points - Flat array of [x, y, x, y, ...] coordinates.
   * @param {number[]} radii - Array of radius values (0-255).
   */
  handlePenStamps(user, points, radii) {
    if (points.length < 2) return;

    if (!user._penStrokeActive) {
      user.clearLine();
      this.handlePenDown(user, { x: points[0], y: points[1] });
    }

    const ctx = user._penOffscreenCtx;
    ctx.fillStyle = user._penStrokeColor;

    for (let i = 0, ri = 0; i < points.length; i += 2, ri++) {
      const x = points[i];
      const y = points[i + 1];
      const pressure = radii[ri] / 255;
      const r = pressure * user.size;
      ctx.beginPath();
      ctx.arc(x, y, getRenderableStampRadius(r), 0, Math.PI * 2);
      ctx.fill();
      if (user.penPoints) {
        user.penPoints.push({ x, y, radius: r });
      }
      this.expandPenDirtyBounds(user, x, y, r);
    }

    const lastPtIdx = points.length - 2;
    const lastPressure = radii[radii.length - 1] / 255;
    const lastR = lastPressure * user.size;
    user._penLastStampPos = {
      x: points[lastPtIdx],
      y: points[lastPtIdx + 1],
      radius: lastR,
      pressure255: radii[radii.length - 1]
    };
    user.setPosition(points[lastPtIdx], points[lastPtIdx + 1]);
    this.updatePenPreview(user);
  }

  /**
   * Handles individual pen movement events and applies adaptive spacing.
   * @param {User} user - The remote user object.
   * @param {Object} pos - The new coordinates {x, y}.
   */
  handlePenMove(user, pos) {
    if (!user._penLastStampPos || !user._penOffscreenCtx) return;

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    const spacing = getStampSpacing(user._penLastStampPos.radius, radius);
    const dx = pos.x - user._penLastStampPos.x;
    const dy = pos.y - user._penLastStampPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= spacing) {
      const ctx = user._penOffscreenCtx;
      ctx.fillStyle = user._penStrokeColor;

      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = user._penLastStampPos.x + dx * t;
        const y = user._penLastStampPos.y + dy * t;
        const r = user._penLastStampPos.radius + (radius - user._penLastStampPos.radius) * t;
        ctx.beginPath();
        ctx.arc(x, y, getRenderableStampRadius(r), 0, Math.PI * 2);
        ctx.fill();
      }

      user._penLastStampPos = {
        x: pos.x,
        y: pos.y,
        radius,
        pressure255: Math.round(pressure * 255)
      };
      if (user.penPoints) {
        user.penPoints.push({ x: pos.x, y: pos.y, radius });
      }
      this.expandPenDirtyBounds(user, pos.x, pos.y, radius);

      this.updatePenPreview(user);
    }
  }

  /**
   * Finalizes and commits a pen stroke to the board layers.
   * @param {User} user - The remote user object.
   */
  handlePenUp(user) {
    if (!user._penLastStampPos || !user._penOffscreen) return;

    const pressure = Math.round((user.pressure ?? 1) * 255) / 255;
    const radius = pressure * user.size;
    const spacing = getStampSpacing(user._penLastStampPos.radius, radius);
    const dx = user.x - user._penLastStampPos.x;
    const dy = user.y - user._penLastStampPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 0.5) {
      const ctx = user._penOffscreenCtx;
      const pressure255End = Math.round(pressure * 255);
      const steps = Math.max(1, Math.ceil(distance / spacing));

      ctx.fillStyle = user._penStrokeColor;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = user._penLastStampPos.x + dx * t;
        const y = user._penLastStampPos.y + dy * t;
        const r = user._penLastStampPos.radius + (radius - user._penLastStampPos.radius) * t;
        ctx.beginPath();
        ctx.arc(x, y, getRenderableStampRadius(r), 0, Math.PI * 2);
        ctx.fill();
        if (user.penPoints) {
          user.penPoints.push({ x, y, radius: r });
        }
        this.expandPenDirtyBounds(user, x, y, r);
      }

      user._penLastStampPos = {
        x: user.x,
        y: user.y,
        radius,
        pressure255: pressure255End
      };
    }

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
      this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: minX, y: minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: maxX, y: maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });

      // Track tile ownership for remote user
      const points = user.penPoints.map(pt => ({ x: pt.x, y: pt.y }));
      const maxRadius = Math.max(...user.penPoints.map(p => p.radius || user.size));
      this.board.markDirtyPath(user, points, maxRadius);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), maxRadius);
      });
    }

    const strokeLayer = user._strokeLayer ?? user.activeLayer;
    const layerCtx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id);
    if (layerCtx) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._penAlpha;

      const hardnessCanvas = this.getHardnessCanvas(user._penOffscreen, user.size, user._penHardness, user._penStrokeColor);
      layerCtx.drawImage(hardnessCanvas, 0, 0);

      this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        this.board.drawMirroredCanvas(layerCtx, hardnessCanvas, region, 0, 0);
        layerCtx.restore();
      });

      layerCtx.globalAlpha = 1.0;
      this.board.requestUpdate();
    }

    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    user._penDirtyBounds = null;
    user._penPreviewDirtyBounds = null;
    user.penPoints = [];
  }

  /**
   * Updates the user's preview canvas with the current pen stroke state.
   * @param {User} user - The remote user object.
   */
  updatePenPreview(user) {
    if (!user._penOffscreen) return;

    const previewRect = this.board.mirrorRegions?.length > 0 ? null : this.getPreviewDirtyRect(user);
    const clearRect = previewRect ? this._clampRectToCanvas(previewRect, user.context.canvas) : null;
    if (clearRect) {
      user.context.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
    } else {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    user.context.globalAlpha = user._penAlpha;

    const hardnessCanvas = this.getHardnessCanvas(user._penOffscreen, user.size, user._penHardness, user._penStrokeColor, previewRect);
    const sourceRect = previewRect ? this._clampRectToCanvas(previewRect, hardnessCanvas) : null;
    if (sourceRect) {
      user.context.drawImage(
        hardnessCanvas,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height,
        sourceRect.x,
        sourceRect.y,
        sourceRect.width,
        sourceRect.height
      );
    } else {
      user.context.drawImage(hardnessCanvas, 0, 0);
    }

    this.board.forEachMirrorRegion({ points: user.penPoints }, (region) => {
      this.board.drawMirroredCanvas(user.context, hardnessCanvas, region, 0, 0);
    });

    user.context.globalAlpha = 1.0;
    user._penPreviewDirtyBounds = null;
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
  compositeWithHardness(ctx, sourceCanvas, size, hardness, strokeColor, x, y, rect = null) {
    const blurAmount = (1 - hardness) * (20 + size * 0.2);
    const sourceRect = rect ? this._clampRectToCanvas(rect, sourceCanvas) : null;

    if (blurAmount > 0) {
      const offset = 100000;
      ctx.save();
      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = strokeColor;
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

  getHardnessCanvas(sourceCanvas, size, hardness, strokeColor, rect = null) {
    if (!this.hardnessCanvas ||
        this.hardnessCanvas.width !== sourceCanvas.width ||
        this.hardnessCanvas.height !== sourceCanvas.height) {
      this.hardnessCanvas = document.createElement('canvas');
      this.hardnessCanvas.width = sourceCanvas.width;
      this.hardnessCanvas.height = sourceCanvas.height;
      this.hardnessCtx = this.hardnessCanvas.getContext('2d');
    }

    const clearRect = rect ? this._clampRectToCanvas(rect, this.hardnessCanvas) : null;
    if (clearRect) {
      this.hardnessCtx.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
    } else {
      this.hardnessCtx.clearRect(0, 0, this.hardnessCanvas.width, this.hardnessCanvas.height);
    }
    this.compositeWithHardness(this.hardnessCtx, sourceCanvas, size, hardness, strokeColor, 0, 0, rect);
    return this.hardnessCanvas;
  }

  expandPenDirtyBounds(user, x, y, radius) {
    const minX = x - radius;
    const minY = y - radius;
    const maxX = x + radius;
    const maxY = y + radius;

    if (!user._penDirtyBounds) {
      user._penDirtyBounds = { minX, minY, maxX, maxY };
    } else {
      user._penDirtyBounds.minX = Math.min(user._penDirtyBounds.minX, minX);
      user._penDirtyBounds.minY = Math.min(user._penDirtyBounds.minY, minY);
      user._penDirtyBounds.maxX = Math.max(user._penDirtyBounds.maxX, maxX);
      user._penDirtyBounds.maxY = Math.max(user._penDirtyBounds.maxY, maxY);
    }

    if (!user._penPreviewDirtyBounds) {
      user._penPreviewDirtyBounds = { minX, minY, maxX, maxY };
      return;
    }
    user._penPreviewDirtyBounds.minX = Math.min(user._penPreviewDirtyBounds.minX, minX);
    user._penPreviewDirtyBounds.minY = Math.min(user._penPreviewDirtyBounds.minY, minY);
    user._penPreviewDirtyBounds.maxX = Math.max(user._penPreviewDirtyBounds.maxX, maxX);
    user._penPreviewDirtyBounds.maxY = Math.max(user._penPreviewDirtyBounds.maxY, maxY);
  }

  getPreviewDirtyRect(user) {
    const bounds = user._penPreviewDirtyBounds;
    if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return null;

    const size = user.size || 0;
    const hardness = user._penHardness !== undefined ? user._penHardness : 1.0;
    const blurAmount = (1 - hardness) * (20 + size * 0.2);
    const margin = blurAmount + size * 0.25 + 2;
    return {
      x: Math.floor(bounds.minX - margin),
      y: Math.floor(bounds.minY - margin),
      width: Math.ceil(bounds.maxX - bounds.minX + margin * 2),
      height: Math.ceil(bounds.maxY - bounds.minY + margin * 2)
    };
  }

  _clampRectToCanvas(rect, canvas) {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const right = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }
}
