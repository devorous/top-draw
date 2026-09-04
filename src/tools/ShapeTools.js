/**
 * @fileoverview Tools for drawing basic shapes (lines, rectangles, circles).
 * The shared stroke lifecycle — preview, commit, mirror reflection, dirty-rect
 * expansion, and tile-ownership tracking — lives in the `ShapeTool` base class;
 * each concrete tool supplies only its path geometry and bounds.
 */

import { Tool } from './BaseTool.js';

/**
 * Base class for click-drag shape tools. Subclasses implement three hooks:
 *   _drawShapePath(ctx, start, end) — stroke the shape onto `ctx`
 *   _getCoverBox(start, end, constrain) — {minX,minY,maxX,maxY} un-margined bounds
 *   _getTrackingPoints(start, end, constrain) — points for tile-ownership tracking
 */
class ShapeTool extends Tool {
  /**
   * @param {string} name - Tool name.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    super(name, board);
    this.startPos = null;
    this.drawMode = 'corner-to-corner';
  }

  /**
   * Updates the shape draw mode.
   * @param {string} mode - 'center-scaling' or 'corner-to-corner'.
   */
  setDrawMode(mode) {
    this.drawMode = mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
  }

  /**
   * Returns whether Shift snapping is currently active.
   * @returns {boolean}
   */
  isSnapConstrained() {
    return !!this.board?.app?.isShiftModifierActive?.();
  }

  /**
   * Whether `user` is the local user driving this client's input.
   * @param {Object} user
   * @returns {boolean}
   */
  _isSelf(user) {
    const self = this.board?.app?.self;
    if (!user || !self) return true;
    return user === self || user.id === self.id;
  }

  /**
   * The draw mode to render `user`'s shape with. Always the DRAWER's mode —
   * the tool instances are shared with remote-user rendering, so reading
   * `this.drawMode` here would apply the observer's setting to someone else's
   * shape. Falls back to the instance mode for callers with no user.
   * @param {Object} user
   * @returns {string}
   */
  _modeFor(user) {
    const mode = user?.shapeDrawMode;
    return mode === 'center-scaling' || mode === 'corner-to-corner' ? mode : this.drawMode;
  }

  /**
   * Whether to snap `user`'s shape to square/circle proportions.
   *
   * Drag points are already constrained on the drawer, before they are
   * previewed or broadcast (App.getConstrainedShapeDragPoint), so a remote
   * endpoint arrives carrying that user's snap. Re-applying the observer's own
   * Shift key would snap a shape its author never snapped.
   * @param {Object} user
   * @returns {boolean}
   */
  _constrainFor(user) {
    return this._isSelf(user) ? this.isSnapConstrained() : false;
  }

  /**
   * Deactivates the tool, committing any in-progress shape.
   */
  deactivate() {
    if (this._activeUser && this.startPos) {
      this.onPointerUp(this._activeUser, this.board.lastMousePos || this.startPos);
    }
    this.startPos = null;
    this._activeUser = null;
  }

  /**
   * Handles pointer down: begins a stroke and anchors the start point.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    this._beginStrokeWindowed(user, pos);
    this.startPos = { x: pos.x, y: pos.y };
    this._onShapeStart(user, pos);
  }

  /**
   * Begin this user's active stroke windowed to a seed point instead of via
   * `Board.beginStroke` — that shared wrapper calls `LayerManager.beginUserStroke`
   * with no `bounds`, allocating full-board immediately; the windowed
   * `getUserStrokeContext` call in `onPointerUp` would then find `active`
   * already exists with `origin: null` and never grow. Same trap already
   * found and fixed in EraserTool/BlurTool/GlitchBlurTool/ConfettiTool/
   * ImageBrushTool. Replicates `beginStroke`'s other effects (mask clip,
   * requestUpdate) directly. Only a SEED — shapes never touch the active
   * stroke again until onPointerUp draws the whole thing at once with the
   * real final bounds, which grows this window to fit exactly.
   * @private
   */
  _beginStrokeWindowed(user, pos) {
    if (user?.panning) return;
    const activeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.board.app?.self?.id ?? 0;
    const blendMode = user?.blendMode ?? 'source-over';
    const margin = this._computeMargin(user);
    const bounds = this._foldMirrorBounds({
      x: pos.x - margin, y: pos.y - margin, width: margin * 2, height: margin * 2
    });
    this.board.layerManager?.beginUserStroke(activeLayer, userId, blendMode, user?.blendBakeMode, bounds);
    this.board.applySelectionMaskClipForStroke(activeLayer, userId);
    this.board.requestUpdate();
  }

