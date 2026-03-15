import { LayerManager } from './LayerManager.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';

/**
 * @fileoverview Board class managing canvas elements and viewport
 */

/**
 * Manages the drawing boards, viewport transformations, and compositing logic.
 */
export class Board {
  /**
   * @param {Object} [options={}] - Configuration options for the board
   */
  constructor(options = {}) {
    this.dimensions = options.dimensions || [720, 1280];
    this.zoom = 1;
    this.defaultZoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.defaultPanX = 0;
    this.defaultPanY = 0;
    this.rotation = 0;
    this.defaultRotation = 0;
    this.mirror = false;
    this.backgroundColor = options.backgroundColor || [255, 255, 255, 1];

    this.container = null;
    this.boardsWrapper = null;
    this.mainCanvas = null;
    this.topCanvas = null;
    this.upperLayersCanvas = null;
    this.mainCtx = null;
    this.topCtx = null;
    this.upperLayersCtx = null;
    this.cursorsSvg = null;
    this.mirrorLine = null;

    this.layerManager = null;
    this.app = null;

    this.activeSelectionLayer = -1;

    this._needsComposite = false;
    this._compositeScheduled = false;

    this._dirtyRects = [];

    this.MAX_DIRTY_RECTS = 20;
    this.DIRTY_RECT_MERGE_DISTANCE = 20;

    /** @type {number} Target render FPS (0 = uncapped/on-demand) */
    this.targetFPS = 0;
    /** @type {number} DOMHighResTimeStamp of the last completed composite */
    this._lastCompositeTime = 0;
    /** @type {number|null} RAF ID for the persistent render loop */
    this._rafLoopId = null;
    /** @type {PerformanceMonitor} */
    this.performanceMonitor = new PerformanceMonitor();
  }

  /**
   * Set reference to the DrawingApp
   * @param {Object} app - The main application instance
   */
  setApp(app) {
    this.app = app;
  }

