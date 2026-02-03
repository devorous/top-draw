import { mirrorLine } from './utils/drawing.js';
import { Homography } from './utils/homography.js';
import { SELECTION_MODES, getNextBrushIndex } from './utils/parseGimp.js';

/**
 * Handles all remote user drawing synchronization
 */
export class RemoteUserHandler {
  constructor(app) {
    this.app = app;
    this.remoteSelectionAnimationId = null;
    this.remoteSelectionOffset = 0;

    // Preview downscaling settings (same as SelectTool)
    this.previewMaxSize = 256; // Max dimension for preview warps
  }

  get board() { return this.app.board; }
  get toolManager() { return this.app.toolManager; }
  get ui() { return this.app.ui; }
  get users() { return this.app.users; }
  get sessionIndex() { return this.app.sessionIndex; }
  get debugOverlay() { return this.app.debugOverlay; }

  /**
   * Start the animation loop for remote user selections
   */
  startRemoteSelectionAnimation() {
    if (this.remoteSelectionAnimationId) return;

    const animate = () => {
      this.remoteSelectionOffset = (this.remoteSelectionOffset + 1) % 16;

      // Check if any remote user has a selection that needs animating
      let hasActiveSelection = false;
      if (this.users) {
        for (const [id, user] of this.users.entries()) {
          // Skip local user
          if (id === this.sessionIndex) continue;

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

  handleMouseMove(user, data) {
    const points = data.ps;
    if (!points || points.length < 2) return;

    // Process each point in the batch
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i];
      const y = points[i + 1];

      if (user.lastx === null) {
        user.lastx = x;
        user.lasty = y;
      }

      const lastPos = { x: user.x, y: user.y };
      user.setPosition(x, y);
      const pos = { x: user.x, y: user.y };

      // Track drawing point for debug overlay
      if (!user.panning && user.mousedown && this.debugOverlay) {
        this.debugOverlay.addDrawingPoint(pos.x, pos.y, user.size, user.id);

        // Debug: Track each point received for remote user
        this.debugOverlay.addStrokePoint(user.id, pos.x, pos.y, 'mouseMove');
      }

      if (!user.panning && user.mousedown) {
        switch (user.tool) {
          case 'brush':
            user.addToLine(pos);
            if (user.pressure !== user.prevpressure) {
              this.commitLine(user);
            }
            user.prevpressure = user.pressure;
            break;

          case 'erase':
            const eraserTool = this.toolManager.getTool('erase');
            eraserTool.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2);
            if (this.board.mirror) {
              const w = this.board.getWidth();
              eraserTool.erase(w - pos.x, pos.y, w - lastPos.x, lastPos.y, user.pressure * user.size * 2);
            }
            break;

          case 'imageBrush':
            if (user.imageBrush) {
              this.toolManager.getTool('imageBrush').draw(user, pos);
            }
            break;

          case 'flowPen':
            this.handlePenMove(user, pos);
            break;

          case 'line':
          case 'rectangle':
          case 'circle':
          case 'select':
            // Shape tools only need the final position, skip intermediate points
            break;
        }
      }

      user.lastx = x;
      user.lasty = y;
    }

    // After processing all points, update cursor and handle shape tools with final position
    const finalX = points[points.length - 2];
    const finalY = points[points.length - 1];
    this.ui.updateRemoteCursor(user.id, finalX, finalY, user.size);

    if (!user.panning && user.mousedown) {
      const pos = { x: finalX, y: finalY };

      // Shape tools and eraser need their preview canvas cleared
      const needsClear = ['line', 'rectangle', 'circle', 'select', 'erase'].includes(user.tool);
      if (needsClear) {
        user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      }

      switch (user.tool) {
        case 'brush':
          // Redraw the accumulated line on preview canvas
          user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          this.drawLineArray(user.currentLine, user.context, user);
          if (this.board.mirror) {
            const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
            this.drawLineArray(mirrored, user.context, user);
          }
          break;

        case 'line':
          this.toolManager.getTool('line').drawPreview(user.context, user, user.startPos, pos);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.toolManager.getTool('line').drawPreview(user.context, user,
              { x: w - user.startPos.x, y: user.startPos.y },
              { x: w - pos.x, y: pos.y }
            );
          }
          break;

        case 'rectangle':
          this.toolManager.getTool('rectangle').drawRect(user.context, user, user.startPos, pos);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.toolManager.getTool('rectangle').drawRect(user.context, user,
              { x: w - user.startPos.x, y: user.startPos.y },
              { x: w - pos.x, y: pos.y }
            );
          }
          break;

        case 'circle':
          this.toolManager.getTool('circle').drawEllipse(user.context, user, user.startPos, pos);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.toolManager.getTool('circle').drawEllipse(user.context, user,
              { x: w - user.startPos.x, y: user.startPos.y },
              { x: w - pos.x, y: pos.y }
            );
          }
          break;

        case 'select':
          if (!user.floatingCanvas && user.startPos) {
            const selectTool = this.toolManager.getTool('select');
            selectTool.drawSelectionBox(user.context, user.startPos, pos);
          }
          break;
      }
    }
  }

  handleMouseDown(user) {
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;
    user.mousedown = true;
    user._mainCtxDrawCount = 0; // Reset draw counter for this stroke

    const pos = { x: user.x, y: user.y };
    // Essential for all shape tools and selection
    user.startPos = pos;

    // Track region for debug overlay (if not panning)
    if (!user.panning && this.debugOverlay) {
      this.debugOverlay.startDrawing(pos.x, pos.y, user.tool, user.size, user.id, user.username);

      // Debug: Start tracking stroke points for remote user
      this.debugOverlay.startStrokeTracking(user.id, false);
      this.debugOverlay.addStrokePoint(user.id, pos.x, pos.y, 'mouseDown');
    }

    switch (user.tool) {
      case 'brush':
        if (!user.panning) {
          // Add point twice (like local BrushTool) so single-click draws a dot
          user.addToLine(pos);
          user.addToLine(pos);
        }
        break;

      case 'flowPen':
        this.handlePenDown(user, pos);
        break;

      case 'erase':
        if (!user.panning) {
          const eraserTool = this.toolManager.getTool('erase');
          eraserTool.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2);
        }
        break;

      case 'text':
        if (user.text) {
          this.toolManager.getTool('text').drawText(user);
          user.text = '';
          this.ui.updateRemoteText(user.id, '');
        }
        break;

      case 'imageBrush':
        if (user.imageBrush && !user.panning) {
          // Reset GIH brush dimensions on new stroke (like local ImageBrushTool.onPointerDown)
          if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
            user.imageBrush.reset();
          }
          this.toolManager.getTool('imageBrush').draw(user, pos);
        }
        break;

      case 'line':
      case 'rectangle':
      case 'circle':
        // These tools primarily use startPos, which we set above.
        break;

      case 'select':
        // If starting a new selection OUTSIDE pending selection, clear it
        // If clicking inside, sel_lift will handle the transition
        if (user.pendingSelection && !user.floatingCanvas) {
          const s = user.pendingSelection;
          const clickedInside = pos.x >= s.x && pos.x <= s.x + s.width &&
                                pos.y >= s.y && pos.y <= s.y + s.height;
          if (!clickedInside) {
            user.pendingSelection = null;
            user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          }
        }
        break;
    }
  }

  handleMouseUp(user) {
    const pos = { x: user.x, y: user.y };
    const mainCtx = this.board.mainCtx;

    // Pen tool needs to composite user.context BEFORE clearing it
    if (user.tool === 'flowPen') {
      this.handlePenUp(user);
    }

    // Clear preview canvas FIRST to prevent composite boldness
    // (otherwise both preview and mainCtx briefly show the same line)
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    switch (user.tool) {
      case 'brush':
        if (!user.panning) {
          this.drawLineArray(user.currentLine, mainCtx, user);
          if (this.board.mirror) {
            const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
            this.drawLineArray(mirrored, mainCtx, user);
          }
        }
        break;

      case 'flowPen':
        // Already handled above before clear
        break;

      case 'line':
        this.toolManager.getTool('line').drawPreview(mainCtx, user, user.startPos, pos);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          this.toolManager.getTool('line').drawPreview(mainCtx, user,
            { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
        }
        break;

      case 'rectangle':
        this.toolManager.getTool('rectangle').drawRect(mainCtx, user, user.startPos, pos);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          this.toolManager.getTool('rectangle').drawRect(mainCtx, user,
            { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
        }
        break;

      case 'circle':
        this.toolManager.getTool('circle').drawEllipse(mainCtx, user, user.startPos, pos);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          this.toolManager.getTool('circle').drawEllipse(mainCtx, user,
            { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
        }
        break;

      case 'select':
        // On MouseUp, the remote user has finished defining a selection area.
        // Store selection info on user (actual lift happens via sel_lift event)
        if (user.startPos) {
          const x = Math.min(user.startPos.x, pos.x);
          const y = Math.min(user.startPos.y, pos.y);
          const width = Math.abs(pos.x - user.startPos.x);
          const height = Math.abs(pos.y - user.startPos.y);
          if (width >= 5 && height >= 5) {
            user.pendingSelection = { x, y, width, height };
          }
        }
        break;
    }

    // End drawing tracking for debug overlay
    if (this.debugOverlay) {
      this.debugOverlay.endDrawing(user.id);

      // Debug: End stroke tracking for remote user
      this.debugOverlay.endStrokeTracking(user.id);
    }

    // Debug: Log total mainCtx draws for this stroke
    console.log(`[DrawDebug] REMOTE user=${user.id} STROKE END - total mainCtx draws: ${user._mainCtxDrawCount || 0}`);

    // Cleanup (preview was already cleared at start of handleMouseUp)
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;

    // Redraw floating selection if user has one (persists after handle release)
    if (user.floatingCanvas && user.selection) {
      this.drawFloatingSelection(user);
    }
    // Draw pending selection rectangle if user just finished creating one
    else if (user.pendingSelection) {
      this.drawPendingSelection(user);
      // Start the selection animation loop
      this.startRemoteSelectionAnimation();
    }
  }

  handleKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key === ' ' ? '&nbsp;' : key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      if (user.text.endsWith('&nbsp;')) {
        user.text = user.text.slice(0, -6);
      } else {
        user.text = user.text.slice(0, -1);
      }
    }
    this.ui.updateRemoteText(user.id, user.text);
  }

  handleBrushLoad(user, brushDataStr) {
    // Parse JSON string from protobuf transport
    const brushData = typeof brushDataStr === 'string' ? JSON.parse(brushDataStr) : brushDataStr;

    if (brushData.type === 'gbr' || brushData.type === 'image') {
      const image = new Image();
      image.src = brushData.gimpUrl;
      brushData.image = image;
      user.imageBrush = brushData;
    } else if (brushData.type === 'gih' && brushData.gBrushes && brushData.gBrushes.length > 0) {
      const images = brushData.gBrushes.map(brush => {
        const img = new Image();
        img.src = brush.gimpUrl;
        return img;
      });
      brushData.images = images;
      brushData.index = 0;
      // Ensure ncells matches the actual number of images
      brushData.ncells = images.length;
      // Ensure cellwidth/cellheight are set (use first brush dimensions as fallback)
      if (!brushData.cellwidth && brushData.gBrushes[0]) {
        brushData.cellwidth = brushData.gBrushes[0].width || 32;
        brushData.cellheight = brushData.gBrushes[0].height || 32;
      }

      // Recreate the getNextBrush and reset functions that were lost during JSON serialization
      // These are needed for proper animation playback on remote clients
      if (brushData.dimensions && brushData.dimensions.length > 0) {
        // Reset dimension indices
        for (const dim of brushData.dimensions) {
          dim.currentIndex = 0;
        }

        // Recreate getNextBrush function using the imported helper
        brushData.getNextBrush = function(context) {
          const idx = getNextBrushIndex(this, context);
          return {
            brush: this.gBrushes[idx],
            index: idx
          };
        };

        // Recreate reset function
        brushData.reset = function() {
          for (const dim of this.dimensions) {
            dim.currentIndex = 0;
          }
        };
      }

      user.imageBrush = brushData;
    }
  }

  handleCancel(user) {
    // Cancel debug overlay tracking
    if (this.debugOverlay) {
      this.debugOverlay.cancelDrawing(user.id);
    }

    // Clear any in-progress drawing
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.pendingSelection = null;

    // Clear per-user pen state
    user.penPoints = [];
    user._penLastStampPos = null;
    user._penStrokeColor = null;
    user._penAlpha = null;
    if (user._penOffscreenCtx) {
      user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);
    }
  }

  // Selection handling

  handleSelectionLift(user, selection) {
    // Clear pending selection since it's now being lifted
    user.pendingSelection = null;

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
    user.floatingCtx.putImageData(imageData, 0, 0);

    // Clear the region on main canvas
    this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);

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

    // Draw floating selection on user's preview layer
    this.drawFloatingSelection(user);

    // Start the selection animation loop
    this.startRemoteSelectionAnimation();
  }

  handleSelectionMove(user, corners) {
    if (!user.floatingCanvas || !user.selection) return;

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

    // Clear user's layer and redraw
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawFloatingSelection(user);

    // Ensure animation is running
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
          this.board.mainCtx.drawImage(tempCanvas, minX, minY);
        } else {
          // Fallback
          this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote homography failed:', e);
        this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      // Simple draw without transform
      this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Cleanup user selection state
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.selection = null;
    user.selectionCorners = null;
    user.originalCorners = null;
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
    user.selectionCorners = null;
    user.originalCorners = null;
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
          this.board.mainCtx.drawImage(tempCanvas, minX, minY);
        } else {
          this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote stamp homography failed:', e);
        this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
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

      // Start selection animation
      this.startRemoteSelectionAnimation();
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

  drawPendingSelection(user) {
    if (!user.pendingSelection) return;

    const ctx = user.context;
    const s = user.pendingSelection;

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

  // Drawing utilities

  commitLine(user) {
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.beginPath();
    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
    user.addToLine({ x: user.x, y: user.y });
  }

  drawLineArray(points, ctx, user) {
    if (points.length === 0) return;

    // Debug: Track draws to mainCtx
    const isMainCtx = ctx === this.board.mainCtx;
    if (isMainCtx) {
      user._mainCtxDrawCount = (user._mainCtxDrawCount || 0) + 1;
      console.log(`[DrawDebug] REMOTE user=${user.id} draw #${user._mainCtxDrawCount} to mainCtx, ${points.length} points, lineWidth=${user.pressure * user.size * 2}`);
    }

    // Explicitly set ALL context properties to ensure consistency
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;

    const smoothing = user.smoothing || 0;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 1) {
      // Single point - draw a dot
      ctx.lineTo(points[0].x, points[0].y);
    } else if (points.length === 2 || smoothing === 0) {
      // Two points or no smoothing - straight lines
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    } else {
      // 3+ points with smoothing: quadratic curves with control point
      // interpolated based on smoothing level
      // smoothing=0: straight line, smoothing=1: full curve through point

      let prevX = points[0].x;
      let prevY = points[0].y;

      for (let i = 1; i < points.length; i++) {
        const curr = points[i];

        if (i < points.length - 1) {
          // Not the last point - curve to midpoint
          const next = points[i + 1];
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;

          // Interpolate control point: at smoothing=0, cp is on the line
          // at smoothing=1, cp is at the actual point
          const linearCpX = (prevX + midX) / 2;
          const linearCpY = (prevY + midY) / 2;
          const cpX = linearCpX + (curr.x - linearCpX) * smoothing;
          const cpY = linearCpY + (curr.y - linearCpY) * smoothing;

          ctx.quadraticCurveTo(cpX, cpY, midX, midY);
          prevX = midX;
          prevY = midY;
        } else {
          // Last point - curve to it
          const linearCpX = (prevX + curr.x) / 2;
          const linearCpY = (prevY + curr.y) / 2;
          const cpX = linearCpX + (curr.x - linearCpX) * smoothing;
          const cpY = linearCpY + (curr.y - linearCpY) * smoothing;

          ctx.quadraticCurveTo(cpX, cpY, curr.x, curr.y);
        }
      }
    }

    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  // Pen tool helpers - use per-user offscreen canvas to avoid opacity stacking

  ensurePenOffscreen(user) {
    const width = this.board.getWidth();
    const height = this.board.getHeight();
    if (!user._penOffscreen || user._penOffscreen.width !== width || user._penOffscreen.height !== height) {
      user._penOffscreen = document.createElement('canvas');
      user._penOffscreen.width = width;
      user._penOffscreen.height = height;
      user._penOffscreenCtx = user._penOffscreen.getContext('2d');
    }
  }

  handlePenDown(user, pos) {
    this.ensurePenOffscreen(user);

    // Clear offscreen canvas
    user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    // Store color at FULL opacity for offscreen (RGB only)
    const color = user.color.slice(0, 3);
    user._penStrokeColor = `rgb(${color.join(',')})`;
    user._penOffscreenCtx.fillStyle = user._penStrokeColor;

    // Store alpha for compositing later
    const colorAlpha = user.color[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    user._penAlpha = colorAlpha * opacitySlider;

    // Stamp first circle to offscreen at full opacity
    user._penOffscreenCtx.beginPath();
    user._penOffscreenCtx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    user._penOffscreenCtx.fill();

    user._penLastStampPos = { x: pos.x, y: pos.y, radius };
    user.penPoints = [{ x: pos.x, y: pos.y, radius }];

    // Update preview
    this.updatePenPreview(user);
  }

  handlePenMove(user, pos) {
    if (!user._penLastStampPos || !user._penOffscreenCtx) return;

    const pressure = Math.round(user.pressure * 255) / 255;
    const radius = pressure * user.size;

    // Adaptive spacing
    const avgRadius = (user._penLastStampPos.radius + radius) / 2;
    const spacing = Math.max(1, avgRadius * 0.2);
    const dx = pos.x - user._penLastStampPos.x;
    const dy = pos.y - user._penLastStampPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= spacing) {
      // Stamp circles to offscreen at full opacity
      user._penOffscreenCtx.fillStyle = user._penStrokeColor;
      const steps = Math.ceil(distance / spacing);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = user._penLastStampPos.x + dx * t;
        const y = user._penLastStampPos.y + dy * t;
        const r = user._penLastStampPos.radius + (radius - user._penLastStampPos.radius) * t;
        user._penOffscreenCtx.beginPath();
        user._penOffscreenCtx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
        user._penOffscreenCtx.fill();
      }

      user._penLastStampPos = { x: pos.x, y: pos.y, radius };
      if (user.penPoints) {
        user.penPoints.push({ x: pos.x, y: pos.y, radius });
      }

      // Update preview
      this.updatePenPreview(user);
    }
  }

  handlePenUp(user) {
    if (!user._penLastStampPos || !user._penOffscreen) return;

    // Clear preview FIRST to prevent double opacity (preview + final stacking)
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    // Composite offscreen to mainCtx with alpha
    const mainCtx = this.board.mainCtx;
    mainCtx.globalAlpha = user._penAlpha;
    mainCtx.drawImage(user._penOffscreen, 0, 0);

    if (this.board.mirror) {
      mainCtx.save();
      mainCtx.translate(this.board.getWidth(), 0);
      mainCtx.scale(-1, 1);
      mainCtx.drawImage(user._penOffscreen, 0, 0);
      mainCtx.restore();
    }

    mainCtx.globalAlpha = 1.0;

    // Clean up per-user pen state
    user._penLastStampPos = null;
    user._penStrokeColor = null;
    user._penAlpha = null;
    user.penPoints = [];
  }

  updatePenPreview(user) {
    if (!user._penOffscreen) return;

    // Composite offscreen to user.context with alpha for preview
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.globalAlpha = user._penAlpha;
    user.context.drawImage(user._penOffscreen, 0, 0);
    user.context.globalAlpha = 1.0;
  }
}
