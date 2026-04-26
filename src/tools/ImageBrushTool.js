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
    this._tintCache = new Map();
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
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRequestUpdate) {
    if (!user.mousedown || user.panning || !user.imageBrush) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this.drawStamp(user, pos);
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      if (shouldRequestUpdate) this.board.requestUpdate();
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
      if (shouldRequestUpdate) this.board.requestUpdate();
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

      this.board.forEachMirrorRegion({ rect: { x, y, width, height } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.minX, y: this.dirtyBounds.minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.maxX, y: this.dirtyBounds.maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
        const my = Math.floor(Math.min(p1.y, p2.y) - margin);
        const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
        const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });
    }

    // Track tile ownership
    if (this.strokePoints.length > 0) {
      this.board.markDirtyPath(user, this.strokePoints, user.size);
      this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(this.strokePoints, region), user.size);
      });
    }
    this.strokePoints = [];

    this.board.endStroke(user);
    this.board.clearTop();

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
    // Check if the user object and its ID are valid (allow ID 0).
    // Changed from 'user && user.id' to 'user && user.id != null' to correctly handle user ID 0.
    const isUserValid = user && user.id != null;

    if (!isUserValid) {
        console.error(`ImageBrushTool: Skipping stroke application for invalid user/ID. User data:`, user);
        return;
    }

    // If activeLayer is not set for this user (e.g., remote user receiving stroke data),
    // initiate a new stroke to create it. This mimics behavior for local users.
    // Target the layer where the stroke actually started, fallback to activeLayer
    const strokeLayer = user._strokeLayer ?? user.activeLayer ?? 0;

    // Check if there is already an active stroke for this user on that layer.
    const hasActiveStroke = this.board.layerManager?.getActiveStroke(strokeLayer, user.id);

    if (!hasActiveStroke) {
        console.warn(`ImageBrushTool: User ${user.id} has no active stroke on layer ${strokeLayer}. Initiating new stroke.`);
        this.board.beginStroke(user); 
    }
    
    // After ensuring activeLayer is set, proceed with drawing.
    // The drawStamp method itself still checks if the context is valid.
    const points = [];
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      this.drawStamp(user, pos);
      points.push(pos);
    }

    // Track tile ownership
    if (points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.board.requestUpdate();
  }

  /**
   * Draw the mirrored live preview for the active image-brush stroke.
   * The primary stroke already exists on the active stroke layer canvas,
   * so the top canvas only needs the mirrored replay.
   * @param {Object} user
   */
  drawPreview(user = this._activeUser) {
    if (!user) return;
    const strokeCtx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    const previewCtx = this.board.topCtx;
    if (!strokeCtx || !previewCtx || !strokeCtx.canvas) return;

    previewCtx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
      this.board.drawMirroredCanvas(previewCtx, strokeCtx.canvas, region, 0, 0);
    });
    previewCtx.globalAlpha = 1.0;
  }

  _getTintedImage(user, image, frameKey = '') {
    const colorKey = user.color.slice(0, 3).join(',');
    const brush = user.imageBrush;
    const brushKey = brush?.brushName || brush?.fileName || 'brush';
    const cacheKey = `${brushKey}_${frameKey}_${colorKey}`;
    if (this._tintCache.has(cacheKey)) return this._tintCache.get(cacheKey);

    const w = image.naturalWidth || image.width || 1;
    const h = image.naturalHeight || image.height || 1;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = `rgb(${user.color[0]}, ${user.color[1]}, ${user.color[2]})`;
    ctx.fillRect(0, 0, w, h);
    this._tintCache.set(cacheKey, canvas);
    return canvas;
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

    const strokeLayer = user._strokeLayer ?? user.activeLayer ?? 0;
    const ctx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id);
    if (!ctx) {
      console.error(`ImageBrushTool: Failed to get active layer context for user ${user.id}. Layer:`, strokeLayer);
      return;
    }

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

    if (brush.type !== 'gih' && (user.imageBrushColorMode || 'original') === 'tinted' && image) {
      image = this._getTintedImage(user, image);
    }

    this.lastPos = { x: pos.x, y: pos.y };
    this.lastTime = performance.now();

    let ratioX = width / height;
    let ratioY = height / width;

    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    ctx.beginPath(); // Start a new path for this stamp
    ctx.fillStyle = user.getColorString();

    const stampX = pos.x - scaledSize * ratioX;
    const stampY = pos.y - scaledSize * ratioY;
    const stampW = scaledSize * 2 * ratioX;
    const stampH = scaledSize * 2 * ratioY;
    
    const drawStampImage = (targetCtx) => {
      const prevSmoothing = targetCtx.imageSmoothingEnabled;
      if (brush.type === 'svg') {
        targetCtx.imageSmoothingEnabled = true;
      }
      targetCtx.drawImage(image, stampX, stampY, stampW, stampH);
      targetCtx.imageSmoothingEnabled = prevSmoothing;
    };

    // Draw the main stamp
    drawStampImage(ctx);

    // Save context state before mirroring operations to ensure it's restored correctly.
    // This is a defensive measure in case board.withMirroredRegionTransform does not fully restore state.
    ctx.save(); 
    
    this.board.forEachMirrorRegion({ rect: { x: stampX, y: stampY, width: stampW, height: stampH } }, (region) => {
      this.board.withMirroredRegionTransform(ctx, region, () => {
        drawStampImage(ctx); // Draw mirrored stamp
      });
    });

    // Restore context state after mirroring operations
    ctx.restore();

    ctx.stroke(); // Apply the path (all draws since beginPath)
    ctx.globalAlpha = 1.0;

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, stampX);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, stampY);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, stampX + stampW);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, stampY + stampH);
    }

    this.board.expandDirtyRect(user, Math.floor(stampX), Math.floor(stampY),
      Math.ceil(stampW) + 1, Math.ceil(stampH) + 1);

    this.board.forEachMirrorRegion({ rect: { x: stampX, y: stampY, width: stampW, height: stampH } }, (region) => {
      const p1 = this.board.mirrorPointToRegion({ x: stampX, y: stampY }, region);
      const p2 = this.board.mirrorPointToRegion({ x: stampX + stampW, y: stampY + stampH }, region);
      const mx = Math.floor(Math.min(p1.x, p2.x));
      const my = Math.floor(Math.min(p1.y, p2.y));
      const mw = Math.ceil(Math.max(p1.x, p2.x)) - mx + 1;
      const mh = Math.ceil(Math.max(p1.y, p2.y)) - my + 1;
      this.board.expandDirtyRect(user, mx, my, mw, mh);
    });
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
