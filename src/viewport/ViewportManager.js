/**
 * ViewportManager - Manages pan, zoom, and resize functionality
 */

import { MessageType } from '../network/Protocol.js';
import { clamp } from '../utils/math.js';

export class ViewportManager {
  #stateManager = null;
  #wsClient = null;
  #canvasManager = null;
  #boardsElement = null;

  // Viewport state
  #zoom = 1;
  #defaultZoom = 1;
  #panX = 0;
  #panY = 0;
  #defaultPanX = 0;
  #defaultPanY = 0;

  // Constraints
  #minZoom = 0.2;
  #maxZoom = 3;
  #zoomStep = 0.1;

  /**
   * Create a ViewportManager
   * @param {StateManager} stateManager - State manager
   * @param {WebSocketClient} wsClient - WebSocket client
   * @param {CanvasManager} canvasManager - Canvas manager
   */
  constructor(stateManager, wsClient, canvasManager) {
    this.#stateManager = stateManager;
    this.#wsClient = wsClient;
    this.#canvasManager = canvasManager;
  }

  /**
   * Initialize viewport
   */
  init() {
    this.#boardsElement = document.getElementById('boards');
    if (!this.#boardsElement) {
      throw new Error('Boards element not found');
    }

    const boardDim = this.#canvasManager.boardDim;

    // Set initial board size
    this.#boardsElement.style.height = `${boardDim[0]}px`;
    this.#boardsElement.style.width = `${boardDim[1]}px`;
    this.#boardsElement.style.transformOrigin = 'top left';

    // Calculate default zoom and pan
    this.#calculateDefaults();

    // Apply initial transform
    this.#applyTransform();

    // Setup mirror line
    this.#setupMirrorLine();

    // Setup bottom bar position
    this.#setupBottomBar();

    // Listen for reset event
    this.#stateManager.addEventListener('viewport:reset', () => this.reset());
    this.#stateManager.addEventListener('viewport:zoom', (e) => {
      this.zoom(this.#zoom + e.detail.delta);
    });

    // Setup resize handler
    window.addEventListener('resize', () => this.#handleResize());
  }

  #calculateDefaults() {
    const boardContainer = document.getElementById('boardContainer');
    if (!boardContainer) return;

    const boardDim = this.#canvasManager.boardDim;
    const containerWidth = boardContainer.offsetWidth * 0.95;
    const containerHeight = boardContainer.offsetHeight * 0.95 - 30;

    // Calculate zoom to fit width
    let zoom = Math.round((containerWidth / boardDim[1]) * 1000) / 1000;
    let panX = containerWidth * 0.05 / 2;
    let panY = containerHeight / 2 - boardDim[0] * zoom / 2 + 30;

    // Check if height is the limiting factor
    const heightZoom = Math.round((containerHeight / boardDim[0]) * 1000) / 1000;
    if (zoom > heightZoom) {
      zoom = heightZoom;
      panX = containerWidth / 2 - boardDim[1] * zoom / 2;
      panY = containerHeight * 0.05 / 2 + 30;
    }

    this.#defaultZoom = zoom;
    this.#defaultPanX = panX;
    this.#defaultPanY = panY;

    this.#zoom = zoom;
    this.#panX = panX;
    this.#panY = panY;

