/**
 * CanvasManager - Manages canvas elements and contexts
 */

export class CanvasManager {
  #mainCanvas = null;
  #topCanvas = null;
  #mainCtx = null;
  #topCtx = null;
  #boardDim = [720, 1280];
  #userBoards = new Map();

  /**
   * Create a CanvasManager
   * @param {Array} boardDim - Board dimensions [height, width]
   */
  constructor(boardDim = [720, 1280]) {
    this.#boardDim = boardDim;
  }

  /**
   * Initialize canvases from DOM elements
   */
  init() {
    this.#mainCanvas = document.getElementById('board');
    this.#topCanvas = document.getElementById('topBoard');

    if (!this.#mainCanvas || !this.#topCanvas) {
      throw new Error('Canvas elements not found');
    }

    // Set canvas dimensions
    this.#mainCanvas.width = this.#boardDim[1];
    this.#mainCanvas.height = this.#boardDim[0];
    this.#topCanvas.width = this.#boardDim[1];
    this.#topCanvas.height = this.#boardDim[0];

    // Get contexts
    this.#mainCtx = this.#mainCanvas.getContext('2d');
    this.#topCtx = this.#topCanvas.getContext('2d');

    // Configure contexts
    this.#configureContext(this.#mainCtx);
    this.#configureContext(this.#topCtx);

    return this;
  }

  #configureContext(ctx) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingQuality = 'high';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /**
   * Get the main canvas context
   * @returns {CanvasRenderingContext2D}
   */
  get mainCtx() {
    return this.#mainCtx;
  }

  /**
   * Get the top (preview) canvas context
   * @returns {CanvasRenderingContext2D}
   */
  get topCtx() {
    return this.#topCtx;
  }

  /**
   * Get the main canvas element
   * @returns {HTMLCanvasElement}
   */
  get mainCanvas() {
    return this.#mainCanvas;
  }

  /**
   * Get the top canvas element
   * @returns {HTMLCanvasElement}
   */
  get topCanvas() {
    return this.#topCanvas;
  }

  /**
   * Get board dimensions
   * @returns {Array} [height, width]
   */
  get boardDim() {
    return this.#boardDim;
  }

  /**
   * Get board width
   * @returns {number}
   */
  get width() {
    return this.#boardDim[1];
  }

  /**
   * Get board height
   * @returns {number}
   */
  get height() {
    return this.#boardDim[0];
  }

  /**
   * Clear the main canvas
   */
  clearMain() {
    this.#mainCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Clear the top (preview) canvas
   */
  clearTop() {
    this.#topCtx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Clear both canvases
   */
  clearAll() {
    this.#mainCtx.beginPath();
    this.#topCtx.beginPath();
    this.clearMain();
    this.clearTop();
  }

  /**
   * Create a user-specific canvas for drawing previews
   * @param {number} userId - User ID
   * @returns {Object} { canvas, context }
   */
  createUserBoard(userId) {
    const userBoards = document.getElementById('userBoards');
    if (!userBoards) {
      throw new Error('userBoards container not found');
    }

    const canvas = document.createElement('canvas');
    canvas.width = this.#boardDim[1];
    canvas.height = this.#boardDim[0];
    canvas.className = `userBoard ${userId}`;

    userBoards.appendChild(canvas);

    const context = canvas.getContext('2d');
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const board = { canvas, context };
    this.#userBoards.set(userId, board);

    return board;
  }

  /**
   * Get a user's board
   * @param {number} userId - User ID
   * @returns {Object|null} { canvas, context } or null
   */
  getUserBoard(userId) {
    return this.#userBoards.get(userId) || null;
  }

  /**
   * Remove a user's board
   * @param {number} userId - User ID
   */
  removeUserBoard(userId) {
    const board = this.#userBoards.get(userId);
    if (board) {
      board.canvas.remove();
      this.#userBoards.delete(userId);
    }
  }

  /**
   * Export the main canvas as a data URL
   * @param {string} type - Image type (default: 'image/png')
   * @returns {string} Data URL
   */
  toDataURL(type = 'image/png') {
    return this.#mainCanvas.toDataURL(type);
  }

  /**
   * Set composite operation for main context
   * @param {string} operation - Composite operation name
   */
  setCompositeOperation(operation) {
    this.#mainCtx.globalCompositeOperation = operation;
  }
}
