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
 * Each blur gesture is stored as one active stroke. Dabs are applied based on distance
 * to prevent lag at high TPS. It reads from a clean snapshot of the layer to prevent
 * destructive feedback loops.
 */
export class BlurTool extends Tool {
  constructor(board) {
    super('blur', board);
    this.pendingBlur = Promise.resolve();
    this.lastStampPos = new Map(); // userId -> {x, y} - last blur application position
  }

  activate() {}
  deactivate() {
    // Clean up on deactivate
    this.lastStampPos.clear();
  }

  /**
   * Capture a snapshot of the committed layer state for this user.
   * Must be called before the first applyBlur of a stroke so applyBlur
   * reads from a stable source (prevents feedback loops).
   * Called by onPointerDown locally and by RemoteUserHandler on mouse-down.
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

    // 1. Draw all baked sequences and compressed groups in chronological order
    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        // Compressed group: draw each stroke in order
        for (const stroke of item.strokes) {
          snapshotCtx.globalCompositeOperation = stroke.blendMode;
          snapshotCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
        }
      } else {
        // Baked sequence: draw as single canvas
        snapshotCtx.globalCompositeOperation = item.blendMode;
        snapshotCtx.drawImage(item.canvas, 0, 0);
      }
    }

    // 2. Draw individual strokes from the stroke stack (recent undo buffer)
    for (const stroke of group.strokeStack) {
      snapshotCtx.globalCompositeOperation = stroke.blendMode;
      snapshotCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    // Reset to default
    snapshotCtx.globalCompositeOperation = 'source-over';

    user.blurSnapshot = snapshotCanvas;
  }

  onPointerDown(user, pos) {
    user.lastBlurPos = pos;
    this.initBlurSnapshot(user);
    this.board.beginStroke(user);
    // Initialize last stamp position
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    // Apply first blur immediately
    this.applyBlur(pos.x, pos.y, user.size, user);
    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.applyBlur(width - pos.x, pos.y, user.size, user);
    }
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;
    
    // Points are provided by InputBufferManager (already smoothed/reduced)
    const prevStamp = this.lastStampPos.get(user.id);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Spacing calculation: 0 = 10% (default), 1-20 = 5%-100% of brush size
      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(1, user.size * spacingPercent);

      if (distance >= minSpacing) {
        this.applyBlur(pos.x, pos.y, user.size, user);

        if (this.board.mirror) {
          const width = this.board.getWidth();
          this.applyBlur(width - pos.x, pos.y, user.size, user);
        }

        // Update last stamp position
        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      }
    } else {
      // First point of the batch after down
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  async onPointerUp(user, pos) {
    await this.pendingBlur;
    this.board.clearTop();
    this.board.endStroke(user);
    this.pendingBlur = Promise.resolve();

    // --- Clean up ---
    user.blurSnapshot = null;
    this.lastStampPos.delete(user.id);
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
      if (!strokeCtx) {
        console.warn('BlurTool: No stroke context available');
        return;
      }
      if (!user.blurSnapshot) {
        console.warn('BlurTool: No blur snapshot available');
        return;
      }

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

      // Reset filter to prevent it from affecting subsequent operations
      tempCtx.filter = 'none';

      // --- Composite onto the main stroke canvas additively, using a circular brush shape ---
      strokeCtx.save();

      // 1. Set up additive blending
      strokeCtx.globalAlpha = 0.5; // This controls the strength of each dab (increased from 0.2 for more visible effect)
      strokeCtx.globalCompositeOperation = 'source-over';
      
      // 2. Create a circular clipping path to define the brush shape
      strokeCtx.beginPath();
      strokeCtx.arc(x, y, radius, 0, Math.PI * 2);
      strokeCtx.clip();

      // 3. Draw the blurred temporary canvas onto the stroke canvas
      strokeCtx.drawImage(temp, left, top);

      // 4. Restore context to remove clip and reset alpha/composite settings
      strokeCtx.restore();

      // Track dirty rect so commitUserStroke can skip expensive getImageData scan
      this.board.expandDirtyRect(user, left, top, width, height);

      this.board.requestUpdate();
    } catch (error) {
      console.error('Blur error:', error);
    }
  }
}
