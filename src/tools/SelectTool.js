/**
 * @fileoverview Selection tool for manipulating canvas content.
 * Provides lasso and rectangular selection, move, rotate, and homography-based transforms.
 */

import { Homography } from '../utils/homography.js';
import { performHomographyTransform, imageDataToCanvas, calculateCornerBounds } from '../utils/homographyUtils.js';
import { pointInHull, distanceBasedCulling } from '../utils/drawing.js';

/**
 * Base tool class for all interactive board tools.
 */
class Tool {
  /**
   * @param {string} name - Unique identifier for the tool.
   * @param {Board} board - The drawing board instance.
   */
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
 * Selection tool for selecting, moving, and transforming regions.
 * Supports both rectangular and lasso selection modes.
 */
export class SelectTool extends Tool {
  /**
   * @param {Board} board - The drawing board instance.
   */
  constructor(board) {
    super('select', board);
    this.mode = 'lasso'; // 'rectangle' or 'lasso'
    this.copyAllLayers = false; // Toggle: copy/cut all visible layers vs active layer only
    this._restoreData = null; // Snapshot of erased area
    this.floatingLayers = null; // Per-layer canvases when copyAllLayers is active
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
    this.handleHitArea = 20;

    // Corner positions for transform
    this.corners = null; // { tl, tr, bl, br }
    this.originalCorners = null; // Original corners relative to selection
    this.originalSelectionPos = null;

    // Rotation
    this.rotation = 0;
    this.rotationHandleDistance = 30;
    this.isRotating = false;
    this.rotationStartAngle = 0;
    this.cornersAtRotationStart = null;

    // Perspective handles
    this.perspectiveHandleDistance = 40;

    // Homography instances
    this.homography = null;
    this.previewHomography = null;
    this.isTransforming = false;

    // Preview downscaling
    this.previewMaxSize = 512;
    this.hasShownPreviewToast = false;

    // Cache for transformed preview
    this._cachedTransform = null; // { canvas, bounds, cornersKey }

    // Clipboard
    this.clipboard = null;

    // Context menu elements
    this.menuElements = null;

    // Menu positioning
    this.lastPointerUpPos = null;

    // Pattern mode
    this.patternMode = false;
    this._patternTileCache = new Map();

    // Throttling for selection move broadcasts (30 TPS)
    this.selectionMoveThrottleRate = 30;
    this.selectionMoveThrottleInterval = 1000 / this.selectionMoveThrottleRate;
    this.lastSelectionBroadcastTime = 0;
    this.pendingSelectionBroadcast = null;

    // Lasso-specific state
    this.lassoPoints = [];
    this.lassoSimplified = null;
    this.lassoPath = null;
  }

  /**
   * Get pattern tile for selection fill (reuses PatternTool's tile generation logic).
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
   * Draw a canvas with pattern fill (uses canvas as alpha mask).
   * @private
   */
  _drawWithPattern(targetCtx, sourceCanvas, x, y, user) {
    const tile = this._getPatternTile(user);
    if (!tile) {
      // Fallback to normal draw if no pattern
      targetCtx.drawImage(sourceCanvas, x, y);
      return;
    }

    let scale = (user.patternScale || 100) / 100;
    // SVGs are rendered at 200px but should display as 40px at 100% scale
    if (user.patternBrush && user.patternBrush.type === 'svg') {
      scale *= 0.2;
    }
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const rotation = user.patternRotation || 0;

    // Create temp canvas for pattern fill
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceCanvas.width;
    tempCanvas.height = sourceCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Step 1: Draw source canvas as black mask
    tempCtx.drawImage(sourceCanvas, 0, 0);

    // Convert to black mask (preserve alpha)
    const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) {
        data[i] = 0;     // R = black
        data[i + 1] = 0; // G = black
        data[i + 2] = 0; // B = black
        // Keep alpha as-is
      }
    }
    tempCtx.putImageData(imgData, 0, 0);

