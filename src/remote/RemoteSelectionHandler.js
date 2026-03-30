import { Homography } from '../utils/homography.js';
import { performHomographyTransform, calculateCornerBounds, imageDataToCanvas } from '../utils/homographyUtils.js';

/**
 * RemoteSelectionHandler - Handles selection tool rendering and operations for remote users
 * Manages floating selections, perspective transforms, and animated marching ants
 */
export class RemoteSelectionHandler {
  constructor(board, getUsersMap, getSessionIndex) {
    this.board = board;
    this.getUsersMap = getUsersMap;
    this.getSessionIndex = getSessionIndex;
    this.remoteSelectionAnimationId = null;
    this.remoteSelectionOffset = 0;

    // Preview downscaling settings (same as SelectTool)
    this.previewMaxSize = 256; // Max dimension for preview warps

    // Pattern tile cache for pattern fills
    this._patternTileCache = new Map();
  }

  /**
   * Generate a pattern tile from a user's pattern brush settings.
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

    const maxDim = 40;
    const imgWidth = img.width || img.naturalWidth;
    const imgHeight = img.height || img.naturalHeight;
    if (!imgWidth || !imgHeight) return null;

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
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = tileWidth;
    tempCanvas.height = tileHeight;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(img, 0, 0, tileWidth, tileHeight);

    // Handle GIMP greyscale brushes
    if (brush.type === 'gbr' && brush.colorDepth === 1) {
      const imageData = tempCtx.getImageData(0, 0, tileWidth, tileHeight);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
        data[i + 3] = 255 - brightness;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
      tempCtx.putImageData(imageData, 0, 0);
    }

    tctx.save();
    tctx.drawImage(tempCanvas, padding / 2, padding / 2, tileWidth, tileHeight);

    if (colorMode === 'tinted') {
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3]})`;
      tctx.fillRect(0, 0, tileCanvas.width, tileCanvas.height);
    }

    tctx.restore();
    this._patternTileCache.set(key, tileCanvas);
    return tileCanvas;
  }

  /**
   * Start the animation loop for remote user selections
   */
  startRemoteSelectionAnimation() {
    if (this.remoteSelectionAnimationId) return;

    const animate = () => {
      this.remoteSelectionOffset = (this.remoteSelectionOffset + 1) % 16;

      // Get fresh values each frame
      const users = this.getUsersMap();
      const sessionIndex = this.getSessionIndex();

      // Check if any remote user has a selection that needs animating
      let hasActiveSelection = false;
      if (users) {
        for (const [id, user] of users.entries()) {
          // Skip local user
          if (id === sessionIndex) continue;

          if (user.floatingCanvas || user.pendingSelection) {
            hasActiveSelection = true;

            if (user.floatingCanvas && user.selection) {
              // Skip during active movement (like local SelectTool's !isDragging guard).
              // handleSelectionMove already drew synchronously.
              // When idle, redraw to animate marching ants.
              if (!user._selectionMoving) {
                user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
                this.drawFloatingSelection(user);
              }
            } else if (user.pendingSelection) {
              user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
              this.drawPendingSelection(user);
            }
          }
        }
      }

      // Only continue animation if there are active selections
      if (hasActiveSelection) {
        this.remoteSelectionAnimationId = requestAnimationFrame(animate);
      } else {
        this.remoteSelectionAnimationId = null;
      }
    };

    this.remoteSelectionAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Stop the remote selection animation
   */
  stopRemoteSelectionAnimation() {
    if (this.remoteSelectionAnimationId) {
      cancelAnimationFrame(this.remoteSelectionAnimationId);
      this.remoteSelectionAnimationId = null;
    }
  }

  /**
   * Handle a remote user lifting a selection
   * @param {Object} user - The remote user
   * @param {Object} selection - Selection bounds {x, y, width, height}
   * @param {Array<{x: number, y: number}>|null} lassoPath - Optional lasso path for non-rectangular selections
   */
  handleSelectionLift(user, selection, lassoPath = null) {
    // Clear pending selection since it's now being lifted
    user.pendingSelection = null;
    user.pendingLassoPath = null;

    // Store selection info on user for rendering
    user.selection = selection;

    // Lift the pixels from main canvas into a floating canvas for this user
    const s = selection;
    user.floatingCanvas = document.createElement('canvas');
    user.floatingCanvas.width = s.width;
    user.floatingCanvas.height = s.height;
    user.floatingCtx = user.floatingCanvas.getContext('2d');
    user.floatingCtx.setTransform(1, 0, 0, 1, 0, 0); // Ensure clean state

    // Copy selected region from the remote user's active layer only (transparent background),
    // matching local SelectTool behaviour (copyAllLayers=false).
    // Reading from mainCtx would capture all layers + background, so moving the selection
    // would appear to move content from every layer instead of just the user's layer.
    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;
    const layerFlatCanvas = document.createElement('canvas');
    layerFlatCanvas.width = lm.width;
    layerFlatCanvas.height = lm.height;
    const layerFlatCtx = layerFlatCanvas.getContext('2d');
    lm.compositeLayerRange(layerFlatCtx, layerIdx, layerIdx + 1, null);
    
    // Copy selected region into user's floating canvas
    user.floatingCtx.drawImage(layerFlatCanvas, s.x, s.y, s.width, s.height, 0, 0, s.width, s.height);

    // Apply lasso mask if path provided (preserves concave selections)
    if (lassoPath && lassoPath.length >= 3) {
      this.applyLassoMask(user.floatingCtx, s.x, s.y, lassoPath);
      user.lassoPath = lassoPath; // Store for potential later use
    }

    // Erase directly from the layer canvas so the hole persists through compositing.
    // Clearing mainCtx is insufficient because compositeAllLayers() rebuilds it from
    // the underlying layer data, restoring the erased pixels.
    // Store restore data so commitSelection can make this undoable for remote users.
    user._selectionRestoreData = this._eraseSelectionFromLayer(s, user.activeLayer ?? 0, lassoPath && lassoPath.length >= 3 ? lassoPath : null, user.id);

    // Check affected tiles for emptiness and clear ownership from empty ones
    const tt = this.board.tileTracker;
    if (tt) {
      const affectedTiles = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
      if (affectedTiles.length > 0) {
        this.board.checkErasedTilesByIndices(new Set(affectedTiles), false);
      }
    }

    // Activate split-composite mode so upper layers render above the floating selection
    this.board.activeSelectionLayer = user.activeLayer ?? 0;

    // Initialize corners for transform
    user.selectionCorners = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: s.width, y: 0 },
      bl: { x: 0, y: s.height },
      br: { x: s.width, y: s.height }
    };
    user.originalSelectionPos = { x: s.x, y: s.y };

