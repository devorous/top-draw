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

  onPointerUp(user, pos, e) {
    if (user.panning || !user.imageBrush) return;

    // Commit the stroke from user canvas to main canvas
    // For local user: commits from topCtx to mainCtx
    // For remote users: commits from their user.context to mainCtx
    if (user.context) {
      // Get the user's canvas
      const userCanvas = user.context.canvas;

      // Draw it to the main canvas
      this.board.mainCtx.globalCompositeOperation = 'source-over';
      this.board.mainCtx.globalAlpha = 1.0;
      this.board.mainCtx.drawImage(userCanvas, 0, 0);

      // Handle mirror mode
      if (this.board.mirror) {
        this.board.mainCtx.save();
        this.board.mainCtx.translate(this.board.getWidth(), 0);
        this.board.mainCtx.scale(-1, 1);
        this.board.mainCtx.drawImage(userCanvas, 0, 0);
        this.board.mainCtx.restore();
      }

      // Clear the user's canvas for the next stroke
      user.context.clearRect(0, 0, userCanvas.width, userCanvas.height);
    }
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