    // Step 2: Create pattern and fill
    const pattern = tempCtx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(rotation)
        .scale(scale);
      pattern.setTransform(matrix);
    }

    tempCtx.globalCompositeOperation = 'source-in';
    tempCtx.fillStyle = pattern;
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Step 3: Draw result to target
    targetCtx.drawImage(tempCanvas, x, y);
  }

  /**
   * Build the canvas path for the current selection shape (lasso polygon or rect).
   * All coordinates are in the local space of ctx: lasso points are shifted by offsetX/offsetY.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{width: number, height: number}} rect
   * @param {number} [offsetX=0] - Canvas-space X origin of this context (subtracted from lasso coords).
   * @param {number} [offsetY=0] - Canvas-space Y origin of this context.
   * @returns {boolean} true if a lasso path was built, false for a simple rect.
   * @private
   */
  _applyPath(ctx, rect, offsetX = 0, offsetY = 0) {
    if (this.mode === 'lasso' && this.lassoPath?.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(this.lassoPath[0].x - offsetX, this.lassoPath[0].y - offsetY);
      for (let i = 1; i < this.lassoPath.length; i++) {
        ctx.lineTo(this.lassoPath[i].x - offsetX, this.lassoPath[i].y - offsetY);
      }
      ctx.closePath();
      return true;
    }
    ctx.rect(0, 0, rect.width, rect.height);
    return false;
  }

  /**
   * Fill ctx with the current color or pattern, clipped to the selection shape.
   * ctx is assumed to be in local space (0,0 = top-left of the selection rect).
   * @param {CanvasRenderingContext2D} ctx
   * @param {{width: number, height: number}} rect
   * @param {Object} user - User state (color, patternBrush, etc.)
   * @param {number} opacity
   * @param {number} [offsetX=0] - Canvas-space X origin used to align lasso coords and pattern tile.
   * @param {number} [offsetY=0]
   * @private
   */
  _executeFill(ctx, rect, user, opacity, offsetX = 0, offsetY = 0) {
    ctx.save();
    const isLasso = this._applyPath(ctx, rect, offsetX, offsetY);

    if (this.patternMode) {
      const tile = this._getPatternTile(user);
      if (tile) {
        let scale = (user.patternScale || 100) / 100;
        if (user.patternBrush?.type === 'svg') scale *= 0.2;
        const pattern = ctx.createPattern(tile, 'repeat');
        const matrix = new DOMMatrix()
          .translate((user.patternOffsetX || 0) - offsetX, (user.patternOffsetY || 0) - offsetY)
          .rotate(user.patternRotation || 0)
          .scale(scale);
        pattern.setTransform(matrix);

        ctx.clip();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.restore();
        return;
      }
    }

    // Solid color (also pattern fallback when no tile is loaded)
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    if (isLasso) {
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, rect.width, rect.height);
    }
    ctx.restore();
  }

  /**
   * Activates the tool.
   */
  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
    this.startMarchingAnts();
    this.setupMenuListeners();
  }

  /**
   * Deactivates the tool, committing any active selection.
   */
  deactivate() {
    this.stopMarchingAnts();
    this.commitSelection();
    this.clearSelection();
    this.hideContextMenu();
    this.board.container.style.cursor = 'none';
    // Reset topCtx line dash to prevent dotted lines bleeding into other tools
    this.board.topCtx.setLineDash([]);
    if (this.board.app?.ui) {
      this.board.app.ui.setSelectCursor(false);
    }
  }

  /**
   * Throttled broadcast for selection moves to limit network/render load.
   * @param {Object} corners - { tl: {x,y}, tr: {x,y}, bl: {x,y}, br: {x,y} }
   * @param {boolean} [force=false] - If true, bypass throttle.
   */
  throttledBroadcastSelectionMove(corners, force = false) {
    if (!this.board.app || !this.board.app.wsClient) return;

    const now = performance.now();
    const elapsed = now - this.lastSelectionBroadcastTime;

    if (force || elapsed >= this.selectionMoveThrottleInterval) {
      this.board.app.wsClient.broadcastSelectionMove(corners);
      this.lastSelectionBroadcastTime = now;
      this.pendingSelectionBroadcast = null;
    } else {
      this.pendingSelectionBroadcast = { ...corners };
    }
  }

  /**
   * Flush any pending selection broadcast.
   */
  flushPendingSelectionBroadcast() {
    if (this.pendingSelectionBroadcast && this.board.app && this.board.app.wsClient) {
      this.board.app.wsClient.broadcastSelectionMove(this.pendingSelectionBroadcast);
      this.pendingSelectionBroadcast = null;
      this.lastSelectionBroadcastTime = performance.now();
    }
  }

  /**
   * Set selection mode.
   * @param {string} mode - 'rectangle' or 'lasso'.
   */
  setMode(mode) {
    if (this.selection) {
      this.commitSelection();
      this.clearSelection();
    }
    this.mode = mode;
  }

  /**
   * Get bounding box from array of points.
   * @param {Array<{x: number, y: number}>} points
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getBoundsFromPoints(points) {
    if (!points || points.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    return {
      x,
      y,
      width: Math.ceil(maxX) - x,
      height: Math.ceil(maxY) - y
    };
  }

  /**
   * Draw lasso preview during selection.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<{x: number, y: number}>} points
   */
  drawLassoPreview(ctx, points) {
    if (points.length < 2) return;

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.marchingAntsOffset;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -this.marchingAntsOffset + 4;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    ctx.setLineDash([]);

    if (this.board.mirror && points.length >= 2) {
      const bw = this.board.getWidth();
      const mPoints = points.map(p => ({ x: bw - p.x, y: p.y }));
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.beginPath();
      ctx.moveTo(mPoints[0].x, mPoints[0].y);
      for (let i = 1; i < mPoints.length; i++) ctx.lineTo(mPoints[i].x, mPoints[i].y);
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.beginPath();
      ctx.moveTo(mPoints[0].x, mPoints[0].y);
      for (let i = 1; i < mPoints.length; i++) ctx.lineTo(mPoints[i].x, mPoints[i].y);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Apply lasso mask to a canvas context.
   * @param {CanvasRenderingContext2D} ctx - The context to mask.
   * @param {number} offsetX - X offset relative to canvas.
   * @param {number} offsetY - Y offset relative to canvas.
   * @param {Array<{x: number, y: number}>} lassoPath - The lasso polygon.
   */
  applyLassoMask(ctx, offsetX, offsetY, lassoPath) {
    if (!lassoPath || lassoPath.length < 3) return;

    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.moveTo(lassoPath[0].x - offsetX, lassoPath[0].y - offsetY);
    for (let i = 1; i < lassoPath.length; i++) {
      ctx.lineTo(lassoPath[i].x - offsetX, lassoPath[i].y - offsetY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Sets up context menu event listeners.
   */
  setupMenuListeners() {
    if (this.menuElements) return;

    this.menuElements = {
      menu: document.getElementById('selectionMenu'),
      clear: document.getElementById('selMenuClear'),
      fill: document.getElementById('selMenuFill'),
      copy: document.getElementById('selMenuCopy'),
      brush: document.getElementById('selMenuBrush'),
      flip: document.getElementById('selMenuFlip'),
      stamp: document.getElementById('selMenuStamp'),
      save: document.getElementById('selMenuSave'),
      cancel: document.getElementById('selMenuCancel')
    };

    if (!this.menuElements.menu) return;

    this.menuElements.clear.addEventListener('click', () => this.deleteSelection());
    this.menuElements.fill.addEventListener('click', () => this.fillSelection());
    this.menuElements.copy.addEventListener('click', () => this.copy());
    this.menuElements.brush.addEventListener('click', () => this.toImageBrush());
    this.menuElements.flip.addEventListener('click', () => this.flipHorizontal());
    this.menuElements.stamp.addEventListener('click', () => this.stamp());
    this.menuElements.save.addEventListener('click', () => this.saveSelection());
    this.menuElements.cancel.addEventListener('click', () => this.cancelSelection());
  }

  /**
   * Displays the selection context menu.
   * @param {boolean} skipReposition - If true, skip repositioning when menu is already visible
   */
  showContextMenu(skipReposition = false) {
    if (!this.menuElements?.menu || !this.selection) return;

    const menu = this.menuElements.menu;
    const wasVisible = menu.style.display !== 'none';
    const hasMoved = this.hasBeenMoved();

    this.menuElements.clear.classList.toggle('hidden', hasMoved);
    this.menuElements.fill.classList.toggle('hidden', hasMoved);
    this.menuElements.flip.classList.toggle('hidden', false);
    this.menuElements.stamp.classList.toggle('hidden', !hasMoved);
    this.menuElements.save.classList.toggle('hidden', false);
    this.menuElements.cancel.classList.toggle('hidden', !hasMoved);

    menu.classList.toggle('grid', hasMoved);
    menu.style.display = '';

    // Skip repositioning if menu was already visible and we're just updating buttons
    if (skipReposition && wasVisible) return;

    let canvasX, canvasY;

    if (this.lastPointerUpPos) {
      canvasX = this.lastPointerUpPos.x;
      canvasY = this.lastPointerUpPos.y;
    } else {
      const rightX = this.corners
        ? Math.max(this.corners.tl.x, this.corners.tr.x, this.corners.bl.x, this.corners.br.x)
        : this.selection.x + this.selection.width;
      const bottomY = this.corners
        ? Math.max(this.corners.tl.y, this.corners.tr.y, this.corners.bl.y, this.corners.br.y)
        : this.selection.y + this.selection.height;

      canvasX = rightX;
      canvasY = bottomY;
    }

    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    const screenX = canvasX * zoom + panX;
    const screenY = canvasY * zoom + panY;

    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;

    const containerRect = this.board.container.getBoundingClientRect();

    let left = containerRect.left + screenX + 10;
    let top = containerRect.top + screenY + 10;

    left = Math.max(10, Math.min(left, window.innerWidth - menuWidth - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - menuHeight - 10));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  /**
   * Hides the selection context menu.
   */
  hideContextMenu() {
    if (this.menuElements?.menu) {
      this.menuElements.menu.style.display = 'none';
    }
  }

  /**
   * Checks if the selection has been moved or transformed.
   * @returns {boolean}
   */
  hasBeenMoved() {
    if (!this.originalSelectionPos || !this.selection) return false;
    return (
      Math.abs(this.selection.x - this.originalSelectionPos.x) > 1 ||
      Math.abs(this.selection.y - this.originalSelectionPos.y) > 1 ||
      this.hasTransformedCorners() ||
      Math.abs(this.rotation) > 0.01
    );
  }

  /**
   * Updates the cursor style based on pointer position.
   * @param {{x: number, y: number}} pos
   */
  updateCursor(pos) {
    if (!this.board.container) return;

    this.updateHandles();
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      if (handle.id === 'rotate') {
        this.board.container.style.cursor = 'grab';
        return;
      }
      const cursorMap = {
        'tl': 'nwse-resize', 'br': 'nwse-resize',
        'tr': 'nesw-resize', 'bl': 'nesw-resize',
        'tm': 'ns-resize', 'bm': 'ns-resize',
        'ml': 'ew-resize', 'mr': 'ew-resize',
        'ptl': 'grab', 'ptr': 'grab', 'pbl': 'grab', 'pbr': 'grab'
      };
      this.board.container.style.cursor = cursorMap[handle.id] || 'move';
      return;
    }

    if (this.selection && this.isInsideSelection(pos)) {
      this.board.container.style.cursor = 'move';
      if (this.board.app?.ui) {
        this.board.app.ui.setSelectCursor(true);
      }
      return;
    }

    this.board.container.style.cursor = 'crosshair';
    if (this.board.app?.ui) {
      this.board.app.ui.setSelectCursor(false);
    }
  }

  /**
   * Starts the "marching ants" selection border animation.
   */
  startMarchingAnts() {
    if (this.animationId) return;

    const animate = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 1) % 16;
      if (this.selection && !this.isDragging && !this.isTransforming && !this.isSelecting && !this.isRotating) {
        this.board.clearTop();
        if (this.floatingCanvas) {
          this.drawFloatingSelection();
          this.drawMarchingAntsOnly();
        } else {
          this.drawMarchingAntsOnly();
        }
      }
      this.animationId = requestAnimationFrame(animate);
    };
    this.animationId = requestAnimationFrame(animate);
  }

  /**
   * Draws the animated selection border and handles.
   */
  drawMarchingAntsOnly() {
    if (!this.selection) return;

    const ctx = this.board.topCtx;
    // Use selection overlay for outline and handles (can extend beyond canvas edge)
    const overlayCtx = this.board.getSelectionCtx() || ctx;

    if (this.corners && this.hasTransformedCorners()) {
      this.drawTransformOutline(overlayCtx);
      this.drawTransformHandles(overlayCtx);
    } else if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.hasScaledSelection()) {
      overlayCtx.strokeStyle = '#000';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 4]);
      overlayCtx.lineDashOffset = -this.marchingAntsOffset;
      overlayCtx.beginPath();
      overlayCtx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
      for (let i = 1; i < this.lassoSimplified.length; i++) {
        overlayCtx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
      }
      overlayCtx.closePath();
      overlayCtx.stroke();

      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineDashOffset = -this.marchingAntsOffset + 4;
      overlayCtx.beginPath();
      overlayCtx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
      for (let i = 1; i < this.lassoSimplified.length; i++) {
        overlayCtx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
      }
      overlayCtx.closePath();
      overlayCtx.stroke();
      overlayCtx.setLineDash([]);

      const s = this.selection;
      overlayCtx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      overlayCtx.lineWidth = 1;
      overlayCtx.strokeRect(s.x, s.y, s.width, s.height);

      this.updateHandles();
      this._drawHandles(overlayCtx);
    } else {
      const s = this.selection;
      overlayCtx.strokeStyle = '#000';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 4]);
      overlayCtx.lineDashOffset = -this.marchingAntsOffset;
      overlayCtx.strokeRect(s.x, s.y, s.width, s.height);

      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineDashOffset = -this.marchingAntsOffset + 4;
      overlayCtx.strokeRect(s.x, s.y, s.width, s.height);
      overlayCtx.setLineDash([]);

      this.updateHandles();
      this._drawHandles(overlayCtx);
    }

    this.board.restoreSelectionCtx();
    this._drawMirrorGhost(ctx);
  }

  /**
   * Draws all handles on the given context.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawHandles(ctx) {
    for (const handle of this.handles) {
      if (handle.isRotation) {
        const tm = this.handles.find(h => h.id === 'tm');
        if (tm) {
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tm.x, tm.y);
          ctx.lineTo(handle.x, handle.y);
          ctx.stroke();
        }

        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (handle.isPerspective) {
        const cornerMap = { ptl: 'tl', ptr: 'tr', pbl: 'bl', pbr: 'br' };
        const cornerId = cornerMap[handle.id];
        const corner = this.corners[cornerId];

        if (corner) {
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 0.75;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(corner.x, corner.y);
          ctx.lineTo(handle.x, handle.y);
          ctx.stroke();

          ctx.fillStyle = '#88CCCC';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } else {
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

  /**
   * Draws a ghost marching-ants outline of the mirrored selection, if mirror is on.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawMirrorGhost(ctx) {
    if (!this.board.mirror || !this.selection) return;

    const bw = this.board.getWidth();
    const s = this.selection;

    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    if (this.corners && this.hasTransformedCorners()) {
      const c = this.corners;
      const mc = {
        tl: { x: bw - c.tr.x, y: c.tr.y },
        tr: { x: bw - c.tl.x, y: c.tl.y },
        bl: { x: bw - c.br.x, y: c.br.y },
        br: { x: bw - c.bl.x, y: c.bl.y }
      };
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.beginPath();
      ctx.moveTo(mc.tl.x, mc.tl.y);
      ctx.lineTo(mc.tr.x, mc.tr.y);
      ctx.lineTo(mc.br.x, mc.br.y);
      ctx.lineTo(mc.bl.x, mc.bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.beginPath();
      ctx.moveTo(mc.tl.x, mc.tl.y);
      ctx.lineTo(mc.tr.x, mc.tr.y);
      ctx.lineTo(mc.br.x, mc.br.y);
      ctx.lineTo(mc.bl.x, mc.bl.y);
      ctx.closePath();
      ctx.stroke();
    } else if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.hasScaledSelection()) {
      const mLasso = this.lassoSimplified.map(p => ({ x: bw - p.x, y: p.y }));
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.beginPath();
      ctx.moveTo(mLasso[0].x, mLasso[0].y);
      for (let i = 1; i < mLasso.length; i++) ctx.lineTo(mLasso[i].x, mLasso[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.beginPath();
      ctx.moveTo(mLasso[0].x, mLasso[0].y);
      for (let i = 1; i < mLasso.length; i++) ctx.lineTo(mLasso[i].x, mLasso[i].y);
      ctx.closePath();
      ctx.stroke();
    } else {
      const mx = bw - s.x - s.width;
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.strokeRect(mx, s.y, s.width, s.height);
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.strokeRect(mx, s.y, s.width, s.height);
    }

    ctx.restore();
  }

  /**
   * Stops the marching ants animation.
   */
  stopMarchingAnts() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  onPointerDown(user, pos) {
    // Hide menu when starting any interaction
    this.hideContextMenu();

    // Initialize lasso points if in lasso mode and starting new selection
    if (this.mode === 'lasso' && !this.selection) {
      this.lassoPoints = [{ x: pos.x, y: pos.y }];
    }

    // Check if clicking a transform handle FIRST (higher priority than dragging)
    this.updateHandles();
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      // Special handling for rotation handle
      if (handle.id === 'rotate') {
        this.isRotating = true;
        const center = this.getSelectionCenter();
        this.rotationStartAngle = Math.atan2(pos.y - center.y, pos.x - center.x);

        // Lift selection if not already lifted
        if (!this.floatingCanvas) {
          this.liftSelection();
        }

        // Store current corners at the start of rotation
        if (this.corners) {
          this.cornersAtRotationStart = {
            tl: { ...this.corners.tl },
            tr: { ...this.corners.tr },
            bl: { ...this.corners.bl },
            br: { ...this.corners.br }
          };
        }
        return;
      }

      this.activeHandle = handle;
      return;
    }

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
    // Handle rotation
    if (this.isRotating && this.selection && this.cornersAtRotationStart) {
      // Calculate center from the corners at rotation start
      const startCorners = this.cornersAtRotationStart;
      const center = {
        x: (startCorners.tl.x + startCorners.tr.x + startCorners.bl.x + startCorners.br.x) / 4,
        y: (startCorners.tl.y + startCorners.tr.y + startCorners.bl.y + startCorners.br.y) / 4
      };

      const currentAngle = Math.atan2(pos.y - center.y, pos.x - center.x);
      const deltaAngle = currentAngle - this.rotationStartAngle;

      // Update corners based on rotation delta from start position
      this.updateCornersFromRotation(deltaAngle);
      // Update selection bounds from rotated corners
      this.updateSelectionFromCorners();

      // Broadcast the rotation to other users (throttled for performance)
      if (this.corners) {
        this.throttledBroadcastSelectionMove(this.corners);
      }

      this.board.clearTop();
      // Use homography-based preview (corners are now rotated)
      this.drawTransformPreview();
      return;
    }

    if (this.isDragging && this.selection) {
      // Calculate movement delta
      const newX = Math.round(pos.x - this.dragOffset.x);
      const newY = Math.round(pos.y - this.dragOffset.y);
      const dx = newX - this.selection.x;
      const dy = newY - this.selection.y;

      // Move the selection (ensure integer coordinates)
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

        // Broadcast the move to other users (throttled for performance)
        this.throttledBroadcastSelectionMove(this.corners);
      }

      // Also translate lasso path points to match the new position
      if (this.lassoPath) {
        this.lassoPath = this.lassoPath.map(p => ({
          x: p.x + dx,
          y: p.y + dy
        }));
      }

      // Also translate the simplified lasso path for rendering
      if (this.lassoSimplified) {
        this.lassoSimplified = this.lassoSimplified.map(p => ({
          x: p.x + dx,
          y: p.y + dy
        }));
      }

      this.board.clearTop();
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

      // Broadcast the transform to other users (throttled for performance)
      if (this.corners) {
        this.throttledBroadcastSelectionMove(this.corners);
      }

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

    // Mode-specific selection drawing
    if (this.mode === 'lasso') {
      // Collect lasso points
      this.lassoPoints.push({ x: pos.x, y: pos.y });

      // Redraw lasso preview
      this.board.clearTop();
      this.drawLassoPreview(this.board.topCtx, this.lassoPoints);
    } else {
      // Rectangle mode (existing code)
      this.board.clearTop();
      
      const minX = Math.min(this.startPos.x, pos.x);
      const minY = Math.min(this.startPos.y, pos.y);
      const maxX = Math.max(this.startPos.x, pos.x);
      const maxY = Math.max(this.startPos.y, pos.y);

      const x = Math.floor(minX);
      const y = Math.floor(minY);
      const width = Math.ceil(maxX) - x;
      const height = Math.ceil(maxY) - y;

      this.drawSelectionBox(this.board.topCtx, { x, y }, { x: x + width, y: y + height });

      if (this.board.mirror) {
        const bw = this.board.getWidth();
        const mx = bw - x - width;
        const ctx = this.board.topCtx;
        ctx.save();
        ctx.globalAlpha = 0.4;
        this.drawSelectionBox(ctx, { x: mx, y }, { x: mx + width, y: y + height });
        ctx.restore();
      }
    }
  }

  onPointerUp(user, pos) {
    // Capture pointer up position for menu positioning
    this.lastPointerUpPos = { x: pos.x, y: pos.y };

    if (this.isRotating) {
      this.isRotating = false;
      this.cornersAtRotationStart = null;
      // Flush any pending broadcast to ensure final rotation state is sent
      this.flushPendingSelectionBroadcast();
      this.board.clearTop();
      // Use homography-based preview (corners are rotated)
      this.drawTransformPreview();
      this.showContextMenu();
      return;
    }

    if (this.isDragging) {
      this.isDragging = false;
      // Flush any pending broadcast to ensure final drag position is sent
      this.flushPendingSelectionBroadcast();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();
      return;
    }

    if (this.activeHandle) {
      // Don't apply transform yet - keep handles in place for layered transforms
      // Transform will be applied when committing the selection
      this.activeHandle = null;
      this.isTransforming = false;
      // Flush any pending broadcast to ensure final transform state is sent
      this.flushPendingSelectionBroadcast();
      this.showContextMenu();
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

    if (this.mode === 'lasso') {
      // Finalize lasso selection
      if (this.lassoPoints.length < 3) {
        // Too few points - cancel
        this.board.clearTop();
        this.lassoPoints = [];
        this.startPos = null;
        return;
      }

      // Simplify the path
      const threshold = 3; // pixels
      this.lassoSimplified = distanceBasedCulling(this.lassoPoints, threshold);

      // Use the simplified path directly for point-in-polygon testing
      // The pointInHull winding number algorithm works with any polygon, not just convex hulls
      this.lassoPath = this.lassoSimplified;

      // Get bounding box
      const bounds = this.getBoundsFromPoints(this.lassoSimplified);

      // Minimum selection size check
      if (bounds.width < 5 || bounds.height < 5) {
        this.board.clearTop();
        this.lassoPoints = [];
        this.lassoSimplified = null;
        this.lassoPath = null;
        this.startPos = null;
        return;
      }

      this.selection = bounds;
      this.originalSelectionPos = { x: bounds.x, y: bounds.y };
      this.startPos = null;

      // Initialize corners for transform
      this.initializeCorners();
      this.updateHandles();

      this.board.clearTop();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();

      // Broadcast the selection marquee (not yet lifted)
      if (this.board.app?.wsClient) {
        this.board.app.wsClient.broadcastSelectionPending(this.selection, this.lassoPath);
      }
    } else {
      // Rectangle mode (existing code)
      const minX = Math.min(this.startPos.x, pos.x);
      const minY = Math.min(this.startPos.y, pos.y);
      const maxX = Math.max(this.startPos.x, pos.x);
      const maxY = Math.max(this.startPos.y, pos.y);

      const x = Math.floor(minX);
      const y = Math.floor(minY);
      const width = Math.ceil(maxX) - x;
      const height = Math.ceil(maxY) - y;

      // Minimum selection size
      if (width < 5 || height < 5) {
        this.board.clearTop();
        this.startPos = null;
        return;
      }

      this.selection = { x, y, width, height };
      this.startPos = null;

      // Store original position to detect moves
      this.originalSelectionPos = { x, y };

      // Initialize corners for transform
      this.initializeCorners();
      this.updateHandles();

      this.board.clearTop();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();

      // Broadcast the selection marquee (not yet lifted)
      if (this.board.app?.wsClient) {
        this.board.app.wsClient.broadcastSelectionPending(this.selection);
      }
    }
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

    // CASE 1: Perspective handles - free-form corner movement
    if (['ptl', 'ptr', 'pbl', 'pbr'].includes(handleId)) {
      const cornerMap = { ptl: 'tl', ptr: 'tr', pbl: 'bl', pbr: 'br' };
      const cornerId = cornerMap[handleId];

      // Free-form perspective control - just move the corner
      c[cornerId].x = pos.x;
      c[cornerId].y = pos.y;

      // Update selection bounds to encompass all corners
      this.updateSelectionFromCorners();
      return;
    }

    // CASE 2: Corner scale handles - scale all corners proportionally from center
    if (['tl', 'tr', 'bl', 'br'].includes(handleId)) {
      // Calculate current bounding box
      const oldMinX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const oldMaxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const oldMinY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const oldMaxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const oldWidth = oldMaxX - oldMinX;
      const oldHeight = oldMaxY - oldMinY;

      // Determine which corner of bounding box is being dragged
      const oppositeMap = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
      const oppositeId = oppositeMap[handleId];

      // Get the opposite corner position (fixed point)
      const oppositeBBoxCorner = {
        tl: { x: oldMinX, y: oldMinY },
        tr: { x: oldMaxX, y: oldMinY },
        bl: { x: oldMinX, y: oldMaxY },
        br: { x: oldMaxX, y: oldMaxY }
      }[oppositeId];

      // Calculate new bounding box
      const newMinX = Math.min(pos.x, oppositeBBoxCorner.x);
      const newMaxX = Math.max(pos.x, oppositeBBoxCorner.x);
      const newMinY = Math.min(pos.y, oppositeBBoxCorner.y);
      const newMaxY = Math.max(pos.y, oppositeBBoxCorner.y);
      const newWidth = newMaxX - newMinX;
      const newHeight = newMaxY - newMinY;

      // Calculate scale factors
      const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;
      const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;

      // Scale all corners relative to the opposite corner
      const scaleCorner = (corner) => ({
        x: oppositeBBoxCorner.x + (corner.x - oppositeBBoxCorner.x) * scaleX,
        y: oppositeBBoxCorner.y + (corner.y - oppositeBBoxCorner.y) * scaleY
      });

      c.tl = scaleCorner(c.tl);
      c.tr = scaleCorner(c.tr);
      c.bl = scaleCorner(c.bl);
      c.br = scaleCorner(c.br);

      this.updateSelectionFromCorners();
      return;
    }

    // CASE 3: Edge handles - scale proportionally along one axis
    const oldMinX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const oldMaxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const oldMinY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const oldMaxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    switch (handleId) {
      case 'tm': { // Top middle - scale vertically from bottom
        const oldHeight = oldMaxY - oldMinY;
        const newMinY = pos.y;
        const newHeight = oldMaxY - newMinY;
        const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;

        c.tl.y = oldMaxY - (oldMaxY - c.tl.y) * scaleY;
        c.tr.y = oldMaxY - (oldMaxY - c.tr.y) * scaleY;
        c.bl.y = oldMaxY - (oldMaxY - c.bl.y) * scaleY;
        c.br.y = oldMaxY - (oldMaxY - c.br.y) * scaleY;
        break;
      }
      case 'bm': { // Bottom middle - scale vertically from top
        const oldHeight = oldMaxY - oldMinY;
        const newMaxY = pos.y;
        const newHeight = newMaxY - oldMinY;
        const scaleY = oldHeight > 0 ? newHeight / oldHeight : 1;

        c.tl.y = oldMinY + (c.tl.y - oldMinY) * scaleY;
        c.tr.y = oldMinY + (c.tr.y - oldMinY) * scaleY;
        c.bl.y = oldMinY + (c.bl.y - oldMinY) * scaleY;
        c.br.y = oldMinY + (c.br.y - oldMinY) * scaleY;
        break;
      }
      case 'ml': { // Middle left - scale horizontally from right
        const oldWidth = oldMaxX - oldMinX;
        const newMinX = pos.x;
        const newWidth = oldMaxX - newMinX;
        const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;

        c.tl.x = oldMaxX - (oldMaxX - c.tl.x) * scaleX;
        c.tr.x = oldMaxX - (oldMaxX - c.tr.x) * scaleX;
        c.bl.x = oldMaxX - (oldMaxX - c.bl.x) * scaleX;
        c.br.x = oldMaxX - (oldMaxX - c.br.x) * scaleX;
        break;
      }
      case 'mr': { // Middle right - scale horizontally from left
        const oldWidth = oldMaxX - oldMinX;
        const newMaxX = pos.x;
        const newWidth = newMaxX - oldMinX;
        const scaleX = oldWidth > 0 ? newWidth / oldWidth : 1;

        c.tl.x = oldMinX + (c.tl.x - oldMinX) * scaleX;
        c.tr.x = oldMinX + (c.tr.x - oldMinX) * scaleX;
        c.bl.x = oldMinX + (c.bl.x - oldMinX) * scaleX;
        c.br.x = oldMinX + (c.br.x - oldMinX) * scaleX;
        break;
      }
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

    const x = Math.floor(minX);
    const y = Math.floor(minY);
    this.selection.x = x;
    this.selection.y = y;
    this.selection.width = Math.ceil(maxX) - x;
    this.selection.height = Math.ceil(maxY) - y;
  }


  drawTransformPreview() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    const ctx = this.board.topCtx;

    // Calculate full output bounds
    const bounds = calculateCornerBounds(this.corners);

    // Create a key from corner positions to detect when transformation changes
    const cornersKey = `${(this.corners.tl.x - bounds.minX).toFixed(2)},${(this.corners.tl.y - bounds.minY).toFixed(2)},` +
                      `${(this.corners.tr.x - bounds.minX).toFixed(2)},${(this.corners.tr.y - bounds.minY).toFixed(2)},` +
                      `${(this.corners.bl.x - bounds.minX).toFixed(2)},${(this.corners.bl.y - bounds.minY).toFixed(2)},` +
                      `${(this.corners.br.x - bounds.minX).toFixed(2)},${(this.corners.br.y - bounds.minY).toFixed(2)}`;

    // Check if we can use the cached transform
    if (this._cachedTransform && this._cachedTransform.cornersKey === cornersKey) {
      // Use cached transformed image
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(this._cachedTransform.canvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
    } else {
      // Need to recalculate transform - use downsampled preview for better performance
      const srcMaxDim = Math.max(this.floatingCanvas.width, this.floatingCanvas.height);
      const previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;

      // Reuse or create preview homography instance
      if (!this.previewHomography) {
        this.previewHomography = new Homography('projective');
      }

      // Perform the transform using shared utility
      const result = performHomographyTransform({
        sourceCanvas: this.floatingCanvas,
        sourceCorners: this.originalCorners,
        destCorners: this.corners,
        scale: previewScale,
        homographyInstance: this.previewHomography
      });

      if (result) {
        // Cache the transformed canvas
        const tempCanvas = imageDataToCanvas(result.imageData);
        this._cachedTransform = {
          canvas: tempCanvas,
          bounds: { width: bounds.width, height: bounds.height },
          cornersKey
        };

        // Draw the warped result scaled up to full size
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(tempCanvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
      } else {
        // Fallback: just draw the original floating selection
        this.drawFloatingSelection();
      }
    }

    // Draw the quadrilateral outline and handles (on selection overlay so they can extend beyond canvas)
    const handleCtx = this.board.getSelectionCtx() || ctx;
    this.drawTransformOutline(handleCtx);
    this.drawTransformHandles(handleCtx);
    this.board.restoreSelectionCtx();
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
    const center = this.getSelectionCenter();

    // Calculate bounding box
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

    const bbox = {
      tl: { x: minX, y: minY },
      tr: { x: maxX, y: minY },
      bl: { x: minX, y: maxY },
      br: { x: maxX, y: maxY }
    };

    // Draw bounding box rectangle (dashed gray line)
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.setLineDash([]);

    // Bounding box handles
    const tm = { x: (bbox.tl.x + bbox.tr.x) / 2, y: (bbox.tl.y + bbox.tr.y) / 2 };
    const bboxHandlePositions = [
      bbox.tl, bbox.tr, bbox.bl, bbox.br,
      tm,
      { x: (bbox.bl.x + bbox.br.x) / 2, y: (bbox.bl.y + bbox.br.y) / 2 }, // bm
      { x: (bbox.tl.x + bbox.bl.x) / 2, y: (bbox.tl.y + bbox.bl.y) / 2 }, // ml
      { x: (bbox.tr.x + bbox.br.x) / 2, y: (bbox.tr.y + bbox.br.y) / 2 }  // mr
    ];

    // Draw bounding box handles as white squares
    for (const pos of bboxHandlePositions) {
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

    // Draw perspective handles (extending from actual corners)
    const getPerspectiveHandlePos = (corner) => {
      const dx = corner.x - center.x;
      const dy = corner.y - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist === 0) {
        return { x: corner.x, y: corner.y };
      }

      const extendDist = dist + this.perspectiveHandleDistance;
      return {
        x: center.x + (dx / dist) * extendDist,
        y: center.y + (dy / dist) * extendDist
      };
    };

    const perspectiveHandles = [
      { corner: c.tl, handle: getPerspectiveHandlePos(c.tl) },
      { corner: c.tr, handle: getPerspectiveHandlePos(c.tr) },
      { corner: c.bl, handle: getPerspectiveHandlePos(c.bl) },
      { corner: c.br, handle: getPerspectiveHandlePos(c.br) }
    ];

    // Draw perspective handle connecting lines first (dark grey, very thin)
    for (const { corner, handle } of perspectiveHandles) {
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(corner.x, corner.y);
      ctx.lineTo(handle.x, handle.y);
      ctx.stroke();
    }

    // Draw perspective handle circles
    for (const { handle } of perspectiveHandles) {
      ctx.fillStyle = '#88CCCC';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Draw rotation handle
    const rotHandle = this.getRotationHandlePosition(center, tm.x, tm.y);

    // Draw connecting line from top-middle to rotation handle
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tm.x, tm.y);
    ctx.lineTo(rotHandle.x, rotHandle.y);
    ctx.stroke();

    // Draw rotation handle as a circle
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    ctx.arc(rotHandle.x, rotHandle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  applyTransform() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    // Reuse or create homography instance for full-resolution transform
    if (!this.homography) {
      this.homography = new Homography('projective');
    }

    // Perform the transform using shared utility
    const result = performHomographyTransform({
      sourceCanvas: this.floatingCanvas,
      sourceCorners: this.originalCorners,
      destCorners: this.corners,
      scale: 1, // Full resolution
      homographyInstance: this.homography
    });

    if (result) {
      // Create new floating canvas with transformed result
      this.floatingCanvas = imageDataToCanvas(result.imageData);
      this.floatingCtx = this.floatingCanvas.getContext('2d');

      // Update selection to match new bounds
      this.selection.x = result.bounds.minX;
      this.selection.y = result.bounds.minY;
      this.selection.width = result.bounds.width;
      this.selection.height = result.bounds.height;

      // Reset corners to new selection bounds
      this.initializeCorners();
    }
  }

  isInsideSelection(pos) {
    if (!this.selection) return false;

    // For lasso mode with path, use point-in-polygon test ONLY if not lifted yet
    // Once lifted, use rectangle bounds for dragging
    if (this.mode === 'lasso' && this.lassoPath && !this.floatingCanvas) {
      return pointInHull(pos, this.lassoPath);
    }

    // Rectangle mode or lifted selection - use bounding box
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
      const center = this.getSelectionCenter();

      // Calculate bounding box from actual corners (for scaling handles)
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);

      const bbox = {
        tl: { x: minX, y: minY },
        tr: { x: maxX, y: minY },
        bl: { x: minX, y: maxY },
        br: { x: maxX, y: maxY }
      };

      // Calculate perspective handle positions (extend outward from ACTUAL corners)
      const getPerspectiveHandlePos = (corner) => {
        const dx = corner.x - center.x;
        const dy = corner.y - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist === 0) {
          return { x: corner.x, y: corner.y };
        }

        // Extend outward by perspectiveHandleDistance
        const extendDist = dist + this.perspectiveHandleDistance;
        return {
          x: center.x + (dx / dist) * extendDist,
          y: center.y + (dy / dist) * extendDist
        };
      };

      const ptlPos = getPerspectiveHandlePos(c.tl);
      const ptrPos = getPerspectiveHandlePos(c.tr);
      const pblPos = getPerspectiveHandlePos(c.bl);
      const pbrPos = getPerspectiveHandlePos(c.br);

      // Calculate rotation handle position (from bounding box top-middle)
      const tmX = (bbox.tl.x + bbox.tr.x) / 2;
      const tmY = (bbox.tl.y + bbox.tr.y) / 2;
      const rotHandlePos = this.getRotationHandlePosition(center, tmX, tmY);

      this.handles = [
        // Corner handles on BOUNDING BOX (for scaling)
        { id: 'tl', x: bbox.tl.x, y: bbox.tl.y, type: 'scale' },
        { id: 'tr', x: bbox.tr.x, y: bbox.tr.y, type: 'scale' },
        { id: 'bl', x: bbox.bl.x, y: bbox.bl.y, type: 'scale' },
        { id: 'br', x: bbox.br.x, y: bbox.br.y, type: 'scale' },
        // Edge midpoint handles on BOUNDING BOX
        { id: 'tm', x: tmX, y: tmY, type: 'edge' },
        { id: 'bm', x: (bbox.bl.x + bbox.br.x) / 2, y: (bbox.bl.y + bbox.br.y) / 2, type: 'edge' },
        { id: 'ml', x: (bbox.tl.x + bbox.bl.x) / 2, y: (bbox.tl.y + bbox.bl.y) / 2, type: 'edge' },
        { id: 'mr', x: (bbox.tr.x + bbox.br.x) / 2, y: (bbox.tr.y + bbox.br.y) / 2, type: 'edge' },
        // Perspective handles at ACTUAL corners (for warping)
        { id: 'ptl', x: ptlPos.x, y: ptlPos.y, type: 'perspective', isPerspective: true },
        { id: 'ptr', x: ptrPos.x, y: ptrPos.y, type: 'perspective', isPerspective: true },
        { id: 'pbl', x: pblPos.x, y: pblPos.y, type: 'perspective', isPerspective: true },
        { id: 'pbr', x: pbrPos.x, y: pbrPos.y, type: 'perspective', isPerspective: true },
        // Rotation handle
        { id: 'rotate', x: rotHandlePos.x, y: rotHandlePos.y, isRotation: true }
      ];
    } else {
      const s = this.selection;
      const tmX = s.x + s.width / 2;
      const tmY = s.y;

      // Calculate rotation handle position
      const center = this.getSelectionCenter();
      const rotHandlePos = this.getRotationHandlePosition(center, tmX, tmY);

      this.handles = [
        { id: 'tl', x: s.x, y: s.y, type: 'scale' },
        { id: 'tr', x: s.x + s.width, y: s.y, type: 'scale' },
        { id: 'bl', x: s.x, y: s.y + s.height, type: 'scale' },
        { id: 'br', x: s.x + s.width, y: s.y + s.height, type: 'scale' },
        { id: 'tm', x: tmX, y: tmY, type: 'edge' },
        { id: 'bm', x: s.x + s.width / 2, y: s.y + s.height, type: 'edge' },
        { id: 'ml', x: s.x, y: s.y + s.height / 2, type: 'edge' },
        { id: 'mr', x: s.x + s.width, y: s.y + s.height / 2, type: 'edge' },
        { id: 'rotate', x: rotHandlePos.x, y: rotHandlePos.y, isRotation: true }
      ];
    }
  }

  getSelectionCenter() {
    if (!this.selection) return { x: 0, y: 0 };

    if (this.corners) {
      const c = this.corners;
      return {
        x: (c.tl.x + c.tr.x + c.bl.x + c.br.x) / 4,
        y: (c.tl.y + c.tr.y + c.bl.y + c.br.y) / 4
      };
    }

    return {
      x: this.selection.x + this.selection.width / 2,
      y: this.selection.y + this.selection.height / 2
    };
  }

  getRotationHandlePosition(center, topMiddleX, topMiddleY) {
    // Position the rotation handle above the top-middle, extended outward from center
    const dx = topMiddleX - center.x;
    const dy = topMiddleY - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist === 0) {
      return { x: topMiddleX, y: topMiddleY - this.rotationHandleDistance };
    }

    // Extend the handle position outward from center
    const extendDist = dist + this.rotationHandleDistance;
    return {
      x: center.x + (dx / dist) * extendDist,
      y: center.y + (dy / dist) * extendDist
    };
  }

  updateCornersFromRotation(deltaAngle) {
    if (!this.cornersAtRotationStart) return;

    // Calculate center from the corners at rotation start
    const startCorners = this.cornersAtRotationStart;
    const center = {
      x: (startCorners.tl.x + startCorners.tr.x + startCorners.bl.x + startCorners.br.x) / 4,
      y: (startCorners.tl.y + startCorners.tr.y + startCorners.bl.y + startCorners.br.y) / 4
    };

    const cos = Math.cos(deltaAngle);
    const sin = Math.sin(deltaAngle);

    // Rotate each corner around the center
    const rotatePoint = (p) => {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos
      };
    };

    this.corners = {
      tl: rotatePoint(startCorners.tl),
      tr: rotatePoint(startCorners.tr),
      bl: rotatePoint(startCorners.bl),
      br: rotatePoint(startCorners.br)
    };
  }

  drawRotatedSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const ctx = this.board.topCtx;
    const center = this.getSelectionCenter();

    ctx.save();

    // Translate to center, rotate, then draw
    ctx.translate(center.x, center.y);
    ctx.rotate(this.rotation);

    // Draw the floating canvas centered
    ctx.drawImage(
      this.floatingCanvas,
      -this.floatingCanvas.width / 2,
      -this.floatingCanvas.height / 2
    );

    ctx.restore();
  }

  drawSelectionBox(ctx, startPos, endPos) {
    const x = Math.min(startPos.x, endPos.x);
    const y = Math.min(startPos.y, endPos.y);
    const width = Math.abs(endPos.x - startPos.x);
    const height = Math.abs(endPos.y - startPos.y);

    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    // Black dashes
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = -this.marchingAntsOffset;
    ctx.strokeRect(x, y, width, height);

    // White dashes (offset to create "marching ants" effect)
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
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    if (this.corners && this.hasTransformedCorners()) {
      // Transformed selection - draw quadrilateral on selection overlay (can extend beyond canvas)
      const overlayCtx = this.board.getSelectionCtx() || ctx;
      const c = this.corners;

      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 4]);
      overlayCtx.strokeStyle = '#000';
      overlayCtx.lineDashOffset = -this.marchingAntsOffset;
      overlayCtx.beginPath();
      overlayCtx.moveTo(c.tl.x, c.tl.y);
      overlayCtx.lineTo(c.tr.x, c.tr.y);
      overlayCtx.lineTo(c.br.x, c.br.y);
      overlayCtx.lineTo(c.bl.x, c.bl.y);
      overlayCtx.closePath();
      overlayCtx.stroke();

      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineDashOffset = -this.marchingAntsOffset + 4;
      overlayCtx.beginPath();
      overlayCtx.moveTo(c.tl.x, c.tl.y);
      overlayCtx.lineTo(c.tr.x, c.tr.y);
      overlayCtx.lineTo(c.br.x, c.br.y);
      overlayCtx.lineTo(c.bl.x, c.bl.y);
      overlayCtx.closePath();
      overlayCtx.stroke();

      // Draw bounding box
      overlayCtx.setLineDash([]);
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      overlayCtx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 4]);
      overlayCtx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      overlayCtx.setLineDash([]);

      // Draw handles on the same overlay context
      this.updateHandles();
      this._drawSelectionUIHandles(overlayCtx);
      this.board.restoreSelectionCtx();
    } else {
      // Lasso or Rectangle mode - draw on overlay so it can extend beyond canvas
      const overlayCtx = this.board.getSelectionCtx() || ctx;
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 4]);

      if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.hasScaledSelection()) {
        // Lasso mode - draw simplified polygon (only if not scaled)
        overlayCtx.strokeStyle = '#000';
        overlayCtx.lineDashOffset = -this.marchingAntsOffset;
        overlayCtx.beginPath();
        overlayCtx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
        for (let i = 1; i < this.lassoSimplified.length; i++) {
          overlayCtx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
        }
        overlayCtx.closePath();
        overlayCtx.stroke();

        overlayCtx.strokeStyle = '#fff';
        overlayCtx.lineDashOffset = -this.marchingAntsOffset + 4;
        overlayCtx.beginPath();
        overlayCtx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
        for (let i = 1; i < this.lassoSimplified.length; i++) {
          overlayCtx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
        }
        overlayCtx.closePath();
        overlayCtx.stroke();

        // Also draw a subtle bounding rectangle
        overlayCtx.setLineDash([]);
        overlayCtx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
        overlayCtx.strokeRect(s.x, s.y, s.width, s.height);
      } else {
        // Rectangle mode OR lasso after lifting - draw bounding box
        overlayCtx.strokeStyle = '#000';
        overlayCtx.lineDashOffset = -this.marchingAntsOffset;
        overlayCtx.strokeRect(s.x, s.y, s.width, s.height);

        overlayCtx.strokeStyle = '#fff';
        overlayCtx.lineDashOffset = -this.marchingAntsOffset + 4;
        overlayCtx.strokeRect(s.x, s.y, s.width, s.height);
      }

      overlayCtx.setLineDash([]);

      // Draw handles on the same overlay context
      this.updateHandles();
      this._drawSelectionUIHandles(overlayCtx);
      this.board.restoreSelectionCtx();
    }

    this._drawMirrorGhost(ctx);
  }

  /**
   * Draws all selection handles (perspective, corner, rotation) on the given context.
   * @param {CanvasRenderingContext2D} ctx
   */
  _drawSelectionUIHandles(ctx) {
    // PASS 1: Draw perspective handle connecting lines first (so corner handles appear on top)
    for (const handle of this.handles) {
      if (handle.isPerspective) {
        const cornerMap = { ptl: 'tl', ptr: 'tr', pbl: 'bl', pbr: 'br' };
        const cornerId = cornerMap[handle.id];
        const corner = this.corners[cornerId];

        if (corner) {
          // Draw connecting line from corner to perspective handle (dark grey, very thin)
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 0.75;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(corner.x, corner.y);
          ctx.lineTo(handle.x, handle.y);
          ctx.stroke();
        }
      }
    }

    // PASS 2: Draw perspective handle circles
    for (const handle of this.handles) {
      if (handle.isPerspective) {
        // Draw perspective handle as desaturated cyan circle
        ctx.fillStyle = '#88CCCC';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // PASS 3: Draw regular corner/edge handles (these appear on top of perspective lines)
    for (const handle of this.handles) {
      if (!handle.isPerspective && !handle.isRotation) {
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

    // PASS 4: Draw rotation handle last
    const rotHandle = this.handles.find(h => h.isRotation);
    if (rotHandle) {
      const tm = this.handles.find(h => h.id === 'tm');
      if (tm) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tm.x, tm.y);
        ctx.lineTo(rotHandle.x, rotHandle.y);
        ctx.stroke();
      }

      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      ctx.arc(rotHandle.x, rotHandle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawFloatingSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const ctx = this.board.topCtx;

    // Check if corners have been transformed (including rotation) - if so, use homography
    if ((this.hasTransformedCorners() || this.rotation !== 0) && this.corners && this.originalCorners) {
      // Calculate full output bounds
      const bounds = calculateCornerBounds(this.corners);

      // Create a key from corner positions to detect when transformation changes
      // We use relative positions (subtract bounds.minX/minY) to make the key invariant to translation
      const cornersKey = `${(this.corners.tl.x - bounds.minX).toFixed(2)},${(this.corners.tl.y - bounds.minY).toFixed(2)},` +
                        `${(this.corners.tr.x - bounds.minX).toFixed(2)},${(this.corners.tr.y - bounds.minY).toFixed(2)},` +
                        `${(this.corners.bl.x - bounds.minX).toFixed(2)},${(this.corners.bl.y - bounds.minY).toFixed(2)},` +
                        `${(this.corners.br.x - bounds.minX).toFixed(2)},${(this.corners.br.y - bounds.minY).toFixed(2)}`;

      // Check if we can use the cached transform (corners shape hasn't changed, only position)
      if (this._cachedTransform && this._cachedTransform.cornersKey === cornersKey) {
        // Use cached transformed image, just draw at new position
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(this._cachedTransform.canvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
        return;
      }

      // Need to recalculate transform
      const srcMaxDim = Math.max(this.floatingCanvas.width, this.floatingCanvas.height);
      const previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;

      // Reuse or create preview homography instance
      if (!this.previewHomography) {
        this.previewHomography = new Homography('projective');
      }

      // Perform the transform using shared utility
      const result = performHomographyTransform({
        sourceCanvas: this.floatingCanvas,
        sourceCorners: this.originalCorners,
        destCorners: this.corners,
        scale: previewScale,
        homographyInstance: this.previewHomography
      });

      if (result) {
        // Cache the transformed canvas for future frames
        const tempCanvas = imageDataToCanvas(result.imageData);
        this._cachedTransform = {
          canvas: tempCanvas,
          bounds: { width: bounds.width, height: bounds.height },
          cornersKey
        };

        // Draw the warped result scaled up to full size
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(tempCanvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
        return;
      }
    }

    // Fallback: simple draw at current position
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

    // Reset preview toast flag when starting a new transform session
    this.hasShownPreviewToast = false;

    // Create floating canvas with selection content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = s.width;
    this.floatingCanvas.height = s.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');

    // In all-layers mode, capture each layer's content independently BEFORE erasing
    if (this.copyAllLayers) {
      const lm = this.board.layerManager;
      this.floatingLayers = [];
      const lassoPath = this.mode === 'lasso' ? this.lassoPath : null;
      for (let i = 0; i < lm.layerGroups.length; i++) {
        const group = lm.layerGroups[i];
        if (!group || !group.visible) continue;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = lm.width;
        tempCanvas.height = lm.height;
        lm.compositeLayerRange(tempCanvas.getContext('2d'), i, i + 1, null);
        const layerCanvas = document.createElement('canvas');
        layerCanvas.width = s.width;
        layerCanvas.height = s.height;
        const layerCtx = layerCanvas.getContext('2d');
        layerCtx.drawImage(tempCanvas, -s.x, -s.y);
        if (lassoPath) {
          this.applyLassoMask(layerCtx, s.x, s.y, lassoPath);
        }
        this.floatingLayers.push({ canvas: layerCanvas, groupIdx: i });
      }
    }

    // Copy from flattened layer(s) with transparent background
    const flatCanvas = this._flattenSelectionToCanvas(s);

    // Apply lasso mask if in lasso mode
    if (this.mode === 'lasso' && this.lassoPath) {
      this.applyLassoMask(flatCanvas.getContext('2d'), s.x, s.y, this.lassoPath);
    }

    this.floatingCtx.drawImage(flatCanvas, 0, 0);
    const imageData = this.floatingCtx.getImageData(0, 0, s.width, s.height);
    this.selectedImageData = imageData;

    // Store original position BEFORE erasing so we can track moves
    if (!this.originalSelectionPos) {
      this.originalSelectionPos = { x: s.x, y: s.y };
    }

    // Erase source area directly from baseCanvas (no stroke record created)
    this._restoreData = this._eraseSelectionDirectly(s, this.mode === 'lasso' ? this.lassoPath : null);

    // Check affected tiles for emptiness and clear tracker if empty
    const tt = this.board.tileTracker;
    if (tt) {
      const affectedTiles = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
      if (affectedTiles.length > 0) {
        this.board.checkErasedTilesByIndices(new Set(affectedTiles));
      }
    }

    // Create reusable homography instances for this selection
    this.homography = new Homography('projective');
    this.previewHomography = new Homography('projective');

    // Activate split-composite mode so upper layers render above the floating selection
    this.board.activeSelectionLayer = this.board.app?.self?.activeLayer ?? 0;

    // Draw floating selection on top canvas
    this.board.clearTop();
    this.drawSelectionUI();

    // Send the data via the websocket client
    if (this.board.app?.wsClient) {
      const imageData = this.floatingCanvas ? this.floatingCanvas.toDataURL('image/png') : null;
      this.board.app.wsClient.broadcastSelectionLift(this.selection, this.lassoPath, imageData);
    }
  }

  commitSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const lm = this.board.layerManager;
    const userId = this.board.app?.self?.id ?? 0;

    // All-layers mode: run the exact same commit logic as single-layer, once per layer
    if (this.copyAllLayers && this.floatingLayers && this.floatingLayers.length > 0) {
      // Compute actual bounds once (may differ from selection if transformed)
      let dirtyX = this.selection.x;
      let dirtyY = this.selection.y;
      let dirtyW = this.selection.width;
      let dirtyH = this.selection.height;

      if ((this.hasTransformedCorners() || this.rotation !== 0) && this.corners) {
        const bounds = calculateCornerBounds(this.corners);
        dirtyX = bounds.minX;
        dirtyY = bounds.minY;
        dirtyW = bounds.width;
        dirtyH = bounds.height;
      }

      // Get affected tile indices for undo tracking
      const tileOwnership = this.board.tileTracker;
      const commitTileIndices = tileOwnership
        ? tileOwnership.getTileIndicesForRect(dirtyX, dirtyY, dirtyW, dirtyH)
        : [];

      for (const { canvas, groupIdx } of this.floatingLayers) {
        lm.beginUserStroke(groupIdx, userId, 'source-over');
        const active = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(userId);
        if (!active) continue;

        // Expand dirty rect directly on this layer's active stroke
        if (active.dirtyRect) {
          active.dirtyRect.minX = dirtyX;
          active.dirtyRect.minY = dirtyY;
          active.dirtyRect.maxX = dirtyX + dirtyW;
          active.dirtyRect.maxY = dirtyY + dirtyH;
        }

        // Store affected tiles in the stroke record for undo
        if (active.affectedTiles) {
          for (const idx of commitTileIndices) {
            active.affectedTiles.add(idx);
          }
        }

        if ((this.hasTransformedCorners() || this.rotation !== 0) && this.corners && this.originalCorners) {
          if (!this.homography) this.homography = new Homography('projective');
          const result = performHomographyTransform({
            sourceCanvas: canvas,
            sourceCorners: this.originalCorners,
            destCorners: this.corners,
            scale: 1,
            homographyInstance: this.homography
          });
          if (result) {
            const tempCanvas = imageDataToCanvas(result.imageData);
            if (this.patternMode && this.board.app?.self) {
              this._drawWithPattern(active.ctx, tempCanvas, result.bounds.minX, result.bounds.minY, this.board.app.self);
            } else {
              active.ctx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
            }
          } else {
            if (this.patternMode && this.board.app?.self) {
              this._drawWithPattern(active.ctx, canvas, this.selection.x, this.selection.y, this.board.app.self);
            } else {
              active.ctx.drawImage(canvas, this.selection.x, this.selection.y);
            }
          }
        } else {
          if (this.patternMode && this.board.app?.self) {
            this._drawWithPattern(active.ctx, canvas, this.selection.x, this.selection.y, this.board.app.self);
          } else {
            active.ctx.drawImage(canvas, this.selection.x, this.selection.y);
          }
        }

        lm.commitUserStroke(groupIdx, userId, { selectionRestoreData: this._restoreData });
      }

      this.board.compositeAllLayers();

      // Add tile ownership for visible tiles in the pasted region (must be after composite)
      this.board.addOccupancyForVisibleTilesInRect(userId, dirtyX, dirtyY, dirtyW, dirtyH);

      // Broadcast tile ownership update and selection commit
      if (this.board.app?.wsClient) {
        if (commitTileIndices.length > 0) {
          this.board.app.wsClient.broadcastTileUpdate(commitTileIndices);
        }
        this.board.app.wsClient.broadcastSelectionCommit();
      }

      this.floatingCanvas = null;
      this.floatingCtx = null;
      this.floatingLayers = null;
      this.selectedImageData = null;
      this._restoreData = null;
      this.board.clearTop();
      return;
    }

    const activeLayer = this.board.app?.self?.activeLayer ?? 0;

    // Begin a new stroke on the active layer so this paste is undoable
    lm.beginUserStroke(activeLayer, userId, 'source-over');
    const active = lm.layerGroups[activeLayer]?.activeStrokeByUser.get(userId);
    if (!active) {
      this.floatingCanvas = null;
      this.floatingCtx = null;
      this.selectedImageData = null;
      this.board.clearTop();
      return;
    }

    // Calculate dirty rect bounds for tracking
    let dirtyX, dirtyY, dirtyWidth, dirtyHeight;

    // Draw the floating selection (with optional transform) into the stroke canvas
    if ((this.hasTransformedCorners() || this.rotation !== 0) && this.corners && this.originalCorners) {
      if (!this.homography) this.homography = new Homography('projective');

      const result = performHomographyTransform({
        sourceCanvas: this.floatingCanvas,
        sourceCorners: this.originalCorners,
        destCorners: this.corners,
        scale: 1,
        homographyInstance: this.homography
      });

      if (result) {
        const tempCanvas = imageDataToCanvas(result.imageData);
        if (this.patternMode && this.board.app?.self) {
          this._drawWithPattern(active.ctx, tempCanvas, result.bounds.minX, result.bounds.minY, this.board.app.self);
        } else {
          active.ctx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
        }
        dirtyX = result.bounds.minX;
        dirtyY = result.bounds.minY;
        dirtyWidth = result.bounds.width;
        dirtyHeight = result.bounds.height;
      } else {
        if (this.patternMode && this.board.app?.self) {
          this._drawWithPattern(active.ctx, this.floatingCanvas, this.selection.x, this.selection.y, this.board.app.self);
        } else {
          active.ctx.drawImage(this.floatingCanvas, this.selection.x, this.selection.y, this.selection.width, this.selection.height);
        }
        dirtyX = this.selection.x;
        dirtyY = this.selection.y;
        dirtyWidth = this.selection.width;
        dirtyHeight = this.selection.height;
      }
    } else {
      if (this.patternMode && this.board.app?.self) {
        this._drawWithPattern(active.ctx, this.floatingCanvas, this.selection.x, this.selection.y, this.board.app.self);
      } else {
        active.ctx.drawImage(this.floatingCanvas, this.selection.x, this.selection.y, this.selection.width, this.selection.height);
      }
      dirtyX = this.selection.x;
      dirtyY = this.selection.y;
      dirtyWidth = this.selection.width;
      dirtyHeight = this.selection.height;
    }

    // Track the dirty region so the stroke is properly saved
    this.board.expandDirtyRect(this.board.app?.self, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Store affected tiles in the stroke record for undo and collect for broadcast
    const tileOwnership = this.board.tileTracker;
    let tilesToBroadcast = [];
    if (tileOwnership && active.affectedTiles) {
      const tileIndices = tileOwnership.getTileIndicesForRect(dirtyX, dirtyY, dirtyWidth, dirtyHeight);
      for (const idx of tileIndices) {
        active.affectedTiles.add(idx);
      }
      tilesToBroadcast = tileIndices;
    }

    // Commit as an undoable stroke record.
    // Attach restore data so Board.undo/redo can also reverse the source-area erase.
    lm.commitUserStroke(activeLayer, userId, { selectionRestoreData: this._restoreData });
    this.board.compositeAllLayers();

    // Add tile ownership for visible tiles in the pasted region (must be after composite)
    this.board.addOccupancyForVisibleTilesInRect(userId, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Broadcast tile ownership update and selection commit
    if (this.board.app && this.board.app.wsClient) {
      if (tilesToBroadcast.length > 0) {
        this.board.app.wsClient.broadcastTileUpdate(tilesToBroadcast);
      }
      this.board.app.wsClient.broadcastSelectionCommit();
    }

    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.selectedImageData = null;
    this._restoreData = null;
    this.board.clearTop();
  }

  clearSelection() {
    // Deactivate split-composite mode — no floating selection in flight
    this.board.activeSelectionLayer = -1;

    this.selection = null;
    this.handles = [];
    this.corners = null;
    this.originalCorners = null;
    this.originalSelectionPos = null;
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.floatingLayers = null;
    this.selectedImageData = null;
    this.isTransforming = false;
    this.rotation = 0;
    this.isRotating = false;
    this.cornersAtRotationStart = null;
    this.hasShownPreviewToast = false; // Reset toast flag for next selection
    this._restoreData = null;
    this.lastPointerUpPos = null; // Reset menu positioning
    // Clear homography instances
    this.homography = null;
    this.previewHomography = null;
    this._cachedTransform = null; // Clear cached transform

    // Lasso cleanup
    this.lassoPoints = [];
    this.lassoPath = null;
    this.lassoSimplified = null;

    // Reset active handle to prevent glitches when switching tools mid-drag
    this.activeHandle = null;

    this.hideContextMenu();
    this.board.clearTop();
  }

  // Toggle all-layers copy/cut mode
  toggleCopyAllLayers(value) {
    this.copyAllLayers = value !== undefined ? value : !this.copyAllLayers;
  }

  // Flatten visible layers (all or active only) into a selection-sized canvas.
  // When copying all layers, reads from mainCtx (includes background).
  // When copying single layer, composites just that layer with transparent background.
  _flattenSelectionToCanvas(s) {
    const lm = this.board.layerManager;
    const selCanvas = document.createElement('canvas');
    selCanvas.width = s.width;
    selCanvas.height = s.height;
    const selCtx = selCanvas.getContext('2d');

    if (this.copyAllLayers) {
      // Composite all layers to a full-size temp canvas, then crop to the selection area
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = lm.width;
      tempCanvas.height = lm.height;
      const tempCtx = tempCanvas.getContext('2d');
      lm.compositeLayerRange(tempCtx, 0, lm.layerGroups.length, null);
      selCtx.drawImage(tempCanvas, -s.x, -s.y);
    } else {
      // Composite just the active layer with transparent background
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = lm.width;
      tempCanvas.height = lm.height;
      const tempCtx = tempCanvas.getContext('2d');
      const activeLayer = this.board.app?.self?.activeLayer ?? 0;
      lm.compositeLayerRange(tempCtx, activeLayer, activeLayer + 1, null);
      selCtx.drawImage(tempCanvas, -s.x, -s.y);
    }

    return selCanvas;
  }

  // Erase the selection directly from the layer manager using a destination-out stroke.
  // This correctly handles content in both baked sequences and the stroke stack.
  _eraseSelectionDirectly(s, lassoPath) {
    const lm = this.board.layerManager;
    const isMultiLayer = this.copyAllLayers;
    const userId = this.board.app?.self?.id ?? 0;
    const batchTimestamp = Date.now();
    const snapshots = [];

    const eraseGroup = (groupIdx) => {
      const group = lm.layerGroups[groupIdx];
      if (!group || !group.visible) return;

      // Composite the group via the full compositeLayerRange path (handles isolated/flatCanvas groups)
      const layerCanvas = document.createElement('canvas');
      layerCanvas.width = lm.width;
      layerCanvas.height = lm.height;
      const layerCtx = layerCanvas.getContext('2d');
      lm.compositeLayerRange(layerCtx, groupIdx, groupIdx + 1, null);

      const snap = document.createElement('canvas');
      snap.width = s.width;
      snap.height = s.height;
      const snapCtx = snap.getContext('2d');
      snapCtx.drawImage(layerCanvas, s.x, s.y, s.width, s.height, 0, 0, s.width, s.height);

      // Mask the snapshot with the lasso path if in lasso mode so restoration respects the shape
      if (lassoPath && lassoPath.length >= 3) {
        snapCtx.globalCompositeOperation = 'destination-in';
        snapCtx.fillStyle = 'white';
        snapCtx.beginPath();
        snapCtx.moveTo(lassoPath[0].x - s.x, lassoPath[0].y - s.y);
        for (let i = 1; i < lassoPath.length; i++) {
          snapCtx.lineTo(lassoPath[i].x - s.x, lassoPath[i].y - s.y);
        }
        snapCtx.closePath();
        snapCtx.fill();
        snapCtx.globalCompositeOperation = 'source-over';
      }

      snapshots.push({ groupIdx, canvas: snap, x: s.x, y: s.y });

      lm.beginUserStroke(groupIdx, userId, 'destination-out');
      const ctx = lm.getUserStrokeContext(groupIdx, userId);

      // Expand dirty rect directly on this layer's stroke so commitUserStroke doesn't drop it
      const eraseStroke = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(userId);
      if (eraseStroke && eraseStroke.dirtyRect) {
        eraseStroke.dirtyRect.minX = s.x;
        eraseStroke.dirtyRect.minY = s.y;
        eraseStroke.dirtyRect.maxX = s.x + s.width;
        eraseStroke.dirtyRect.maxY = s.y + s.height;
      }

      if (lassoPath && lassoPath.length >= 3) {
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) {
          ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = 'white';
        ctx.fillRect(s.x, s.y, s.width, s.height);
      }

      // Track the dirty region so the erase stroke is properly saved
      const user = this.board.app?.self;
      if (user) {
        this.board.expandDirtyRect(user, s.x, s.y, s.width, s.height, groupIdx);
      }

      // Commit the stroke with the shared batch timestamp and original selection data
      lm.commitUserStroke(groupIdx, userId, {
        eraseAll: isMultiLayer,
        timestamp: batchTimestamp,
        isSelectionErase: true // Flag to distinguish from normal erasers if needed
      });
    };

    if (isMultiLayer) {
      for (let i = 0; i < lm.layerGroups.length; i++) eraseGroup(i);
    } else {
      eraseGroup(this.board.app?.self?.activeLayer ?? 0);
    }

    this.board.compositeAllLayers();

    // Return snapshots + the original erase shape so Board.undo/redo can replay it
    return {
      snapshots,
      eraseS: { ...s },
      eraseLassoPath: lassoPath ? lassoPath.map(p => ({ ...p })) : null
    };
  }

  // Copy selection to clipboard
  copy() {
    if (!this.selection) return false;
    if (!this.board.app?.canUseImageFeatures?.(true)) return false;

    const s = this.selection;

    // Get image data from transformed canvas if lifted, otherwise from main canvas
    if (this.floatingCanvas) {
      const transformedCanvas = this.getTransformedCanvas();
      this.clipboard = {
        width: transformedCanvas.width,
        height: transformedCanvas.height,
        imageData: transformedCanvas.getContext('2d').getImageData(0, 0, transformedCanvas.width, transformedCanvas.height)
      };
    } else {
      const flatCanvas = this._flattenSelectionToCanvas(s);
      if (this.mode === 'lasso' && this.lassoPath) {
        this.applyLassoMask(flatCanvas.getContext('2d'), s.x, s.y, this.lassoPath);
      }
      this.clipboard = {
        width: s.width,
        height: s.height,
        imageData: flatCanvas.getContext('2d').getImageData(0, 0, s.width, s.height)
      };
    }

    // Show toast notification
    if (this.board.app?.ui) {
      this.board.app.ui.showToast('Copied to clipboard!');
    }

    return true;
  }

  // Cut selection (copy + delete)
  cut() {
    if (!this.selection) return false;

    if (!this.copy()) return false;
    this.deleteSelection();
    return true;
  }

  // Paste from clipboard
  paste() {
    if (!this.clipboard) return false;
    if (!this.board.app?.canUseImageFeatures?.(true)) return false;

    // Commit any existing selection
    this.commitSelection();
    this.clearSelection();

    // Paste at user's current cursor position (centered on cursor)
    const app = this.board.app;
    const x = app?.self?.x || 50;
    const y = app?.self?.y || 50;

    // Center the pasted content on cursor
    const pasteX = x - this.clipboard.width / 2;
    const pasteY = y - this.clipboard.height / 2;

    this.selection = {
      x: pasteX,
      y: pasteY,
      width: this.clipboard.width,
      height: this.clipboard.height
    };

    // Create floating canvas with clipboard content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = this.clipboard.width;
    this.floatingCanvas.height = this.clipboard.height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    this.floatingCtx.putImageData(this.clipboard.imageData, 0, 0);

    // Store original position - pasted content is considered "moved"
    this.originalSelectionPos = { x: -1, y: -1 };

    // Initialize corners for transform handles
    this.initializeCorners();
    this.updateHandles();
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu();

    // Broadcast paste to other users
    if (this.board.app?.wsClient) {
      // Convert floating canvas to data URL for transmission
      const dataUrl = this.floatingCanvas.toDataURL('image/png');
      this.board.app.wsClient.broadcastImagePaste(pasteX, pasteY, this.clipboard.width, this.clipboard.height, dataUrl);
    }

    return true;
  }

  /**
   * Paste an image from an external source (clipboard, drag-drop, file upload)
   * @param {HTMLImageElement|HTMLCanvasElement|ImageData} imageSource 
   */
  pasteImage(imageSource) {
    if (!this.board.app?.canUseImageFeatures?.(true)) return false;

    // Commit any existing selection
    this.commitSelection();
    this.clearSelection();

    let origWidth, origHeight;
    if (imageSource instanceof ImageData) {
      origWidth = imageSource.width;
      origHeight = imageSource.height;
    } else {
      origWidth = imageSource.width;
      origHeight = imageSource.height;
    }

    // Calculate the visible viewport in canvas coordinates
    const container = this.board.container;
    const containerWidth = container?.clientWidth || 800;
    const containerHeight = container?.clientHeight || 600;
    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    // Viewport dimensions in canvas space
    const viewportWidth = containerWidth / zoom;
    const viewportHeight = containerHeight / zoom;

    // Viewport center in canvas coordinates
    const viewCenterX = (containerWidth / 2 - panX) / zoom;
    const viewCenterY = (containerHeight / 2 - panY) / zoom;

    // Scale image to fit within 80% of viewport
    const maxWidth = viewportWidth * 0.8;
    const maxHeight = viewportHeight * 0.8;
    const scale = Math.min(1, maxWidth / origWidth, maxHeight / origHeight);
    const width = Math.round(origWidth * scale);
    const height = Math.round(origHeight * scale);

    // Center on viewport
    const pasteX = viewCenterX - width / 2;
    const pasteY = viewCenterY - height / 2;

    this.selection = {
      x: pasteX,
      y: pasteY,
      width: width,
      height: height
    };

    // Create floating canvas with the scaled image content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = width;
    this.floatingCanvas.height = height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');

    if (imageSource instanceof ImageData) {
      // ImageData can't be scaled directly - draw to temp canvas first
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = origWidth;
      tempCanvas.height = origHeight;
      tempCanvas.getContext('2d').putImageData(imageSource, 0, 0);
      this.floatingCtx.drawImage(tempCanvas, 0, 0, origWidth, origHeight, 0, 0, width, height);
    } else {
      this.floatingCtx.drawImage(imageSource, 0, 0, origWidth, origHeight, 0, 0, width, height);
    }

    // Store original position - pasted content is considered "moved"
    this.originalSelectionPos = { x: -1, y: -1 };

    // Initialize corners for transform handles
    this.initializeCorners();
    this.updateHandles();
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu();

    // Broadcast paste to other users
    if (this.board.app?.wsClient) {
      const dataUrl = this.floatingCanvas.toDataURL('image/png');
      this.board.app.wsClient.broadcastImagePaste(pasteX, pasteY, width, height, dataUrl);
    }

    // Switch to select tool if not already active
    if (this.board.app?.self?.tool !== 'select') {
      this.board.app?.selectTool('select');
    }

    return true;
  }

  // Delete/clear selection content
  deleteSelection() {
    if (!this.selection) return false;

    const s = this.selection;
    const app = this.board.app;
    if (!app) return false;

    // If floating, erase already happened at lift time — just discard
    if (this.floatingCanvas) {
      this.floatingCanvas = null;
      this.floatingCtx = null;
      this._restoreData = null;
    } else {
      // Not yet lifted — erase now directly
      const lassoPath = this.mode === 'lasso' ? this.lassoPath : null;
      this._eraseSelectionDirectly(s, lassoPath);

      // Check affected tiles for emptiness and clear ownership
      const tileOwnership = this.board.tileTracker;
      if (tileOwnership) {
        const affectedTiles = tileOwnership.getTileIndicesForRect(s.x, s.y, s.width, s.height);
        if (affectedTiles.length > 0) {
          this.board.checkErasedTilesByIndices(new Set(affectedTiles));
        }
      }

      if (this.board.mirror) {
        const bw = this.board.getWidth();
        const ms = { x: bw - s.x - s.width, y: s.y, width: s.width, height: s.height };
        const mLassoPath = lassoPath ? lassoPath.map(p => ({ x: bw - p.x, y: p.y })) : null;
        this._eraseSelectionDirectly(ms, mLassoPath);

        // Also check mirrored tiles
        if (tileOwnership) {
          const mirrorTiles = tileOwnership.getTileIndicesForRect(ms.x, ms.y, ms.width, ms.height);
          if (mirrorTiles.length > 0) {
            this.board.checkErasedTilesForOwnershipByIndices(new Set(mirrorTiles));
          }
        }
      }
    }

    // Broadcast delete to other users
    if (app.wsClient) {
      app.wsClient.broadcastSelectionDelete(app.self.activeLayer);
    }

    this.hideContextMenu();
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

  // Fill selection with current color or pattern
  fillSelection() {
    if (!this.selection) return false;

    const s = this.selection;
    const app = this.board.app;
    if (!app) return false;

    const opacity = app.self.opacity !== undefined ? app.self.opacity : 1;

    if (this.floatingCanvas) {
      // Fill directly into the floating canvas (local coords: offsetX/Y = selection origin)
      this._executeFill(this.floatingCtx, s, app.self, opacity, s.x, s.y);
      this.board.clearTop();
      this.drawSelectionUI();
    } else {
      // Fill on the active layer via a temp canvas, then blit to layer coords.
      // _fillToLayer temporarily swaps this.lassoPath to support mirror path overrides.
      this.board.beginStroke(app.self);
      const layerCtx = this.board.getActiveLayerContext();

      const _fillToLayer = (rect, lassoOverride) => {
        const temp = document.createElement('canvas');
        temp.width = rect.width;
        temp.height = rect.height;
        const origLasso = this.lassoPath;
        if (lassoOverride !== undefined) this.lassoPath = lassoOverride;
        this._executeFill(temp.getContext('2d'), rect, app.self, opacity, rect.x, rect.y);
        this.lassoPath = origLasso;
        layerCtx.drawImage(temp, rect.x, rect.y);
      };

      _fillToLayer(s);

      // Dirty rect + tile tracking
      this.board.expandDirtyRect(app.self, s.x, s.y, s.width, s.height);
      const userId = app.self?.id ?? 0;
      const activeLayer = app.self?.activeLayer ?? 0;
      const tileOwnership = this.board.tileTracker;
      const lm = this.board.layerManager;
      const active = lm?.layerGroups[activeLayer]?.activeStrokeByUser.get(userId);
      if (tileOwnership && active?.affectedTiles) {
        for (const idx of tileOwnership.getTileIndicesForRect(s.x, s.y, s.width, s.height)) {
          active.affectedTiles.add(idx);
        }
      }

      if (this.board.mirror) {
        const bw = this.board.getWidth();
        const mx = bw - s.x - s.width;
        const mirrorRect = { x: mx, y: s.y, width: s.width, height: s.height };
        const mLasso = this.lassoPath ? this.lassoPath.map(p => ({ x: bw - p.x, y: p.y })) : null;
        _fillToLayer(mirrorRect, mLasso);

        this.board.expandDirtyRect(app.self, mx, s.y, s.width, s.height);
        if (tileOwnership && active?.affectedTiles) {
          for (const idx of tileOwnership.getTileIndicesForRect(mx, s.y, s.width, s.height)) {
            active.affectedTiles.add(idx);
          }
        }
      }

      this.board.compositeAllLayers();
      this.board.endStroke(app.self);

      // Tile occupancy (must be after composite)
      this.board.addOccupancyForVisibleTilesInRect(userId, s.x, s.y, s.width, s.height);
      if (this.board.mirror) {
        const bw = this.board.getWidth();
        const mx = bw - s.x - s.width;
        this.board.addOccupancyForVisibleTilesInRect(userId, mx, s.y, s.width, s.height);
      }
    }

    if (this.board.app?.wsClient) {
      this.board.app.wsClient.broadcastSelectionFill(app.self.color, app.self.activeLayer);
    }

    // Keep selection active, update menu buttons only (don't reposition)
    this.showContextMenu(true);
    return true;
  }

  // Stamp current selection to canvas without clearing it (for repeated stamping)
  stamp() {
    if (!this.floatingCanvas || !this.selection) return false;

    const app = this.board.app;
    if (!app) return false;

    const lm = this.board.layerManager;
    const userId = app.self?.id ?? 0;
    const hasTransform = (this.hasTransformedCorners() || this.rotation !== 0) && this.corners && this.originalCorners;

    const layers = (this.copyAllLayers && this.floatingLayers && this.floatingLayers.length > 0)
      ? this.floatingLayers
      : [{ canvas: this.floatingCanvas, groupIdx: app.self?.activeLayer ?? 0 }];

    // Compute actual bounds once (may differ from selection if transformed)
    let dirtyX = this.selection.x;
    let dirtyY = this.selection.y;
    let dirtyW = this.selection.width;
    let dirtyH = this.selection.height;

    if (hasTransform && this.corners) {
      const bounds = calculateCornerBounds(this.corners);
      dirtyX = bounds.minX;
      dirtyY = bounds.minY;
      dirtyW = bounds.width;
      dirtyH = bounds.height;
    }

    // Get affected tile indices for undo tracking
    const tileOwnership = this.board.tileTracker;
    const stampTileIndices = tileOwnership
      ? tileOwnership.getTileIndicesForRect(dirtyX, dirtyY, dirtyW, dirtyH)
      : [];

    for (const { canvas, groupIdx } of layers) {
      lm.beginUserStroke(groupIdx, userId, 'source-over');
      const active = lm.layerGroups[groupIdx]?.activeStrokeByUser.get(userId);
      if (!active) continue;

      if (active.dirtyRect) {
        active.dirtyRect.minX = dirtyX;
        active.dirtyRect.minY = dirtyY;
        active.dirtyRect.maxX = dirtyX + dirtyW;
        active.dirtyRect.maxY = dirtyY + dirtyH;
      }

      // Store affected tiles in the stroke record for undo
      if (active.affectedTiles) {
        for (const idx of stampTileIndices) {
          active.affectedTiles.add(idx);
        }
      }

      if (hasTransform) {
        if (!this.homography) this.homography = new Homography('projective');
        const result = performHomographyTransform({
          sourceCanvas: canvas,
          sourceCorners: this.originalCorners,
          destCorners: this.corners,
          scale: 1,
          homographyInstance: this.homography
        });
        if (result) {
          const tempCanvas = imageDataToCanvas(result.imageData);
          active.ctx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
        } else {
          active.ctx.drawImage(canvas, this.selection.x, this.selection.y);
        }
      } else {
        active.ctx.drawImage(canvas, this.selection.x, this.selection.y);
      }

      lm.commitUserStroke(groupIdx, userId, {});
    }

    // Composite and commit the stroke
    this.board.compositeAllLayers();

    // Add tile ownership for visible stamped tiles (after composite)
    this.board.addOccupancyForVisibleTilesInRect(userId, dirtyX, dirtyY, dirtyW, dirtyH);

    // Broadcast tile ownership update and stamp
    if (this.board.app?.wsClient) {
      if (stampTileIndices.length > 0) {
        this.board.app.wsClient.broadcastTileUpdate(stampTileIndices);
      }
      this.board.app.wsClient.broadcastSelectionStamp();
    }

    // Redraw the floating selection on top canvas
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu(true);

    return true;
  }

  // Flip selection horizontally
  flipHorizontal() {
    if (!this.selection) return false;

    // If selection hasn't been lifted yet, lift it first
    if (!this.floatingCanvas) {
      this.liftSelection();
    }

    if (!this.floatingCanvas) return false;

    // Create a temporary canvas for the flipped image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.floatingCanvas.width;
    tempCanvas.height = this.floatingCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Flip horizontally by scaling -1 on x-axis
    tempCtx.save();
    tempCtx.translate(tempCanvas.width, 0);
    tempCtx.scale(-1, 1);
    tempCtx.drawImage(this.floatingCanvas, 0, 0);
    tempCtx.restore();

    // Replace the floating canvas with the flipped version
    this.floatingCanvas = tempCanvas;
    this.floatingCtx = tempCtx;

    // If there are original corners (for transforms), flip them horizontally
    if (this.originalCorners) {
      const width = this.floatingCanvas.width;
      // Swap left and right corners and flip their x positions
      const temp = {
        tl: { ...this.originalCorners.tl },
        tr: { ...this.originalCorners.tr },
        bl: { ...this.originalCorners.bl },
        br: { ...this.originalCorners.br }
      };

      // Flip x coordinates and swap left/right
      this.originalCorners.tl = { x: width - temp.tr.x, y: temp.tr.y };
      this.originalCorners.tr = { x: width - temp.tl.x, y: temp.tl.y };
      this.originalCorners.bl = { x: width - temp.br.x, y: temp.br.y };
      this.originalCorners.br = { x: width - temp.bl.x, y: temp.bl.y };
    }

    // Invalidate cached transform since the source image changed
    this._cachedTransform = null;

    // Broadcast flip to other users
    if (this.board.app?.wsClient) {
      this.board.app.wsClient.broadcastSelectionFlip();
    }

    // Redraw the selection with flipped content
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu(true);

    return true;
  }

  // Returns a canvas of the current selection content (transparent background).
  // Returns null if no selection is active.
  getSelectionExportCanvas() {
    if (!this.selection) return null;

    if (this.floatingCanvas) {
      if ((this.hasTransformedCorners() || this.rotation !== 0) && this.corners && this.originalCorners) {
        return this.getTransformedCanvas();
      }
      return this.floatingCanvas;
    }

    const s = this.selection;
    const canvas = this._flattenSelectionToCanvas(s);
    if (this.mode === 'lasso' && this.lassoPath) {
      this.applyLassoMask(canvas.getContext('2d'), s.x, s.y, this.lassoPath);
    }
    return canvas;
  }

  // Save selection as image file - opens save dialog with selection highlighted
  saveSelection() {
    const canvas = this.getSelectionExportCanvas();
    if (!canvas) return false;

    const app = this.board.app;
    if (app?.saveMode) {
      // Open save dialog with the selection canvas
      this.hideContextMenu();
      app.saveMode.openWithCanvas(canvas);
    } else {
      // Fallback to direct download if SaveMode not available
      const dataURL = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      link.download = `selection-${timestamp}.png`;
      link.href = dataURL;
      link.click();

      if (this.board.app?.ui) {
        this.board.app.ui.showToast('Selection saved!');
      }
      this.hideContextMenu();
    }

    return true;
  }

  // Convert selection to image brush
  toImageBrush() {
    if (!this.selection) return false;

    const app = this.board.app;
    if (!app) return false;

    // Get the transformed image data
    let canvas;
    if (this.floatingCanvas) {
      // Use transformed canvas if homography was applied
      canvas = this.getTransformedCanvas();
    } else {
      const s = this.selection;
      canvas = this._flattenSelectionToCanvas(s);
      // Apply lasso mask if in lasso mode
      if (this.mode === 'lasso' && this.lassoPath) {
        this.applyLassoMask(canvas.getContext('2d'), s.x, s.y, this.lassoPath);
      }
    }

    // Create brush data structure similar to GIMP brush
    const brushData = {
      type: 'image',
      width: canvas.width,
      height: canvas.height,
      gimpUrl: canvas.toDataURL(),
      image: null // Will be set when loaded
    };

    // Create the image element
    const img = new Image();
    img.onload = () => {
      brushData.image = img;

      // Set as active brush and switch to imageBrush tool
      app.self.imageBrush = brushData;
      app.selectTool('imageBrush');
      app.ui.setBrushPreview(brushData.gimpUrl);

      // Broadcast brush to other users
      app.wsClient.broadcastBrush(brushData);
      app.wsClient.broadcastSelectionToBrush(brushData);
    };
    img.src = brushData.gimpUrl;

    // Deselect after converting to brush
    this.deselect();

    return true;
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

  // Check if selection has been scaled from its original size
  hasScaledSelection() {
    if (!this.selection || !this.originalCorners || !this.floatingCanvas) return false;
    const tolerance = 1; // Allow 1px tolerance for rounding
    return (
      Math.abs(this.selection.width - this.originalCorners.br.x) > tolerance ||
      Math.abs(this.selection.height - this.originalCorners.br.y) > tolerance
    );
  }

  // Get transformed canvas (applies homography if corners are transformed)
  getTransformedCanvas() {
    if (!this.floatingCanvas) return null;

    // If no transform, return original
    if (!this.hasTransformedCorners()) {
      return this.floatingCanvas;
    }

    // Perform the transform using shared utility
    const result = performHomographyTransform({
      sourceCanvas: this.floatingCanvas,
      sourceCorners: this.originalCorners,
      destCorners: this.corners,
      scale: 1 // Full resolution
    });

    if (result) {
      return imageDataToCanvas(result.imageData);
    }

    // Fallback to original
    return this.floatingCanvas;
  }

  /**
   * Cancel selection - delete the floating selection without restoring original content
   * (New behavior - different from UNDO)
   */
  cancelSelection() {
    if (!this.floatingCanvas || !this.selection) return false;

    // Do NOT restore the erased area - let it stay erased
    // Clear the restore data without using it
    this._restoreData = null;

    // Broadcast cancel to other users
    if (this.board.app?.wsClient) {
      this.board.app.wsClient.broadcastSelectionCancel();
    }

    // Clear floating state
    this.floatingCanvas = null;
    this.floatingCtx = null;
    this.selectedImageData = null;

    // Clear selection and UI
    this.hideContextMenu();
    this.clearSelection();
    this.board.clearTop();

    return true;
  }
}
