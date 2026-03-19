/**
 * @fileoverview Handles synchronization of remote user drawing actions.
 * Manages remote cursors, drawing tool routing, and position interpolation.
 */

import { mirrorLine, drawLineArray, bridgeGap } from '../utils/drawing.js';
import { SELECTION_MODES, getNextBrushIndex } from '../utils/parseGimp.js';
import { resetSmoothingBuffer } from '../utils/smoothing.js';
import { RemotePenHandler } from './RemotePenHandler.js';
import { RemoteInkHandler } from './RemoteInkHandler.js';
import { RemoteSelectionHandler } from './RemoteSelectionHandler.js';

/**
 * RemoteUserHandler coordinates the rendering of remote users' drawing events.
 * It manages tool-specific handlers and ensures visual parity between clients.
 */
export class RemoteUserHandler {
  /**
   * @param {App} app - The main application instance.
   */
  constructor(app) {
    this.app = app;

    /** @type {RemotePenHandler} */
    this.penHandler = new RemotePenHandler(app.board);
    /** @type {RemoteInkHandler} */
    this.inkHandler = new RemoteInkHandler(app.board);
    /** @type {RemoteSelectionHandler} */
    this.selectionHandler = new RemoteSelectionHandler(
      app.board,
      () => this.users,
      () => this.sessionIndex
    );

    /** @type {number} */
    this.catchupInterval = 16;
    /** @type {number|null} */
    this.catchupTimer = null;
  }

  get board() { return this.app.board; }
  get toolManager() { return this.app.toolManager; }
  get ui() { return this.app.ui; }
  get users() { return this.app.users; }
  get sessionIndex() { return this.app.sessionIndex; }
  get debugOverlay() { return this.app.debugOverlay; }

  /**
   * Processes remote mouse movement and updates drawing state.
   *
   * @param {User} user - The remote user moving their mouse.
   * @param {Object} data - Movement data payload containing points and radii.
   * @returns {void}
   */
  handleMouseMove(user, data) {
    const points = data.ps;
    if (!points || points.length < 2) return;

    user.remoteTarget = { x: points[points.length - 2], y: points[points.length - 1] };
    this.startCatchupLoop();

    // Points arrive pre-smoothed by the sender's InputBufferManager, so we
    // use them directly.  Applying EMA again would cause double-smoothing,
    // making remote strokes visibly shorter / laggier than local ones.
    const smoothedPoints = [];
    for (let i = 0; i < points.length; i += 2) {
      smoothedPoints.push(points[i], points[i + 1]);
    }

    // Keep the smooth buffer in sync so the catchup loop starts from the
    // correct position (the last received point, not a stale EMA value).
    if (smoothedPoints.length >= 2) {
      user.smoothBuffer.x = smoothedPoints[smoothedPoints.length - 2];
      user.smoothBuffer.y = smoothedPoints[smoothedPoints.length - 1];
      user.smoothBuffer.isFirst = false;
    }

    const radii = data.rs;
    if (!user.panning && user.mousedown && radii && radii.length > 0) {
      if (user.tool === 'ink') {
        this.inkHandler.handleInkPoints(user, smoothedPoints, radii);
      } else if (user.tool === 'pixel' || user.tool === 'imageBrush') {
        const tool = this.toolManager.getTool(user.tool);
        if (tool) tool.applyStamps(user, smoothedPoints);
      } else if (user.tool === 'circleBlur' || user.tool === 'circleBlurHard') {
        const tool = this.toolManager.getTool(user.tool);
        if (tool) tool.applyStamps(user, smoothedPoints, radii);
      } else {
        this.penHandler.handlePenStamps(user, smoothedPoints, radii);
      }
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      return;
    }

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

      if (!user.panning && user.mousedown && this.debugOverlay) {
        this.debugOverlay.addDrawingPoint(pos.x, pos.y, user.size, user.id);
        this.debugOverlay.addStrokePoint(user.id, pos.x, pos.y, 'mouseMove');
      }

      if (!user.panning && user.mousedown) {
        this.renderRemoteMove(user, pos, lastPos);
      }

      user.lastx = x;
      user.lasty = y;
    }

    const finalX = smoothedPoints[smoothedPoints.length - 2];
    const finalY = smoothedPoints[smoothedPoints.length - 1];
    this.ui.updateRemoteCursor(user.id, finalX, finalY, user.size);

    if (!user.panning && user.mousedown) {
      this.renderRemotePreview(user, { x: finalX, y: finalY });
      if (user.tool === 'brush') {
        this.board.requestUpdate();
      }
    }

