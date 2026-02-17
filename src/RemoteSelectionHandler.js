import { Homography } from './utils/homography.js';
import { pointInHull } from './sync/ConvexHull.js';

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
            // Redraw this user's selection with updated offset
            user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
            if (user.floatingCanvas && user.selection) {
              this.drawFloatingSelection(user);
            } else if (user.pendingSelection) {
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

    // Copy selected region from main canvas
    const imageData = this.board.mainCtx.getImageData(s.x, s.y, s.width, s.height);

    // Apply lasso mask if path provided (preserves concave selections)
    if (lassoPath && lassoPath.length >= 3) {
      this.applyLassoMask(imageData, s.x, s.y, lassoPath);
      user.lassoPath = lassoPath; // Store for potential later use
    }

    user.floatingCtx.putImageData(imageData, 0, 0);

    // Clear the region on main canvas - use lasso path as clip if available
    if (lassoPath && lassoPath.length >= 3) {
      // Use lasso path as clipping mask to only clear the selected area
      this.board.mainCtx.save();
      this.board.mainCtx.beginPath();
      this.board.mainCtx.moveTo(lassoPath[0].x, lassoPath[0].y);
      for (let i = 1; i < lassoPath.length; i++) {
        this.board.mainCtx.lineTo(lassoPath[i].x, lassoPath[i].y);
      }
      this.board.mainCtx.closePath();
      this.board.mainCtx.clip();
      this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);
      this.board.mainCtx.restore();
    } else {
      // Rectangle mode - clear the entire selection
      this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);
    }

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
   * Apply lasso mask to ImageData - sets alpha to 0 for pixels outside lasso path
   * @param {ImageData} imageData - The image data to mask
   * @param {number} offsetX - X offset of imageData relative to canvas
   * @param {number} offsetY - Y offset of imageData relative to canvas
   * @param {Array<{x: number, y: number}>} lassoPath - The lasso polygon
   */
  applyLassoMask(imageData, offsetX, offsetY, lassoPath) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const canvasX = x + offsetX;
        const canvasY = y + offsetY;

        // Check if this pixel is inside the lasso path (pointInHull uses winding number algorithm)
        if (!pointInHull({ x: canvasX, y: canvasY }, lassoPath)) {
          // Set alpha to 0 for pixels outside the lasso
          const idx = (y * width + x) * 4;
          data[idx + 3] = 0; // Alpha channel
        }
      }
    }
  }

  handleSelectionMove(user, corners) {
    if (!user.floatingCanvas || !user.selection) return;

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

    // Ensure animation loop is running to render updates at 60fps
    // (This eliminates flicker by avoiding double-rendering)
    this.startRemoteSelectionAnimation();
  }

  handleSelectionCommit(user) {
    if (!user.floatingCanvas || !user.selection) return;

    const s = user.selection;
    const c = user.selectionCorners;

    // Check if transform was applied (corners moved from axis-aligned rectangle)
    const hasTransform = this.hasTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      // Apply homography transform using reused instance
      try {
        // Reuse or create homography instance for full-resolution commit
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

        // Warp at full resolution
        const result = user.homography.warp();
        if (result) {
          // Use tempCanvas to avoid putImageData overwriting transparent pixels
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = result.width;
          tempCanvas.height = result.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.putImageData(result, 0, 0);
          this.board.mainCtx.globalCompositeOperation = 'source-over';
          this.board.mainCtx.drawImage(tempCanvas, minX, minY);
        } else {
          // Fallback
          this.board.mainCtx.globalCompositeOperation = 'source-over';
          this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote homography failed:', e);
        this.board.mainCtx.globalCompositeOperation = 'source-over';
        this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      // Simple draw without transform
      this.board.mainCtx.globalCompositeOperation = 'source-over';
      this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Cleanup user selection state
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.selection = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.lassoPath = null;
    // Clear homography instances
    user.homography = null;
    user.previewHomography = null;
  }

  handleSelectionDelete(user) {
    // Use selection if available, otherwise fall back to pendingSelection
    // (Fill/Delete can be called before sel_lift when selection hasn't been moved)
    const s = user.selection || user.pendingSelection;
    if (!s) return;

    // If floating, just clear it; otherwise clear on main canvas
    if (user.floatingCanvas) {
      user.floatingCanvas = null;
      user.floatingCtx = null;
    } else {
      this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);
    }

    // Clear user selection state
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.selection = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.lassoPath = null;
    // Clear homography instances
    user.homography = null;
    user.previewHomography = null;
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
    // Same as commit but don't clear floating canvas
    if (!user.floatingCanvas || !user.selection) return;

    const s = user.selection;
    const c = user.selectionCorners;

    // Check if transform was applied
    const hasTransform = this.hasTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      try {
        // Reuse or create homography instance for full-resolution stamp
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

        // Warp at full resolution
        const result = user.homography.warp();
        if (result) {
          // Use tempCanvas to avoid putImageData overwriting transparent pixels
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = result.width;
          tempCanvas.height = result.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.putImageData(result, 0, 0);
          this.board.mainCtx.globalCompositeOperation = 'source-over';
          this.board.mainCtx.drawImage(tempCanvas, minX, minY);
        } else {
          this.board.mainCtx.globalCompositeOperation = 'source-over';
          this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote stamp homography failed:', e);
        this.board.mainCtx.globalCompositeOperation = 'source-over';
        this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      this.board.mainCtx.globalCompositeOperation = 'source-over';
      this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Keep selection active (don't cleanup like commit does)
    // Redraw floating selection on user's layer
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawFloatingSelection(user);
  }

  handleSelectionCancel(user) {
    if (!user.floatingCanvas || !user.selection || !user.originalSelectionPos) return;

    // Restore selection to original position on main canvas
    this.board.mainCtx.globalCompositeOperation = 'source-over';
    this.board.mainCtx.drawImage(
      user.floatingCanvas,
      user.originalSelectionPos.x,
      user.originalSelectionPos.y
    );

    // Clear user selection state
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.selection = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.originalSelectionPos = null;
    user.lassoPath = null;
    // Clear homography instances
    user.homography = null;
    user.previewHomography = null;
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

      // Draw the floating selection
      this.drawFloatingSelection(user);
    };
    img.src = imageData;
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

  drawFloatingSelection(user) {
    if (!user.floatingCanvas || !user.selection) return;

    const ctx = user.context;
    const s = user.selection;
    const c = user.selectionCorners;

    // Check if we need to apply homography transform
    if (c && user.originalCorners && this.hasTransformedCorners(user)) {
      try {
        // Calculate output bounds
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
          // Create temporary canvas to hold the ImageData
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = result.width;
          tempCanvas.height = result.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.putImageData(result, 0, 0);

          // Draw scaled up to full output size
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'low';
          ctx.drawImage(tempCanvas, minX, minY, outputWidth, outputHeight);
        } else {
          // Fallback to simple draw
          ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote homography preview failed:', e);
        ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
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
}
