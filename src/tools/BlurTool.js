/**
 * @fileoverview Blur tool - applies a filter-based blur to the area under the circular cursor.
 * Creates a mask during the stroke and applies blur as a filter at composite time.
 */

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
 * Blur tool that creates filter layers instead of painting pixels.
 * Builds up an intensity mask during the stroke which is used to blend
 * between original and blurred content at composite time.
 */
export class BlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('blur', board);
    this.lastStampPos = new Map(); // userId -> {x, y}
    this.strokePoints = new Map(); // userId -> [{x, y}, ...]
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    if (this._activeUser) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      if (lastPos) {
        this.onPointerUp(this._activeUser, lastPos);
      }
    }
    this.lastStampPos.clear();
    this._activeUser = null;
  }

  /**
   * Handles pointer down event.
   * Begins a filter stroke and starts building the mask.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    // Blur always targets layer 0 - it reads from the fully composited image
    // which includes the white background, so it can't work on transparent layers
    const activeLayerIdx = 0;

    // Store blur radius for this user
    user.blurRadius = user.blurRadius || 10;

    // Get the stroke context - this will be our mask canvas
    // Pass metadata so the active stroke is marked as a blur filter from the start
    const maskCtx = this.board.layerManager?.getUserStrokeContext(
      activeLayerIdx,
      user.id,
      'source-over',
      { filterType: 'blur', blurRadius: user.blurRadius }
    );
    if (!maskCtx) {
      console.warn('BlurTool: No stroke context available');
      return;
    }

    // Initialize bounds tracking for this stroke
    user.blurBounds = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity
    };

    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.strokePoints.set(user.id, [{ x: pos.x, y: pos.y }]);

    // Paint the first mask stamp
    this.paintMask(pos.x, pos.y, user.size, user, maskCtx);

    this.board.forEachMirrorRegion({ point: pos }, (region) => {
      const mirrored = this.board.mirrorPointToRegion(pos, region);
      this.board.withMirrorRegionClip(maskCtx, region, () => {
        this.paintMask(mirrored.x, mirrored.y, user.size, user, maskCtx);
      });
    });

    this.board.requestUpdate();
  }

  /**
   * Handles pointer move event.
   * Continues building the mask.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   */
  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const activeLayerIdx = 0;
    const maskCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, user.id);
    if (!maskCtx) return;

    const prevStamp = this.lastStampPos.get(user.id);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(user.size * spacingPercent, 5); // Min 5px spacing

      if (distance >= minSpacing) {
        const points = this.strokePoints.get(user.id);
        const steps = Math.max(1, Math.ceil(distance / minSpacing));

        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const stampX = prevStamp.x + dx * t;
          const stampY = prevStamp.y + dy * t;
          this.paintMask(stampX, stampY, user.size, user, maskCtx);

          this.board.forEachMirrorRegion({ point: { x: stampX, y: stampY } }, (region) => {
            const mirrored = this.board.mirrorPointToRegion({ x: stampX, y: stampY }, region);
            this.board.withMirrorRegionClip(maskCtx, region, () => {
              this.paintMask(mirrored.x, mirrored.y, user.size, user, maskCtx);
            });
          });

          if (points) points.push({ x: stampX, y: stampY });
        }

        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
        this.board.requestUpdate();
      }
    } else {
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  /**
   * Handles pointer up event.
   * Commits the filter stroke with metadata and accurate bounds.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos) {
    const activeLayerIdx = 0;
    const blurRadius = user.blurRadius || 10;

    // Get the bounds we tracked during painting
    const bounds = user.blurBounds || {
      minX: 0,
      minY: 0,
      maxX: this.board.getWidth(),
      maxY: this.board.getHeight()
    };

    // Clamp to canvas bounds
    const x = Math.max(0, Math.floor(bounds.minX));
    const y = Math.max(0, Math.floor(bounds.minY));
    const maxX = Math.min(this.board.getWidth(), Math.ceil(bounds.maxX));
    const maxY = Math.min(this.board.getHeight(), Math.ceil(bounds.maxY));
    const width = maxX - x;
    const height = maxY - y;

    // Store blur metadata and bounds on the stroke
    const extraProps = {
      filterType: 'blur',
      blurRadius: blurRadius,
      // Pass crop bounds for optimized filter application
      cropBounds: { x, y, width, height }
    };

    // Track tile ownership
    const points = this.strokePoints.get(user.id);
    if (points && points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.strokePoints.delete(user.id);

    this.board.endStroke(user, extraProps);
    this.lastStampPos.delete(user.id);
    delete user.blurBounds;
    this.board.requestUpdate();
  }

  /**
   * Paint a square mask stamp at the given position.
   * Square masks work better with edge feathering.
   * @param {number} x - Center x-coordinate.
   * @param {number} y - Center y-coordinate.
   * @param {number} size - Radius/half-width of the mask square.
   * @param {Object} user - The user performing the action.
   * @param {CanvasRenderingContext2D} maskCtx - The mask context to paint into.
   */
  paintMask(x, y, size, user, maskCtx) {
    const radius = size;
    const blurRadius = user.blurRadius || 10;
    const intensity = user.pressure || 1.0;

    maskCtx.save();
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.globalAlpha = intensity;
    maskCtx.fillStyle = '#ffffff';

    // Draw a square instead of circle for better feathering
    maskCtx.fillRect(x - radius, y - radius, radius * 2, radius * 2);

    maskCtx.restore();

    // Expand dirty rect (include blur radius margin)
    const margin = Math.ceil(blurRadius * 2);
    const left = Math.floor(x - radius - margin);
    const top = Math.floor(y - radius - margin);
    const width = Math.ceil((radius + margin) * 2);
    const height = Math.ceil((radius + margin) * 2);
    this.board.expandDirtyRect(user, left, top, width, height);

    // Update bounds for this blur stroke
    if (user.blurBounds) {
      user.blurBounds.minX = Math.min(user.blurBounds.minX, left);
      user.blurBounds.minY = Math.min(user.blurBounds.minY, top);
      user.blurBounds.maxX = Math.max(user.blurBounds.maxX, left + width);
      user.blurBounds.maxY = Math.max(user.blurBounds.maxY, top + height);
    }
  }
}
