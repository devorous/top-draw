/**
 * @fileoverview Blur tool - applies a GPU-accelerated blur to the area under the circular cursor.
 */

import { blurImageData } from '../utils/blurUtils.js';

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Blur tool for softening areas of the canvas.
 */
export class BlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('blur', board);
    this.pendingBlur = Promise.resolve();
    this.lastStampPos = new Map(); // userId -> {x, y}
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    this.lastStampPos.clear();
  }

  /**
   * Capture a snapshot of the committed layer state for this user.
   * @param {Object} user - The user for whom to initialize the snapshot.
   */
  initBlurSnapshot(user) {
    const activeLayerIdx = user.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
    const group = this.board.layerManager?.getLayerGroup(activeLayerIdx);
    if (!group) {
      console.warn('BlurTool: No layer group found for snapshot');
      return;
    }

    const snapshotCanvas = document.createElement('canvas');
    snapshotCanvas.width = this.board.getWidth();
    snapshotCanvas.height = this.board.getHeight();
    const snapshotCtx = snapshotCanvas.getContext('2d');

    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          snapshotCtx.globalCompositeOperation = stroke.blendMode;
          snapshotCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
        }
      } else {
        snapshotCtx.globalCompositeOperation = item.blendMode;
        snapshotCtx.drawImage(item.canvas, 0, 0);
      }
    }

    for (const stroke of group.strokeStack) {
      snapshotCtx.globalCompositeOperation = stroke.blendMode;
      snapshotCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    snapshotCtx.globalCompositeOperation = 'source-over';
    user.blurSnapshot = snapshotCanvas;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    user.lastBlurPos = pos;
    this.initBlurSnapshot(user);
    this.board.beginStroke(user);
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.applyBlur(pos.x, pos.y, user.size, user);
    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.applyBlur(width - pos.x, pos.y, user.size, user);
    }
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;
    
    const prevStamp = this.lastStampPos.get(user.id);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(1, user.size * spacingPercent);

      if (distance >= minSpacing) {
        this.applyBlur(pos.x, pos.y, user.size, user);

        if (this.board.mirror) {
          const width = this.board.getWidth();
          this.applyBlur(width - pos.x, pos.y, user.size, user);
        }

        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      }
    } else {
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  async onPointerUp(user, pos) {
    await this.pendingBlur;
    this.board.clearTop();
    this.board.endStroke(user);
    this.pendingBlur = Promise.resolve();

    user.blurSnapshot = null;
    this.lastStampPos.delete(user.id);
  }

  /**
   * Apply blur to a circular region centered at (x, y).
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} size - Radius of the blur area.
   * @param {Object} user - The user performing the blur.
   */
  applyBlur(x, y, size, user) {
    const blurAmount = user.blurRadius || 10;
    const radius = size;

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
      if (!strokeCtx) {
        console.warn('BlurTool: No stroke context available');
        return;
      }
      if (!user.blurSnapshot) {
        console.warn('BlurTool: No blur snapshot available');
        return;
      }

      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      const tempCtx = temp.getContext('2d');

      tempCtx.filter = `blur(${blurAmount}px)`;
      tempCtx.drawImage(user.blurSnapshot,
        left, top, width, height, 
        0, 0, width, height     
      );

      tempCtx.filter = 'none';

      strokeCtx.save();
      strokeCtx.globalAlpha = 0.5; 
      strokeCtx.globalCompositeOperation = 'source-over';
      
      strokeCtx.beginPath();
      strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
      strokeCtx.clip();

      strokeCtx.drawImage(temp, left, top);
      strokeCtx.restore();

      this.board.expandDirtyRect(user, left, top, width, height);
      this.board.requestUpdate();
    } catch (error) {
      console.error('Blur error:', error);
    }
  }
}
