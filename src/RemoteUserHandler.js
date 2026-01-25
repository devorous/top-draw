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

          case 'pen':
            this.toolManager.getTool('pen').onPointerMove(user, pos, lastPos);
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

      case 'pen':
        this.toolManager.getTool('pen').onPointerDown(user, pos);
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

      case 'pen':
        this.toolManager.getTool('pen').onPointerUp(user, pos);
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

    // Clear pen stroke data (matching local cancelCurrentStroke behavior)
    user.penPoints = [];
    const penTool = this.toolManager.getTool('pen');
    if (penTool && penTool.clearStroke) {
      penTool.clearStroke();
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
      // Apply homography transform
      try {
        const homography = new Homography('projective');

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

        homography.setSourcePoints(srcPoints, user.floatingCanvas);
        homography.setDestinyPoints(dstPoints);

        const result = homography.warp();
        if (result) {
          this.board.mainCtx.putImageData(result, minX, minY);
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
        const homography = new Homography('projective');

        // Source points (original corners of the floating canvas)
        const srcPoints = [
          [user.originalCorners.tl.x, user.originalCorners.tl.y],
          [user.originalCorners.tr.x, user.originalCorners.tr.y],
          [user.originalCorners.bl.x, user.originalCorners.bl.y],
          [user.originalCorners.br.x, user.originalCorners.br.y]
        ];

        // Destination points (current corner positions, relative to output)
        const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
        const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

        const dstPoints = [
          [c.tl.x - minX, c.tl.y - minY],
          [c.tr.x - minX, c.tr.y - minY],
          [c.bl.x - minX, c.bl.y - minY],
          [c.br.x - minX, c.br.y - minY]
        ];

        homography.setSourcePoints(srcPoints, user.floatingCanvas);
        homography.setDestinyPoints(dstPoints);

        const result = homography.warp();
        if (result) {
          ctx.putImageData(result, minX, minY);
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
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }
}
