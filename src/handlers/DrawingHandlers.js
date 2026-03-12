/** @fileoverview Handles drawing-related events including tool changes, mouse interactions, and canvas operations. */

/**
 * Sets up WebSocket event handlers for drawing and canvas operations.
 * @param {Function} wrapHandler - Function to wrap event handlers for sync buffering.
 * @param {App} app - The main application instance.
 */
export function setupDrawingHandlers(wrapHandler, app) {
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
      // Clear pending selection if switching away from select tool
      if (user.pendingSelection && data.tool !== 'select') {
        user.pendingSelection = null;
        user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
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

  wrapHandler('cl', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setActiveLayer(data.layerIndex);
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
}
