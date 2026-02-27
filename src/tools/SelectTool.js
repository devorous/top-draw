import { Homography } from '../utils/homography.js';
import { performHomographyTransform, imageDataToCanvas, calculateCornerBounds } from '../utils/homographyUtils.js';
import { pointInHull } from '../sync/ConvexHull.js';
import { distanceBasedCulling } from '../utils/drawing.js';

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
 * Selection tool for selecting, moving, and transforming regions
 */
export class SelectTool extends Tool {
  constructor(board) {
    super('select', board);
    this.mode = 'lasso'; // 'rectangle' or 'lasso' - default to lasso
    this.copyAllLayers = false; // Toggle: copy/cut all visible layers vs active layer only
    this._restoreData = null; // Snapshot of erased area for undoMovement()
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
    this.originalSelectionPos = null; // Track original position to detect moves

    // Rotation
    this.rotation = 0; // Rotation angle in radians
    this.rotationHandleDistance = 30; // Distance of rotation handle from top edge
    this.isRotating = false;
    this.rotationStartAngle = 0; // Angle when rotation started
    this.cornersAtRotationStart = null; // Corners at the start of rotation

    // Perspective handles (extend from corners for homography control)
    this.perspectiveHandleDistance = 40; // Distance from corners (similar to rotation's 30px)

    // Homography instance for transforms (reused to avoid per-frame allocation)
    this.homography = null;
    this.previewHomography = null; // Separate instance for downscaled previews
    this.isTransforming = false;

    // Preview downscaling settings
    this.previewMaxSize = 256; // Max dimension for preview warps
    this.hasShownPreviewToast = false; // Track if we've shown the low-res preview toast

    // Clipboard
    this.clipboard = null;

    // Context menu elements (cached after first use)
    this.menuElements = null;

    // Menu positioning
    this.lastPointerUpPos = null; // Track where mouse up occurred for menu positioning

    // Throttling for selection move broadcasts (30 TPS for homography performance)
    this.selectionMoveThrottleRate = 30; // TPS
    this.selectionMoveThrottleInterval = 1000 / this.selectionMoveThrottleRate; // ~33.33ms
    this.lastSelectionBroadcastTime = 0;
    this.pendingSelectionBroadcast = null; // Stores corners to broadcast after throttle

    // Lasso-specific state
    this.lassoPoints = []; // Raw points collected during lasso draw
    this.lassoSimplified = null; // Simplified path for rendering/testing
    this.lassoPath = null; // The actual lasso path used for point-in-polygon testing (preserves concave shape)
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
    this.startMarchingAnts();
    this.setupMenuListeners();
  }

  deactivate() {
    this.stopMarchingAnts();
    this.commitSelection();
    this.clearSelection();
    this.hideContextMenu();
    // Reset cursor
    this.board.container.style.cursor = 'none';
    if (this.board.app?.ui) {
      this.board.app.ui.setSelectCursor(false); // Reset to crosshair
    }
  }

  /**
   * Throttled broadcast for selection moves to limit network/render load.
   * Broadcasts at most at selectionMoveThrottleRate TPS (default 30).
   * @param {Object} corners - { tl: {x,y}, tr: {x,y}, bl: {x,y}, br: {x,y} }
   * @param {boolean} force - If true, bypass throttle (for final position on pointer up)
   */
  throttledBroadcastSelectionMove(corners, force = false) {
    if (!this.board.app || !this.board.app.wsClient) return;

    const now = performance.now();
    const elapsed = now - this.lastSelectionBroadcastTime;

    if (force || elapsed >= this.selectionMoveThrottleInterval) {
      // Enough time has passed or forced - send immediately
      this.board.app.wsClient.broadcastSelectionMove(corners);
      this.lastSelectionBroadcastTime = now;
      this.pendingSelectionBroadcast = null;
    } else {
      // Store for later - will be sent when throttle window passes or on pointer up
      this.pendingSelectionBroadcast = { ...corners };
    }
  }

  /**
   * Flush any pending selection broadcast (call on pointer up to ensure final state is sent)
   */
  flushPendingSelectionBroadcast() {
    if (this.pendingSelectionBroadcast && this.board.app && this.board.app.wsClient) {
      this.board.app.wsClient.broadcastSelectionMove(this.pendingSelectionBroadcast);
      this.pendingSelectionBroadcast = null;
      this.lastSelectionBroadcastTime = performance.now();
    }
  }