  /**
   * Expand a board-absolute box to also cover every active mirror region's
   * transformed copy — same simplification the rest of this windowing
   * campaign uses (brush/eraser/blur/glitchBlur/confetti/imageBrush).
   * @private
   */
  _foldMirrorBounds(bounds) {
    const regions = this.board.getActiveMirrorRegions?.() || [];
    if (!regions.length) return bounds;
    let minX = bounds.x, minY = bounds.y;
    let maxX = bounds.x + bounds.width, maxY = bounds.y + bounds.height;
    const corners = [
      { x: minX, y: minY }, { x: maxX, y: minY },
      { x: minX, y: maxY }, { x: maxX, y: maxY }
    ];
    for (const region of regions) {
      const mirrored = this.board.mirrorPointsToRegion(corners, region);
      for (const p of mirrored) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Hook fired after the start point is anchored. Default draws an initial
   * preview; tools may override (e.g. LineTool defers preview to first move).
   * @param {Object} user
   * @param {Object} pos
   */
  _onShapeStart(user, pos) {
    this.drawPreview(user, pos);
  }

  /**
   * Handles pointer move: refreshes the live preview.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  /**
   * Handles pointer up: commits the shape to the active layer (plus mirror
   * reflections), expands dirty rects, and tracks tile ownership.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    const start = this.startPos;
    const constrain = this._constrainFor(user);
    const activeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.board.app?.self?.id ?? 0;

    // The shape's real, final extent is already known here (unlike a stamped
    // tool, this is drawn exactly once) — reuse the same margin/box already
    // computed below for expandDirtyRect as the window bounds too, folded
    // through mirrors since those draw onto the same canvas.
    const margin = this._computeMargin(user);
    const rect = this._marginRect(this._getCoverBox(start, pos, constrain, user), margin);
    const windowBounds = this._foldMirrorBounds(rect);
    const layerCtx = this.board.layerManager?.getUserStrokeContext(
      activeLayer, userId, undefined, undefined, windowBounds
    );

    if (layerCtx) {
      // Active canvas may be windowed (see docs/
      // scope_layermanager_active_stroke_windowing_RESULT.md) — drawShape and
      // the mirror clip both operate in board-absolute coordinates, so
      // translate by -origin first, same fix shape as every other tool in
      // this campaign.
      const active = this.board.layerManager.getActiveStroke(activeLayer, userId);
      const ox = active?.origin?.x ?? 0;
      const oy = active?.origin?.y ?? 0;
      if (ox || oy) layerCtx.save();
      try {
        if (ox || oy) layerCtx.translate(-ox, -oy);

        this.drawShape(layerCtx, user, start, pos);

        this.board.forEachMirrorRegion({ points: [start, pos] }, (region) => {
          this.board.withMirrorRegionClip(layerCtx, region, () => {
            this.drawShape(
              layerCtx,
              user,
              this.board.mirrorPointToRegion(start, region),
              this.board.mirrorPointToRegion(pos, region)
            );
          });
        });
      } finally {
        if (ox || oy) layerCtx.restore();
      }
    }

    this.board.expandDirtyRect(user, rect.x, rect.y, rect.width, rect.height);

    this.board.forEachMirrorRegion({ rect }, (region) => {
      const mStart = this.board.mirrorPointToRegion(start, region);
      const mEnd = this.board.mirrorPointToRegion(pos, region);
      const mRect = this._marginRect(this._getCoverBox(mStart, mEnd, constrain, user), margin);
      this.board.expandDirtyRect(user, mRect.x, mRect.y, mRect.width, mRect.height);
    });

    const points = this._getTrackingPoints(start, pos, constrain, user);
    this.board.markDirtyPath(user, points, margin);
    this.board.forEachMirrorRegion({ points }, (region) => {
      this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), margin);
    });

    this.startPos = null;
    this.board.endStroke(user);
    this.board.clearTop();
  }

  /**
   * Draws the live preview (with mirror reflections) onto the top canvas.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  drawPreview(user, pos) {
    this.drawPreviewOnContext(this.board.topCtx, user, this.startPos, pos);
  }

  /**
   * Draws the shape preview (selection-mask clip + mirror reflections +
   * existing-mode masking) onto an explicit context. Used both for the local
   * top-canvas preview and by RemoteUserHandler for remote-user rendering.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawPreviewOnContext(ctx, user, start, end) {
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      this.drawShape(ctx, user, start, end);

      this.board.forEachMirrorRegion({ points: [start, end] }, (region) => {
        this.board.withMirrorRegionClip(ctx, region, () => {
          this.drawShape(
            ctx,
            user,
            this.board.mirrorPointToRegion(start, region),
            this.board.mirrorPointToRegion(end, region)
          );
        });
      });
    });
    this.board.maskPreviewForExistingMode(ctx, user);
  }

  /**
   * Strokes the shape with the user's color/opacity, applying the soft-edge
   * shadow trick when hardness < 100. The actual path is drawn by the subclass.
   * @param {CanvasRenderingContext2D} ctx - The target context.
   * @param {Object} user - The user performing the action.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   */
  drawShape(ctx, user, start, end) {
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const hardness = (user.hardness !== undefined ? user.hardness : 100) / 100;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.size * 2;

    if (hardness < 1.0) {
      const blurAmount = (1 - hardness) * (20 + user.size * 0.2);
      const offset = 100000;

      ctx.shadowBlur = blurAmount;
      ctx.shadowColor = user.getColorString();
      ctx.shadowOffsetX = -offset;
      ctx.shadowOffsetY = 0;

      ctx.save();
      ctx.translate(offset, 0);
    } else {
      ctx.shadowBlur = 0;
    }

    this._drawShapePath(ctx, start, end, user);

    if (hardness < 1.0) {
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.globalAlpha = 1.0;
  }

  /**
   * Computes the dirty-rect margin around a shape (line width + soft-edge blur
   * + safety padding).
   * @param {Object} user
   * @returns {number}
   */
  _computeMargin(user) {
    const radius = user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1.0 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    const safetyMargin = radius * 0.1;
    return radius + blurAmount + safetyMargin + 2;
  }

  /**
   * Expands a {minX,minY,maxX,maxY} box by `margin` and snaps to integer pixels.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} box
   * @param {number} margin
   * @returns {{x:number,y:number,width:number,height:number}}
   */
  _marginRect(box, margin) {
    const x = Math.floor(box.minX - margin);
    const y = Math.floor(box.minY - margin);
    return {
      x,
      y,
      width: Math.ceil(box.maxX + margin) - x,
      height: Math.ceil(box.maxY + margin) - y
    };
  }
}

/**
 * Line tool for drawing straight lines.
 */
export class LineTool extends ShapeTool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('line', board);
  }

  /** Line defers its preview to the first pointer move (matches legacy behavior). */
  _onShapeStart(user) {
    user.startPos = this.startPos;
  }

  _drawShapePath(ctx, start, end) {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  _getCoverBox(start, end) {
    return {
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y)
    };
  }

  _getTrackingPoints(start, end) {
    return [start, end];
  }
}

/**
 * Rectangle tool for drawing rectangles.
 */
export class RectangleTool extends ShapeTool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('rectangle', board);
  }

  /**
   * Computes rectangle bounds for the current draw mode.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   * @param {boolean} constrain - Whether to enforce square proportions.
   * @param {string} [mode] - Draw mode to use; defaults to this tool's mode.
   * @returns {{x:number, y:number, w:number, h:number}}
   */
  getRectBounds(start, end, constrain, mode = this.drawMode) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (mode === 'center-scaling') {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      const halfW = side;
      const halfH = side;

      return {
        x: start.x - halfW,
        y: start.y - halfH,
        w: halfW * 2,
        h: halfH * 2
      };
    }

    if (!constrain) {
      return {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        w: Math.abs(dx),
        h: Math.abs(dy)
      };
    }

    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
    const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
    const x2 = start.x + sx * side;
    const y2 = start.y + sy * side;

    return {
      x: Math.min(start.x, x2),
      y: Math.min(start.y, y2),
      w: Math.abs(x2 - start.x),
      h: Math.abs(y2 - start.y)
    };
  }

  /** Backward-compatible raw draw used by RemoteUserHandler. */
  drawRect(ctx, user, start, end) {
    this.drawShape(ctx, user, start, end);
  }

  _drawShapePath(ctx, start, end, user) {
    const { x, y, w, h } = this.getRectBounds(
      start, end, this._constrainFor(user), this._modeFor(user)
    );
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.stroke();
  }

  _getCoverBox(start, end, constrain, user) {
    const b = this.getRectBounds(start, end, constrain, this._modeFor(user));
    return { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h };
  }

  _getTrackingPoints(start, end, constrain, user) {
    const b = this.getRectBounds(start, end, constrain, this._modeFor(user));
    return [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
      { x: b.x, y: b.y + b.h },
      { x: b.x, y: b.y }
    ];
  }
}

