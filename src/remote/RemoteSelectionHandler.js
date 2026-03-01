import { Homography } from '../utils/homography.js';

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

    // Update selection bounds from corners
    const c = corners;
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
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

  handleSelectionCommit(user) {
    if (!user.floatingCanvas || !user.selection) return;

    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;
    const s = user.selection;
    const c = user.selectionCorners;

    // Begin a stroke on the remote user's active layer so the committed pixels
    // enter the layer system and persist through compositeAllLayers() calls.
    lm.beginUserStroke(layerIdx, user.id, 'source-over');
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
    if (!active) {
      this._cleanupUserSelection(user);
      return;
    }

    // Check if transform was applied (corners moved from axis-aligned rectangle)
    const hasTransform = this.hasTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      try {
        if (!user.homography) {
          user.homography = new Homography('projective');
        }

        const srcPoints = [
          [user.originalCorners.tl.x, user.originalCorners.tl.y],
          [user.originalCorners.tr.x, user.originalCorners.tr.y],
          [user.originalCorners.bl.x, user.originalCorners.bl.y],
          [user.originalCorners.br.x, user.originalCorners.br.y]
        ];

        const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
        const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

        const dstPoints = [
          [c.tl.x - minX, c.tl.y - minY],
          [c.tr.x - minX, c.tr.y - minY],
          [c.bl.x - minX, c.bl.y - minY],
          [c.br.x - minX, c.br.y - minY]
        ];

        user.homography.setSourcePoints(srcPoints, user.floatingCanvas);
        user.homography.setDestinyPoints(dstPoints);

        const result = user.homography.warp();
        if (result) {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = result.width;
          tempCanvas.height = result.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.putImageData(result, 0, 0);
          active.ctx.drawImage(tempCanvas, minX, minY);
        } else {
          active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote homography failed:', e);
        active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Pass the restore data captured during lift so Board.undo can reverse the erase
    lm.commitUserStroke(layerIdx, user.id, { selectionRestoreData: user._selectionRestoreData });
    this.board.activeSelectionLayer = -1;
    this.board.requestUpdate();
    this._cleanupUserSelection(user);
  }

  handleSelectionDelete(user) {
    // Use selection if available, otherwise fall back to pendingSelection
    // (Fill/Delete can be called before sel_lift when selection hasn't been moved)
    const s = user.selection || user.pendingSelection;
    if (!s) return;

    // If floating the pixels were already erased from the layer on lift — just
    // discard the floating canvas. Otherwise erase directly from the layer now.
    if (!user.floatingCanvas) {
      this._eraseSelectionFromLayer(
        s,
        user.activeLayer ?? 0,
        user.pendingLassoPath && user.pendingLassoPath.length >= 3 ? user.pendingLassoPath : null,
        user.id
      );
    }

    this.board.activeSelectionLayer = -1;
    this._cleanupUserSelection(user);
  }

  handleSelectionFill(user, color) {
    // Use selection if available, otherwise fall back to pendingSelection
    // (Fill can be called before sel_lift when selection hasn't been moved)
    const s = user.selection || user.pendingSelection;
    if (!s) return;
    const colorString = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;

    // If floating, fill the floating canvas
    if (user.floatingCanvas && user.floatingCtx) {
      user.floatingCtx.fillStyle = colorString;
      user.floatingCtx.fillRect(0, 0, s.width, s.height);

      // Redraw on user's layer
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      user.context.drawImage(user.floatingCanvas, s.x, s.y);
    } else {
      // Fill directly on main canvas
      this.board.mainCtx.globalCompositeOperation = 'source-over';
      this.board.mainCtx.fillStyle = colorString;
      this.board.mainCtx.fillRect(s.x, s.y, s.width, s.height);
    }
  }

  handleSelectionStamp(user) {
    // Same as commit but keep floating canvas active for further moves/stamps
    if (!user.floatingCanvas || !user.selection) return;

    const lm = this.board.layerManager;
    const layerIdx = user.activeLayer ?? 0;
    const s = user.selection;
    const c = user.selectionCorners;

    lm.beginUserStroke(layerIdx, user.id, 'source-over');
    const active = lm.layerGroups[layerIdx]?.activeStrokeByUser.get(user.id);
    if (!active) return;

    const hasTransform = this.hasTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      try {
        if (!user.homography) {
          user.homography = new Homography('projective');
        }

        const srcPoints = [
          [user.originalCorners.tl.x, user.originalCorners.tl.y],
          [user.originalCorners.tr.x, user.originalCorners.tr.y],
          [user.originalCorners.bl.x, user.originalCorners.bl.y],
          [user.originalCorners.br.x, user.originalCorners.br.y]
        ];

        const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
        const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

        const dstPoints = [
          [c.tl.x - minX, c.tl.y - minY],
          [c.tr.x - minX, c.tr.y - minY],
          [c.bl.x - minX, c.bl.y - minY],
          [c.br.x - minX, c.br.y - minY]
        ];

        user.homography.setSourcePoints(srcPoints, user.floatingCanvas);
        user.homography.setDestinyPoints(dstPoints);

        const result = user.homography.warp();
        if (result) {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = result.width;
          tempCanvas.height = result.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.putImageData(result, 0, 0);
          active.ctx.drawImage(tempCanvas, minX, minY);
        } else {
          active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote stamp homography failed:', e);
        active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      active.ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    lm.commitUserStroke(layerIdx, user.id);
    this.board.requestUpdate();

    // Keep selection active — redraw floating selection on user's overlay layer
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
    this.board.requestUpdate();
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

    // Load the image from data URL
    const img = new Image();
    img.onload = () => {
      user.floatingCtx.drawImage(img, 0, 0);

      // Set up selection state
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

      // Draw the floating selection
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
      const c = user.selectionCorners;
      const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
      const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
      const outputWidth = maxX - minX;
      const outputHeight = maxY - minY;

      // Calculate preview scale for downsampling input image (max 256px on longest side of source)
      const srcMaxDim = Math.max(user.floatingCanvas.width, user.floatingCanvas.height);
      const previewScale = srcMaxDim > this.previewMaxSize ? this.previewMaxSize / srcMaxDim : 1;
      const previewSrcWidth = Math.max(1, Math.round(user.floatingCanvas.width * previewScale));
      const previewSrcHeight = Math.max(1, Math.round(user.floatingCanvas.height * previewScale));

      // Reuse or create preview homography instance
      if (!user.previewHomography) {
        user.previewHomography = new Homography('projective');
      }

      // Source points scaled for the downsampled input image
      const srcPoints = [
        [user.originalCorners.tl.x * previewScale, user.originalCorners.tl.y * previewScale],
        [user.originalCorners.tr.x * previewScale, user.originalCorners.tr.y * previewScale],
        [user.originalCorners.bl.x * previewScale, user.originalCorners.bl.y * previewScale],
        [user.originalCorners.br.x * previewScale, user.originalCorners.br.y * previewScale]
      ];

      // Destination points scaled down proportionally
      const dstPoints = [
        [(c.tl.x - minX) * previewScale, (c.tl.y - minY) * previewScale],
        [(c.tr.x - minX) * previewScale, (c.tr.y - minY) * previewScale],
        [(c.bl.x - minX) * previewScale, (c.bl.y - minY) * previewScale],
        [(c.br.x - minX) * previewScale, (c.br.y - minY) * previewScale]
      ];

      // Set up homography with downscaled source image
      user.previewHomography.setSourcePoints(srcPoints, user.floatingCanvas, previewSrcWidth, previewSrcHeight);
      user.previewHomography.setDestinyPoints(dstPoints);

      const result = user.previewHomography.warp();
      if (result) {
        // Create/reuse cached canvas
        if (!user._cachedPreviewCanvas) {
          user._cachedPreviewCanvas = document.createElement('canvas');
        }
        user._cachedPreviewCanvas.width = result.width;
        user._cachedPreviewCanvas.height = result.height;
        const cacheCtx = user._cachedPreviewCanvas.getContext('2d');
        cacheCtx.putImageData(result, 0, 0);

        // Store bounds for drawing
        user._cachedPreviewBounds = {
          minX,
          minY,
          width: outputWidth,
          height: outputHeight
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

    // 1. Snapshot the selection area BEFORE erasing (for undo/cancel)
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

    // 2. Apply the erase as a committed stroke
    lm.beginUserStroke(layerIdx, userId, 'destination-out');
    const ctx = lm.getUserStrokeContext(layerIdx, userId);
    
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
      ctx.fillRect(s.x, s.y, s.width, s.height);
    }

    // Commit the stroke. Selection erasures are usually atomic/independent for remote users.
    lm.commitUserStroke(layerIdx, userId, { 
      isSelectionErase: true
    });

    lm.needsComposite = true;
    this.board.requestUpdate();

    return {
      snapshots,
      eraseS: { ...s },
      eraseLassoPath: lassoPath ? lassoPath.map(p => ({ ...p })) : null
    };
  }
}
