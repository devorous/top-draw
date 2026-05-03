import { LayerManager } from './LayerManager.js';
import { CompositeTileGrid } from './CompositeTileGrid.js';
import { TileTracker } from './TileTracker.js';
import * as wasm from '../wasm/ddraw_wasm.js';
import { readQoiDimensions, snapshotLayerDimensions } from '../../shared/qoi.js';

/**
 * @fileoverview Board class managing canvas elements and viewport
 */

/**
 * Manages the drawing boards, viewport transformations, and compositing logic.
 */
export class Board {
  static MAX_ZOOM = 10;
  static MIN_ZOOM = 0.2;
  static HIGH_ZOOM_THRESHOLD = 5;

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
    this.canvasFlipped = false;
    this.mirror = false;
    this.mirrorRegions = [];
    this.backgroundColor = options.backgroundColor || [255, 255, 255, 1];
    this.displayBackgroundColorOverride = null;

    this.container = null;
    this.boardsWrapper = null;
    this.mainCanvas = null;
    this.topCanvas = null;
    this.upperLayersCanvas = null;
    this.pixelGridOverlay = null;
    this.selectionOverlay = null;
    this.selectionOverlayPadding = 500;
    this.interactionBlockOverlay = null;
    this.interactionBlockCtx = null;
    this.mainCtx = null;
    this.topCtx = null;
    this.upperLayersCtx = null;
    this._upperLayersCompositeStart = null;
    this._mainCompositeEnd = null;
    this.selectionCtx = null;
    this.cursorsSvg = null;
    this.mirrorLine = null;
    this.mirrorRegionsLayer = null;
    this.onMirrorRegionsChange = null;

    this.layerManager = null;
    this.app = null;

    this.activeSelectionLayer = -1;
    this.interactionBlocks = [];
    this.interactionBlockOverlayPadding = 500;
    this.interactionBlockDashOffset = 0;
    this.interactionBlockAnimationId = null;

    this._needsComposite = false;
    this._compositeScheduled = false;

