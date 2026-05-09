/** @fileoverview Handles drawing-related events including tool changes, mouse interactions, and canvas operations. */

import { blurImageData } from '../utils/blurUtils.js';

/**
 * Sets up WebSocket event handlers for drawing and canvas operations.
 * @param {Function} wrapHandler - Function to wrap event handlers for sync buffering.
 * @param {App} app - The main application instance.
 */
export function setupDrawingHandlers(wrapHandler, app) {
  // Preload stackblur so remote fill blur uses the same renderer as local
  blurImageData(new ImageData(1, 1), 1, 1, 1).catch(() => {});
  const { users, ui, board, remoteUserHandler } = app;
  const pressureTools = new Set(['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur', 'imageBrush']);
  const applyImageToolData = (user, data) => {
    if (data.imageType === 'imageBrush') {
      remoteUserHandler.handleBrushLoad(user, data.imageData);
    } else if (data.imageType === 'pattern') {
      remoteUserHandler.handlePatternBrushLoad(user, data.imageData);
    } else if (data.imageType === 'confetti') {
      const confettiTool = app.toolManager.getTool('confetti');
      confettiTool?.applyNetworkSettings?.(user, data.imageData);
      confettiTool?.updatePreview?.(user);
    }
  };
  const queuePendingImageTool = (data) => {
    if (data?.sessionIndex === undefined || data?.sessionIndex === null || !data.imageType || !data.imageData) return;
    if (!app._pendingRemoteImageToolChanges) {
      app._pendingRemoteImageToolChanges = new Map();
    }
    const pending = app._pendingRemoteImageToolChanges.get(data.sessionIndex) || {};
    pending[data.imageType] = data.imageData;
    app._pendingRemoteImageToolChanges.set(data.sessionIndex, pending);
    setTimeout(() => {
      const user = users.get(data.sessionIndex);
      if (!user) return;
      const stored = app._pendingRemoteImageToolChanges?.get(data.sessionIndex);
      if (!stored?.[data.imageType]) return;
      applyImageToolData(user, data);
      delete stored[data.imageType];
      if (Object.keys(stored).length === 0) {
        app._pendingRemoteImageToolChanges.delete(data.sessionIndex);
      }
    }, 0);
  };

  wrapHandler('mm', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.ps || data.ps.length < 2) return;
    remoteUserHandler.handleMouseMove(user, data);
  });

  wrapHandler('md', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseDown(user, data);
    }
  });

  wrapHandler('mu', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseUp(user);
    }
  });

  // Pressure change - brush still commits per segment before updating.
  wrapHandler('cp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (!pressureTools.has(user.tool)) {
        return;
      }
      if (user.mousedown && !user._penStrokeActive && !user._inkStrokeActive) {
        if (user.tool === 'brush') {
          remoteUserHandler.commitLine(user, data.pressure, user.size);
        }
      }
      user.setPressure(data.pressure);
    }
  });

  // Size change - brush still commits per segment before updating.
  wrapHandler('cs', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (user.mousedown && !user._penStrokeActive && !user._inkStrokeActive) {
        if (user.tool === 'brush') {
          remoteUserHandler.commitLine(user, user.pressure, data.size);
        }
      }
      user.setSize(data.size);
      ui.updateRemoteSize(data.sessionIndex, data.size);
    }
  });

  wrapHandler('ct', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      const previousTool = user.tool;

      // Defensively clean up any dangling selection state when switching away from select
      if (data.tool !== 'select' && !user.isMaskMode && (user.floatingCanvas || user.pendingSelection)) {
        if (user.floatingCanvas) {
          // Floating canvas present but no commit/cancel was received — cancel it to restore
          // the erased content and clear the overlay, preventing a permanently stuck selection.
          remoteUserHandler.selectionHandler.handleSelectionCancel(user);
        } else {
          user.pendingSelection = null;
          user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
        }
      }

      if (previousTool === 'text' && data.tool !== 'text') {
        if (user.context) {
          user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
        }
        ui.setRemoteTextDomVisible(data.sessionIndex, true);
        ui.updateRemoteText(data.sessionIndex, '');
      }

      user.setTool(data.tool);
      // Track eraser mode so remote erase-all works correctly
      if (data.tool === 'erase') {
        user.eraseAllLayers = data.eraseAll || false;
      }
      ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
      app.updateChatUserList?.();
    }
  });

  wrapHandler('cc', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      const nextOpacity = data.color[3];
      if (user.mousedown && user.tool === 'erase') {
        app.toolManager.getTool('erase')?.commitCurrentLine(user, user.pressure, user.size, nextOpacity);
      }
      user.setColor(data.color);
      user.setOpacity(nextOpacity); // Sync opacity from color alpha (matches local behavior)
      ui.updateRemoteColor(data.sessionIndex, data.color);

      const patternTool = app.toolManager.getTool('pattern');
      if (patternTool?._tileCache) {
        patternTool._tileCache.clear();
      }

      const fillTool = app.toolManager.getTool('fill');
      if (fillTool?._patternTileCache) {
        fillTool._patternTileCache.clear();
      }

      const selectTool = app.toolManager.getTool('select');
      if (selectTool?._patternTileCache) {
        selectTool._patternTileCache.clear();
      }

      const remoteSelectionHandler = app.remoteUserHandler?.selectionHandler;
      if (remoteSelectionHandler?._patternTileCache) {
        remoteSelectionHandler._patternTileCache.clear();
      }
    }
  });

  wrapHandler('csp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSpacing(data.spacing);
    }
  });

  wrapHandler('csm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSmoothing(data.smoothing);
    }
  });

  wrapHandler('chd', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setHardness(data.hardness);
    }
  });

  wrapHandler('cbr', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setBlurRadius(data.blurRadius);
    }
  });

  wrapHandler('cthn', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setThinning(data.thinning);
      if (data.sessionIndex === app.sessionIndex) {
        ui.updateThinningValue(Math.round(data.thinning * 100));
      }
    }
  });

  wrapHandler('csim', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSimulatePressure(data.simulatePressure);
      if (data.sessionIndex === app.sessionIndex) {
        ui.updateSimulatePressure(data.simulatePressure);
      }
    }
  });

  wrapHandler('cl', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setActiveLayer(data.layerIndex);
      app.refreshRemoteLayerVisibilityStates?.(data.sessionIndex);
    }
  });

  wrapHandler('cbm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Enforce layer restriction — remote users cannot use complex blend modes on restricted layers
      let blendMode = data.blendMode;
      const layerIdx = data.layerIndex ?? user.activeLayer ?? 0;
      if (!board.layerManager.getLayerAllowComplexBlendModes(layerIdx)) {
        blendMode = 'source-over';
      }
      user.setBlendMode(blendMode);
      user.setBlendBakeMode(data.blendBakeMode);
      // Always update CSS blend mode on the remote user's preview canvas
      if (user.board) {
        user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(blendMode);
      }
      // If user is on text tool, switch preview mode (DOM vs canvas)
      if (user.tool === 'text') {
        const hasBlend = blendMode && blendMode !== 'source-over';
        ui.setRemoteTextDomVisible(user.id, !hasBlend);
      }
      if (data.layerIndex !== null && data.layerIndex !== undefined) {
        board.markCompositeFull();
        board.compositeAllLayers();
      }
    }
  });

  wrapHandler('kp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text') {
      remoteUserHandler.handleKeyPress(user, data.key);
    }
  });

  wrapHandler('text_apply', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleTextApply(user, data);
    }
  });

  wrapHandler('clr', () => {
    board.clear();
  });

  wrapHandler('mir', () => {
    const mirror = board.toggleMirror();
    ui.updateMirrorDisplay(mirror);
  });

  wrapHandler('cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleCancel(user);
    }
  });

  wrapHandler('gmp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleBrushLoad(user, data.brushData);
    }
  });

  wrapHandler('gpt', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handlePatternBrushLoad(user, data.patternData);
    }
  });

  wrapHandler('image_tool', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) {
      queuePendingImageTool(data);
      return;
    }

    applyImageToolData(user, data);
  });

  wrapHandler('cpm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.patternMode = data.patternMode || false;
    }
  });

  wrapHandler('cf', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) {
      if (!app._pendingRemoteFontChanges) {
        app._pendingRemoteFontChanges = new Map();
      }
      app._pendingRemoteFontChanges.set(data.sessionIndex, {
        font: data.font,
        textPositionMultiplier: data.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset
      });
      return;
    }

    user.setFont(data.font);
    if (data.textPositionMultiplier !== undefined) {
      user.setTextPositionMultiplier(data.textPositionMultiplier);
    }
    if (data.textPositionOffset !== undefined) {
      user.setTextPositionOffset(data.textPositionOffset);
    }
    ui.updateRemoteFont(data.sessionIndex, data.font);
    ui.updateRemoteTextLayout(data.sessionIndex, user);
    app._refreshTextRenderingAfterFontLoad?.(data.font);

    if (user.tool !== 'text' || !user.text) return;

    if (user.blendMode && user.blendMode !== 'source-over') {
      remoteUserHandler._renderRemoteTextToCanvas(user);
    } else {
      ui.updateRemoteText(data.sessionIndex, user.text);
    }
  });

  wrapHandler('csdm', (data) => {
    app.applyShapeDrawMode(data.shapeDrawMode, { broadcast: false, persist: true });
  });

  wrapHandler('glitch_result', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.imageData) return;

    const bounds = { x: data.x, y: data.y, width: data.width, height: data.height };
    const pendingGlitch = remoteUserHandler.queueRemoteGlitchImage(user, bounds);
    if (!pendingGlitch) return;

    const img = new Image();
    img.onload = () => {
      // Convert to canvas for use as _cachedBlurResult
      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, data.width, data.height);
      remoteUserHandler.resolveRemoteGlitchImage(pendingGlitch, canvas);
    };
    img.onerror = () => {
      pendingGlitch.canceled = true;
      remoteUserHandler.resolveRemoteGlitchImage(pendingGlitch, null);
    };
    img.src = data.imageData;
  });

  wrapHandler('undo', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (user.tool === 'glitchBlur') {
        if (user.mousedown || board.layerManager?.layerGroups?.some(group => group?.activeStrokeByUser?.has(user.id))) {
          remoteUserHandler.handleCancel(user);
        }
        remoteUserHandler.cancelLatestPendingGlitchImage(user.id);
        if (remoteUserHandler.undoLatestRemoteGlitchImage(user.id)) {
          return;
        }
      }

      const hasActiveStroke = user.mousedown || board.layerManager?.layerGroups?.some(
        group => group?.activeStrokeByUser?.has(user.id)
      );
      if (hasActiveStroke) {
        remoteUserHandler.handleCancel(user);
        return;
      }

      const undone = board.undo(user.activeLayer, user.id);
      if (!undone && user.tool === 'glitchBlur') {
        remoteUserHandler.markPendingGlitchUndo(user.id);
      }
    }
  });

  wrapHandler('redo', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      board.redo(user.id);
    }
  });

  wrapHandler('fill', async (data) => {
    const user = users.get(data.sessionIndex);
    if (!user) return;

    remoteUserHandler._invalidateFillPreview?.(user);

    const fillTool = app.toolManager.getTool('fill');
    if (!fillTool) return;

    const width = board.getWidth();
    const height = board.getHeight();
    const x = data.x;
    const y = data.y;
    if (x < 0 || x >= width || y < 0 || y >= height) return;

    const layerIndex = data.layerIndex ?? user.activeLayer ?? 0;
    const userId = user.id;

    const fillColor = user.color ?? [0, 0, 0, 1];
    const fillR = Math.round(fillColor[0]);
    const fillG = Math.round(fillColor[1]);
    const fillB = Math.round(fillColor[2]);
    // Match local fill behavior: use the opacity slider only so alpha is not applied twice.
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    const userOpacity = opacitySlider;

    const imageData = board.mainCtx.getImageData(0, 0, width, height);
    const imgData = imageData.data;

    // Check target vs fill color similarity (same as local)
    const startIdx = (y * width + x) * 4;
    const tR = imgData[startIdx], tG = imgData[startIdx + 1], tB = imgData[startIdx + 2], tA = imgData[startIdx + 3];
    if (tA >= 10) {
      const dr = tR - fillR, dg = tG - fillG, db = tB - fillB, da = tA - 255;
      if (dr * dr + dg * dg + db * db + da * da <= 100) return;
    }

    const expansion = data.expansion || 0;
    const blurRadius = data.blurRadius || 0;

    const result = await fillTool._fillWorker.computeFill(
      imgData, width, height, x, y, 10, expansion, null
    );
    if (!result) return;

    const blendMode = user.blendMode || 'source-over';
    board.layerManager.beginUserStroke(layerIndex, userId, blendMode, user.blendBakeMode);
    board.applySelectionMaskClipForStroke(layerIndex, userId);
    const strokeCtx = board.layerManager.getUserStrokeContext(layerIndex, userId);
    if (!strokeCtx) return;

    fillTool._renderMask(strokeCtx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user);

    const pad = Math.ceil(blurRadius * 3) + Math.ceil(Math.abs(expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    board.expandDirtyRect(user, bx, by, bw, bh);

    for (const region of board.getActiveMirrorRegions()) {
      if (!region?.synthetic) continue;
      const mirrored = board.mirrorPointToRegion({ x, y }, region);
      const mx = Math.round(mirrored.x);
      const my = Math.round(mirrored.y);
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;
      const mirrorData = board.mainCtx.getImageData(0, 0, width, height).data;
      const mResult = await fillTool._fillWorker.computeFill(
        mirrorData, width, height, mx, my, 10, expansion, null
      );
      if (mResult) {
        board.withMirrorRegionClip(strokeCtx, region, () => {
          fillTool._renderMaskComposite(strokeCtx, mResult, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user);
        });
        const mbx = Math.max(0, mResult.minX - pad);
        const mby = Math.max(0, mResult.minY - pad);
        const mbw = Math.min(width, mResult.maxX + pad + 1) - mbx;
        const mbh = Math.min(height, mResult.maxY + pad + 1) - mby;
        board.expandDirtyRect(user, mbx, mby, mbw, mbh);
      }
    }

    board.releaseSelectionMaskClipForStroke(layerIndex, userId);
    board.layerManager.commitUserStroke(layerIndex, userId);
    board.compositeAllLayers();
  });
}