  /**
   * Initialize board elements and layer manager
   * @param {string} containerSelector - CSS selector for the container element
   */
  init(containerSelector) {
    this.container = document.querySelector(containerSelector);
    this.boardsWrapper = document.getElementById('boards');
    this.mainCanvas = document.getElementById('board');
    this.topCanvas = document.getElementById('topBoard');
    this.cursorsSvg = document.getElementById('cursorsSvg');
    this.mirrorLine = document.querySelector('.mirrorLine');

    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true });
    this.topCtx = this.topCanvas.getContext('2d');

    this.upperLayersCanvas = document.createElement('canvas');
    this.upperLayersCanvas.id = 'upperLayersBoard';
    this.upperLayersCanvas.style.position = 'absolute';
    this.upperLayersCanvas.style.top = '0';
    this.upperLayersCanvas.style.left = '0';
    this.upperLayersCanvas.style.pointerEvents = 'none';
    this.upperLayersCanvas.style.zIndex = '2';
    this.boardsWrapper.appendChild(this.upperLayersCanvas);
    this.upperLayersCtx = this.upperLayersCanvas.getContext('2d');

    this.setupCanvas();

    const [height, width] = this.dimensions;
    this.layerManager = new LayerManager(width, height);
    this.layerManager.onNeedsUpdate = () => this.requestUpdate();

    this.calculateDefaultView();
    this.resetView();
  }

  /**
   * Set up canvas dimensions and initial context states
   */
  setupCanvas() {
    const [height, width] = this.dimensions;

    this.boardsWrapper.style.height = `${height}px`;
    this.boardsWrapper.style.width = `${width}px`;

    this.mainCanvas.height = height;
    this.mainCanvas.width = width;
    this.topCanvas.height = height;
    this.topCanvas.width = width;
    if (this.upperLayersCanvas) {
      this.upperLayersCanvas.height = height;
      this.upperLayersCanvas.width = width;
    }

    this.mainCtx.globalCompositeOperation = 'source-over';
    this.mainCtx.imageSmoothingQuality = 'high';
    this.mainCtx.lineCap = 'round';
    this.mainCtx.lineJoin = 'round';

    this.topCtx.imageSmoothingQuality = 'high';
    this.topCtx.lineCap = 'round';
    this.topCtx.lineJoin = 'round';

    this.mirrorLine.setAttribute('x1', width / 2);
    this.mirrorLine.setAttribute('y1', 0);
    this.mirrorLine.setAttribute('x2', width / 2);
    this.mirrorLine.setAttribute('y2', height);
    this.mirrorLine.style.display = 'none';

    this.boardsWrapper.style.transformOrigin = 'top left';
  }

  /**
   * Calculate default zoom and pan to fit the board in the container
   */
  calculateDefaultView() {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight - 50;
    const [height, width] = this.dimensions;

    const padding = 20;
    const availableWidth = containerWidth - padding * 2;
    const availableHeight = containerHeight - padding * 2;

    const zoomX = availableWidth / width;
    const zoomY = availableHeight / height;
    const zoom = Math.min(zoomX, zoomY, 1);

    const scaledWidth = width * zoom;
    const scaledHeight = height * zoom;
    const panX = (containerWidth - scaledWidth) / 2;
    const panY = (containerHeight - scaledHeight) / 2 + 50;

    this.defaultZoom = Math.round(zoom * 1000) / 1000;
    this.defaultPanX = panX;
    this.defaultPanY = panY;
  }

  /**
   * Reset the viewport to default zoom, pan, and rotation
   */
  resetView() {
    this.zoom = this.defaultZoom;
    this.panX = this.defaultPanX;
    this.panY = this.defaultPanY;
    this.rotation = this.defaultRotation;

    this.applyTransform();
  }

  /**
   * Apply current pan, zoom, and rotation to the board's DOM wrapper
   */
  applyTransform() {
    this.boardsWrapper.style.transformOrigin = '0 0';
    this.boardsWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom}) rotate(${this.rotation}deg)`;
    this.boardsWrapper.style.left = '';
    this.boardsWrapper.style.top = '';
  }

  /**
   * Transforms screen (client) coordinates to board-space coordinates.
   * Accounts for zoom, pan, and rotation.
   * @param {number} clientX - Screen X coordinate
   * @param {number} clientY - Screen Y coordinate
   * @returns {{x: number, y: number}} - Board-relative coordinates
   */
  getBoardRelativePos(clientX, clientY) {
    const rect = this.boardsWrapper.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // The rect from getBoundingClientRect accounts for the transform (scale/rotate).
    // To get back to canonical board space, we need to undo rotation and scale.
    // The pan (translate) is already handled by being relative to rect.left/top, 
    // but the rect's top-left is the top-left of the BOUNDING BOX of the transformed element.

    // A more robust way is to use the inverse matrix logic since we know the transform parameters.
    // client -> boardContainer (pan is here) -> boardsWrapper (zoom and rotate are here)

    // 1. Convert client to boardContainer space
    const containerRect = this.container.getBoundingClientRect();
    let bx = clientX - containerRect.left;
    let by = clientY - containerRect.top;

    // 2. Undo translation (pan)
    bx -= this.panX;
    by -= this.panY;

    // 3. Undo rotation
    const rad = -this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = bx * cos - by * sin;
    const ry = bx * sin + by * cos;

    // 4. Undo scale (zoom)
    return {
      x: Math.round((rx / this.zoom) * 100) / 100,
      y: Math.round((ry / this.zoom) * 100) / 100
    };
  }

  /**
   * Set board rotation
   * @param {number} angle - Rotation angle in degrees
   */
  setRotation(angle) {
    this.rotation = angle;
    this.applyTransform();
  }

  /**
   * Rotate to a new angle while keeping the given boardContainer-space pivot fixed on screen.
   * @param {number} newAngleDeg - New rotation in degrees
   * @param {number} pivotX - Pivot X in boardContainer coordinates
   * @param {number} pivotY - Pivot Y in boardContainer coordinates
   */
  setRotationAround(newAngleDeg, pivotX, pivotY) {
    const oldRad = this.rotation * Math.PI / 180;
    const newRad = newAngleDeg * Math.PI / 180;
    const { zoom } = this;

    const dx = pivotX - this.panX;
    const dy = pivotY - this.panY;
    const cosOld = Math.cos(oldRad);
    const sinOld = Math.sin(oldRad);
    const boardX = (dx * cosOld + dy * sinOld) / zoom;
    const boardY = (-dx * sinOld + dy * cosOld) / zoom;

    const cosNew = Math.cos(newRad);
    const sinNew = Math.sin(newRad);
    this.panX = pivotX - zoom * (boardX * cosNew - boardY * sinNew);
    this.panY = pivotY - zoom * (boardX * sinNew + boardY * cosNew);
    this.rotation = newAngleDeg;
    this.applyTransform();
  }

  /**
   * Reset rotation to default
   */
  resetRotation() {
    this.rotation = this.defaultRotation;
    this.applyTransform();
  }

  /**
   * Pan the viewport
   * @param {number} dx - Change in X
   * @param {number} dy - Change in Y
   */
  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.applyTransform();
  }

  /**
   * Set viewport zoom level
   * @param {number} zoom - Zoom level (0.2 to 3)
   * @param {Object} [cursorPos=null] - Pivot point for zoom {x, y}
   * @returns {number} The applied zoom level
   */
  setZoom(zoom, cursorPos = null) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.2, Math.min(3, zoom));

    if (cursorPos) {
      const screenX = cursorPos.x * oldZoom + this.panX;
      const screenY = cursorPos.y * oldZoom + this.panY;

      this.panX = screenX - (cursorPos.x * this.zoom);
      this.panY = screenY - (cursorPos.y * this.zoom);
    } else {
      const [height, width] = this.dimensions;
      const midX = width / 2;
      const midY = height / 2;
      
      const screenX = midX * oldZoom + this.panX;
      const screenY = midY * oldZoom + this.panY;

      this.panX = screenX - (midX * this.zoom);
      this.panY = screenY - (midY * this.zoom);
    }

    this.applyTransform();
    return this.zoom;
  }

  /**
   * Set viewport zoom level while keeping a boardContainer-space pivot fixed.
   * @param {number} newZoom - Target zoom level
   * @param {number} pivotX - Pivot X in boardContainer coordinates
   * @param {number} pivotY - Pivot Y in boardContainer coordinates
   */
  setZoomAround(newZoom, pivotX, pivotY) {
    const oldZoom = this.zoom;
    const rad = this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Get pivot in board-space
    const dx = pivotX - this.panX;
    const dy = pivotY - this.panY;
    const boardX = (dx * cos + dy * sin) / oldZoom;
    const boardY = (-dx * sin + dy * cos) / oldZoom;

    // Apply new zoom
    this.zoom = Math.max(0.2, Math.min(3, newZoom));

    // Calculate new pan to keep pivot fixed
    this.panX = pivotX - this.zoom * (boardX * cos - boardY * sin);
    this.panY = pivotY - this.zoom * (boardX * sin + boardY * cos);

    this.applyTransform();
  }

  /**
   * Zoom in by a step
   * @param {number} [step=0.1] - Zoom step
   * @param {Object} [cursorPos=null] - Pivot point for zoom
   * @returns {number} The applied zoom level
   */
  zoomIn(step = 0.1, cursorPos = null) {
    return this.setZoom(Math.round((this.zoom + step) * 10) / 10, cursorPos);
  }

  /**
   * Zoom out by a step
   * @param {number} [step=0.1] - Zoom step
   * @param {Object} [cursorPos=null] - Pivot point for zoom
   * @returns {number} The applied zoom level
   */
  zoomOut(step = 0.1, cursorPos = null) {
    return this.setZoom(Math.round((this.zoom - step) * 10) / 10, cursorPos);
  }

  /**
   * Get zoom percentage string
   * @returns {string}
   */
  getZoomPercent() {
    return `${(this.zoom * 100).toFixed(1)}%`;
  }

  /**
   * Toggle vertical mirror line
   * @returns {boolean} New mirror state
   */
  toggleMirror() {
    this.mirror = !this.mirror;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    return this.mirror;
  }

  /**
   * Set mirror state
   * @param {boolean} value - Mirror state
   */
  setMirror(value) {
    this.mirror = value;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
  }

  /**
   * Clear all layers and reset canvases
   */
  clear() {
    const [height, width] = this.dimensions;
    this.mainCtx.beginPath();
    this.topCtx.beginPath();

    if (this.layerManager) {
      this.layerManager.clearAll();
      this.compositeAllLayers();
    } else {
      this.mainCtx.clearRect(0, 0, width, height);
    }

    this.topCtx.clearRect(0, 0, width, height);
  }

  /**
   * Get the drawing context for the local user's active sub-layer.
   * @param {string} [createBlendMode='source-over'] - Blend mode if creating new sub-layer
   * @returns {CanvasRenderingContext2D}
   */
  getActiveLayerContext(createBlendMode = 'source-over') {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    return this.layerManager?.getLayerContext(activeLayer, userId, createBlendMode) ?? this.mainCtx;
  }

  /**
   * Get drawing context for a specific user on a specific layer.
   * @param {number} layerIndex - Layer index
   * @param {number} userId - User ID
   * @param {string} [createBlendMode='source-over'] - Blend mode if creating new sub-layer
   * @returns {CanvasRenderingContext2D}
   */
  getLayerContext(layerIndex, userId, createBlendMode = 'source-over') {
    return this.layerManager?.getLayerContext(layerIndex, userId, createBlendMode) ?? this.mainCtx;
  }

  /**
   * Get local user's current blend mode
   * @returns {string}
   */
  getActiveLayerBlendMode() {
    return this.app?.self?.blendMode ?? 'source-over';
  }

  /**
   * Begin a new sub-layer with a specific blend mode for the local user.
   * @param {string} blendMode - Canvas composite operation
   */
  createActiveLayerBlendSubLayer(blendMode) {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    if (this.layerManager) {
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode);
    }
  }

  /**
   * Begin a new stroke for a user.
   * @param {Object} user - User object
   * @param {string} [blendModeOverride] - Optional blend mode override
   */
  beginStroke(user, blendModeOverride) {
    if (user?.panning) return;
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const blendMode = blendModeOverride ?? user?.blendMode ?? 'source-over';
    if (this.layerManager) {
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode);
    }
    this.requestUpdate();
  }

  /**
   * Begin a stroke on every layer simultaneously (erase-all mode).
   * @param {Object} user - User object
   * @param {string} blendMode - Blend mode (usually destination-out)
   */
  beginStrokeAllLayers(user, blendMode) {
    if (user?.panning) return;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (this.layerManager) {
      const count = this.layerManager.getLayerCount();
      for (let i = 0; i < count; i++) {
        this.layerManager.beginUserStroke(i, userId, blendMode);
      }
    }
    this.requestUpdate();
  }

  /**
   * End stroke on every layer for a user (erase-all mode).
   * @param {Object} user - User object
   */
  endStrokeAllLayers(user) {
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    const batchTimestamp = Date.now();
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.layerManager.commitUserStroke(i, userId, { eraseAll: true, timestamp: batchTimestamp });
    }
    this.requestUpdate();
  }

  /**
   * Get drawing contexts for all layers for a user.
   * @param {number} userId - User ID
   * @returns {CanvasRenderingContext2D[]}
   */
  getAllLayerContexts(userId) {
    if (!this.layerManager) return [];
    const ctxs = [];
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const ctx = this.layerManager.getUserStrokeContext(i, userId);
      if (ctx) ctxs.push(ctx);
    }
    return ctxs;
  }

  /**
   * End the current stroke for a user.
   * @param {Object} user - User object
   * @param {Object} [extraProps={}] - Extra properties for the stroke record (e.g., filter metadata)
   */
  endStroke(user, extraProps = {}) {
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    this.layerManager.commitUserStroke(activeLayer, userId, extraProps);
    this.requestUpdate();
  }

  /**
   * Expand the dirty rectangle for a user's active stroke.
   * @param {Object} user - User object
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   */
  expandDirtyRect(user, x, y, width, height) {
    if (!this.layerManager) return;
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;
    const active = group.activeStrokeByUser.get(userId);
    if (!active || !active.dirtyRect) return;
    this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);

    this._addOrMergeDirtyRect(x, y, width, height);

    if (this.app?.debugOverlay) {
      const username = user?.username ?? this.app?.self?.username ?? `User ${userId}`;
      this.app.debugOverlay.expandUserRegion(userId, username, x, y, width, height);
    }
  }

  /**
   * Expand dirty rects for all layers' active strokes for a user.
   * @param {Object} user - User object
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   */
  expandDirtyRectAllLayers(user, x, y, width, height) {
    if (!this.layerManager) return;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group) continue;
      const active = group.activeStrokeByUser.get(userId);
      if (!active || !active.dirtyRect) continue;
      this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    }
    this._addOrMergeDirtyRect(x, y, width, height);
    if (this.app?.debugOverlay) {
      const username = user?.username ?? this.app?.self?.username ?? `User ${userId}`;
      this.app.debugOverlay.expandUserRegion(userId, username, x, y, width, height);
    }
  }

  /**
   * Add or merge a dirty rectangle into the global dirty regions array.
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   * @private
   */
  _addOrMergeDirtyRect(x, y, width, height) {
    const newRect = { x, y, width, height };

    if (this._dirtyRects.length === 0) {
      this._dirtyRects.push(newRect);
      return;
    }

    let closestIdx = -1;
    let closestDist = Infinity;

    for (let i = 0; i < this._dirtyRects.length; i++) {
      const dist = this._rectDistance(this._dirtyRects[i], newRect);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }

    if (closestDist <= this.DIRTY_RECT_MERGE_DISTANCE) {
      this._dirtyRects[closestIdx] = this._unionRects(this._dirtyRects[closestIdx], newRect);
    } else {
      this._dirtyRects.push(newRect);
    }

    while (this._dirtyRects.length > this.MAX_DIRTY_RECTS) {
      this._mergeClosestPair();
    }
  }

  /**
   * Calculate minimum distance between two rectangles.
   * @param {Object} r1 - First rectangle
   * @param {Object} r2 - Second rectangle
   * @returns {number}
   * @private
   */
  _rectDistance(r1, r2) {
    const overlapX = !(r1.x + r1.width < r2.x || r2.x + r2.width < r1.x);
    const overlapY = !(r1.y + r1.height < r2.y || r2.y + r2.height < r1.y);

    if (overlapX && overlapY) return 0;

    const gapX = overlapX ? 0 : Math.max(0,
      Math.max(r1.x, r2.x) - Math.min(r1.x + r1.width, r2.x + r2.width));
    const gapY = overlapY ? 0 : Math.max(0,
      Math.max(r1.y, r2.y) - Math.min(r1.y + r1.height, r2.y + r2.height));

    return Math.sqrt(gapX * gapX + gapY * gapY);
  }

  /**
   * Union two rectangles into their bounding box.
   * @param {Object} r1 - First rectangle
   * @param {Object} r2 - Second rectangle
   * @returns {Object} Union rectangle
   * @private
   */
  _unionRects(r1, r2) {
    const minX = Math.min(r1.x, r2.x);
    const minY = Math.min(r1.y, r2.y);
    const maxX = Math.max(r1.x + r1.width, r2.x + r2.width);
    const maxY = Math.max(r1.y + r1.height, r2.y + r2.height);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Find and merge the two closest rectangles in the array.
   * @private
   */
  _mergeClosestPair() {
    if (this._dirtyRects.length < 2) return;

    let minDist = Infinity;
    let mergeI = 0, mergeJ = 1;

    for (let i = 0; i < this._dirtyRects.length; i++) {
      for (let j = i + 1; j < this._dirtyRects.length; j++) {
        const dist = this._rectDistance(this._dirtyRects[i], this._dirtyRects[j]);
        if (dist < minDist) {
          minDist = dist;
          mergeI = i;
          mergeJ = j;
        }
      }
    }

    this._dirtyRects[mergeI] = this._unionRects(this._dirtyRects[mergeI], this._dirtyRects[mergeJ]);
    this._dirtyRects.splice(mergeJ, 1);
  }

  /**
   * Cancel the current stroke for a user.
   * @param {Object} user - User object
   */
  cancelStroke(user) {
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    this.layerManager.cancelUserStroke(activeLayer, userId);
    this.requestUpdate();
  }

  /**
   * Undo the most recent stroke for userId across all layers.
   * @param {number} _layerIndex - Unused; kept for compatibility
   * @param {number} userId - User ID
   */
  undo(_layerIndex, userId) {
    if (!this.layerManager) return;
    const batch = this.layerManager.undoLastStrokeGlobal(userId);
    if (batch) {
      this.layerManager._pushToRedoStack(userId, batch);
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          this._applySelectionRestore(record.selectionRestoreData.snapshots);
          break;
        }
      }
    }
    this.clearTop();
    this.compositeAllLayers();
  }

  /**
   * Redo the most recently undone stroke batch for userId.
   * @param {number} userId - User ID
   */
  redo(userId) {
    if (!this.layerManager) return;
    const redoStack = this.layerManager.redoStackByUser.get(userId);
    if (redoStack && redoStack.length > 0) {
      const batch = redoStack[redoStack.length - 1];
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          this._applySelectionReErase(record.selectionRestoreData);
          break;
        }
      }
    }
    this.layerManager.redoLastStroke(userId);
    this.clearTop();
    this.compositeAllLayers();
  }

  /**
   * Apply pixel snapshots back to baseCanvas
   * @param {Array} snapshots - Array of snapshot data
   * @private
   */
  _applySelectionRestore(snapshots) {
    if (!snapshots) return;
    const lm = this.layerManager;
    for (const { groupIdx, canvas, x, y } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;
      lm.addToBaseBin(groupIdx, canvas, x, y, 'source-over');
    }
    lm._notifyHistoryPanel();
  }

  /**
   * Re-apply the erase to baseCanvas
   * @param {Object} restoreData - Selection restore data
   * @private
   */
  _applySelectionReErase(restoreData) {
    const lm = this.layerManager;
    const { snapshots, eraseS: s, eraseLassoPath: lassoPath } = restoreData;
    for (const { groupIdx } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;

      const eraserCanvas = document.createElement('canvas');
      eraserCanvas.width = s.width;
      eraserCanvas.height = s.height;
      const eCtx = eraserCanvas.getContext('2d');
      eCtx.fillStyle = 'white';
      eCtx.fillRect(0, 0, s.width, s.height);

      lm.eraseFromAllBaseBins(groupIdx, eraserCanvas, s.x, s.y, lassoPath);
    }
    lm._notifyHistoryPanel();
  }

  /**
   * Get the full layer group for the active layer
   * @returns {Object|undefined}
   */
  getActiveLayerGroup() {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    return this.layerManager?.getLayerGroup(activeLayer);
  }

  /**
   * Get the full layer group for a specific index
   * @param {number} index - Layer index
   * @returns {Object|undefined}
   */
  getLayerGroup(index) {
    return this.layerManager?.getLayerGroup(index);
  }

  /**
   * Composite all visible layers onto the main canvas.
   */
  compositeAllLayers() {
    if (!this.layerManager) return;
    this.performanceMonitor.recordCompositeStart();

    const activeLayerIdx = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    const totalLayers = this.layerManager.getLayerCount();
    const [height, width] = this.dimensions;

    const dirtyRects = this._dirtyRects.slice();

    if (this.app?.debugOverlay) {
      this.app.debugOverlay.captureDirtyRects(dirtyRects);
    }

    this._dirtyRects = [];

    const activeGroup = this.layerManager.getLayerGroup(activeLayerIdx);
    const isDrawing = activeGroup?.activeStrokeByUser?.has(userId) ?? false;
    const isEraser = this.app?.activeTool === 'erase';
    const eraseAll = isEraser && (this.app?.eraseAllLayers ?? false);
    
    const hasActiveSelection = this.activeSelectionLayer >= 0;
    const splitLayer = hasActiveSelection ? this.activeSelectionLayer : activeLayerIdx;
    
    const upperLayersHaveBlendModes = this.layerManager.rangeHasBlendModeStrokes(splitLayer + 1, totalLayers);

    if (isDrawing && eraseAll) {
      this.layerManager.compositeLayerRange(this.mainCtx, 0, totalLayers, null, dirtyRects);
      
      this.mainCtx.globalCompositeOperation = 'destination-out';
      this.mainCtx.globalAlpha = this.app?.self?.opacity ?? 1.0;
      this.mainCtx.drawImage(this.topCanvas, 0, 0);
      
      this.mainCtx.globalCompositeOperation = 'destination-over';
      const [r, g, b, a] = this.backgroundColor;
      this.mainCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      this.mainCtx.fillRect(0, 0, width, height);
      
      this.mainCtx.globalCompositeOperation = 'source-over';
      this.mainCtx.globalAlpha = 1.0;
      
      if (this.upperLayersCtx) {
        this.upperLayersCtx.clearRect(0, 0, width, height);
      }
    } 
    else if ((isDrawing || hasActiveSelection) && splitLayer + 1 < totalLayers && !upperLayersHaveBlendModes) {
      this.layerManager.compositeLayerRange(this.mainCtx, 0, splitLayer + 1, this.backgroundColor, dirtyRects);
      
      if (isDrawing) {
        if (isEraser) {
          this.mainCtx.globalCompositeOperation = 'destination-out';
          this.mainCtx.globalAlpha = this.app?.self?.opacity ?? 1.0;
          this.mainCtx.drawImage(this.topCanvas, 0, 0);
          
          this.mainCtx.globalCompositeOperation = 'destination-over';
          const [r, g, b, a] = this.backgroundColor;
          this.mainCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
          this.mainCtx.fillRect(0, 0, width, height);
        } else {
          const blendMode = this.getActiveLayerBlendMode();
          if (blendMode !== 'source-over') {
            this.mainCtx.globalCompositeOperation = blendMode;
            this.mainCtx.drawImage(this.topCanvas, 0, 0);
          }
        }
        this.mainCtx.globalCompositeOperation = 'source-over';
        this.mainCtx.globalAlpha = 1.0;
      }

      if (this.upperLayersCtx) {
        this.layerManager.compositeLayerRange(this.upperLayersCtx, splitLayer + 1, totalLayers, null, dirtyRects);
      }
    } else {
      this.layerManager.compositeLayerRange(this.mainCtx, 0, totalLayers, this.backgroundColor, dirtyRects);
      
      if (isDrawing) {
        if (isEraser) {
          this.mainCtx.globalCompositeOperation = 'destination-out';
          this.mainCtx.globalAlpha = this.app?.self?.opacity ?? 1.0;
          this.mainCtx.drawImage(this.topCanvas, 0, 0);
          
          this.mainCtx.globalCompositeOperation = 'destination-over';
          const [r, g, b, a] = this.backgroundColor;
          this.mainCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
          this.mainCtx.fillRect(0, 0, width, height);
        } else {
          const blendMode = this.getActiveLayerBlendMode();
          if (blendMode !== 'source-over') {
            this.mainCtx.globalCompositeOperation = blendMode;
            this.mainCtx.drawImage(this.topCanvas, 0, 0);
          }
        }
        this.mainCtx.globalCompositeOperation = 'source-over';
        this.mainCtx.globalAlpha = 1.0;
      }

      if (this.upperLayersCtx) {
        this.upperLayersCtx.clearRect(0, 0, width, height);
      }
    }

    this.layerManager.needsComposite = false;
    this.layerManager._notifyHistoryPanel();
    this.performanceMonitor.recordCompositeEnd();
  }

  /**
   * Request a composite update on the next animation frame.
   */
  /**
   * Set the target render FPS.
   * 0 = uncapped (on-demand RAF, original behaviour).
   * Any positive value starts a persistent RAF loop capped to that rate.
   * @param {number} fps
   */
  setTargetFPS(fps) {
    this.targetFPS = fps;
    if (fps > 0) {
      this._startRenderLoop();
    } else {
      this._stopRenderLoop();
    }
  }

  /**
   * Starts a persistent RAF loop that composites at most targetFPS times/sec.
   * @private
   */
  _startRenderLoop() {
    if (this._rafLoopId !== null) return;
    const loop = (time) => {
      this._rafLoopId = requestAnimationFrame(loop);
      if (!this._needsComposite) return;
      const minInterval = 1000 / this.targetFPS;
      if (time - this._lastCompositeTime < minInterval) return;
      this._needsComposite = false;
      this._lastCompositeTime = time;
      this.compositeAllLayers();
    };
    this._rafLoopId = requestAnimationFrame(loop);
  }

  /**
   * Stops the persistent RAF loop.
   * @private
   */
  _stopRenderLoop() {
    if (this._rafLoopId !== null) {
      cancelAnimationFrame(this._rafLoopId);
      this._rafLoopId = null;
    }
  }

  /**
   * Request a composite on the next animation frame.
   * When a target FPS is set the persistent loop handles this automatically.
   * When uncapped, schedules a one-shot RAF as before.
   */
  requestUpdate() {
    this._needsComposite = true;
    if (this.targetFPS === 0 && !this._compositeScheduled) {
      this._compositeScheduled = true;
      requestAnimationFrame(() => this._performScheduledComposite());
    }
  }

  /**
   * One-shot RAF callback used in uncapped mode.
   * @private
   */
  _performScheduledComposite() {
    this._compositeScheduled = false;
    if (this._needsComposite) {
      this._needsComposite = false;
      this._lastCompositeTime = performance.now();
      this.compositeAllLayers();
    }
  }

  /**
   * Clear the preview (top) canvas
   */
  clearTop() {
    const [height, width] = this.dimensions;
    this.topCtx.clearRect(0, 0, width, height);
  }

  /**
   * Get board width
   * @returns {number}
   */
  getWidth() {
    return this.dimensions[1];
  }

  /**
   * Get board height
   * @returns {number}
   */
  getHeight() {
    return this.dimensions[0];
  }

  /**
   * Save the main canvas as a PNG image
   */
  saveAsImage() {
    const dataURL = this.mainCanvas.toDataURL();
    const link = document.createElement('a');
    link.download = `${new Date().toString().slice(0, 24)}.png`;
    link.href = dataURL;
    link.click();
  }
}
