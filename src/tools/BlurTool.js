/**
 * @fileoverview Blur tool - stamps blurred pixels sampled from the active layer.
 */

import { Tool } from './BaseTool.js';

/**
 * Blur tool that behaves like an image brush: each stamp samples from a
 * stroke-start snapshot, blurs that sample, and paints the resulting pixels
 * into the active stroke canvas.
 */
export class BlurTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('blur', board);
    this.lastStampPos = new Map(); // userId -> {x, y}
    this.strokePoints = new Map(); // userId -> [{x, y}, ...]
    this.snapshotCanvases = new Map(); // userId -> canvas
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
    this.snapshotCanvases.clear();
    this._activeUser = null;
  }

  _getTargetLayer(user) {
    return user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
  }

  captureSnapshot(userId, layerIdx) {
    let canvas = this.snapshotCanvases.get(userId);
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.snapshotCanvases.set(userId, canvas);
    }
    canvas.width = this.board.getWidth();
    canvas.height = this.board.getHeight();
    const ctx = canvas.getContext('2d');

    // Snapshot only the target layer so upper-layer pixels cannot be blurred
    // into this layer's stroke.
    this.board.layerManager.compositeLayerRange(ctx, layerIdx, layerIdx + 1, null);
  }

  clearSnapshot(userId) {
    this.snapshotCanvases.delete(userId);
  }

  /**
   * Handles pointer down event.
   * Begins a regular stroke and starts stamping blurred pixels.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    this._activeUser = user;
    const activeLayerIdx = this._getTargetLayer(user);
    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    const rawBlurRadius = Number(user.blurRadius);
    user.blurRadius = Math.max(1, Math.min(10, Number.isFinite(rawBlurRadius) ? rawBlurRadius : 10));

    this.captureSnapshot(userId, activeLayerIdx);
    this.board.beginStroke(user);

    const maskCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, userId);
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

    this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    this.strokePoints.set(userId, [{ x: pos.x, y: pos.y }]);

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
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRequestUpdate) {
    if (!user.mousedown || user.panning) return;

    const activeLayerIdx = this._getTargetLayer(user);
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const maskCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, userId);
    if (!maskCtx) return;

    const prevStamp = this.lastStampPos.get(userId);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(user.size * spacingPercent, 5); // Min 5px spacing

      if (distance >= minSpacing) {
        const points = this.strokePoints.get(userId);
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

        this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
        if (shouldRequestUpdate) this.board.requestUpdate();
      }
    } else {
      this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    }
  }

  /**
   * Handles pointer up event.
   * Commits the regular stroke containing the stamped blur pixels.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerUp(user, pos) {
    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    // Track tile ownership
    const points = this.strokePoints.get(userId);
    if (points && points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.strokePoints.delete(userId);

    this.board.endStroke(user);
    this.lastStampPos.delete(userId);
    this.clearSnapshot(userId);
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

    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const sourceCanvas = this.snapshotCanvases.get(userId) || this.board.mainCanvas || this.board.mainCtx?.canvas;
    if (sourceCanvas) {
      const margin = Math.ceil(blurRadius * 2);
      const cropX = Math.max(0, Math.floor(x - radius - margin));
      const cropY = Math.max(0, Math.floor(y - radius - margin));
      const cropW = Math.min(sourceCanvas.width - cropX, Math.ceil((radius + margin) * 2));
      const cropH = Math.min(sourceCanvas.height - cropY, Math.ceil((radius + margin) * 2));

      if (cropW > 0 && cropH > 0) {
        const blurCanvas = document.createElement('canvas');
        blurCanvas.width = cropW;
        blurCanvas.height = cropH;
        const blurCtx = blurCanvas.getContext('2d');

        blurCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        // Apply blur to the intermediate canvas
        blurCtx.filter = `blur(${blurRadius * 0.5}px)`;
        blurCtx.drawImage(blurCanvas, 0, 0);
        blurCtx.filter = 'none';

        maskCtx.save();
        maskCtx.globalCompositeOperation = 'source-over';
        maskCtx.globalAlpha = intensity;

        // Clip to the stamp's square region so blur bleeds don't overwrite
        // pixels outside the stamp footprint.
        maskCtx.beginPath();
        maskCtx.rect(x - radius, y - radius, radius * 2, radius * 2);
        maskCtx.clip();

        maskCtx.drawImage(blurCanvas, 0, 0, cropW, cropH, cropX, cropY, cropW, cropH);

        maskCtx.restore();
      }
    }

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
