import { LayerManager } from './LayerManager.js';

/**
 * Board class managing canvas elements and viewport
 */
export class Board {
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
    this.backgroundColor = options.backgroundColor || [255, 255, 255, 1]; // Default: white [r, g, b, a]

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

    // Layer management
    this.layerManager = null;
    this.app = null; // Reference to DrawingApp for accessing user state
  }

  /**
   * Set reference to the DrawingApp
   * @param {DrawingApp} app - The main application instance
   */
  setApp(app) {
    this.app = app;
  }

  init(containerSelector) {
    this.container = document.querySelector(containerSelector);
    this.boardsWrapper = document.getElementById('boards');
    this.mainCanvas = document.getElementById('board');
    this.topCanvas = document.getElementById('topBoard');
    this.cursorsSvg = document.getElementById('cursorsSvg');
    this.mirrorLine = document.querySelector('.mirrorLine');

    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true });
    this.topCtx = this.topCanvas.getContext('2d');

    // Create upper layers canvas: renders layers above the active layer so they
    // appear on top of the topCtx preview stroke during drawing.
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

    // Initialize layer manager after canvas setup
    const [height, width] = this.dimensions;
    this.layerManager = new LayerManager(width, height);

    this.calculateDefaultView();
    this.resetView();
  }

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

  calculateDefaultView() {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight - 50; // Account for toolbar
    const [height, width] = this.dimensions;

    // Calculate zoom to fit board in container with padding
    const padding = 20;
    const availableWidth = containerWidth - padding * 2;
    const availableHeight = containerHeight - padding * 2;

    const zoomX = availableWidth / width;
    const zoomY = availableHeight / height;
    const zoom = Math.min(zoomX, zoomY, 1); // Don't zoom above 100%

    // Center the board in the container
    const scaledWidth = width * zoom;
    const scaledHeight = height * zoom;
    const panX = (containerWidth - scaledWidth) / 2;
    const panY = (containerHeight - scaledHeight) / 2 + 50; // Offset for toolbar

    this.defaultZoom = Math.round(zoom * 1000) / 1000;
    this.defaultPanX = panX;
    this.defaultPanY = panY;
  }

  resetView() {
    this.zoom = this.defaultZoom;
    this.panX = this.defaultPanX;
    this.panY = this.defaultPanY;
    this.rotation = this.defaultRotation;

    this.applyTransform();
  }


    applyTransform() {
      // Set origin to top-left to simplify math
      this.boardsWrapper.style.transformOrigin = '0 0';
      
      // Apply rotation and scale
      // Note: We translate via left/top, but you could also do it in the transform string
      this.boardsWrapper.style.transform = `scale(${this.zoom}) rotate(${this.rotation}deg)`;
      this.boardsWrapper.style.left = `${this.panX}px`;
      this.boardsWrapper.style.top = `${this.panY}px`;
    }
  

  setRotation(angle) {
    this.rotation = angle;
    this.applyTransform();
  }

  /**
   * Rotate to a new angle while keeping the given boardContainer-space pivot fixed on screen.
   * @param {number} newAngleDeg - New rotation in degrees
   * @param {number} pivotX - Pivot X in boardContainer coordinates (same space as panX)
   * @param {number} pivotY - Pivot Y in boardContainer coordinates (same space as panY)
   */
  setRotationAround(newAngleDeg, pivotX, pivotY) {
    const oldRad = this.rotation * Math.PI / 180;
    const newRad = newAngleDeg * Math.PI / 180;
    const { zoom } = this;

    // Find board-space coordinate of the pivot using current transform:
    //   cx = panX + zoom*(bx*cosθ - by*sinθ)
    //   cy = panY + zoom*(bx*sinθ + by*cosθ)
    // Inverting: boardX = ((cx-panX)*cosθ + (cy-panY)*sinθ) / zoom
    //            boardY = (-(cx-panX)*sinθ + (cy-panY)*cosθ) / zoom
    const dx = pivotX - this.panX;
    const dy = pivotY - this.panY;
    const cosOld = Math.cos(oldRad);
    const sinOld = Math.sin(oldRad);
    const boardX = (dx * cosOld + dy * sinOld) / zoom;
    const boardY = (-dx * sinOld + dy * cosOld) / zoom;

    // Compute new pan so the board point maps back to the same pivot on screen
    const cosNew = Math.cos(newRad);
    const sinNew = Math.sin(newRad);
    this.panX = pivotX - zoom * (boardX * cosNew - boardY * sinNew);
    this.panY = pivotY - zoom * (boardX * sinNew + boardY * cosNew);
    this.rotation = newAngleDeg;
    this.applyTransform();
  }

  resetRotation() {
    this.rotation = this.defaultRotation;
    this.applyTransform();
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.applyTransform();
  }

  setZoom(zoom, cursorPos = null) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.2, Math.min(3, zoom));

    if (cursorPos) {
      // 1. Where is the cursor on the screen?
      // (Local canvas point * old zoom) + current offset
      const screenX = cursorPos.x * oldZoom + this.panX;
      const screenY = cursorPos.y * oldZoom + this.panY;

      // 2. Adjust pan so that: (cursorPos.x * newZoom) + newPan = screenX
      this.panX = screenX - (cursorPos.x * this.zoom);
      this.panY = screenY - (cursorPos.y * this.zoom);
    } else {
      // Center zoom logic (using board dimensions)
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

  zoomIn(step = 0.1, cursorPos = null) {
    return this.setZoom(Math.round((this.zoom + step) * 10) / 10, cursorPos);
  }

  zoomOut(step = 0.1, cursorPos = null) {
    return this.setZoom(Math.round((this.zoom - step) * 10) / 10, cursorPos);
  }

  getZoomPercent() {
    return `${(this.zoom * 100).toFixed(1)}%`;
  }

  toggleMirror() {
    this.mirror = !this.mirror;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    return this.mirror;
  }

  setMirror(value) {
    this.mirror = value;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
  }

  clear() {
    const [height, width] = this.dimensions;
    this.mainCtx.beginPath();
    this.topCtx.beginPath();

    // Clear all layers
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
   * Strokes must always be drawn source-over into this context —
   * the blend mode is applied at composite time, not at draw time.
   * @param {string} [createBlendMode='source-over']
   * @returns {CanvasRenderingContext2D} The active sub-layer's context
   */
  getActiveLayerContext(createBlendMode = 'source-over') {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    return this.layerManager?.getLayerContext(activeLayer, userId, createBlendMode) ?? this.mainCtx;
  }

  /**
   * Get the drawing context for a specific user on a specific layer.
   * Used by remote user handlers.
   * @param {number} layerIndex - Layer group index
   * @param {number} userId - User ID
   * @param {string} [createBlendMode='source-over']
   * @returns {CanvasRenderingContext2D} The sub-layer's context
   */
  getLayerContext(layerIndex, userId, createBlendMode = 'source-over') {
    return this.layerManager?.getLayerContext(layerIndex, userId, createBlendMode) ?? this.mainCtx;
  }

  /**
   * Get the local user's current blend mode.
   * This is the sticky blend mode set by the user, used for UI display.
   * Sub-layers are always drawn source-over internally.
   * @returns {string}
   */
  getActiveLayerBlendMode() {
    return this.app?.self?.blendMode ?? 'source-over';
  }

  /**
   * Begin a new stroke for the local user with the given blend mode.
   * Called when the user switches blend modes mid-session.
   * @param {string} blendMode - CSS composite operation
   */
  createActiveLayerBlendSubLayer(blendMode) {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    if (this.layerManager) {
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode);
    }
  }

  /**
   * Begin a new stroke for a user. Creates a fresh active-stroke canvas so each
   * stroke composites independently — required for blend modes like difference/multiply.
   * @param {Object} user - User object with activeLayer, id, and blendMode
   * @param {string} [blendModeOverride] - Override user.blendMode (e.g. 'destination-out' for eraser)
   */
  beginStroke(user, blendModeOverride) {
    if (user?.panning) return;
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const blendMode = blendModeOverride ?? user?.blendMode ?? 'source-over';
    if (this.layerManager) {
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode);
    }
    // Refresh the mainCtx/upperLayersCtx split so the preview (topCtx) sits at the
    // correct depth between lower and upper layers when drawing begins.
    this.compositeAllLayers();
  }

  /**
   * Begin a destination-out stroke on every layer simultaneously (erase-all mode).
   * @param {Object} user - User object with id
   * @param {string} blendMode - Expected to be 'destination-out'
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
    this.compositeAllLayers();
  }

  /**
   * Commit active strokes on every layer for a user (erase-all mode).
   * @param {Object} user - User object with id
   */
  endStrokeAllLayers(user) {
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    const batchTimestamp = Date.now();
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.layerManager.commitUserStroke(i, userId, { eraseAll: true, timestamp: batchTimestamp });
    }
    this.compositeAllLayers();
  }

  /**
   * Return drawing contexts for all layers for a given user.
   * Lazily creates active stroke canvases if not present.
   * @param {number} userId
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
   * End the current stroke for a user. Commits the active stroke canvas to the
   * stroke history stack and triggers a composite refresh.
   * @param {Object} user - User object with activeLayer and id
   */
  endStroke(user) {
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    this.layerManager.commitUserStroke(activeLayer, userId);
    this.compositeAllLayers();
  }

  /**
   * Cancel the current stroke for a user. Discards the active stroke canvas
   * without committing it.
   * @param {Object} user - User object with activeLayer and id
   */
  cancelStroke(user) {
    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;
    this.layerManager.cancelUserStroke(activeLayer, userId);
    this.compositeAllLayers();
  }

  /**
   * Undo the most recent stroke for userId across all layers (global, timestamp-ordered).
   * Erase-all batches are removed atomically. The undone batch is pushed onto the redo stack.
   * @param {number} _layerIndex - Unused; kept for call-site compatibility
   * @param {number} userId
   */
  undo(_layerIndex, userId) {
    if (!this.layerManager) return;
    const batch = this.layerManager.undoLastStrokeGlobal(userId);
    if (batch) {
      this.layerManager._pushToRedoStack(userId, batch);
      // If the undone stroke was a selection paste, restore the erased source area
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          this._applySelectionRestore(record.selectionRestoreData.snapshots);
          break;
        }
      }
    }
    this.compositeAllLayers();
  }

  /**
   * Redo the most recently undone stroke batch for userId.
   * @param {number} userId
   */
  redo(userId) {
    if (!this.layerManager) return;
    // If the stroke being redone was a selection paste, re-apply the source-area erase
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
    this.compositeAllLayers();
  }

  /** Apply pixel snapshots back to baseCanvas (used by undo of a selection paste) */
  _applySelectionRestore(snapshots) {
    if (!snapshots) return;
    const lm = this.layerManager;
    for (const { groupIdx, canvas, x, y } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;
      group.baseCtx.drawImage(canvas, x, y);
      lm.needsComposite = true;
    }
    lm._notifyHistoryPanel();
  }

  /** Re-apply the erase to baseCanvas (used by redo of a selection paste) */
  _applySelectionReErase(restoreData) {
    const lm = this.layerManager;
    const { snapshots, eraseS: s, eraseLassoPath: lassoPath } = restoreData;
    for (const { groupIdx } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;
      group.baseCtx.globalCompositeOperation = 'destination-out';
      group.baseCtx.fillStyle = 'white';
      if (lassoPath && lassoPath.length >= 3) {
        group.baseCtx.beginPath();
        group.baseCtx.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) {
          group.baseCtx.lineTo(lassoPath[i].x, lassoPath[i].y);
        }
        group.baseCtx.closePath();
        group.baseCtx.fill();
      } else {
        group.baseCtx.fillRect(s.x, s.y, s.width, s.height);
      }
      group.baseCtx.globalCompositeOperation = 'source-over';
      lm.needsComposite = true;
    }
    lm._notifyHistoryPanel();
  }

  /**
   * Get the full layer group for the active layer (used by eraser)
   * @returns {Object|undefined}
   */
  getActiveLayerGroup() {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    return this.layerManager?.getLayerGroup(activeLayer);
  }

  /**
   * Get the full layer group for a specific index (used by remote eraser)
   * @param {number} index - Layer group index
   * @returns {Object|undefined}
   */
  getLayerGroup(index) {
    return this.layerManager?.getLayerGroup(index);
  }

  /**
   * Composite all visible layers onto the main canvas.
   *
   * While the local user has an active in-progress stroke we use a split:
   *   - mainCtx   → layers 0..activeLayerIdx (with background)
   *   - upperLayersCtx → layers above activeLayerIdx (transparent)
   * This lets the topCtx live-preview stroke sit visually between the two canvases.
   *
   * At all other times (layer switch, undo, stroke committed, etc.) we do a full
   * composite of all layers onto mainCtx so that blend modes (overlay, multiply…)
   * interact correctly with every layer beneath them. upperLayersCtx is cleared.
   */
  compositeAllLayers() {
    if (!this.layerManager) return;

    const activeLayerIdx = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    const totalLayers = this.layerManager.getLayerCount();
    const [height, width] = this.dimensions;

    // Only split when the user actually has a stroke in progress so the preview
    // depth is correct. Outside of drawing, upper-layer blend modes need to
    // blend against lower-layer pixels, which only works when all layers share
    // one canvas context.
    //
    // Also skip split mode if upper layers have blend-mode strokes (non-source-over).
    // CSS canvas stacking doesn't support cross-canvas blend operations, so those
    // strokes would composite against transparent instead of lower-layer content.
    const activeGroup = this.layerManager.getLayerGroup(activeLayerIdx);
    const isDrawing = activeGroup?.activeStrokeByUser?.has(userId) ?? false;
    const upperLayersHaveBlendModes = this.layerManager.rangeHasBlendModeStrokes(activeLayerIdx + 1, totalLayers);

    if (isDrawing && activeLayerIdx + 1 < totalLayers && !upperLayersHaveBlendModes) {
      // Split mode: preview (topCtx) sits between lower and upper layer canvases.
      // Safe because upper layers only have source-over strokes.
      this.layerManager.compositeLayerRange(this.mainCtx, 0, activeLayerIdx + 1, this.backgroundColor);
      if (this.upperLayersCtx) {
        this.layerManager.compositeLayerRange(this.upperLayersCtx, activeLayerIdx + 1, totalLayers, null);
      }
    } else {
      // Full composite: all layers together so blend modes resolve correctly.
      this.layerManager.compositeLayerRange(this.mainCtx, 0, totalLayers, this.backgroundColor);
      if (this.upperLayersCtx) {
        this.upperLayersCtx.clearRect(0, 0, width, height);
      }
    }

    this.layerManager.needsComposite = false;
    this.layerManager._notifyHistoryPanel();
  }

  clearTop() {
    const [height, width] = this.dimensions;
    this.topCtx.clearRect(0, 0, width, height);
  }

  getWidth() {
    return this.dimensions[1];
  }

  getHeight() {
    return this.dimensions[0];
  }

  saveAsImage() {
    const dataURL = this.mainCanvas.toDataURL();
    const link = document.createElement('a');
    link.download = `${new Date().toString().slice(0, 24)}.png`;
    link.href = dataURL;
    link.click();
  }
}