/**
 * Circle tool for drawing circles/ellipses.
 */
export class CircleTool extends ShapeTool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('circle', board);
  }

  /**
   * Computes ellipse geometry for the current draw mode.
   * @param {Object} start - Start point.
   * @param {Object} end - End point.
   * @param {boolean} constrain - Whether to enforce circle proportions.
   * @param {string} [mode] - Draw mode to use; defaults to this tool's mode.
   * @returns {{cx:number, cy:number, rx:number, ry:number}}
   */
  getEllipseParams(start, end, constrain, mode = this.drawMode) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (mode === 'center-scaling') {
      const radius = Math.hypot(dx, dy);
      return {
        cx: start.x,
        cy: start.y,
        rx: radius,
        ry: radius
      };
    }

    if (!constrain) {
      return {
        cx: (start.x + end.x) / 2,
        cy: (start.y + end.y) / 2,
        rx: Math.abs(dx) / 2,
        ry: Math.abs(dy) / 2
      };
    }

    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
    const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
    const x2 = start.x + sx * side;
    const y2 = start.y + sy * side;

    return {
      cx: (start.x + x2) / 2,
      cy: (start.y + y2) / 2,
      rx: Math.abs(x2 - start.x) / 2,
      ry: Math.abs(y2 - start.y) / 2
    };
  }

  /** Backward-compatible raw draw used by RemoteUserHandler. */
  drawEllipse(ctx, user, start, end) {
    this.drawShape(ctx, user, start, end);
  }

  _drawShapePath(ctx, start, end, user) {
    const { cx, cy, rx, ry } = this.getEllipseParams(
      start, end, this._constrainFor(user), this._modeFor(user)
    );
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  _getCoverBox(start, end, constrain, user) {
    const { cx, cy, rx, ry } = this.getEllipseParams(start, end, constrain, this._modeFor(user));
    return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
  }

  _getTrackingPoints(start, end, constrain, user) {
    const { cx, cy, rx, ry } = this.getEllipseParams(start, end, constrain, this._modeFor(user));
    const points = [];
    const steps = Math.max(16, Math.ceil(Math.max(rx, ry) / 8));
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
    }
    return points;
  }
}
