/**
 * @fileoverview Hard-pixel brush tool using Bresenham algorithm
 */

import { bresenhamLine, midpointCircle, thickBresenhamLine } from '../utils/hardpixel.js';

/**
 * Brush tool that draws hard pixels (no anti-aliasing)
 */
export class HardPixelBrushTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'hardpixel';
    this.board = board;
    this.lastPos = null;
    this.drawing = false;
    this.currentImageData = null;
    this.tempCanvas = null;
    this.tempCtx = null;
  }

  activate() {
    this.drawing = false;
    this.lastPos = null;
  }

  deactivate() {
    this.drawing = false;
    this.lastPos = null;
    if (this.tempCanvas) {
      this.tempCanvas = null;
      this.tempCtx = null;
      this.currentImageData = null;
    }
  }

  /**
   * Begin drawing
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerDown(user, pos, e) {
    this.drawing = true;
    this.lastPos = { x: Math.floor(pos.x), y: Math.floor(pos.y) };

    // Create temporary canvas for ImageData manipulation
    if (!this.tempCanvas) {
      this.tempCanvas = document.createElement('canvas');
      this.tempCanvas.width = this.board.getWidth();
      this.tempCanvas.height = this.board.getHeight();
      this.tempCtx = this.tempCanvas.getContext('2d', { willReadFrequently: true });
    }

    // Get fresh ImageData
    this.currentImageData = this.tempCtx.createImageData(this.tempCanvas.width, this.tempCanvas.height);

    // Begin stroke
    this.board.beginStroke(user);

    // Draw initial dot
    const color = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 255];
    const size = user?.size ?? this.board.app?.self?.size ?? 5;

    midpointCircle(
      this.currentImageData,
      this.lastPos.x,
      this.lastPos.y,
      size / 2,
      color[0],
      color[1],
      color[2],
      255,
      true
    );

    // Update canvas
    this.tempCtx.putImageData(this.currentImageData, 0, 0);

    const activeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.board.app?.self?.id ?? 0;
    const ctx = this.board.layerManager.getUserStrokeContext(activeLayer, userId);
    if (ctx) {
      ctx.drawImage(this.tempCanvas, 0, 0);
    }

    this.board.expandDirtyRect(user, this.lastPos.x - size, this.lastPos.y - size, size * 2, size * 2);
  }

  /**
   * Continue drawing
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Object} lastPos - Last position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerMove(user, pos, lastPos, e) {
    if (!this.drawing || !this.lastPos) return;

    const currentPos = { x: Math.floor(pos.x), y: Math.floor(pos.y) };
    const color = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 255];
    const size = user?.size ?? this.board.app?.self?.size ?? 5;

    // Draw line from last position to current position
    if (size <= 2) {
      bresenhamLine(
        this.currentImageData,
        this.lastPos.x,
        this.lastPos.y,
        currentPos.x,
        currentPos.y,
        color[0],
        color[1],
        color[2],
        255
      );
    } else {
      thickBresenhamLine(
        this.currentImageData,
        this.lastPos.x,
        this.lastPos.y,
        currentPos.x,
        currentPos.y,
        size,
        color[0],
        color[1],
        color[2],
        255
      );
    }

    // Update canvas
    this.tempCtx.putImageData(this.currentImageData, 0, 0);

    const activeLayer = user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const userId = user?.id ?? this.board.app?.self?.id ?? 0;
    const ctx = this.board.layerManager.getUserStrokeContext(activeLayer, userId);
    if (ctx) {
      ctx.clearRect(0, 0, this.tempCanvas.width, this.tempCanvas.height);
      ctx.drawImage(this.tempCanvas, 0, 0);
    }

    // Calculate dirty rect
    const minX = Math.min(this.lastPos.x, currentPos.x) - size;
    const minY = Math.min(this.lastPos.y, currentPos.y) - size;
    const maxX = Math.max(this.lastPos.x, currentPos.x) + size;
    const maxY = Math.max(this.lastPos.y, currentPos.y) + size;
    this.board.expandDirtyRect(user, minX, minY, maxX - minX, maxY - minY);

    this.lastPos = currentPos;
  }

  /**
   * End drawing
   * @param {Object} user - User object
   * @param {Object} pos - Position {x, y}
   * @param {Event} e - Pointer event
   */
  onPointerUp(user, pos, e) {
    if (!this.drawing) return;

    this.drawing = false;
    this.lastPos = null;

    // Commit the stroke
    this.board.endStroke(user);

    // Clean up
    this.currentImageData = null;
  }
}
