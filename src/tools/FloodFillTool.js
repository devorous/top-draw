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
    this._advancedMode = true;

    // Persistent values — maintained between fills, driven by sliders
    this._expansion = 0;
    this._blurRadius = 0;

    // Interactive state (used only in advanced mode)
    this._active = false;
    this._startPos = null;
    this._clickPos = null;
    this._dragStartExpansion = 0;
    this._dragStartBlur = 0;
    this._imageData = null;
    this._fillParams = null;

    // Tracks whether onPointerDown already committed the fill (standard mode)
    this._committed = false;

    // Worker for off-thread computation
    this._fillWorker = new FillWorkerClient();

    // Debounce timer for advanced mode preview updates
    this._previewTimer = null;
    this._pendingPreview = false;
    this._lastTooLargeToast = 0;
  }

  get advancedMode() { return this._advancedMode; }
  set advancedMode(val) {
    this._advancedMode = val;
    if (!val) {
      // Reset persistent fill settings when advanced mode is disabled
      this._expansion = 0;
      this._blurRadius = 0;
      this._updateSliders();
    }
  }

  /** Sync slider DOM elements to current persistent values. */
  _updateSliders() {
    const expSlider = document.getElementById('fillExpansionSlider');
    const expValue = document.getElementById('fillExpansionValue');
    const blurSlider = document.getElementById('fillBlurSlider');
    const blurValue = document.getElementById('fillBlurValue');
    if (expSlider) expSlider.value = this._expansion;
    if (expValue) expValue.textContent = this._expansion;
    if (blurSlider) blurSlider.value = this._blurRadius;
    if (blurValue) blurValue.textContent = this._blurRadius.toFixed(1);
  }

  activate() {
    // Preload stackblur so it's available synchronously for _renderMask
    blurImageData(new ImageData(1, 1), 1, 1, 1).catch(() => {});
  }

  deactivate() {
    if (this._active && this._fillParams) {
      // Finalize the current interactive fill before deactivating
      const user = this._fillParams.user || this.board.app?.self;
      if (user) {
        this.onPointerUp(user, this.board.lastMousePos || this._clickPos);
      }
    }
    this._cancelInteractive();
  }

  compactMemory(options = {}) {
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._pendingPreview = false;
    this._cancelInteractive();
    this._imageData = null;
    this._fillParams = null;
    this._startPos = null;
    this._clickPos = null;
    this._committed = false;

    if (options.recycleWorker && this._fillWorker) {
      this._fillWorker.destroy();
      this._fillWorker = new FillWorkerClient();
    }
  }

  // -- helpers --

  _getFillParams(user) {
    const fillColor = user?.color ?? this.board.app?.self?.color ?? [0, 0, 0, 1];
    const opacitySlider = user?.opacity !== undefined
      ? user.opacity
      : (this.board.app?.self?.opacity !== undefined ? this.board.app.self.opacity : 1);
    // Use only the opacity slider, not color alpha (avoids double application)
    const userOpacity = opacitySlider;
    return {
      fillR: Math.round(fillColor[0]),
      fillG: Math.round(fillColor[1]),
      fillB: Math.round(fillColor[2]),
      userOpacity,
      userId: user?.id ?? this.board.app?.self?.id ?? 0,
      activeLayer: user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0,
    };
  }

  /**
   * Get pattern tile for fill (reuses PatternTool's tile generation logic).
   * @private
   */
  _getPatternTile(user) {
    const brush = user.patternBrush;
    if (!brush) return null;

    let img = brush.image;
    if (brush.type === 'gih' && brush.images) img = brush.images[0];
    if (!img) return null;

    const colorMode = user.patternColorMode || 'original';
    const colorKey = colorMode === 'tinted' ? user.color.join(',') : 'original';
    const spacing = user.patternSpacing || 0;
    const key = `${brush.brushName || brush.fileName}_${colorKey}_${spacing}_${colorMode}`;

    if (!this._patternTileCache) this._patternTileCache = new Map();
    if (this._patternTileCache.has(key)) return this._patternTileCache.get(key);

    // Render SVGs at higher resolution (200px) to avoid pixelation when scaled
    const maxDim = (brush.type === 'svg') ? 200 : 40;
    const imgWidth = img.width || img.naturalWidth;
    const imgHeight = img.height || img.naturalHeight;
    const aspectRatio = imgWidth / imgHeight;

    let tileWidth, tileHeight;
    if (aspectRatio > 1) {
      tileWidth = maxDim;
      tileHeight = maxDim / aspectRatio;
    } else {
      tileWidth = maxDim * aspectRatio;
      tileHeight = maxDim;
    }

    const padding = spacing;
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = tileWidth + padding;
    tileCanvas.height = tileHeight + padding;

    const tctx = tileCanvas.getContext('2d');

    // Disable image smoothing for SVGs to keep them crisp when scaled
    if (brush.type === 'svg') {
      tctx.imageSmoothingEnabled = false;
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = tileWidth;
    tempCanvas.height = tileHeight;
    const tempCtx = tempCanvas.getContext('2d');

    if (brush.type === 'svg') {
      tempCtx.imageSmoothingEnabled = false;
    }

    tempCtx.drawImage(img, 0, 0, tileWidth, tileHeight);

    if (brush.type === 'gbr' && brush.colorDepth === 1) {
      const imageData = tempCtx.getImageData(0, 0, tileWidth, tileHeight);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
        data[i+3] = 255 - brightness;
        data[i] = data[i+1] = data[i+2] = 0;
      }
      tempCtx.putImageData(imageData, 0, 0);
    }

    tctx.save();
    tctx.drawImage(tempCanvas, padding/2, padding/2, tileWidth, tileHeight);

    if (colorMode === 'tinted') {
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, 1.0)`;
      tctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);
    }

    tctx.restore();
    this._patternTileCache.set(key, tileCanvas);
    return tileCanvas;
  }

  /**
   * Render a mask to a target canvas context, optionally blurring edges.
   * Runs on main thread (needs canvas context).
   */
  _renderMask(ctx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user = null) {
    if (!result) return;
    const { mask, minX, minY, maxX, maxY } = result;

    // If pattern mode is enabled and user has a pattern brush, use pattern fill
    if (user && user.patternMode && user.patternBrush) {
      return this._renderMaskPattern(ctx, result, userOpacity, blurRadius, width, height, user);
    }

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
    const padMinX = Math.max(0, minX - br * 3);
    const padMinY = Math.max(0, minY - br * 3);
    const padMaxX = Math.min(width - 1, maxX + br * 3);
    const padMaxY = Math.min(height - 1, maxY + br * 3);
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
      // CSS fallback: Do NOT manually premultiply - canvas handles it internally
      // Manual premultiplication + putImageData causes double premultiplication
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

  /**
   * Render a mask with pattern fill instead of solid color.
   * Works like pattern brush: black fill acts as mask over pattern.
   * @private
   */
  _renderMaskPattern(ctx, result, userOpacity, blurRadius, width, height, user) {
    const { mask, minX, minY, maxX, maxY } = result;

    const tile = this._getPatternTile(user);
    if (!tile) {
      // Fallback to solid color if no pattern
      const [r, g, b] = user.color;
      return this._renderMask(ctx, result, r, g, b, userOpacity, blurRadius, width, height, null);
    }

    let scale = (user.patternScale || 100) / 100;
    // SVGs are rendered at 200px but should display as 40px at 100% scale
    if (user.patternBrush && user.patternBrush.type === 'svg') {
      scale *= 0.2;
    }
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const rotation = user.patternRotation || 0;

    const br = blurRadius > 0 ? Math.ceil(blurRadius) : 0;
    const padMinX = Math.max(0, minX - br * 3);
    const padMinY = Math.max(0, minY - br * 3);
    const padMaxX = Math.min(width - 1, maxX + br * 3);
    const padMaxY = Math.min(height - 1, maxY + br * 3);
    const padW = padMaxX - padMinX + 1;
    const padH = padMaxY - padMinY + 1;

    // Create temp canvas for the mask
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = padW;
    tmpCanvas.height = padH;
    const tmpCtx = tmpCanvas.getContext('2d');

    // Step 1: Render black mask (using regular render with black)
    const regionW = maxX - minX + 1;
    const regionH = maxY - minY + 1;
    const imgData = new ImageData(regionW, regionH);
    const pixels = imgData.data;

    // Fill mask pixels as black
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          const oi = ((py - minY) * regionW + (px - minX)) * 4;
          pixels[oi] = 0;     // R
          pixels[oi + 1] = 0; // G
          pixels[oi + 2] = 0; // B
          pixels[oi + 3] = 255; // A (full opacity for mask)
        }
      }
    }

    tmpCtx.putImageData(imgData, minX - padMinX, minY - padMinY);

    // Apply blur to mask if needed
    if (blurRadius > 0) {
      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = padW;
      blurCanvas.height = padH;
      const blurCtx = blurCanvas.getContext('2d');
      blurCtx.filter = `blur(${blurRadius}px)`;
      blurCtx.drawImage(tmpCanvas, 0, 0);
      tmpCtx.clearRect(0, 0, padW, padH);
      tmpCtx.drawImage(blurCanvas, 0, 0);
    }

    // Step 2: Fill with pattern
    const pattern = tmpCtx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX - padMinX, offsetY - padMinY)
        .rotate(rotation)
        .scale(scale);
      pattern.setTransform(matrix);
    }

    tmpCtx.globalCompositeOperation = 'source-in';
    tmpCtx.globalAlpha = userOpacity;
    tmpCtx.fillStyle = pattern;
    tmpCtx.fillRect(0, 0, padW, padH);

    // Step 3: Draw result to target context
    ctx.drawImage(tmpCanvas, padMinX, padMinY);
  }

  _renderMaskComposite(targetCtx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user = null) {
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    this._renderMask(tmp.getContext('2d'), result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user);
    targetCtx.drawImage(tmp, 0, 0);
  }

  _broadcastFill(user, x, y, layerIndex, expansion, blurRadius) {
    const wsClient = this.board.app?.wsClient;
    if (wsClient && user === this.board.app?.self) {
      this.board.app.inputBufferManager.queueBroadcast(() => wsClient.broadcastFill(x, y, layerIndex, expansion, blurRadius));
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

  _countFilledPixels(result) {
    if (!result?.mask) return 0;
    let filledPixels = 0;
    for (let i = 0; i < result.mask.length; i++) {
      if (result.mask[i]) filledPixels++;
    }
    return filledPixels;
  }

  _isFillTooLarge(result, width, height) {
    const filledPixels = this._countFilledPixels(result);
    const maxPixels = Math.round(width * height * 0.4);
    return filledPixels > maxPixels
      ? { filledPixels, maxPixels }
      : null;
  }

  _warnFillTooLarge(fillLimit, showToast = false) {
    if (!fillLimit) return;
    console.warn(`Fill rejected: ${fillLimit.filledPixels} pixels exceeds 40% of canvas (${fillLimit.maxPixels})`);
    if (!showToast) return;
    const now = Date.now();
    if (now - this._lastTooLargeToast < 1500) return;
    this._lastTooLargeToast = now;
    this.board.app?.ui?.showToast('Fill region too large', 2000);
  }

  /**
   * Commit a fill result to the stroke canvas.
   * @private
   */
  _commitFillResult(user, result, params, width, height, mirrorResults, blurRadius = this._blurRadius, expansion = this._expansion) {
    if (!result) return;

    this.board.beginStroke(user);
    const strokeCtx = this.board.layerManager.getUserStrokeContext(params.activeLayer, params.userId);
    if (!strokeCtx) return;

    this._renderMask(strokeCtx, result, params.fillR, params.fillG, params.fillB, params.userOpacity, blurRadius, width, height, user);

    const pad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    this.board.expandDirtyRect(user, bx, by, bw, bh);

    const mirrors = Array.isArray(mirrorResults) ? mirrorResults : (mirrorResults ? [mirrorResults] : []);
    for (const entry of mirrors) {
      const mirrorResult = entry?.result || entry;
      const region = entry?.region || null;
      if (!mirrorResult) continue;
      if (region) {
        this.board.withMirrorRegionClip(strokeCtx, region, () => {
          this._renderMaskComposite(strokeCtx, mirrorResult, params.fillR, params.fillG, params.fillB, params.userOpacity, blurRadius, width, height, user);
        });
      } else {
        this._renderMaskComposite(strokeCtx, mirrorResult, params.fillR, params.fillG, params.fillB, params.userOpacity, blurRadius, width, height, user);
      }
      const mpad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
      const mbx = Math.max(0, mirrorResult.minX - mpad);
      const mby = Math.max(0, mirrorResult.minY - mpad);
      const mbw = Math.min(width, mirrorResult.maxX + mpad + 1) - mbx;
      const mbh = Math.min(height, mirrorResult.maxY + mpad + 1) - mby;
      this.board.expandDirtyRect(user, mbx, mby, mbw, mbh);
    }
  }

  async _computeMirrorFillResults(imageData, width, height, x, y, expansion, userId) {
    const results = [];
    for (const region of this.board.getActiveMirrorRegions()) {
      if (!region?.synthetic) continue;
      const mirrored = this.board.mirrorPointToRegion({ x, y }, region);
      const mx = Math.round(mirrored.x);
      const my = Math.round(mirrored.y);
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;
      const mirrorResult = await this._fillWorker.computeFill(imageData, width, height, mx, my, 10, expansion, null);
      if (mirrorResult) results.push({ region, result: mirrorResult });
    }
    return results;
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
      // -- Standard mode --
      const result = await this._fillWorker.computeFill(
        data, width, height, x, y, 10, 0, null
      );
      if (!result) { this._committed = true; return; }

      const fillLimit = this._isFillTooLarge(result, width, height);
      if (fillLimit) {
        this._warnFillTooLarge(fillLimit, true);
        this._committed = true;
        return;
      }

      const mirrorResults = await this._computeMirrorFillResults(
        this.board.mainCtx.getImageData(0, 0, width, height).data,
        width,
        height,
        x,
        y,
        0,
        params.userId
      );

      this._commitFillResult(user, result, params, width, height, mirrorResults, 0, 0);
      this._broadcastFill(user, x, y, params.activeLayer, 0, 0);
      this.board.endStroke(user);
      this._committed = true;
      return;
    }

    // -- Advanced mode: enter interactive drag immediately so move events are captured --
    this._active = true;
    this._startPos = { x: pos.x, y: pos.y };
    this._clickPos = { x, y };
    this._dragStartExpansion = this._expansion;
    this._dragStartBlur = this._blurRadius;
    this._imageData = this.board.mainCtx.getImageData(0, 0, width, height);

    this._fillParams = { ...params, width, height, user };

    const initialResult = await this._fillWorker.computeFill(
      data, width, height, x, y, 10, 0, null
    );
    if (!initialResult) { this._active = false; return; }

    const initialFillLimit = this._isFillTooLarge(initialResult, width, height);
    if (initialFillLimit) {
      this._warnFillTooLarge(initialFillLimit, true);
      this._cancelInteractive();
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

    this._expansion = Math.round(Math.max(-50, Math.min(50, this._dragStartExpansion + dx * 0.3)) * 10) / 10;
    this._blurRadius = Math.round(Math.max(0, Math.min(25, this._dragStartBlur + dy * 0.12)) * 10) / 10;
    this._updateSliders();

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

    const { width, height, userId, user } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const { x, y } = this._clickPos;

    const result = await this._fillWorker.computeFill(
      this._imageData.data.slice(0), width, height,
      x, y, 10, this._expansion, null
    );

    // If we've been cancelled while waiting, don't render
    if (!this._active) return;

    const fillLimit = this._isFillTooLarge(result, width, height);
    if (fillLimit) {
      this._warnFillTooLarge(fillLimit, true);
      this._cancelInteractive();
      this._committed = true;
      return;
    }

    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);

    if (result) {
      this._renderMask(topCtx, result, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height, user);

      const mirrorResults = await this._computeMirrorFillResults(
        this._imageData.data.slice(0),
        width,
        height,
        x,
        y,
        this._expansion,
        userId
      );
      for (const entry of mirrorResults) {
        if (!this._active) break;
        this.board.withMirrorRegionClip(topCtx, entry.region, () => {
          this._renderMaskComposite(topCtx, entry.result, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height, user);
        });
      }
    }
  }

  /**
   * Show a fill result on the preview canvas immediately.
   * @private
   */
  _showPreviewResult(result) {
    if (!result || !this._fillParams) return;
    const { width, height, user } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);
    this._renderMask(topCtx, result, fillR, fillG, fillB, userOpacity, 0, width, height, user);
  }

  async onPointerUp(user, pos, e) {
    if (!this._active) {
      if (!this._committed) this.board.endStroke(user);
      return;
    }

    const { width, height, activeLayer, userId } = this._fillParams;
    const params = this._fillParams;
    const { x, y } = this._clickPos;

    // Cancel any pending preview
    if (this._previewTimer !== null) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
    this._pendingPreview = false;

    const result = await this._fillWorker.computeFill(
      this._imageData.data.slice(0), width, height,
      x, y, 10, this._expansion, null
    );

    // Clear preview
    this.board.topCtx.clearRect(0, 0, width, height);

    if (result) {
      const fillLimit = this._isFillTooLarge(result, width, height);
      if (fillLimit) {
        this._warnFillTooLarge(fillLimit, true);
        this._active = false;
        this._imageData = null;
        this._fillParams = null;
        this._committed = true;
        return;
      }

      const mirrorResults = await this._computeMirrorFillResults(
        this._imageData.data.slice(0),
        width,
        height,
        x,
        y,
        this._expansion,
        userId
      );

      this._commitFillResult(user, result, params, width, height, mirrorResults);
      this._broadcastFill(user, x, y, activeLayer, this._expansion, this._blurRadius);
      this.board.endStroke(user);
    }

    this._active = false;
    this._imageData = null;
    this._fillParams = null;
  }
}
