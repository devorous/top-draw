import { manhattanDistance, mirrorLine } from './utils/drawing.js';
import { parseGbr, parseGih } from './utils/parseGimp.js';
import { Homography } from './utils/homography.js';

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
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    user.currentLine.push(pos);
    user.currentLine.push(pos);
    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    user.currentLine.push(pos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.topCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.topCtx, user);
    }

    user.lineLength += manhattanDistance(pos, lastPos);
  }

  onPointerUp(user) {
    if (user.panning) return;

    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    this.board.clearTop();
    user.clearLine();
  }

  drawPreview(user) {
    this.drawLineArray(user.currentLine, this.board.topCtx, user);
  }

  drawLineArray(points, ctx, user) {
    if (points.length === 0) return;

    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
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
    const size = (user.size + 5).toString();
    const text = user.text.replace(/&nbsp;/g, ' ');

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${size}px Newsreader, serif`;
    ctx.fillText(text, user.x + 5, user.y - 6 + user.size + 5);
  }
}

/**
 * GIMP brush tool
 */
export class GimpTool extends Tool {
  constructor(board) {
    super('gimp', board);
    this.lastPos = null;
    this.lastTime = null;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    if (user.gBrush) {
      this.lastPos = { x: pos.x, y: pos.y };
      this.lastTime = performance.now();
      // Reset GIH brush dimensions on new stroke
      if (user.gBrush.type === 'gih' && user.gBrush.reset) {
        user.gBrush.reset();
      }
      this.draw(user, pos);
    }
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !user.gBrush) return;
    this.draw(user, pos);
  }

  draw(user, pos) {
    if (user.spacing !== 0) {
      if (user.spaceIndex !== 0) {
        user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
        return;
      }
      user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
    }

    const gBrush = user.gBrush;
    const size = user.size;
    const ctx = this.board.mainCtx;

    let height, width, image;

    if (gBrush.type === 'gbr') {
      height = gBrush.height;
      width = gBrush.width;
      image = gBrush.image;
    } else if (gBrush.type === 'gih') {
      height = gBrush.cellheight;
      width = gBrush.cellwidth;

      // Calculate context for selection modes
      const context = this.calculateContext(user, pos);

      // Use the new getNextBrush method if available
      if (gBrush.getNextBrush) {
        const result = gBrush.getNextBrush(context);
        image = gBrush.images[result.index];
      } else {
        // Fallback to old incremental behavior
        image = gBrush.images[gBrush.index];
        gBrush.index = (gBrush.index + 1) % gBrush.ncells;
      }
    }

    // Update last position and time for next calculation
    this.lastPos = { x: pos.x, y: pos.y };
    this.lastTime = performance.now();

    let ratioX = width / height;
    let ratioY = height / width;

    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

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
    return new Promise((resolve) => {
      const fileType = file.name.split('.').pop().toLowerCase();
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
            user.gBrush = gbrObject;
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
            user.gBrush = gihObject;
            resolve(gihObject);
          }
        }
      };

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

    // Clear offscreen canvas
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Store color at full opacity for offscreen canvas (RGB only)
    const color = user.color.slice(0, 3);
    this.strokeColor = `rgb(${color.join(',')})`;
    this.offscreenCtx.fillStyle = this.strokeColor;

    // Store user's alpha for compositing (alpha is already 0-1)
    this.userAlpha = user.color[3];

    // Stamp first circle
    this.stampCircle(pos.x, pos.y, radius);
    this.lastStampPos = { x: pos.x, y: pos.y, radius };

    // Store points for reference
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];

    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos, e) {
    if (!user.mousedown || user.panning || !this.lastStampPos) return;

    const pressure = this.quantizePressure(user.pressure);
    const radius = pressure * user.size;

    // Adaptive spacing: stamp when distance >= 20% of average radius
    const avgRadius = (this.lastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const distance = this.getDistance(this.lastStampPos, pos);

    if (distance >= spacing) {
      // Interpolate circles along the path for smooth coverage
      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = this.lastStampPos.x + (pos.x - this.lastStampPos.x) * t;
        const y = this.lastStampPos.y + (pos.y - this.lastStampPos.y) * t;
        const r = this.lastStampPos.radius + (radius - this.lastStampPos.radius) * t;
        this.stampCircle(x, y, r);
      }
      this.lastStampPos = { x: pos.x, y: pos.y, radius };
      user.penPoints.push({ x: pos.x, y: pos.y, radius });
    }

    this.board.clearTop();
    this.drawPreview(user);
  }

  onPointerUp(user, pos, e) {
    if (user.panning || !this.offscreenCanvas) return;

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

    this.board.clearTop();
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
  }
}

/**
 * Selection tool for selecting, moving, and transforming regions
 */
export class SelectTool extends Tool {
  constructor(board) {
    super('select', board);
    this.mode = 'rectangle'; // 'rectangle' or 'lasso'
    this.isSelecting = false;
    this.isDragging = false;
    this.startPos = null;
    this.selection = null; // { x, y, width, height }
    this.selectedImageData = null;
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.dragOffset = { x: 0, y: 0 };
    this.marchingAntsOffset = 0;
    this.animationId = null;

    // Transform handles
    this.handles = [];
    this.activeHandle = null;
    this.handleSize = 8;
    this.handleHitArea = 20; // Larger hit area for easier clicking

    // Corner positions for transform (can be moved independently for perspective)
    this.corners = null; // { tl, tr, bl, br } - each is {x, y}
    this.originalCorners = null; // Original corners before transform

    // Homography instance for transforms
    this.homography = null;
    this.isTransforming = false;

    // Clipboard
    this.clipboard = null;
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
    this.startMarchingAnts();
  }

  deactivate() {
    this.stopMarchingAnts();
    this.commitSelection();
    this.clearSelection();
    // Reset cursor
    this.board.container.style.cursor = 'none';
  }

  updateCursor(pos) {
    if (!this.board.container) return;

    // Check if over a handle first (highest priority)
    this.updateHandles();
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      // Set cursor based on handle position
      const cursorMap = {
        'tl': 'nwse-resize', 'br': 'nwse-resize',
        'tr': 'nesw-resize', 'bl': 'nesw-resize',
        'tm': 'ns-resize', 'bm': 'ns-resize',
        'ml': 'ew-resize', 'mr': 'ew-resize'
      };
      this.board.container.style.cursor = cursorMap[handle.id] || 'move';
      return;
    }

    // Check if over selection (for move)
    if (this.selection && this.isInsideSelection(pos)) {
      this.board.container.style.cursor = 'move';
      return;
    }

    // Default crosshair for selection
    this.board.container.style.cursor = 'crosshair';
  }

  startMarchingAnts() {
    if (this.animationId) return;

    const animate = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 1) % 16;
      // Only redraw if we have a selection and aren't actively transforming
      if (this.selection && !this.isDragging && !this.isTransforming && !this.isSelecting) {
        this.board.clearTop();
        // Draw floating selection or transform preview
        if (this.floatingCanvas && this.hasTransformedCorners()) {
          // Show transform preview if corners have been moved
          this.drawTransformPreview();
        } else if (this.floatingCanvas) {
          this.drawFloatingSelection();
          this.drawMarchingAntsOnly();
        } else {
          // Draw only the marching ants border and handles
          this.drawMarchingAntsOnly();
        }
      }
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  }

  drawMarchingAntsOnly() {
    if (!this.selection) return;

    const ctx = this.board.topCtx;

    // Draw marching ants border using corners if available
    if (this.corners) {
      this.drawTransformOutline(ctx);
      this.drawTransformHandles(ctx);
    } else {
      const s = this.selection;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.strokeRect(s.x, s.y, s.width, s.height);

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.strokeRect(s.x, s.y, s.width, s.height);
      ctx.setLineDash([]);

      // Draw handles
      this.updateHandles();
      for (const handle of this.handles) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.fillRect(
          handle.x - this.handleSize / 2,
          handle.y - this.handleSize / 2,
          this.handleSize,
          this.handleSize
        );
        ctx.strokeRect(
          handle.x - this.handleSize / 2,
          handle.y - this.handleSize / 2,
          this.handleSize,
          this.handleSize
        );
      }
    }
  }

  stopMarchingAnts() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  onPointerDown(user, pos) {
    // Check if clicking inside existing selection to drag it
    if (this.selection && this.isInsideSelection(pos)) {
      this.isDragging = true;
      this.dragOffset = {
        x: pos.x - this.selection.x,
        y: pos.y - this.selection.y
      };

      // If we haven't lifted the selection yet, do it now
      if (!this.floatingCanvas) {
        this.liftSelection();
      }
      return;
    }

    // Check if clicking a transform handle
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      this.activeHandle = handle;
      return;
    }

    // Commit any existing selection before starting a new one
    if (this.selection) {
      this.commitSelection();
      this.clearSelection();
    }

    // Start new selection
    this.isSelecting = true;
    this.startPos = { x: pos.x, y: pos.y };
  }

  onPointerMove(user, pos) {
    if (this.isDragging && this.selection) {
      // Calculate movement delta
      const newX = pos.x - this.dragOffset.x;
      const newY = pos.y - this.dragOffset.y;
      const dx = newX - this.selection.x;
      const dy = newY - this.selection.y;

      // Move the selection
      this.selection.x = newX;
      this.selection.y = newY;

      // Also move all corners
      if (this.corners) {
        this.corners.tl.x += dx;
        this.corners.tl.y += dy;
        this.corners.tr.x += dx;
        this.corners.tr.y += dy;
        this.corners.bl.x += dx;
        this.corners.bl.y += dy;
        this.corners.br.x += dx;
        this.corners.br.y += dy;
      }

      this.board.clearTop();
      this.drawFloatingSelection();
      this.drawSelectionUI();
      return;
    }

    if (this.activeHandle && this.selection) {
      // Lift selection if not already lifted
      if (!this.floatingCanvas) {
        this.liftSelection();
      }

      // Update corner position based on which handle is being dragged
      this.updateCornerFromHandle(this.activeHandle.id, pos);
      this.isTransforming = true;

      // Redraw with transform preview
      this.board.clearTop();
      this.drawTransformPreview();
      return;
    }

    if (!this.isSelecting || !this.startPos) {
      // Not doing anything - update cursor based on position
      this.updateCursor(pos);
      return;
    }

    // Update selection rectangle preview
    this.board.clearTop();
    this.drawSelectionPreview(pos);
  }

  onPointerUp(user, pos) {
    if (this.isDragging) {
      this.isDragging = false;
      this.drawSelectionUI();
      return;
    }

    if (this.activeHandle) {
      // Don't apply transform yet - keep handles in place for layered transforms
      // Transform will be applied when committing the selection
      this.activeHandle = null;
      this.isTransforming = false;
      this.board.clearTop();
      // Draw the transform preview (keeps showing warped result)
      if (this.floatingCanvas && this.corners) {
        this.drawTransformPreview();
      } else {
        this.drawSelectionUI();
      }
      return;
    }

    if (!this.isSelecting || !this.startPos) return;

    this.isSelecting = false;

    // Finalize selection rectangle
    const x = Math.min(this.startPos.x, pos.x);
    const y = Math.min(this.startPos.y, pos.y);
    const width = Math.abs(pos.x - this.startPos.x);
    const height = Math.abs(pos.y - this.startPos.y);

    // Minimum selection size
    if (width < 5 || height < 5) {
      this.board.clearTop();
      this.startPos = null;
      return;
    }

    this.selection = { x, y, width, height };
    this.startPos = null;

    // Initialize corners for transform
    this.initializeCorners();
    this.updateHandles();

    this.board.clearTop();
    this.drawSelectionUI();
  }

  initializeCorners() {
    if (!this.selection) return;

    const s = this.selection;
    this.corners = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };
    // Store original corners (in image coordinates, relative to top-left of selection)
    this.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: s.width, y: 0 },
      bl: { x: 0, y: s.height },
      br: { x: s.width, y: s.height }
    };
  }

  updateCornerFromHandle(handleId, pos) {
    if (!this.corners) return;

    const c = this.corners;

    switch (handleId) {
      // Corner handles - free transform
      case 'tl':
        c.tl.x = pos.x;
        c.tl.y = pos.y;
        break;
      case 'tr':
        c.tr.x = pos.x;
        c.tr.y = pos.y;
        break;
      case 'bl':
        c.bl.x = pos.x;
        c.bl.y = pos.y;
        break;
      case 'br':
        c.br.x = pos.x;
        c.br.y = pos.y;
        break;

      // Edge handles - constrained transform
      case 'tm': // Top middle - move both top corners
        const topDy = pos.y - (c.tl.y + c.tr.y) / 2;
        c.tl.y += topDy;
        c.tr.y += topDy;
        break;
      case 'bm': // Bottom middle
        const botDy = pos.y - (c.bl.y + c.br.y) / 2;
        c.bl.y += botDy;
        c.br.y += botDy;
        break;
      case 'ml': // Middle left
        const leftDx = pos.x - (c.tl.x + c.bl.x) / 2;
        c.tl.x += leftDx;
        c.bl.x += leftDx;
        break;
      case 'mr': // Middle right
        const rightDx = pos.x - (c.tr.x + c.br.x) / 2;
        c.tr.x += rightDx;
        c.br.x += rightDx;
        break;
    }

    // Update selection bounds based on corners
    this.updateSelectionFromCorners();
  }

  updateSelectionFromCorners() {
    if (!this.corners) return;

    const c = this.corners;
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    this.selection.x = minX;
    this.selection.y = minY;
    this.selection.width = maxX - minX;
    this.selection.height = maxY - minY;
  }

  drawTransformPreview() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    const ctx = this.board.topCtx;

    try {
      // Create homography for projective transform
      const homography = new Homography('projective');

      // Source points (original corners of the floating canvas)
      const srcPoints = [
        [this.originalCorners.tl.x, this.originalCorners.tl.y],
        [this.originalCorners.tr.x, this.originalCorners.tr.y],
        [this.originalCorners.bl.x, this.originalCorners.bl.y],
        [this.originalCorners.br.x, this.originalCorners.br.y]
      ];

      // Destination points (current corner positions, relative to output)
      const c = this.corners;
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

      const dstPoints = [
        [c.tl.x - minX, c.tl.y - minY],
        [c.tr.x - minX, c.tr.y - minY],
        [c.bl.x - minX, c.bl.y - minY],
        [c.br.x - minX, c.br.y - minY]
      ];

      // Set up homography
      homography.setSourcePoints(srcPoints, this.floatingCanvas);
      homography.setDestinyPoints(dstPoints);

      // Warp the image
      const result = homography.warp();

      if (result) {
        // Draw the warped result
        ctx.putImageData(result, minX, minY);
      }
    } catch (e) {
      // Fallback: just draw the original floating selection
      console.warn('Homography transform failed:', e);
      this.drawFloatingSelection();
    }

    // Draw the quadrilateral outline
    this.drawTransformOutline(ctx);

    // Draw handles at corners
    this.drawTransformHandles(ctx);
  }

  drawTransformOutline(ctx) {
    if (!this.corners) return;

    const c = this.corners;

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.marchingAntsOffset;

    ctx.beginPath();
    ctx.moveTo(c.tl.x, c.tl.y);
    ctx.lineTo(c.tr.x, c.tr.y);
    ctx.lineTo(c.br.x, c.br.y);
    ctx.lineTo(c.bl.x, c.bl.y);
    ctx.closePath();
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -this.marchingAntsOffset + 4;

    ctx.beginPath();
    ctx.moveTo(c.tl.x, c.tl.y);
    ctx.lineTo(c.tr.x, c.tr.y);
    ctx.lineTo(c.br.x, c.br.y);
    ctx.lineTo(c.bl.x, c.bl.y);
    ctx.closePath();
    ctx.stroke();

    ctx.setLineDash([]);
  }

  drawTransformHandles(ctx) {
    if (!this.corners) return;

    const c = this.corners;
    const handlePositions = [
      c.tl, c.tr, c.bl, c.br,
      { x: (c.tl.x + c.tr.x) / 2, y: (c.tl.y + c.tr.y) / 2 }, // tm
      { x: (c.bl.x + c.br.x) / 2, y: (c.bl.y + c.br.y) / 2 }, // bm
      { x: (c.tl.x + c.bl.x) / 2, y: (c.tl.y + c.bl.y) / 2 }, // ml
      { x: (c.tr.x + c.br.x) / 2, y: (c.tr.y + c.br.y) / 2 }  // mr
    ];

    for (const pos of handlePositions) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.fillRect(
        pos.x - this.handleSize / 2,
        pos.y - this.handleSize / 2,
        this.handleSize,
        this.handleSize
      );
      ctx.strokeRect(
        pos.x - this.handleSize / 2,
        pos.y - this.handleSize / 2,
        this.handleSize,
        this.handleSize
      );
    }
  }

  applyTransform() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    try {
      // Create homography for projective transform
      const homography = new Homography('projective');

      // Source points
      const srcPoints = [
        [this.originalCorners.tl.x, this.originalCorners.tl.y],
        [this.originalCorners.tr.x, this.originalCorners.tr.y],
        [this.originalCorners.bl.x, this.originalCorners.bl.y],
        [this.originalCorners.br.x, this.originalCorners.br.y]
      ];

      // Destination points
      const c = this.corners;
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

      const dstPoints = [
        [c.tl.x - minX, c.tl.y - minY],
        [c.tr.x - minX, c.tr.y - minY],
        [c.bl.x - minX, c.bl.y - minY],
        [c.br.x - minX, c.br.y - minY]
      ];

      homography.setSourcePoints(srcPoints, this.floatingCanvas);
      homography.setDestinyPoints(dstPoints);

      const result = homography.warp();

      if (result) {
        // Create new floating canvas with transformed result
        const newCanvas = document.createElement('canvas');
        newCanvas.width = result.width;
        newCanvas.height = result.height;
        const newCtx = newCanvas.getContext('2d');
        newCtx.putImageData(result, 0, 0);

        this.floatingCanvas = newCanvas;
        this.floatingCtx = newCtx;

        // Update selection to match new bounds
        this.selection.x = minX;
        this.selection.y = minY;
        this.selection.width = result.width;
        this.selection.height = result.height;

        // Reset corners to new selection bounds
        this.initializeCorners();
      }
    } catch (e) {
      console.warn('Failed to apply transform:', e);
    }
  }

  isInsideSelection(pos) {
    if (!this.selection) return false;
    const s = this.selection;
    return pos.x >= s.x && pos.x <= s.x + s.width &&
           pos.y >= s.y && pos.y <= s.y + s.height;
  }

  getHandleAtPoint(pos) {
    for (const handle of this.handles) {
      const dx = pos.x - handle.x;
      const dy = pos.y - handle.y;
      // Use larger hit area for easier clicking
      if (Math.abs(dx) <= this.handleHitArea && Math.abs(dy) <= this.handleHitArea) {
        return handle;
      }
    }
    return null;
  }

  updateHandles() {
    if (!this.selection) {
      this.handles = [];
      return;
    }

    // Use corners if available (for perspective transform), otherwise use selection bounds
    if (this.corners) {
      const c = this.corners;
      this.handles = [
        { id: 'tl', x: c.tl.x, y: c.tl.y },
        { id: 'tr', x: c.tr.x, y: c.tr.y },
        { id: 'bl', x: c.bl.x, y: c.bl.y },
        { id: 'br', x: c.br.x, y: c.br.y },
        { id: 'tm', x: (c.tl.x + c.tr.x) / 2, y: (c.tl.y + c.tr.y) / 2 },
        { id: 'bm', x: (c.bl.x + c.br.x) / 2, y: (c.bl.y + c.br.y) / 2 },
        { id: 'ml', x: (c.tl.x + c.bl.x) / 2, y: (c.tl.y + c.bl.y) / 2 },
        { id: 'mr', x: (c.tr.x + c.br.x) / 2, y: (c.tr.y + c.br.y) / 2 }
      ];
    } else {
      const s = this.selection;
      this.handles = [
        { id: 'tl', x: s.x, y: s.y },
        { id: 'tr', x: s.x + s.width, y: s.y },
        { id: 'bl', x: s.x, y: s.y + s.height },
        { id: 'br', x: s.x + s.width, y: s.y + s.height },
        { id: 'tm', x: s.x + s.width / 2, y: s.y },
        { id: 'bm', x: s.x + s.width / 2, y: s.y + s.height },
        { id: 'ml', x: s.x, y: s.y + s.height / 2 },
        { id: 'mr', x: s.x + s.width, y: s.y + s.height / 2 }
      ];
    }
  }

  drawSelectionPreview(pos) {
    const ctx = this.board.topCtx;
    const x = Math.min(this.startPos.x, pos.x);
    const y = Math.min(this.startPos.y, pos.y);
    const width = Math.abs(pos.x - this.startPos.x);
    const height = Math.abs(pos.y - this.startPos.y);

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.strokeRect(x, y, width, height);

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -this.marchingAntsOffset + 4;
    ctx.strokeRect(x, y, width, height);

    ctx.setLineDash([]);
  }

  drawSelectionUI() {
    if (!this.selection) return;

    const ctx = this.board.topCtx;
    const s = this.selection;

    // Draw floating selection if exists
    if (this.floatingCanvas) {
      this.drawFloatingSelection();
    }

    // Draw marching ants border
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.strokeRect(s.x, s.y, s.width, s.height);

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -this.marchingAntsOffset + 4;
    ctx.strokeRect(s.x, s.y, s.width, s.height);

    ctx.setLineDash([]);

    // Draw transform handles
    this.updateHandles();
    for (const handle of this.handles) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.fillRect(
        handle.x - this.handleSize / 2,
        handle.y - this.handleSize / 2,
        this.handleSize,
        this.handleSize
      );
      ctx.strokeRect(
        handle.x - this.handleSize / 2,
        handle.y - this.handleSize / 2,
        this.handleSize,
        this.handleSize
      );
    }
  }

  drawFloatingSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const ctx = this.board.topCtx;
    ctx.drawImage(
      this.floatingCanvas,
      this.selection.x,
      this.selection.y,
      this.selection.width,
      this.selection.height
    );
  }

  liftSelection() {
    if (!this.selection) return;

    const s = this.selection;

    // Create floating canvas with selection content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = s.width;
    this.floatingCanvas.height = s.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');

    // Copy selected region from main canvas
    const imageData = this.board.mainCtx.getImageData(s.x, s.y, s.width, s.height);
    this.floatingCtx.putImageData(imageData, 0, 0);
    this.selectedImageData = imageData;

    // Clear the region on main canvas
    this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);

    // Draw floating selection on top canvas
    this.board.clearTop();
    this.drawFloatingSelection();
    this.drawSelectionUI();
  }

  commitSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    // Check if we need to apply a homography transform
    if (this.hasTransformedCorners() && this.corners && this.originalCorners) {
      try {
        // Create homography for projective transform
        const homography = new Homography('projective');

        // Source points (original corners of the floating canvas)
        const srcPoints = [
          [this.originalCorners.tl.x, this.originalCorners.tl.y],
          [this.originalCorners.tr.x, this.originalCorners.tr.y],
          [this.originalCorners.bl.x, this.originalCorners.bl.y],
          [this.originalCorners.br.x, this.originalCorners.br.y]
        ];

        // Destination points (current corner positions, relative to output)
        const c = this.corners;
        const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
        const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

        const dstPoints = [
          [c.tl.x - minX, c.tl.y - minY],
          [c.tr.x - minX, c.tr.y - minY],
          [c.bl.x - minX, c.bl.y - minY],
          [c.br.x - minX, c.br.y - minY]
        ];

        // Set up homography
        homography.setSourcePoints(srcPoints, this.floatingCanvas);
        homography.setDestinyPoints(dstPoints);

        // Warp the image
        const result = homography.warp();

        if (result) {
          // Draw the warped result to the main canvas
          this.board.mainCtx.putImageData(result, minX, minY);
        } else {
          // Fallback: draw without transform
          this.board.mainCtx.drawImage(
            this.floatingCanvas,
            this.selection.x,
            this.selection.y,
            this.selection.width,
            this.selection.height
          );
        }
      } catch (e) {
        console.warn('Failed to apply homography transform on commit:', e);
        // Fallback: draw without transform
        this.board.mainCtx.drawImage(
          this.floatingCanvas,
          this.selection.x,
          this.selection.y,
          this.selection.width,
          this.selection.height
        );
      }
    } else {
      // No transform needed, just draw at current position
      this.board.mainCtx.drawImage(
        this.floatingCanvas,
        this.selection.x,
        this.selection.y,
        this.selection.width,
        this.selection.height
      );
    }

    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.selectedImageData = null;
    this.board.clearTop();
  }

  clearSelection() {
    this.selection = null;
    this.handles = [];
    this.corners = null;
    this.originalCorners = null;
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.selectedImageData = null;
    this.isTransforming = false;
    this.board.clearTop();
  }

  // Copy selection to clipboard
  copy() {
    if (!this.selection) return false;

    const s = this.selection;

    // Get image data from floating canvas if lifted, otherwise from main canvas
    if (this.floatingCanvas) {
      this.clipboard = {
        width: s.width,
        height: s.height,
        imageData: this.floatingCtx.getImageData(0, 0, s.width, s.height)
      };
    } else {
      this.clipboard = {
        width: s.width,
        height: s.height,
        imageData: this.board.mainCtx.getImageData(s.x, s.y, s.width, s.height)
      };
    }

    return true;
  }

  // Cut selection (copy + delete)
  cut() {
    if (!this.selection) return false;

    this.copy();
    this.deleteSelection();
    return true;
  }

  // Paste from clipboard
  paste() {
    if (!this.clipboard) return false;

    // Commit any existing selection
    this.commitSelection();
    this.clearSelection();

    // Create new selection at center of viewport (or offset from original)
    const x = 50;
    const y = 50;

    this.selection = {
      x,
      y,
      width: this.clipboard.width,
      height: this.clipboard.height
    };

    // Create floating canvas with clipboard content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = this.clipboard.width;
    this.floatingCanvas.height = this.clipboard.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    this.floatingCtx.putImageData(this.clipboard.imageData, 0, 0);

    // Initialize corners for transform handles
    this.initializeCorners();
    this.updateHandles();
    this.board.clearTop();
    this.drawFloatingSelection();
    this.drawSelectionUI();

    return true;
  }

  // Delete selection content
  deleteSelection() {
    if (!this.selection) return false;

    const s = this.selection;

    // If floating, just discard it
    if (this.floatingCanvas) {
      this.floatingCanvas = null;
      this.floatingCtx = null;
    } else {
      // Clear region on main canvas
      this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);
    }

    this.clearSelection();
    return true;
  }

  // Select all
  selectAll() {
    this.commitSelection();
    this.clearSelection();

    this.selection = {
      x: 0,
      y: 0,
      width: this.board.mainCanvas.width,
      height: this.board.mainCanvas.height
    };

    // Initialize corners for transform handles
    this.initializeCorners();
    this.updateHandles();
    this.board.clearTop();
    this.drawSelectionUI();
  }

  // Deselect
  deselect() {
    this.commitSelection();
    this.clearSelection();
  }

  hasSelection() {
    return this.selection !== null;
  }

  hasClipboard() {
    return this.clipboard !== null;
  }

  // Check if corners have been transformed from their original positions
  hasTransformedCorners() {
    if (!this.corners || !this.originalCorners || !this.selection) return false;

    // Compare current corner positions with what they would be if untransformed
    const s = this.selection;
    const untransformed = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };

    const tolerance = 0.5;
    const c = this.corners;

    return (
      Math.abs(c.tl.x - untransformed.tl.x) > tolerance ||
      Math.abs(c.tl.y - untransformed.tl.y) > tolerance ||
      Math.abs(c.tr.x - untransformed.tr.x) > tolerance ||
      Math.abs(c.tr.y - untransformed.tr.y) > tolerance ||
      Math.abs(c.bl.x - untransformed.bl.x) > tolerance ||
      Math.abs(c.bl.y - untransformed.bl.y) > tolerance ||
      Math.abs(c.br.x - untransformed.br.x) > tolerance ||
      Math.abs(c.br.y - untransformed.br.y) > tolerance
    );
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
    this.drawPreview(user, pos);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !this.startPos) return;
    this.board.clearTop();
    this.drawPreview(user, pos);
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

  drawPreview(user, pos) {
    this.drawLine(this.board.topCtx, user, this.startPos, pos);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      const mirroredStart = { x: width - this.startPos.x, y: this.startPos.y };
      const mirroredEnd = { x: width - pos.x, y: pos.y };
      this.drawLine(this.board.topCtx, user, mirroredStart, mirroredEnd);
    }
  }

  drawLine(ctx, user, start, end) {
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
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

    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.stroke();
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

    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
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
      gimp: new GimpTool(board)
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
