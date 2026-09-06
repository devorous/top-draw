/**
 * @fileoverview Blur tool - stamps blurred pixels sampled from the active layer.
 */

import { Tool } from './BaseTool.js';
import { SnapshotCanvasPool } from '../utils/snapshotCanvasPool.js';

/**
 * Blur tool that behaves like an image brush: each stamp samples from a
 * stroke-start snapshot, blurs that sample, and paints the resulting pixels
 * into the active stroke canvas.
 */
export class BlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('blur', board);
    this.lastStampPos = new Map(); // userId -> {x, y}
    this.strokePoints = new Map(); // userId -> [{x, y}, ...]
    this.snapshotCanvases = new Map();
    this._snapshotPool = new SnapshotCanvasPool(); // userId -> canvas
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    if (this._activeUser) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      if (lastPos) {
        this.onPointerUp(this._activeUser, lastPos);
      }
    }
    this.lastStampPos.clear();
    this.snapshotCanvases.clear();
    this._activeUser = null;
  }

  _getTargetLayer(user) {
    return user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
  }

  /**
   * Borrow a board-sized snapshot canvas. See {@link SnapshotCanvasPool} for why
   * this is pooled rather than allocated per stroke.
   * @param {number} w
   * @param {number} h
   * @returns {HTMLCanvasElement}
   * @private
   */
  _acquireSnapshotCanvas(w, h) {
    return this._snapshotPool.acquire(w, h);
  }

  /** Return a snapshot canvas to the free-list at stroke end. */
  _releaseSnapshotCanvas(canvas) {
    this._snapshotPool.release(canvas);
  }

  captureSnapshot(userId, layerIdx) {
    const w = this.board.getWidth();
    const h = this.board.getHeight();
    let canvas = this.snapshotCanvases.get(userId);
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      if (canvas) this._releaseSnapshotCanvas(canvas);
      canvas = this._acquireSnapshotCanvas(w, h);
      this.snapshotCanvases.set(userId, canvas);
    }
    const ctx = canvas.getContext('2d');
    // clearRect, not a width reassignment: the latter drops and reallocates the
    // backing store, which is the whole cost being avoided here.
    ctx.clearRect(0, 0, w, h);

    // Include the room background in the blur source so transparent layer
    // pixels blur against the same color the room actually displays.
    // Snapshot only the target layer above the room background so upper-layer
    // pixels cannot be blurred into this layer's stroke.
    const backgroundColor = this.board.roomBackgroundColor || this.board.backgroundColor || [255, 255, 255, 1];
    this.board.layerManager.compositeLayerRange(ctx, layerIdx, layerIdx + 1, backgroundColor);
  }

  clearSnapshot(userId) {
    const canvas = this.snapshotCanvases.get(userId);
    this.snapshotCanvases.delete(userId);
    this._releaseSnapshotCanvas(canvas);
  }

  /**
   * Scratch canvas the per-stamp blur is built on.
   *
   * `paintMask` used to `document.createElement('canvas')` on EVERY stamp point
   * — hundreds per stroke — which is the single most expensive canvas operation
   * there is and is invisible to JS timers. Same shape as the fixes in
   * [[pattern_composite_bounds_clipping]] and the glitch crop path.
   *
   * Grows to the largest crop seen and is never shrunk; a blur stamp is bounded
   * by (size + 2 x blurRadius) x 2, so this stays small.
   *
   * @param {number} w
   * @param {number} h
   * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
   * @private
   */
  _getBlurScratch(w, h) {
    let scratch = this._blurScratch;
    if (!scratch || scratch.canvas.width < w || scratch.canvas.height < h) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(w, scratch?.canvas.width ?? 0);
      canvas.height = Math.max(h, scratch?.canvas.height ?? 0);
      scratch = { canvas, ctx: canvas.getContext('2d') };
      this._blurScratch = scratch;
    }
    return scratch;
  }

  /**
   * Handles pointer down event.
   * Begins a regular stroke and starts stamping blurred pixels.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    const activeLayerIdx = this._getTargetLayer(user);
    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    const rawBlurRadius = Number(user.blurRadius);
    user.blurRadius = Math.max(1, Math.min(10, Number.isFinite(rawBlurRadius) ? rawBlurRadius : 10));

    this.captureSnapshot(userId, activeLayerIdx);

    // NOT this.board.beginStroke(user) — that wrapper calls
    // LayerManager.beginUserStroke with no `bounds`, which would create the
    // active stroke full-board immediately; by the time the windowed
    // getUserStrokeContext call below ran, `active` would already exist
    // (origin null) and never grow. Replicate beginStroke's other effects
    // (blend mode resolution, mask clip, requestUpdate) with bounds instead —
    // same reason EraserTool._beginStroke bypasses it too.
    const bounds = this._canWindowActiveStroke(user)
      ? this._foldMirrorBounds(this._stampBounds(pos.x, pos.y, user.size, this._stampMargin(user)))
      : null;
    const blendMode = user?.blendMode ?? 'source-over';
    this.board.layerManager?.beginUserStroke(activeLayerIdx, userId, blendMode, user?.blendBakeMode, bounds);
    this.board.applySelectionMaskClipForStroke(activeLayerIdx, userId);

    const maskCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, userId, undefined, undefined, bounds);
    if (!maskCtx) {
      console.warn('BlurTool: No stroke context available');
      return;
    }

    // Initialize bounds tracking for this stroke
    user.blurBounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };

    this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    this.strokePoints.set(userId, [{ x: pos.x, y: pos.y }]);

    // The active stroke canvas may now be windowed (see docs/
    // scope_layermanager_active_stroke_windowing_RESULT.md) — paintMask's
    // clip/drawImage calls use board-absolute coordinates, so the ctx needs
    // translating by -origin to land on the (small) canvas's own pixel
    // space, same fix shape as brush/eraser.
    const active = this.board.layerManager.getActiveStroke(activeLayerIdx, userId);
    const ox = active?.origin?.x ?? 0;
    const oy = active?.origin?.y ?? 0;
    if (ox || oy) maskCtx.save();
    try {
      if (ox || oy) maskCtx.translate(-ox, -oy);

      // Paint the first mask stamp
      this.paintMask(pos.x, pos.y, user.size, user, maskCtx);

      this.board.forEachMirrorRegion({ point: pos }, (region) => {
        const mirrored = this.board.mirrorPointToRegion(pos, region);
        this.board.withMirrorRegionClip(maskCtx, region, () => {
          this.paintMask(mirrored.x, mirrored.y, user.size, user, maskCtx);
        });
      });
    } finally {
      if (ox || oy) maskCtx.restore();
    }

    this.board.requestUpdate();
  }

  /**
   * Whether this tool's active stroke canvas may be windowed rather than
   * full-board — see docs/scope_layermanager_active_stroke_windowing_RESULT.md.
   * Unlike eraser, blur has no all-layers variant and always targets exactly
   * one layer, so this is unconditionally true.
   * @private
   */
  _canWindowActiveStroke() {
    return true;
  }

  /** Board-absolute margin a stamp's blur can bleed into, in px. @private */
  _stampMargin(user) {
    return Math.ceil((user.blurRadius || 10) * 2);
  }

  /**
   * Board-absolute bounds a single stamp at (x, y) touches, matching
   * `paintMask`'s own dirty-rect expansion math exactly.
   * @private
   */
  _stampBounds(x, y, size, margin) {
    const radius = size;
    return {
      x: x - radius - margin,
      y: y - radius - margin,
      width: (radius + margin) * 2,
      height: (radius + margin) * 2
    };
  }

  /**
   * Expand a board-absolute box to also cover every active mirror region's
   * transformed copy — same "single bounding box, not a rect list"
   * simplification the brush/eraser windowing already uses.
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
   * Handles pointer move event.
   * Continues building the mask.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRequestUpdate) {
    if (!user.mousedown || user.panning) return;

    const activeLayerIdx = this._getTargetLayer(user);
    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    const prevStamp = this.lastStampPos.get(userId);
    if (!prevStamp) {
      this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
      return;
    }

    const dx = pos.x - prevStamp.x;
    const dy = pos.y - prevStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
    const minSpacing = Math.max(user.size * spacingPercent, 5); // Min 5px spacing
    if (distance < minSpacing) return;

    // Bounds hint covers the WHOLE segment's stamps, not just one — grown
    // once per tick rather than per stamp (segments between ticks are short,
    // so this stays tight without the overhead of growing N times).
    const margin = this._stampMargin(user);
    const segBounds = this._canWindowActiveStroke(user) ? this._foldMirrorBounds({
      x: Math.min(prevStamp.x, pos.x) - user.size - margin,
      y: Math.min(prevStamp.y, pos.y) - user.size - margin,
      width: Math.abs(dx) + (user.size + margin) * 2,
      height: Math.abs(dy) + (user.size + margin) * 2
    }) : null;
    const maskCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, userId, undefined, undefined, segBounds);
    if (!maskCtx) return;

    const active = this.board.layerManager.getActiveStroke(activeLayerIdx, userId);
    const ox = active?.origin?.x ?? 0;
    const oy = active?.origin?.y ?? 0;

    const points = this.strokePoints.get(userId);
    const steps = Math.max(1, Math.ceil(distance / minSpacing));

    if (ox || oy) maskCtx.save();
    try {
      if (ox || oy) maskCtx.translate(-ox, -oy);

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const stampX = prevStamp.x + dx * t;
        const stampY = prevStamp.y + dy * t;
        this.paintMask(stampX, stampY, user.size, user, maskCtx);

        this.board.forEachMirrorRegion({ point: { x: stampX, y: stampY } }, (region) => {
          const mirrored = this.board.mirrorPointToRegion({ x: stampX, y: stampY }, region);
          this.board.withMirrorRegionClip(maskCtx, region, () => {
            this.paintMask(mirrored.x, mirrored.y, user.size, user, maskCtx);
          });
        });

        if (points) points.push({ x: stampX, y: stampY });
      }
    } finally {
      if (ox || oy) maskCtx.restore();
    }

    this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    if (shouldRequestUpdate) this.board.requestUpdate();
  }

  /**
   * Handles pointer up event.
   * Commits the regular stroke containing the stamped blur pixels.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos, extraProps = {}) {
    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    // Track tile ownership
    const points = this.strokePoints.get(userId);
    if (points && points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.strokePoints.delete(userId);

    this.board.endStroke(user, extraProps);
    this.lastStampPos.delete(userId);
    this.clearSnapshot(userId);
    delete user.blurBounds;
    this.board.requestUpdate();
  }

  /**
   * Paint a square mask stamp at the given position.
   * Square masks work better with edge feathering.
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} size - Radius/half-width of the mask square.
   * @param {Object} user - The user performing the action.
   * @param {CanvasRenderingContext2D} maskCtx - The mask context to paint into.
   */
  paintMask(x, y, size, user, maskCtx) {
    const radius = size;
    const blurRadius = user.blurRadius || 10;
    const intensity = user.pressure || 1.0;

    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    // onPointerDown normally captures this; a stamp that arrives without one
    // (a remote stroke joined mid-flight) captures lazily rather than falling
    // back to viewCanvas. viewCanvas is a DISPLAY surface — it may be culled,
    // and it is not necessarily board-sized or board-aligned — so indexing it
    // with board coordinates is wrong in a way that silently produces a blur of
    // the wrong pixels. captureSnapshot composites from the layer stack.
    if (!this.snapshotCanvases.has(userId)) {
      this.captureSnapshot(userId, this._getTargetLayer(user));
    }
    const sourceCanvas = this.snapshotCanvases.get(userId);
    if (sourceCanvas) {
      const margin = Math.ceil(blurRadius * 2);
      const cropX = Math.max(0, Math.floor(x - radius - margin));
      const cropY = Math.max(0, Math.floor(y - radius - margin));
      const cropW = Math.min(sourceCanvas.width - cropX, Math.ceil((radius + margin) * 2));
      const cropH = Math.min(sourceCanvas.height - cropY, Math.ceil((radius + margin) * 2));

      if (cropW > 0 && cropH > 0) {
        const { canvas: blurCanvas, ctx: blurCtx } = this._getBlurScratch(cropW, cropH);

        // The scratch is shared and sized to the LARGEST crop seen, so clear it
        // WHOLE, not just the crop rect: the filtered self-draw below reads the
        // entire canvas, and leftovers from a bigger previous stamp would blur
        // into this one. Clearing all of it also keeps the edge behaviour
        // identical to the old exactly-sized canvas, where everything outside
        // the crop was transparent.
        blurCtx.clearRect(0, 0, blurCanvas.width, blurCanvas.height);
        blurCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        // Apply blur to the intermediate canvas
        blurCtx.filter = `blur(${blurRadius * 0.5}px)`;
        blurCtx.drawImage(blurCanvas, 0, 0);
        blurCtx.filter = 'none';

        maskCtx.save();
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.globalAlpha = intensity;

        // Clip to the stamp's square region so blur bleeds don't overwrite
        // pixels outside the stamp footprint.
        maskCtx.beginPath();
        maskCtx.rect(x - radius, y - radius, radius * 2, radius * 2);
        maskCtx.clip();

        maskCtx.drawImage(blurCanvas, 0, 0, cropW, cropH, cropX, cropY, cropW, cropH);

        maskCtx.restore();
      }
    }

    // Expand dirty rect (include blur radius margin)
    const margin = Math.ceil(blurRadius * 2);
    const left = Math.floor(x - radius - margin);
    const top = Math.floor(y - radius - margin);
    const width = Math.ceil((radius + margin) * 2);
    const height = Math.ceil((radius + margin) * 2);
    this.board.expandDirtyRect(user, left, top, width, height);

    // Update bounds for this blur stroke
    if (user.blurBounds) {
      user.blurBounds.minX = Math.min(user.blurBounds.minX, left);
      user.blurBounds.minY = Math.min(user.blurBounds.minY, top);
      user.blurBounds.maxX = Math.max(user.blurBounds.maxX, left + width);
      user.blurBounds.maxY = Math.max(user.blurBounds.maxY, top + height);
    }
  }
}
