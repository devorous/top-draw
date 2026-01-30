import { manhattanDistance, mirrorLine, calcCatmullRomCurve, drawTangentStroke } from './utils/drawing.js';
import { parseGbr, parseGih } from './utils/parseGimp.js';
import { Homography } from './utils/homography.js';
import { SelectTool } from './tools/SelectTool.js';

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
 * Brush tool for drawing lines
 */
export class BrushTool extends Tool {
  constructor(board) {
    super('brush', board);
    // Smoothing buffer for stroke stabilization
    this.smoothBuffer = { x: 0, y: 0 };
    this.isFirstPoint = true;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Apply exponential moving average smoothing to position
   * @param {number} targetX - Target X position
   * @param {number} targetY - Target Y position
   * @param {number} smoothing - Smoothing factor (0-1, where 0 = no smoothing)
   */
  smoothPosition(targetX, targetY, smoothing) {
    if (this.isFirstPoint || smoothing === 0) {
      this.smoothBuffer.x = targetX;
      this.smoothBuffer.y = targetY;
      this.isFirstPoint = false;
      return { x: targetX, y: targetY };
    }

    // Higher smoothing = more lag/stabilization (lerp factor becomes smaller)
    const factor = 1 - smoothing * 0.9; // At max smoothing, factor is 0.1
    this.smoothBuffer.x += (targetX - this.smoothBuffer.x) * factor;
    this.smoothBuffer.y += (targetY - this.smoothBuffer.y) * factor;

    return {
      x: this.smoothBuffer.x,
      y: this.smoothBuffer.y
    };
  }

  onPointerDown(user, pos) {
    this.isFirstPoint = true;
    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    user.currentLine.push(smoothedPos);
    user.currentLine.push(smoothedPos);
    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    user.currentLine.push(smoothedPos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.topCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.topCtx, user);
    }

    user.lineLength += manhattanDistance(smoothedPos, lastPos);
  }

  onPointerUp(user) {
    if (user.panning) return;

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
  }

  drawPreview(user) {
    this.drawLineArray(user.currentLine, this.board.topCtx, user);
  }

  drawLineArray(points, ctx, user) {
    if (points.length === 0) return;

    // Debug: Track draws to mainCtx
    const isMainCtx = ctx === this.board.mainCtx;
    if (isMainCtx) {
      user._mainCtxDrawCount = (user._mainCtxDrawCount || 0) + 1;
      console.log(`[DrawDebug] LOCAL user=${user.id} draw #${user._mainCtxDrawCount} to mainCtx, ${points.length} points, lineWidth=${user.pressure * user.size * 2}`);
    }

    // Apply user opacity (independent of color alpha)
    const opacity = user.opacity !== undefined ? user.opacity : 1;

    // Explicitly set ALL context properties to ensure consistency
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;

    // Apply Level 2 smoothing (Catmull-Rom) if enabled
    const smoothing = user.smoothing || 0; // 0-1 range

    if (smoothing > 0 && points.length >= 3) {
      // Use Catmull-Rom curves for smooth rendering
      const tension = smoothing; // 0.0 to 1.0
      const smoothedPoints = calcCatmullRomCurve(points, tension);

      // Draw as bezier curves
      ctx.beginPath();
      ctx.moveTo(smoothedPoints[0].x, smoothedPoints[0].y);

      // smoothedPoints format: [p1, cp1, cp2, p2, cp1, cp2, p3, ...]
      for (let i = 1; i < smoothedPoints.length - 2; i += 3) {
        const cp1 = smoothedPoints[i];
        const cp2 = smoothedPoints[i + 1];
        const end = smoothedPoints[i + 2];
        ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
      }
      ctx.stroke();
    } else {
      // Original linear rendering for low/no smoothing
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }

    // Reset globalAlpha
    ctx.globalAlpha = 1.0;
  }

  commitCurrentLine(user) {
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
    user.currentLine.push({ x: user.x, y: user.y });
  }
}

/**
 * Eraser tool
 */
export class EraserTool extends Tool {
  constructor(board) {
    super('erase', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'destination-out';
  }

  onPointerDown(user, pos) {
    this.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.erase(width - pos.x, pos.y, width - lastPos.x, lastPos.y, user.pressure * user.size * 2);
    }
  }

