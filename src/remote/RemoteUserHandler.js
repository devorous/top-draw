/**
 * @fileoverview Handles synchronization of remote user drawing actions.
 * Manages remote cursors, drawing tool routing, and position interpolation.
 */

import { drawLineArray, bridgeGap } from '../utils/drawing.js';
import { SELECTION_MODES, getNextBrushIndex } from '../utils/parseGimp.js';
import { resetSmoothingBuffer } from '../utils/smoothing.js';
import { getPreviewTextLayout } from '../utils/textLayout.js';
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

  getStrokeLayer(user) {
    return user?._strokeLayer ?? user?.activeLayer ?? 0;
  }

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

    this.ui.markRemoteCursorActivity(user.id);
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

    // Pattern tool doesn't depend on radii - handle separately
    if (!user.panning && user.mousedown && user.tool === 'pattern') {
      const tool = this.toolManager.getTool('pattern');
      if (tool) tool.remoteStampMask(user, smoothedPoints);
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      return;
    }

    if (!user.panning && user.mousedown && radii && radii.length > 0) {
      if (user.tool === 'ink') {
        this.inkHandler.handleInkPoints(user, smoothedPoints, radii);
      } else if (user.tool === 'pixel' || user.tool === 'imageBrush') {
        const tool = this.toolManager.getTool(user.tool);
        if (tool) tool.applyStamps(user, smoothedPoints);
      } else if (user.tool === 'circleBlur') {
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
              this.board.forEachMirrorRegion({ points: [pos, lastPos] }, (region) => {
                const p1 = this.board.mirrorPointToRegion(pos, region);
                const p2 = this.board.mirrorPointToRegion(lastPos, region);
                eraserTool.eraseOnGroup(g, p1.x, p1.y, p2.x, p2.y, eraseSize, user.opacity, user.id);
              });
            }
          }
        } else {
          const group = this.board.layerManager.getLayerGroup(this.getStrokeLayer(user));
          if (group) {
            eraserTool.eraseOnGroup(group, pos.x, pos.y, lastPos.x, lastPos.y, eraseSize, user.opacity, user.id);
            this.board.forEachMirrorRegion({ points: [pos, lastPos] }, (region) => {
              const p1 = this.board.mirrorPointToRegion(pos, region);
              const p2 = this.board.mirrorPointToRegion(lastPos, region);
              eraserTool.eraseOnGroup(group, p1.x, p1.y, p2.x, p2.y, eraseSize, user.opacity, user.id);
            });
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

      case 'glitchBlur':
        const glitchBlurToolMove = this.toolManager.getTool('glitchBlur');
        if (glitchBlurToolMove) {
          glitchBlurToolMove.onPointerMove(user, pos, lastPos);
        }
        break;

      case 'pixel': {
        const pixelTool = this.toolManager.getTool('pixel');
        if (pixelTool) {
          pixelTool.onPointerMove(user, pos, lastPos);
        }
        break;
      }

      case 'circleBlur': {
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
    const needsClear = ['brush', 'line', 'rectangle', 'circle', 'select', 'erase', 'text', 'glitchBlur'].includes(user.tool);
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
          this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
            const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
            this.board.withMirrorRegionClip(user.context, region, () => {
              drawLineArray(mirroredLine, user.context, user);
            });
          });
        }
        break;

      case 'line':
        this.toolManager.getTool('line').drawPreview(user.context, user, user.startPos, pos);
        this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
          this.board.withMirrorRegionClip(user.context, region, () => {
            this.toolManager.getTool('line').drawPreview(
              user.context,
              user,
              this.board.mirrorPointToRegion(user.startPos, region),
              this.board.mirrorPointToRegion(pos, region)
            );
          });
        });
        break;

      case 'rectangle':
        this.toolManager.getTool('rectangle').drawRect(user.context, user, user.startPos, pos);
        this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
          this.board.withMirrorRegionClip(user.context, region, () => {
            this.toolManager.getTool('rectangle').drawRect(
              user.context,
              user,
              this.board.mirrorPointToRegion(user.startPos, region),
              this.board.mirrorPointToRegion(pos, region)
            );
          });
        });
        break;

      case 'circle':
        this.toolManager.getTool('circle').drawEllipse(user.context, user, user.startPos, pos);
        this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
          this.board.withMirrorRegionClip(user.context, region, () => {
            this.toolManager.getTool('circle').drawEllipse(
              user.context,
              user,
              this.board.mirrorPointToRegion(user.startPos, region),
              this.board.mirrorPointToRegion(pos, region)
            );
          });
        });
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

      case 'glitchBlur':
        const glitchBlurTool = this.toolManager.getTool('glitchBlur');
        if (glitchBlurTool) {
          glitchBlurTool.drawPreview(user, user.context);
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
    this.ui.markRemoteCursorActivity(user.id);
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
    user._strokeLayer = user.activeLayer ?? 0;

    if (!user.panning) {
      if (user.tool === 'erase' && user.eraseAllLayers) {
        this.board.beginStrokeAllLayers(user, 'destination-out');
      } else if (user.tool !== 'blur' && user.tool !== 'glitchBlur' && user.tool !== 'fill' && user.tool !== 'text') {
        // Blur tool handles its own stroke creation in onPointerDown with filter metadata
        // Fill tool manages its own stroke lifecycle via the dedicated FILL message handler
        const blendMode = user.tool === 'erase' ? 'destination-out' : (user.blendMode || 'source-over');
        this.board.layerManager.beginUserStroke(this.getStrokeLayer(user), user.id, blendMode);
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
            const eraseGroup = this.board.layerManager.getLayerGroup(this.getStrokeLayer(user));
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

      case 'glitchBlur':
        if (!user.panning) {
          const glitchBlurTool = this.toolManager.getTool('glitchBlur');
          if (glitchBlurTool) {
            glitchBlurTool.onPointerDown(user, pos);
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
        if (!user.panning) {
          const circleBlurTool = this.toolManager.getTool(user.tool);
          if (circleBlurTool) {
            const radius = user.pressure * user.size;
            circleBlurTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
            circleBlurTool.stampBlurredCircle(pos.x, pos.y, radius, user);
            this.board.forEachMirrorRegion({ point: pos }, (region) => {
              const mirrored = this.board.mirrorPointToRegion(pos, region);
              circleBlurTool.stampBlurredCircle(mirrored.x, mirrored.y, radius, user, region);
            });
          }
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

      case 'pattern':
        if (!user.panning) {
          const patternTool = this.toolManager.getTool('pattern');
          if (patternTool) {
            patternTool.remoteBeginStroke(user, pos);
          }
        }
        break;

      case 'fill':
        if (!user.panning) {
          this._invalidateFillPreview(user);
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
    const strokeLayer = this.getStrokeLayer(user);
    user.remoteTarget = null;
    this._invalidateFillPreview(user, !(user.tool === 'select' && user.floatingCanvas));

    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(strokeLayer, user.id);

    const hadPenStroke = user._penStrokeActive;
    if (hadPenStroke) {
      this.penHandler.handlePenUp(user);
    }

    const hadInkStroke = user._inkStrokeActive;
    if (hadInkStroke) {
      this.inkHandler.handleInkUp(user);
    }

    if (hadPenStroke || hadInkStroke) {
      // Handled above
    } else switch (user.tool) {
      case 'brush':
        if (activeStrokeCtx && user.currentLine.length >= 2) {
          drawLineArray(user.currentLine, activeStrokeCtx, user);
          this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
            const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              drawLineArray(mirroredLine, activeStrokeCtx, user);
            });
          });
          this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
        }
        break;

      case 'line':
        if (activeStrokeCtx) {
          this.toolManager.getTool('line').drawPreview(activeStrokeCtx, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              this.toolManager.getTool('line').drawPreview(
                activeStrokeCtx,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
          const lineMargin = user.size + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], lineMargin);
        }
        break;

      case 'rectangle':
        if (activeStrokeCtx) {
          this.toolManager.getTool('rectangle').drawRect(activeStrokeCtx, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              this.toolManager.getTool('rectangle').drawRect(
                activeStrokeCtx,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
          const rectMargin = user.size + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], rectMargin);
        }
        break;

      case 'circle':
        if (activeStrokeCtx) {
          this.toolManager.getTool('circle').drawEllipse(activeStrokeCtx, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              this.toolManager.getTool('circle').drawEllipse(
                activeStrokeCtx,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
          const circleMargin = user.size + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], circleMargin);
        }
        break;

      case 'select':
        // Don't set pendingSelection or pendingLassoPath here — the authoritative
        // selection data comes via SEL_PENDING which provides the correctly simplified
        // lasso path. Setting it here from user.lassoPoints would overwrite the correct
        // path with an incomplete one (live preview only captures ~1 point per message batch).
        break;

      case 'blur':
        if (!user.panning) {
          const blurTool = this.toolManager.getTool('blur');
          if (blurTool) {
            blurTool.onPointerUp(user, pos);
          }
        }
        break;

      case 'glitchBlur':
        if (!user.panning) {
          const glitchBlurToolUp = this.toolManager.getTool('glitchBlur');
          if (glitchBlurToolUp) {
            glitchBlurToolUp.onPointerUp(user, pos);
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
        break;

      case 'pattern':
        if (!user.panning) {
          const patternTool = this.toolManager.getTool('pattern');
          if (patternTool) patternTool.remoteEndStroke(user);
        }
        break;
    }

    if (this.debugOverlay) {
      this.debugOverlay.endDrawing(user.id);
      this.debugOverlay.endStrokeTracking(user.id);
    }

    this.board.compositeAllLayers();

    // Collect erased tiles before committing (for tile ownership check)
    let erasedTiles = null;
    if (user.tool === 'erase') {
      erasedTiles = new Set();
      if (user.eraseAllLayers) {
        const count = this.board.layerManager.getLayerCount();
        for (let i = 0; i < count; i++) {
          const group = this.board.layerManager.getLayerGroup(i);
          const active = group?.activeStrokeByUser?.get(user.id);
          if (active?.affectedTiles) {
            for (const idx of active.affectedTiles) erasedTiles.add(idx);
          }
        }
      } else {
        const group = this.board.layerManager.getLayerGroup(strokeLayer);
        const active = group?.activeStrokeByUser?.get(user.id);
        if (active?.affectedTiles) {
          for (const idx of active.affectedTiles) erasedTiles.add(idx);
        }
      }
    }

    if (user.tool === 'erase' && user.eraseAllLayers) {
      this.board.endStrokeAllLayers(user);
    } else if (user.tool !== 'fill' && user.tool !== 'text') {
      // Fill tool commits its own stroke via the dedicated FILL message handler
      this.board.layerManager.commitUserStroke(strokeLayer, user.id);
    }

    // Check erased tiles and clear ownership for empty ones (don't broadcast - remote user handles that)
    if (erasedTiles && erasedTiles.size > 0) {
      this.board.compositeAllLayers();
      this.board.checkErasedTilesByIndices(erasedTiles, false);
    }

    user.clearLine();
    user.mousedown = false;
    user._strokeLayer = null;
    user.startPos = null;
    user.lassoPoints = null;

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) circleBlurTool.lastStampPos.delete(user.id);

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) glitchBlurTool.lastStampPos.delete(user.id);

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) patternTool.lastStampPos.delete(user.id);

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
    this.ui.markRemoteCursorActivity(user.id);
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

  handleTextApply(user, data) {
    if (!user || !data?.text) return;

    const layerIndex = data.layerIndex ?? user.activeLayer ?? 0;
    const blendMode = data.blendMode || user.blendMode || 'source-over';
    const textUser = {
      ...user,
      text: data.text,
      x: data.position?.x ?? user.x,
      y: data.position?.y ?? user.y,
      size: data.size ?? user.size,
      color: data.color ?? user.color,
      opacity: data.opacity ?? user.opacity,
      activeLayer: layerIndex,
      blendMode,
      font: data.font ?? user.font,
      textPositionMultiplier: data.textPositionMultiplier ?? user.textPositionMultiplier,
      textPositionOffset: data.textPositionOffset ?? user.textPositionOffset,
      getColorString() {
        return `rgba(${this.color.join(',')})`;
      }
    };

    this.board.layerManager.beginUserStroke(layerIndex, user.id, blendMode);
    this.toolManager.getTool('text').drawText(textUser);
    this.board.layerManager.commitUserStroke(layerIndex, user.id);

    user.text = '';
    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    this.ui.setRemoteTextDomVisible(user.id, true);
    this.ui.updateRemoteText(user.id, '');
    this.board.requestUpdate();
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
    const { fontSize, drawX, baselineY } = getPreviewTextLayout(user);
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(user.text, drawX, baselineY);
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

    if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
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

  handlePatternBrushLoad(user, patternDataStr) {
    const patternData = typeof patternDataStr === 'string' ? JSON.parse(patternDataStr) : patternDataStr;
    const brushData = patternData.brush;
    if (!brushData) return;

    // Apply settings immediately so they're ready when stamps arrive
    user.patternScale = patternData.scale ?? 100;
    user.patternRotation = patternData.rotation ?? 0;
    user.patternSpacing = patternData.spacing ?? 0;
    user.patternOffsetX = patternData.offsetX ?? 0;
    user.patternOffsetY = patternData.offsetY ?? 0;
    user.patternColorMode = patternData.colorMode ?? 'original';

    // Clear tile cache so it rebuilds with new brush/settings
    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) patternTool._tileCache.clear();

    if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
      const image = new Image();
      image.onload = () => {
        brushData.image = image;
        user.patternBrush = brushData;
      };
      image.onerror = () => {
        console.error(`[PatternBrush] Failed to load brush image for remote user ${user.id}`);
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
            user.patternBrush = brushData;
          }
        };
        img.onerror = () => {
          console.error(`[PatternBrush] Failed to load GIH image ${idx} for remote user ${user.id}`);
        };
        img.src = brush.gimpUrl;
        return img;
      });
    }
  }

  /**
   * Invalidate any in-flight async fill preview render and optionally clear
   * the user's preview canvas immediately.
   * @param {User} user
   * @param {boolean} [clearCanvas=true]
   * @returns {void}
   */
  _invalidateFillPreview(user, clearCanvas = true) {
    if (!user) return;
    user._fillPreviewToken = (user._fillPreviewToken || 0) + 1;
    if (clearCanvas && user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
  }

  /**
   * Deep-clean all transient renderer state associated with a remote user.
   * Optionally bakes their visible drawing into the permanent layer state first.
   * @param {User} user
   * @param {{preserveVisuals?: boolean}} [options={}]
   */
  cleanupUserState(user, options = {}) {
    if (!user) return;
    const preserveVisuals = options.preserveVisuals === true;

    if (preserveVisuals) {
      this.board.layerManager?.deepCleanupUserState?.(user.id, { preserveVisuals: true });
    } else {
      this.board.layerManager?.deepCleanupUserState?.(user.id, { preserveVisuals: false });
    }

    this._cleanupTransientUserState(user);
    this.board.requestUpdate();
  }

  _disposeCanvasElement(canvas) {
    if (!canvas) return;
    if (typeof canvas.close === 'function') {
      try { canvas.close(); } catch (_) {}
    }
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Clear room-level remote caches that are not tied to a single remaining user.
   */
  resetTransientState() {
    this.selectionHandler?.stopRemoteSelectionAnimation?.();
    if (this.selectionHandler?._patternTileCache) {
      for (const tile of this.selectionHandler._patternTileCache.values()) {
        this._disposeCanvasElement(tile);
      }
      this.selectionHandler._patternTileCache.clear();
    }

    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) {
      blurTool.lastStampPos?.clear?.();
      blurTool.strokePoints?.clear?.();
      blurTool._activeUser = null;
    }

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) {
      circleBlurTool.lastStampPos?.clear?.();
      circleBlurTool._activeUser = null;
    }

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) {
      glitchBlurTool.lastStampPos?.clear?.();
      glitchBlurTool.strokePoints?.clear?.();
      glitchBlurTool._activeUser = null;
    }

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) {
      imageBrushTool.lastStampPos?.clear?.();
      imageBrushTool._activeUser = null;
      imageBrushTool.strokePoints = [];
      imageBrushTool.stampBuffer = [];
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      patternTool.lastStampPos?.clear?.();
      for (const tile of patternTool._tileCache?.values?.() || []) {
        this._disposeCanvasElement(tile);
      }
      for (const offscreen of patternTool.remoteOffscreens?.values?.() || []) {
        this._disposeCanvasElement(offscreen?.canvas);
        offscreen.ctx = null;
      }
      patternTool.remoteOffscreens?.clear?.();
      patternTool._tileCache?.clear?.();
      patternTool._activeUser = null;
      patternTool.strokePoints = [];
      patternTool.stampBuffer = [];
      this._disposeCanvasElement(patternTool.offscreenCanvas);
      patternTool.offscreenCanvas = null;
      patternTool.offscreenCtx = null;
      patternTool.dirtyBounds = null;
    }

    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool) {
      pixelTool.lastStampPos?.clear?.();
      for (const canvas of pixelTool.tempCanvases?.values?.() || []) {
        this._disposeCanvasElement(canvas);
      }
      pixelTool.tempCanvases?.clear?.();
      pixelTool._activeUser = null;
      pixelTool.strokePoints = [];
      pixelTool.stampBuffer = [];
    }

    const fillTool = this.toolManager.getTool('fill');
    fillTool?._cancelInteractive?.();
  }

  getDebugStats() {
    let remoteSelections = 0;
    for (const [id, user] of this.users.entries()) {
      if (id === this.sessionIndex) continue;
      if (user?.floatingCanvas || user?.pendingSelection) {
        remoteSelections++;
      }
    }

    return {
      remoteSelections,
      remoteSelectionAnimationActive: !!this.selectionHandler?.remoteSelectionAnimationId,
      remotePatternPreviewCaches: this.selectionHandler?._patternTileCache?.size ?? 0,
      remotePatternOffscreens: this.toolManager.getTool('pattern')?.remoteOffscreens?.size ?? 0,
      remotePixelTempCanvases: this.toolManager.getTool('pixel')?.tempCanvases?.size ?? 0,
      remoteBlurTracks: this.toolManager.getTool('blur')?.strokePoints?.size ?? 0,
      remoteGlitchTracks: this.toolManager.getTool('glitchBlur')?.strokePoints?.size ?? 0
    };
  }

  _cleanupTransientUserState(user) {
    if (this.debugOverlay) {
      this.debugOverlay.cancelDrawing(user.id);
      this.debugOverlay.endDrawing?.(user.id);
      this.debugOverlay.endStrokeTracking?.(user.id);
    }

    this._invalidateFillPreview(user);
    this.selectionHandler?._cleanupUserSelection?.(user);

    user.clearLine();
    user.mousedown = false;
    user._strokeLayer = null;
    user.startPos = null;
    user.pendingSelection = null;
    user.pendingLassoPath = null;
    user.remoteTarget = null;
    user.selection = null;
    user.selectionCorners = null;
    user.originalCorners = null;
    user.originalSelectionPos = null;
    user.lassoPath = null;
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.homography = null;
    user.previewHomography = null;
    this._disposeCanvasElement(user._cachedPreviewCanvas);
    user._selectionRestoreData = null;
    user._cachedPreviewCanvas = null;
    user._cachedPreviewBounds = null;
    user.penPoints = [];
    user._penLastStampPos = null;
    user._penStrokeActive = false;
    user._penStrokeColor = null;
    user._penAlpha = null;
    if (user._penOffscreenCtx && user._penOffscreen) {
      user._penOffscreenCtx.clearRect(0, 0, user._penOffscreen.width, user._penOffscreen.height);
    }
    this._disposeCanvasElement(user._penOffscreen);
    user._penOffscreen = null;
    user._penOffscreenCtx = null;

    user._inkPoints = [];
    user._inkStrokeActive = false;
    user._inkStrokeColor = null;
    user._inkAlpha = null;
    if (user._inkCtx && user._inkOffscreen) {
      user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);
    }
    this._disposeCanvasElement(user._inkOffscreen);
    user._inkOffscreen = null;
    user._inkCtx = null;

    delete user.blurBounds;
    delete user.glitchStamps;
    user.lastBlurPos = null;
    user.imageBrush = null;
    user.patternBrush = null;

    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) {
      blurTool.lastStampPos.delete(user.id);
      blurTool.strokePoints.delete(user.id);
    }

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) circleBlurTool.lastStampPos.delete(user.id);

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) {
      glitchBlurTool.lastStampPos.delete(user.id);
      glitchBlurTool.strokePoints.delete(user.id);
    }

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      patternTool.lastStampPos.delete(user.id);
      const offscreen = patternTool.remoteOffscreens.get(user.id);
      if (offscreen) {
        this._disposeCanvasElement(offscreen.canvas);
        offscreen.ctx = null;
      }
      patternTool.remoteOffscreens.delete(user.id);
    }

    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool) {
      pixelTool.lastStampPos.delete(user.id);
      const tempCanvas = pixelTool.tempCanvases.get(user.id);
      this._disposeCanvasElement(tempCanvas);
      pixelTool.tempCanvases.delete(user.id);
    }

    if (user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
  }

  /**
   * Cancels a remote user's active stroke and cleans up state.
   *
   * @param {User} user - The remote user whose stroke is being cancelled.
   * @returns {void}
   */
  handleCancel(user) {
    this.board.layerManager.cancelUserStroke(this.getStrokeLayer(user), user.id);
    this._cleanupTransientUserState(user);
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
  async _drawFillPreview(user, pos) {
    const fillTool = this.toolManager.getTool('fill');
    if (!fillTool) return;
    const previewToken = user._fillPreviewToken || 0;

    const width = this.board.getWidth();
    const height = this.board.getHeight();
    const x = Math.floor(pos.x);
    const y = Math.floor(pos.y);
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const imageData = this.board.mainCtx.getImageData(0, 0, width, height);
    let result = await fillTool._fillWorker.computeFill(
      imageData.data, width, height, x, y, 10, 0, null
    );
    if (!result || previewToken !== (user._fillPreviewToken || 0) || !user.mousedown || user.tool !== 'fill') return;

    // Apply tile constraint if fill is too large (same logic as local FloodFillTool)
    if (fillTool._isFillTooLarge(result, width, height)) {
      const tileRects = fillTool._getOccupiedTileRects(x, y);
      if (tileRects) {
        const constrainedResult = await fillTool._fillWorker.computeFill(
          this.board.mainCtx.getImageData(0, 0, width, height).data,
          width, height, x, y, 10, 0, tileRects
        );
        if (constrainedResult) {
          result = constrainedResult;
        } else {
          return; // Can't constrain a too-large fill
        }
      } else {
        return; // No tiles occupied, can't allow huge fill
      }
    }

    if (previewToken !== (user._fillPreviewToken || 0) || !user.mousedown || user.tool !== 'fill') return;

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

    user.context.clearRect(0, 0, width, height);
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

    this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
      const p1 = this.board.mirrorPointToRegion({ x: minX, y: minY }, region);
      const p2 = this.board.mirrorPointToRegion({ x: maxX, y: maxY }, region);
      const mx = Math.floor(Math.min(p1.x, p2.x) - margin);
      const my = Math.floor(Math.min(p1.y, p2.y) - margin);
      const mw = Math.ceil(Math.max(p1.x, p2.x) - Math.min(p1.x, p2.x) + margin * 2);
      const mh = Math.ceil(Math.max(p1.y, p2.y) - Math.min(p1.y, p2.y) + margin * 2);
      this.board.expandDirtyRect(user, mx, my, mw, mh);
    });

    // Track occupied tiles for remote users (non-erase operations)
    const tt = this.board.tileTracker;
    if (tt && user.tool !== 'erase') {
      const userId = user.id;
      const radius = user.size || margin;

      // Get the active stroke to collect affectedTiles (same as local implementation)
      const group = this.board.layerManager?.layerGroups[this.getStrokeLayer(user)];
      const active = group?.activeStrokeByUser?.get(userId);

      tt.markPathDirty(points, radius, active?.affectedTiles);

      // Also track mirrored tiles
      this.board.forEachMirrorRegion({ points }, (region) => {
        tt.markPathDirty(this.board.mirrorPointsToRegion(points, region), radius, active?.affectedTiles);
      });
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

    const activeStrokeCtx = this.board.layerManager.getUserStrokeContext(this.getStrokeLayer(user), user.id);
    if (activeStrokeCtx) {
      if (user.tool === 'brush' && user.currentLine.length >= 2) {
        drawLineArray(user.currentLine, activeStrokeCtx, user);
        this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
          const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
          this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
            drawLineArray(mirroredLine, activeStrokeCtx, user);
          });
        });
        this._expandDirtyRectFromPoints(user, user.currentLine, this._brushMargin(user));
      }

      if (user.currentLine.length > 0 && oldRadius !== newRadius) {
        const from = lastDrawnPos;
        bridgeGap(activeStrokeCtx, from, lastDrawnPos, oldRadius, newRadius, user);
        this.board.forEachMirrorRegion({ points: [from, lastDrawnPos] }, (region) => {
          this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
            bridgeGap(
              activeStrokeCtx,
              this.board.mirrorPointToRegion(from, region),
              this.board.mirrorPointToRegion(lastDrawnPos, region),
              oldRadius,
              newRadius,
              user
            );
          });
        });
      }
    }

    user.clearLine();
    user.addToLine(lastDrawnPos);
    this.board.compositeAllLayers();
  }
}
