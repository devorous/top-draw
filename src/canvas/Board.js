import { LayerManager } from './LayerManager.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { TileGrid } from './TileGrid.js';
import { TileTracker } from './TileTracker.js';
import * as wasm from '../wasm/ddraw_wasm.js';

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
    this.mirrorRegions = [];
    this.backgroundColor = options.backgroundColor || [255, 255, 255, 1];

    this.container = null;
    this.boardsWrapper = null;
    this.mainCanvas = null;
    this.topCanvas = null;
    this.upperLayersCanvas = null;
    this.selectionOverlay = null;
    this.selectionOverlayPadding = 500;
    this.interactionBlockOverlay = null;
    this.interactionBlockCtx = null;
    this.mainCtx = null;
    this.topCtx = null;
    this.upperLayersCtx = null;
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

    this._dirtyRects = [];

    this.MAX_DIRTY_RECTS = 20;
    this.DIRTY_RECT_MERGE_DISTANCE = 20;

    /** @type {TileGrid|null} Tile-based dirty tracking (initialized in init()) */
    this.tileGrid = null;

    /** @type {TileTracker|null} Tracks occupied tiles */
    this.tileTracker = null;

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
   * Set the canvas background color from a hex string
   * @param {string} hex - Hex color string (e.g., "#ffffff")
   */
  setBackgroundColor(hex) {
    // Convert hex to RGBA array
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    this.backgroundColor = [r, g, b, 1];
    this.requestUpdate();
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

    // Create selection overlay canvas with padding to allow handles to extend beyond board
    this.selectionOverlay = document.createElement('canvas');
    this.selectionOverlay.id = 'selectionOverlay';
    this.boardsWrapper.appendChild(this.selectionOverlay);
    this.selectionCtx = this.selectionOverlay.getContext('2d');

    this.interactionBlockOverlay = document.createElement('canvas');
    this.interactionBlockOverlay.id = 'interactionBlockOverlay';
    this.interactionBlockOverlay.style.position = 'absolute';
    this.interactionBlockOverlay.style.top = '0';
    this.interactionBlockOverlay.style.left = '0';
    this.interactionBlockOverlay.style.pointerEvents = 'none';
    this.interactionBlockOverlay.style.zIndex = '4';
    this.boardsWrapper.appendChild(this.interactionBlockOverlay);
    this.interactionBlockCtx = this.interactionBlockOverlay.getContext('2d');

    this.upperLayersCanvas = document.createElement('canvas');
    this.upperLayersCanvas.id = 'upperLayersBoard';
    this.upperLayersCanvas.style.position = 'absolute';
    this.upperLayersCanvas.style.top = '0';
    this.upperLayersCanvas.style.left = '0';
    this.upperLayersCanvas.style.pointerEvents = 'none';
    this.upperLayersCanvas.style.zIndex = '2';
    this.boardsWrapper.appendChild(this.upperLayersCanvas);
    this.upperLayersCtx = this.upperLayersCanvas.getContext('2d');

    this.mirrorRegionsLayer = document.createElement('div');
    this.mirrorRegionsLayer.id = 'mirrorRegionsLayer';
    this.mirrorRegionsLayer.style.position = 'absolute';
    this.mirrorRegionsLayer.style.top = '0';
    this.mirrorRegionsLayer.style.left = '0';
    this.mirrorRegionsLayer.style.width = '100%';
    this.mirrorRegionsLayer.style.height = '100%';
    this.mirrorRegionsLayer.style.pointerEvents = 'none';
    this.mirrorRegionsLayer.style.zIndex = '3';
    this.boardsWrapper.appendChild(this.mirrorRegionsLayer);

    this.setupCanvas();

    this._createLayerManager();

    const [height, width] = this.dimensions;
    this.tileGrid = new TileGrid(width, height);
    this.tileTracker = new TileTracker(width, height);

    this.calculateDefaultView();
    this.resetView();
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
    if (this.upperLayersCanvas) {
      this.upperLayersCanvas.height = height;
      this.upperLayersCanvas.width = width;
    }
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

    this.mirrorLine.setAttribute('x1', width / 2);
    this.mirrorLine.setAttribute('y1', 0);
    this.mirrorLine.setAttribute('x2', width / 2);
    this.mirrorLine.setAttribute('y2', height);
    this.mirrorLine.style.display = 'none';

    this.boardsWrapper.style.transformOrigin = 'top left';
    if (this.mirrorRegionsLayer) {
      this.mirrorRegionsLayer.style.width = `${width}px`;
      this.mirrorRegionsLayer.style.height = `${height}px`;
    }
    this.renderInteractionBlocks();
    this.renderMirrorRegions();
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


    const containerRect = this.container.getBoundingClientRect();
    let bx = clientX - containerRect.left;
    let by = clientY - containerRect.top;


    bx -= this.panX;
    by -= this.panY;


    const rad = -this.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = bx * cos - by * sin;
    const ry = bx * sin + by * cos;


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
   * @param {number} zoom - Zoom level (0.2 to 5)
   * @param {Object} [cursorPos=null] - Pivot point for zoom {x, y}
   * @returns {number} The applied zoom level
   */
  setZoom(zoom, cursorPos = null) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.2, Math.min(5, zoom));

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
    this.zoom = Math.max(0.2, Math.min(5, newZoom));

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
    if (!this.mirrorRegionsLayer) return;
    this.mirrorRegionsLayer.innerHTML = '';

    if (this.mirror) return;

    for (const region of this.mirrorRegions) {
      const regionEl = document.createElement('div');
      regionEl.className = 'mirror-region';
      regionEl.style.position = 'absolute';
      regionEl.style.left = `${region.x}px`;
      regionEl.style.top = `${region.y}px`;
      regionEl.style.width = `${region.width}px`;
      regionEl.style.height = `${region.height}px`;
      regionEl.style.border = '1px solid rgba(0, 212, 170, 0.9)';
      regionEl.style.boxSizing = 'border-box';
      regionEl.style.background = 'transparent';
      regionEl.style.overflow = 'hidden';

      if (region.showLine) {
        this._appendMirrorRegionGuide(regionEl, region);
      }

      this.mirrorRegionsLayer.appendChild(regionEl);
    }
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
    return ['horizontal', 'quad', 'rotational', 'radial'].includes(mode) ? mode : 'vertical';
  }

  _normalizeMirrorSlices(slices) {
    const parsed = Math.floor(Number(slices));
    if (!Number.isFinite(parsed)) return 6;
    return Math.max(3, Math.min(16, parsed));
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
   * Clear all layers and reset canvases
   */
  clear() {
    const [height, width] = this.dimensions;
    this.mainCtx.beginPath();
    this.topCtx.beginPath();

    if (this.layerManager) {
      this.layerManager.clearAll();
      if (this.tileGrid) this.tileGrid.markAllDirty();
      this.compositeAllLayers();
    } else {
      this.mainCtx.clearRect(0, 0, width, height);
    }

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
    this.tileGrid?.clear?.();
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
    if (isLocalUser && this.app?.wsClient && this.app?.connected) {
      const active = this.layerManager.getActiveStroke(activeLayer, userId);
      if (active?.affectedTiles?.size > 0 && active.blendMode !== 'destination-out') {
        tilesToBroadcast = Array.from(active.affectedTiles);
      }
    }

    if (extraProps.filterType === 'glitchBlur') {
      extraProps.mirrorRegions = this.getActiveMirrorRegions().map(region => ({ ...region }));
    }

    this.layerManager.commitUserStroke(activeLayer, userId, extraProps);
    this.requestUpdate();

    // Broadcast tile ownership update for local user
    if (tilesToBroadcast && tilesToBroadcast.length > 0) {
      this.app.wsClient.broadcastTileUpdate(tilesToBroadcast);
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
    if (this.tileGrid) this.tileGrid.markDirty(x, y, width, height);

    if (this.app?.debugOverlay) {
      const username = user?.username ?? this.app?.self?.username ?? `User ${userId}`;
      this.app.debugOverlay.expandUserRegion(userId, username, x, y, width, height);
    }
  }

  /**
   * Mark tiles dirty along a path (for line-based strokes).
   * More efficient than bounding box for diagonal lines.
   * Tracks occupied tiles for efficient synchronization.
   * @param {Object} user - User object
   * @param {Array<{x: number, y: number}>} points - Array of points
   * @param {number} radius - Brush radius
   * @param {boolean} [isErase=false] - Whether this is an erase operation
   */
  markDirtyPath(user, points, radius, isErase = false) {
    if (!this.layerManager || !points || points.length === 0) return;

    const activeLayer = user?.activeLayer ?? this.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.app?.self?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    if (active?.dirtyRect) {
      // Still expand the per-stroke bounding box for content bounds detection
      for (const pt of points) {
        this.layerManager._expandDirtyRect(active.dirtyRect, pt.x - radius, pt.y - radius, radius * 2, radius * 2);
      }
    }

    // Use line-based tile marking for immediate redraw
    if (this.tileGrid) {
      this.tileGrid.markDirtyPath(points, radius);
    }

    // Track occupied tiles for drawing (not erasing)
    if (this.tileTracker && !isErase) {
      // Mark tiles as occupied along the path
      this.tileTracker.markPathDirty(points, radius, active?.affectedTiles);
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
      const group = this.layerManager.layerGroups[i];
      if (!group) continue;
      const active = group.activeStrokeByUser.get(userId);
      if (!active || !active.dirtyRect) continue;
      this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    }
    this._addOrMergeDirtyRect(x, y, width, height);
    if (this.tileGrid) this.tileGrid.markDirty(x, y, width, height);
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
    let tilesToRecheck = null;

    if (batch) {
      this.layerManager._pushToRedoStack(userId, batch);
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          this._applySelectionRestore(record.selectionRestoreData.snapshots);
          break;
        }
        if (record.affectedTiles) {
          if (!tilesToRecheck) tilesToRecheck = new Set();
          for (const idx of record.affectedTiles) tilesToRecheck.add(idx);
        }
      }
    }
    if (this.tileGrid) this.tileGrid.markAllDirty();
    // Preserve the local preview/selection overlays during undo so another
    // user's history change cannot blank an in-progress stroke preview.
    this.compositeAllLayers();

    // After composite, check affected tiles and update tracker state based on current pixels
    if (tilesToRecheck && this.tileTracker) {
      this.checkErasedTilesByIndices(tilesToRecheck, userId === this.app?.self?.id);
    }
  }

  /**
   * Add occupancy to tiles within a rectangular region (no empty check).
   * Use this for paste/commit/stamp/fill operations where we're adding content.
   * @param {number} x - Left edge (pixels)
   * @param {number} y - Top edge (pixels)
   * @param {number} width - Width (pixels)
   * @param {number} height - Height (pixels)
   */
  addOccupancyForTilesInRect(x, y, width, height) {
    if (!this.tileTracker) return;

    const tileIndices = this.tileTracker.getTileIndicesForRect(x, y, width, height);
    for (const idx of tileIndices) {
      this.tileTracker.markTileDirty(idx);
    }
  }

  /**
   * Add occupancy to visible (non-empty) tiles within a rectangular region.
   * Should be called AFTER compositing so mainCtx has current pixel data.
   * @param {number} x - Left edge (pixels)
   * @param {number} y - Top edge (pixels)
   * @param {number} width - Width (pixels)
   * @param {number} height - Height (pixels)
   */
  addOccupancyForVisibleTilesInRect(x, y, width, height) {
    if (!this.tileTracker) return;

    const tileIndices = this.tileTracker.getTileIndicesForRect(x, y, width, height);
    this.checkErasedTilesByIndices(new Set(tileIndices), true);
  }

  /**
   * Redo the most recently undone stroke batch for userId.
   * @param {number} userId - User ID
   */
  redo(userId) {
    if (!this.layerManager) return;
    const redoStack = this.layerManager.redoStackByUser.get(userId);
    let tilesToRecheck = null;

    if (redoStack && redoStack.length > 0) {
      const batch = redoStack[redoStack.length - 1];
      for (const { record } of batch) {
        if (record.selectionRestoreData) {
          this._applySelectionReErase(record.selectionRestoreData);
          break;
        }
        if (record.affectedTiles) {
          if (!tilesToRecheck) tilesToRecheck = new Set();
          for (const idx of record.affectedTiles) tilesToRecheck.add(idx);
        }
      }
    }
    this.layerManager.redoLastStroke(userId);
    if (this.tileGrid) this.tileGrid.markAllDirty();
    // Preserve the local preview/selection overlays during redo for the same
    // reason as undo: previews are transient UI state, not history state.
    this.compositeAllLayers();

    // Re-check tiles to update tracker state
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

    // Prefer tile grid rects; fall back to legacy bounding-box array
    let dirtyRects;
    let tileSnapshot = null;
    if (this.tileGrid && this.tileGrid.isDirty()) {
      // Capture tile state for debug overlay BEFORE clearing
      if (this.app?.debugOverlay?.enabled) {
        tileSnapshot = this.tileGrid.getTileSnapshot();
      }
      dirtyRects = this.tileGrid.getDirtyRects();
      this.tileGrid.clear();
      // Also drain the legacy array so it doesn't accumulate
      this._dirtyRects = [];
    } else {
      dirtyRects = this._dirtyRects.slice();
      this._dirtyRects = [];
    }

    if (this.app?.debugOverlay) {
      this.app.debugOverlay.captureDirtyTiles(tileSnapshot, this.tileGrid);
      this.app.debugOverlay.captureDirtyRects(dirtyRects);
    }

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
   * Clear the preview (top) canvas and selection overlay
   */
  clearTop() {
    const [height, width] = this.dimensions;
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
   * Check erased tiles by indices and clear tracker if empty, or mark dirty if not.
   * Processes tiles asynchronously in batches to avoid blocking the main thread.
   * @param {Set<number>} tileIndices - Set of tile indices to check
   * @param {boolean} [broadcast=true] - Whether to broadcast updates to other clients
   */
  checkErasedTilesByIndices(tileIndices, broadcast = true) {
    if (!this.tileTracker || tileIndices.size === 0) return;

    const BATCH_SIZE = 16;
    const tileArray = Array.from(tileIndices);
    const clearedTiles = [];
    const dirtiedTiles = [];
    let index = 0;

    const processNextBatch = () => {
      const tileSize = this.tileTracker.tileSize;
      const endIndex = Math.min(index + BATCH_SIZE, tileArray.length);

      for (; index < endIndex; index++) {
        const tileIdx = tileArray[index];
        const col = tileIdx % this.tileTracker.cols;
        const row = Math.floor(tileIdx / this.tileTracker.cols);
        const tileX = col * tileSize;
        const tileY = row * tileSize;

        const tileW = Math.min(tileSize, this.dimensions[1] - tileX);
        const tileH = Math.min(tileSize, this.dimensions[0] - tileY);

        if (tileW <= 0 || tileH <= 0) continue;

        const imageData = this.mainCtx.getImageData(tileX, tileY, tileW, tileH);
        const isEmpty = this._checkTileEmpty(imageData.data);

        if (isEmpty) {
          if (this.tileTracker.clearTile(tileIdx)) {
            clearedTiles.push(tileIdx);
          }
        } else {
          if (this.tileTracker.markTileDirty(tileIdx)) {
            dirtiedTiles.push(tileIdx);
          }
        }
      }

      if (index < tileArray.length) {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(processNextBatch, { timeout: 50 });
        } else {
          setTimeout(processNextBatch, 0);
        }
      } else {
        if (broadcast && this.app?.wsClient && this.app?.connected) {
          if (clearedTiles.length > 0) this.app.wsClient.broadcastTileClear(clearedTiles);
          if (dirtiedTiles.length > 0) this.app.wsClient.broadcastTileUpdate(dirtiedTiles);
        }
      }
    };

    processNextBatch();
  }

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
      this.layerManager.compositeLayerRange(ctx, i, i + 1, null);
      const imageData = ctx.getImageData(0, 0, width, height);
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
    const [height, width] = this.dimensions;

    this.layerManager.clearAll();

    for (let i = 0; i < layerDatas.length && i < this.layerManager.layerGroups.length; i++) {
      const qoi = layerDatas[i];
      if (!qoi || qoi.length === 0) continue;

      const pixels = wasm.qoi_decode(qoi);
      if (!pixels || pixels.length === 0) continue;

      const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), width, height);
      const group = this.layerManager.layerGroups[i];

      if (group.flatCanvas) {
        group.flatCtx.putImageData(imageData, 0, 0);
      } else {
        this.layerManager.addToBaseBin(i, this._createCanvasFromImageData(imageData), 0, 0);
      }
    }

    if (this.tileGrid) this.tileGrid.markAllDirty();
    if (this.tileTracker) {
      const tileIndices = [];
      for (let i = 0; i < this.tileTracker.cols * this.tileTracker.rows; i++) {
        tileIndices.push(i);
      }
      this.checkErasedTilesByIndices(new Set(tileIndices), true);
    }

    this.compositeAllLayers();
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
