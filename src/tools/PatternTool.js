/**
 * @fileoverview Pattern tool - Reveals a grid of images through a brush stroke.
 */

/**
 * Base tool class.
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

export class PatternTool extends Tool {
  constructor(board) {
    super('pattern', board);
    this.lastStampPos = new Map();
    this.stampBuffer = [];
    this.strokePoints = [];
    this._tileCache = new Map();
    this.previewCanvas = null;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.dirtyBounds = null;
    this.remoteOffscreens = new Map(); // userId -> { canvas, ctx, strokePoints }
  }

  activate() {
    this.ensureOffscreenCanvas();
    this.updatePreview();
  }

  deactivate() {
    if (this._activeUser && this.lastStampPos.has(this._activeUser.id)) {
      this.onPointerUp(this._activeUser);
    }
    this.lastStampPos.clear();
    this._tileCache.clear();
    this._activeUser = null;
  }

  ensureOffscreenCanvas() {
    const width = this.board.mainCanvas.width;
    const height = this.board.mainCanvas.height;
    if (!this.offscreenCanvas ||
        this.offscreenCanvas.width !== width ||
        this.offscreenCanvas.height !== height) {
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCanvas.width = width;
      this.offscreenCanvas.height = height;
      this.offscreenCtx = this.offscreenCanvas.getContext('2d');
    }
  }

  onPointerDown(user, pos) {
    this._activeUser = user;
    this.board.beginStroke(user);
    this.ensureOffscreenCanvas();
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.strokePoints = [pos];
    this._stampMask(pos, user.size * (user.pressure || 1));
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.board.clearTop();
    this._drawPreview(user);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this._stampMask(pos, user.size * (user.pressure || 1));
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.clearTop();
      this._drawPreview(user);
      return;
    }

    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minSpacing = Math.max(1, user.size * 0.1);

    if (distance >= minSpacing) {
      const steps = Math.max(1, Math.floor(distance / minSpacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpPos = { x: lastStamp.x + dx * t, y: lastStamp.y + dy * t };
        this._stampMask(interpPos, user.size * (user.pressure || 1));
        this.stampBuffer.push(interpPos.x, interpPos.y);
        this.strokePoints.push(interpPos);
      }
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }

    this.board.clearTop();
    this._drawPreview(user);
  }

  onPointerUp(user) {
    if (user.panning || !user.mousedown) return;

    const ctx = this.board.getActiveLayerContext();
    if (ctx) {
      const composite = this._buildPatternComposite(user);
      if (composite) {
        ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
        ctx.drawImage(composite, 0, 0);
        ctx.globalAlpha = 1.0;
      }
    }

    if (this.strokePoints.length > 0) {
      this.board.markDirtyPath(user, this.strokePoints, user.size);
    }

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const x = Math.floor(this.dirtyBounds.minX) - 2;
      const y = Math.floor(this.dirtyBounds.minY) - 2;
      const w = Math.ceil(this.dirtyBounds.maxX) - x + 2;
      const h = Math.ceil(this.dirtyBounds.maxY) - y + 2;
      this.board.expandDirtyRect(user, x, y, w, h);
    }

    this.strokePoints = [];
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    this.dirtyBounds = null;
    this.board.compositeAllLayers();
    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
    this.board.clearTop();
  }

  _stampMask(pos, radius) {
    const ctx = this.offscreenCtx;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x - radius);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y - radius);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x + radius);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y + radius);
    }
  }

  _buildPatternComposite(user, maskCanvas = null) {
    const mask = maskCanvas ?? this.offscreenCanvas;
    if (!mask) return null;
    const tile = this._getPatternTile(user);
    if (!tile) return null;

    const w = mask.width;
    const h = mask.height;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');

    let scale = (user.patternScale || 100) / 100;
    // SVGs are rendered at 200px but should display as 40px at 100% scale
    if (user.patternBrush && user.patternBrush.type === 'svg') {
      scale *= 0.2; // 200px / 40px = 5, so multiply by 1/5
    }
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const pattern = tempCtx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }
    tempCtx.fillStyle = pattern;
    tempCtx.fillRect(0, 0, w, h);

    // Clip pattern to the stroke mask
    tempCtx.globalCompositeOperation = 'destination-in';
    tempCtx.drawImage(mask, 0, 0);
    tempCtx.globalCompositeOperation = 'source-over';

    return tempCanvas;
  }

  _drawPreview(user) {
    const composite = this._buildPatternComposite(user);
    if (!composite) return;

    const ctx = this.board.topCtx;
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    ctx.drawImage(composite, 0, 0);
    ctx.globalAlpha = 1.0;
  }

  _drawRemotePreview(user, maskCanvas) {
    if (!user?.context) return;

    const ctx = user.context;
    ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    const composite = this._buildPatternComposite(user, maskCanvas);
    if (!composite) return;

    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    ctx.drawImage(composite, 0, 0);
    ctx.globalAlpha = 1.0;
  }

  /**
   * Generates a single tile for the repeating pattern.
   * Standardizes size and adds user-defined padding (spacing).
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

    if (this._tileCache.has(key)) {
      return this._tileCache.get(key);
    }

    // Preserve aspect ratio
    // Render SVGs at higher resolution (200px) to avoid pixelation when scaled
    const maxDim = (brush.type === 'svg') ? 200 : 40;
    const imgWidth = img.width || img.naturalWidth;
    const imgHeight = img.height || img.naturalHeight;

    // Image not loaded yet
    if (!imgWidth || !imgHeight) return null;

    const aspectRatio = imgWidth / imgHeight;

    let tileWidth, tileHeight;
    if (aspectRatio > 1) {
      // Wider than tall
      tileWidth = maxDim;
      tileHeight = maxDim / aspectRatio;
    } else {
      // Taller than wide or square
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

    // Create an intermediate canvas to handle greyscale transparency
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = tileWidth;
    tempCanvas.height = tileHeight;
    const tempCtx = tempCanvas.getContext('2d');

    if (brush.type === 'svg') {
      tempCtx.imageSmoothingEnabled = false;
    }

    tempCtx.drawImage(img, 0, 0, tileWidth, tileHeight);

    // If it's a GIMP greyscale brush, it's often black-on-white.
    // We want white to be transparent.
    if (brush.type === 'gbr' && brush.colorDepth === 1) {
        const imageData = tempCtx.getImageData(0, 0, tileWidth, tileHeight);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            // Use lightness as the inverse alpha (black = opaque, white = transparent)
            const brightness = (r + g + b) / 3;
            data[i+3] = 255 - brightness;
            // Set RGB to black so source-in works correctly
            data[i] = data[i+1] = data[i+2] = 0;
        }
        tempCtx.putImageData(imageData, 0, 0);
    }

    // Draw centered and optionally tinted
    tctx.save();
    tctx.drawImage(tempCanvas, padding/2, padding/2, tileWidth, tileHeight);

    // Only apply color tinting if colorMode is 'tinted'
    if (colorMode === 'tinted') {
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, 1.0)`;
      tctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);
    }

    tctx.restore();

    this._tileCache.set(key, tileCanvas);
    return tileCanvas;
  }

  drawStamp(user, pos) {
    // Legacy method: stamp directly to layer (used by applyStamps for remote rendering).
    const ctx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    if (!ctx) return;

    const tile = this._getPatternTile(user);
    if (!tile) return;

    const size = user.size * (user.pressure || 1);
    const scale = (user.patternScale || 100) / 100;
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;

    ctx.save();
    const pattern = ctx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }
    ctx.fillStyle = pattern;
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this.board.expandDirtyRect(user, pos.x - size - 2, pos.y - size - 2, size * 2 + 4, size * 2 + 4);
    this.board.requestUpdate();
  }

  updatePreview(user) {
    this.previewCanvas = document.getElementById('patternPreviewCanvas');
    if (!this.previewCanvas) {
      return;
    }

    const ctx = this.previewCanvas.getContext('2d');

    // Get user from parameter, board, or app
    if (!user) {
      user = this.board.self || this.board.app?.self;
    }
    if (!user) {
      console.warn('No user available for pattern preview');
      return;
    }

    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    const tile = this._getPatternTile(user);
    if (!tile) {
      // No pattern selected yet - show blank preview
      return;
    }

    const pattern = ctx.createPattern(tile, 'repeat');
    let scale = (user.patternScale || 100) / 100;
    // SVGs are rendered at 200px but should display as 40px at 100% scale
    if (user.patternBrush && user.patternBrush.type === 'svg') {
      scale *= 0.2; // 200px / 40px = 5, so multiply by 1/5
    }
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;

    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }
    
    ctx.save();
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    ctx.restore();
  }

  drainStampBuffer() {
    const ps = this.stampBuffer;
    this.stampBuffer = [];
    const rs = Array(ps.length / 2).fill(0);
    return { ps, rs };
  }

  remoteBeginStroke(user, pos) {
    const w = this.board.mainCanvas.width;
    const h = this.board.mainCanvas.height;
    let offscreen = this.remoteOffscreens.get(user.id);
    if (!offscreen || offscreen.canvas.width !== w || offscreen.canvas.height !== h) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      offscreen = { canvas, ctx: canvas.getContext('2d'), strokePoints: [] };
      this.remoteOffscreens.set(user.id, offscreen);
    }
    offscreen.ctx.clearRect(0, 0, w, h);
    offscreen.strokePoints = [pos];
    const radius = user.size * (user.pressure || 1);
    offscreen.ctx.beginPath();
    offscreen.ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    offscreen.ctx.fill();
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this._drawRemotePreview(user, offscreen.canvas);
  }

  remoteStampMask(user, ps) {
    const offscreen = this.remoteOffscreens.get(user.id);
    if (!offscreen) return;
    const radius = user.size * (user.pressure || 1);
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      offscreen.ctx.beginPath();
      offscreen.ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
      offscreen.ctx.fill();
      offscreen.strokePoints.push(pos);
    }
    this._drawRemotePreview(user, offscreen.canvas);
  }

  remoteEndStroke(user) {
    const offscreen = this.remoteOffscreens.get(user.id);
    if (!offscreen) return;

    const composite = this._buildPatternComposite(user, offscreen.canvas);
    if (composite) {
      const ctx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
      if (ctx) {
        ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
        ctx.drawImage(composite, 0, 0);
        ctx.globalAlpha = 1.0;
      }
    }

    if (offscreen.strokePoints.length > 0) {
      this.board.markDirtyPath(user, offscreen.strokePoints, user.size);
    }

    if (user?.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.remoteOffscreens.delete(user.id);
    this.lastStampPos.delete(user.id);
  }

  applyStamps(user, ps) {
    const points = [];
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      this.drawStamp(user, pos);
      points.push(pos);
    }
    if (points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
    }
    this.board.requestUpdate();
  }
}
