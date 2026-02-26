import { blurImageData } from '../utils/blurUtils.js';

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
 * Blur tool - applies a GPU-accelerated blur to the area under the circular cursor.
 *
 * Each blur gesture is stored as one active stroke. Dabs are applied continuously
 * and additively while the pointer is held down, even if stationary. It reads from a
 * clean snapshot of the layer to prevent destructive feedback loops.
 */
export class BlurTool extends Tool {
  constructor(board) {
    super('blur', board);
    this.pendingBlur = Promise.resolve();
    this.activeLoops = new Map(); // userId -> animationFrameID
  }

  activate() {}
  deactivate() {}

  /**
   * Capture a snapshot of the committed layer state for this user.
   * Must be called before the first applyBlur of a stroke so applyBlur
   * reads from a stable source (prevents feedback loops).
   * Called by onPointerDown locally and by RemoteUserHandler on mouse-down.
   */
  initBlurSnapshot(user) {
    const activeLayerIdx = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const group = this.board.layerManager?.getLayerGroup(activeLayerIdx);
    if (!group) return;

    const snapshotCanvas = document.createElement('canvas');
    snapshotCanvas.width = this.board.getWidth();
    snapshotCanvas.height = this.board.getHeight();
    const snapshotCtx = snapshotCanvas.getContext('2d');

    snapshotCtx.drawImage(group.baseCanvas, 0, 0);
    for (const stroke of group.strokeStack) {
      snapshotCtx.globalCompositeOperation = stroke.blendMode;
      snapshotCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    user.blurSnapshot = snapshotCanvas;
  }

  onPointerDown(user, pos) {
    user.lastBlurPos = pos;
    this.initBlurSnapshot(user);
    this.board.beginStroke(user);
    this.startBlurLoop(user);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning) return;
    user.lastBlurPos = pos;
  }

  async onPointerUp(user) {
    this.stopBlurLoop(user);
    await this.pendingBlur;
    this.board.clearTop();
    this.board.endStroke(user);
    this.pendingBlur = Promise.resolve();

    // --- Clean up snapshot ---
    user.blurSnapshot = null;
  }

  startBlurLoop(user) {
    if (this.activeLoops.has(user.id)) return;

    const loop = () => {
      if (!user.mousedown || user.panning) {
        this.stopBlurLoop(user);
        return;
      }

      const pos = user.lastBlurPos;
      if (pos) {
        // No need for pendingBlur promise chain with this simpler implementation
        this.applyBlur(pos.x, pos.y, user.size, user);

        if (this.board.mirror) {
          const width = this.board.getWidth();
          this.applyBlur(width - pos.x, pos.y, user.size, user);
        }
      }

      this.activeLoops.set(user.id, requestAnimationFrame(loop));
    };

    this.activeLoops.set(user.id, requestAnimationFrame(loop));
  }

  stopBlurLoop(user) {
    const frameId = this.activeLoops.get(user.id);
    if (frameId !== undefined) {
      cancelAnimationFrame(frameId);
      this.activeLoops.delete(user.id);
    }
  }

  /**
   * Apply blur to a circular region centered at (x, y).
   * Reads from a clean snapshot, applies a hardware-accelerated blur,
   * and draws the result additively to the stroke canvas.
   */
  applyBlur(x, y, size, user) {
    const blurAmount = user.blurRadius || 10;
    const radius = size;
    
    // Bounding box for the update region, expanded to accommodate the blur effect
    const margin = Math.ceil(blurAmount);
    const left = Math.max(0, Math.floor(x - radius - margin));
    const top = Math.max(0, Math.floor(y - radius - margin));
    const right = Math.min(this.board.getWidth(), Math.ceil(x + radius + margin));
    const bottom = Math.min(this.board.getHeight(), Math.ceil(y + radius + margin));

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    try {
      const activeLayerIdx = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
      const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, user.id);
      if (!strokeCtx || !user.blurSnapshot) return;

      // Use a single temporary canvas for the blur operation
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      const tempCtx = temp.getContext('2d');

      // Apply the browser's native blur filter to the temp context
      tempCtx.filter = `blur(${blurAmount}px)`;

      // Draw the region from the clean snapshot into the temp canvas.
      // The filter will be applied to this drawing operation.
      // We draw with a margin inside the temp canvas to prevent the blur from getting clipped at the edges.
      tempCtx.drawImage(user.blurSnapshot, 
        left, top, width, height, // Source rect from snapshot
        0, 0, width, height      // Destination rect in temp canvas
      );

      // --- Composite onto the main stroke canvas additively, using a circular brush shape ---
      strokeCtx.save();
      
      // 1. Set up additive blending
      strokeCtx.globalAlpha = 0.2; // This controls the strength of each dab
      strokeCtx.globalCompositeOperation = 'source-over';
      
      // 2. Create a circular clipping path to define the brush shape
      strokeCtx.beginPath();
      strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
      strokeCtx.clip();

      // 3. Draw the blurred temporary canvas onto the stroke canvas
      strokeCtx.drawImage(temp, left, top);
      
      // 4. Restore context to remove clip and reset alpha/composite settings
      strokeCtx.restore();

      this.board.compositeAllLayers();
    } catch (error) {
      console.error('Blur error:', error);
    }
  }
}
