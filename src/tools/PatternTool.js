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
  }

  activate() {
    this.updatePreview();
  }
  
  deactivate() {
    this.lastStampPos.clear();
    this._tileCache.clear();
  }

  onPointerDown(user, pos) {
    this.board.beginStroke(user);
    this.strokePoints = [pos];
    this.drawStamp(user, pos);
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      return;
    }

    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Continuous stroke spacing
    const minSpacing = Math.max(1, user.size * 0.1);

    if (distance >= minSpacing) {
      const steps = Math.max(1, Math.floor(distance / minSpacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpX = lastStamp.x + dx * t;
        const interpY = lastStamp.y + dy * t;
        const interpPos = { x: interpX, y: interpY };
        this.drawStamp(user, interpPos);
        this.stampBuffer.push(interpX, interpY);
        this.strokePoints.push(interpPos);
      }
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.requestUpdate();
    }
  }

  onPointerUp(user) {
    if (user.panning) return;
    if (this.strokePoints.length > 0) {
      this.board.markDirtyPath(user, this.strokePoints, user.size);
    }
    this.strokePoints = [];
    this.board.compositeAllLayers();
    this.board.endStroke(user);
    this.lastStampPos.delete(user.id);
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

    const colorKey = user.color.join(',');
    const spacing = user.patternSpacing || 0;
    const key = `${brush.brushName || brush.fileName}_${colorKey}_${spacing}`;
    
    if (this._tileCache.has(key)) return this._tileCache.get(key);

    const tileCanvas = document.createElement('canvas');
    const baseDim = 40; 
    const padding = spacing;
    tileCanvas.width = tileCanvas.height = baseDim + padding;
    
    const tctx = tileCanvas.getContext('2d');
    
    // Create an intermediate canvas to handle greyscale transparency
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = baseDim;
    tempCanvas.height = baseDim;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0, baseDim, baseDim);

    // If it's a GIMP greyscale brush, it's often black-on-white.
    // We want white to be transparent.
    if (brush.type === 'gbr' && brush.colorDepth === 1) {
        const imageData = tempCtx.getImageData(0, 0, baseDim, baseDim);
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
    
    // Draw centered and tinted
    tctx.save();
    tctx.drawImage(tempCanvas, padding/2, padding/2, baseDim, baseDim);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3]})`;
    tctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);
    tctx.restore();

    this._tileCache.set(key, tileCanvas);
    return tileCanvas;
  }

  drawStamp(user, pos) {
    const ctx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    if (!ctx) return;

    const tile = this._getPatternTile(user);
    if (!tile) return;

    const size = user.size * (user.pressure || 1);
    const scale = (user.patternScale || 100) / 100;
    
    ctx.save();
    
    // Create the repeating grid wallpaper
    const pattern = ctx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }

    ctx.fillStyle = pattern;
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    
    // Revel the wallpaper through a circle (the brush mask)
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();

    this.board.expandDirtyRect(user, pos.x - size - 2, pos.y - size - 2, size * 2 + 4, size * 2 + 4);
    this.board.requestUpdate();
  }

  updatePreview() {
    if (!this.previewCanvas) {
      this.previewCanvas = document.getElementById('patternPreview');
    }
    if (!this.previewCanvas) return;

    const ctx = this.previewCanvas.getContext('2d');
    const user = this.board.self;
    if (!user) return;

    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    
    const tile = this._getPatternTile(user);
    if (!tile) return;

    const pattern = ctx.createPattern(tile, 'repeat');
    const scale = (user.patternScale || 100) / 100;
    
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
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
