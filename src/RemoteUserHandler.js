import { mirrorLine } from './utils/drawing.js';
import { Homography } from './utils/homography.js';

/**
 * Handles all remote user drawing synchronization
 */
export class RemoteUserHandler {
  constructor(app) {
    this.app = app;
  }

  get board() { return this.app.board; }
  get toolManager() { return this.app.toolManager; }
  get ui() { return this.app.ui; }

  handleMouseMove(user, data) {
    if (user.lastx === null) {
      user.lastx = data.x;
      user.lasty = data.y;
    }

    const lastPos = { x: user.x, y: user.y };
    user.setPosition(data.x, data.y);
    const pos = { x: user.x, y: user.y };

    this.ui.updateRemoteCursor(user.id, user.x, user.y, user.size);

    if (!user.panning && user.mousedown) {
      // Clear the remote user's specific top/preview layer before drawing frame-based tools
      // Brush and Erase often draw cumulatively, but Shapes and Select need a fresh frame.
      const needsClear = ['line', 'rectangle', 'circle', 'select'].includes(user.tool);
      if (needsClear) {
        user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      }

      switch (user.tool) {
        case 'brush':
          user.addToLine(pos);
          if (user.pressure !== user.prevpressure) {
            this.commitLine(user);
          } else {
            user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
            this.drawLineArray(user.currentLine, user.context, user);
            if (this.board.mirror) {
              const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
              this.drawLineArray(mirrored, user.context, user);
            }
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

        case 'gimp':
          if (user.gBrush) {
            this.toolManager.getTool('gimp').draw(user, pos);
          }
          break;

        case 'pen':
          // Pen tool typically uses an offscreen canvas for "stamping"
          // to prevent opacity overlap before committing.
          this.toolManager.getTool('pen').onPointerMove(user, pos, lastPos);
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
          // Only draw selection box if user is creating a NEW selection
          // (not if they have an active floating selection being moved/transformed)
          if (!user.floatingCanvas && user.startPos) {
            const selectTool = this.toolManager.getTool('select');
            selectTool.drawSelectionBox(user.context, user.startPos, pos);
          }
          break;
      }
    }

    user.lastx = data.x;
    user.lasty = data.y;
  }

  handleMouseDown(user) {
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;
    user.mousedown = true;

    const pos = { x: user.x, y: user.y };
    // Essential for all shape tools and selection
    user.startPos = pos;

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

      case 'gimp':
        if (user.gBrush && !user.panning) {
          this.toolManager.getTool('gimp').draw(user, pos);
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

    // Cleanup
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
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

  handleGimpLoad(user, gimpDataStr) {
    // Parse JSON string from protobuf transport
    const gimpData = typeof gimpDataStr === 'string' ? JSON.parse(gimpDataStr) : gimpDataStr;

    if (gimpData.type === 'gbr') {
      const image = new Image();
      image.src = gimpData.gimpUrl;
      gimpData.image = image;
      user.gBrush = gimpData;
    } else if (gimpData.type === 'gih') {
      const images = gimpData.gBrushes.map(brush => {
        const img = new Image();
        img.src = brush.gimpUrl;
        return img;
      });
      gimpData.index = 0;
      gimpData.images = images;
      user.gBrush = gimpData;
    }
  }

  handleCancel(user) {
    // Clear any in-progress drawing
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.pendingSelection = null;
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

    // Draw marching ants border (simple static version for remote)
    if (c) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(c.tl.x, c.tl.y);
      ctx.lineTo(c.tr.x, c.tr.y);
      ctx.lineTo(c.br.x, c.br.y);
      ctx.lineTo(c.bl.x, c.bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawPendingSelection(user) {
    if (!user.pendingSelection) return;

    const ctx = user.context;
    const s = user.pendingSelection;

    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    ctx.strokeStyle = '#000';
    ctx.strokeRect(s.x, s.y, s.width, s.height);

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 4;
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
