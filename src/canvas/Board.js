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
    this.mainCtx = null;
    this.topCtx = null;
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

    this.mainCtx = this.mainCanvas.getContext('2d');
    this.topCtx = this.topCanvas.getContext('2d');

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
   * Get the drawing context for the active layer's blend-mode sub-layer.
   * The returned context should always be drawn to source-over; the blend
   * mode is applied at composite time.
   * Uses the layer's activeBlendMode (set via setActiveLayerBlendMode).
   * @returns {CanvasRenderingContext2D} The active sub-layer's context
   */
  getActiveLayerContext() {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    return this.layerManager?.getLayerContext(activeLayer) ?? this.mainCtx;
  }

  /**
   * Get the drawing context for a specific layer's active blend-mode sub-layer.
   * Uses the layer's activeBlendMode (not a per-user blend mode).
   * @param {number} layerIndex - Layer group index
   * @returns {CanvasRenderingContext2D} The sub-layer's context
   */
  getLayerContext(layerIndex) {
    return this.layerManager?.getLayerContext(layerIndex) ?? this.mainCtx;
  }

  /**
   * Get the active blend mode for the current layer
   * @returns {string} The active blend mode (e.g., 'source-over', 'multiply')
   */
  getActiveLayerBlendMode() {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    return this.layerManager?.getActiveBlendMode(activeLayer) ?? 'source-over';
  }

  /**
   * Set the active blend mode for the current layer
   * @param {string} blendMode - CSS composite operation
   */
  setActiveLayerBlendMode(blendMode) {
    const activeLayer = this.app?.self?.activeLayer ?? 0;
    if (this.layerManager) {
      this.layerManager.setActiveBlendMode(activeLayer, blendMode);
    }
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
   * Composite all visible layers onto the main canvas
   */
  compositeAllLayers() {
    if (this.layerManager) {
      this.layerManager.compositeLayers(this.mainCtx);
    }
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
