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

  // Pressure change - commit BEFORE updating so old segment draws at correct width
  wrapHandler('cp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (user.mousedown && user.tool === 'brush' && !user._penStrokeActive && !user._inkStrokeActive) {
        remoteUserHandler.commitLine(user, data.pressure, user.size);
      }
      user.setPressure(data.pressure);
    }
  });

  // Size change - commit BEFORE updating so old segment draws at correct width
  wrapHandler('cs', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (user.mousedown && user.tool === 'brush' && !user._penStrokeActive && !user._inkStrokeActive) {
        remoteUserHandler.commitLine(user, user.pressure, data.size);
      }
      user.setSize(data.size);
      ui.updateRemoteSize(data.sessionIndex, data.size);
    }
  });

  wrapHandler('ct', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Defensively clean up any dangling selection state when switching away from select
      if (data.tool !== 'select' && (user.floatingCanvas || user.pendingSelection)) {
        if (user.floatingCanvas) {
          // Floating canvas present but no commit/cancel was received — cancel it to restore
          // the erased content and clear the overlay, preventing a permanently stuck selection.
          remoteUserHandler.selectionHandler.handleSelectionCancel(user);
        } else {
          user.pendingSelection = null;
          user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
        }
      }
      user.setTool(data.tool);
      // Track eraser mode so remote erase-all works correctly
      if (data.tool === 'erase') {
        user.eraseAllLayers = data.eraseAll || false;
      }
      ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
    }
  });

  wrapHandler('cc', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setColor(data.color);
      user.setOpacity(data.color[3]); // Sync opacity from color alpha (matches local behavior)
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

    if (user.tool !== 'text' || !user.text) return;

    if (user.blendMode && user.blendMode !== 'source-over') {
      remoteUserHandler._renderRemoteTextToCanvas(user);
    } else {
      ui.updateRemoteText(data.sessionIndex, user.text);
    }
  });

  wrapHandler('glitch_result', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.imageData) return;

    const img = new Image();
    img.onload = () => {
      // Convert to canvas for use as _cachedBlurResult
      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, data.width, data.height);
      const bounds = { x: data.x, y: data.y, width: data.width, height: data.height };
      board.layerManager?.applyRemoteGlitchResult(user.id, canvas, bounds);
    };
    img.src = data.imageData;
  });

  wrapHandler('undo', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      board.undo(user.activeLayer, user.id);
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
    const colorAlpha = fillColor[3];
    const opacitySlider = user.opacity !== undefined ? user.opacity : 1;
    const userOpacity = colorAlpha * opacitySlider;

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

    // Try unconstrained fill first
    let result = await fillTool._fillWorker.computeFill(
      imgData, width, height, x, y, 10, expansion, null
    );
    if (!result) return;

    // Apply tile constraint if fill is too large (same logic as local FloodFillTool)
    if (fillTool._isFillTooLarge(result, width, height)) {
      const tileRects = fillTool._getOwnedTileRects(x, y, userId);
      if (tileRects) {
        const constrainedResult = await fillTool._fillWorker.computeFill(
          board.mainCtx.getImageData(0, 0, width, height).data,
          width, height, x, y, 10, expansion, tileRects
        );
        if (constrainedResult) {
          result = constrainedResult;
        } else {
          return; // Can't constrain a too-large fill
        }
      } else {
        return; // No tiles owned, can't allow huge fill
      }
    }

    const blendMode = user.blendMode || 'source-over';
    board.layerManager.beginUserStroke(layerIndex, userId, blendMode);
    const strokeCtx = board.layerManager.getUserStrokeContext(layerIndex, userId);
    if (!strokeCtx) return;

    fillTool._renderMask(strokeCtx, result, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user);

    const pad = Math.ceil(blurRadius * 2) + Math.ceil(Math.abs(expansion));
    const bx = Math.max(0, result.minX - pad);
    const by = Math.max(0, result.minY - pad);
    const bw = Math.min(width, result.maxX + pad + 1) - bx;
    const bh = Math.min(height, result.maxY + pad + 1) - by;
    board.expandDirtyRect(user, bx, by, bw, bh);

    // Track tile ownership for remote user's fill
    fillTool._markFilledTiles(result, width, userId, layerIndex);

    for (const region of board.getActiveMirrorRegions()) {
      const mirrored = board.mirrorPointToRegion({ x, y }, region);
      const mx = Math.round(mirrored.x);
      const my = Math.round(mirrored.y);
      if (mx < 0 || mx >= width || my < 0 || my >= height) continue;
      const mirrorData = board.mainCtx.getImageData(0, 0, width, height).data;
      let mResult = await fillTool._fillWorker.computeFill(
        mirrorData, width, height, mx, my, 10, expansion, null
      );
      if (mResult && fillTool._isFillTooLarge(mResult, width, height)) {
        const mirrorTileRects = fillTool._getOwnedTileRects(mx, my, userId);
        if (mirrorTileRects) {
          mResult = await fillTool._fillWorker.computeFill(
            board.mainCtx.getImageData(0, 0, width, height).data,
            width, height, mx, my, 10, expansion, mirrorTileRects
          );
        } else {
          mResult = null;
        }
      }
      if (mResult) {
        board.withMirrorRegionClip(strokeCtx, region, () => {
          fillTool._renderMaskComposite(strokeCtx, mResult, fillR, fillG, fillB, userOpacity, blurRadius, width, height, user);
        });
        const mbx = Math.max(0, mResult.minX - pad);
        const mby = Math.max(0, mResult.minY - pad);
        const mbw = Math.min(width, mResult.maxX + pad + 1) - mbx;
        const mbh = Math.min(height, mResult.maxY + pad + 1) - mby;
        board.expandDirtyRect(user, mbx, mby, mbw, mbh);
        fillTool._markFilledTiles(mResult, width, userId, layerIndex);
      }
    }

    board.layerManager.commitUserStroke(layerIndex, userId);
    board.compositeAllLayers();
  });
}