    // Flush any pending composite when the tab returns to visible — rAF is
    // paused while hidden, so a requestUpdate() scheduled in the background
    // would otherwise sit stalled until the next user-initiated frame.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this._needsComposite) {
          this._performScheduledComposite();
        }
      });
    }

    /** @type {TileTracker|null} Tracks occupied tiles */
    this.tileTracker = null;

    /** @type {number} Target render FPS (0 = uncapped/on-demand) */
    this.targetFPS = 0;
    /** @type {number} DOMHighResTimeStamp of the last completed composite */
    this._lastCompositeTime = 0;
    /** @type {number|null} RAF ID for the persistent render loop */
    this._rafLoopId = null;
    this.compositeTileGrid = null;
    this.showRawPixelsAtHighZoom = true;
    this.useDesynchronizedBoardContexts = false;
    this._boardContextsInitialized = false;
    this._desyncDiagnosticsLogged = false;
    this._contextDesyncSupport = {};
    this._lastPixelGridZoom = null;
    this._lastPixelGridVisible = null;
    this._lastPixelGridPanX = null;
    this._lastPixelGridPanY = null;
    this._lastHighZoomCrisp = null;

    this._cachedContainerRect = null;
    this._containerResizeObserver = null;
    this._invalidateContainerRect = () => { this._cachedContainerRect = null; };
  }

  _getContainerRect() {
    if (!this._cachedContainerRect) {
      this._cachedContainerRect = this.container.getBoundingClientRect();
    }
    return this._cachedContainerRect;
  }

  /**
   * Set reference to the DrawingApp
   * @param {Object} app - The main application instance
   */
  setApp(app) {
    this.app = app;
  }

  /**
   * Configure whether board canvases should request low-latency 2D contexts.
   * Returns true when a refresh is required for the change to take effect.
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setUseDesynchronizedBoardContexts(enabled) {
    const next = !!enabled;
    const changed = this.useDesynchronizedBoardContexts !== next;
    this.useDesynchronizedBoardContexts = next;
    return changed && this._boardContextsInitialized;
  }

  _createBoard2DContext(canvas, role, baseOptions = null) {
    const options = {
      ...(baseOptions || {})
    };

    if (this.useDesynchronizedBoardContexts) {
      options.desynchronized = true;
    }

    const ctx = canvas.getContext('2d', options);
    const attrs = typeof ctx?.getContextAttributes === 'function'
      ? ctx.getContextAttributes()
      : null;

    this._contextDesyncSupport[role] = {
      requested: !!this.useDesynchronizedBoardContexts,
      effective: !!attrs?.desynchronized,
      reported: !!attrs && typeof attrs.desynchronized === 'boolean'
    };

    return ctx;
  }

  _logDesyncDiagnostics() {
    if (this._desyncDiagnosticsLogged) return;

    const entries = Object.entries(this._contextDesyncSupport);
    const detail = entries.map(([role, state]) => ({
      role,
      requested: state.requested,
      effective: state.reported ? state.effective : 'unknown'
    }));

    console.info('[Board] Canvas2D desynchronized context status', detail);
    this._desyncDiagnosticsLogged = true;
  }

  /**
   * Set the canvas background color from a hex string
   * @param {string} hex - Hex color string (e.g., "#ffffff")
   */
  setBackgroundColor(hex) {
    // Convert hex to RGBA array
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    this.backgroundColor = [r, g, b, 1];
    this._syncBoardWrapperBackground();
    this.markCompositeFull();
    this.requestUpdate();
  }

  /**
   * Set a local-only background color override used for board compositing.
   * This does not change the room background color used by blur/export/network logic.
   * @param {string|null} hex - Hex color string or null to clear override
   */
  setDisplayBackgroundColorOverride(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) {
      this.displayBackgroundColorOverride = null;
    } else {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      this.displayBackgroundColorOverride = [r, g, b, 1];
    }
    this._syncBoardWrapperBackground();
    this.markCompositeFull();
    this.requestUpdate();
  }

  getCompositeBackgroundColor() {
    return this.displayBackgroundColorOverride || this.backgroundColor;
  }

  _syncBoardWrapperBackground() {
    if (!this.boardsWrapper) return;
    const [r, g, b, a = 1] = this.getCompositeBackgroundColor();
    this.boardsWrapper.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a})`;
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
    this._syncBoardWrapperBackground();

    this.mainCtx = this._createBoard2DContext(this.mainCanvas, 'main', { willReadFrequently: true });
    this.topCtx = this._createBoard2DContext(this.topCanvas, 'top');

    // Create selection overlay canvas with padding to allow handles to extend beyond board
    this.selectionOverlay = document.createElement('canvas');
    this.selectionOverlay.id = 'selectionOverlay';
    this.selectionOverlay.style.position = 'absolute';
    this.selectionOverlay.style.pointerEvents = 'none';
    this.boardsWrapper.appendChild(this.selectionOverlay);
    this.selectionCtx = this._createBoard2DContext(this.selectionOverlay, 'selection');

    this.interactionBlockOverlay = document.createElement('canvas');
    this.interactionBlockOverlay.id = 'interactionBlockOverlay';
    this.interactionBlockOverlay.style.position = 'absolute';
    this.interactionBlockOverlay.style.top = '0';
    this.interactionBlockOverlay.style.left = '0';
    this.interactionBlockOverlay.style.pointerEvents = 'none';
    this.interactionBlockOverlay.style.zIndex = '4';
    this.boardsWrapper.appendChild(this.interactionBlockOverlay);
    this.interactionBlockCtx = this._createBoard2DContext(this.interactionBlockOverlay, 'interaction');

    this.upperLayersCanvas = document.createElement('canvas');
    this.upperLayersCanvas.id = 'upperLayersBoard';
    this.upperLayersCanvas.style.position = 'absolute';
    this.upperLayersCanvas.style.top = '0';
    this.upperLayersCanvas.style.left = '0';
    this.upperLayersCanvas.style.pointerEvents = 'none';
    this.upperLayersCanvas.style.zIndex = '2';
    this.boardsWrapper.appendChild(this.upperLayersCanvas);
    this.upperLayersCtx = this._createBoard2DContext(this.upperLayersCanvas, 'upper');

    this.pixelGridOverlay = document.createElement('div');
    this.pixelGridOverlay.id = 'pixelGridBoard';
    this.pixelGridOverlay.style.position = 'absolute';
    this.pixelGridOverlay.style.top = '0';
    this.pixelGridOverlay.style.left = '0';
    this.pixelGridOverlay.style.pointerEvents = 'none';
    this.pixelGridOverlay.style.zIndex = '250';
    this.pixelGridOverlay.style.display = 'none';
    this.pixelGridOverlay.style.backgroundRepeat = 'repeat';
    this.container.appendChild(this.pixelGridOverlay);

    this.mirrorRegionsLayer = document.createElement('canvas');
    this.mirrorRegionsLayer.id = 'mirrorRegionsLayer';
    this.mirrorRegionsLayer.style.position = 'absolute';
    this.mirrorRegionsLayer.style.top = '0';
    this.mirrorRegionsLayer.style.left = '0';
    this.mirrorRegionsLayer.style.pointerEvents = 'none';
    this.mirrorRegionsLayer.style.zIndex = '3';
    this.boardsWrapper.appendChild(this.mirrorRegionsLayer);

    this.mirrorRegionsCtx = this._createBoard2DContext(this.mirrorRegionsLayer, 'mirror');
    this._boardContextsInitialized = true;
    this._logDesyncDiagnostics();

    this.setupCanvas();

    this._createLayerManager();

    const [height, width] = this.dimensions;
    this.compositeTileGrid = new CompositeTileGrid(width, height, 32);
    this.tileTracker = new TileTracker(width, height);

    this.calculateDefaultView();
    this.resetView();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this._invalidateContainerRect, { passive: true });
      window.addEventListener('scroll', this._invalidateContainerRect, { passive: true, capture: true });
    }
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      this._containerResizeObserver = new ResizeObserver(this._invalidateContainerRect);
      this._containerResizeObserver.observe(this.container);
    }
  }

  _createLayerManager(previousLayerManager = null) {
    const [height, width] = this.dimensions;
    const layerManager = new LayerManager(width, height);
    layerManager.board = this;
    layerManager.onNeedsUpdate = () => this.requestUpdate();
    layerManager.onGlitchBlurReady = (result) => this._handleGlitchBlurReady(result);
    layerManager.localUserId = this.app?.self?.id ?? null;

    if (previousLayerManager?.layerGroups?.length === layerManager.layerGroups.length) {
      for (let i = 0; i < layerManager.layerGroups.length; i++) {
        layerManager.layerGroups[i].visible = previousLayerManager.layerGroups[i].visible;
        layerManager.layerGroups[i].allowComplexBlendModes = previousLayerManager.layerGroups[i].allowComplexBlendModes;
        layerManager.layerGroups[i].name = previousLayerManager.layerGroups[i].name;
      }
    }

    this.layerManager = layerManager;
    return layerManager;
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
    if (typeof document !== 'undefined') {
      document.querySelectorAll('#userBoards .userBoard').forEach((canvas) => {
        canvas.height = height;
        canvas.width = width;
        const context = canvas.getContext('2d');
        context.lineCap = 'round';
        context.lineJoin = 'round';
      });
    }
    if (this.upperLayersCanvas) {
      this.upperLayersCanvas.height = height;
      this.upperLayersCanvas.width = width;
    }
    this.compositeTileGrid?.resize(width, height);
    if (this.selectionOverlay) {
      const pad = this.selectionOverlayPadding;
      this.selectionOverlay.width = width + pad * 2;
      this.selectionOverlay.height = height + pad * 2;
      this.selectionOverlay.style.left = `${-pad}px`;
      this.selectionOverlay.style.top = `${-pad}px`;
    }
    if (this.interactionBlockOverlay) {
      const pad = this.interactionBlockOverlayPadding;
      this.interactionBlockOverlay.width = width + pad * 2;
      this.interactionBlockOverlay.height = height + pad * 2;
      this.interactionBlockOverlay.style.left = `${-pad}px`;
      this.interactionBlockOverlay.style.top = `${-pad}px`;
    }

    this.mainCtx.globalCompositeOperation = 'source-over';
    this.mainCtx.imageSmoothingQuality = 'high';
    this.mainCtx.lineCap = 'round';
    this.mainCtx.lineJoin = 'round';

    this.topCtx.imageSmoothingQuality = 'high';
    this.topCtx.lineCap = 'round';
    this.topCtx.lineJoin = 'round';

    if (this.mirrorLine) {
      this.mirrorLine.setAttribute('x1', width / 2);
      this.mirrorLine.setAttribute('y1', 0);
      this.mirrorLine.setAttribute('x2', width / 2);
      this.mirrorLine.setAttribute('y2', height);
      this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    }

    this.boardsWrapper.style.transformOrigin = 'top left';
    if (this.mirrorRegionsLayer) {
      this.mirrorRegionsLayer.width = width;
      this.mirrorRegionsLayer.height = height;
      this.mirrorRegionsLayer.style.width = `${width}px`;
      this.mirrorRegionsLayer.style.height = `${height}px`;
    }
    this.renderInteractionBlocks();
    this.renderMirrorRegions();
    this.renderPixelGrid();
    this.updateHighZoomRenderingMode();
  }

  /**
   * Calculate default zoom and pan to fit the board in the container
   */
  calculateDefaultView() {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
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
    const panY = (containerHeight - scaledHeight) / 2;

    this.defaultZoom = Math.round(zoom * 1000) / 1000;
    this.defaultPanX = panX;
    this.defaultPanY = panY;
  }

  /**
   * Reset the viewport to default zoom, pan, and rotation
   */
  resetView() {
    this.calculateDefaultView();
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
    const flipTransform = this.canvasFlipped
      ? ` translate(${this.getWidth()}px, 0) scaleX(-1)`
      : '';
    this.boardsWrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom}) rotate(${this.rotation}deg)${flipTransform}`;
    this.boardsWrapper.style.left = '';
    this.boardsWrapper.style.top = '';

    // Counter-flip #floatingArtMount so the floating art gallery stays upright
    // while the board's drawing layers mirror horizontally.
    const floatingArtMount = document.getElementById('floatingArtMount');
    if (floatingArtMount) {
      floatingArtMount.style.transformOrigin = '0 0';
      floatingArtMount.style.transform = this.canvasFlipped
        ? `translate(${this.getWidth()}px, 0) scaleX(-1)`
        : '';
    }
    this.renderPixelGrid();
    this.updateHighZoomRenderingMode();
  }

  /**
   * Transforms screen (client) coordinates to board-space coordinates.
   * Accounts for zoom, pan, and rotation.
   * @param {number} clientX - Screen X coordinate
   * @param {number} clientY - Screen Y coordinate
   * @returns {{x: number, y: number}} - Board-relative coordinates
   */
  getBoardRelativePos(clientX, clientY) {
    // Cached to avoid forced style recalc on every pointermove. The container
    // element's screen rect is unaffected by zoom/pan/rotate (those transform
    // boardsWrapper inside it), so it only needs invalidating on layout
    // changes — wired up in init() via resize/scroll listeners + ResizeObserver.
    const containerRect = this._getContainerRect();
    let bx = clientX - containerRect.left;
    let by = clientY - containerRect.top;


    bx -= this.panX;
    by -= this.panY;


    const rad = -this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = bx * cos - by * sin;
    const ry = bx * sin + by * cos;


    let boardX = rx / this.zoom;
    const boardY = ry / this.zoom;

    if (this.canvasFlipped) {
      boardX = this.getWidth() - boardX;
    }

    return {
      x: Math.round(boardX * 100) / 100,
      y: Math.round(boardY * 100) / 100
    };
  }

  /**
   * Toggle a local-only horizontal flip of the viewport.
   * @returns {boolean} New flip state
   */
  toggleCanvasFlip() {
    this.canvasFlipped = !this.canvasFlipped;
    this.applyTransform();
    return this.canvasFlipped;
  }

  /**
   * Set local-only horizontal flip of the viewport.
   * @param {boolean} enabled
   */
  setCanvasFlip(enabled) {
    this.canvasFlipped = !!enabled;
    this.applyTransform();
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
   * @param {number} zoom - Zoom level
   * @param {Object} [cursorPos=null] - Pivot point for zoom {x, y}
   * @returns {number} The applied zoom level
   */
  setZoom(zoom, cursorPos = null) {
    const oldZoom = this.zoom;
    this.zoom = this._clampZoom(zoom);

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
    this.zoom = this._clampZoom(newZoom);

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
    return this.setZoom(this._getNextZoomStep('in', step), cursorPos);
  }

  /**
   * Zoom out by a step
   * @param {number} [step=0.1] - Zoom step
   * @param {Object} [cursorPos=null] - Pivot point for zoom
   * @returns {number} The applied zoom level
   */
  zoomOut(step = 0.1, cursorPos = null) {
    return this.setZoom(this._getNextZoomStep('out', step), cursorPos);
  }

  /**
   * Get zoom percentage string
   * @returns {string}
   */
  getZoomPercent() {
    return `${(this.zoom * 100).toFixed(1)}%`;
  }

  _clampZoom(zoom) {
    return Math.max(Board.MIN_ZOOM, Math.min(Board.MAX_ZOOM, zoom));
  }

  _getNextZoomStep(direction, requestedStep = 0.1) {
    const step = this.zoom >= Board.HIGH_ZOOM_THRESHOLD
      ? 0.25
      : requestedStep;
    const nextZoom = direction === 'out'
      ? this.zoom - step
      : this.zoom + step;
    const precision = step >= 0.25 ? 100 : 1000;
    return Math.round(nextZoom * precision) / precision;
  }

  shouldShowPixelGrid() {
    return this.zoom >= Board.HIGH_ZOOM_THRESHOLD && this.rotation === 0;
  }

  setShowRawPixelsAtHighZoom(enabled) {
    this.showRawPixelsAtHighZoom = !!enabled;
    this.updateHighZoomRenderingMode();
  }

  updateHighZoomRenderingMode() {
    const crisp = this.showRawPixelsAtHighZoom && this.zoom >= Board.HIGH_ZOOM_THRESHOLD;
    if (this._lastHighZoomCrisp === crisp) return;
    this._lastHighZoomCrisp = crisp;

    const imageRendering = crisp ? 'pixelated' : 'auto';
    const smoothingEnabled = !crisp;
    const smoothingQuality = crisp ? 'low' : 'high';
    const canvases = [
      this.mainCanvas,
      this.topCanvas,
      this.upperLayersCanvas,
      this.selectionOverlay,
      this.interactionBlockOverlay
    ].filter(Boolean);
    const contexts = [
      this.mainCtx,
      this.topCtx,
      this.upperLayersCtx,
      this.selectionCtx,
      this.interactionBlockCtx
    ].filter(Boolean);

    for (const canvas of canvases) {
      canvas.style.imageRendering = imageRendering;
    }

    for (const ctx of contexts) {
      ctx.imageSmoothingEnabled = smoothingEnabled;
      if ('imageSmoothingQuality' in ctx) {
        ctx.imageSmoothingQuality = smoothingQuality;
      }
    }
  }

  renderPixelGrid() {
    if (!this.pixelGridOverlay || !this.container) return;

    const visible = this.shouldShowPixelGrid();
    if (
      this._lastPixelGridVisible === visible &&
      this._lastPixelGridZoom === this.zoom &&
      this._lastPixelGridPanX === this.panX &&
      this._lastPixelGridPanY === this.panY
    ) {
      return;
    }
    this._lastPixelGridVisible = visible;
    this._lastPixelGridZoom = this.zoom;
    this._lastPixelGridPanX = this.panX;
    this._lastPixelGridPanY = this.panY;

    this.pixelGridOverlay.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const width = Math.round(this.getWidth() * this.zoom);
    const height = Math.round(this.getHeight() * this.zoom);
    const left = Math.round(this.panX);
    const top = Math.round(this.panY);
    const cellSize = this.zoom;

    this.pixelGridOverlay.style.left = `${left}px`;
    this.pixelGridOverlay.style.top = `${top}px`;
    this.pixelGridOverlay.style.width = `${width}px`;
    this.pixelGridOverlay.style.height = `${height}px`;
    this.pixelGridOverlay.style.backgroundSize = `${cellSize}px ${cellSize}px`;
    this.pixelGridOverlay.style.backgroundPosition = '0 0, 0 0';
    this.pixelGridOverlay.style.backgroundImage = [
      'linear-gradient(to right, rgba(150, 150, 150, 0.16) 1px, transparent 1px)',
      'linear-gradient(to bottom, rgba(150, 150, 150, 0.16) 1px, transparent 1px)'
    ].join(', ');
  }

  /**
   * Toggle vertical mirror line
   * @returns {boolean} New mirror state
   */
  toggleMirror() {
    this.mirror = !this.mirror;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    this.renderMirrorRegions();
    return this.mirror;
  }

  /**
   * Set mirror state
   * @param {boolean} value - Mirror state
   */
  setMirror(value) {
    this.mirror = value;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    this.renderMirrorRegions();
  }

  /**
   * Sets the shared mirror regions for the room.
   * @param {Array<Object>} regions
   */
  setMirrorRegions(regions = []) {
    this.mirrorRegions = Array.isArray(regions)
      ? regions
        .map(region => this._normalizeMirrorRegion(region))
        .filter(Boolean)
      : [];
    this.renderMirrorRegions();
    if (typeof this.onMirrorRegionsChange === 'function') {
      this.onMirrorRegionsChange(this.mirrorRegions);
    }
  }

  addInteractionBlock(region) {
    const normalized = this._normalizeInteractionBlock(region);
    if (!normalized) return null;
    this.interactionBlocks = [...this.interactionBlocks, normalized];
    this.renderInteractionBlocks();
    this._updateInteractionBlockAnimation();
    return normalized.id;
  }

  removeInteractionBlock(id) {
    if (!id) return;
    const nextBlocks = this.interactionBlocks.filter(block => block.id !== id);
    if (nextBlocks.length === this.interactionBlocks.length) return;
    this.interactionBlocks = nextBlocks;
    this.renderInteractionBlocks();
    this._updateInteractionBlockAnimation();
  }

  clearInteractionBlocks() {
    if (this.interactionBlocks.length === 0) return;
    this.interactionBlocks = [];
    this.renderInteractionBlocks();
    this._updateInteractionBlockAnimation();
  }

  hasInteractionBlocks() {
    return this.interactionBlocks.length > 0;
  }

  isPointInInteractionBlock(point) {
    if (!point) return false;
    return this.interactionBlocks.some(block => this._pointInInteractionBlock(point, block));
  }

  segmentIntersectsInteractionBlock(start, end) {
    if (!start || !end) return false;
    return this.interactionBlocks.some(block => this._segmentIntersectsInteractionBlock(start, end, block));
  }

  /**
   * Gets active mirror regions, with full-board mirror taking precedence.
   * @returns {Array<Object>}
   */
  getActiveMirrorRegions() {
    if (this.mirror) {
      return this._expandMirrorRegionTransforms({
        id: '__global_mirror__',
        x: 0,
        y: 0,
        width: this.getWidth(),
        height: this.getHeight(),
        mode: 'vertical',
        showLine: true,
        synthetic: true
      });
    }
    return this.mirrorRegions.flatMap(region => this._expandMirrorRegionTransforms(region));
  }

  /**
   * Returns true when any mirror source is active.
   * @returns {boolean}
   */
  hasMirrors() {
    return this.getActiveMirrorRegions().length > 0;
  }

  /**
   * Mirrors a single point inside a region.
   * @param {{x:number,y:number}} point
   * @param {Object} region
   * @returns {{x:number,y:number}}
   */
  mirrorPointToRegion(point, region) {
    if (!region || !point) return point;
    const centerX = region.x + (region.width / 2);
    const centerY = region.y + (region.height / 2);
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const transform = region.transform || region.mode || region.axis;

    if (transform === 'rotateCustom') {
      const angle = Number(region.rotationAngle || 0);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return {
        x: centerX + (dx * cos) - (dy * sin),
        y: centerY + (dx * sin) + (dy * cos)
      };
    }

    if (transform === 'fibStep') {
      const invPHI = 0.6180339887;
      const step = region.fibStep || 1;
      
      // Fixed point (eye) of the golden spiral in a rectangle [0, w]x[0, h]
      // with the first square on the left and the second on top-right.
      const eyeX = region.x + region.width * invPHI;
      const eyeY = region.y + region.height * invPHI;
      
      const angle = step * (Math.PI / 2); // 90 degrees clockwise per step
      const scale = Math.pow(invPHI, step);
      
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = point.x - eyeX;
      const dy = point.y - eyeY;
      
      const rdx = dx * cos - dy * sin;
      const rdy = dx * sin + dy * cos;
      
      return {
        x: eyeX + rdx * scale,
        y: eyeY + rdy * scale
      };
    }

    switch (transform) {
      case 'horizontal':
      case 'flipY':
        return { x: point.x, y: (centerY * 2) - point.y };
      case 'vertical':
      case 'flipX':
        return { x: (centerX * 2) - point.x, y: point.y };
      case 'flipXY':
        return { x: (centerX * 2) - point.x, y: (centerY * 2) - point.y };
      case 'rotate90':
        return { x: centerX - dy, y: centerY + dx };
      case 'rotate180':
        return { x: (centerX * 2) - point.x, y: (centerY * 2) - point.y };
      case 'rotate270':
        return { x: centerX + dy, y: centerY - dx };
      default:
        return { x: (centerX * 2) - point.x, y: point.y };
    }
  }

  /**
   * Mirrors an array of points inside a region.
   * @param {Array<{x:number,y:number}>} points
   * @param {Object} region
   * @returns {Array<{x:number,y:number}>}
   */
  mirrorPointsToRegion(points, region) {
    if (!Array.isArray(points)) return [];
    return points.map(point => this.mirrorPointToRegion(point, region));
  }

  /**
   * Clips drawing operations to a mirror region.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} region
   * @param {Function} drawFn
   */
  withMirrorRegionClip(ctx, region, drawFn) {
    if (!ctx || !region || typeof drawFn !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    drawFn();
    ctx.restore();
  }

  /**
   * Runs drawing code in a mirror-region-local transformed coordinate space.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} region
   * @param {Function} drawFn
   */
  withMirroredRegionTransform(ctx, region, drawFn) {
    if (!ctx || !region || typeof drawFn !== 'function') return;
    this.withMirrorRegionClip(ctx, region, () => {
      ctx.save();
      const centerX = region.x + (region.width / 2);
      const centerY = region.y + (region.height / 2);
      const transform = region.transform || region.mode || region.axis;
      switch (transform) {
        case 'horizontal':
        case 'flipY':
          ctx.translate(0, centerY * 2);
          ctx.scale(1, -1);
          break;
        case 'vertical':
        case 'flipX':
          ctx.translate(centerX * 2, 0);
          ctx.scale(-1, 1);
          break;
        case 'flipXY':
        case 'rotate180':
          ctx.translate(centerX * 2, centerY * 2);
          ctx.scale(-1, -1);
          break;
        case 'rotate90':
          ctx.translate(centerX, centerY);
          ctx.rotate(Math.PI / 2);
          ctx.translate(-centerX, -centerY);
          break;
        case 'rotate270':
          ctx.translate(centerX, centerY);
          ctx.rotate(-Math.PI / 2);
          ctx.translate(-centerX, -centerY);
          break;
        case 'rotateCustom':
          ctx.translate(centerX, centerY);
          ctx.rotate(Number(region.rotationAngle || 0));
          ctx.translate(-centerX, -centerY);
          break;
        case 'fibStep':
          const invPHI = 0.6180339887;
          const step = region.fibStep || 1;
          const eyeX = region.x + region.width * invPHI;
          const eyeY = region.y + region.height * invPHI;
          const angle = step * (Math.PI / 2);
          const scale = Math.pow(invPHI, step);
          ctx.translate(eyeX, eyeY);
          ctx.rotate(angle);
          ctx.scale(scale, scale);
          ctx.translate(-eyeX, -eyeY);
          break;
        default:
          ctx.translate(centerX * 2, 0);
          ctx.scale(-1, 1);
          break;
      }
      drawFn();
      ctx.restore();
    });
  }

  /**
   * Draws a source canvas mirrored into a mirror region.
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} sourceCanvas
   * @param {Object} region
   * @param {number} [x=0]
   * @param {number} [y=0]
   */
  drawMirroredCanvas(ctx, sourceCanvas, region, x = 0, y = 0) {
    if (!ctx || !sourceCanvas || !region) return;
    this.withMirroredRegionTransform(ctx, region, () => {
      ctx.drawImage(sourceCanvas, x, y);
    });
  }

  /**
   * Iterates active mirror regions intersecting a target geometry.
   * @param {Object|null} target
   * @param {(region: Object) => void} callback
   */
  forEachMirrorRegion(target, callback) {
    if (typeof callback !== 'function') return;
    const bounds = this._getMirrorTargetBounds(target);
    for (const region of this.getActiveMirrorRegions()) {
      if (!bounds || this._rectIntersects(bounds, region)) {
        callback(region);
      }
    }
  }

  /**
   * Renders the persistent mirror region overlays.
   */
  renderMirrorRegions() {
    if (!this.mirrorRegionsCtx || !this.mirrorRegionsLayer) return;
    this.mirrorRegionsCtx.clearRect(0, 0, this.mirrorRegionsLayer.width, this.mirrorRegionsLayer.height);

    for (const region of this.mirrorRegions) {
      this.mirrorRegionsCtx.save();
      this.mirrorRegionsCtx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
      this.mirrorRegionsCtx.lineWidth = 1;
      this.mirrorRegionsCtx.strokeRect(region.x, region.y, region.width, region.height);

      if (region.showLine) {
        this.mirrorRegionsCtx.setLineDash([4, 4]);
        this.mirrorRegionsCtx.lineWidth = 0.75;
        this.mirrorRegionsCtx.strokeStyle = 'rgba(0, 212, 170, 0.85)';
        Board.drawMirrorGuide(this.mirrorRegionsCtx, region);
      }
      this.mirrorRegionsCtx.restore();
    }
  }

  /**
   * Shared helper for drawing mirror mode guides.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} region
   */
  static drawMirrorGuide(ctx, region) {
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    const axis = region.mode || region.axis || 'vertical';

    ctx.save();
    if (axis === 'horizontal') {
      ctx.beginPath();
      ctx.moveTo(region.x, cy);
      ctx.lineTo(region.x + region.width, cy);
      ctx.stroke();
    } else if (axis === 'vertical') {
      ctx.beginPath();
      ctx.moveTo(cx, region.y);
      ctx.lineTo(cx, region.y + region.height);
      ctx.stroke();
    } else if (axis === 'radial') {
      const radius = Math.max(region.width, region.height) / 2;
      const slices = region.slices || 6;
      ctx.beginPath();
      for (let step = 0; step < slices; step += 1) {
        const angle = ((Math.PI * 2) / slices) * step - (Math.PI / 2);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      }
      ctx.stroke();
    } else if (axis === 'fib') {
      const depth = region.fibDepth || 4;
      const previewDepth = 8;
      const invPHI = 0.6180339887;
      const fibAngleOffset = Math.PI;
      const eyeX = region.x + region.width * invPHI;
      const eyeY = region.y + region.height * invPHI;

      // Always draw the guide rectangle from the exact selected region bounds.
      ctx.strokeRect(region.x, region.y, region.width, region.height);

      // Keep all Fibonacci preview geometry hard-clipped to the selected region.
      ctx.save();
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.clip();

      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.15;
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.9)';
      ctx.beginPath();
      const startX = region.x;
      const startY = region.y + region.height;
      const startDx = startX - eyeX;
      const startDy = startY - eyeY;
      const offsetCos = Math.cos(fibAngleOffset);
      const offsetSin = Math.sin(fibAngleOffset);
      // Phase-compensate the start vector so t=0 remains anchored at bottom-left.
      const baseDx = (startDx * offsetCos) + (startDy * offsetSin);
      const baseDy = (-startDx * offsetSin) + (startDy * offsetCos);
      const steps = Math.max(20, previewDepth * 48);
      for (let i = 0; i <= steps; i += 1) {
        const t = (previewDepth * i) / steps;
        const angle = fibAngleOffset + (t * (Math.PI / 2));
        const scale = Math.pow(invPHI, t);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const x = eyeX + ((baseDx * cos) - (baseDy * sin)) * scale;
        const y = eyeY + ((baseDx * sin) + (baseDy * cos)) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    } else {
      // Quad / Rotational
      ctx.beginPath();
      ctx.moveTo(region.x, cy);
      ctx.lineTo(region.x + region.width, cy);
      ctx.moveTo(cx, region.y);
      ctx.lineTo(cx, region.y + region.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderInteractionBlocks() {
    if (!this.interactionBlockCtx || !this.interactionBlockOverlay) return;

    const pad = this.interactionBlockOverlayPadding;
    const [height, width] = this.dimensions;
    this.interactionBlockCtx.clearRect(0, 0, width + pad * 2, height + pad * 2);

    if (this.interactionBlocks.length === 0) return;

    this.interactionBlockCtx.save();
    this.interactionBlockCtx.translate(pad, pad);

    for (const block of this.interactionBlocks) {
      this.interactionBlockCtx.save();
      this._traceInteractionBlockPath(this.interactionBlockCtx, block);
      this.interactionBlockCtx.fillStyle = 'rgba(34, 34, 34, 0.14)';
      this.interactionBlockCtx.fill();

      this.interactionBlockCtx.lineWidth = 1;
      this.interactionBlockCtx.setLineDash([4, 4]);
      this.interactionBlockCtx.strokeStyle = '#000';
      this.interactionBlockCtx.lineDashOffset = -this.interactionBlockDashOffset;
      this.interactionBlockCtx.stroke();

      this.interactionBlockCtx.strokeStyle = '#fff';
      this.interactionBlockCtx.lineDashOffset = -this.interactionBlockDashOffset + 4;
      this.interactionBlockCtx.stroke();
      this.interactionBlockCtx.restore();
    }

    this.interactionBlockCtx.restore();
  }

  _normalizeMirrorRegion(region) {
    if (!region) return null;
    const x = Math.floor(Number(region.x));
    const y = Math.floor(Number(region.y));
    const width = Math.floor(Number(region.width));
    const height = Math.floor(Number(region.height));

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    return {
      id: String(region.id || `mr_${x}_${y}_${width}_${height}`),
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(1, width),
      height: Math.max(1, height),
      mode: this._normalizeMirrorMode(region.mode || region.axis),
      axis: this._normalizeMirrorMode(region.mode || region.axis),
      slices: this._normalizeMirrorSlices(region.slices),
      fibDepth: this._normalizeFibDepth(region.fibDepth),
      showLine: region.showLine !== false,
      owner: region.owner || region.createdBy || null
    };
  }

  _normalizeInteractionBlock(region) {
    if (!region) return null;

    const id = String(region.id || `ib_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const type = region.type === 'lasso' ? 'lasso' : 'rect';

    if (type === 'lasso') {
      const points = Array.isArray(region.points)
        ? region.points
          .map(point => ({
            x: Math.floor(Number(point?.x)),
            y: Math.floor(Number(point?.y))
          }))
          .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
        : [];

      if (points.length < 3) return null;

      let minX = points[0].x;
      let minY = points[0].y;
      let maxX = points[0].x;
      let maxY = points[0].y;
      for (const point of points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }

      return {
        id,
        type,
        points,
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY)
      };
    }

    const x = Math.floor(Number(region.x));
    const y = Math.floor(Number(region.y));
    const width = Math.floor(Number(region.width));
    const height = Math.floor(Number(region.height));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    return {
      id,
      type,
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.max(1, width),
      height: Math.max(1, height)
    };
  }

  _traceInteractionBlockPath(ctx, block) {
    ctx.beginPath();
    if (block.type === 'lasso' && block.points?.length >= 3) {
      ctx.moveTo(block.points[0].x, block.points[0].y);
      for (let i = 1; i < block.points.length; i++) {
        ctx.lineTo(block.points[i].x, block.points[i].y);
      }
      ctx.closePath();
      return;
    }

    ctx.rect(block.x, block.y, block.width, block.height);
  }

  _updateInteractionBlockAnimation() {
    if (this.interactionBlocks.length > 0) {
      if (this.interactionBlockAnimationId !== null) return;
      const tick = () => {
        if (this.interactionBlocks.length === 0) {
          this.interactionBlockAnimationId = null;
          return;
        }
        this.interactionBlockDashOffset = (this.interactionBlockDashOffset + 1) % 8;
        this.renderInteractionBlocks();
        this.interactionBlockAnimationId = requestAnimationFrame(tick);
      };
      this.interactionBlockAnimationId = requestAnimationFrame(tick);
      return;
    }

    if (this.interactionBlockAnimationId !== null) {
      cancelAnimationFrame(this.interactionBlockAnimationId);
      this.interactionBlockAnimationId = null;
    }
    this.interactionBlockDashOffset = 0;
  }

  _pointInInteractionBlock(point, block) {
    if (!this._rectIntersects(
      { x: point.x, y: point.y, width: 1, height: 1 },
      { x: block.x, y: block.y, width: block.width, height: block.height }
    )) {
      return false;
    }

    if (block.type !== 'lasso') {
      return point.x >= block.x
        && point.x <= block.x + block.width
        && point.y >= block.y
        && point.y <= block.y + block.height;
    }

    let inside = false;
    const points = block.points || [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      const intersects = ((yi > point.y) !== (yj > point.y))
        && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  _segmentIntersectsInteractionBlock(start, end, block) {
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);

    if (!this._rectIntersects(
      { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
      { x: block.x, y: block.y, width: block.width, height: block.height }
    )) {
      return false;
    }

    if (this._pointInInteractionBlock(start, block) || this._pointInInteractionBlock(end, block)) {
      return true;
    }

    if (block.type === 'lasso' && block.points?.length >= 3) {
      for (let i = 0; i < block.points.length; i++) {
        const a = block.points[i];
        const b = block.points[(i + 1) % block.points.length];
        if (this._segmentsIntersect(start, end, a, b)) return true;
      }
      return false;
    }

    const corners = [
      { x: block.x, y: block.y },
      { x: block.x + block.width, y: block.y },
      { x: block.x + block.width, y: block.y + block.height },
      { x: block.x, y: block.y + block.height }
    ];
    for (let i = 0; i < corners.length; i++) {
      if (this._segmentsIntersect(start, end, corners[i], corners[(i + 1) % corners.length])) {
        return true;
      }
    }

    return false;
  }

  _segmentsIntersect(a, b, c, d) {
    const orientation = (p, q, r) => {
      const value = ((q.y - p.y) * (r.x - q.x)) - ((q.x - p.x) * (r.y - q.y));
      if (Math.abs(value) < 0.0001) return 0;
      return value > 0 ? 1 : 2;
    };

    const onSegment = (p, q, r) => (
      q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x)
      && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
    );

    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(a, c, b)) return true;
    if (o2 === 0 && onSegment(a, d, b)) return true;
    if (o3 === 0 && onSegment(c, a, d)) return true;
    if (o4 === 0 && onSegment(c, b, d)) return true;
    return false;
  }

  _normalizeMirrorMode(mode) {
    return ['horizontal', 'quad', 'rotational', 'radial', 'fib'].includes(mode) ? mode : 'vertical';
  }

  _normalizeMirrorSlices(slices) {
    const parsed = Math.floor(Number(slices));
    if (!Number.isFinite(parsed)) return 6;
    return Math.max(3, Math.min(16, parsed));
  }

  _normalizeFibDepth(depth) {
    const parsed = Math.floor(Number(depth));
    if (!Number.isFinite(parsed)) return 4;
    return Math.max(1, Math.min(8, parsed));
  }

  _expandMirrorRegionTransforms(region) {
    if (!region) return [];

    const baseRegion = {
      ...region,
      mode: this._normalizeMirrorMode(region.mode || region.axis),
      slices: this._normalizeMirrorSlices(region.slices)
    };

    const transformsByMode = {
      vertical: ['flipX'],
      horizontal: ['flipY'],
      quad: ['flipX', 'flipY', 'flipXY'],
      rotational: ['rotate180']
    };

    if (baseRegion.mode === 'radial') {
      const transforms = [];
      for (let step = 1; step < baseRegion.slices; step += 1) {
        const rotationAngle = (Math.PI * 2 * step) / baseRegion.slices;
        transforms.push({
          ...baseRegion,
          transform: 'rotateCustom',
          rotationAngle,
          rotationStep: step,
          synthetic: true,
          id: `${baseRegion.id}_radial_${step}`
        });
      }
      return transforms;
    }

    if (baseRegion.mode === 'fib') {
      const transforms = [];
      const depth = baseRegion.fibDepth || 4;
      for (let step = 1; step <= depth; step += 1) {
        transforms.push({
          ...baseRegion,
          transform: 'fibStep',
          fibStep: step,
          synthetic: true,
          id: `${baseRegion.id}_fib_${step}`
        });
      }
      return transforms;
    }

    return (transformsByMode[baseRegion.mode] || transformsByMode.vertical).map(transform => ({
      ...baseRegion,
      transform,
      synthetic: true,
      id: `${baseRegion.id}_${transform}`
    }));
  }

  _appendMirrorRegionGuide(regionEl, region) {
    const addLine = (styles) => {
      const lineEl = document.createElement('div');
      lineEl.className = 'mirror-region-line';
      lineEl.style.position = 'absolute';
      Object.assign(lineEl.style, styles);
      regionEl.appendChild(lineEl);
    };

    const horizontalStyles = {
      left: '0',
      right: '0',
      top: `${region.height / 2}px`,
      height: '0',
      borderTop: '1px dashed rgba(0, 212, 170, 0.85)',
      transform: 'translateY(-0.5px) scaleY(0.8)',
      transformOrigin: 'center'
    };
    const verticalStyles = {
      top: '0',
      bottom: '0',
      left: `${region.width / 2}px`,
      width: '0',
      borderLeft: '1px dashed rgba(0, 212, 170, 0.85)',
      transform: 'translateX(-0.5px) scaleX(0.8)',
      transformOrigin: 'center'
    };

    switch (region.mode) {
      case 'horizontal':
        addLine(horizontalStyles);
        break;
      case 'radial': {
        const cx = region.width / 2;
        const cy = region.height / 2;
        const radius = Math.max(region.width, region.height) / 2;
        for (let step = 0; step < region.slices; step += 1) {
          const angle = ((Math.PI * 2) / region.slices) * step - (Math.PI / 2);
          addLine({
            left: `${cx}px`,
            top: `${cy}px`,
            width: `${radius}px`,
            height: '0',
            borderTop: '1px dashed rgba(0, 212, 170, 0.85)',
            transformOrigin: '0 0',
            transform: `rotate(${angle}rad) scaleX(0.8)`
          });
        }
        break;
      }
      case 'quad':
      case 'rotational':
        addLine(horizontalStyles);
        addLine(verticalStyles);
        break;
      default:
        addLine(verticalStyles);
        break;
    }
  }

  _getMirrorTargetBounds(target) {
    if (!target) return null;

    if (target.rect) return target.rect;

    if (target.point) {
      return { x: target.point.x, y: target.point.y, width: 0, height: 0 };
    }

    if (Array.isArray(target.points) && target.points.length > 0) {
      let minX = target.points[0].x;
      let minY = target.points[0].y;
      let maxX = target.points[0].x;
      let maxY = target.points[0].y;

      for (const point of target.points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }

      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      };
    }

    return null;
  }

  _rectIntersects(a, b) {
    return (
      a.x <= b.x + b.width &&
      a.x + a.width >= b.x &&
      a.y <= b.y + b.height &&
      a.y + a.height >= b.y
    );
  }

  /**
   * Resize the board to new dimensions, preserving existing layer content at top-left.
   * @param {[number, number]} newDimensions - [height, width]
   */
  resizeBoard(newDimensions) {
    // Capture each layer before dimensions change so we can restore at (0,0)
    const snapshots = this.layerManager ? this.getSnapshot() : null;
    const [oldH, oldW] = this.dimensions;

    this.dimensions = newDimensions;
    const [height, width] = this.dimensions;

    this._createLayerManager();
    this.compositeTileGrid = new CompositeTileGrid(width, height, 32);
    this.tileTracker = new TileTracker(width, height);
    this.setupCanvas();

    if (snapshots?.length) {
      for (let i = 0; i < snapshots.length && i < this.layerManager.layerGroups.length; i++) {
        const qoi = snapshots[i];
        if (!qoi || qoi.length === 0) continue;
        const pixels = wasm.qoi_decode(qoi);
        if (!pixels || pixels.length === 0) continue;
        const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), oldW, oldH);
        this.layerManager.addToBaseBin(i, this._createCanvasFromImageData(imageData), 0, 0);
      }
      this.markCompositeFull();
      this.compositeAllLayers();
    }

    this.resetView();
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
      this.markCompositeFull();
      this.compositeAllLayers();
    } else {
      this.mainCtx.clearRect(0, 0, width, height);
    }

    this.compositeTileGrid?.clear?.();

    // Clear tile tracker when board is cleared
    if (this.tileTracker) {
      this.tileTracker.clear();
    }

    this.topCtx.clearRect(0, 0, width, height);
  }

  rebuildRenderingState(options = {}) {
    const preserveSnapshot = options.preserveSnapshot === true;
    const layerSnapshot = preserveSnapshot ? this.getSnapshot() : null;
    const previousLayerManager = this.layerManager;

    previousLayerManager?.destroy?.();
    this._createLayerManager(previousLayerManager);

    this.activeSelectionLayer = -1;
    this.mainCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
    this.clearTop();
    this.clearSelectionOverlay();
    if (this.upperLayersCtx) {
      this.upperLayersCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
    }
    this._upperLayersCompositeStart = null;
    this._mainCompositeEnd = null;
    this.markCompositeFull();
    this.tileTracker?.clear?.();

    if (layerSnapshot?.length) {
      this.restoreSnapshot(layerSnapshot);
    } else {
      this.layerManager.needsComposite = true;
      this.compositeAllLayers();
    }
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
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    if (!this.layerManager?.getLayerAllowComplexBlendModes(activeLayer)) {
      return 'source-over';
    }
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
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode, this.app?.self?.blendBakeMode);
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
      this.layerManager.beginUserStroke(activeLayer, userId, blendMode, user?.blendBakeMode);
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
    this._compositeCommittedStrokeNow();
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
    // Blur/glitch blur tools always create their stroke on layer 0
    const isBlurFilter = extraProps.filterType === 'blur' || extraProps.filterType === 'glitchBlur';
    const activeLayer = isBlurFilter ? 0 : (user?.activeLayer ?? this.app?.self?.activeLayer ?? 0);
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    if (!this.layerManager) return;

    // Keep localUserId current so LayerManager can distinguish local vs remote strokes
    this.layerManager.localUserId = this.app?.self?.id ?? null;

    // Get affected tiles before committing (for broadcasting local user's tiles)
    // Skip for erasers - they use TILE_CLEAR instead of TILE_UPDATE
    let tilesToBroadcast = null;
    const isLocalUser = userId === this.app?.self?.id;
    const active = this.layerManager.getActiveStroke(activeLayer, userId);
    if (isLocalUser && this.app?.wsClient && this.app?.connected) {
      if (active?.affectedTiles?.size > 0 && active.blendMode !== 'destination-out') {
        tilesToBroadcast = Array.from(active.affectedTiles);
      }
    }
    if (active?.dirtyRect && active.dirtyRect.maxX !== -1) {
      this.compositeTileGrid?.markRect(
        active.dirtyRect.minX,
        active.dirtyRect.minY,
        active.dirtyRect.maxX - active.dirtyRect.minX + 1,
        active.dirtyRect.maxY - active.dirtyRect.minY + 1
      );
    }

    if (extraProps.filterType === 'glitchBlur') {
      extraProps.mirrorRegions = this.getActiveMirrorRegions().map(region => ({ ...region }));
    }

    this.layerManager.commitUserStroke(activeLayer, userId, extraProps);
    this._compositeCommittedStrokeNow();

    // Broadcast tile ownership update for local user
    if (tilesToBroadcast && tilesToBroadcast.length > 0) {
      this.app.wsClient.broadcastTileUpdate(tilesToBroadcast);
    }
  }

  _compositeCommittedStrokeNow() {
    this._needsComposite = false;
    this._lastCompositeTime = performance.now();
    this.compositeAllLayers();
  }

  /**
   * Commits all active strokes for an AFK user with delays to avoid lag.
   * Processes one layer at a time with 50ms delays between each.
   * @param {number} userId - User ID to commit strokes for
   * @returns {Promise<void>}
   */
  async commitAllUserStrokesForAFKUser(userId) {
    if (!this.layerManager) return;

    const gen = this.layerManager.commitAllUserStrokesGenerator(userId);
    const DELAY_MS = 50;

    for (const groupIdx of gen) {
      // Composite after each layer commit
      this.compositeAllLayers();
      // Wait before processing next layer to avoid sudden lag
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  /**
   * Called when the local user's glitch blur WASM computation completes.
   * Converts the result to a data URL and broadcasts it to other clients.
   * @param {Object} result - { userId, x, y, width, height, canvas }
   * @private
   */
  _handleGlitchBlurReady(result) {
    if (!this.app?.wsClient || !this.app?.connected) return;
    const dataUrl = result.canvas.toDataURL('image/png');
    this.app.wsClient.broadcastGlitchResult(result.x, result.y, result.width, result.height, dataUrl);
  }

  markCompositeFull() {
    this.compositeTileGrid?.markFull?.();
  }

  _markBatchDirtyRects(batch) {
    const pad = 2;
    let marked = false;
    for (const { record } of batch) {
      if (record.x != null && record.y != null && record.width > 0 && record.height > 0) {
        this.compositeTileGrid?.markRect(
          record.x - pad, record.y - pad,
          record.width + pad * 2, record.height + pad * 2
        );
        marked = true;
      }
    }
    if (!marked) {
      this.markCompositeFull();
    }
  }

  _markSelectionRestoreDirtyRects(restoreData) {
    if (!restoreData) return;
    const { snapshots, eraseS } = restoreData;
    if (eraseS) {
      this.compositeTileGrid?.markRect(eraseS.x, eraseS.y, eraseS.width, eraseS.height);
    }
    if (snapshots) {
      for (const { canvas, x, y } of snapshots) {
        if (canvas) {
          this.compositeTileGrid?.markRect(x, y, canvas.width, canvas.height);
        }
      }
    }
  }

  _applyCompositeClip(ctx, dirtyRects) {
    if (!ctx || !dirtyRects || dirtyRects.length === 0) return false;
    ctx.save();
    ctx.beginPath();
    for (const rect of dirtyRects) {
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
    }
    ctx.clip();
    return true;
  }

  _clearCompositeContext(ctx, dirtyRects) {
    if (!ctx) return;
    if (dirtyRects && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
      }
      return;
    }
    ctx.clearRect(0, 0, this.getWidth(), this.getHeight());
  }

  _fillCompositeContext(ctx, dirtyRects) {
    if (!ctx) return;
    if (dirtyRects && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
      return;
    }
    ctx.fillRect(0, 0, this.getWidth(), this.getHeight());
  }

  _getEraserPreviewBuffer() {
    const w = this.getWidth();
    const h = this.getHeight();
    if (!this._eraserPreviewCanvas || this._eraserPreviewCanvas.width !== w || this._eraserPreviewCanvas.height !== h) {
      this._eraserPreviewCanvas = document.createElement('canvas');
      this._eraserPreviewCanvas.width = w;
      this._eraserPreviewCanvas.height = h;
      this._eraserPreviewCtx = this._eraserPreviewCanvas.getContext('2d');
    }
    return { canvas: this._eraserPreviewCanvas, ctx: this._eraserPreviewCtx };
  }

  _applyEraserPreviewToMain(splitLayer, dirtyRects, userId = this.app?.self?.id ?? 0, maskCanvas = this.topCanvas, opacity = 1.0) {
    const { canvas: tempCanvas, ctx: tempCtx } = this._getEraserPreviewBuffer();

    this._clearCompositeContext(tempCtx, dirtyRects);
    this.layerManager.compositeLayerWithoutActiveStroke(tempCtx, splitLayer, userId, null, dirtyRects);

    if (splitLayer === 0) {
      this._clearCompositeContext(this.mainCtx, dirtyRects);
      const [r, g, b, a] = this.getCompositeBackgroundColor();
      this.mainCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      this._fillCompositeContext(this.mainCtx, dirtyRects);
    } else {
      this.layerManager.compositeLayerRange(this.mainCtx, 0, splitLayer, this.getCompositeBackgroundColor(), dirtyRects);
    }

    if (maskCanvas) {
      tempCtx.save();
      tempCtx.globalCompositeOperation = 'destination-out';
      tempCtx.globalAlpha = opacity;
      this._drawCompositeCanvas(tempCtx, maskCanvas, dirtyRects);
      tempCtx.restore();
    }

    this.mainCtx.globalCompositeOperation = 'source-over';
    this.mainCtx.globalAlpha = 1.0;
    this._drawCompositeCanvas(this.mainCtx, tempCanvas, dirtyRects);
  }

  _drawCompositeCanvas(ctx, canvas, dirtyRects) {
    if (!ctx || !canvas) return;
    if (dirtyRects && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        const sourceRect = this._clampRectToCanvas(rect, canvas);
        if (!sourceRect) continue;
        ctx.drawImage(
          canvas,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height
        );
      }
      return;
    }

    const clipped = this._applyCompositeClip(ctx, dirtyRects);
    ctx.drawImage(canvas, 0, 0);
    if (clipped) {
      ctx.restore();
    }
  }

  _compositeUpperLayers(startIdx, endIdx, dirtyRects) {
    if (!this.upperLayersCtx) return;
    this.layerManager.compositeLayerRange(
      this.upperLayersCtx,
      startIdx,
      endIdx,
      null,
      null
    );
    this._upperLayersCompositeStart = startIdx;
  }

  _clearUpperLayers(dirtyRects) {
    if (!this.upperLayersCtx) return;
    if (this._upperLayersCompositeStart !== null) {
      this._clearCompositeContext(this.upperLayersCtx, null);
    } else {
      this._clearCompositeContext(this.upperLayersCtx, dirtyRects);
    }
    this._upperLayersCompositeStart = null;
  }

  _getSplitMainDirtyRects(endIdx, dirtyRects) {
    if (this._mainCompositeEnd !== endIdx) {
      this._mainCompositeEnd = endIdx;
      return null;
    }
    return dirtyRects;
  }

  _getFullMainDirtyRects(dirtyRects) {
    const needsFullRedraw = this._mainCompositeEnd !== null;
    this._mainCompositeEnd = null;
    return needsFullRedraw ? null : dirtyRects;
  }

  _findActiveEraserPreview() {
    const layerCount = this.layerManager?.getLayerCount?.() ?? 0;
    const localUserId = this.app?.self?.id;

    for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
      const group = this.layerManager.getLayerGroup(layerIndex);
      if (!group?.activeStrokeByUser) continue;

      for (const [userId, active] of group.activeStrokeByUser.entries()) {
        if (active?.blendMode !== 'destination-out') continue;

        const user = this.app?.users?.get?.(userId);
        if (user?.tool && user.tool !== 'erase') continue;
        if (user?.eraseAllLayers) continue;

        const maskCanvas = userId === localUserId
          ? this.topCanvas
          : user?.context?.canvas;

        if (!maskCanvas) continue;

        return {
          layerIndex,
          userId,
          maskCanvas,
          opacity: user?.opacity ?? active.opacity ?? 1.0
        };
      }
    }

    return null;
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
   * Expand the dirty rectangle for a user's active stroke so the stroke
   * bake step can crop to a tight content bound.
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
    this.compositeTileGrid?.markRect(x, y, width, height);
  }

  /**
   * Expand per-stroke bounds along a path and mark occupied tiles for sync.
   */
  markDirtyPath(user, points, radius, isErase = false) {
    if (!this.layerManager || !points || points.length === 0) return;

    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    if (active?.dirtyRect) {
      for (const pt of points) {
        const x = pt.x - radius;
        const y = pt.y - radius;
        const size = radius * 2;
        this.layerManager._expandDirtyRect(active.dirtyRect, x, y, size, size);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + size > maxX) maxX = x + size;
        if (y + size > maxY) maxY = y + size;
      }
    }
    if (maxX > minX && maxY > minY) {
      this.compositeTileGrid?.markRect(minX, minY, maxX - minX, maxY - minY);
    }
  }

  /**
   * Expand per-stroke bounds for all layers' active strokes for a user.
   */
  expandDirtyRectAllLayers(user, x, y, width, height) {
    if (!this.layerManager) return;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const group = this.layerManager.layerGroups[i];
      if (!group) continue;
      const active = group.activeStrokeByUser.get(userId);
      if (!active || !active.dirtyRect) continue;
      this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    }
    this.compositeTileGrid?.markRect(x, y, width, height);
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
    if (!this.layerManager) return null;
    const batch = this.layerManager.undoLastStrokeGlobal(userId);
    let tilesToRecheck = null;
    let needsFullRedraw = false;

    if (batch) {
      this.layerManager._pushToRedoStack(userId, batch);
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          const rd = record.selectionRestoreData;
          // If the paired lift erase is still live in stroke history, removing it is
          // enough to reveal the original pixels again. Only paint the saved snapshot
          // back when that erase has already been baked into base bins/sequences.
          const removedLiveErase = rd.eraseTimestamp !== undefined
            ? this._takeSelectionEraseStroke(rd.eraseUserId ?? userId, rd.eraseTimestamp)
            : null;
          if (removedLiveErase) {
            rd._redoEraseRecord = removedLiveErase;
          } else {
            this._applySelectionRestore(rd.snapshots);
          }
          this._markSelectionRestoreDirtyRects(rd);
          break;
        }
        if (record.affectedTiles) {
          if (!tilesToRecheck) tilesToRecheck = new Set();
          for (const idx of record.affectedTiles) tilesToRecheck.add(idx);
        }
      }
    }

    if (!batch) {
      return null;
    }
    this._markBatchDirtyRects(batch);
    this.compositeAllLayers();

    if (tilesToRecheck && this.tileTracker) {
      this.checkErasedTilesByIndices(tilesToRecheck, userId === this.app?.self?.id);
    }

    return batch;
  }

  /** No-op: occupancy tracking has been disabled. */
  addOccupancyForTilesInRect() {}

  /** No-op: occupancy tracking has been disabled. */
  addOccupancyForVisibleTilesInRect() {}

  /**
   * Redo the most recently undone stroke batch for userId.
   * @param {number} userId - User ID
   */
  redo(userId) {
    if (!this.layerManager) return;
    const redoStack = this.layerManager.redoStackByUser.get(userId);
    let tilesToRecheck = null;
    let needsFullRedraw = false;
    let batch = null;

    if (redoStack && redoStack.length > 0) {
      batch = redoStack[redoStack.length - 1];
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          const rd = record.selectionRestoreData;
          if (rd._redoEraseRecord) {
            this._restoreSelectionEraseStroke(rd._redoEraseRecord);
            rd._redoEraseRecord = null;
          } else {
            this._applySelectionReErase(rd);
          }
          this._markSelectionRestoreDirtyRects(rd);
          break;
        }
        if (record.affectedTiles) {
          if (!tilesToRecheck) tilesToRecheck = new Set();
          for (const idx of record.affectedTiles) tilesToRecheck.add(idx);
        }
      }
    }
    this.layerManager.redoLastStroke(userId);

    if (!batch) {
      return;
    }
    this._markBatchDirtyRects(batch);
    this.compositeAllLayers();

    if (tilesToRecheck && this.tileTracker) {
      this.checkErasedTilesByIndices(tilesToRecheck, userId === this.app?.self?.id);
    }
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
   * Remove the destination-out erase stroke that was paired with a selection commit,
   * identified by userId + timestamp. Called during undo so the restored pixels aren't
   * immediately re-erased by the lingering erase stroke.
   * @param {number} userId - User ID
   * @param {number} eraseTimestamp - Timestamp of the erase stroke to remove
   * @private
   */
  _takeSelectionEraseStroke(userId, eraseTimestamp) {
    const lm = this.layerManager;
    for (let groupIdx = 0; groupIdx < lm.layerGroups.length; groupIdx++) {
      const group = lm.layerGroups[groupIdx];
      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        const s = group.strokeStack[i];
        if (s.userId === userId && s.timestamp === eraseTimestamp && s.isSelectionErase) {
          group.strokeStack.splice(i, 1);
          const cnt = group.userStrokeCounts.get(userId) || 0;
          if (cnt > 0) group.userStrokeCounts.set(userId, cnt - 1);
          return { groupIdx, record: s };
        }
      }
    }
    return null;
  }

  _restoreSelectionEraseStroke(eraseStrokeEntry) {
    const lm = this.layerManager;
    const group = lm?.layerGroups?.[eraseStrokeEntry?.groupIdx];
    const record = eraseStrokeEntry?.record;
    if (!group || !record) return false;

    let insertIdx = group.strokeStack.length;
    for (let i = 0; i < group.strokeStack.length; i++) {
      if (group.strokeStack[i].timestamp > record.timestamp) {
        insertIdx = i;
        break;
      }
    }
    group.strokeStack.splice(insertIdx, 0, record);
    const cnt = group.userStrokeCounts.get(record.userId) || 0;
    group.userStrokeCounts.set(record.userId, cnt + 1);
    return true;
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

    const activeLayerIdx = this.app?.self?.activeLayer ?? 0;
    const userId = this.app?.self?.id ?? 0;
    const totalLayers = this.layerManager.getLayerCount();
    const activeGroup = this.layerManager.getLayerGroup(activeLayerIdx);
    const isDrawing = activeGroup?.activeStrokeByUser?.has(userId) ?? false;
    const activeTool = this.app?.activeTool ?? this.app?.self?.tool;
    const isEraser = activeTool === 'erase';
    const eraseAll = isEraser && (this.app?.eraseAllLayers ?? false);
    const pendingDirtyRects = this.compositeTileGrid?.consumeDirtyRects?.() ?? null;
    const activeEraserPreview = this._findActiveEraserPreview();

    const hasActiveSelection = this.activeSelectionLayer >= 0;
    const splitLayer = hasActiveSelection ? this.activeSelectionLayer : (activeEraserPreview?.layerIndex ?? activeLayerIdx);
    const dirtyRects = Array.isArray(pendingDirtyRects) && pendingDirtyRects.length > 0
      ? pendingDirtyRects
      : null;

    if (this.onCompositeDirtyRects) {
      const isFullRedraw = pendingDirtyRects === null;
      this.onCompositeDirtyRects(dirtyRects, isFullRedraw);
    }

    if (Array.isArray(pendingDirtyRects) &&
        pendingDirtyRects.length === 0 &&
        !this.layerManager.needsComposite &&
        !isDrawing &&
        !activeEraserPreview &&
        !hasActiveSelection) {
      this.layerManager.needsComposite = false;
      this.layerManager._notifyStrokeHistoryPanel();
      return;
    }

    const upperLayersHaveBlendModes = this.layerManager.rangeHasBlendModeStrokes(splitLayer + 1, totalLayers);

    if (isDrawing && eraseAll) {
      const mainDirtyRects = this._getFullMainDirtyRects(dirtyRects);
      this._fillBackgroundLayers(mainDirtyRects);
      this.layerManager.compositeLayerRange(this.mainCtx, 0, totalLayers, null, mainDirtyRects);

      this.mainCtx.globalCompositeOperation = 'destination-out';
      this.mainCtx.globalAlpha = this.app?.self?.opacity ?? 1.0;
      this._drawCompositeCanvas(this.mainCtx, this.topCanvas, mainDirtyRects);

      this.mainCtx.globalCompositeOperation = 'source-over';
      this.mainCtx.globalAlpha = 1.0;

      this._clearUpperLayers(mainDirtyRects);
    }
    else if (
      (isDrawing || activeEraserPreview || hasActiveSelection) &&
      splitLayer + 1 < totalLayers &&
      (activeEraserPreview || !upperLayersHaveBlendModes)
    ) {
      if (activeEraserPreview) {
        const mainDirtyRects = this._getSplitMainDirtyRects(splitLayer + 1, dirtyRects);
        this._applyEraserPreviewToMain(
          splitLayer,
          mainDirtyRects,
          activeEraserPreview.userId,
          activeEraserPreview.maskCanvas,
          activeEraserPreview.opacity
        );
      } else {
        const mainDirtyRects = this._getSplitMainDirtyRects(splitLayer + 1, dirtyRects);
        this._fillBackgroundLayers(mainDirtyRects);
        this.layerManager.compositeLayerRange(this.mainCtx, 0, splitLayer + 1, null, mainDirtyRects);

        if (isDrawing) {
          const blendMode = this.getActiveLayerBlendMode();
          if (blendMode !== 'source-over') {
            this.mainCtx.globalCompositeOperation = blendMode;
            this._drawCompositeCanvas(this.mainCtx, this.topCanvas, mainDirtyRects);
          }
          this.mainCtx.globalCompositeOperation = 'source-over';
          this.mainCtx.globalAlpha = 1.0;
        }
      }

      this._compositeUpperLayers(splitLayer + 1, totalLayers, dirtyRects);
    } else {
      const mainDirtyRects = this._getFullMainDirtyRects(dirtyRects);
      if (activeEraserPreview) {
        this._applyEraserPreviewToMain(
          splitLayer,
          mainDirtyRects,
          activeEraserPreview.userId,
          activeEraserPreview.maskCanvas,
          activeEraserPreview.opacity
        );
      } else {
        this._fillBackgroundLayers(mainDirtyRects);
        this.layerManager.compositeLayerRange(this.mainCtx, 0, totalLayers, null, mainDirtyRects);

        if (isDrawing) {
          const blendMode = this.getActiveLayerBlendMode();
          if (blendMode !== 'source-over') {
            this.mainCtx.globalCompositeOperation = blendMode;
            this._drawCompositeCanvas(this.mainCtx, this.topCanvas, mainDirtyRects);
          }
          this.mainCtx.globalCompositeOperation = 'source-over';
          this.mainCtx.globalAlpha = 1.0;
        }
      }

      this._clearUpperLayers(mainDirtyRects);
    }

    this.layerManager.needsComposite = false;
    this.layerManager._notifyStrokeHistoryPanel();
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
      // Skip this frame if message processing just ran — let it composite next tick.
      const lastProcEnd = this.app?.wsClient?._lastProcessingFrameEnd;
      if (lastProcEnd && performance.now() - lastProcEnd < 2) return;
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
    // If message processing ran in this same RAF batch, defer the composite
    // to the next frame to avoid stacking 10–20ms of work into one frame.
    const lastProcEnd = this.app?.wsClient?._lastProcessingFrameEnd;
    if (lastProcEnd && performance.now() - lastProcEnd < 2) {
      requestAnimationFrame(() => this._performScheduledComposite());
      return;
    }

    this._compositeScheduled = false;
    if (this._needsComposite) {
      this._needsComposite = false;
      this._lastCompositeTime = performance.now();
      this.compositeAllLayers();
    }
  }

  /**
   * Clear the preview (top) canvas and selection overlay
   */
  clearTop(rect = null) {
    const [height, width] = this.dimensions;
    if (rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0) {
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const right = Math.min(width, Math.ceil(rect.x + rect.width));
      const bottom = Math.min(height, Math.ceil(rect.y + rect.height));
      if (right > x && bottom > y) {
        this.topCtx.clearRect(x, y, right - x, bottom - y);
      }
      return;
    }

    this.topCtx.clearRect(0, 0, width, height);
    this.clearSelectionOverlay();
  }

  /**
   * Clear the selection overlay canvas
   */
  clearSelectionOverlay() {
    if (this.selectionCtx) {
      const pad = this.selectionOverlayPadding;
      this.selectionCtx.clearRect(0, 0, this.dimensions[1] + pad * 2, this.dimensions[0] + pad * 2);
    }
  }

  /**
   * Get the selection overlay context with padding offset applied.
   * Call save() before and restore() after drawing.
   * @returns {CanvasRenderingContext2D|null}
   */
  getSelectionCtx() {
    if (!this.selectionCtx) return null;
    this.selectionCtx.save();
    this.selectionCtx.translate(this.selectionOverlayPadding, this.selectionOverlayPadding);
    return this.selectionCtx;
  }

  /**
   * Restore the selection overlay context after drawing
   */
  restoreSelectionCtx() {
    if (this.selectionCtx) {
      this.selectionCtx.restore();
    }
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
   * Returns a canvas representing the full board for export.
   * @param {boolean} transparent - If true, omits the background fill (transparent PNG).
   * @returns {HTMLCanvasElement}
   */
  getExportCanvas(transparent) {
    if (!transparent) return this.mainCanvas;
    const [height, width] = this.dimensions;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    this.layerManager.compositeLayerRange(canvas.getContext('2d'), 0, this.layerManager.getLayerCount(), null);
    return canvas;
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

  /**
   * TileTracker has been stubbed out — per-tile pixel scans on every
   * undo/redo/commit were dragging down low-end machines for bookkeeping
   * nothing was actually reading. Left as a no-op so callers don't need
   * to change.
   */
  checkErasedTilesByIndices() {}

  /**
   * Captures each layer as a separate QOI-encoded image.
   * @returns {Uint8Array[]|null} Array of QOI blobs, one per layer
   */
  getSnapshot() {
    if (!this.layerManager) return null;
    const [height, width] = this.dimensions;
    const layers = [];

    for (let i = 0; i < this.layerManager.layerGroups.length; i++) {
      const { canvas, ctx } = this.layerManager._createCanvas();
      ctx.clearRect(0,0,width,height);
      this.layerManager.compositeLayerRange(ctx, i, i + 1, null);
      const imageData = ctx.getImageData(0, 0, width, height);
      if (i === 0) {
        this._stripSnapshotBackground(imageData);
      }
      layers.push(wasm.qoi_encode(new Uint8Array(imageData.data.buffer), width, height));
    }

    return layers;
  }

  /**
   * Restores per-layer QOI snapshot data onto the board.
   * @param {Uint8Array[]} layerDatas - Array of QOI blobs, one per layer
   */
  restoreSnapshot(layerDatas) {
    if (!this.layerManager || !layerDatas || layerDatas.length === 0) return;
    const [currentHeight, currentWidth] = this.dimensions;
    const snapshotDimensions = snapshotLayerDimensions(layerDatas) || { width: currentWidth, height: currentHeight };
    if (
      snapshotDimensions?.width > 0 &&
      snapshotDimensions?.height > 0 &&
      (this.dimensions[1] !== snapshotDimensions.width || this.dimensions[0] !== snapshotDimensions.height)
    ) {
      this.resizeBoard([snapshotDimensions.height, snapshotDimensions.width]);
    }

    const [height, width] = this.dimensions;
    const restoreWidth = Math.min(width, snapshotDimensions.width);
    const restoreHeight = Math.min(height, snapshotDimensions.height);
    const replacesFullBoard = snapshotDimensions.width >= width && snapshotDimensions.height >= height;

    if (replacesFullBoard) {
      this.layerManager.clearAll();
    } else if (restoreWidth > 0 && restoreHeight > 0) {
      for (let i = 0; i < this.layerManager.layerGroups.length; i++) {
        this._clearLayerRectForSnapshotRestore(i, 0, 0, restoreWidth, restoreHeight);
      }
      this.layerManager.redoStackByUser?.clear?.();
    }

    for (let i = 0; i < layerDatas.length && i < this.layerManager.layerGroups.length; i++) {
      const qoi = layerDatas[i];
      if (!qoi || qoi.length === 0) continue;

      const pixels = wasm.qoi_decode(qoi);
      if (!pixels || pixels.length === 0) continue;

      const dimensions = readQoiDimensions(qoi) || snapshotDimensions;
      if (!dimensions || pixels.length !== dimensions.width * dimensions.height * 4) continue;

      const imageData = new ImageData(
        new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        dimensions.width,
        dimensions.height
      );
      const group = this.layerManager.layerGroups[i];
      const sourceCanvas = this._createCanvasFromImageData(imageData);

      if (group.flatCanvas) {
        group.flatCtx.drawImage(sourceCanvas, 0, 0);
      } else {
        this.layerManager.addToBaseBin(i, sourceCanvas, 0, 0);
      }
    }

    this.markCompositeFull();
    this.compositeAllLayers();
  }

  _clearLayerRectForSnapshotRestore(groupIdx, x, y, width, height) {
    const group = this.layerManager?.layerGroups?.[groupIdx];
    if (!group) return;

    for (const stroke of group.strokeStack) {
      this.layerManager.addToBaseBin(groupIdx, stroke.canvas, stroke.x, stroke.y, stroke.blendMode);
    }
    group.strokeStack = [];
    group.userStrokeCounts = new Map();
    group.activeStrokeByUser.clear();

    if (group.flatCanvas) {
      group.flatCtx.clearRect(x, y, width, height);
      return;
    }

    const eraseCanvas = document.createElement('canvas');
    eraseCanvas.width = width;
    eraseCanvas.height = height;
    const eraseCtx = eraseCanvas.getContext('2d');
    eraseCtx.fillStyle = '#000';
    eraseCtx.fillRect(0, 0, width, height);
    this.layerManager.addToBaseBin(groupIdx, eraseCanvas, x, y, 'destination-out');
  }

  /**
   * Helper to create a canvas from ImageData.
   * @param {ImageData} imageData
   * @returns {HTMLCanvasElement}
   * @private
   */
  _createCanvasFromImageData(imageData) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * Fills the background layers: room background, then user background (if set).
   * This creates the z-order: room BG → user BG → drawn strokes.
   * @param {Array} dirtyRects - Dirty regions to update, or null for full canvas
   * @private
   */
  _fillBackgroundLayers(dirtyRects) {
    this.mainCtx.globalCompositeOperation = 'source-over';

    const [bgR, bgG, bgB, bgA = 1] = this.backgroundColor || [255, 255, 255, 1];
    this.mainCtx.fillStyle = `rgba(${bgR}, ${bgG}, ${bgB}, ${bgA})`;

    if (dirtyRects && Array.isArray(dirtyRects) && dirtyRects.length > 0) {
      for (const rect of dirtyRects) {
        this.mainCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      this.mainCtx.fillRect(0, 0, this.width, this.height);
    }

    if (this.displayBackgroundColorOverride) {
      const [r, g, b, a] = this.displayBackgroundColorOverride;
      this.mainCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;

      if (dirtyRects && Array.isArray(dirtyRects) && dirtyRects.length > 0) {
        for (const rect of dirtyRects) {
          this.mainCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
      } else {
        this.mainCtx.fillRect(0, 0, this.width, this.height);
      }
    }
  }

  /**
   * Removes border-connected background pixels from the exported base layer so
   * snapshots keep a transparent backdrop even if the baked flat canvas has
   * picked up the room background color.
   * @param {ImageData} imageData
   * @private
   */
  _stripSnapshotBackground(imageData) {
    const { data, width, height } = imageData;
    if (!data || width <= 0 || height <= 0) return;

    const [bgR, bgG, bgB, bgA = 1] = this.backgroundColor || [255, 255, 255, 1];
    const bgAlpha = Math.round(bgA * 255);
    const tolerance = 3;
    const totalPixels = width * height;
    const visited = new Uint8Array(totalPixels);
    const queue = new Uint32Array(totalPixels);
    let head = 0;
    let tail = 0;

    const matchesBackground = (pixelIndex) => {
      const offset = pixelIndex * 4;
      return Math.abs(data[offset] - bgR) <= tolerance &&
        Math.abs(data[offset + 1] - bgG) <= tolerance &&
        Math.abs(data[offset + 2] - bgB) <= tolerance &&
        Math.abs(data[offset + 3] - bgAlpha) <= tolerance;
    };

    const enqueue = (pixelIndex) => {
      if (pixelIndex < 0 || pixelIndex >= totalPixels) return;
      if (visited[pixelIndex] || !matchesBackground(pixelIndex)) return;
      visited[pixelIndex] = 1;
      queue[tail++] = pixelIndex;
    };

    for (let x = 0; x < width; x++) {
      enqueue(x);
      enqueue((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      enqueue(y * width);
      enqueue(y * width + (width - 1));
    }

    while (head < tail) {
      const pixelIndex = queue[head++];
      const offset = pixelIndex * 4;
      data[offset + 3] = 0;

      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);

      if (x > 0) enqueue(pixelIndex - 1);
      if (x + 1 < width) enqueue(pixelIndex + 1);
      if (y > 0) enqueue(pixelIndex - width);
      if (y + 1 < height) enqueue(pixelIndex + width);
    }
  }

  /**
   * Check if tile pixel data is empty (transparent or only background color).
   * @param {Uint8ClampedArray} data - RGBA pixel data
   * @returns {boolean} True if all pixels are transparent or match background
   * @private
   */
  _checkTileEmpty(data) {
    const [bgR, bgG, bgB, bgA] = this.backgroundColor;
    const bgAlpha = Math.round(bgA * 255);
    const tolerance = 5; // Handle anti-aliasing artifacts

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];

      // Transparent pixel = empty
      if (a === 0) continue;

      // Check if close to background (within tolerance)
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (Math.abs(a - bgAlpha) <= tolerance &&
          Math.abs(r - bgR) <= tolerance &&
          Math.abs(g - bgG) <= tolerance &&
          Math.abs(b - bgB) <= tolerance) {
        continue;
      }

      // Has other content
      return false;
    }
    return true;
  }
}