  /**
   * Set selection mode
   * @param {string} mode - 'rectangle' or 'lasso'
   */
  setMode(mode) {
    if (this.selection) {
      this.commitSelection();
      this.clearSelection();
    }
    this.mode = mode;
  }

  /**
   * Get bounding box from array of points
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

    return {
      x: Math.floor(minX),
      y: Math.floor(minY),
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY)
    };
  }

  /**
   * Draw lasso preview during selection
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
  }

  /**
   * Apply lasso mask to ImageData - sets alpha to 0 for pixels outside lasso
   * @param {ImageData} imageData - The image data to mask
   * @param {number} offsetX - X offset of imageData relative to canvas
   * @param {number} offsetY - Y offset of imageData relative to canvas
   * @param {Array<{x: number, y: number}>} lassoPath - The lasso polygon (any polygon works with pointInHull winding number algorithm)
   */
  applyLassoMask(imageData, offsetX, offsetY, lassoPath) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const canvasX = x + offsetX;
        const canvasY = y + offsetY;

        // Check if this pixel is inside the lasso path (pointInHull uses winding number algorithm which works with any polygon)
        if (!pointInHull({ x: canvasX, y: canvasY }, lassoPath)) {
          // Set alpha to 0 for pixels outside the lasso
          const idx = (y * width + x) * 4;
          data[idx + 3] = 0; // Alpha channel
        }
      }
    }
  }

  setupMenuListeners() {
    if (this.menuElements) return; // Already set up

    this.menuElements = {
      menu: document.getElementById('selectionMenu'),
      clear: document.getElementById('selMenuClear'),
      fill: document.getElementById('selMenuFill'),
      copy: document.getElementById('selMenuCopy'),
      brush: document.getElementById('selMenuBrush'),
      flip: document.getElementById('selMenuFlip'),
      stamp: document.getElementById('selMenuStamp'),
      undo: document.getElementById('selMenuUndo'),
      cancel: document.getElementById('selMenuCancel')
    };

    if (!this.menuElements.menu) return;

    this.menuElements.clear.addEventListener('click', () => this.deleteSelection());
    this.menuElements.fill.addEventListener('click', () => this.fillSelection());
    this.menuElements.copy.addEventListener('click', () => this.copy());
    this.menuElements.brush.addEventListener('click', () => this.toImageBrush());
    this.menuElements.flip.addEventListener('click', () => this.flipHorizontal());
    this.menuElements.stamp.addEventListener('click', () => this.stamp());
    this.menuElements.undo.addEventListener('click', () => this.undoMovement());
    this.menuElements.cancel.addEventListener('click', () => this.cancelSelection());
  }

  showContextMenu() {
    if (!this.menuElements?.menu || !this.selection) return;

    const menu = this.menuElements.menu;
    const hasMoved = this.hasBeenMoved();

    // Show/hide options based on state
    this.menuElements.clear.classList.toggle('hidden', hasMoved);
    this.menuElements.fill.classList.toggle('hidden', hasMoved);
    this.menuElements.flip.classList.toggle('hidden', false); // Always visible
    this.menuElements.stamp.classList.toggle('hidden', !hasMoved);
    this.menuElements.undo.classList.toggle('hidden', !hasMoved);
    this.menuElements.cancel.classList.toggle('hidden', !hasMoved);

    // Use grid layout when selection has been moved (6 buttons in 2x3 grid)
    // Use column layout for fresh selection (5 buttons in vertical list)
    menu.classList.toggle('grid', hasMoved);

    // Position menu near cursor instead of selection corner
    let canvasX, canvasY;

    if (this.lastPointerUpPos) {
      // Use last pointer up position
      canvasX = this.lastPointerUpPos.x;
      canvasY = this.lastPointerUpPos.y;
    } else {
      // Fallback to bottom-right of selection (legacy behavior)
      const rightX = this.corners
        ? Math.max(this.corners.tl.x, this.corners.tr.x, this.corners.bl.x, this.corners.br.x)
        : this.selection.x + this.selection.width;
      const bottomY = this.corners
        ? Math.max(this.corners.tl.y, this.corners.tr.y, this.corners.bl.y, this.corners.br.y)
        : this.selection.y + this.selection.height;

      canvasX = rightX;
      canvasY = bottomY;
    }

    // Account for board zoom/pan transforms
    const zoom = this.board.zoom || 1;
    const panX = this.board.panX || 0;
    const panY = this.board.panY || 0;

    // Transform canvas coordinates to screen coordinates
    const screenX = canvasX * zoom + panX;
    const screenY = canvasY * zoom + panY;

    // Show menu to measure dimensions (let CSS classes control display type)
    menu.style.display = '';
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;

    // Position relative to board container
    const containerRect = this.board.container.getBoundingClientRect();

    // Position menu slightly offset from cursor (10px right, 10px down)
    let left = containerRect.left + screenX + 10;
    let top = containerRect.top + screenY + 10;

    // Keep menu on screen
    left = Math.max(10, Math.min(left, window.innerWidth - menuWidth - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - menuHeight - 10));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  hideContextMenu() {
    if (this.menuElements?.menu) {
      this.menuElements.menu.style.display = 'none';
    }
  }

  hasBeenMoved() {
    if (!this.originalSelectionPos || !this.selection) return false;
    return (
      Math.abs(this.selection.x - this.originalSelectionPos.x) > 1 ||
      Math.abs(this.selection.y - this.originalSelectionPos.y) > 1 ||
      this.hasTransformedCorners() ||
      Math.abs(this.rotation) > 0.01
    );
  }

  updateCursor(pos) {
    if (!this.board.container) return;

    // Check if over a handle first (highest priority)
    this.updateHandles();
    const handle = this.getHandleAtPoint(pos);
    if (handle) {
      // Set cursor based on handle position
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

    // Check if over selection (for move)
    if (this.selection && this.isInsideSelection(pos)) {
      this.board.container.style.cursor = 'move';
      if (this.board.app?.ui) {
        this.board.app.ui.setSelectCursor(true); // Show hand cursor
      }
      return;
    }

    // Default crosshair for selection
    this.board.container.style.cursor = 'crosshair';
    if (this.board.app?.ui) {
      this.board.app.ui.setSelectCursor(false); // Show crosshair cursor
    }
  }

  startMarchingAnts() {
    if (this.animationId) return;

    const animate = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 1) % 16;
      // Only redraw if we have a selection and aren't actively transforming
      if (this.selection && !this.isDragging && !this.isTransforming && !this.isSelecting && !this.isRotating) {
        this.board.clearTop();
        // Draw floating selection or transform preview
        if (this.floatingCanvas && (this.hasTransformedCorners() || this.rotation !== 0)) {
          // Show transform preview if corners have been moved or rotated
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

    // Draw marching ants border using corners if available AND transformed
    if (this.corners && this.hasTransformedCorners()) {
      this.drawTransformOutline(ctx);
      this.drawTransformHandles(ctx);
    } else if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.hasScaledSelection()) {
      // Lasso mode - draw simplified polygon (only if not scaled)
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.beginPath();
      ctx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
      for (let i = 1; i < this.lassoSimplified.length; i++) {
        ctx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
      }
      ctx.closePath();
      ctx.stroke();

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.beginPath();
      ctx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
      for (let i = 1; i < this.lassoSimplified.length; i++) {
        ctx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Also draw a subtle bounding rectangle (no animation)
      const s = this.selection;
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x, s.y, s.width, s.height);

      // Draw handles
      this.updateHandles();
      for (const handle of this.handles) {
        if (handle.isRotation) {
          // Draw connecting line to rotation handle
          const tm = this.handles.find(h => h.id === 'tm');
          if (tm) {
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tm.x, tm.y);
            ctx.lineTo(handle.x, handle.y);
            ctx.stroke();
          }

          // Draw rotation handle as a circle
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#000';
          ctx.beginPath();
          ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (handle.isPerspective) {
          // Draw perspective handle with connecting line
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

            // Draw perspective handle as desaturated cyan circle
            ctx.fillStyle = '#88CCCC'; // Less saturated cyan
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        } else {
          // Draw regular handles as squares
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
    } else {
      // Rectangle mode - draw bounding box
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
        if (handle.isRotation) {
          // Draw connecting line to rotation handle
          const tm = this.handles.find(h => h.id === 'tm');
          if (tm) {
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(tm.x, tm.y);
            ctx.lineTo(handle.x, handle.y);
            ctx.stroke();
          }

          // Draw rotation handle as a circle
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#000';
          ctx.beginPath();
          ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (handle.isPerspective) {
          // Draw perspective handle with connecting line
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

            // Draw perspective handle as desaturated cyan circle
            ctx.fillStyle = '#88CCCC'; // Less saturated cyan
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(handle.x, handle.y, this.handleSize / 2 + 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        } else {
          // Draw regular handles as squares
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
  }

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
      this.drawSelectionBox(this.board.topCtx, this.startPos, pos);
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
    } else {
      // Rectangle mode (existing code)
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

      // Store original position to detect moves
      this.originalSelectionPos = { x, y };

      // Initialize corners for transform
      this.initializeCorners();
      this.updateHandles();

      this.board.clearTop();
      this.drawSelectionUI();
      this.updateCursor(pos);
      this.showContextMenu();
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

    this.selection.x = minX;
    this.selection.y = minY;
    this.selection.width = maxX - minX;
    this.selection.height = maxY - minY;
  }


  drawTransformPreview() {
    if (!this.floatingCanvas || !this.corners || !this.originalCorners) return;

    const ctx = this.board.topCtx;

    // Calculate preview scale for downsampling input image (max 256px on longest side of source)
    const srcMaxDim = Math.max(this.floatingCanvas.width, this.floatingCanvas.height);
    const previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;

    // Show toast if preview downscaling is active (only once per selection session)
    if (previewScale < 1 && !this.hasShownPreviewToast && this.board.app?.ui) {
      this.board.app.ui.showToast('Low res preview!');
      this.hasShownPreviewToast = true;
    }

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
      // Calculate full output bounds for scaling up the preview
      const bounds = calculateCornerBounds(this.corners);

      // Draw the warped result scaled up to full size
      const tempCanvas = imageDataToCanvas(result.imageData);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.drawImage(tempCanvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
    } else {
      // Fallback: just draw the original floating selection
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
      // Transformed selection - draw quadrilateral
      const c = this.corners;

      ctx.strokeStyle = '#000';
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

      // Draw bounding box
      ctx.setLineDash([]);
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      ctx.setLineDash([4, 4]); // Keep dashed for cleanup
    } else if (this.mode === 'lasso' && this.lassoSimplified && this.lassoSimplified.length > 0 && !this.hasScaledSelection()) {
      // Lasso mode - draw simplified polygon (only if not scaled)
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.beginPath();
      ctx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
      for (let i = 1; i < this.lassoSimplified.length; i++) {
        ctx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
      }
      ctx.closePath();
      ctx.stroke();

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.beginPath();
      ctx.moveTo(this.lassoSimplified[0].x, this.lassoSimplified[0].y);
      for (let i = 1; i < this.lassoSimplified.length; i++) {
        ctx.lineTo(this.lassoSimplified[i].x, this.lassoSimplified[i].y);
      }
      ctx.closePath();
      ctx.stroke();

      // Also draw a subtle bounding rectangle (no animation)
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x, s.y, s.width, s.height);
      ctx.setLineDash([4, 4]); // Restore for cleanup below
    } else {
      // Rectangle mode OR lasso after lifting - draw bounding box
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.marchingAntsOffset;
      ctx.strokeRect(s.x, s.y, s.width, s.height);

      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.marchingAntsOffset + 4;
      ctx.strokeRect(s.x, s.y, s.width, s.height);
    }

    ctx.setLineDash([]);

    // Draw transform handles
    this.updateHandles();

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
      // Calculate preview scale for downsampling input image (max 256px on longest side of source)
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
        // Calculate full output bounds for scaling up the preview
        const bounds = calculateCornerBounds(this.corners);

        // Draw the warped result scaled up to full size
        const tempCanvas = imageDataToCanvas(result.imageData);
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

    // Copy from flattened layer(s) with transparent background
    const flatCanvas = this._flattenSelectionToCanvas(s);
    const imageData = flatCanvas.getContext('2d').getImageData(0, 0, s.width, s.height);

    // Apply lasso mask if in lasso mode
    if (this.mode === 'lasso' && this.lassoPath) {
      this.applyLassoMask(imageData, s.x, s.y, this.lassoPath);
    }

    this.floatingCtx.putImageData(imageData, 0, 0);
    this.selectedImageData = imageData;

    // Store original position BEFORE erasing so we can track moves
    if (!this.originalSelectionPos) {
      this.originalSelectionPos = { x: s.x, y: s.y };
    }

    // Erase source area directly from baseCanvas (no stroke record created)
    this._restoreData = this._eraseSelectionDirectly(s, this.mode === 'lasso' ? this.lassoPath : null);

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
      this.board.app.wsClient.broadcastSelectionLift(this.selection, this.lassoPath);
    }
  }

  commitSelection() {
    if (!this.floatingCanvas || !this.selection) return;

    const lm = this.board.layerManager;
    const userId = this.board.app?.self?.id ?? 0;
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
        active.ctx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
      } else {
        active.ctx.drawImage(this.floatingCanvas, this.selection.x, this.selection.y, this.selection.width, this.selection.height);
      }
    } else {
      active.ctx.drawImage(this.floatingCanvas, this.selection.x, this.selection.y, this.selection.width, this.selection.height);
    }

    // Commit as an undoable stroke record.
    // Attach restore data so Board.undo/redo can also reverse the source-area erase.
    lm.commitUserStroke(activeLayer, userId, { selectionRestoreData: this._restoreData });
    this.board.compositeAllLayers();

    if (this.board.app && this.board.app.wsClient) {
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

    // Lasso cleanup
    this.lassoPoints = [];
    this.lassoPath = null;
    this.lassoSimplified = null;

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
      // Read from mainCtx which has all layers composited with background
      selCtx.drawImage(this.board.mainCanvas, s.x, s.y, s.width, s.height, 0, 0, s.width, s.height);
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

  // Erase the selection directly from baseCanvas without touching the stroke history.
  // Bakes the current user's uncommitted strokes into baseCanvas first, then applies
  // destination-out. Stores a per-layer restore snapshot and returns it.
  _eraseSelectionDirectly(s, lassoPath) {
    const lm = this.board.layerManager;
    const isMultiLayer = this.copyAllLayers;
    const snapshots = [];

    const eraseGroup = (groupIdx) => {
      const group = lm.layerGroups[groupIdx];
      if (!group || !group.visible) return;

      // Composite the entire group (base + all strokes) onto a TRANSPARENT canvas.
      // _compositeGroupInto does not fill a background, so transparency is preserved —
      // unlike _bakeStrokeToBase which fills with the board background colour (white).
      const layerCanvas = document.createElement('canvas');
      layerCanvas.width = lm.width;
      layerCanvas.height = lm.height;
      const layerCtx = layerCanvas.getContext('2d');
      lm._compositeGroupInto(layerCtx, group);

      // Snapshot the selection area BEFORE erasing (used by undoMovement / undo to restore)
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

      // Apply the erase to the composited layer canvas
      layerCtx.globalCompositeOperation = 'destination-out';
      layerCtx.fillStyle = 'white';
      if (lassoPath && lassoPath.length >= 3) {
        layerCtx.beginPath();
        layerCtx.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) {
          layerCtx.lineTo(lassoPath[i].x, lassoPath[i].y);
        }
        layerCtx.closePath();
        layerCtx.fill();
      } else {
        layerCtx.fillRect(s.x, s.y, s.width, s.height);
      }
      layerCtx.globalCompositeOperation = 'source-over';

      // Replace baseCanvas with the transparent erased composite
      // and clear the stroke stack (everything is now baked in)
      group.baseCtx.clearRect(0, 0, lm.width, lm.height);
      group.baseCtx.drawImage(layerCanvas, 0, 0);
      group.strokeStack = [];
      group.userStrokeCounts.clear();
      group.activeStrokeByUser.clear();

      lm.needsComposite = true;
    };

    if (isMultiLayer) {
      for (let i = 0; i < lm.layerGroups.length; i++) eraseGroup(i);
    } else {
      eraseGroup(this.board.app?.self?.activeLayer ?? 0);
    }

    lm._notifyHistoryPanel();
    this.board.compositeAllLayers();

    // Return snapshots + the original erase shape so Board.undo/redo can replay it
    return {
      snapshots,
      eraseS: { ...s },
      eraseLassoPath: lassoPath ? lassoPath.map(p => ({ ...p })) : null
    };
  }

  // Restore erased content from a restore snapshot (used by undoMovement / Board.undo)
  _restoreSelectionContent(restoreData) {
    if (!restoreData) return;
    const snapshots = restoreData.snapshots || restoreData; // accept both formats
    const lm = this.board.layerManager;

    for (const { groupIdx, canvas, x, y } of snapshots) {
      const group = lm.layerGroups[groupIdx];
      if (!group) continue;
      group.baseCtx.drawImage(canvas, x, y);
      lm.needsComposite = true;
    }

    lm._notifyHistoryPanel();
    this.board.compositeAllLayers();
  }

  // Copy selection to clipboard
  copy() {
    if (!this.selection) return false;

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
      const imageData = flatCanvas.getContext('2d').getImageData(0, 0, s.width, s.height);
      if (this.mode === 'lasso' && this.lassoPath) {
        this.applyLassoMask(imageData, s.x, s.y, this.lassoPath);
      }
      this.clipboard = {
        width: s.width,
        height: s.height,
        imageData
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
    // Commit any existing selection
    this.commitSelection();
    this.clearSelection();

    let width, height;
    if (imageSource instanceof ImageData) {
      width = imageSource.width;
      height = imageSource.height;
    } else {
      width = imageSource.width;
      height = imageSource.height;
    }

    // Paste at user's current cursor position (centered on cursor)
    const app = this.board.app;
    const x = app?.self?.x || this.board.mainCanvas.width / 2;
    const y = app?.self?.y || this.board.mainCanvas.height / 2;

    const pasteX = x - width / 2;
    const pasteY = y - height / 2;

    this.selection = {
      x: pasteX,
      y: pasteY,
      width: width,
      height: height
    };

    // Create floating canvas with the image content
    this.floatingCanvas = document.createElement('canvas');
    this.floatingCanvas.width = width;
    this.floatingCanvas.height = height;
    this.floatingCtx = this.floatingCanvas.getContext('2d');
    
    if (imageSource instanceof ImageData) {
      this.floatingCtx.putImageData(imageSource, 0, 0);
    } else {
      this.floatingCtx.drawImage(imageSource, 0, 0);
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

    // If floating, erase already happened at lift time — just discard
    if (this.floatingCanvas) {
      this.floatingCanvas = null;
      this.floatingCtx = null;
      this._restoreData = null;
    } else {
      // Not yet lifted — erase now directly
      this._eraseSelectionDirectly(s, this.mode === 'lasso' ? this.lassoPath : null);
    }

    // Broadcast delete to other users
    if (this.board.app?.wsClient) {
      this.board.app.wsClient.broadcastSelectionDelete();
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

  // Fill selection with current color
  fillSelection() {
    if (!this.selection) return false;

    const s = this.selection;
    const app = this.board.app;
    if (!app) return false;

    const color = app.self.getColorString();
    const opacity = app.self.opacity !== undefined ? app.self.opacity : 1;

    // If floating, fill the floating canvas
    if (this.floatingCanvas) {
      this.floatingCtx.globalAlpha = opacity;
      this.floatingCtx.fillStyle = color;

      if (this.mode === 'lasso' && this.lassoPath && this.lassoPath.length >= 3) {
        // Use lasso path as clipping region (translate to floating canvas coordinates)
        this.floatingCtx.save();
        this.floatingCtx.beginPath();
        this.floatingCtx.moveTo(this.lassoPath[0].x - s.x, this.lassoPath[0].y - s.y);
        for (let i = 1; i < this.lassoPath.length; i++) {
          this.floatingCtx.lineTo(this.lassoPath[i].x - s.x, this.lassoPath[i].y - s.y);
        }
        this.floatingCtx.closePath();
        this.floatingCtx.clip();
        this.floatingCtx.fillRect(0, 0, s.width, s.height);
        this.floatingCtx.restore();
      } else {
        // Rectangle mode - fill entire selection
        this.floatingCtx.fillRect(0, 0, s.width, s.height);
      }

      this.floatingCtx.globalAlpha = 1;
      this.board.clearTop();
      this.drawSelectionUI();
    } else {
      // Fill on active layer using layer system
      this.board.beginStroke(app.self);

      const layerCtx = this.board.getActiveLayerContext();
      layerCtx.globalAlpha = opacity;
      layerCtx.fillStyle = color;

      if (this.mode === 'lasso' && this.lassoPath && this.lassoPath.length >= 3) {
        // Use lasso path as clipping region
        layerCtx.save();
        layerCtx.beginPath();
        layerCtx.moveTo(this.lassoPath[0].x, this.lassoPath[0].y);
        for (let i = 1; i < this.lassoPath.length; i++) {
          layerCtx.lineTo(this.lassoPath[i].x, this.lassoPath[i].y);
        }
        layerCtx.closePath();
        layerCtx.clip();
        layerCtx.fillRect(s.x, s.y, s.width, s.height);
        layerCtx.restore();
      } else {
        // Rectangle mode - fill entire selection
        layerCtx.fillRect(s.x, s.y, s.width, s.height);
      }

      layerCtx.globalAlpha = 1;

      this.board.compositeAllLayers();
      this.board.endStroke(app.self);
    }

    // Broadcast fill to other users
    if (this.board.app?.wsClient) {
      this.board.app.wsClient.broadcastSelectionFill(app.self.color);
    }

    // Keep selection active, update menu position
    this.showContextMenu();

    return true;
  }

  // Stamp current selection to canvas without clearing it (for repeated stamping)
  stamp() {
    if (!this.floatingCanvas || !this.selection) return false;

    const app = this.board.app;
    if (!app) return false;

    // Begin stroke for the stamp operation
    this.board.beginStroke(app.self);

    // Get layer context instead of mainCtx
    const layerCtx = this.board.getActiveLayerContext();

    // Same logic as commitSelection but don't clear the floating canvas
    if ((this.hasTransformedCorners() || this.rotation !== 0) && this.corners && this.originalCorners) {
      // Reuse or create homography instance for full-resolution stamp
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
        const tempCanvas = imageDataToCanvas(result.imageData);
        layerCtx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
      } else {
        layerCtx.drawImage(
          this.floatingCanvas,
          this.selection.x,
          this.selection.y,
          this.selection.width,
          this.selection.height
        );
      }
    } else {
      layerCtx.drawImage(
        this.floatingCanvas,
        this.selection.x,
        this.selection.y,
        this.selection.width,
        this.selection.height
      );
    }

    // Composite and commit the stroke
    this.board.compositeAllLayers();
    this.board.endStroke(app.self);

    // Broadcast stamp but keep selection active
    if (this.board.app?.wsClient) {
      this.board.app.wsClient.broadcastSelectionStamp();
    }

    // Redraw the floating selection on top canvas
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu();

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

    // If there are original corners (for transforms), we need to flip them too
    if (this.originalCorners) {
      const width = this.floatingCanvas.width;
      // Swap left and right corners horizontally
      const tempTL = { ...this.originalCorners.tl };
      const tempBL = { ...this.originalCorners.bl };

      this.originalCorners.tl.x = width - this.originalCorners.tr.x;
      this.originalCorners.bl.x = width - this.originalCorners.br.x;
      this.originalCorners.tr.x = width - tempTL.x;
      this.originalCorners.br.x = width - tempBL.x;
    }

    // Note: Network broadcast not implemented yet - flip is local only

    // Redraw the selection with flipped content
    this.board.clearTop();
    this.drawSelectionUI();
    this.showContextMenu();

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
      // Create a canvas with the selection content
      const s = this.selection;
      canvas = document.createElement('canvas');
      canvas.width = s.width;
      canvas.height = s.height;
      const ctx = canvas.getContext('2d');
      const imageData = this.board.mainCtx.getImageData(s.x, s.y, s.width, s.height);
      ctx.putImageData(imageData, 0, 0);
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

  // Cancel movement and restore selection to original position
  /**
   * Undo movement - restore selection to original position and clear
   * (Previous CANCEL behavior)
   */
  undoMovement() {
    if (!this.floatingCanvas || !this.selection || !this.originalSelectionPos) return false;

    // Restore the erased source area from our snapshot
    if (this._restoreData) {
      this._restoreSelectionContent(this._restoreData);
      this._restoreData = null;
    }

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
