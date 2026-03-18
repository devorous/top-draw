/**
 * @fileoverview FloodFill tool for filling regions with color.
 * Supports an optional "Advanced" interactive mode where dragging after click
 * adjusts expansion (horizontal) and edge blur (vertical) before committing.
 */

import { blurImageData, getStackblurSync } from '../utils/blurUtils.js';

/**
 * Flood fill tool using optimized scanline algorithm.
 * Works best on hard-pixel data with precise boundaries.
 */
export class FloodFillTool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    this.name = 'fill';
    this.board = board;
    this.advancedMode = false;

    // Interactive state (used only in advanced mode)
    this._active = false;
    this._startPos = null;       // click origin for drag delta
    this._clickPos = null;       // flood-fill seed {x,y}
    this._expansion = 0;         // mask dilation in pixels
    this._blurRadius = 0;        // edge blur radius
    this._imageData = null;      // snapshot at click time
    this._fillParams = null;     // cached color / region info
  }

  activate() {
    // Preload stackblur so it's available synchronously during interactive drag
    blurImageData(new ImageData(1, 1), 1, 1, 1).catch(() => {});
  }

  deactivate() {
    this._cancelInteractive();
  }

  // ── helpers ───────────────────────────────────────────────────────────

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

  _getRegionConstraint() {
    const userId = this.board.app?.self?.id ?? 0;
    const debugOverlay = this.board.app?.debugOverlay;
    const userRegions = debugOverlay?.userRegions.get(userId)?.regions || null;
    const hasRegions = userRegions && userRegions.length > 0;
    return hasRegions
      ? (px, py) => {
          for (let i = 0; i < userRegions.length; i++) {
            const r = userRegions[i];
            if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) return true;
          }
          return false;
        }
      : null;
  }

  /**
   * Run the scanline flood fill and return a Uint8Array mask (1 = filled).
   * Also returns bounds {minX, minY, maxX, maxY}.
   */
  _computeMask(data, width, height, sx, sy, tolerance, inRegion) {
    const startIdx = (sy * width + sx) * 4;
    const tR = data[startIdx];
    const tG = data[startIdx + 1];
    const tB = data[startIdx + 2];
    const tA = data[startIdx + 3];

    const fillTransparentOnly = tA < 10;
    const tolSq = tolerance * tolerance;

    const matchPixel = fillTransparentOnly
      ? (idx) => data[idx + 3] < 10
      : (idx) => {
          const dr = data[idx] - tR;
          const dg = data[idx + 1] - tG;
          const db = data[idx + 2] - tB;
          const da = data[idx + 3] - tA;
          return dr * dr + dg * dg + db * db + da * da <= tolSq;
        };

    const mask = new Uint8Array(width * height);

    const canFill = (px, py) => {
      if (px < 0 || px >= width || py < 0 || py >= height) return false;
      const vi = py * width + px;
      if (mask[vi]) return false;
      if (inRegion && !inRegion(px, py)) return false;
      return matchPixel(vi * 4);
    };

    if (!canFill(sx, sy)) return null;

    let minX = width, maxX = 0, minY = height, maxY = 0;

    const stack = new Int32Array(Math.min(width * height, 500000) * 2);
    let stackPtr = 0;
    stack[stackPtr++] = sx;
    stack[stackPtr++] = sy;

    while (stackPtr > 0) {
      const row = stack[--stackPtr];
      const col = stack[--stackPtr];
      if (mask[row * width + col]) continue;

      let left = col;
      while (left > 0 && canFill(left - 1, row)) left--;
      let right = col;
      while (right < width - 1 && canFill(right + 1, row)) right++;

      for (let i = left; i <= right; i++) mask[row * width + i] = 1;

      if (left < minX) minX = left;
      if (right > maxX) maxX = right;
      if (row < minY) minY = row;
      if (row > maxY) maxY = row;

      for (let dy = -1; dy <= 1; dy += 2) {
        const ny = row + dy;
        if (ny < 0 || ny >= height) continue;
        let i = left;
        while (i <= right) {
          while (i <= right && !canFill(i, ny)) i++;
          if (i > right) break;
          stack[stackPtr++] = i;
          stack[stackPtr++] = ny;
          while (i <= right && canFill(i, ny)) i++;
        }
      }
    }

    if (minX > maxX) return null;
    return { mask, minX, minY, maxX, maxY };
  }

  /**
   * Dilate (expand) a mask by `radius` pixels using a two-pass distance transform.
   * Much faster than per-pixel neighborhood search — O(region) instead of O(region * r^2).
   */
  _dilateMask(result, radius, width, height) {
    if (!result || radius <= 0) return result;
    const { mask, minX, minY, maxX, maxY } = result;
    const r = Math.ceil(radius);

    // Work area with padding, clamped to canvas
    const eMinX = Math.max(0, minX - r);
    const eMinY = Math.max(0, minY - r);
    const eMaxX = Math.min(width - 1, maxX + r);
    const eMaxY = Math.min(height - 1, maxY + r);
    const rw = eMaxX - eMinX + 1;
    const rh = eMaxY - eMinY + 1;

    // Squared-distance field (Chebyshev approximation via two separable passes)
    const INF = 1e9;
    const dist = new Float32Array(rw * rh);
    dist.fill(INF);

    // Initialize: mask pixels get distance 0
    for (let py = minY; py <= maxY; py++) {
      const ry = py - eMinY;
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          dist[ry * rw + (px - eMinX)] = 0;
        }
      }
    }

    // Horizontal pass: propagate left then right (squared Euclidean on x)
    for (let ry = 0; ry < rh; ry++) {
      const row = ry * rw;
      // left to right
      for (let rx = 1; rx < rw; rx++) {
        const prev = dist[row + rx - 1];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[row + rx]) dist[row + rx] = dSq;
        }
      }
      // right to left
      for (let rx = rw - 2; rx >= 0; rx--) {
        const prev = dist[row + rx + 1];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[row + rx]) dist[row + rx] = dSq;
        }
      }
    }

    // Vertical pass: propagate up then down
    for (let rx = 0; rx < rw; rx++) {
      for (let ry = 1; ry < rh; ry++) {
        const prev = dist[(ry - 1) * rw + rx];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq;
        }
      }
      for (let ry = rh - 2; ry >= 0; ry--) {
        const prev = dist[(ry + 1) * rw + rx];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq;
        }
      }
    }

    // Threshold: pixels with distance <= radius are in the dilated mask
    const rSq = r * r;
    const dilated = new Uint8Array(width * height);
    let dMinX = width, dMaxX = 0, dMinY = height, dMaxY = 0;

    for (let ry = 0; ry < rh; ry++) {
      const py = ry + eMinY;
      for (let rx = 0; rx < rw; rx++) {
        if (dist[ry * rw + rx] <= rSq) {
          const px = rx + eMinX;
          dilated[py * width + px] = 1;
          if (px < dMinX) dMinX = px;
          if (px > dMaxX) dMaxX = px;
          if (py < dMinY) dMinY = py;
          if (py > dMaxY) dMaxY = py;
        }
      }
    }

    if (dMinX > dMaxX) return result;
    return { mask: dilated, minX: dMinX, minY: dMinY, maxX: dMaxX, maxY: dMaxY };
  }

  /**
   * Erode (shrink) a mask by `radius` pixels using a two-pass distance transform.
   * Removes mask pixels that are within `radius` of the nearest non-mask pixel.
   */
  _erodeMask(result, radius, width, height) {
    if (!result || radius <= 0) return result;
    const { mask, minX, minY, maxX, maxY } = result;
    const r = Math.ceil(radius);

    // Pad work area by 1px so edge mask pixels see the non-mask boundary
    const padMinX = Math.max(0, minX - 1);
    const padMinY = Math.max(0, minY - 1);
    const padMaxX = Math.min(width - 1, maxX + 1);
    const padMaxY = Math.min(height - 1, maxY + 1);
    const rw = padMaxX - padMinX + 1;
    const rh = padMaxY - padMinY + 1;

    // Distance from nearest non-mask pixel (0 = non-mask, INF = deep interior)
    const INF = 1e9;
    const dist = new Float32Array(rw * rh);

    for (let ry = 0; ry < rh; ry++) {
      const py = ry + padMinY;
      for (let rx = 0; rx < rw; rx++) {
        const px = rx + padMinX;
        dist[ry * rw + rx] = mask[py * width + px] ? INF : 0;
      }
    }

    // Horizontal pass
    for (let ry = 0; ry < rh; ry++) {
      const row = ry * rw;
      for (let rx = 1; rx < rw; rx++) {
        const prev = dist[row + rx - 1];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[row + rx]) dist[row + rx] = dSq;
        }
      }
      for (let rx = rw - 2; rx >= 0; rx--) {
        const prev = dist[row + rx + 1];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[row + rx]) dist[row + rx] = dSq;
        }
      }
    }

    // Vertical pass
    for (let rx = 0; rx < rw; rx++) {
      for (let ry = 1; ry < rh; ry++) {
        const prev = dist[(ry - 1) * rw + rx];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq;
        }
      }
      for (let ry = rh - 2; ry >= 0; ry--) {
        const prev = dist[(ry + 1) * rw + rx];
        if (prev < INF) {
          const d = Math.sqrt(prev) + 1;
          const dSq = d * d;
          if (dSq < dist[ry * rw + rx]) dist[ry * rw + rx] = dSq;
        }
      }
    }

    // Keep only mask pixels with distance > radius from boundary
    const rSq = r * r;
    const eroded = new Uint8Array(width * height);
    let eMinX = width, eMaxX = 0, eMinY = height, eMaxY = 0;

    for (let ry = 0; ry < rh; ry++) {
      const py = ry + padMinY;
      for (let rx = 0; rx < rw; rx++) {
        if (dist[ry * rw + rx] > rSq) {
          const px = rx + padMinX;
          eroded[py * width + px] = 1;
          if (px < eMinX) eMinX = px;
          if (px > eMaxX) eMaxX = px;
          if (py < eMinY) eMinY = py;
          if (py > eMaxY) eMaxY = py;
        }
      }
    }

    if (eMinX > eMaxX) return null;
    return { mask: eroded, minX: eMinX, minY: eMinY, maxX: eMaxX, maxY: eMaxY };
  }

  /**
   * Render a mask to a target canvas context, optionally blurring edges.
   * Uses stackblur if available, falls back to CSS filter.
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
    // Pad the region so blur has room to spread
    const padMinX = Math.max(0, minX - br * 2);
    const padMinY = Math.max(0, minY - br * 2);
    const padMaxX = Math.min(width - 1, maxX + br * 2);
    const padMaxY = Math.min(height - 1, maxY + br * 2);
    const padW = padMaxX - padMinX + 1;
    const padH = padMaxY - padMinY + 1;

    // Build padded ImageData of the mask
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
      // Pre-multiply alpha
      for (let i = 0; i < pd.length; i += 4) {
        const alpha = pd[i + 3] / 255;
        pd[i] *= alpha;
        pd[i + 1] *= alpha;
        pd[i + 2] *= alpha;
      }
      stackblur(pd, padW, padH, br);
      // Un-pre-multiply
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
      // Fallback: CSS filter blur
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
    this._active = false;
    this._imageData = null;
    this._fillParams = null;
  }

  // ── pointer events ────────────────────────────────────────────────────

  onPointerDown(user, pos, e) {
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const params = this._getFillParams(user);
    const inRegion = this._getRegionConstraint();

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
      // ── Standard mode: immediate fill ──
      const result = this._computeMask(data, width, height, x, y, 10, inRegion);
      if (!result) return;

      this.board.beginStroke(user);
      const strokeCtx = this.board.layerManager.getUserStrokeContext(params.activeLayer, params.userId);
      if (!strokeCtx) return;

      this._renderMask(strokeCtx, result,params.fillR, params.fillG, params.fillB, params.userOpacity, 0, width, height);
      this.board.expandDirtyRect(user, result.minX, result.minY, result.maxX - result.minX + 1, result.maxY - result.minY + 1);
      this._broadcastFill(user, x, y, params.activeLayer, 0, 0);
      return;
    }

    // ── Advanced mode: check fill size first ──
    const initialResult = this._computeMask(data, width, height, x, y, 10, inRegion);
    if (!initialResult) return;

    const fillArea = (initialResult.maxX - initialResult.minX + 1) * (initialResult.maxY - initialResult.minY + 1);
    const canvasArea = width * height;
    if (fillArea > canvasArea * 0.15) {
      // Fill is too large for advanced mode — do an immediate standard fill
      this.board.beginStroke(user);
      const strokeCtx = this.board.layerManager.getUserStrokeContext(params.activeLayer, params.userId);
      if (!strokeCtx) return;
      this._renderMask(strokeCtx, initialResult, params.fillR, params.fillG, params.fillB, params.userOpacity, 0, width, height);
      this.board.expandDirtyRect(user, initialResult.minX, initialResult.minY, initialResult.maxX - initialResult.minX + 1, initialResult.maxY - initialResult.minY + 1);
      this._broadcastFill(user, x, y, params.activeLayer, 0, 0);
      return;
    }

    this._active = true;
    this._startPos = { x: pos.x, y: pos.y };
    this._clickPos = { x, y };
    this._expansion = 0;
    this._blurRadius = 0;
    this._imageData = imageData;
    this._fillParams = { ...params, inRegion, width, height, user };

    // Show initial preview
    this._updatePreview();
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!this._active || !this.advancedMode) return;

    // Use screen-space drag distance (undo zoom) so sensitivity is consistent at all zoom levels
    const zoom = this.board.zoom || 1;
    const dx = (pos.x - this._startPos.x) * zoom;
    const dy = (pos.y - this._startPos.y) * zoom;

    // Horizontal: expansion/dilation (-40–40px), drag right = grow, drag left = shrink
    this._expansion = Math.max(-40, Math.min(40, dx * 0.3));

    // Vertical: edge blur (0–20px), 1px screen drag down = +0.12 blur
    this._blurRadius = Math.max(0, Math.min(20, dy * 0.12));

    this._updatePreview();
  }

  _updatePreview() {
    const { width, height, inRegion } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const data = this._imageData.data;
    const { x, y } = this._clickPos;

    let result = this._computeMask(data, width, height, x, y, 10, inRegion);
    if (result && this._expansion > 0) {
      result = this._dilateMask(result, this._expansion, width, height);
    } else if (result && this._expansion < 0) {
      result = this._erodeMask(result, -this._expansion, width, height);
    }

    // Clear and redraw preview on topCtx
    const topCtx = this.board.topCtx;
    topCtx.clearRect(0, 0, width, height);

    if (result) {
      this._renderMask(topCtx, result,fillR, fillG, fillB, userOpacity, this._blurRadius, width, height);
    }
  }

  onPointerUp(user, pos, e) {
    if (!this._active) {
      this.board.endStroke(user);
      return;
    }

    // Commit the interactive fill
    const { width, height, inRegion, activeLayer, userId } = this._fillParams;
    const { fillR, fillG, fillB, userOpacity } = this._fillParams;
    const data = this._imageData.data;
    const { x, y } = this._clickPos;

    let result = this._computeMask(data, width, height, x, y, 10, inRegion);
    if (result && this._expansion > 0) {
      result = this._dilateMask(result, this._expansion, width, height);
    } else if (result && this._expansion < 0) {
      result = this._erodeMask(result, -this._expansion, width, height);
    }

    // Clear preview
    this.board.topCtx.clearRect(0, 0, width, height);

    if (result) {
      this.board.beginStroke(user);
      const strokeCtx = this.board.layerManager.getUserStrokeContext(activeLayer, userId);
      if (strokeCtx) {
        this._renderMask(strokeCtx, result, fillR, fillG, fillB, userOpacity, this._blurRadius, width, height);

        // Expand dirty rect accounting for blur + expansion bleed
        const pad = Math.ceil(this._blurRadius * 2) + Math.ceil(Math.abs(this._expansion));
        const bx = Math.max(0, result.minX - pad);
        const by = Math.max(0, result.minY - pad);
        const bw = Math.min(width, result.maxX + pad + 1) - bx;
        const bh = Math.min(height, result.maxY + pad + 1) - by;
        this.board.expandDirtyRect(user, bx, by, bw, bh);
        this._broadcastFill(user, x, y, activeLayer, this._expansion, this._blurRadius);
      }
      this.board.endStroke(user);
    }

    this._active = false;
    this._imageData = null;
    this._fillParams = null;
  }
}
