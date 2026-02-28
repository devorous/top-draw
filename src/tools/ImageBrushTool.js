import { parseGbr, parseGih } from '../utils/parseGimp.js';

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
 * Image brush tool - supports GIMP brushes (.gbr/.gih) and standard images (.png/.jpg/.webp)
 * Uses distance-based spacing for consistent stamp intervals regardless of cursor speed.
 */
export class ImageBrushTool extends Tool {
  constructor(board) {
    super('imageBrush', board);
    this.lastPos = null;
    this.lastTime = null;
    this.lastStampPos = new Map(); // userId -> {x, y} - last stamp position for distance-based spacing
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  deactivate() {
    this.lastStampPos.clear();
  }

  onPointerDown(user, pos) {
    if (user.imageBrush) {
      this.board.beginStroke(user);
      this.lastPos = { x: pos.x, y: pos.y };
      this.lastTime = performance.now();
      // Reset GIH brush dimensions on new stroke
      if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
        user.imageBrush.reset();
      }
      // Initialize dirty rect tracking
      this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      // Stamp first image immediately and track position
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !user.imageBrush) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      // Fallback: stamp and track
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      return;
    }

    // Distance-based spacing
    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Spacing calculation: 0 = 10% (default), 1-20 = 5%-100% of brush size
    const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
    const minSpacing = Math.max(1, user.size * spacingPercent);

    if (distance >= minSpacing) {
      // Interpolate stamps along the path for smooth coverage
      const steps = Math.max(1, Math.floor(distance / minSpacing));

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpX = lastStamp.x + dx * t;
        const interpY = lastStamp.y + dy * t;
        this.drawStamp(user, { x: interpX, y: interpY });
      }

      // Update last stamp position to the final interpolated point
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  onPointerUp(user, pos, e) {
    if (user.panning || !user.imageBrush) return;

    // Commit the stroke from user canvas to active layer
    // For local user: commits from topCtx to active layer
    // For remote users: commits from their user.context to active layer
    if (user.context) {
      // Get the user's canvas
      const userCanvas = user.context.canvas;

      // Composite source-over into sub-layer; blend mode applied at composite time.
      const layerCtx = this.board.getActiveLayerContext();
      layerCtx.globalCompositeOperation = 'source-over';
      layerCtx.globalAlpha = 1.0;
      layerCtx.drawImage(userCanvas, 0, 0);

      // Handle mirror mode
      if (this.board.mirror) {
        layerCtx.save();
        layerCtx.globalCompositeOperation = 'source-over';
        layerCtx.translate(this.board.getWidth(), 0);
        layerCtx.scale(-1, 1);
        layerCtx.drawImage(userCanvas, 0, 0);
        layerCtx.restore();
      }

      // Clear the user's canvas for the next stroke
      user.context.clearRect(0, 0, userCanvas.width, userCanvas.height);
    }

    // Update dirty rect before ending stroke with 25% safety margin
    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      // Add 25% safety margin for image brush edges/anti-aliasing
      const brushRadius = user.size;
      const safetyMargin = brushRadius * 0.25;
      const margin = safetyMargin + 2; // +2 for anti-aliasing

      const x = Math.floor(this.dirtyBounds.minX - margin);
      const y = Math.floor(this.dirtyBounds.minY - margin);
      const width = Math.ceil(this.dirtyBounds.maxX - this.dirtyBounds.minX + margin * 2);
      const height = Math.ceil(this.dirtyBounds.maxY - this.dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      // Mirror dirty rect if mirror mode is enabled
      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirrorX = Math.floor(boardWidth - this.dirtyBounds.maxX - margin);
        this.board.expandDirtyRect(user, mirrorX, y, width, height);
      }
    }

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
    this.board.endStroke(user);

    // Clean up tracking
    this.lastStampPos.delete(user.id);
    this.dirtyBounds = null;
  }

  drawStamp(user, pos) {
    const brush = user.imageBrush;
    const size = user.size;
    const pressure = user.pressure ?? 1;  // Use ?? instead of || so 0 doesn't default to 1
    const scaledSize = size * pressure;
    // Use user.context for remote users, mainCtx for local user
    const ctx = user.context || this.board.mainCtx;

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

    const stampX = pos.x - scaledSize * ratioX;
    const stampY = pos.y - scaledSize * ratioY;
    const stampW = scaledSize * 2 * ratioX;
    const stampH = scaledSize * 2 * ratioY;

    ctx.drawImage(image, stampX, stampY, stampW, stampH);
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Track dirty bounds
    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, stampX);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, stampY);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, stampX + stampW);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, stampY + stampH);
    }
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
