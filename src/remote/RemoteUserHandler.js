/**
 * @fileoverview Handles synchronization of remote user drawing actions.
 * Manages remote cursors, drawing tool routing, and position interpolation.
 */

import { drawLineArray, bridgeGap } from '../utils/drawing.js';
import { SELECTION_MODES, getNextBrushIndex } from '../utils/parseGimp.js';
import { resetSmoothingBuffer, applySmoothingEMA } from '../utils/smoothing.js';
import { getPreviewTextLayout, getUserTextLineHeight } from '../utils/textLayout.js';
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
    this.catchupInterval = 33; // 30 FPS (was 16ms / 62.5 FPS)
    /** @type {number|null} */
    this.catchupTimer = null;
    this.pendingGlitchUndoByUser = new Map();
    this.pendingGlitchImagesByUser = new Map();
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

  _usesLayeredRemotePreview(user) {
    return !!user && [
      'brush',
      'line',
      'rectangle',
      'circle',
      'flowPen',
      'ink',
      'pixel',
      'pattern'
    ].includes(user.tool);
  }

  _syncLayeredRemotePreview(user, dirtyRect = null) {
    if (!this._usesLayeredRemotePreview(user) || !user?.context?.canvas) return;

    if (!user.mousedown || user.panning) {
      this._clearLayeredRemotePreview(user);
      return;
    }

    const layerIndex = this.getStrokeLayer(user);
    if (!this.board.layerManager?.isLayerVisible?.(layerIndex)) {
      this._clearLayeredRemotePreview(user);
      return;
    }

    const blendMode = this.board.layerManager.getLayerAllowComplexBlendModes(layerIndex)
      ? (user.blendMode || 'source-over')
      : 'source-over';
    this.board.layerManager.setUserPreviewStroke(layerIndex, user.id, user.context.canvas, blendMode, dirtyRect);
    user._layeredPreviewActive = true;
    if (user.board) user.board.style.opacity = '0';

    if (dirtyRect && Number.isFinite(dirtyRect.x) && Number.isFinite(dirtyRect.y) && dirtyRect.width > 0 && dirtyRect.height > 0) {
      this.board.compositeTileGrid?.markRect(dirtyRect.x, dirtyRect.y, dirtyRect.width, dirtyRect.height);
    } else {
      this.board.markCompositeFull?.();
    }
    this.board.requestUpdate?.();
  }

  _clearLayeredRemotePreview(user) {
    if (!user) return;
    this.board.layerManager?.clearUserPreviewStroke?.(user.id);
    if (user._layeredPreviewActive && user.board) {
      user.board.style.opacity = '';
    }
    user._layeredPreviewActive = false;
  }

  updateRemotePreviewPresentation(user) {
    if (!user?.board) return;

    const isActiveEraser = user.tool === 'erase' && user.mousedown && !user.panning;
    if (!user._layeredPreviewActive) {
      user.board.style.opacity = isActiveEraser ? '0' : '';
    }

    const blendMode = user.tool === 'erase' ? 'source-over' : (user.blendMode || 'source-over');
    user.board.style.mixBlendMode = this.app.blendModeManager.toCSSBlendMode(blendMode);
  }

  /**
   * Processes remote mouse movement and updates drawing state.
   *
   * @param {User} user - The remote user moving their mouse.
   * @param {Object} data - Movement data payload containing points and radii.
   * @returns {void}
   */
  handleMouseMove(user, data) {
    if (user.id === this.app.sessionIndex) return;

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
    if (user.tool === 'confetti' && data.confettiData) {
      this.toolManager.getTool('confetti')?.applyNetworkSettings?.(user, data.confettiData);
    }

    // Pattern tool doesn't depend on radii - handle separately
    if (!user.panning && user.mousedown && user.tool === 'pattern') {
      if (user._patternPendingStrokes) {
        user._patternPendingStrokes.push({ type: 'stamps', pts: [...smoothedPoints] });
        return;
      }
      const tool = this.toolManager.getTool('pattern');
      if (tool) tool.remoteStampMask(user, smoothedPoints);
      this._syncLayeredRemotePreview(user);
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      this.app.boardViewer?.requestLiveRender?.();
      return;
    }

    // Ink: always batch-route through inkHandler so local and remote follow the
    // same perfect-freehand pipeline. When the sender sent uniform pressures it
    // omits `rs` (broadcastMove path) — synthesize a uniform radii array from
    // user.pressure as-is. Do NOT coerce a 0 to a positive value: a transient
    // pressure=0 sample must keep being filtered by handleInkPoints' skip-guard,
    // otherwise a liftoff sample renders as a full-size 100% dot.
    if (!user.panning && user.mousedown && user.tool === 'ink') {
      const inkRadii = (radii && radii.length > 0)
        ? radii
        : new Array(smoothedPoints.length / 2).fill(Math.round((user.pressure ?? 1) * 255));
      this.inkHandler.handleInkPoints(user, smoothedPoints, inkRadii);
      this._syncLayeredRemotePreview(user);
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      this.app.boardViewer?.requestLiveRender?.();
      return;
    }

    if (!user.panning && user.mousedown && radii && radii.length > 0) {
      if (user.tool === 'pixel' || user.tool === 'imageBrush' || user.tool === 'confetti') {
        if (user.tool === 'imageBrush' && user.imageBrush?._pendingStrokes) {
          user.imageBrush._pendingStrokes.push({ type: 'stamps', pts: [...smoothedPoints] });
        } else {
          const tool = this.toolManager.getTool(user.tool);
          if (tool) tool.applyStamps(user, smoothedPoints, radii);
          if (user.tool === 'pixel') this._syncLayeredRemotePreview(user);
        }
      } else if (user.tool === 'circleBlur') {
        const tool = this.toolManager.getTool(user.tool);
        if (tool) tool.applyStamps(user, smoothedPoints, radii);
      } else {
        this.penHandler.handlePenStamps(user, smoothedPoints, radii);
        this._syncLayeredRemotePreview(user);
      }
      if (smoothedPoints.length >= 2) {
        this.ui.updateRemoteCursor(user.id, smoothedPoints[smoothedPoints.length - 2], smoothedPoints[smoothedPoints.length - 1], user.size);
      }
      this.app.boardViewer?.requestLiveRender?.();
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
      this.app.boardViewer?.requestLiveRender?.();
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

    // Tools that use EMA smoothing locally — catchup must match
    const smoothingTools = new Set(['brush', 'flowPen', 'imageBrush', 'ink', 'erase']);
    // Stamp-based tools: catchup should only update cursor, not generate new stamps.
    // Stamps come exclusively from sender's broadcast messages.
    const stampTools = new Set(['flowPen', 'ink', 'pixel', 'circleBlur', 'imageBrush', 'confetti']);

    for (const user of this.users.values()) {
      if (user.mousedown && !user.panning && user.remoteTarget) {
        const dx = user.remoteTarget.x - user.smoothBuffer.x;
        const dy = user.remoteTarget.y - user.smoothBuffer.y;
        const distSq = dx * dx + dy * dy;

        if (distSq > 0.25) {
          anyActive = true;
          const lastPos = { x: user.x, y: user.y };

          let pos;
          const userSmoothing = user.smoothing !== undefined ? user.smoothing : 0;

          // Apply EMA smoothing for tools that use it locally, matching InputBufferManager behavior
          if (smoothingTools.has(user.tool) && userSmoothing > 0) {
            const smoothed = applySmoothingEMA(
              user.smoothBuffer,
              user.remoteTarget.x,
              user.remoteTarget.y,
              user.pressure || 1,
              userSmoothing,
              0.12
            );
            pos = { x: smoothed.x, y: smoothed.y };
          } else {
            // No smoothing: snap directly to target
            pos = { x: user.remoteTarget.x, y: user.remoteTarget.y };
            user.smoothBuffer.x = pos.x;
            user.smoothBuffer.y = pos.y;
          }

          user.setPosition(pos.x, pos.y);
          this.ui.updateRemoteCursor(user.id, pos.x, pos.y, user.size);

          // Skip renderRemoteMove for stamp tools - stamps come from sender's broadcasts only.
          // Calling renderRemoteMove would generate extra stamps not present in sender's output.
          if (!stampTools.has(user.tool)) {
            this.renderRemoteMove(user, pos, lastPos);
          }
          this.app.boardViewer?.requestLiveRender?.();
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
        if (eraserTool) {
          eraserTool.appendBufferedPoint(user, pos);
        }
        break;
        // Skip erasing if pressure is 0 — liftoff sample, no visible effect intended.
      }

      case 'blur':
        const blurTool = this.toolManager.getTool('blur');
        if (blurTool) {
          user.lastBlurPos = pos;
          blurTool.onPointerMove(user, pos, lastPos);
        }
        break;

      case 'glitchBlur': {
        // Glitch blur is non-deterministic, so remote clients wait for the
        // sender's rendered stamp image (GLITCH_RESULT) instead of recomputing
        // the (expensive) WASM stroke. To avoid a blank canvas in the meantime,
        // paint a cheap grey-square placeholder trail onto the user's preview
        // canvas; it's cleared on mouseUp when the real result lands.
        const glitchTool = this.toolManager.getTool('glitchBlur');
        if (glitchTool && user.context) {
          glitchTool.drawPlaceholderAlong(user, user.context, lastPos, pos);
          // Track mirror regions in realtime like the sender's live stroke
          // does (_compositeStampWithMirrors) — otherwise the mirrored halves
          // pop in all at once when GLITCH_RESULT lands.
          this.board.forEachMirrorRegion({ points: lastPos ? [lastPos, pos] : [pos] }, (region) => {
            this.board.withMirroredRegionTransform(user.context, region, () => {
              glitchTool.drawPlaceholderAlong(user, user.context, lastPos, pos);
            });
          });
        }
        break;
      }

      case 'pixel': {
        const pixelTool = this.toolManager.getTool('pixel');
        if (pixelTool) {
          pixelTool.onPointerMove(user, pos, lastPos);
        }
        break;
      }

      case 'flowPen':
        this.penHandler.handlePenMove(user, pos);
        this._syncLayeredRemotePreview(user);
        break;

      case 'ink': {
        const pressure255 = Math.round((user.pressure ?? 1) * 255);
        this.inkHandler.handleInkPoints(user, [pos.x, pos.y], [pressure255]);
        this._syncLayeredRemotePreview(user);
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
          if (user.imageBrush._pendingStrokes) {
            user.imageBrush._pendingStrokes.push({ type: 'stamps', pts: [pos.x, pos.y] });
            break;
          }
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            imageBrushTool.onPointerMove(user, pos);
          }
        }
        break;

      case 'confetti': {
        const confettiTool = this.toolManager.getTool('confetti');
        if (confettiTool) confettiTool.onPointerMove(user, pos);
        break;
      }
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
    const needsClear = ['brush', 'line', 'rectangle', 'circle', 'erase', 'text'].includes(user.tool);
    if (needsClear && !(user.tool === 'select' && user.floatingCanvas)) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    switch (user.tool) {
      case 'text':
        // DOM text element handles the preview; no canvas drawing needed here
        break;

      case 'brush':
        if (user.currentLine.length >= 2) {
          this.board.withSelectionMaskClip(user.context, user.id, () => {
            drawLineArray(user.currentLine, user.context, user, this.board);
            this.board.forEachMirrorRegion({ points: user.currentLine }, (region) => {
              const mirroredLine = this.board.mirrorPointsToRegion(user.currentLine, region);
              this.board.withMirrorRegionClip(user.context, region, () => {
                drawLineArray(mirroredLine, user.context, user, this.board);
              });
            });
          });
        }
        break;

      case 'line':
        this.toolManager.getTool('line').drawPreviewOnContext(user.context, user, user.startPos, pos);
        break;

      case 'rectangle':
        this.board.withSelectionMaskClip(user.context, user.id, () => {
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
        });
        break;

      case 'circle':
        this.board.withSelectionMaskClip(user.context, user.id, () => {
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
        });
        break;

      case 'select':
        // Selection previews are rendered from SEL_PENDING so remote viewers
        // follow the authoritative selection path/bounds instead of a second
        // local reconstruction from cursor motion.
        break;

      case 'erase':
        this.toolManager.getTool('erase')?.drawPreview(user, user.context);
        break;

    }

    this.board.maskPreviewForExistingMode?.(user.context, user);

    if (user.isMaskMode && user.maskSelection) {
      this.selectionHandler?.drawStaticMaskOutline(user, user.maskSelection, false);
    }

    this._syncLayeredRemotePreview(user);
  }

  /**
   * Handles remote mouse down events.
   *
   * @param {User} user - The remote user.
   * @param {Object} [data={}] - Event data containing starting points.
   * @returns {void}
   */
  handleMouseDown(user, data = {}) {
    if (user.id === this.app.sessionIndex) return;

    this.ui.markRemoteCursorActivity(user.id);
    user.mousedown = true;
    user._mainCtxDrawCount = 0;
    if (data.layerIndex !== undefined) user.setActiveLayer(data.layerIndex);
    if (data.blendMode !== undefined) user.setBlendMode(data.blendMode);
    if (data.blendBakeMode !== undefined) user.setBlendBakeMode(data.blendBakeMode);
    if (user.tool === 'confetti' && data.confettiData) {
      this.toolManager.getTool('confetti')?.applyNetworkSettings?.(user, data.confettiData);
    }
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
        const strokeLayer = this.getStrokeLayer(user);
        this.board.layerManager.beginUserStroke(strokeLayer, user.id, blendMode, user.blendBakeMode);
        this.board.applySelectionMaskClipForStroke(strokeLayer, user.id);
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
        this._syncLayeredRemotePreview(user);
        break;

      case 'ink':
        this.inkHandler.handleInkDown(user, pos);
        this._syncLayeredRemotePreview(user);
        break;

      case 'erase':
        if (user.panning) {
          break;
        }
        {
          this.updateRemotePreviewPresentation(user);
          const eraserTool = this.toolManager.getTool('erase');
          if (eraserTool) {
            eraserTool.onPointerDown(user, pos);
          }
          break;
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

      case 'glitchBlur': {
        // The drawing client sends the rendered glitch stamps via GLITCH_RESULT.
        // Until then, show a cheap grey-square placeholder on the user's preview
        // canvas so the in-progress stroke is visible (live remote + replay).
        const glitchTool = this.toolManager.getTool('glitchBlur');
        if (glitchTool && user.context) {
          user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          // Keep the preview canvas neutral + visible: the placeholder is plain
          // grey and the baked result travels source-over, so no blend here.
          if (user.board) {
            user.board.style.opacity = '';
            user.board.style.mixBlendMode = 'normal';
          }
          glitchTool.drawPlaceholderAlong(user, user.context, pos, pos);
          this.board.forEachMirrorRegion({ point: pos }, (region) => {
            this.board.withMirroredRegionTransform(user.context, region, () => {
              glitchTool.drawPlaceholderAlong(user, user.context, pos, pos);
            });
          });
        }
        break;
      }

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
            circleBlurTool.beginSnapshot(user.id);
            circleBlurTool.strokePoints?.set?.(user.id, [{ x: pos.x, y: pos.y }]);
            circleBlurTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y, radius });
            circleBlurTool.stampBlurredCircle(pos.x, pos.y, radius, user);
            this.board.forEachMirrorRegion({ point: pos }, (region) => {
              const mirrored = this.board.mirrorPointToRegion(pos, region);
              circleBlurTool.stampBlurredCircle(mirrored.x, mirrored.y, radius, user, region);
            });
          }
        }
        break;


    if (!user.panning && ['brush', 'line', 'rectangle', 'circle', 'erase'].includes(user.tool)) {
      this.renderRemotePreview(user, pos);
      this.app.boardViewer?.requestLiveRender?.();
    }
      case 'imageBrush':
        if (user.imageBrush && !user.panning) {
          if (user.imageBrush._pendingStrokes) {
            user.imageBrush._pendingStrokes.push({ type: 'down', pos: { ...pos } });
            return;
          }
          if (user.imageBrush.type === 'gih' && user.imageBrush.reset) {
            user.imageBrush.reset();
          }
          const imageBrushTool = this.toolManager.getTool('imageBrush');
          if (imageBrushTool) {
            user._imageBrushLastPos = { x: pos.x, y: pos.y };
            user._imageBrushLastTime = performance.now();
            user._imageBrushDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            user._imageBrushStrokePoints = [{ x: pos.x, y: pos.y }];
            imageBrushTool.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
            imageBrushTool.drawStamp(user, pos);
          }
        }
        break;

      case 'confetti': {
        if (!user.panning) {
          const confettiTool = this.toolManager.getTool('confetti');
          if (confettiTool) confettiTool.onPointerDown(user, pos);
        }
        break;
      }

      case 'pattern':
        if (!user.panning) {
          // Buffer until the pattern image decodes — see handlePatternBrushLoad.
          if (user._patternPendingStrokes) {
            user._patternPendingStrokes.push({ type: 'down', pos: { ...pos } });
            return;
          }
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
  handleMouseUp(user, seq = 0) {
    // Self-reconciliation: If this is the local user's own 'mu' message, it
    // contains the server-assigned sequence number for the stroke they just
    // optimistically committed. Update the record in LayerManager so global
    // ordering is consistent across all clients.
    if (user.id === this.app.sessionIndex) {
      // Self-echo of our own MU: assign the authoritative global seq to our
      // oldest still-optimistic stroke (search all layers — we may have switched
      // layers before the echo returned). Reconcile-only; we already drew it.
      // Do NOT touch user.mousedown here: the echo is async and may land after
      // we've already begun a *new* local stroke, and clobbering it would break
      // that stroke. The local pointer handlers own mousedown.
      this.board.layerManager.reconcileOldestLocalStroke(user.id, seq);
      return;
    }

    if (!user.mousedown) return;

    if (user.tool === 'imageBrush' && user.imageBrush?._pendingStrokes) {
      user.imageBrush._pendingStrokes.push({ type: 'up', seq });
      user.mousedown = false; // Stop further mouse move processing
      return;
    }

    // Same for a pattern stroke still waiting on its image to decode. Returning
    // before the commit machinery leaves the active stroke open; replayPending
    // re-enters here once the tile can actually be built, so the commit happens
    // with real pixels and this MU's authoritative seq.
    if (user.tool === 'pattern' && user._patternPendingStrokes) {
      user._patternPendingStrokes.push({ type: 'up', seq });
      user.mousedown = false;
      return;
    }

    const pos = { x: user.x, y: user.y };
    const strokeLayer = this.getStrokeLayer(user);
    user.remoteTarget = null;
    if (user.tool === 'fill') {
      this._invalidateFillPreview(user);
    }

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
          // drawPreviewOnContext already draws the mirrored copies internally
          // (unlike drawRect/drawEllipse below) — wrapping it in another
          // forEachMirrorRegion pass drew every line twice on both sides of
          // the mirror (mirror-of-mirror lands back on the original).
          this.toolManager.getTool('line').drawPreviewOnContext(activeStrokeCtx, user, user.startPos, pos);
          // Mirror LineTool.onPointerUp margin so the hardness blur halo is
          // included in the dirtyRect, otherwise commitUserStroke crops the
          // halo off and observers' committed stroke disagrees with drawer's.
          const lineRadius = user.size;
          const lineHardness = (user.hardness !== undefined ? user.hardness : 100) / 100;
          const lineBlur = lineHardness < 1.0 ? (1 - lineHardness) * (20 + user.size * 0.2) : 0;
          const lineMargin = lineRadius + lineBlur + lineRadius * 0.1 + 2;
          this._expandDirtyRectFromPoints(user, [user.startPos, pos], lineMargin);
        }
        break;

      case 'rectangle':
        if (activeStrokeCtx) {
          const rectangleTool = this.toolManager.getTool('rectangle');
          rectangleTool.drawRect(activeStrokeCtx, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              rectangleTool.drawRect(
                activeStrokeCtx,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
          const rectMargin = this._brushMargin(user);
          // Same mode the paint above resolved from the user, or the dirty rect
          // crops the committed record to different bounds than were drawn.
          const rectBounds = rectangleTool.getRectBounds(
            user.startPos, pos, false, user.shapeDrawMode
          );
          this._expandDirtyRectFromRect(user, rectBounds, rectMargin);
        }
        break;

      case 'circle':
        if (activeStrokeCtx) {
          const circleTool = this.toolManager.getTool('circle');
          circleTool.drawEllipse(activeStrokeCtx, user, user.startPos, pos);
          this.board.forEachMirrorRegion({ points: [user.startPos, pos] }, (region) => {
            this.board.withMirrorRegionClip(activeStrokeCtx, region, () => {
              circleTool.drawEllipse(
                activeStrokeCtx,
                user,
                this.board.mirrorPointToRegion(user.startPos, region),
                this.board.mirrorPointToRegion(pos, region)
              );
            });
          });
          const circleMargin = this._brushMargin(user);
          const ellipse = circleTool.getEllipseParams(
            user.startPos, pos, false, user.shapeDrawMode
          );
          this._expandDirtyRectFromRect(user, {
            x: ellipse.cx - ellipse.rx,
            y: ellipse.cy - ellipse.ry,
            w: ellipse.rx * 2,
            h: ellipse.ry * 2
          }, circleMargin);
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
            blurTool.onPointerUp(user, pos, { seq });
          }
        }
        break;

      case 'glitchBlur':
        // Committed when GLITCH_RESULT arrives.
        break;

      case 'pixel':
        if (!user.panning) {
          const pixelTool = this.toolManager.getTool('pixel');
          if (pixelTool) {
            pixelTool.onPointerUp(user, pos, { seq });
          }
        }
        break;

      case 'erase': {
        const eraserTool = this.toolManager.getTool('erase');
        if (eraserTool) {
          eraserTool.commitCurrentLine(user, user.pressure, user.size, user.opacity, false, { seq });
        }
        break;
      }

      case 'text':
        break;

      case 'pattern':
        if (!user.panning) {
          const patternTool = this.toolManager.getTool('pattern');
          if (patternTool) patternTool.remoteEndStroke(user, seq);
        }
        break;
    }

    if (this.debugOverlay) {
      this.debugOverlay.endDrawing(user.id);
      this.debugOverlay.endStrokeTracking(user.id);
    }

    // Remove the transient layered preview before committing/compositing the
    // finished stroke, otherwise the final composite can keep drawing the
    // preview canvas until the next remote stroke invalidates it.
    this._clearLayeredRemotePreview(user);

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
      this.board.endStrokeAllLayers(user, { seq });
    } else if (user.tool !== 'fill' && user.tool !== 'text' && user.tool !== 'glitchBlur') {
      // Fill tool commits its own stroke via the dedicated FILL message handler
      this.board.releaseSelectionMaskClipForStroke(strokeLayer, user.id);
      this.board.layerManager.commitUserStroke(strokeLayer, user.id, { seq });
      if (this.board._compositeCommittedStrokeNow) {
        this.board._compositeCommittedStrokeNow();
      } else {
        this.board.compositeAllLayers();
      }
    }

    if (user.tool === 'fill' || user.tool === 'text') {
      this.board.compositeAllLayers();
    }

    if (!(user.tool === 'select' && user.floatingCanvas) && user.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      if (user.context.canvas) {
        user.context.canvas.style.opacity = '';
      }
      if (user.isMaskMode && user.maskSelection) {
        this.selectionHandler?.drawStaticMaskOutline(user, user.maskSelection, false);
      }
    }
    this._clearLayeredRemotePreview(user);

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
    this.updateRemotePreviewPresentation(user);

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) {
      circleBlurTool.lastStampPos.delete(user.id);
      circleBlurTool.clearSnapshot(user.id);
      circleBlurTool.strokePoints?.delete?.(user.id);
    }

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) glitchBlurTool.lastStampPos.delete(user.id);

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);
    delete user._imageBrushLastPos;
    delete user._imageBrushLastTime;
    delete user._imageBrushDirtyBounds;
    delete user._imageBrushStrokePoints;

    const confettiTool = this.toolManager.getTool('confetti');
    if (confettiTool) confettiTool.lastStampPos.delete(user.id);
    delete user._confettiDirtyBounds;
    delete user._confettiStrokePoints;

    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool) {
      pixelTool.lastStampPos.delete(user.id);
      const tempCanvas = pixelTool.tempCanvases.get(user.id);
      this._disposeCanvasElement(tempCanvas);
      pixelTool.tempCanvases.delete(user.id);
    }
    delete user._pixelStrokePoints;
    delete user._pixelPreviewDirtyBounds;

    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.lastPos?.delete?.(user.id);

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

  queueRemoteGlitchImage(user, bounds, layerIndex = null, seq = 0, blendMode = null, blendBakeMode = null) {
    if (!user || !bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const token = { user, bounds, layerIndex, seq, blendMode, blendBakeMode, resultCanvas: null, canceled: false };
    const queue = this.pendingGlitchImagesByUser.get(user.id) || [];
    queue.push(token);
    this.pendingGlitchImagesByUser.set(user.id, queue);
    return token;
  }

  resolveRemoteGlitchImage(token, resultCanvas) {
    if (!token || token.canceled) {
      this._processPendingGlitchImages(token?.user?.id);
      return;
    }
    token.resultCanvas = resultCanvas;
    this._processPendingGlitchImages(token.user.id);
  }

  cancelLatestPendingGlitchImage(userId) {
    const queue = this.pendingGlitchImagesByUser.get(userId);
    if (!queue?.length) return false;

    for (let i = queue.length - 1; i >= 0; i--) {
      const token = queue[i];
      if (!token.canceled) {
        token.canceled = true;
        this._processPendingGlitchImages(userId);
        return true;
      }
    }
    return false;
  }

  /**
   * Seq of the latest in-flight (queued, not yet committed) glitch stamp for a
   * user — i.e. the token cancelLatestPendingGlitchImage would cancel. Glitch
   * stamps commit asynchronously (image decode), so an undo can arrive before the
   * stamp lands in the strokeStack; the caller uses this seq to decide whether the
   * undo actually targets the in-flight glitch (vs a later committed stroke).
   * @param {number} userId
   * @returns {number} The latest pending glitch seq, or -1 if none is in flight.
   */
  getLatestPendingGlitchSeq(userId) {
    const queue = this.pendingGlitchImagesByUser.get(userId);
    if (!queue?.length) return -1;

    for (let i = queue.length - 1; i >= 0; i--) {
      if (!queue[i].canceled) return queue[i].seq || 0;
    }
    return -1;
  }

  _processPendingGlitchImages(userId) {
    if (userId == null) return;
    const queue = this.pendingGlitchImagesByUser.get(userId);
    if (!queue?.length) return;

    while (queue.length > 0) {
      const token = queue[0];
      if (token.canceled) {
        queue.shift();
        continue;
      }
      if (!token.resultCanvas) break;
      queue.shift();
      this.commitRemoteGlitchImage(token.user, token.resultCanvas, token.bounds, token.layerIndex, token.seq, token.blendMode, token.blendBakeMode);
    }

    if (queue.length === 0) {
      this.pendingGlitchImagesByUser.delete(userId);
    }
  }

  commitRemoteGlitchImage(user, resultCanvas, bounds, layerIndex = null, seq = 0, blendModeOverride = null, blendBakeModeOverride = null) {
    if (!user || !resultCanvas || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const pendingUndoCount = this.pendingGlitchUndoByUser.get(user.id) || 0;
    if (pendingUndoCount > 0) {
      if (pendingUndoCount === 1) {
        this.pendingGlitchUndoByUser.delete(user.id);
      } else {
        this.pendingGlitchUndoByUser.set(user.id, pendingUndoCount - 1);
      }
      return;
    }

    const targetLayer = Number.isFinite(Number(layerIndex)) ? Number(layerIndex) : this.getStrokeLayer(user);
    const group = this.board.layerManager?.getLayerGroup(targetLayer);
    // A glitch result authoritatively defines its own blend. Prefer the blend
    // that travelled with the result (draw-time) over the user's live blendMode —
    // the image decode is async, so by now the live blend may belong to a later
    // stroke.
    // Glitch results now bake their displayed (blend-resolved) appearance into
    // the image and travel as source-over (see GlitchBlurTool). So default to
    // source-over here rather than the user's LIVE blend: the broadcast omits
    // bm/bbm for source-over, and falling back to user.blendMode would re-blend
    // an already-blended image (e.g. white 'difference' over white → black).
    // An explicit override (older recordings that carried a real blend) still
    // wins for backward compatibility.
    const blendMode = blendModeOverride || 'source-over';
    const blendBakeMode = blendBakeModeOverride || 'background';

    let active = group?.activeStrokeByUser?.get(user.id);
    if (!active) {
      this.board.layerManager.beginUserStroke(targetLayer, user.id, blendMode, blendBakeMode);
      this.board.applySelectionMaskClipForStroke(targetLayer, user.id);
      active = group?.activeStrokeByUser?.get(user.id);
    } else {
      // A stale/foreign active stroke is being reused — the begin branch (which
      // sets blend) was skipped, so the glitch would inherit whatever blend that
      // stroke had (usually source-over → opaque squares). Force the glitch's
      // blend onto it so the commit composites correctly.
      active.blendMode = blendMode;
      active.blendBakeMode = blendBakeMode === 'background' ? 'background' : 'existing';
    }
    if (!active?.ctx) return;

    active.ctx.save();
    active.ctx.globalCompositeOperation = 'source-over';
    active.ctx.globalAlpha = 1;
    active.ctx.drawImage(resultCanvas, bounds.x, bounds.y, bounds.width, bounds.height);
    active.ctx.restore();

    this.board.layerManager._expandDirtyRect(active.dirtyRect, bounds.x, bounds.y, bounds.width, bounds.height);
    this.board.compositeTileGrid?.markRect(bounds.x, bounds.y, bounds.width, bounds.height);

    this.board.releaseSelectionMaskClipForStroke(targetLayer, user.id);
    this.board.layerManager.commitUserStroke(targetLayer, user.id, {
      isRemoteGlitchImage: true,
      // Authoritative per-layer seq from GLITCH_RESULT — keeps this glitch
      // stroke ordered identically to the drawer (who reconciles its matching
      // local glitch stroke to this same seq). seq=0 would sort it to the top.
      seq: seq || 0
    });
    if (this.board._compositeCommittedStrokeNow) {
      this.board._compositeCommittedStrokeNow();
    } else {
      this.board.compositeAllLayers();
    }
  }

  markPendingGlitchUndo(userId) {
    if (userId == null) return;
    const count = this.pendingGlitchUndoByUser.get(userId) || 0;
    this.pendingGlitchUndoByUser.set(userId, count + 1);
  }

  undoLatestRemoteGlitchImage(userId) {
    const layerCount = this.board.layerManager?.getLayerCount?.() ?? 0;
    for (let layerIndex = layerCount - 1; layerIndex >= 0; layerIndex--) {
      const group = this.board.layerManager?.getLayerGroup(layerIndex);
      if (!group?.strokeStack) continue;

      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        const record = group.strokeStack[i];
        if (record.userId === userId && record.isRemoteGlitchImage) {
          const removed = group.strokeStack.splice(i, 1)[0];
          const count = group.userStrokeCounts.get(userId) || 0;
          if (count > 0) group.userStrokeCounts.set(userId, count - 1);
          const batch = [{ groupIdx: layerIndex, record: removed }];
          this.board.layerManager._pushToRedoStack(userId, batch);
          this.board._markBatchDirtyRects?.(batch);
          this.board.compositeAllLayers();
          this.board.layerManager._notifyHistoryPanel?.(true);
          return true;
        }
      }
    }

    return false;
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

    // Parse modifiers from key string
    const isCtrlAction = key.startsWith('Ctrl+');
    const isShiftEnter = key === 'Shift+Enter';

    let actualKey = key;
    let ctrlKey = false;
    if (isCtrlAction) {
      actualKey = key.substring(5); // Remove 'Ctrl+' prefix
      ctrlKey = true;
    } else if (isShiftEnter) {
      actualKey = 'Enter';
    }

    if (actualKey.length === 1) {
      user.text += actualKey;
    } else if (actualKey === 'Enter') {
      if (isShiftEnter) {
        user.text += '\n';
      } else {
        user.text = '';
      }
    } else if (actualKey === 'Backspace') {
      if (ctrlKey) {
        // Ctrl+Backspace: delete word backwards
        const text = user.text;
        let i = text.length - 1;
        // Skip trailing whitespace backwards
        while (i >= 0 && /\s/.test(text[i])) i--;
        // Skip word characters backwards
        while (i >= 0 && /\S/.test(text[i])) i--;
        user.text = text.slice(0, i + 1);
      } else {
        user.text = user.text.slice(0, -1);
      }
    } else if (actualKey === 'Delete') {
      if (ctrlKey) {
        // Ctrl+Delete: same as Ctrl+Backspace since cursor is at end
        const text = user.text;
        let i = text.length - 1;
        // Skip trailing whitespace backwards
        while (i >= 0 && /\s/.test(text[i])) i--;
        // Skip word characters backwards
        while (i >= 0 && /\S/.test(text[i])) i--;
        user.text = text.slice(0, i + 1);
      }
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

    if (data.pixel) {
      // Legacy raster path — text becomes a permanent stroke on the remote layer.
      const blendMode = data.blendMode || user.blendMode || 'source-over';
      const blendBakeMode = data.blendBakeMode || user.blendBakeMode || 'background';
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
        blendBakeMode,
        font: data.font ?? user.font,
        textPositionMultiplier: data.textPositionMultiplier ?? user.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset ?? user.textPositionOffset,
        getColorString() {
          return `rgba(${this.color.join(',')})`;
        }
      };
      this.board.layerManager.beginUserStroke(layerIndex, user.id, blendMode, blendBakeMode);
      this.board.applySelectionMaskClipForStroke(layerIndex, user.id);
      this.toolManager.getTool('text').drawText(textUser);
      this.board.releaseSelectionMaskClipForStroke(layerIndex, user.id);
      // Authoritative per-broadcast seq from TEXT_APPLY. At seq 0 the bake sorts
      // to the top of the stack (_sortStrokeStack maps 0 to MAX_SAFE_INTEGER) and
      // ties break on this client's own clock, so text landed in a different
      // z-order on every client. The drawer reconciles its own copy to the same
      // seq on the self echo.
      this.board.layerManager.commitUserStroke(layerIndex, user.id, { seq: data.seq || 0 });
    } else {
      // Vector path — add to ephemeral SVG overlay.
      const id = data.id || `t_${user.id ?? 0}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.board.textOverlay?.add({
        id,
        userId: user.id ?? 0,
        text: data.text,
        font: data.font ?? user.font,
        size: data.size ?? user.size,
        color: data.color ?? user.color,
        opacity: data.opacity ?? user.opacity,
        x: data.position?.x ?? user.x,
        y: data.position?.y ?? user.y,
        textPositionMultiplier: data.textPositionMultiplier ?? user.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset ?? user.textPositionOffset,
        layerIdx: layerIndex,
        lifetimeMs: data.lifetimeMs,
        fadeMs: data.fadeMs,
        ageMs: data.ageMs ?? 0
      });
    }

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
    const lineHeight = getUserTextLineHeight(user);
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';
    user.text.split('\n').forEach((line, i) => {
      ctx.fillText(line, drawX, baselineY + (i * lineHeight));
    });
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
    let brushData;
    try {
      brushData = typeof brushDataStr === 'string' ? JSON.parse(brushDataStr) : brushDataStr;
    } catch (err) {
      console.error(`[ImageBrush] Failed to parse brush payload for remote user ${user?.id}:`, err);
      return;
    }
    if (!brushData || typeof brushData !== 'object') return;

    // Assign immediately so that MD/stamp messages arriving before the image
    // element finishes decoding still see the correct brush identity.
    // Strokes that arrive while the image is still loading are buffered in
    // brushData._pendingStrokes and replayed once the image is ready.
    user.imageBrush = brushData;
    user.imageBrushColorMode = brushData.colorMode ?? 'original';
    brushData._pendingStrokes = [];

    const replayPending = () => {
      const pending = brushData._pendingStrokes;
      delete brushData._pendingStrokes;
      if (!pending || pending.length === 0) return;
      
      const tool = this.toolManager.getTool('imageBrush');
      if (!tool) return;
      
      // Temporary swap to ensure we use the brush we JUST loaded during replay
      const currentBrush = user.imageBrush;
      user.imageBrush = brushData;

      for (const entry of pending) {
        if (entry.type === 'down') {
          user._imageBrushLastPos = { x: entry.pos.x, y: entry.pos.y };
          user._imageBrushLastTime = performance.now();
          user._imageBrushDirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          user._imageBrushStrokePoints = [{ x: entry.pos.x, y: entry.pos.y }];
          tool.lastStampPos.set(user.id, entry.pos);
          user.mousedown = true;
          tool.drawStamp(user, entry.pos);
        } else if (entry.type === 'stamps') {
          tool.applyStamps(user, entry.pts);
        } else if (entry.type === 'up') {
          user.mousedown = true;
          // The buffered entry captured the MU's authoritative seq precisely so
          // the replayed commit could keep it; handleMouseUp(user) defaults it to
          // 0, which sorts the stroke to the top of the stack and orders it by
          // this client's clock instead of the server's.
          this.handleMouseUp(user, entry.seq);
        }
      }
      
      // Restore the current brush (it might have changed since this load started)
      user.imageBrush = currentBrush;
      this.board.requestUpdate?.();
    };

    if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
      this._loadBrushImage(brushData, () => {
        console.log(`[ImageBrush] Remote user ${user.id} loaded ${brushData.type} brush:`, brushData.brushName || brushData.fileName);
        replayPending();
      }, () => {
        delete brushData._pendingStrokes;
        console.error(`[ImageBrush] Failed to load brush image for remote user ${user.id}`);
      });
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

            console.log(`[ImageBrush] Remote user ${user.id} loaded GIH brush with ${totalImages} cells:`, brushData.brushName);
            replayPending();
          }
        };
        img.onerror = () => {
          delete brushData._pendingStrokes;
          console.error(`[ImageBrush] Failed to load GIH image ${idx} for remote user ${user.id}`);
        };
        img.src = brush.gimpUrl;
        return img;
      });
    } else {
      // Unknown type or no async loading needed
      user._pendingBrushStrokes = null;
    }
  }

  handlePatternBrushLoad(user, patternDataStr) {
    let patternData;
    try {
      patternData = typeof patternDataStr === 'string' ? JSON.parse(patternDataStr) : patternDataStr;
    } catch (err) {
      console.error(`[PatternBrush] Failed to parse pattern payload for remote user ${user?.id}:`, err);
      return;
    }
    if (!patternData || typeof patternData !== 'object') return;
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

    // Strokes that arrive while the image is still decoding are buffered here and
    // replayed once it is ready — the same race the image brush already handles
    // via _pendingStrokes. Without it the whole gesture ran against a null tile
    // (_getPatternTile needs the decoded image), painted nothing, and committed an
    // empty dirtyRect that is silently discarded: the drawer had a pattern stroke
    // that simply did not exist on any observer.
    //
    // The buffer lives on the USER, not on brushData, so `user.patternBrush` stays
    // unset until the image is genuinely usable — anything else that asks whether
    // this user has a pattern (notably pattern-mode FILL) keeps reading the same
    // readiness signal it reads today.
    user._patternPendingStrokes = [];

    const replayPending = () => {
      const pending = user._patternPendingStrokes;
      delete user._patternPendingStrokes;
      if (!pending || pending.length === 0) return;
      const tool = this.toolManager.getTool('pattern');
      if (!tool) return;
      for (const entry of pending) {
        if (entry.type === 'down') {
          user.mousedown = true;
          tool.remoteBeginStroke(user, entry.pos);
        } else if (entry.type === 'stamps') {
          tool.remoteStampMask(user, entry.pts);
        } else if (entry.type === 'up') {
          user.mousedown = true;
          this.handleMouseUp(user, entry.seq);
        }
      }
    };

    // On failure the gesture is replayed too. It still paints nothing (there is no
    // tile), but it runs the commit path and closes the stroke out, instead of
    // leaving an active stroke open forever because its MU was swallowed.
    if (brushData.type === 'gbr' || brushData.type === 'image' || brushData.type === 'svg') {
      this._loadBrushImage(brushData, () => {
        user.patternBrush = brushData;
        patternTool?._tileCache.clear();
        replayPending();
      }, () => {
        console.error(`[PatternBrush] Failed to load brush image for remote user ${user.id}`);
        replayPending();
      });
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
            patternTool?._tileCache.clear();
            replayPending();
          }
        };
        img.onerror = () => {
          console.error(`[PatternBrush] Failed to load GIH image ${idx} for remote user ${user.id}`);
          replayPending();
        };
        img.src = brush.gimpUrl;
        return img;
      });
    }
  }

  _loadBrushImage(brushData, onLoad, onError) {
    const image = new Image();
    image.onload = () => {
      brushData.image = image;
      if (!brushData.width) brushData.width = image.naturalWidth || image.width;
      if (!brushData.height) brushData.height = image.naturalHeight || image.height;
      onLoad();
    };
    image.onerror = onError;

    if (brushData.type === 'svg' && brushData.svgContent) {
      const svgBlob = new Blob([brushData.svgContent], { type: 'image/svg+xml' });
      image.src = URL.createObjectURL(svgBlob);
      return;
    }

    image.src = brushData.gimpUrl;
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
      circleBlurTool.strokePoints?.clear?.();
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
      imageBrushTool.stampBuffer = [];
    }

    const confettiTool = this.toolManager.getTool('confetti');
    if (confettiTool) {
      confettiTool.lastStampPos?.clear?.();
      confettiTool._activeUser = null;
      confettiTool.stampBuffer = [];
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
      pixelTool.stampBuffer = [];
    }

    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.lastPos?.clear?.();

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

    this._clearLayeredRemotePreview(user);
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
    user._penDirtyBounds = null;
    user._penPreviewDirtyBounds = null;
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
    user._inkDirtyBounds = null;
    if (user._inkCtx && user._inkOffscreen) {
      user._inkCtx.clearRect(0, 0, user._inkOffscreen.width, user._inkOffscreen.height);
    }
    this._disposeCanvasElement(user._inkOffscreen);
    user._inkOffscreen = null;
    user._inkCtx = null;

    delete user.blurBounds;
    delete user.glitchStamps;
    user.lastBlurPos = null;

    const blurTool = this.toolManager.getTool('blur');
    if (blurTool) {
      blurTool.lastStampPos.delete(user.id);
      blurTool.strokePoints.delete(user.id);
    }

    const circleBlurTool = this.toolManager.getTool('circleBlur');
    if (circleBlurTool) {
      circleBlurTool.lastStampPos.delete(user.id);
      circleBlurTool.strokePoints?.delete?.(user.id);
    }

    const glitchBlurTool = this.toolManager.getTool('glitchBlur');
    if (glitchBlurTool) {
      glitchBlurTool.lastStampPos.delete(user.id);
      glitchBlurTool.strokePoints.delete(user.id);
    }

    const imageBrushTool = this.toolManager.getTool('imageBrush');
    if (imageBrushTool) imageBrushTool.lastStampPos.delete(user.id);
    delete user._imageBrushLastPos;
    delete user._imageBrushLastTime;
    delete user._imageBrushDirtyBounds;
    delete user._imageBrushStrokePoints;

    const confettiTool = this.toolManager.getTool('confetti');
    if (confettiTool) confettiTool.lastStampPos.delete(user.id);
    delete user._confettiDirtyBounds;
    delete user._confettiStrokePoints;

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
    delete user._pixelStrokePoints;
    delete user._pixelPreviewDirtyBounds;

    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.lastPos?.delete?.(user.id);

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
    const result = await fillTool._fillWorker.computeFill(
      imageData.data, width, height, x, y, 10, 0, null
    );
    if (!result || previewToken !== (user._fillPreviewToken || 0) || !user.mousedown || user.tool !== 'fill') return;

    const fillLimit = fillTool._isFillTooLarge?.(result, width, height);
    if (fillLimit) {
      fillTool._warnFillTooLarge?.(fillLimit, false);
      this._invalidateFillPreview(user);
      return;
    }

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
    this.board.withSelectionMaskClip(user.context, user.id, () => {
      if (!this._fillPreviewCanvas ||
          this._fillPreviewCanvas.width !== regionW ||
          this._fillPreviewCanvas.height !== regionH) {
        this._fillPreviewCanvas = document.createElement('canvas');
        this._fillPreviewCanvas.width = regionW;
        this._fillPreviewCanvas.height = regionH;
        this._fillPreviewCtx = this._fillPreviewCanvas.getContext('2d');
      }
      this._fillPreviewCtx.clearRect(0, 0, regionW, regionH);
      this._fillPreviewCtx.putImageData(imgData, 0, 0);
      user.context.drawImage(this._fillPreviewCanvas, minX, minY);
    });
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
  }

  _expandDirtyRectFromRect(user, rect, margin) {
    if (!rect) return;

    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.w;
    const maxY = rect.y + rect.h;

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
    this._clearLayeredRemotePreview(user);

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
