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
    this.hardnessCanvas = null;
    this.hardnessCtx = null;
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

    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._inkAlpha = opacitySlider;
    user._inkHardness = user.hardness !== undefined ? user.hardness / 100 : 1.0;

    user._inkSize = user.size;

    // Don't add the initial point here — match local InkTool behavior where
    // inputPoints starts empty and waits for first move with real pressure data.
    // Points are added by handleInkPoints which processes all incoming points.
    user._inkPoints = [];
    user._inkStrokeActive = true;
    user._inkDirtyBounds = { minX: pos.x, minY: pos.y, maxX: pos.x, maxY: pos.y };

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
      // Skip pressure=0 points — they indicate a liftoff sample and produce
      // artefacts (sharp blobs) when fed into the perfect-freehand pipeline.
      if (pressure === 0) continue;
      user._inkPoints.push([points[i], points[i + 1], pressure]);
      this.expandInkDirtyBounds(user, points[i], points[i + 1]);
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
    const points = user._inkPoints.map(pt => ({ x: pt[0], y: pt[1] }));

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
      this.board.markDirtyPath(user, points, size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), size);
      });
    }

    const strokeLayer = user._strokeLayer ?? user.activeLayer;
    // Resolve the stroke blend from synced user state (respecting the layer's
    // complex-blend restriction), matching how handleMouseDown/_syncLayeredRemotePreview
    // would have begun this stroke. Passing it means that if the active stroke was
    // lazily created as source-over — e.g. a joiner that missed this stroke's
    // MD/CBM preamble in the join race — getUserStrokeContext corrects its blend
    // instead of baking the stroke flat (overlay → plain black). See
    // LayerManager.getUserStrokeContext (it overwrites a stale non-source-over blend).
    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(strokeLayer);
    const strokeBlend = allowComplex ? (user.blendMode || 'source-over') : 'source-over';
    const layerCtx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id, strokeBlend, { blendBakeMode: user.blendBakeMode });
    if (layerCtx) {
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = user._inkAlpha;

      const hardnessCanvas = this.getHardnessCanvas(user._inkOffscreen, user._inkSize || user.size, user._inkHardness, user._inkStrokeColor);
      layerCtx.drawImage(hardnessCanvas, 0, 0);

      this.board.forEachMirrorRegion({ points }, (region) => {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        this.board.drawMirroredCanvas(layerCtx, hardnessCanvas, region, 0, 0);
        layerCtx.restore();
      });

      layerCtx.globalAlpha = 1.0;
      this.board.requestUpdate();
    }

    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
    user._inkDirtyBounds = null;
  }

  /**
   * Renders the current ink points to the user's offscreen context.
   * @param {User} user - The remote user object.
   * @param {boolean} last - Whether this is the final segment of the stroke.
   */
  renderInkStroke(user, last) {
    if (!user._inkPoints || user._inkPoints.length < 1) return;

    const ctx = user._inkCtx;
    const previewRect = this.getPreviewDirtyRect(user);
    const clearRect = previewRect ? this._clampRectToCanvas(previewRect, user._inkOffscreen) : null;
    if (clearRect) {
      ctx.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
    } else {
      ctx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);
    }

    const simulatePressure = user.simulatePressure !== undefined ? user.simulatePressure : true;
    const inkSize = user._inkSize || user.size;
    const rawThinning = user.thinning !== undefined ? user.thinning : 0.5;
    const thinning = !simulatePressure ? 0.95 : Math.min(0.99, rawThinning * Math.max(1, inkSize / 10));

    // Single point: render as a dot
    if (user._inkPoints.length === 1) {
      if (!last) return;

      const [x, y, pressure] = user._inkPoints[0];
      const dotPressure = pressure !== undefined ? pressure : 1;
      ctx.fillStyle = user._inkStrokeColor;
      ctx.beginPath();
      ctx.arc(x, y, inkSize * dotPressure, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Very short strokes can arrive in tiny remote batches. Perfect-freehand
    // can collapse these into an unstable preview, so draw a simple segment
    // instead of clearing to blank between network updates.
    if (user._inkPoints.length === 2) {
      const [x0, y0, pressure0] = user._inkPoints[0];
      const [x1, y1, pressure1] = user._inkPoints[1];
      const averagePressure = ((pressure0 ?? 1) + (pressure1 ?? 1)) / 2;
      const width = Math.max(0.5, inkSize * averagePressure);
      ctx.fillStyle = user._inkStrokeColor;
      ctx.strokeStyle = user._inkStrokeColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      return;
    }

    // Match local ink preview behavior: wait for enough points to form a real
    // stroke shape before drawing the preview, avoiding oversized start blobs.
    if (!last && user._inkPoints.length < 3) return;

    const userSmoothing = user.smoothing !== undefined ? user.smoothing / 50 : 0.5;
    // We use a baseline streamline even at 0 smoothing to stabilize velocity calculation in perfect-freehand
    const streamline = 0.3 + (userSmoothing * 0.7); // Scale 0.3 to 1.0

    const options = {
      size: Math.max(0.1, (inkSize * 2) / (1 + rawThinning)),
      thinning: thinning,
      smoothing: userSmoothing,
      streamline: streamline,
      simulatePressure: simulatePressure,
      last
    };

    // Use pressure values directly without squaring
    const strokePoints = user._inkPoints;

    const outlinePoints = getStroke(strokePoints, options);

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

    const previewRect = this.board.hasMirrors?.() ? null : this.getPreviewDirtyRect(user);
    const clearRect = previewRect ? this._clampRectToCanvas(previewRect, user.context.canvas) : null;
    if (clearRect) {
      user.context.clearRect(clearRect.x, clearRect.y, clearRect.width, clearRect.height);
    } else {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    user.context.globalAlpha = user._inkAlpha;

    const hardnessCanvas = this.getHardnessCanvas(
      user._inkOffscreen,
      user._inkSize || user.size,
      user._inkHardness,
      user._inkStrokeColor,
      previewRect
    );
    const sourceRect = previewRect ? this._clampRectToCanvas(previewRect, hardnessCanvas) : null;
    this.board.withSelectionMaskClip(user.context, user.id, () => {
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

      this.board.forEachMirrorRegion({ points: user._inkPoints?.map(pt => ({ x: pt[0], y: pt[1] })) || [] }, (region) => {
        this.board.drawMirroredCanvas(user.context, hardnessCanvas, region, 0, 0);
      });
    });

    user.context.globalAlpha = 1.0;
    this.board.maskPreviewForExistingMode?.(user.context, user, previewRect);
    this.board.app?.remoteUserHandler?.selectionHandler?.drawStaticMaskOutline?.(user, user.maskSelection, false);
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

  expandInkDirtyBounds(user, x, y) {
    if (!user._inkDirtyBounds) {
      user._inkDirtyBounds = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }
    user._inkDirtyBounds.minX = Math.min(user._inkDirtyBounds.minX, x);
    user._inkDirtyBounds.minY = Math.min(user._inkDirtyBounds.minY, y);
    user._inkDirtyBounds.maxX = Math.max(user._inkDirtyBounds.maxX, x);
    user._inkDirtyBounds.maxY = Math.max(user._inkDirtyBounds.maxY, y);
  }

  getPreviewDirtyRect(user) {
    const bounds = user._inkDirtyBounds;
    if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return null;

    const size = user._inkSize || user.size;
    const hardness = user._inkHardness !== undefined ? user._inkHardness : 1.0;
    const blurAmount = (1 - hardness) * (20 + size * 0.2);
    const margin = size + (blurAmount * 2.5) + size * 0.5 + 15;
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
