/**
 * @fileoverview FloodFill tool for filling regions with color.
 * Supports an optional "Advanced" interactive mode where dragging after click
 * adjusts expansion (horizontal) and edge blur (vertical) before committing.
 *
 * Heavy computation (scanline fill, dilation, erosion) runs in a dedicated
 * Web Worker so the main thread stays responsive.
 */

import { blurImageData, getStackblurSync } from '../utils/blurUtils.js';
import { FillWorkerClient } from '../workers/FillWorkerClient.js';

/**
 * Flood fill tool using optimized scanline algorithm via Web Worker.
 */
export class FloodFillTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'fill';
    this.board = board;
    this.advancedMode = true;

    // Interactive state (used only in advanced mode)
    this._active = false;
    this._startPos = null;
    this._clickPos = null;
    this._expansion = 0;
    this._blurRadius = 0;
    this._imageData = null;
    this._fillParams = null;

    // Tracks whether onPointerDown already committed the fill (standard mode)
    this._committed = false;

    // Worker for off-thread computation
    this._fillWorker = new FillWorkerClient();

    // Debounce timer for advanced mode preview updates
    this._previewTimer = null;
    this._pendingPreview = false;
  }

  activate() {
    // Preload stackblur so it's available synchronously for _renderMask
    blurImageData(new ImageData(1, 1), 1, 1, 1).catch(() => {});
  }

  deactivate() {
    this._cancelInteractive();
  }

  // -- helpers --

  _getFillParams(user) {
    const fillColor = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 1];
    const colorAlpha = fillColor[3];
    const opacitySlider = user?.opacity !== undefined
      ? user.opacity
      : (this.board.app?.self?.opacity !== undefined ? this.board.app.self.opacity : 1);
    const userOpacity = colorAlpha * opacitySlider;
    return {
      fillR: Math.round(fillColor[0]),
      fillG: Math.round(fillColor[1]),
      fillB: Math.round(fillColor[2]),
      userOpacity,
      userId: user?.id ?? this.board.app?.self?.id ?? 0,
      activeLayer: user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0,
    };
  }

  _getRegionRects() {
    const userId = this.board.app?.self?.id ?? 0;
    const debugOverlay = this.board.app?.debugOverlay;
    const userRegions = debugOverlay?.userRegions.get(userId)?.regions || null;
    if (!userRegions || userRegions.length === 0) return null;
    // Serialize to plain objects for worker transfer
    return userRegions.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  }

  /**
   * Render a mask to a target canvas context, optionally blurring edges.
   * Runs on main thread (needs canvas context).
   */
  _renderMask(ctx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height) {
    if (!result) return;
    const { mask, minX, minY, maxX, maxY } = result;
    const a = Math.round(userOpacity * 255);

    if (blurRadius <= 0) {
      const regionW = maxX - minX + 1;
      const regionH = maxY - minY + 1;
      const imgData = new ImageData(regionW, regionH);
      const pixels = imgData.data;
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          if (mask[py * width + px]) {
            const oi = ((py - minY) * regionW + (px - minX)) * 4;
            pixels[oi] = fillR;
            pixels[oi + 1] = fillG;
            pixels[oi + 2] = fillB;
            pixels[oi + 3] = a;
          }
        }
      }
      ctx.putImageData(imgData, minX, minY);
      return;
    }

    const br = Math.ceil(blurRadius);
    const padMinX = Math.max(0, minX - br * 2);
    const padMinY = Math.max(0, minY - br * 2);
    const padMaxX = Math.min(width - 1, maxX + br * 2);
    const padMaxY = Math.min(height - 1, maxY + br * 2);
    const padW = padMaxX - padMinX + 1;
    const padH = padMaxY - padMinY + 1;

    const padded = new ImageData(padW, padH);
    const pd = padded.data;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          const oi = ((py - padMinY) * padW + (px - padMinX)) * 4;
          pd[oi] = fillR;
          pd[oi + 1] = fillG;
          pd[oi + 2] = fillB;
          pd[oi + 3] = a;
        }
      }
    }

    const stackblur = getStackblurSync();
    if (stackblur) {
      for (let i = 0; i < pd.length; i += 4) {
        const alpha = pd[i + 3] / 255;
        pd[i] *= alpha;
        pd[i + 1] *= alpha;
        pd[i + 2] *= alpha;
      }
      stackblur(pd, padW, padH, br);
      for (let i = 0; i < pd.length; i += 4) {
        const alpha = pd[i + 3] / 255;
        if (alpha > 0) {
          pd[i] /= alpha;
          pd[i + 1] /= alpha;
          pd[i + 2] /= alpha;
        }
      }
      ctx.putImageData(padded, padMinX, padMinY);
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = padW;
      tmp.height = padH;
      tmp.getContext('2d').putImageData(padded, 0, 0);
      ctx.save();
      ctx.filter = `blur(${blurRadius}px)`;
      ctx.drawImage(tmp, padMinX, padMinY);
      ctx.restore();
    }
  }

  _renderMaskComposite(targetCtx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height) {
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    this._renderMask(tmp.getContext('2d'), result, fillR, fillG, fillB, userOpacity, blurRadius, width, height);
    targetCtx.drawImage(tmp, 0, 0);
  }

  _broadcastFill(user, x, y, layerIndex, expansion, blurRadius) {
    const wsClient = this.board.app?.wsClient;
    if (wsClient && user === this.board.app?.self) {
      wsClient.broadcastFill(x, y, layerIndex, expansion, blurRadius);
    }
  }

  _cancelInteractive() {
    if (this._active) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._fillWorker.invalidate();
    this._active = false;
    this._imageData = null;
    this._fillParams = null;
    this._pendingPreview = false;
  }

  /**
   * Commit a fill result to the stroke canvas.
   * @private
   */
  _commitFillResult(user, result, params, width, height, mirrorResult) {
    if (!result) return;

    this.board.beginStroke(user);
    const strokeCtx = this.board.layerManager.getUserStrokeContext(params.activeLayer, params.userId);
    if (!strokeCtx) return;

    this._renderMask(strokeCtx, result, params.fillR, params.fillG, params.fillB, params.userOpacity, this._blurRadius, width, height);

    const pad = Math.ceil(this._blurRadius * 2) + Math.ceil(Math.abs(this._expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    this.board.expandDirtyRect(user, bx, by, bw, bh);

    if (mirrorResult) {
      this._renderMaskComposite(strokeCtx, mirrorResult, params.fillR, params.fillG, params.fillB, params.userOpacity, this._blurRadius, width, height);
      const mbx = Math.max(0, mirrorResult.minX - pad);
      const mby = Math.max(0, mirrorResult.minY - pad);
      const mbw = Math.min(width, mirrorResult.maxX + pad + 1) - mbx;
      const mbh = Math.min(height, mirrorResult.maxY + pad + 1) - mby;
      this.board.expandDirtyRect(user, mbx, mby, mbw, mbh);
    }

    // Track tile ownership for filled region
    const fillRadius = Math.max(bw, bh) / 2;
    const fillPoints = [
      { x: bx, y: by },
      { x: bx + bw, y: by },
      { x: bx + bw, y: by + bh },
      { x: bx, y: by + bh },
      { x: bx, y: by }
    ];
    this.board.markDirtyPath(user, fillPoints, fillRadius);
    if (mirrorResult) {
      const mbx = Math.max(0, mirrorResult.minX - pad);
      const mby = Math.max(0, mirrorResult.minY - pad);
      const mbw = Math.min(width, mirrorResult.maxX + pad + 1) - mbx;
      const mirrorPoints = [
        { x: mbx, y: mby },
        { x: mbx + mbw, y: mby },
        { x: mbx + mbw, y: mby + (Math.min(height, mirrorResult.maxY + pad + 1) - mby) },
        { x: mbx, y: mby + (Math.min(height, mirrorResult.maxY + pad + 1) - mby) },
        { x: mbx, y: mby }
      ];
      this.board.markDirtyPath(user, mirrorPoints, fillRadius);
    }
  }

  // -- pointer events --

  async onPointerDown(user, pos, e) {
    this._committed = false;
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const params = this._getFillParams(user);
    const regionRects = this._getRegionRects();

    const imageData = this.board.mainCtx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Check target vs fill color similarity
    const startIdx = (y * width + x) * 4;
    const tR = data[startIdx], tG = data[startIdx + 1], tB = data[startIdx + 2], tA = data[startIdx + 3];
    if (tA >= 10) {
      const dr = tR - params.fillR, dg = tG - params.fillG, db = tB - params.fillB, da = tA - 255;
      if (dr * dr + dg * dg + db * db + da * da <= 100) return;
    }

    if (!this.advancedMode) {
      // -- Standard mode: async fill via worker --
      const result = await this._fillWorker.computeFill(
        data, width, height, x, y, 10, 0, regionRects
      );
      if (!result) { this._committed = true; return; }

      let mirrorResult = null;
      if (this.board.mirror) {
        const mx = width - 1 - x;
        if (mx >= 0 && mx < width) {
          // Need fresh imageData copy for mirror since buffer was transferred
          const mirrorData = this.board.mainCtx.getImageData(0, 0, width, height).data;
          mirrorResult = await this._fillWorker.computeFill(
            mirrorData, width, height, mx, y, 10, 0, regionRects
          );
        }
      }

      this._commitFillResult(user, result, params, width, height, mirrorResult);
      this._broadcastFill(user, x, y, params.activeLayer, 0, 0);
      this.board.endStroke(user);
      this._committed = true;
      return;
    }

    // -- Advanced mode: enter interactive drag immediately so move events are captured --
    this._active = true;
    this._startPos = { x: pos.x, y: pos.y };
    this._clickPos = { x, y };
    this._expansion = 0;
    this._blurRadius = 0;
    this._imageData = this.board.mainCtx.getImageData(0, 0, width, height);
    this._fillParams = { ...params, regionRects, width, height, user };

    const initialResult = await this._fillWorker.computeFill(
      data, width, height, x, y, 10, 0, regionRects
    );
    if (!initialResult) { this._active = false; return; }

    const fillArea = (initialResult.maxX - initialResult.minX + 1) * (initialResult.maxY - initialResult.minY + 1);
    const canvasArea = width * height;
    if (fillArea > canvasArea * 0.15) {
      // Fill is too large for interactive mode — immediate commit
      this._active = false;
      let mirrorResult = null;
      if (this.board.mirror) {
        const mx = width - 1 - x;
        if (mx >= 0 && mx < width) {
          const mirrorData = this.board.mainCtx.getImageData(0, 0, width, height).data;
          mirrorResult = await this._fillWorker.computeFill(
            mirrorData, width, height, mx, y, 10, 0, regionRects
          );
        }
      }
      this._commitFillResult(user, initialResult, params, width, height, mirrorResult);
      this._broadcastFill(user, x, y, params.activeLayer, 0, 0);
      this.board.endStroke(user);
      this._committed = true;
      return;
    }

    // Show initial preview (move events may have already updated expansion/blur)
    if (this._expansion !== 0 || this._blurRadius !== 0) {
      this._requestPreviewUpdate();
    } else {
      this._showPreviewResult(initialResult);
    }
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!this._active || !this.advancedMode) return;

    const zoom = this.board.zoom || 1;
    const dx = (pos.x - this._startPos.x) * zoom;
    const dy = (pos.y - this._startPos.y) * zoom;

    this._expansion = Math.max(-40, Math.min(40, dx * 0.3));
    this._blurRadius = Math.max(0, Math.min(20, dy * 0.12));

    this._requestPreviewUpdate();
  }

  /**
   * Throttle preview updates to avoid flooding the worker during fast drags.
   * @private
   */
  _requestPreviewUpdate() {
    if (this._pendingPreview) return;
    this._pendingPreview = true;

    // ~30fps preview updates
    this._previewTimer = setTimeout(() => {
      this._previewTimer = null;
      this._pendingPreview = false;
      this._updatePreviewAsync();
    }, 33);
  }

  async _updatePreviewAsync() {
    if (!this._active || !this._fillParams) return;

    const { width, height, regionRects } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const { x, y } = this._clickPos;

    // Send to worker with current expansion
    const result = await this._fillWorker.computeFill(
      this._imageData.data.slice(0), width, height,
      x, y, 10, this._expansion, regionRects
    );

    // If we've been cancelled while waiting, don't render
    if (!this._active) return;

    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);

    if (result) {
      this._renderMask(topCtx, result, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height);

      if (this.board.mirror) {
        const mx = width - 1 - x;
        if (mx >= 0 && mx < width) {
          const mResult = await this._fillWorker.computeFill(
            this._imageData.data.slice(0), width, height,
            mx, y, 10, this._expansion, regionRects
          );
          if (mResult && this._active) {
            this._renderMaskComposite(topCtx, mResult, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height);
          }
        }
      }
    }
  }

  /**
   * Show a fill result on the preview canvas immediately.
   * @private
   */
  _showPreviewResult(result) {
    if (!result || !this._fillParams) return;
    const { width, height } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);
    this._renderMask(topCtx, result, fillR, fillG, fillB, userOpacity, 0, width, height);
  }

  async onPointerUp(user, pos, e) {
    if (!this._active) {
      if (!this._committed) this.board.endStroke(user);
      return;
    }

    const { width, height, regionRects, activeLayer } = this._fillParams;
    const params = this._fillParams;
    const { x, y } = this._clickPos;

    // Cancel any pending preview
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._pendingPreview = false;

    // Final computation with current expansion
    const result = await this._fillWorker.computeFill(
      this._imageData.data.slice(0), width, height,
      x, y, 10, this._expansion, regionRects
    );

    // Clear preview
    this.board.topCtx.clearRect(0, 0, width, height);

    if (result) {
      let mirrorResult = null;
      if (this.board.mirror) {
        const mx = width - 1 - x;
        if (mx >= 0 && mx < width) {
          mirrorResult = await this._fillWorker.computeFill(
            this._imageData.data.slice(0), width, height,
            mx, y, 10, this._expansion, regionRects
          );
        }
      }

      this._commitFillResult(user, result, params, width, height, mirrorResult);
      this._broadcastFill(user, x, y, activeLayer, this._expansion, this._blurRadius);
      this.board.endStroke(user);
    }

    this._active = false;
    this._imageData = null;
    this._fillParams = null;
  }
}
