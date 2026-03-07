import { mirrorLine, drawLineArray, bridgeGap } from '../utils/drawing.js';
import { SELECTION_MODES, getNextBrushIndex } from '../utils/parseGimp.js';
import { applySmoothingEMA, resetSmoothingBuffer } from '../utils/smoothing.js';
import { RemotePenHandler } from './RemotePenHandler.js';
import { RemoteInkHandler } from './RemoteInkHandler.js';
import { RemoteSelectionHandler } from './RemoteSelectionHandler.js';

/**
 * Handles all remote user drawing synchronization
 *
 * IMPORTANT: Position Smoothing vs Visual Smoothing
 * - Incoming points (data.ps) are already EMA-smoothed by the sender's InputBufferManager
 * - This ensures perfect parity: sender sees exactly what gets broadcast
 * - Remote rendering applies NO additional position smoothing
 * - Visual smoothing (e.g., Catmull-Rom curves in drawLineArray) is separate and applied
 *   during rendering, not to the positions themselves
 */
export class RemoteUserHandler {
  constructor(app) {
    this.app = app;

    // Tool-specific handlers
    this.penHandler = new RemotePenHandler(app.board);
    this.inkHandler = new RemoteInkHandler(app.board);
    this.selectionHandler = new RemoteSelectionHandler(
      app.board,
      () => this.users,
      () => this.sessionIndex
    );

    // Remote catch-up loop configuration
    this.catchupInterval = 16; // ~60 FPS
    this.catchupTimer = null;
  }

  get board() { return this.app.board; }
  get toolManager() { return this.app.toolManager; }
  get ui() { return this.app.ui; }
  get users() { return this.app.users; }
  get sessionIndex() { return this.app.sessionIndex; }
  get debugOverlay() { return this.app.debugOverlay; }

  handleMouseMove(user, data) {
    const points = data.ps;
    if (!points || points.length < 2) return;

    // Track the raw final target for catch-up convergence
    user.remoteTarget = { x: points[points.length - 2], y: points[points.length - 1] };
    this.startCatchupLoop();

    // Apply EMA smoothing to incoming points to match local user experience.
    // While the sender smooths before broadcasting, the remote catch-up mechanism
    // ensures the pointer reaches the target even if the broadcast stream ends.
    const smoothedPoints = [];
    const isInk = user._inkStrokeActive || user.tool === 'ink';
    
    for (let i = 0; i < points.length; i += 2) {
      const rx = points[i];
      const ry = points[i + 1];
      
      if (isInk) {
        // Ink has its own calligraphic smoothing, don't double-smooth positions
        smoothedPoints.push(rx, ry);
      } else {
        const smoothed = applySmoothingEMA(user.smoothBuffer, rx, ry, user.smoothing);
        smoothedPoints.push(smoothed.x, smoothed.y);
      }
    }

    // Flow pen and ink send per-point data in separate rs array
    const radii = data.rs;
    if (!user.panning && user.mousedown && radii && radii.length > 0) {
      // Route by active stroke flag first (survives CT race), then by tool name
      if (isInk) {
        this.inkHandler.handleInkPoints(user, smoothedPoints, radii);
      } else {
        this.penHandler.handlePenStamps(user, smoothedPoints, radii);
      }
      // Update cursor from last point pair
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      return;
    }

    // Process each smoothed point in the batch (pair-based: [x, y, x, y, ...])
    for (let i = 0; i < smoothedPoints.length; i += 2) {
      const x = smoothedPoints[i];
      const y = smoothedPoints[i + 1];

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
        this.renderRemoteMove(user, pos, lastPos);
      }

      user.lastx = x;
      user.lasty = y;
    }

    // After processing all points, update cursor and handle shape tools with final position
    const finalX = smoothedPoints[smoothedPoints.length - 2];
    const finalY = smoothedPoints[smoothedPoints.length - 1];
    this.ui.updateRemoteCursor(user.id, finalX, finalY, user.size);

