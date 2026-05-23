/**
 * @fileoverview Eraser tool.
 * Each eraser gesture is stored as a single active stroke with blendMode 'destination-out'.
 */

import { Tool } from './BaseTool.js';

/**
 * Eraser tool for removing content from layers.
 */
export class EraserTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('erase', board);
    this.userSize = 10;
    this.lastPos = new Map();
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this._activeUser?.currentLine?.length > 0) {
      this.onPointerUp(this._activeUser);
    }
    this._setPreviewMaskVisible(true);
    this._activeUser = null;
  }

  usesDeferredPreview() {
    return true;
  }

  /**
   * Checks if erasing should apply to all layers.
   * @private
   * @returns {boolean} - True if all layers should be erased.
   */
  _eraseAllLayers() {
    return this.board.app?.eraseAllLayers ?? false;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    if (this._isLocalUser(user)) this._setPreviewMaskVisible(false);
    this.lastPos.set(this._getUserId(user), { x: pos.x, y: pos.y });
    user.clearLine();
    user._strokeLayer = user.activeLayer ?? 0;
    this._beginStroke(user);
    this._resetStrokeState(user);
    const rect = this.getPreviewDirtyRect(user);
    if (rect !== false) {
      this._clearPreview(user, rect);
      this.drawPreview(user, rect, this._getPreviewContext(user));
    }
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.appendBufferedPoint(user, pos);
    const rect = this.getPreviewDirtyRect(user);
    if (rect !== false) {
      this._clearPreview(user, rect);
      this.drawPreview(user, rect, this._getPreviewContext(user));
    }
    this.lastPos.set(this._getUserId(user), { x: pos.x, y: pos.y });
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.appendBufferedPoint(user, pos);
    this.lastPos.set(this._getUserId(user), { x: pos.x, y: pos.y });
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   */
  onPointerUp(user) {
    const userId = this._getUserId(user);
    const lastPos = this.lastPos.get(userId);
    if (user?.currentLine?.length === 0 && lastPos) {
      this.appendBufferedPoint(user, lastPos, user.pressure, user.size, user.opacity);
    }
    this.commitCurrentLine(user, user.pressure, user.size, user.opacity, false);

    const erasedTiles = this.collectErasedTiles(user);

    if (this._shouldEraseAllLayers(user)) {
      this.board.endStrokeAllLayers(user);
    } else {
      this.board.endStroke(user);
    }

    if (erasedTiles.size > 0) {
      this.board.compositeAllLayers();
      this.board.checkErasedTilesByIndices(erasedTiles);
    }

    this.lastPos.delete(userId);
    user.clearLine();
    this._clearStrokeState(user);

    this._clearPreview(user);
    if (this._isLocalUser(user)) this._setPreviewMaskVisible(true);
  }

  appendBufferedPoint(user, pos, pressure = user.pressure, size = user.size, opacity = user.opacity) {
    if (!user) return;
    const point = this._createBufferedPoint(pos.x, pos.y, pressure, size, opacity);
    if (point.size <= 0 || point.opacity <= 0) return;

    user.addToLine(point);
    const state = this._ensureStrokeState(user);
    this._stampPoint(user, state, point);
    this._eraseOverlayTextHits(point);
  }

  /**
   * If this eraser stamp covers any active SVG text records, fade them out
   * and broadcast their removal so other clients drop the SVG node too.
   */
  _eraseOverlayTextHits(point) {
    const overlay = this.board?.textOverlay;
    if (!overlay || overlay.records.size === 0) return;
    const radius = Math.max(1, point.size / 2);
    const hits = overlay.hitTestCircle(point.x, point.y, radius);
    for (const r of hits) overlay.eraseRemove(r.id);
  }

  drawPreview(user, rect = null, ctx = this.board.topCtx) {
    if (rect?.drawImage) {
      ctx = rect;
      rect = null;
    }

    if (!ctx || !user?.currentLine?.length) return;
    const state = this._getStrokeState(user);
    if (!state || !this._hasDirtyBounds(state)) return;
    const [r, g, b] = this.board.backgroundColor;
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      this._renderPreviewPath(ctx, user.currentLine, r, g, b, user, rect);

      this.board.forEachMirrorRegion({ rect: this._boundsToRect(state.dirtyBounds) }, (region) => {
        this.board.drawMirroredCanvas(ctx, state.previewCanvas, region, 0, 0);
      });
    });

    state.previewDirtyBounds = null;
    this.board.requestUpdate();
  }

  commitCurrentLine(user, newPressure = user.pressure, newSize = user.size, newOpacity = user.opacity, continueStroke = true) {
    if (!user?.currentLine?.length) return false;
    const state = this._getStrokeState(user);
    if (!state || !this._hasDirtyBounds(state)) return false;

    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    const bufferedPoints = user.currentLine.map((point) => ({ ...point }));
    const committed = this._commitBufferedPath(user, bufferedPoints, state);
    const lastPoint = bufferedPoints[bufferedPoints.length - 1];

    user.clearLine();
    this._clearStrokeState(user);
    if (continueStroke && lastPoint) {
      this.appendBufferedPoint(user, { x: lastPoint.x, y: lastPoint.y }, newPressure, newSize, newOpacity);
    }

    if (committed) {
      this.board.requestUpdate();
    }

    return committed;
  }

  collectErasedTiles(user) {
    const erasedTiles = new Set();
    const lm = this.board.layerManager;
    if (!lm || !user) return erasedTiles;

    if (this._shouldEraseAllLayers(user)) {
      const count = lm.getLayerCount();
      for (let i = 0; i < count; i++) {
        const active = lm.getLayerGroup(i)?.activeStrokeByUser?.get(user.id);
        if (active?.affectedTiles) {
          for (const idx of active.affectedTiles) erasedTiles.add(idx);
        }
      }
      return erasedTiles;
    }

    const group = lm.getLayerGroup(this._getStrokeLayer(user));
    const active = group?.activeStrokeByUser?.get(user.id);
    if (active?.affectedTiles) {
      for (const idx of active.affectedTiles) erasedTiles.add(idx);
    }
    return erasedTiles;
  }

  _beginStroke(user) {
    if (!this.board.layerManager || user?.panning) return;

    if (this._shouldEraseAllLayers(user)) {
      const count = this.board.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        this.board.layerManager.beginUserStroke(i, user.id, 'destination-out');
        this.board.applySelectionMaskClipForStroke(i, user.id);
      }
      return;
    }

    const strokeLayer = this._getStrokeLayer(user);
    this.board.layerManager.beginUserStroke(strokeLayer, user.id, 'destination-out');
    this.board.applySelectionMaskClipForStroke(strokeLayer, user.id);
  }

  _commitBufferedPath(user, points, state) {
    if (!points || points.length === 0 || !state || !this._hasDirtyBounds(state)) return false;

    let committed = false;
    const groups = this._getTargetGroups(user);
    if (groups.length === 0) return false;
    const opacity = state.opacity ?? points[0]?.opacity ?? 1;
    if (opacity <= 0) return false;

    for (const group of groups) {
      this.eraseMaskOnGroup(group, state, opacity, user.id);
      this.board.forEachMirrorRegion({ rect: this._boundsToRect(state.dirtyBounds) }, (region) => {
        this.eraseMaskOnGroup(group, state, opacity, user.id, region);
      });
      committed = true;
    }

    if (committed) {
      this._markDirtyBounds(user, state.dirtyBounds);
      const maxRadius = Math.max(0.5, state.maxRadius ?? 0);
      if (maxRadius > 0 && points.length > 0) {
        this._markDirtyPath(user, points, maxRadius);
      }
    }

    return committed;
  }

  _getTargetGroups(user) {
    if (!this.board.layerManager) return [];

    if (this._shouldEraseAllLayers(user)) {
      const groups = [];
      const count = this.board.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        const group = this.board.layerManager.getLayerGroup(i);
        if (group) groups.push(group);
      }
      return groups;
    }

    const group = this.board.layerManager.getLayerGroup(this._getStrokeLayer(user));
    return group ? [group] : [];
  }

  _getStrokeLayer(user) {
    return user?._strokeLayer ?? user?.activeLayer ?? 0;
  }

  _shouldEraseAllLayers(user) {
    return user?.eraseAllLayers ?? this._eraseAllLayers();
  }

  _createBufferedPoint(x, y, pressure, size, opacity) {
    return {
      x,
      y,
      size: Math.max(0, pressure * size * 2),
      opacity: opacity !== undefined ? opacity : 1
    };
  }

  _renderPreviewPath(ctx, points, r, g, b, user, rect = null) {
    const state = this._getStrokeState(user);
    if (!state || !this._hasDirtyBounds(state)) return;
    this._renderPreviewMask(state, `rgb(${r}, ${g}, ${b})`, rect);
    const sourceRect = rect ? this._clampRectToCanvas(rect, state.previewCanvas) : null;
    if (sourceRect) {
      ctx.drawImage(
        state.previewCanvas,
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
      ctx.drawImage(state.previewCanvas, 0, 0);
    }
  }

  _setPreviewMaskVisible(visible) {
    if (!this.board?.topCanvas) return;
    this.board.topCanvas.style.opacity = visible ? '' : '0';
  }

  _getUserId(user) {
    return user?.id ?? this.board.app?.self?.id ?? 0;
  }

  _isLocalUser(user) {
    return user === this.board.app?.self || user?.id === this.board.app?.sessionIndex;
  }

  _getPreviewContext(user) {
    return this._isLocalUser(user) ? this.board.topCtx : user?.context;
  }

  _clearPreview(user, rect = null) {
    if (this._isLocalUser(user)) {
      this.board.clearTop(rect);
      return;
    }

    const ctx = user?.context;
    if (!ctx) return;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0) {
      ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
  }

  /**
   * Draw an eraser path into a user's active stroke group.
   * @param {Object} group - The layer group.
   * @param {Array<Object>} points - Buffered path points.
   * @param {number} size - Eraser size.
   * @param {number} opacity - Eraser opacity.
   * @param {string} userId - ID of the user erasing.
   */
  eraseMaskOnGroup(group, state, opacity, userId, mirrorRegion = null) {
    const active = group.activeStrokeByUser?.get(userId);
    if (active?.ctx) {
      active.opacity = opacity;
      active.ctx.save();
      active.ctx.globalCompositeOperation = 'source-over';
      active.ctx.globalAlpha = opacity;
      if (mirrorRegion) {
        this.board.drawMirroredCanvas(active.ctx, state.maskCanvas, mirrorRegion, 0, 0);
      } else {
        active.ctx.drawImage(state.maskCanvas, 0, 0);
      }
      active.ctx.restore();
    }
  }

  _ensureStrokeState(user) {
    const width = this.board.getWidth();
    const height = this.board.getHeight();

    if (!user._eraserStrokeState) {
      user._eraserStrokeState = this._createStrokeState(width, height);
    }

    const state = user._eraserStrokeState;
    if (state.maskCanvas.width !== width || state.maskCanvas.height !== height) {
      user._eraserStrokeState = this._createStrokeState(width, height);
      return user._eraserStrokeState;
    }

    return state;
  }

  _createStrokeState(width, height) {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = width;
    previewCanvas.height = height;

    return {
      maskCanvas,
      maskCtx: maskCanvas.getContext('2d'),
      previewCanvas,
      previewCtx: previewCanvas.getContext('2d'),
      lastStampPos: null,
      dirtyBounds: null,
      previewDirtyBounds: null,
      maxRadius: 0,
      opacity: 1
    };
  }

  _getStrokeState(user) {
    return user?._eraserStrokeState ?? null;
  }

  _resetStrokeState(user) {
    const state = this._ensureStrokeState(user);
    state.maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    state.previewCtx.clearRect(0, 0, state.previewCanvas.width, state.previewCanvas.height);
    state.lastStampPos = null;
    state.dirtyBounds = null;
    state.previewDirtyBounds = null;
    state.maxRadius = 0;
    state.opacity = user?.opacity ?? 1;
  }

  _clearStrokeState(user) {
    const state = this._getStrokeState(user);
    if (!state) return;
    state.maskCtx.clearRect(0, 0, state.maskCanvas.width, state.maskCanvas.height);
    state.previewCtx.clearRect(0, 0, state.previewCanvas.width, state.previewCanvas.height);
    state.lastStampPos = null;
    state.dirtyBounds = null;
    state.previewDirtyBounds = null;
    state.maxRadius = 0;
  }

  _stampPoint(user, state, point) {
    const radius = Math.max(0.5, point.size / 2);
    state.opacity = point.opacity;

    if (!state.lastStampPos) {
      this._stampCircle(state, point.x, point.y, radius, user?.id);
      state.lastStampPos = { x: point.x, y: point.y, radius };
      state.maxRadius = Math.max(state.maxRadius, radius);
      return;
    }

    const distance = this._getDistance(state.lastStampPos, point);
    const avgRadius = (state.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(0.75, avgRadius * 0.2);
    const steps = Math.max(1, Math.ceil(distance / spacing));

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = state.lastStampPos.x + (point.x - state.lastStampPos.x) * t;
      const y = state.lastStampPos.y + (point.y - state.lastStampPos.y) * t;
      const r = state.lastStampPos.radius + (radius - state.lastStampPos.radius) * t;
      this._stampCircle(state, x, y, r, user?.id);
      state.maxRadius = Math.max(state.maxRadius, r);
    }

    state.lastStampPos = { x: point.x, y: point.y, radius };
  }

  _stampCircle(state, x, y, radius, userId = null) {
    const ctx = state.maskCtx;
    ctx.save();
    if (userId != null) {
      this.board._applyMaskClipToCtx?.(ctx, userId);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this._expandBounds(state, x - radius, y - radius, x + radius, y + radius);
  }

  _renderPreviewMask(state, fillStyle, rect = null) {
    const { previewCtx, previewCanvas, maskCanvas } = state;
    const sourceRect = rect ? this._clampRectToCanvas(rect, previewCanvas) : null;

    if (sourceRect) {
      previewCtx.clearRect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
      previewCtx.drawImage(
        maskCanvas,
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
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewCtx.drawImage(maskCanvas, 0, 0);
    }

    previewCtx.save();
    previewCtx.globalCompositeOperation = 'source-in';
    previewCtx.globalAlpha = state.opacity ?? 1;
    previewCtx.fillStyle = fillStyle;
    if (sourceRect) {
      previewCtx.fillRect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
    } else {
      previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
    previewCtx.restore();
  }

  _expandBounds(state, minX, minY, maxX, maxY) {
    this._expandPreviewDirtyBounds(state, minX, minY, maxX, maxY);

    if (!state.dirtyBounds) {
      state.dirtyBounds = { minX, minY, maxX, maxY };
      return;
    }

    state.dirtyBounds.minX = Math.min(state.dirtyBounds.minX, minX);
    state.dirtyBounds.minY = Math.min(state.dirtyBounds.minY, minY);
    state.dirtyBounds.maxX = Math.max(state.dirtyBounds.maxX, maxX);
    state.dirtyBounds.maxY = Math.max(state.dirtyBounds.maxY, maxY);
  }

  _expandPreviewDirtyBounds(state, minX, minY, maxX, maxY) {
    if (!state) return;
    if (!state.previewDirtyBounds) {
      state.previewDirtyBounds = { minX, minY, maxX, maxY };
      return;
    }

    state.previewDirtyBounds.minX = Math.min(state.previewDirtyBounds.minX, minX);
    state.previewDirtyBounds.minY = Math.min(state.previewDirtyBounds.minY, minY);
    state.previewDirtyBounds.maxX = Math.max(state.previewDirtyBounds.maxX, maxX);
    state.previewDirtyBounds.maxY = Math.max(state.previewDirtyBounds.maxY, maxY);
  }

  getPreviewDirtyRect(user) {
    const state = this._getStrokeState(user);
    if (!state?.previewDirtyBounds) return false;
    if (this.board.mirrorRegions?.length > 0) return null;
    return this._expandBoundsForComposite(state.previewDirtyBounds) ?? false;
  }

  _markDirtyBounds(user, bounds) {
    if (!bounds) return;
    const expanded = this._expandBoundsForComposite(bounds);
    this._expandActiveDirtyRect(user, expanded);
    this.board.compositeTileGrid?.markRect(expanded.x, expanded.y, expanded.width, expanded.height);

    this.board.forEachMirrorRegion({ rect: expanded }, (region) => {
      const mirrored = this._mirrorRect(expanded, region);
      this._expandActiveDirtyRect(user, mirrored);
      this.board.compositeTileGrid?.markRect(mirrored.x, mirrored.y, mirrored.width, mirrored.height);
    });
  }

  _markDirtyPath(user, points, radius) {
    if (!points?.length || radius <= 0) return;

    const targetGroups = this._getTargetGroups(user);
    for (const group of targetGroups) {
      const active = group?.activeStrokeByUser?.get(user.id);
      if (active?.affectedTiles && this.board.tileTracker) {
        this.board.tileTracker.collectTilesFromPath(points, radius, active.affectedTiles);
      }
    }
  }

  _expandActiveDirtyRect(user, rect) {
    const count = this.board.layerManager?.getLayerCount?.() ?? 0;
    const userId = user?.id;
    const applyRect = (group) => {
      const active = group?.activeStrokeByUser?.get(userId);
      if (!active?.dirtyRect) return;
      this.board.layerManager._expandDirtyRect(active.dirtyRect, rect.x, rect.y, rect.width, rect.height);
    };

    if (this._shouldEraseAllLayers(user)) {
      for (let i = 0; i < count; i++) {
        applyRect(this.board.layerManager.getLayerGroup(i));
      }
      return;
    }

    applyRect(this.board.layerManager?.getLayerGroup(this._getStrokeLayer(user)));
  }

  _expandBoundsForComposite(bounds) {
    if (!bounds) return null;
    const margin = 2;
    const x = Math.floor(bounds.minX - margin);
    const y = Math.floor(bounds.minY - margin);
    const width = Math.ceil(bounds.maxX - bounds.minX + margin * 2);
    const height = Math.ceil(bounds.maxY - bounds.minY + margin * 2);
    return { x, y, width, height };
  }

  _clampRectToCanvas(rect, canvas) {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const right = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
    const bottom = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }

  _mirrorRect(rect, region) {
    const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x, y: rect.y + rect.height },
      { x: rect.x + rect.width, y: rect.y + rect.height }
    ];

    const mirrored = corners.map(p => this.board.mirrorPointToRegion(p, region));

    let minX = mirrored[0].x;
    let minY = mirrored[0].y;
    let maxX = mirrored[0].x;
    let maxY = mirrored[0].y;

    for (const p of mirrored) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY)
    };
  }

  _boundsToRect(bounds) {
    if (!bounds) return null;
    return {
      x: bounds.minX,
      y: bounds.minY,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY
    };
  }

  _hasDirtyBounds(state) {
    return !!(state?.dirtyBounds && state.dirtyBounds.maxX > state.dirtyBounds.minX && state.dirtyBounds.maxY > state.dirtyBounds.minY);
  }

  _getDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