    // Update state
    this.#stateManager.update({
      zoom: this.#zoom,
      defaultZoom: this.#defaultZoom,
      pan: { x: this.#panX, y: this.#panY },
      defaultPan: { x: this.#defaultPanX, y: this.#defaultPanY }
    });
  }

  #setupMirrorLine() {
    const mirrorLine = document.querySelector('.mirrorLine');
    if (mirrorLine) {
      const boardDim = this.#canvasManager.boardDim;
      mirrorLine.setAttribute('x1', boardDim[1] / 2);
      mirrorLine.setAttribute('y1', 0);
      mirrorLine.setAttribute('x2', boardDim[1] / 2);
      mirrorLine.setAttribute('y2', boardDim[0]);
      mirrorLine.style.display = 'none';
    }
  }

  #setupBottomBar() {
    const bottomBar = document.getElementById('bottomBar');
    const boardContainer = document.getElementById('boardContainer');
    if (bottomBar && boardContainer) {
      bottomBar.style.top = `${boardContainer.offsetHeight - 20}px`;
      bottomBar.style.width = `${boardContainer.offsetWidth}px`;
    }
  }

  #applyTransform() {
    if (!this.#boardsElement) return;

    this.#boardsElement.style.left = `${this.#panX}px`;
    this.#boardsElement.style.top = `${this.#panY}px`;
    this.#boardsElement.style.scale = this.#zoom;

    // Update zoom percentage display
    const zoomPercent = document.querySelector('.zoomPercent');
    if (zoomPercent) {
      zoomPercent.textContent = `${(this.#zoom * 100).toFixed(1)}%`;
    }
  }

  #handleResize() {
    this.#calculateDefaults();
    this.#setupBottomBar();
  }

  /**
   * Set zoom level
   * @param {number} newZoom - New zoom level
   * @param {Object} origin - Optional zoom origin {x, y}
   */
  zoom(newZoom, origin = null) {
    newZoom = clamp(Math.round(newZoom * 10) / 10, this.#minZoom, this.#maxZoom);

    if (origin) {
      // Zoom towards a point
      this.#boardsElement.style.transformOrigin = `${origin.x}px ${origin.y}px`;
    }

    this.#zoom = newZoom;
    this.#stateManager.set('zoom', this.#zoom);
    this.#applyTransform();
  }

  /**
   * Pan the viewport
   * @param {number} dx - Delta X
   * @param {number} dy - Delta Y
   */
  pan(dx, dy) {
    this.#panX += dx;
    this.#panY += dy;

    this.#stateManager.set('pan', { x: this.#panX, y: this.#panY });
    this.#applyTransform();
  }

  /**
   * Set absolute pan position
   * @param {number} x - X position
   * @param {number} y - Y position
   */
  setPan(x, y) {
    this.#panX = x;
    this.#panY = y;

    this.#stateManager.set('pan', { x: this.#panX, y: this.#panY });
    this.#applyTransform();
  }

  /**
   * Reset viewport to default zoom and position
   */
  reset() {
    this.#boardsElement.style.transformOrigin = 'top left';
    this.#zoom = this.#defaultZoom;
    this.#panX = this.#defaultPanX;
    this.#panY = this.#defaultPanY;

    this.#stateManager.update({
      zoom: this.#zoom,
      pan: { x: this.#panX, y: this.#panY }
    });

    this.#applyTransform();
  }

  /**
   * Handle wheel event for zooming
   * @param {WheelEvent} e - Wheel event
   */
  handleWheel(e) {
    const user = this.#stateManager.get('localUser');
    if (!user || !user.panning) return;

    e.preventDefault();

    const zoomOrigin = { x: e.layerX, y: e.layerY };

    if (e.deltaY > 0) {
      // Zoom out
      this.zoom(this.#zoom - this.#zoomStep, zoomOrigin);
    } else {
      // Zoom in
      this.zoom(this.#zoom + this.#zoomStep, zoomOrigin);
    }
  }

  /**
   * Handle pointer move for panning
   * @param {PointerEvent} e - Pointer event
   */
  handlePan(e) {
    const user = this.#stateManager.get('localUser');
    if (!user || !user.panning || !user.mousedown) return;

    this.pan(e.movementX, e.movementY);
  }

  /**
   * Start panning mode
   */
  startPanning() {
    const user = this.#stateManager.get('localUser');
    if (user && !user.panning && !user.mousedown) {
      user.panning = true;
      this.#wsClient.broadcast(MessageType.USER_PANNING, { value: true });
    }
  }

  /**
   * Stop panning mode
   */
  stopPanning() {
    const user = this.#stateManager.get('localUser');
    if (user && user.panning) {
      user.panning = false;
      this.#wsClient.broadcast(MessageType.USER_PANNING, { value: false });
    }
  }

  /**
   * Get current zoom level
   * @returns {number}
   */
  get currentZoom() {
    return this.#zoom;
  }

  /**
   * Get current pan position
   * @returns {Object} {x, y}
   */
  get currentPan() {
    return { x: this.#panX, y: this.#panY };
  }
}
