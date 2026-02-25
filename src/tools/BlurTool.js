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
 * Blur tool - applies stackblur to the area under the circular cursor.
 *
 * Each blur gesture is stored as one active stroke. Dabs are applied continuously
 * while the pointer is held down, even if stationary.
 */
export class BlurTool extends Tool {
  constructor(board) {
    super('blur', board);
    this.pendingBlur = Promise.resolve();
    this.activeLoops = new Map(); // userId -> animationFrameID
  }

  activate() {}
  deactivate() {}

  onPointerDown(user, pos) {
    user.lastBlurPos = pos;
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
   * Reads only from the active layer's content and writes blurred pixels 
   * to the user's active stroke canvas using a feathered circular mask.
   */
  async applyBlur(x, y, size, user) {
    const canvasWidth = this.board.getWidth();
    const canvasHeight = this.board.getHeight();

    // Use a slightly larger bounding box for the blur kernel to avoid edge artifacts
    const radius = size;
    const blurRadius = user.blurRadius || 10;
    const margin = Math.ceil(blurRadius);
    
    const left = Math.max(0, Math.floor(x - radius - margin));
    const top = Math.max(0, Math.floor(y - radius - margin));
    const right = Math.min(canvasWidth, Math.ceil(x + radius + margin));
    const bottom = Math.min(canvasHeight, Math.ceil(y + radius + margin));

    const width = right - left;
    const height = bottom - top;

    if (width <= 0 || height <= 0) return;

    try {
      const activeLayerIdx = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
      const group = this.board.layerManager?.getLayerGroup(activeLayerIdx);
      if (!group) return;

      const userId = user.id ?? this.board.app?.self?.id ?? 0;
      const strokeCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, userId);
      if (!strokeCtx) return;

      // Create a temporary canvas to composite just the active layer's content
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      const tempCtx = temp.getContext('2d');

      // 1. Draw base baked content
      tempCtx.drawImage(group.baseCanvas, left, top, width, height, 0, 0, width, height);

      // 2. Draw committed strokes
      for (const stroke of group.strokeStack) {
        tempCtx.globalCompositeOperation = stroke.blendMode;
        tempCtx.drawImage(stroke.canvas, stroke.x - left, stroke.y - top);
      }

      // 3. Draw active strokes (including previous dabs of THIS blur gesture)
      for (const [id, active] of group.activeStrokeByUser) {
        tempCtx.globalCompositeOperation = active.blendMode;
        tempCtx.drawImage(active.canvas, left, top, width, height, 0, 0, width, height);
      }

      // Apply the blur
      const imageData = tempCtx.getImageData(0, 0, width, height);
      const blurred = await blurImageData(imageData, width, height, blurRadius);

      // Now merge the blurred result back into the stroke canvas using a circular mask
      const destImageData = strokeCtx.getImageData(left, top, width, height);
      const destData = destImageData.data;
      const blurredData = blurred.data;
      
      const centerX = x - left;
      const centerY = y - top;
      const radiusSq = radius * radius;
      const featherRange = radius * 0.4; // Soften the edge
      const innerRadius = radius - featherRange;
      const innerRadiusSq = innerRadius * innerRadius;

      for (let i = 0; i < blurredData.length; i += 4) {
        const px = (i / 4) % width;
        const py = Math.floor((i / 4) / width);
        const dx = px - centerX;
        const dy = py - centerY;
        const distSq = dx * dx + dy * dy;

        if (distSq < radiusSq) {
          let weight = 1;
          if (distSq > innerRadiusSq) {
            const dist = Math.sqrt(distSq);
            weight = 1 - (dist - innerRadius) / featherRange;
          }
          
          // Interpolate: replace dest with blurred result based on weight
          destData[i]     = blurredData[i]     * weight + destData[i]     * (1 - weight);
          destData[i + 1] = blurredData[i + 1] * weight + destData[i + 1] * (1 - weight);
          destData[i + 2] = blurredData[i + 2] * weight + destData[i + 2] * (1 - weight);
          destData[i + 3] = blurredData[i + 3] * weight + destData[i + 3] * (1 - weight);
        }
      }
      
      strokeCtx.putImageData(destImageData, left, top);
      this.board.compositeAllLayers();
    } catch (error) {
      console.error('Blur error:', error);
    }
  }
}
