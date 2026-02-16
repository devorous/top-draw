import { blurImageDataWithBackground } from '../utils/drawing.js';

/**
 * Base tool class
 */
class Tool {
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}
}

/**
 * Blur tool - applies stackblur to the area under the square cursor
 */
export class BlurTool extends Tool {
  constructor(board) {
    super('blur', board);
  }

  activate() {
    // No special composite operation needed - we're manipulating pixels directly
  }

  deactivate() {
    // Reset to default if needed
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    this.applyBlur(pos.x, pos.y, user.size, user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.applyBlur(pos.x, pos.y, user.size, user);

    // Mirror mode support
    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.applyBlur(width - pos.x, pos.y, user.size, user);
    }
  }

  /**
   * Apply blur to a square region centered at (x, y) with given size
   */
  applyBlur(x, y, size, user) {
    const ctx = this.board.mainCtx;
    const canvas = this.board.mainCanvas;

    // Calculate the square bounds (centered on cursor)
    const halfSize = size;
    const left = Math.max(0, Math.floor(x - halfSize));
    const top = Math.max(0, Math.floor(y - halfSize));
    const right = Math.min(canvas.width, Math.ceil(x + halfSize));
    const bottom = Math.min(canvas.height, Math.ceil(y + halfSize));

    const width = right - left;
    const height = bottom - top;

    // Don't blur if the area is too small
    if (width <= 0 || height <= 0) return;

    try {
      // Get the ImageData for this region
      const imageData = ctx.getImageData(left, top, width, height);

      // Apply blur with background compositing
      const blurred = blurImageDataWithBackground(
        imageData,
        width,
        height,
        user.blurRadius,
        this.board.backgroundColor
      );

      // Put the blurred ImageData back
      ctx.putImageData(blurred, left, top);
    } catch (error) {
      console.error('Blur error:', error);
    }
  }
}