  erase(x1, y1, x2, y2, size) {
    const ctx = this.board.mainCtx;
    // Explicitly set all properties (remote users bypass activate())
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1.0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

/**
 * Text tool
 */
export class TextTool extends Tool {
  constructor(board) {
    super('text', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    if (user.text) {
      this.drawText(user);
      user.text = '';
    }
  }

  onKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      if (user.text.endsWith('&nbsp;')) {
        user.text = user.text.slice(0, -6);
      } else {
        user.text = user.text.slice(0, -1);
      }
    }
    return user.text;
  }

  drawText(user) {
    const ctx = this.board.mainCtx;
    ctx.globalCompositeOperation = 'source-over';
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    const size = (user.size + 5).toString();
    const text = user.text.replace(/&nbsp;/g, ' ');

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${size}px Newsreader, serif`;
    ctx.fillText(text, user.x + 5, user.y - 6 + user.size + 5);
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Image brush tool - supports GIMP brushes (.gbr/.gih) and standard images (.png/.jpg/.webp)
 */
export class ImageBrushTool extends Tool {
  constructor(board) {
    super('imageBrush', board);
    this.lastPos = null;
    this.lastTime = null;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    if (user.imageBrush) {
      this.lastPos = { x: pos.x, y: pos.y };
      this.lastTime = performance.now();
      // Reset GIH brush dimensions on new stroke
      if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
        user.imageBrush.reset();
      }
      this.draw(user, pos);
    }
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !user.imageBrush) return;
    this.draw(user, pos);
  }

  draw(user, pos) {
    // Handle spacing - if spacing is 0 or 1, draw every time
    if (user.spacing > 1) {
      user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
      // Only draw when spacing counter reaches 0
      if (user.spaceIndex !== 0) return;
    }

    const brush = user.imageBrush;
    const size = user.size;
    const ctx = this.board.mainCtx;

    let height, width, image;

    if (brush.type === 'gbr') {
      height = brush.height;
      width = brush.width;
      image = brush.image;
    } else if (brush.type === 'gih') {
      height = brush.cellheight;
      width = brush.cellwidth;

      // Calculate context for selection modes
      const context = this.calculateContext(user, pos);

      // Use the new getNextBrush method if available
      if (brush.getNextBrush) {
        const result = brush.getNextBrush(context);
        image = brush.images[result.index];
      } else {
        // Fallback to old incremental behavior
        image = brush.images[brush.index];
        brush.index = (brush.index + 1) % brush.ncells;
      }
    } else if (brush.type === 'image') {
      // Handle standard image formats (PNG, JPG, WebP)
      height = brush.height;
      width = brush.width;
      image = brush.image;
    }

    // Update last position and time for next calculation
    this.lastPos = { x: pos.x, y: pos.y };
    this.lastTime = performance.now();

    let ratioX = width / height;
    let ratioY = height / width;

    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.drawImage(
      image,
      pos.x - size * ratioX,
      pos.y - size * ratioY,
      size * 2 * ratioX,
      size * 2 * ratioY
    );
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  /**
   * Calculate context for GIH selection modes
   */
  calculateContext(user, pos) {
    const context = {
      pressure: user.pressure || 0.5,
      angle: 0,
      velocity: 0,
      tiltX: 0,
      tiltY: 0
    };

    // Calculate angle from last position
    if (this.lastPos) {
      const dx = pos.x - this.lastPos.x;
      const dy = pos.y - this.lastPos.y;

      if (dx !== 0 || dy !== 0) {
        // Calculate angle in degrees (0 = up, 90 = right, 180 = down, 270 = left)
        // Math.atan2 gives angle from positive x-axis, we want from negative y-axis
        let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
        context.angle = ((angle % 360) + 360) % 360;
      }

      // Calculate velocity (pixels per millisecond)
      if (this.lastTime) {
        const dt = performance.now() - this.lastTime;
        if (dt > 0) {
          const distance = Math.sqrt(dx * dx + dy * dy);
          context.velocity = distance / dt * 16; // Normalize to ~60fps
        }
      }
    }

    return context;
  }

  loadBrush(file, user) {
    return new Promise((resolve, reject) => {
      const fileType = file.name.split('.').pop().toLowerCase();

      // Handle standard image formats (PNG, JPG, WebP)
      if (['png', 'jpg', 'jpeg', 'webp'].includes(fileType)) {
        const reader = new FileReader();
        reader.onload = () => {
          const imageUrl = reader.result;
          const image = new Image();

          image.onload = () => {
            const brushObject = {
              type: 'image',
              fileName: file.name,
              imageFormat: fileType,
              brushName: file.name.replace(/\.[^/.]+$/, ''),
              gimpUrl: imageUrl,
              width: image.width,
              height: image.height,
              image: image
            };
            user.imageBrush = brushObject;
            resolve(brushObject);
          };

          image.onerror = () => reject(new Error('Failed to load image'));
          image.src = imageUrl;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
        return;
      }

      // Handle GIMP brush formats
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result;

        if (fileType === 'gbr') {
          const gbrObject = parseGbr(arrayBuffer);
          if (gbrObject) {
            gbrObject.type = 'gbr';
            const image = new Image();
            image.src = gbrObject.gimpUrl;
            gbrObject.image = image;
            user.imageBrush = gbrObject;
            resolve(gbrObject);
          }
        } else if (fileType === 'gih') {
          const gihObject = parseGih(arrayBuffer);
          if (gihObject) {
            const images = gihObject.gBrushes.map(brush => {
              const img = new Image();
              img.src = brush.gimpUrl;
              return img;
            });
            gihObject.type = 'gih';
            gihObject.images = images;
            user.imageBrush = gihObject;
            resolve(gihObject);
          }
        }
      };

      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }
}

/**
 * Pen tool for pressure-sensitive strokes using circle stamping
 * Uses offscreen canvas to prevent opacity stacking when circles overlap
 */
export class PenTool extends Tool {
  constructor(board) {
    super('pen', board);
    this.pressureSteps = 256;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.lastStampPos = null;
    this.userAlpha = 1.0;
    this.strokeColor = null;
    // Smoothing buffer for stroke stabilization
    this.smoothBuffer = { x: 0, y: 0 };
    this.isFirstPoint = true;
  }

  /**
   * Apply exponential moving average smoothing to position
   */
  smoothPosition(targetX, targetY, smoothing) {
    if (this.isFirstPoint || smoothing === 0) {
      this.smoothBuffer.x = targetX;
      this.smoothBuffer.y = targetY;
      this.isFirstPoint = false;
      return { x: targetX, y: targetY };
    }

    const factor = 1 - smoothing * 0.9;
    this.smoothBuffer.x += (targetX - this.smoothBuffer.x) * factor;
    this.smoothBuffer.y += (targetY - this.smoothBuffer.y) * factor;

    return {
      x: this.smoothBuffer.x,
      y: this.smoothBuffer.y
    };
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
    this.ensureOffscreenCanvas();
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

  quantizePressure(pressure) {
    return Math.round(pressure * (this.pressureSteps - 1)) / (this.pressureSteps - 1);
  }

  getDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  onPointerDown(user, pos, e) {
    this.ensureOffscreenCanvas();
    this.isFirstPoint = true;

    // Clear offscreen canvas
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Store color at full opacity for offscreen canvas (RGB only)
    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.offscreenCtx.fillStyle = this.strokeColor;

    // Store user's alpha for compositing (combine color alpha with opacity slider)
    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    this.userAlpha = colorAlpha * opacitySlider;

    // Apply smoothing
    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    // Stamp first circle
    this.stampCircle(smoothedPos.x, smoothedPos.y, radius);
    this.lastStampPos = { x: smoothedPos.x, y: smoothedPos.y, radius };

    // Store points for reference
    user.penPoints = [{ x: smoothedPos.x, y: smoothedPos.y, radius }];

    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    // Apply smoothing
    const smoothing = user.smoothing || 0;
    const smoothedPos = this.smoothPosition(pos.x, pos.y, smoothing);

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Adaptive spacing: stamp when distance >= 20% of average radius
    const avgRadius = (this.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const distance = this.getDistance(this.lastStampPos, smoothedPos);

    if (distance >= spacing) {
      // Interpolate circles along the path for smooth coverage
      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = this.lastStampPos.x + (smoothedPos.x - this.lastStampPos.x) * t;
        const y = this.lastStampPos.y + (smoothedPos.y - this.lastStampPos.y) * t;
        const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
        this.stampCircle(x, y, r);
      }
      this.lastStampPos = { x: smoothedPos.x, y: smoothedPos.y, radius };
      user.penPoints.push({ x: smoothedPos.x, y: smoothedPos.y, radius });
    }

    this.board.clearTop();
    this.drawPreview(user);
  }

  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    // Composite offscreen canvas to main canvas with user's alpha
    const ctx = this.board.mainCtx;
    ctx.globalAlpha = this.userAlpha;
    ctx.drawImage(this.offscreenCanvas, 0, 0);

    if (this.board.mirror) {
      // Flip horizontally and draw mirrored
      ctx.save();
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.offscreenCanvas, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;

    this.clearStroke();
    user.penPoints = [];
  }

  stampCircle(x, y, radius) {
    this.offscreenCtx.beginPath();
    this.offscreenCtx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
    this.offscreenCtx.fill();
  }

  drawPreview(user) {
    if (!this.offscreenCanvas) return;

    const ctx = this.board.topCtx;

    // Draw offscreen canvas with user's alpha
    ctx.globalAlpha = this.userAlpha;
    ctx.drawImage(this.offscreenCanvas, 0, 0);

    if (this.board.mirror) {
      ctx.save();
      ctx.translate(this.board.getWidth(), 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.offscreenCanvas, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;
  }

  clearStroke() {
    if (this.offscreenCtx) {
      this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    }
    this.lastStampPos = null;
    // Clear the preview from the top canvas as well
    this.board.clearTop();
  }
}


/**
 * Line tool for drawing straight lines
 */
export class LineTool extends Tool {
  constructor(board) {
    super('line', board);
    this.startPos = null;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    this.startPos = { x: pos.x, y: pos.y };
    user.startPos = this.startPos; // Store on user for remote sync
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(this.board.topCtx, user, this.startPos, pos);
  }

  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    this.drawLine(this.board.mainCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawLine(this.board.mainCtx, user, mirroredStart, mirroredEnd);
    }

    this.board.clearTop();
    this.startPos = null;
  }

  drawPreview(ctx, user, start, end) {
    this.drawLine(ctx, user, start, end);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - start.x, y: start.y };
      const mirroredEnd = { x: width - end.x, y: end.y };
      this.drawLine(ctx, user, mirroredStart, mirroredEnd);
    }
  }

  drawLine(ctx, user, start, end) {
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Rectangle tool for drawing rectangles
 */
export class RectangleTool extends Tool {
  constructor(board) {
    super('rectangle', board);
    this.startPos = null;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    this.startPos = { x: pos.x, y: pos.y };
    this.drawPreview(user, pos);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    this.drawRect(this.board.mainCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawRect(this.board.mainCtx, user, mirroredStart, mirroredEnd);
    }

    this.board.clearTop();
    this.startPos = null;
  }

  drawPreview(user, pos) {
    this.drawRect(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawRect(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  drawRect(ctx, user, start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Circle tool for drawing circles/ellipses
 */
export class CircleTool extends Tool {
  constructor(board) {
    super('circle', board);
    this.startPos = null;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    this.startPos = { x: pos.x, y: pos.y };
    this.drawPreview(user, pos);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
  }

  onPointerUp(user, pos) {
    if (user.panning || !this.startPos) return;

    this.drawEllipse(this.board.mainCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawEllipse(this.board.mainCtx, user, mirroredStart, mirroredEnd);
    }

    this.board.clearTop();
    this.startPos = null;
  }

  drawPreview(user, pos) {
    this.drawEllipse(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawEllipse(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  drawEllipse(ctx, user, start, end) {
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }
}

/**
 * Tool manager
 */
export class ToolManager {
  constructor(board) {
    this.board = board;
    this.tools = {
      select: new SelectTool(board),
      brush: new BrushTool(board),
      pen: new PenTool(board),
      line: new LineTool(board),
      rectangle: new RectangleTool(board),
      circle: new CircleTool(board),
      erase: new EraserTool(board),
      text: new TextTool(board),
      imageBrush: new ImageBrushTool(board)
    };
    this.currentTool = null;
  }

  setTool(toolName) {
    if (this.currentTool) {
      this.currentTool.deactivate();
    }
    this.currentTool = this.tools[toolName];
    if (this.currentTool) {
      this.currentTool.activate();
    }
    return this.currentTool;
  }

  getTool(toolName) {
    return this.tools[toolName];
  }

  getCurrentTool() {
    return this.currentTool;
  }
}