    // Keep canvas text preview in sync with cursor position when blend mode is active
    if (user.tool === 'text' && user.blendMode && user.blendMode !== 'source-over' && user.text) {
      this._renderRemoteTextToCanvas(user);
    }
  }

  /**
   * Starts the global catch-up loop to converge remote cursors to their targets.
   * @returns {void}
   */
  startCatchupLoop() {
    if (this.catchupTimer) return;
    this.catchupTimer = setInterval(() => this.tickCatchup(), this.catchupInterval);
  }

  /**
   * Performs one tick of the catch-up convergence logic.
   * Stops the loop when all users have reached their targets.
   * @returns {void}
   */
  tickCatchup() {
    let anyActive = false;

    for (const user of this.users.values()) {
      if (user.mousedown && !user.panning && user.remoteTarget) {
        const dx = user.remoteTarget.x - user.smoothBuffer.x;
        const dy = user.remoteTarget.y - user.smoothBuffer.y;
        const distSq = dx * dx + dy * dy;

        if (distSq > 0.25) {
          anyActive = true;
          const lastPos = { x: user.x, y: user.y };

          // Snap directly to the target — incoming points are already
          // smoothed by the sender, so additional EMA here would double-smooth.
          const pos = { x: user.remoteTarget.x, y: user.remoteTarget.y };
          user.smoothBuffer.x = pos.x;
          user.smoothBuffer.y = pos.y;

          user.setPosition(pos.x, pos.y);
          this.ui.updateRemoteCursor(user.id, pos.x, pos.y, user.size);
          this.renderRemoteMove(user, pos, lastPos);
        }
      }
    }

    if (!anyActive) {
      clearInterval(this.catchupTimer);
      this.catchupTimer = null;
    }
  }

  /**
   * Internal router to render a single movement step based on the user's active tool.
   *
   * @param {User} user - The remote user.
   * @param {Object} pos - The current {x, y} position.
   * @param {Object} lastPos - The previous {x, y} position.
   * @returns {void}
   */
  renderRemoteMove(user, pos, lastPos) {
    switch (user.tool) {
      case 'brush':
        user.addToLine(pos);

        if (user.pressure !== user.prevpressure) {
          this.commitLine(user);
        }
        user.prevpressure = user.pressure;
        break;

      case 'erase': {
        const eraserTool = this.toolManager.getTool('erase');
        const eraseSize = user.pressure * user.size * 2;
        if (user.eraseAllLayers) {
          const count = this.board.layerManager.getLayerCount();
          for (let i = 0; i < count; i++) {
            const g = this.board.layerManager.getLayerGroup(i);
            if (g) {
              eraserTool.eraseOnGroup(g, pos.x, pos.y, lastPos.x, lastPos.y, eraseSize, user.opacity, user.id);
              if (this.board.mirror) {
                const w = this.board.getWidth();
                eraserTool.eraseOnGroup(g, w - pos.x, pos.y, w - lastPos.x, lastPos.y, eraseSize, user.opacity, user.id);
              }
            }
          }
        } else {
          const group = this.board.layerManager.getLayerGroup(user.activeLayer);
          if (group) {
            eraserTool.eraseOnGroup(group, pos.x, pos.y, lastPos.x, lastPos.y, eraseSize, user.opacity, user.id);
            if (this.board.mirror) {
              const w = this.board.getWidth();
              eraserTool.eraseOnGroup(group, w - pos.x, pos.y, w - lastPos.x, lastPos.y, eraseSize, user.opacity, user.id);
            }
          }
        }
        this.board.requestUpdate();
        break;
      }

      case 'blur':
        const blurTool = this.toolManager.getTool('blur');
        if (blurTool) {
          user.lastBlurPos = pos;
          blurTool.onPointerMove(user, pos, lastPos);
        }
        break;

      case 'pixel': {
        const pixelTool = this.toolManager.getTool('pixel');
        if (pixelTool) {
          pixelTool.onPointerMove(user, pos, lastPos);
        }
        break;
      }

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
   * Renders the transient preview of a remote user's drawing (e.g., shapes, brush line).
   *
   * @param {User} user - The remote user.
   * @param {Object} pos - The current {x, y} position.
   * @returns {void}
   */
  renderRemotePreview(user, pos) {
    const needsClear = ['brush', 'line', 'rectangle', 'circle', 'select', 'erase', 'text'].includes(user.tool);
    if (needsClear && !(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    switch (user.tool) {
      case 'text':
        // DOM text element handles the preview; no canvas drawing needed here
        break;

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

  /**
   * Handles remote mouse down events.
   *
   * @param {User} user - The remote user.
   * @param {Object} [data={}] - Event data containing starting points.
   * @returns {void}
   */
  handleMouseDown(user, data = {}) {
    user.mousedown = true;
    user._mainCtxDrawCount = 0;
    user.clearLine();

    resetSmoothingBuffer(user.smoothBuffer);
    user.remoteTarget = null;

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
    user.startPos = pos;
    user.setPosition(pos.x, pos.y);

    if (!user.panning) {
      if (user.tool === 'erase' && user.eraseAllLayers) {
        this.board.beginStrokeAllLayers(user, 'destination-out');
      } else if (user.tool !== 'blur' && user.tool !== 'fill') {
        // Blur tool handles its own stroke creation in onPointerDown with filter metadata
        // Fill tool manages its own stroke lifecycle via the dedicated FILL message handler
        const blendMode = user.tool === 'erase' ? 'destination-out' : (user.blendMode || 'source-over');
        this.board.layerManager.beginUserStroke(user.activeLayer, user.id, blendMode);
      }
    }

    if (!user.panning && this.debugOverlay) {
      this.debugOverlay.startDrawing(pos.x, pos.y, user.tool, user.size, user.id, user.username);
      this.debugOverlay.startStrokeTracking(user.id, false);
      this.debugOverlay.addStrokePoint(user.id, pos.x, pos.y, 'mouseDown');
    }

    switch (user.tool) {
      case 'brush':
        if (!user.panning) {
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
          const eraseSize = user.pressure * user.size * 2;
          if (user.eraseAllLayers) {
            const count = this.board.layerManager.getLayerCount();
            for (let i = 0; i < count; i++) {
              const g = this.board.layerManager.getLayerGroup(i);
              if (g) eraserTool.eraseOnGroup(g, pos.x, pos.y, pos.x, pos.y, eraseSize, 1.0, user.id);
            }
          } else {
            const eraseGroup = this.board.layerManager.getLayerGroup(user.activeLayer);
            if (eraseGroup) eraserTool.eraseOnGroup(eraseGroup, pos.x, pos.y, pos.x, pos.y, eraseSize, 1.0, user.id);
          }
          this.board.requestUpdate();
        }
        break;

      case 'blur':
        if (!user.panning) {
          const blurTool = this.toolManager.getTool('blur');
          if (blurTool) {
            blurTool.onPointerDown(user, pos);
          }
        }
        break;

      case 'pixel':
        if (!user.panning) {
          const pixelTool = this.toolManager.getTool('pixel');
          if (pixelTool) {
            pixelTool.onPointerDown(user, pos);
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
          this.ui.setRemoteTextDomVisible(user.id, true);
          this.ui.updateRemoteText(user.id, '');
          this.board.layerManager.commitUserStroke(user.activeLayer, user.id);
          this.board.requestUpdate();
        }
        break;

      case 'imageBrush':
        if (user.imageBrush && !user.panning) {
          if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
            user.imageBrush.reset();
          }
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            imageBrushTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
            imageBrushTool.drawStamp(user, pos);
          }
        }
        break;

      case 'fill':
        if (!user.panning) {
          this._drawFillPreview(user, pos);
        }
        break;

      case 'select':
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
        user.lassoPoints = [{ x: pos.x, y: pos.y }];
        break;
    }
  }

  /**
   * Handles remote mouse up events. Finalizes and commits remote strokes.
   *
   * @param {User} user - The remote user.
   * @returns {void}
   */
  handleMouseUp(user) {
    if (!user.mousedown) return;
    const pos = { x: user.x, y: user.y };
    user.remoteTarget = null;

    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);

    const hadPenStroke = user._penStrokeActive;
    if (hadPenStroke) {
      this.penHandler.handlePenUp(user);
    }

    const hadInkStroke = user._inkStrokeActive;
    if (hadInkStroke) {
      this.inkHandler.handleInkUp(user);
    }

    if (!(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    if (hadPenStroke || hadInkStroke) {
      // Handled above
    } else switch (user.tool) {
      case 'brush':
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
        if (user.startPos) {
          const x = Math.min(user.startPos.x, pos.x);
          const y = Math.min(user.startPos.y, pos.y);
          const width = Math.abs(pos.x - user.startPos.x);
          const height = Math.abs(pos.y - user.startPos.y);
          if (width >= 5 && height >= 5) {
            user.pendingSelection = { x, y, width, height };
            user.pendingLassoPath = user.lassoPoints && user.lassoPoints.length >= 2 ? [...user.lassoPoints] : null;
          }
        }
        break;

      case 'blur':
        if (!user.panning) {
          const blurTool = this.toolManager.getTool('blur');
          if (blurTool) {
            blurTool.onPointerUp(user, pos);
          }
        }
        break;

      case 'pixel':
        if (!user.panning) {
          const pixelTool = this.toolManager.getTool('pixel');
          if (pixelTool) {
            pixelTool.onPointerUp(user, pos);
          }
        }
        break;

      case 'text':
        if (user.text) {
          this.toolManager.getTool('text').drawText(user);
          user.text = '';
          this.ui.setRemoteTextDomVisible(user.id, true);
          this.ui.updateRemoteText(user.id, '');
          this.board.requestUpdate();
        }
        break;
    }

    if (this.debugOverlay) {
      this.debugOverlay.endDrawing(user.id);
      this.debugOverlay.endStrokeTracking(user.id);
    }

    this.board.compositeAllLayers();

    if (!(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    if (user.tool === 'erase' && user.eraseAllLayers) {
      this.board.endStrokeAllLayers(user);
    } else if (user.tool !== 'fill') {
      // Fill tool commits its own stroke via the dedicated FILL message handler
      this.board.layerManager.commitUserStroke(user.activeLayer, user.id);
    }

    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.lassoPoints = null;

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) circleBlurTool.lastStampPos.delete(user.id);

    const circleBlurHardTool = this.toolManager.getTool('circleBlurHard');
    if (circleBlurHardTool) circleBlurHardTool.lastStampPos.delete(user.id);

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);

    if (user.floatingCanvas && user.selection) {
      this.selectionHandler.drawFloatingSelection(user);
    }
    else if (user.pendingSelection) {
      this.selectionHandler.drawPendingSelection(user);
      this.selectionHandler.startRemoteSelectionAnimation();
    }
  }

  /**
   * Updates remote text buffer based on key presses.
   *
   * @param {User} user - The remote user typing.
   * @param {string} key - The character or key name (e.g., 'Enter', 'Backspace').
   * @returns {void}
   */
  handleKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      user.text = user.text.slice(0, -1);
    }
    const hasBlendMode = user.blendMode && user.blendMode !== 'source-over';
    if (hasBlendMode) {
      this.ui.setRemoteTextDomVisible(user.id, false);
      this._renderRemoteTextToCanvas(user);
    } else {
      this.ui.setRemoteTextDomVisible(user.id, true);
      this.ui.updateRemoteText(user.id, user.text);
    }
  }

  /**
   * Draws the remote user's current text to their preview canvas.
   * Used when a non-default blend mode is active — the userBoard canvas already
   * has CSS mix-blend-mode set, so drawing here achieves the blend effect.
   *
   * @private
   * @param {User} user - The remote user.
   * @returns {void}
   */
  _renderRemoteTextToCanvas(user) {
    const ctx = user.context;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    if (!user.text) return;
    const fontSize = user.size + 5;
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px Newsreader, serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(user.text, user.x + 5, user.y + (fontSize * 0.66) - 3);
    ctx.restore();
  }

  /**
   * Loads a brush resource for a remote user.
   *
   * @param {User} user - The remote user.
   * @param {string|Object} brushDataStr - Serialized brush configuration.
   * @returns {void}
   */
  handleBrushLoad(user, brushDataStr) {
    const brushData = typeof brushDataStr === 'string' ? JSON.parse(brushDataStr) : brushDataStr;

    if (brushData.type === 'gbr' || brushData.type === 'image') {
      const image = new Image();
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
      let loadedCount = 0;
      const totalImages = brushData.gBrushes.length;

      const images = brushData.gBrushes.map((brush, idx) => {
        const img = new Image();
        img.onload = () => {
          loadedCount++;
          if (loadedCount === totalImages) {
            brushData.images = images;
            brushData.index = 0;
            brushData.ncells = images.length;
            if (!brushData.cellwidth && brushData.gBrushes[0]) {
              brushData.cellwidth = brushData.gBrushes[0].width || 32;
              brushData.cellheight = brushData.gBrushes[0].height || 32;
            }

            if (brushData.dimensions && brushData.dimensions.length > 0) {
              for (const dim of brushData.dimensions) {
                dim.currentIndex = 0;
              }

              brushData.getNextBrush = function(context) {
                const idx = getNextBrushIndex(this, context);
                return {
                  brush: this.gBrushes[idx],
                  index: idx
                };
              };

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

  /**
   * Cancels a remote user's active stroke and cleans up state.
   *
   * @param {User} user - The remote user whose stroke is being cancelled.
   * @returns {void}
   */
  handleCancel(user) {
    if (this.debugOverlay) {
      this.debugOverlay.cancelDrawing(user.id);
    }

    this.board.layerManager.cancelUserStroke(user.activeLayer, user.id);

    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;

    user.penPoints = [];
    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    if (user._penOffscreenCtx) {
      user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);
    }

    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
    if (user._inkCtx) {
      user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);
    }

    delete user.blurBounds;
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

  /**
   * Internal helper to expand the dirty rect for a remote user.
   *
   * @private
   * @param {User} user - The remote user.
   * @param {Array<Object>} points - Array of {x, y} points.
   * @param {number} margin - Expansion margin around the points.
   * @returns {void}
   */
  /**
   * Draws a checkerboard fill preview on a remote user's preview canvas.
   * Shows where the user is performing an advanced fill operation.
   *
   * @private
   * @param {User} user - The remote user.
   * @param {{x: number, y: number}} pos - The fill seed position.
   */
  _drawFillPreview(user, pos) {
    const fillTool = this.toolManager.getTool('fill');
    if (!fillTool) return;

    const width = this.board.getWidth();
    const height = this.board.getHeight();
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const imageData = this.board.mainCtx.getImageData(0, 0, width, height);
    const result = fillTool._computeMask(imageData.data, width, height, x, y, 10, null);
    if (!result) return;

    const { mask, minX, minY, maxX, maxY } = result;
    const regionW = maxX - minX + 1;
    const regionH = maxY - minY + 1;
    const imgData = new ImageData(regionW, regionH);
    const pixels = imgData.data;

    // Use the remote user's fill color with a checkerboard pattern
    const fillColor = user.color ?? [0, 0, 0, 1];
    const r = Math.round(fillColor[0]);
    const g = Math.round(fillColor[1]);
    const b = Math.round(fillColor[2]);
    const tileSize = 6;

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        if (mask[py * width + px]) {
          const oi = ((py - minY) * regionW + (px - minX)) * 4;
          const isLight = ((Math.floor(px / tileSize) + Math.floor(py / tileSize)) % 2 === 0);
          if (isLight) {
            pixels[oi] = r;
            pixels[oi + 1] = g;
            pixels[oi + 2] = b;
            pixels[oi + 3] = 140;
          } else {
            pixels[oi] = Math.round(r * 0.5);
            pixels[oi + 1] = Math.round(g * 0.5);
            pixels[oi + 2] = Math.round(b * 0.5);
            pixels[oi + 3] = 140;
          }
        }
      }
    }

    user.context.putImageData(imgData, minX, minY);
  }

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
   * Computes the brush margin for dirty rectangle expansion.
   *
   * @private
   * @param {User} user - The remote user.
   * @returns {number}
   */
  _brushMargin(user) {
    const radius = user.pressure * user.size;
    const hardnessFloat = (user.hardness !== undefined ? user.hardness : 100) / 100;
    const blurAmount = hardnessFloat < 1 ? (1 - hardnessFloat) * (20 + user.size * 0.2) : 0;
    return radius + blurAmount + radius * 0.25 + 2;
  }

  /**
   * Commits the current line segment to the history and prepares for the next.
   * Used when remote brush parameters change mid-stroke.
   *
   * @param {User} user - The remote user.
   * @param {number} [newPressure] - New pressure value.
   * @param {number} [newSize] - New brush size.
   * @returns {void}
   */
  commitLine(user, newPressure, newSize) {
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    const lastDrawnPos = user.currentLine.length > 0
      ? user.currentLine[user.currentLine.length - 1]
      : { x: user.x, y: user.y };

    const oldRadius = user.pressure * user.size;
    const newRadius = (newPressure ?? user.pressure) * (newSize ?? user.size);

    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(user.activeLayer, user.id);
    if (activeStrokeCtx) {
      if (user.tool === 'brush' && user.currentLine.length >= 2) {
        drawLineArray(user.currentLine, activeStrokeCtx, user);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          const mirroredLine = mirrorLine(user.currentLine, w);
          drawLineArray(mirroredLine, activeStrokeCtx, user);
        }
        this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
      }

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
    this.board.compositeAllLayers();
  }
}
