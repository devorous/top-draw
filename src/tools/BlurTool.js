import { blurImageDataWithBackground } from '../utils/blurUtils.js';

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
 * Blur tool - applies stackblur to the area under the square cursor.
 *
 * Each blur gesture is stored as one active stroke: dabs are accumulated on the
 * stroke canvas during the gesture and committed as a single undoable record on
 * pointerUp. Reading from board.mainCtx ensures each dab sees previously blurred
 * content (mainCtx is composited after each dab, including the active stroke).
 */
export class BlurTool extends Tool {
  constructor(board) {
    super('blur', board);
    this.pendingBlur = Promise.resolve();
  }

  activate() {}
  deactivate() {}

  onPointerDown(user, pos) {
    this.board.beginStroke(user);
    this.pendingBlur = this.applyBlur(pos.x, pos.y, user.size, user);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning) return;

    // Chain subsequent dabs so they don't overlap and we can track completion
    this.pendingBlur = this.pendingBlur.then(() => 
      this.applyBlur(pos.x, pos.y, user.size, user)
    );

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.pendingBlur = this.pendingBlur.then(() => 
        this.applyBlur(width - pos.x, pos.y, user.size, user)
      );
    }
  }

  async onPointerUp(user) {
    await this.pendingBlur;
    this.board.clearTop();
    this.board.endStroke(user);
    this.pendingBlur = Promise.resolve();
  }

  /**
   * Apply blur to a square region centered at (x, y).
   * Reads from board.mainCtx (fully composited, includes previous dabs in this gesture)
   * and writes blurred pixels source-over to the user's active stroke canvas.
   */
  async applyBlur(x, y, size, user) {
    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();

    const halfSize = size;
    const left = Math.max(0, Math.floor(x - halfSize));
    const top = Math.max(0, Math.floor(y - halfSize));
    const right = Math.min(canvasWidth, Math.ceil(x + halfSize));
    const bottom = Math.min(canvasHeight, Math.ceil(y + halfSize));

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    try {
      // Read from the composited canvas (includes active stroke's previous dabs)
      const imageData = this.board.mainCtx.getImageData(left, top, width, height);

      const blurred = await blurImageDataWithBackground(
        imageData,
        width,
        height,
        user.blurRadius,
        this.board.backgroundColor
      );

      // Write blurred pixels source-over to the active stroke canvas
      const strokeCtx = this.board.layerManager?.getUserStrokeContext(
        user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0,
        user.id ?? this.board.app?.self?.id ?? 0
      );
      if (strokeCtx) {
        strokeCtx.putImageData(blurred, left, top);
      }

      this.board.compositeAllLayers();
    } catch (error) {
      console.error('Blur error:', error);
    }
  }
}