    if (!user.panning && user.mousedown) {
      this.renderRemotePreview(user, { x: finalX, y: finalY });
      if (user.tool === 'brush') {
        this.board.requestUpdate();
      }
    }
  }

  /**
   * Start the global catch-up loop for remote users if not already running
   */
  startCatchupLoop() {
    if (this.catchupTimer) return;
    this.catchupTimer = setInterval(() => this.tickCatchup(), this.catchupInterval);
  }

  /**
   * Process one step of convergence for all active remote users
   */
  tickCatchup() {
    let anyActive = false;

    for (const user of this.users.values()) {
      // Only catch up while drawing and if we have a target
      if (user.mousedown && !user.panning && user.remoteTarget) {
        const dx = user.remoteTarget.x - user.smoothBuffer.x;
        const dy = user.remoteTarget.y - user.smoothBuffer.y;
        const distSq = dx * dx + dy * dy;

        // Converge if distance > 0.5 pixels
        if (distSq > 0.25) {
          anyActive = true;
          const lastPos = { x: user.x, y: user.y };
          
          // Smooth towards target
          const isInk = user._inkStrokeActive || user.tool === 'ink';
          let pos;
          if (isInk) {
            // Ink catch-up: perfect-freehand needs more points to shift the curve
            pos = user.remoteTarget;
          } else {
            pos = applySmoothingEMA(user.smoothBuffer, user.remoteTarget.x, user.remoteTarget.y, user.smoothing);
          }

          user.setPosition(pos.x, pos.y);
          this.ui.updateRemoteCursor(user.id, pos.x, pos.y, user.size);
          this.renderRemoteMove(user, pos, lastPos);
        }
      }
    }

    // Stop loop if no users need catch-up
    if (!anyActive) {
      clearInterval(this.catchupTimer);
      this.catchupTimer = null;
    }
  }

  /**
   * Internal router for rendering a single movement step
   */
  renderRemoteMove(user, pos, lastPos) {
    switch (user.tool) {
      case 'brush':
        // Store point for later rendering (whole line drawn in renderRemotePreview)
        user.addToLine(pos);

        if (user.pressure !== user.prevpressure) {
          this.commitLine(user);
        }
        user.prevpressure = user.pressure;
        break;

      case 'erase':
        const eraserTool = this.toolManager.getTool('erase');
        const group = this.board.layerManager.getLayerGroup(user.activeLayer);
        if (group) {
          eraserTool.eraseOnGroup(group, pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2, user.opacity, user.id);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            eraserTool.eraseOnGroup(group, w - pos.x, pos.y, w - lastPos.x, lastPos.y, user.pressure * user.size * 2, user.opacity, user.id);
          }
          this.board.requestUpdate();
        }
        break;

      case 'blur':
        const blurTool = this.toolManager.getTool('blur');
        if (blurTool) {
          user.lastBlurPos = pos;
          blurTool.onPointerMove(user, pos, lastPos);
        }
        break;

      case 'circleBlur':
      case 'circleBlurHard': {
        const circleBlurTool = this.toolManager.getTool(user.tool);
        if (circleBlurTool) {
          circleBlurTool.onPointerMove(user, pos, lastPos);
        }
        break;
      }

      case 'imageBrush':
        if (user.imageBrush) {
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            imageBrushTool.onPointerMove(user, pos);
          }
        }
        break;
    }
  }

  /**
   * Internal router for rendering shape previews/lasso
   */
  renderRemotePreview(user, pos) {
    // Shape tools and eraser need their preview canvas cleared.
    // Brush also needs clear because it redraws the whole line for better quality.
    // Skip for select tool when a floating selection exists.
    const needsClear = ['brush', 'line', 'rectangle', 'circle', 'select', 'erase'].includes(user.tool);
    if (needsClear && !(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    switch (user.tool) {
      case 'brush':
        if (user.currentLine.length >= 2) {
          drawLineArray(user.currentLine, user.context, user);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            const mirroredLine = mirrorLine(user.currentLine, w);
            drawLineArray(mirroredLine, user.context, user);
          }
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
          if (!user.lassoPoints) user.lassoPoints = [];
          const lastPoint = user.lassoPoints[user.lassoPoints.length - 1];
          if (!lastPoint || Math.hypot(pos.x - lastPoint.x, pos.y - lastPoint.y) >= 3) {
            user.lassoPoints.push({ x: pos.x, y: pos.y });
          }
          if (user.lassoPoints.length >= 2) {
            selectTool.drawLassoPreview(user.context, user.lassoPoints);
          } else {
            selectTool.drawSelectionBox(user.context, user.startPos, pos);
          }
        }
        break;
    }
  }

  handleMouseDown(user, data = {}) {
    user.mousedown = true;
    user._mainCtxDrawCount = 0; // Reset draw counter for this stroke

    // Reset smoothing buffer for the new stroke
    resetSmoothingBuffer(user.smoothBuffer);
    user.remoteTarget = null;

    // Use broadcast position if provided (already smoothed by sender)
    // This ensures remote users don't see raw click positions when high smoothing is active
    if (data.ps && data.ps.length >= 2) {
      const rx = data.ps[0];
      const ry = data.ps[1];
      user.setPosition(rx, ry);
      user.smoothBuffer.x = rx;
      user.smoothBuffer.y = ry;
      user.smoothBuffer.isFirst = false;
    }

    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;

    const pos = { x: user.x, y: user.y };
    // Essential for all shape tools and selection
    user.startPos = pos;

    // Begin a fresh active stroke for this user so each stroke composites independently
    if (!user.panning) {
      const blendMode = user.tool === 'erase' ? 'destination-out' : (user.blendMode || 'source-over');
      this.board.layerManager.beginUserStroke(user.activeLayer, user.id, blendMode);
    }

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
        this.penHandler.handlePenDown(user, pos);
        break;

      case 'ink':
        this.inkHandler.handleInkDown(user, pos);
        break;

      case 'erase':
        if (!user.panning) {
          const eraserTool = this.toolManager.getTool('erase');
          const eraseGroup = this.board.layerManager.getLayerGroup(user.activeLayer);
          if (eraseGroup) {
            eraserTool.eraseOnGroup(eraseGroup, pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2, 1.0, user.id);
            this.board.requestUpdate();
          }
        }
        break;

      case 'blur':
        if (!user.panning) {
          const blurTool = this.toolManager.getTool('blur');
          if (blurTool) {
            // Initialize blur snapshot and tracking for distance-based spacing
            blurTool.initBlurSnapshot(user);
            user.lastBlurPos = pos;
            blurTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
            blurTool.applyBlur(pos.x, pos.y, user.size, user);
            if (this.board.mirror) {
              const width = this.board.getWidth();
              blurTool.applyBlur(width - pos.x, pos.y, user.size, user);
            }
          }
        }
        break;

      case 'circleBlur':
      case 'circleBlurHard':
        if (!user.panning) {
          const circleBlurTool = this.toolManager.getTool(user.tool);
          if (circleBlurTool) {
            const radius = user.pressure * user.size;
            circleBlurTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
            const stampMethod = user.tool === 'circleBlurHard' ? 'stampHardCircle' : 'stampBlurredCircle';
            circleBlurTool[stampMethod](pos.x, pos.y, radius, user);
            if (this.board.mirror) {
              const width = this.board.getWidth();
              circleBlurTool[stampMethod](width - pos.x, pos.y, radius, user);
            }
          }
        }
        break;

      case 'text':
        if (user.text) {
          this.toolManager.getTool('text').drawText(user);
          user.text = '';
          this.ui.updateRemoteText(user.id, '');
          
          // Commit to history stack so it can be undone by other clients
          this.board.layerManager.commitUserStroke(user.activeLayer, user.id);
          this.board.requestUpdate();
        }
        break;

      case 'imageBrush':
        if (user.imageBrush && !user.panning) {
          // Reset GIH brush dimensions on new stroke (like local ImageBrushTool.onPointerDown)
          if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
            user.imageBrush.reset();
          }
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            // Initialize lastStampPos and stamp first image
            imageBrushTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
            imageBrushTool.drawStamp(user, pos);
          }
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
            user.pendingLassoPath = null;
            user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          }
        }
        // Initialize lasso points for new selection
        user.lassoPoints = [{ x: pos.x, y: pos.y }];
        break;
    }
  }

  handleMouseUp(user) {
    const pos = { x: user.x, y: user.y };
    user.remoteTarget = null; // Clear target on release

    // Get the ACTIVE sub-layer context for this user's stroke.
    // Brush uses this for the whole duration of the stroke.
    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);

    // Pen stroke active — composite offscreen and skip the tool switch,
    // since CT (tool change) may arrive after MD/MM when a new user joins
    // and user.tool could still be 'brush' despite an active pen stroke
    const hadPenStroke = user._penStrokeActive;
    if (hadPenStroke) {
      this.penHandler.handlePenUp(user);
    }

    // Ink stroke active — composite offscreen and skip tool switch
    const hadInkStroke = user._inkStrokeActive;
    if (hadInkStroke) {
      this.inkHandler.handleInkUp(user);
    }

    // Clear preview canvas FIRST to prevent composite boldness
    // (otherwise both preview and mainCtx briefly show the same line)
    // Skip for select tool when a floating selection exists — its rendering
    // is handled by RemoteSelectionHandler and clearing here would erase it.
    if (!(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    if (hadPenStroke || hadInkStroke) {
      // Pen/ink stroke was fully handled above — skip tool switch
    } else switch (user.tool) {
      case 'brush':
        // Brush uses non-incremental rendering now. Draw final line to activeStrokeCtx.
        if (activeStrokeCtx && user.currentLine.length >= 2) {
          drawLineArray(user.currentLine, activeStrokeCtx, user);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            const mirroredLine = mirrorLine(user.currentLine, w);
            drawLineArray(mirroredLine, activeStrokeCtx, user);
          }
          this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
        }
        break;

      case 'flowPen':
        // Already handled above before clear
        break;

      case 'line':
        if (activeStrokeCtx) {
          this.toolManager.getTool('line').drawPreview(activeStrokeCtx, user, user.startPos, pos);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.toolManager.getTool('line').drawPreview(activeStrokeCtx, user,
              { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
          }
          const lineMargin = user.size + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], lineMargin);
        }
        break;

      case 'rectangle':
        if (activeStrokeCtx) {
          this.toolManager.getTool('rectangle').drawRect(activeStrokeCtx, user, user.startPos, pos);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.toolManager.getTool('rectangle').drawRect(activeStrokeCtx, user,
              { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
          }
          const rectMargin = user.size + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], rectMargin);
        }
        break;

      case 'circle':
        if (activeStrokeCtx) {
          this.toolManager.getTool('circle').drawEllipse(activeStrokeCtx, user, user.startPos, pos);
          if (this.board.mirror) {
            const w = this.board.getWidth();
            this.toolManager.getTool('circle').drawEllipse(activeStrokeCtx, user,
              { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
          }
          const circleMargin = user.size + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], circleMargin);
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
            // Preserve lasso points for pending selection display
            user.pendingLassoPath = user.lassoPoints && user.lassoPoints.length >= 2 ? [...user.lassoPoints] : null;
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

    // Synchronously composite all layers to the visible canvas BEFORE clearing the preview.
    // This ensures there is no frame where the stroke is missing from both.
    this.board.compositeAllLayers();

    // Clear preview canvas ONLY after we are certain the main board has the updated stroke
    // Skip for select tool when a floating selection exists — its rendering
    // is handled by RemoteSelectionHandler and clearing here would erase it.
    if (!(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    // Commit the stroke to the history stack.
    // Skip if tool is text, as text is committed immediately in handleMouseDown.
    if (user.tool !== 'text') {
      this.board.layerManager.commitUserStroke(user.activeLayer, user.id);
    }
    // Cleanup (preview was already cleared at start of handleMouseUp)
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.lassoPoints = null;
    user.blurSnapshot = null;

    // Clean up tool-specific tracking maps
    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) blurTool.lastStampPos.delete(user.id);

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) circleBlurTool.lastStampPos.delete(user.id);

    const circleBlurHardTool = this.toolManager.getTool('circleBlurHard');
    if (circleBlurHardTool) circleBlurHardTool.lastStampPos.delete(user.id);

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);

    // Redraw floating selection if user has one (persists after handle release)
    if (user.floatingCanvas && user.selection) {
      this.selectionHandler.drawFloatingSelection(user);
    }
    // Draw pending selection rectangle if user just finished creating one
    else if (user.pendingSelection) {
      this.selectionHandler.drawPendingSelection(user);
      // Start the selection animation loop
      this.selectionHandler.startRemoteSelectionAnimation();
    }
  }

  handleKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      user.text = user.text.slice(0, -1);
    }
    this.ui.updateRemoteText(user.id, user.text);
  }

  handleBrushLoad(user, brushDataStr) {
    // Parse JSON string from protobuf transport
    const brushData = typeof brushDataStr === 'string' ? JSON.parse(brushDataStr) : brushDataStr;

    if (brushData.type === 'gbr' || brushData.type === 'image') {
      const image = new Image();
      // Wait for image to load before assigning to user
      image.onload = () => {
        brushData.image = image;
        user.imageBrush = brushData;
        console.log(`[ImageBrush] Remote user ${user.id} loaded ${brushData.type} brush:`, brushData.brushName || brushData.fileName);
      };
      image.onerror = () => {
        console.error(`[ImageBrush] Failed to load brush image for remote user ${user.id}`);
      };
      image.src = brushData.gimpUrl;
    } else if (brushData.type === 'gih' && brushData.gBrushes && brushData.gBrushes.length > 0) {
      // Track loading progress for all images
      let loadedCount = 0;
      const totalImages = brushData.gBrushes.length;

      const images = brushData.gBrushes.map((brush, idx) => {
        const img = new Image();
        img.onload = () => {
          loadedCount++;
          if (loadedCount === totalImages) {
            // All images loaded - now safe to assign to user
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
            console.log(`[ImageBrush] Remote user ${user.id} loaded GIH brush with ${totalImages} cells:`, brushData.brushName);
          }
        };
        img.onerror = () => {
          console.error(`[ImageBrush] Failed to load GIH image ${idx} for remote user ${user.id}`);
        };
        img.src = brush.gimpUrl;
        return img;
      });
    }
  }

  handleCancel(user) {
    // Cancel debug overlay tracking
    if (this.debugOverlay) {
      this.debugOverlay.cancelDrawing(user.id);
    }

    // Cancel in-progress stroke in LayerManager
    this.board.layerManager.cancelUserStroke(user.activeLayer, user.id);

    // Clear any in-progress drawing
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;

    // Clear per-user pen state
    user.penPoints = [];
    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    if (user._penOffscreenCtx) {
      user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);
    }

    // Clear per-user ink state
    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
    if (user._inkCtx) {
      user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);
    }

    // Clear blur/circleBlur/imageBrush tracking
    user.blurSnapshot = null;
    user.lastBlurPos = null;

    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) blurTool.lastStampPos.delete(user.id);

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) circleBlurTool.lastStampPos.delete(user.id);

    const circleBlurHardTool2 = this.toolManager.getTool('circleBlurHard');
    if (circleBlurHardTool2) circleBlurHardTool2.lastStampPos.delete(user.id);

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);

    this.board.requestUpdate();
  }

  // Drawing utilities

  /**
   * Expand the dirty rect for a remote user based on drawn points and brush size.
   * Mirrors the logic local tools use (BrushTool, ShapeTools, etc.).
   */
  _expandDirtyRectFromPoints(user, points, margin) {
    if (!points || points.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const x = Math.floor(minX - margin);
    const y = Math.floor(minY - margin);
    const w = Math.ceil(maxX - minX + margin * 2);
    const h = Math.ceil(maxY - minY + margin * 2);

    this.board.expandDirtyRect(user, x, y, w, h);

    if (this.board.mirror) {
      const boardW = this.board.getWidth();
      this.board.expandDirtyRect(user, Math.floor(boardW - maxX - margin), y, w, h);
    }
  }

  /**
   * Compute brush margin for dirty rect expansion (matching BrushTool logic).
   */
  _brushMargin(user) {
    const radius = user.pressure * user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    return radius + blurAmount + radius * 0.25 + 2;
  }

  commitLine(user, newPressure, newSize) {
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    // Save last drawn position (where old segment visually ends)
    const lastDrawnPos = user.currentLine.length > 0
      ? user.currentLine[user.currentLine.length - 1]
      : { x: user.x, y: user.y };

    const oldRadius = user.pressure * user.size;
    const newRadius = (newPressure ?? user.pressure) * (newSize ?? user.size);

    // Get the ACTIVE sub-layer context for this user's stroke.
    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    if (activeStrokeCtx) {
      // Draw the segment-so-far to the active stroke context before resetting the buffer
      if (user.tool === 'brush' && user.currentLine.length >= 2) {
        drawLineArray(user.currentLine, activeStrokeCtx, user);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          const mirroredLine = mirrorLine(user.currentLine, w);
          drawLineArray(mirroredLine, activeStrokeCtx, user);
        }
        // Track dirty rect from drawn points
        this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
      }

      // Bridge the gap between old segment end and new segment start when pressure changes
      // using interpolated filled circles (flow-pen style)
      if (user.currentLine.length > 0 && oldRadius !== newRadius) {
        const from = lastDrawnPos;
        bridgeGap(activeStrokeCtx, from, lastDrawnPos, oldRadius, newRadius, user);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          bridgeGap(activeStrokeCtx,
            { x: w - from.x, y: from.y },
            { x: w - lastDrawnPos.x, y: lastDrawnPos.y },
            oldRadius, newRadius, user);
        }
      }
    }

    user.clearLine();
    user.addToLine(lastDrawnPos);
    this.board.requestUpdate();
  }
}