    // Create reusable homography instances for this user's selection
    user.homography = new Homography('projective');
    user.previewHomography = new Homography('projective');

    // Draw floating selection on user's preview layer and start animation loop
    this.drawFloatingSelection(user);
    this.startRemoteSelectionAnimation();
  }

  /**
   * Handle a remote user creating a selection marquee (not yet moved/lifted)
   * @param {Object} user - The remote user
   * @param {Object} selection - Selection bounds {x, y, width, height}
   * @param {Array<{x: number, y: number}>|null} lassoPath - Optional lasso path
   */
  handleSelectionPending(user, selection, lassoPath = null) {
    user.pendingSelection = selection;
    user.pendingLassoPath = lassoPath;

    // Start animation loop if not running to show the marquee
    this.startRemoteSelectionAnimation();
  }

  /**
   * Apply lasso mask to a canvas context - sets alpha to 0 for pixels outside lasso path
   * Uses Canvas globalCompositeOperation for hardware-accelerated masking.
   * @param {CanvasRenderingContext2D} ctx - The context to mask
   * @param {number} offsetX - X offset of context relative to canvas
   * @param {number} offsetY - Y offset of context relative to canvas
   * @param {Array<{x: number, y: number}>} lassoPath - The lasso polygon
   */
  applyLassoMask(ctx, offsetX, offsetY, lassoPath) {
    if (!lassoPath || lassoPath.length < 3) return;

    ctx.save();
    // destination-in: Only keep pixels where the new drawing (the lasso path) overlaps existing content
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'white'; // Color doesn't matter for destination-in
    ctx.beginPath();
    ctx.moveTo(lassoPath[0].x - offsetX, lassoPath[0].y - offsetY);
    for (let i = 1; i < lassoPath.length; i++) {
      ctx.lineTo(lassoPath[i].x - offsetX, lassoPath[i].y - offsetY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  handleSelectionMove(user, corners) {
    if (!user.floatingCanvas || !user.selection) return;

    // Signal animation loop: skip drawing while moves are arriving
    // (mirrors local SelectTool's isDragging guard in startMarchingAnts)
    user._selectionMoving = true;

    // Reset idle timer — after 100ms of no SEL_MOVE, resume animation loop
    if (user._selectionIdleTimer) {
      clearTimeout(user._selectionIdleTimer);
    }
    user._selectionIdleTimer = setTimeout(() => {
      user._selectionMoving = false;
      user._selectionIdleTimer = null;
    }, 100);

    // Calculate movement delta before updating selection
    const oldX = user.selection.x;
    const oldY = user.selection.y;

    // Update corners
    user.selectionCorners = corners;

    // Update selection bounds from corners (ensure integers)
    const c = corners;
    const minX = Math.floor(Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x));
    const maxX = Math.ceil(Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x));
    const minY = Math.floor(Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y));
    const maxY = Math.ceil(Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y));
    
    user.selection.x = minX;
    user.selection.y = minY;
    user.selection.width = maxX - minX;
    user.selection.height = maxY - minY;

    // Translate lasso path to match new position (same as local SelectTool)
    if (user.lassoPath && user.lassoPath.length > 0) {
      const dx = minX - oldX;
      const dy = minY - oldY;
      user.lassoPath = user.lassoPath.map(p => ({
        x: p.x + dx,
        y: p.y + dy
      }));
    }

    // Regenerate preview cache if corners are transformed
    this._regeneratePreviewCache(user);

    // SYNCHRONOUS clear + redraw (matches local SelectTool pattern:
    // board.clearTop() then drawSelectionUI() in onPointerMove)
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawFloatingSelection(user);

    // Keep animation loop alive (for marching ants when idle)
    this.startRemoteSelectionAnimation();
  }

  handleSelectionCommit(user, layerIndex) {
    if (!user.floatingCanvas || !user.selection) return;

    const lm = this.board.layerManager;
    const layerIdx = layerIndex ?? user.activeLayer ?? 0;
    const s = user.selection;
    const c = user.selectionCorners;

    // Ensure integer coordinates for consistent baking
    const ix = Math.floor(s.x);
    const iy = Math.floor(s.y);
    const iw = Math.ceil(s.x + s.width) - ix;
    const ih = Math.ceil(s.y + s.height) - iy;

    // Begin a stroke on the remote user's active layer so the committed pixels
    // enter the layer system and persist through compositeAllLayers() calls.
    lm.beginUserStroke(layerIdx, user.id, 'source-over');
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
    if (!active) {
      this._cleanupUserSelection(user);
      return;
    }

    // Calculate dirty rect bounds for tracking
    let dirtyX, dirtyY, dirtyWidth, dirtyHeight;

    // Check if transform was applied (corners moved from axis-aligned rectangle)
    const hasTransform = this.hasTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      try {
        if (!user.homography) {
          user.homography = new Homography('projective');
        }

        const result = performHomographyTransform({
          sourceCanvas: user.floatingCanvas,
          sourceCorners: user.originalCorners,
          destCorners: c,
          scale: 1, // Full resolution for commit
          homographyInstance: user.homography
        });

        if (result) {
          const tempCanvas = imageDataToCanvas(result.imageData);
          active.ctx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
          dirtyX = result.bounds.minX;
          dirtyY = result.bounds.minY;
          dirtyWidth = result.bounds.width;
          dirtyHeight = result.bounds.height;
        } else {
          active.ctx.drawImage(user.floatingCanvas, ix, iy, iw, ih);
          dirtyX = ix;
          dirtyY = iy;
          dirtyWidth = iw;
          dirtyHeight = ih;
        }
      } catch (e) {
        console.warn('Remote homography failed:', e);
        active.ctx.drawImage(user.floatingCanvas, ix, iy, iw, ih);
        dirtyX = ix;
        dirtyY = iy;
        dirtyWidth = iw;
        dirtyHeight = ih;
      }
    } else {
      active.ctx.drawImage(user.floatingCanvas, ix, iy, iw, ih);
      dirtyX = ix;
      dirtyY = iy;
      dirtyWidth = iw;
      dirtyHeight = ih;
    }

    // Track the dirty region so the stroke is properly saved
    this.board.expandDirtyRect(user, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Store affected tiles in the stroke record for undo
    const tt = this.board.tileTracker;
    if (tt && active.affectedTiles) {
      const tileIndices = tt.getTileIndicesForRect(dirtyX, dirtyY, dirtyWidth, dirtyHeight);
      for (const idx of tileIndices) {
        active.affectedTiles.add(idx);
      }
    }

    // Pass the restore data captured during lift so Board.undo can reverse the erase
    lm.commitUserStroke(layerIdx, user.id, { selectionRestoreData: user._selectionRestoreData });
    this.board.activeSelectionLayer = -1;
    this.board.compositeAllLayers();

    // Add tile ownership for visible tiles in the pasted region (must be after composite)
    this.board.addOccupancyForVisibleTilesInRect(user.id, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    this._cleanupUserSelection(user);
  }

  handleSelectionDelete(user) {
    // Use selection if available, otherwise fall back to pendingSelection
    const s = user.selection || user.pendingSelection;
    if (!s) return;

    // Ensure integer coordinates for consistent erasing
    const x = Math.floor(s.x);
    const y = Math.floor(s.y);
    const width = Math.ceil(s.x + s.width) - x;
    const height = Math.ceil(s.y + s.height) - y;
    const intS = { x, y, width, height };

    if (!user.floatingCanvas) {
      this._eraseSelectionFromLayer(
        intS,
        user.activeLayer ?? 0,
        user.pendingLassoPath && user.pendingLassoPath.length >= 3 ? user.pendingLassoPath : null,
        user.id
      );

      // Check affected tiles for emptiness and clear ownership from empty ones
      const tt = this.board.tileTracker;
      if (tt) {
        const affectedTiles = tt.getTileIndicesForRect(s.x, s.y, s.width, s.height);
        if (affectedTiles.length > 0) {
          this.board.checkErasedTilesByIndices(new Set(affectedTiles), false);
        }
      }
    }

    this.board.activeSelectionLayer = -1;
    this.board.compositeAllLayers();
    this._cleanupUserSelection(user);
  }

  handleSelectionFill(user, color, layerIndex) {
    const s = user.selection || user.pendingSelection;
    if (!s) return;
    const colorString = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;

    // Check for pattern mode
    const usePattern = user.patternMode && user.patternBrush;
    let patternTile = null;
    if (usePattern) {
      patternTile = this._getPatternTile(user);
    }

    // Ensure integer coordinates for consistent filling
    let ix = Math.floor(s.x);
    let iy = Math.floor(s.y);
    let iw = Math.ceil(s.x + s.width) - ix;
    let ih = Math.ceil(s.y + s.height) - iy;

    const userOpacity = user.opacity !== undefined ? user.opacity : 1;

    if (user.floatingCanvas && user.floatingCtx) {
      user.floatingCtx.save();
      user.floatingCtx.setTransform(1, 0, 0, 1, 0, 0); // Ensure clean coordinate space

      // Set fill style (pattern or solid color)
      if (usePattern && patternTile) {
        const pattern = user.floatingCtx.createPattern(patternTile, 'repeat');
        if (pattern.setTransform) {
          const scale = (user.patternScale || 100) / 100;
          const offsetX = (user.patternOffsetX || 0) - s.x;
          const offsetY = (user.patternOffsetY || 0) - s.y;
          const rotation = user.patternRotation || 0;
          const matrix = new DOMMatrix()
            .translate(offsetX, offsetY)
            .rotate(rotation)
            .scale(scale);
          pattern.setTransform(matrix);
        }
        user.floatingCtx.fillStyle = pattern;
      } else {
        user.floatingCtx.fillStyle = colorString;
      }
      user.floatingCtx.globalCompositeOperation = 'source-over';
      user.floatingCtx.globalAlpha = userOpacity;

      const path = user.lassoPath || (user.pendingLassoPath && user.pendingLassoPath.length >= 3 ? user.pendingLassoPath : null);
      if (path) {
        user.floatingCtx.beginPath();
        user.floatingCtx.moveTo(path[0].x - s.x, path[0].y - s.y);
        for (let i = 1; i < path.length; i++) {
          user.floatingCtx.lineTo(path[i].x - s.x, path[i].y - s.y);
        }
        user.floatingCtx.closePath();
        user.floatingCtx.clip();
      }
      user.floatingCtx.fillRect(0, 0, user.floatingCanvas.width, user.floatingCanvas.height);
      user.floatingCtx.restore();

      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      this.drawFloatingSelection(user);
    } else {
      const lm = this.board.layerManager;
      const layerIdx = layerIndex ?? user.activeLayer ?? 0;

      lm.beginUserStroke(layerIdx, user.id, 'source-over');
      const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
      if (!active) return;

      const layerCtx = active.ctx;
      layerCtx.globalAlpha = userOpacity;

      // Set fill style (pattern or solid color)
      if (usePattern && patternTile) {
        const pattern = layerCtx.createPattern(patternTile, 'repeat');
        if (pattern.setTransform) {
          const scale = (user.patternScale || 100) / 100;
          const offsetX = user.patternOffsetX || 0;
          const offsetY = user.patternOffsetY || 0;
          const rotation = user.patternRotation || 0;
          const matrix = new DOMMatrix()
            .translate(offsetX, offsetY)
            .rotate(rotation)
            .scale(scale);
          pattern.setTransform(matrix);
        }
        layerCtx.fillStyle = pattern;
      } else {
        layerCtx.fillStyle = colorString;
      }

      const path = user.lassoPath || (user.pendingLassoPath && user.pendingLassoPath.length >= 3 ? user.pendingLassoPath : null);
      if (path) {
        // Recalculate bounds from path to ensure dirty rect covers the entire shape
        // (User selection bounds might be stale or not perfectly aligned with path)
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of path) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }

        // Update variables for fill and dirty rect
        ix = Math.floor(minX);
        iy = Math.floor(minY);
        iw = Math.ceil(maxX) - ix;
        ih = Math.ceil(maxY) - iy;

        layerCtx.save();
        layerCtx.beginPath();
        layerCtx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) {
          layerCtx.lineTo(path[i].x, path[i].y);
        }
        layerCtx.closePath();
        layerCtx.clip();
        layerCtx.fillRect(ix, iy, iw, ih);
        layerCtx.restore();
      } else {
        layerCtx.fillRect(ix, iy, iw, ih);
      }
      layerCtx.globalAlpha = 1.0;

      this.board.expandDirtyRect(user, ix, iy, iw, ih);

      // Store affected tiles in the stroke record for undo
      const tileOwnership = this.board.tileTracker;
      if (tileOwnership && active.affectedTiles) {
        const tileIndices = tileOwnership.getTileIndicesForRect(ix, iy, iw, ih);
        for (const idx of tileIndices) {
          active.affectedTiles.add(idx);
        }
      }

      lm.commitUserStroke(layerIdx, user.id);
      this.board.compositeAllLayers();

      // Add tile ownership for visible filled tiles (after composite)
      this.board.addOccupancyForVisibleTilesInRect(user.id, ix, iy, iw, ih);
    }
  }

  handleSelectionStamp(user, layerIndex) {
    // Same as commit but keep floating canvas active for further moves/stamps
    if (!user.floatingCanvas || !user.selection) return;

    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;
    const s = user.selection;
    const c = user.selectionCorners;

    lm.beginUserStroke(layerIdx, user.id, 'source-over');
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
    if (!active) return;

    // Calculate dirty rect bounds for tracking
    let dirtyX, dirtyY, dirtyWidth, dirtyHeight;

    const hasTransform = this.hasTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      try {
        if (!user.homography) {
          user.homography = new Homography('projective');
        }

        const result = performHomographyTransform({
          sourceCanvas: user.floatingCanvas,
          sourceCorners: user.originalCorners,
          destCorners: c,
          scale: 1, // Full resolution for stamp
          homographyInstance: user.homography
        });

        if (result) {
          const tempCanvas = imageDataToCanvas(result.imageData);
          active.ctx.drawImage(tempCanvas, result.bounds.minX, result.bounds.minY);
          dirtyX = result.bounds.minX;
          dirtyY = result.bounds.minY;
          dirtyWidth = result.bounds.width;
          dirtyHeight = result.bounds.height;
        } else {
          active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
          dirtyX = s.x;
          dirtyY = s.y;
          dirtyWidth = s.width;
          dirtyHeight = s.height;
        }
      } catch (e) {
        console.warn('Remote stamp homography failed:', e);
        active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        dirtyX = s.x;
        dirtyY = s.y;
        dirtyWidth = s.width;
        dirtyHeight = s.height;
      }
    } else {
      active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      dirtyX = s.x;
      dirtyY = s.y;
      dirtyWidth = s.width;
      dirtyHeight = s.height;
    }

    // Track the dirty region so the stroke is properly saved
    this.board.expandDirtyRect(user, dirtyX, dirtyY, dirtyWidth, dirtyHeight, layerIdx);

    // Store affected tiles in the stroke record for undo
    const tt = this.board.tileTracker;
    if (tt && active.affectedTiles) {
      const tileIndices = tt.getTileIndicesForRect(dirtyX, dirtyY, dirtyWidth, dirtyHeight);
      for (const idx of tileIndices) {
        active.affectedTiles.add(idx);
      }
    }

    lm.commitUserStroke(layerIdx, user.id);
    this.board.compositeAllLayers();

    // Add tile ownership for visible stamped tiles (after composite)
    this.board.addOccupancyForVisibleTilesInRect(user.id, dirtyX, dirtyY, dirtyWidth, dirtyHeight);

    // Keep selection active — redraw floating selection on user's overlay layer
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawFloatingSelection(user);
  }

  handleSelectionFlip(user) {
    if (!user.floatingCanvas || !user.selection) return;

    // Create a temporary canvas for the flipped image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = user.floatingCanvas.width;
    tempCanvas.height = user.floatingCanvas.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Flip horizontally by scaling -1 on x-axis
    tempCtx.save();
    tempCtx.translate(tempCanvas.width, 0);
    tempCtx.scale(-1, 1);
    tempCtx.drawImage(user.floatingCanvas, 0, 0);
    tempCtx.restore();

    // Replace the floating canvas with the flipped version
    user.floatingCanvas = tempCanvas;
    user.floatingCtx = tempCtx;

    // If there are original corners (for transforms), flip them horizontally
    if (user.originalCorners) {
      const width = user.floatingCanvas.width;
      // Swap left and right corners and flip their x positions
      const temp = {
        tl: { ...user.originalCorners.tl },
        tr: { ...user.originalCorners.tr },
        bl: { ...user.originalCorners.bl },
        br: { ...user.originalCorners.br }
      };

      // Flip x coordinates and swap left/right
      user.originalCorners.tl = { x: width - temp.tr.x, y: temp.tr.y };
      user.originalCorners.tr = { x: width - temp.tl.x, y: temp.tl.y };
      user.originalCorners.bl = { x: width - temp.br.x, y: temp.br.y };
      user.originalCorners.br = { x: width - temp.bl.x, y: temp.bl.y };
    }

    // Invalidate cached preview since the source image changed
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;

    // Redraw the selection with flipped content
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawFloatingSelection(user);
  }

  handleSelectionCancel(user) {
    if (!user.floatingCanvas || !user.selection || !user.originalSelectionPos) return;

    // Restore the lifted pixels back to the layer at their original position
    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;

    // If we have accurate restore data (layer snapshots), use that.
    // Otherwise fall back to drawing the floating canvas back.
    if (user._selectionRestoreData) {
      for (const { groupIdx, canvas, x, y } of user._selectionRestoreData.snapshots) {
        const group = lm.layerGroups[groupIdx];
        if (group) {
          group.baseCtx.drawImage(canvas, x, y);
        }
      }
    } else {
      lm.beginUserStroke(layerIdx, user.id, 'source-over');
      const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
      if (active) {
        active.ctx.drawImage(user.floatingCanvas, user.originalSelectionPos.x, user.originalSelectionPos.y);
        lm.commitUserStroke(layerIdx, user.id);
      }
    }

    this.board.activeSelectionLayer = -1;
    this.board.compositeAllLayers();
    this._cleanupUserSelection(user);
  }

  handleSelectionToBrush(user, brushDataJson) {
    // This is mostly informational - the brush data is being set on the remote user
    // The actual brush will be loaded when they receive the GMP message
    // This handler exists for consistency but may not need implementation
    console.log(`User ${user.username} converted selection to brush`);
  }

  handleImagePaste(user, data) {
    const { x, y, width, height, imageData } = data;

    // Clear any existing selection state for this user
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.pendingSelection = null;
    user.pendingLassoPath = null;

    // Create floating canvas for the pasted image
    user.floatingCanvas = document.createElement('canvas');
    user.floatingCanvas.width = width;
    user.floatingCanvas.height = height;
    user.floatingCtx = user.floatingCanvas.getContext('2d');

    // Set up selection state synchronously so that a replayed SEL_MOVE (e.g. on join)
    // can apply the current transform corners before the image finishes loading.
    user.selection = { x, y, width, height };
    user.selectionCorners = {
      tl: { x, y },
      tr: { x: x + width, y },
      bl: { x, y: y + height },
      br: { x: x + width, y: y + height }
    };
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: width, y: 0 },
      bl: { x: 0, y: height },
      br: { x: width, y: height }
    };
    user.originalSelectionPos = { x: -1, y: -1 }; // Pasted content is "moved"

    // Create reusable homography instances for this user's selection
    user.homography = new Homography('projective');
    user.previewHomography = new Homography('projective');

    // Activate split-composite mode for the pasted floating selection
    this.board.activeSelectionLayer = user.activeLayer ?? 0;

    // Load the image and draw once ready — by then SEL_MOVE may have already updated
    // selectionCorners, so drawFloatingSelection will render at the correct position.
    const img = new Image();
    img.onload = () => {
      user.floatingCtx.drawImage(img, 0, 0);
      // A SEL_MOVE replay may have already run _regeneratePreviewCache on the empty
      // canvas, producing a stale (blank) cached preview. Invalidate and rebuild now
      // that the actual image data is available.
      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
      if (this.hasTransformedCorners(user)) {
        this._regeneratePreviewCache(user);
      }
      this.drawFloatingSelection(user);
      this.startRemoteSelectionAnimation();
    };
    img.src = imageData;
  }

  /**
   * Reset all selection-related state on a user object and clear their overlay canvas.
   */
  _cleanupUserSelection(user) {
    // Cancel idle timer
    if (user._selectionIdleTimer) {
      clearTimeout(user._selectionIdleTimer);
      user._selectionIdleTimer = null;
    }
    user._selectionMoving = false;

    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.selection = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.originalSelectionPos = null;
    user.lassoPath = null;
    user.homography = null;
    user.previewHomography = null;
    user._selectionRestoreData = null;
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;
  }

  hasTransformedCorners(user) {
    if (!user.selectionCorners || !user.selection) return false;

    const s = user.selection;
    const c = user.selectionCorners;
    const tolerance = 0.5;

    return (
      Math.abs(c.tl.x - s.x) > tolerance ||
      Math.abs(c.tl.y - s.y) > tolerance ||
      Math.abs(c.tr.x - (s.x + s.width)) > tolerance ||
      Math.abs(c.tr.y - s.y) > tolerance ||
      Math.abs(c.bl.x - s.x) > tolerance ||
      Math.abs(c.bl.y - (s.y + s.height)) > tolerance ||
      Math.abs(c.br.x - (s.x + s.width)) > tolerance ||
      Math.abs(c.br.y - (s.y + s.height)) > tolerance
    );
  }

  /**
   * Regenerate the cached preview canvas for transformed selections.
   * This expensive operation is only done when corners change, not every frame.
   * @private
   */
  _regeneratePreviewCache(user) {
    if (!user.floatingCanvas || !user.selection || !user.selectionCorners || !user.originalCorners) return;
    if (!this.hasTransformedCorners(user)) {
      // No transform needed, clear cache
      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
      return;
    }

    try {
      // Calculate preview scale for downsampling input image (max 256px on longest side of source)
      // REMOTE USER: Stay at lower resolution to avoid hitching the observer's frame rate.
      const srcMaxDim = Math.max(user.floatingCanvas.width, user.floatingCanvas.height);
      const previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;

      // Reuse or create preview homography instance
      if (!user.previewHomography) {
        user.previewHomography = new Homography('projective');
      }

      const result = performHomographyTransform({
        sourceCanvas: user.floatingCanvas,
        sourceCorners: user.originalCorners,
        destCorners: user.selectionCorners,
        scale: previewScale,
        homographyInstance: user.previewHomography
      });

      if (result) {
        // Create/reuse cached canvas
        if (!user._cachedPreviewCanvas) {
          user._cachedPreviewCanvas = document.createElement('canvas');
        }
        user._cachedPreviewCanvas.width = result.imageData.width;
        user._cachedPreviewCanvas.height = result.imageData.height;
        const cacheCtx = user._cachedPreviewCanvas.getContext('2d');
        cacheCtx.putImageData(result.imageData, 0, 0);

        // Calculate FULL SIZE bounds for drawing the preview scaled up
        const fullBounds = calculateCornerBounds(user.selectionCorners);

        // Store bounds for drawing
        user._cachedPreviewBounds = {
          minX: fullBounds.minX,
          minY: fullBounds.minY,
          width: fullBounds.width,
          height: fullBounds.height
        };
      } else {
        user._cachedPreviewCanvas = null;
        user._cachedPreviewBounds = null;
      }
    } catch (e) {
      console.warn('Remote preview cache generation failed:', e);
      user._cachedPreviewCanvas = null;
      user._cachedPreviewBounds = null;
    }
  }

  drawFloatingSelection(user) {
    if (!user.floatingCanvas || !user.selection) return;

    const ctx = user.context;
    const s = user.selection;
    const c = user.selectionCorners;

    // Check if we need to use cached transform preview
    if (c && user.originalCorners && this.hasTransformedCorners(user)) {
      // Use cached preview canvas if available
      if (user._cachedPreviewCanvas && user._cachedPreviewBounds) {
        const bounds = user._cachedPreviewBounds;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(user._cachedPreviewCanvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
      } else {
        // Fallback: regenerate if cache missing (shouldn't happen)
        this._regeneratePreviewCache(user);
        if (user._cachedPreviewCanvas && user._cachedPreviewBounds) {
          const bounds = user._cachedPreviewBounds;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'low';
          ctx.drawImage(user._cachedPreviewCanvas, bounds.minX, bounds.minY, bounds.width, bounds.height);
        } else {
          // Final fallback
          ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      }
    } else {
      // No transform, simple draw at current position
      ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Draw animated marching ants border
    if (c) {
      // Determine if we should show lasso outline or quadrilateral
      const shouldShowLassoOutline =
        user.lassoPath &&
        user.lassoPath.length >= 3 &&
        !this.hasTransformedCorners(user);

      if (shouldShowLassoOutline) {
        // Draw lasso polygon outline (matches local SelectTool.drawMarchingAntsOnly pattern)
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        // Black dashes
        ctx.strokeStyle = '#000';
        ctx.lineDashOffset = -this.remoteSelectionOffset;
        ctx.beginPath();
        ctx.moveTo(user.lassoPath[0].x, user.lassoPath[0].y);
        for (let i = 1; i < user.lassoPath.length; i++) {
          ctx.lineTo(user.lassoPath[i].x, user.lassoPath[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        // White dashes (offset for marching effect)
        ctx.strokeStyle = '#fff';
        ctx.lineDashOffset = -this.remoteSelectionOffset + 4;
        ctx.beginPath();
        ctx.moveTo(user.lassoPath[0].x, user.lassoPath[0].y);
        for (let i = 1; i < user.lassoPath.length; i++) {
          ctx.lineTo(user.lassoPath[i].x, user.lassoPath[i].y);
        }
        ctx.closePath();
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      } else {
        // Draw quadrilateral outline (existing code for rectangle/transformed selections)
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        // Black dashes
        ctx.strokeStyle = '#000';
        ctx.lineDashOffset = -this.remoteSelectionOffset;
        ctx.beginPath();
        ctx.moveTo(c.tl.x, c.tl.y);
        ctx.lineTo(c.tr.x, c.tr.y);
        ctx.lineTo(c.br.x, c.br.y);
        ctx.lineTo(c.bl.x, c.bl.y);
        ctx.closePath();
        ctx.stroke();

        // White dashes (offset to create marching effect)
        ctx.strokeStyle = '#fff';
        ctx.lineDashOffset = -this.remoteSelectionOffset + 4;
        ctx.beginPath();
        ctx.moveTo(c.tl.x, c.tl.y);
        ctx.lineTo(c.tr.x, c.tr.y);
        ctx.lineTo(c.br.x, c.br.y);
        ctx.lineTo(c.bl.x, c.bl.y);
        ctx.closePath();
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
    }
  }

  drawPendingSelection(user) {
    if (!user.pendingSelection) return;

    const ctx = user.context;
    const s = user.pendingSelection;

    // Check if we have a lasso path to draw
    if (user.pendingLassoPath && user.pendingLassoPath.length >= 2) {
      // Draw lasso polygon outline
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      // Black dashes with animated offset
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.remoteSelectionOffset;
      ctx.beginPath();
      ctx.moveTo(user.pendingLassoPath[0].x, user.pendingLassoPath[0].y);
      for (let i = 1; i < user.pendingLassoPath.length; i++) {
        ctx.lineTo(user.pendingLassoPath[i].x, user.pendingLassoPath[i].y);
      }
      ctx.closePath();
      ctx.stroke();

      // White dashes offset to create marching effect
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.remoteSelectionOffset + 4;
      ctx.beginPath();
      ctx.moveTo(user.pendingLassoPath[0].x, user.pendingLassoPath[0].y);
      for (let i = 1; i < user.pendingLassoPath.length; i++) {
        ctx.lineTo(user.pendingLassoPath[i].x, user.pendingLassoPath[i].y);
      }
      ctx.closePath();
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    } else {
      // Draw rectangle (default/rectangle mode)
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      // Black dashes with animated offset
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.remoteSelectionOffset;
      ctx.strokeRect(s.x, s.y, s.width, s.height);

      // White dashes offset to create marching effect
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = -this.remoteSelectionOffset + 4;
      ctx.strokeRect(s.x, s.y, s.width, s.height);

      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }

  /**
   * Erase a selection region directly from the layer manager using a destination-out stroke.
   * This correctly handles content in both baked sequences and the stroke stack.
   * @param {Object} s - Selection bounds {x, y, width, height}
   * @param {number} layerIdx - Layer group index
   * @param {Array<{x,y}>|null} lassoPath - Lasso polygon, or null for rectangle erase
   * @param {number} userId - ID of the user performing the erase
   */
  _eraseSelectionFromLayer(s, layerIdx, lassoPath, userId) {
    const lm = this.board.layerManager;
    if (!lm) return null;

    const group = lm.layerGroups[layerIdx];
    if (!group) return null;

    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = lm.width;
    layerCanvas.height = lm.height;
    const layerCtx = layerCanvas.getContext('2d');
    lm._compositeGroupInto(layerCtx, group);

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

    const snapshots = [{ groupIdx: layerIdx, canvas: snap, x: s.x, y: s.y }];

    lm.beginUserStroke(layerIdx, userId, 'destination-out');
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(userId);
    if (!active) return null;

    const ctx = active.ctx;

    // Ensure integer coordinates for consistent erasing
    let ix = Math.floor(s.x);
    let iy = Math.floor(s.y);
    let iw = Math.ceil(s.x + s.width) - ix;
    let ih = Math.ceil(s.y + s.height) - iy;

    if (lassoPath && lassoPath.length >= 3) {
      // Recalculate bounds from path to ensure dirty rect covers the entire shape
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of lassoPath) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      ix = Math.floor(minX);
      iy = Math.floor(minY);
      iw = Math.ceil(maxX) - ix;
      ih = Math.ceil(maxY) - iy;

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
      ctx.fillRect(ix, iy, iw, ih);
    }

    // Track the dirty region so the erase stroke is properly saved
    const user = this.getUsersMap().get(userId);
    this.board.expandDirtyRect(user, ix, iy, iw, ih);

    // Commit the stroke. Selection erasures are usually atomic/independent for remote users.
    lm.commitUserStroke(layerIdx, userId, {
      isSelectionErase: true
    });

    lm.needsComposite = true;
    this.board.compositeAllLayers();

    return {
      snapshots,
      eraseS: { ...s },
      eraseLassoPath: lassoPath ? lassoPath.map(p => ({ ...p })) : null
    };
  }
}
