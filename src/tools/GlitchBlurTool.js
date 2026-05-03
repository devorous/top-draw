/**
 * @fileoverview Glitch Blur tool - identical to BlurTool but forces the
 * stackblur_rgba_glitch algorithm, producing a directional smear artifact.
 */

import * as wasm from '../wasm/ddraw_wasm.js';

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

export class GlitchBlurTool extends Tool {
  constructor(board) {
    super('glitchBlur', board);
    this.lastStampPos = new Map();
    this.strokePoints = new Map(); // userId -> [{x, y}, ...]
    this.snapshotCanvases = new Map(); // userId -> canvas
    this._prevGlitchSetting = false;
  }

  activate() {}

  deactivate() {
    if (this._activeUser) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      if (lastPos) {
        this.onPointerUp(this._activeUser, lastPos);
      }
    }
    this.lastStampPos.clear();
    this.snapshotCanvases.clear();
    // Clear any lingering preview
    if (this.board.topCtx) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    this._activeUser = null;
  }

  captureSnapshot(userId) {
    const sourceCanvas = this.board.mainCanvas || this.board.mainCtx?.canvas;
    if (!sourceCanvas) return;
    let canvas = this.snapshotCanvases.get(userId);
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.snapshotCanvases.set(userId, canvas);
    }
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    canvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
  }

  clearSnapshot(userId) {
    this.snapshotCanvases.delete(userId);
  }

  onPointerDown(user, pos) {
    this._activeUser = user;
    const activeLayerIdx = 0;
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const rawBlurRadius = Number(user.blurRadius);
    user.blurRadius = Math.max(1, Math.min(25, Number.isFinite(rawBlurRadius) ? rawBlurRadius : 10));

    this.captureSnapshot(userId);
    this.board.beginStroke(user);

    const maskCtx = this.board.layerManager?.getUserStrokeContext(activeLayerIdx, userId);
    if (!maskCtx) return;

    user.blurBounds = {
      minX: Infinity, minY: Infinity,
      maxX: -Infinity, maxY: -Infinity
    };

    // Get preview context and clear it once at the start
    let previewCtx = null;
    if (user === this.board.app?.self) {
      previewCtx = this.board.topCtx;
      previewCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    } else if (user.context) {
      previewCtx = user.context;
      previewCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    this.strokePoints.set(userId, [{ x: pos.x, y: pos.y }]);

    const stamp = this._computeGlitchStamp(pos.x, pos.y, user.size, user);
    if (stamp) {
      this._applyStampToCtx(maskCtx, stamp, pos.x, pos.y, user.size, user.pressure || 1.0);
      this._expandBounds(user, pos.x, pos.y, user.size, user.blurRadius);

      // Apply to mirror regions using transforms (compute once, mirror the result)
      this.board.forEachMirrorRegion({ point: pos }, (region) => {
        const mirrored = this.board.mirrorPointToRegion(pos, region);
        this._expandBounds(user, mirrored.x, mirrored.y, user.size, user.blurRadius);
        this.board.withMirroredRegionTransform(maskCtx, region, () => {
          this._applyStampToCtx(maskCtx, stamp, pos.x, pos.y, user.size, user.pressure || 1.0);
        });
      });

      // Draw preview
      if (previewCtx) {
        this._drawStampPreview(previewCtx, pos.x, pos.y, user.size, user.pressure || 1.0);
      }
    }

    this.board.requestUpdate();
  }

  onPointerMove(user, pos, lastPos) {
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRender) {
    if (!user.mousedown || user.panning) return;

    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const maskCtx = this.board.layerManager?.getUserStrokeContext(0, userId);
    if (!maskCtx) return;

    const prevStamp = this.lastStampPos.get(userId);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(user.size * spacingPercent, 5);

      if (distance >= minSpacing) {
        const previewCtx = shouldRender ? (user === this.board.app?.self ? this.board.topCtx : user.context) : null;
        this._stampAlongPath(user, prevStamp, pos, minSpacing, maskCtx, previewCtx);
        if (shouldRender) this.board.requestUpdate();
      }
    } else {
      this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    }
  }

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

    const strokeImage = this._captureLocalStrokeImage(user, userId);
    this.board.endStroke(user);
    this._broadcastLocalStrokeImage(strokeImage);

    this.lastStampPos.delete(userId);
    this.clearSnapshot(userId);
    delete user.blurBounds;

    // Clear preview
    if (user === this.board.app?.self) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.board.requestUpdate();
  }

  _captureLocalStrokeImage(user, userId) {
    if (user !== this.board.app?.self) return null;

    const active = this.board.layerManager?.getActiveStroke(0, userId);
    const sourceCanvas = active?.canvas;
    if (!sourceCanvas) return null;

    let bounds = null;
    if (active.dirtyRect && active.dirtyRect.maxX !== -1) {
      const x = Math.floor(Math.max(0, active.dirtyRect.minX));
      const y = Math.floor(Math.max(0, active.dirtyRect.minY));
      const width = Math.ceil(Math.min(sourceCanvas.width, active.dirtyRect.maxX + 1)) - x;
      const height = Math.ceil(Math.min(sourceCanvas.height, active.dirtyRect.maxY + 1)) - y;
      if (width > 0 && height > 0) bounds = { x, y, width, height };
    }
    if (!bounds && user.blurBounds) {
      const x = Math.floor(Math.max(0, user.blurBounds.minX));
      const y = Math.floor(Math.max(0, user.blurBounds.minY));
      const width = Math.ceil(Math.min(sourceCanvas.width, user.blurBounds.maxX)) - x;
      const height = Math.ceil(Math.min(sourceCanvas.height, user.blurBounds.maxY)) - y;
      if (width > 0 && height > 0) bounds = { x, y, width, height };
    }
    if (!bounds) return null;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = bounds.width;
    cropCanvas.height = bounds.height;
    cropCanvas
      .getContext('2d')
      .drawImage(sourceCanvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);

    return { bounds, cropCanvas };
  }

  _broadcastLocalStrokeImage(strokeImage) {
    if (!strokeImage || !this.board.app?.wsClient || !this.board.app?.connected) return;
    const { bounds, cropCanvas } = strokeImage;

    // Validate bounds before broadcasting
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
        !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
        bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const sendGlitchResult = () => {
      this.board.app.wsClient.broadcastGlitchResult(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        cropCanvas.toDataURL('image/png')
      );
    };

    const inputBufferManager = this.board.app.inputBufferManager;
    if (inputBufferManager?.queueBroadcast) {
      inputBufferManager.queueBroadcast(sendGlitchResult, { snapshot: false });
    } else {
      sendGlitchResult();
    }
  }

  _computeGlitchStamp(x, y, size, user) {
    const radius = size;
    const blurRadius = user.blurRadius || 10;
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const sourceCanvas = this.snapshotCanvases.get(userId) || this.board.mainCanvas || this.board.mainCtx?.canvas;

    if (!sourceCanvas) return null;

    const margin = Math.ceil(blurRadius * 2);
    const cropX = Math.max(0, Math.floor(x - radius - margin));
    const cropY = Math.max(0, Math.floor(y - radius - margin));
    const cropW = Math.min(sourceCanvas.width - cropX, Math.ceil((radius + margin) * 2));
    const cropH = Math.min(sourceCanvas.height - cropY, Math.ceil((radius + margin) * 2));

    if (cropW <= 0 || cropH <= 0) return null;

    const stampCanvas = document.createElement('canvas');
    stampCanvas.width = cropW;
    stampCanvas.height = cropH;
    const stampCtx = stampCanvas.getContext('2d');
    stampCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    try {
      const imageData = stampCtx.getImageData(0, 0, cropW, cropH);
      const blurred = wasm.stackblur_rgba_glitch(
        new Uint8Array(imageData.data.buffer.slice(0)),
        cropW,
        cropH,
        Math.max(1, Math.round(blurRadius))
      );
      stampCtx.putImageData(new ImageData(new Uint8ClampedArray(blurred), cropW, cropH), 0, 0);
    } catch (err) {
      console.warn('Glitch blur WASM failed:', err);
    }

    return { stampCanvas, cropX, cropY };
  }

  _applyStampToCtx(ctx, stamp, x, y, radius, intensity) {
    if (!stamp) return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = intensity;
    ctx.beginPath();
    ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.clip();
    ctx.drawImage(stamp.stampCanvas, stamp.cropX, stamp.cropY);
    ctx.restore();
  }

  _expandBounds(user, x, y, radius, blurRadius) {
    const margin = Math.ceil(blurRadius * 2);
    const left = Math.floor(x - radius - margin);
    const top = Math.floor(y - radius - margin);
    const width = Math.ceil((radius + margin) * 2);
    const height = Math.ceil((radius + margin) * 2);

    this.board.expandDirtyRect(user, left, top, width, height);

    if (user.blurBounds) {
      user.blurBounds.minX = Math.min(user.blurBounds.minX, left);
      user.blurBounds.minY = Math.min(user.blurBounds.minY, top);
      user.blurBounds.maxX = Math.max(user.blurBounds.maxX, left + width);
      user.blurBounds.maxY = Math.max(user.blurBounds.maxY, top + height);
    }
  }

  _stampAlongPath(user, from, to, spacing, maskCtx, previewCtx) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(distance) || distance <= 0) return;

    const steps = Math.floor(distance / spacing);
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const points = this.strokePoints.get(userId);
    let lastStamp = from;

    for (let i = 1; i <= steps; i++) {
      const t = (i * spacing) / distance;
      const x = from.x + dx * t;
      const y = from.y + dy * t;

      const stamp = this._computeGlitchStamp(x, y, user.size, user);
      if (stamp) {
        this._applyStampToCtx(maskCtx, stamp, x, y, user.size, user.pressure || 1.0);
        this._expandBounds(user, x, y, user.size, user.blurRadius);

        // Apply to mirror regions using transforms
        this.board.forEachMirrorRegion({ point: { x, y } }, (region) => {
          const mirrored = this.board.mirrorPointToRegion({ x, y }, region);
          this._expandBounds(user, mirrored.x, mirrored.y, user.size, user.blurRadius);
          this.board.withMirroredRegionTransform(maskCtx, region, () => {
            this._applyStampToCtx(maskCtx, stamp, x, y, user.size, user.pressure || 1.0);
          });
        });

        // Draw preview
        if (previewCtx) {
          this._drawStampPreview(previewCtx, x, y, user.size, user.pressure || 1.0);
        }
      }

      points?.push({ x, y });
      lastStamp = { x, y };
    }

    this.lastStampPos.set(userId, lastStamp);
  }

  _drawStampPreview(ctx, x, y, size, pressure) {
    const alpha = pressure * 0.3;

    ctx.save();

    const gradient = ctx.createLinearGradient(x - size, y, x + size, y);
    gradient.addColorStop(0, `rgba(128, 128, 128, 0)`);
    gradient.addColorStop(0.3, `rgba(128, 128, 128, ${alpha})`);
    gradient.addColorStop(0.7, `rgba(128, 128, 128, ${alpha})`);
    gradient.addColorStop(1, `rgba(128, 128, 128, 0)`);

    ctx.fillStyle = gradient;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);

    ctx.strokeStyle = `rgba(100, 100, 100, ${alpha * 0.5})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - size, y - size, size * 2, size * 2);

    ctx.restore();
  }
}
