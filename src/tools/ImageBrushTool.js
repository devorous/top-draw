/**
 * @fileoverview Image brush tool - supports GIMP brushes (.gbr/.gih) and standard images.
 * Uses distance-based spacing for consistent stamp intervals regardless of cursor speed.
 */

import { parseGbr, parseGih } from '../utils/parseGimp.js';

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Image brush tool - supports GIMP brushes (.gbr/.gih) and standard images.
 */
export class ImageBrushTool extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('imageBrush', board);
    this.lastPos = null;
    this.lastTime = null;
    this.lastStampPos = new Map(); // userId -> {x, y}
    this.stampBuffer = []; // [x, y, x, y, ...] for broadcast
    this.strokePoints = []; // Track points for tile ownership
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool and cleans up tracking.
   */
  deactivate() {
    if (this._activeUser && this.lastStampPos.has(this._activeUser.id)) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      this.onPointerUp(this._activeUser, lastPos);
    }
    this.lastStampPos.clear();
    this._activeUser = null;
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerDown(user, pos) {
    if (user.imageBrush) {
      this._activeUser = user;
      this.board.beginStroke(user);
      this.lastPos = { x: pos.x, y: pos.y };
      this.lastTime = performance.now();
      if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
        user.imageBrush.reset();
      }
      this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      this.strokePoints = [{ x: pos.x, y: pos.y }];
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   */
  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !user.imageBrush) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.requestUpdate();
      return;
    }

    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
    const minSpacing = Math.max(1, user.size * spacingPercent);

    if (distance >= minSpacing) {
      const steps = Math.max(1, Math.floor(distance / minSpacing));

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpX = lastStamp.x + dx * t;
        const interpY = lastStamp.y + dy * t;
        this.drawStamp(user, { x: interpX, y: interpY });
        this.stampBuffer.push(interpX, interpY);
        this.strokePoints.push({ x: interpX, y: interpY });
      }

      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.requestUpdate();
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (user.panning || !user.imageBrush) return;

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const brushRadius = user.size;
      const safetyMargin = brushRadius * 0.25;
      const margin = safetyMargin + 2; 

      const x = Math.floor(this.dirtyBounds.minX - margin);
      const y = Math.floor(this.dirtyBounds.minY - margin);
      const width = Math.ceil(this.dirtyBounds.maxX - this.dirtyBounds.minX + margin * 2);
      const height = Math.ceil(this.dirtyBounds.maxY - this.dirtyBounds.minY + margin * 2);

      this.board.expandDirtyRect(user, x, y, width, height);

      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirrorX = Math.floor(boardWidth - this.dirtyBounds.maxX - margin);
        this.board.expandDirtyRect(user, mirrorX, y, width, height);
      }
    }

    // Track tile ownership
    if (this.strokePoints.length > 0) {
      this.board.markDirtyPath(user, this.strokePoints, user.size);
      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirroredPoints = this.strokePoints.map(pt => ({ x: boardWidth - pt.x, y: pt.y }));
        this.board.markDirtyPath(user, mirroredPoints, user.size);
      }
    }
    this.strokePoints = [];

    this.board.compositeAllLayers();
    this.board.endStroke(user);

    this.lastStampPos.delete(user.id);
    this.dirtyBounds = null;
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
    // Track tile ownership for remote user
    if (points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      if (this.board.mirror) {
        const boardWidth = this.board.getWidth();
        const mirroredPoints = points.map(pt => ({ x: boardWidth - pt.x, y: pt.y }));
        this.board.markDirtyPath(user, mirroredPoints, user.size);
      }
    }
    this.board.requestUpdate();
  }

  /**
   * Draws a single brush stamp at the given position.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The position to draw the stamp.
   */
  drawStamp(user, pos) {
    const brush = user.imageBrush;
    if (!brush) return;
    const size = user.size;
    const pressure = user.pressure ?? 1;
    const scaledSize = size * pressure;

    const ctx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    if (!ctx) return;

    let height, width, image;

    if (brush.type === 'gbr') {
      height = brush.height;
      width = brush.width;
      image = brush.image;
    } else if (brush.type === 'gih') {
      height = brush.cellheight;
      width = brush.cellwidth;

      const context = this.calculateContext(user, pos);

      if (brush.getNextBrush) {
        const result = brush.getNextBrush(context);
        image = brush.images[result.index];
      } else {
        image = brush.images[brush.index];
        brush.index = (brush.index + 1) % brush.ncells;
      }
    } else if (brush.type === 'image' || brush.type === 'svg') {
      height = brush.height;
      width = brush.width;
      image = brush.image;
    }

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

    // Disable image smoothing for SVGs to keep them crisp when scaled
    const prevSmoothing = ctx.imageSmoothingEnabled;
    if (brush.type === 'svg') {
      ctx.imageSmoothingEnabled = false;
    }

    ctx.drawImage(image, stampX, stampY, stampW, stampH);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
    ctx.imageSmoothingEnabled = prevSmoothing;

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, stampX);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, stampY);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, stampX + stampW);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, stampY + stampH);
    }

    this.board.expandDirtyRect(user, Math.floor(stampX), Math.floor(stampY),
      Math.ceil(stampW) + 1, Math.ceil(stampH) + 1);
  }

  /**
   * Calculate context for GIH selection modes.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @returns {Object} - The context object for GIH selection.
   */
  calculateContext(user, pos) {
    const context = {
      pressure: user.pressure || 0.5,
      angle: 0,
      velocity: 0,
      tiltX: 0,
      tiltY: 0
    };

    if (this.lastPos) {
      const dx = pos.x - this.lastPos.x;
      const dy = pos.y - this.lastPos.y;

      if (dx !== 0 || dy !== 0) {
        let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
        context.angle = ((angle % 360) + 360) % 360;
      }

      if (this.lastTime) {
        const dt = performance.now() - this.lastTime;
        if (dt > 0) {
          const distance = Math.sqrt(dx * dx + dy * dy);
          context.velocity = distance / dt * 16; 
        }
      }
    }

    return context;
  }

  /**
   * Loads a brush from a file.
   * @param {File} file - The brush file to load.
   * @param {Object} user - The user associated with the brush.
   * @returns {Promise<Object>} - A promise that resolves to the loaded brush object.
   */
  loadBrush(file, user) {
    return new Promise((resolve, reject) => {
      const fileType = file.name.split('.').pop().toLowerCase();

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
