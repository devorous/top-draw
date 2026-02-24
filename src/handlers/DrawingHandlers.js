/**
 * DrawingHandlers
 *
 * Handles all drawing-related events (buffered during sync):
 * - Mouse events (move, down, up)
 * - Tool/property changes (tool, color, size, pressure, spacing, smoothing, hardness, blur radius)
 * - Brush loading (GIMP brushes)
 * - Canvas operations (clear, mirror, cancel)
 * - Text input (key press)
 */

export function setupDrawingHandlers(wrapHandler, app) {
  const { users, ui, board, remoteUserHandler } = app;

  // Mouse move
  wrapHandler('mm', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.ps || data.ps.length < 2) return;
    remoteUserHandler.handleMouseMove(user, data);
  });

  // Mouse down
  wrapHandler('md', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseDown(user);
    }
  });

  // Mouse up
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
      if (user.mousedown && user.tool === 'brush' && !user._penStrokeActive) {
        remoteUserHandler.commitLine(user, data.pressure, user.size);
      }
      user.setPressure(data.pressure);
    }
  });

  // Size change - commit BEFORE updating so old segment draws at correct width
  wrapHandler('cs', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (user.mousedown && user.tool === 'brush' && !user._penStrokeActive) {
        remoteUserHandler.commitLine(user, user.pressure, data.size);
      }
      user.setSize(data.size);
      ui.updateRemoteSize(data.sessionIndex, data.size);
    }
  });

  // Tool change
  wrapHandler('ct', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Clear pending selection if switching away from select tool
      if (user.pendingSelection && data.tool !== 'select') {
        user.pendingSelection = null;
        user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
      }
      user.setTool(data.tool);
      ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
    }
  });

  // Color change
  wrapHandler('cc', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setColor(data.color);
      user.setOpacity(data.color[3]); // Sync opacity from color alpha (matches local behavior)
      ui.updateRemoteColor(data.sessionIndex, data.color);
    }
  });

  // Spacing change
  wrapHandler('csp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSpacing(data.spacing);
    }
  });

  // Smoothing change
  wrapHandler('csm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSmoothing(data.smoothing);
    }
  });

  // Hardness change
  wrapHandler('chd', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setHardness(data.hardness);
    }
  });

  // Blur radius change
  wrapHandler('cbr', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setBlurRadius(data.blurRadius);
    }
  });

  // Layer change
  wrapHandler('cl', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setActiveLayer(data.layerIndex);
    }
  });

  // Blend mode change (per-layer)
  wrapHandler('cbm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Legacy: if no layerIndex, just update user's blend mode (backwards compat)
      if (data.layerIndex === null || data.layerIndex === undefined) {
        user.setBlendMode(data.blendMode);
        if (user.board) {
          user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(data.blendMode);
        }
      } else {
        // Update the user's sticky blend mode so handleMouseDown uses it for new strokes
        user.setBlendMode(data.blendMode);
        board.compositeAllLayers();
      }
    }
  });

  // Key press
  wrapHandler('kp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text') {
      remoteUserHandler.handleKeyPress(user, data.key);
    }
  });

  // Clear canvas
  wrapHandler('clr', () => {
    board.clear();
  });

  // Toggle mirror
  wrapHandler('mir', () => {
    const mirror = board.toggleMirror();
    ui.updateMirrorDisplay(mirror);
  });

  // Cancel stroke
  wrapHandler('cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleCancel(user);
    }
  });

  // Image brush (GIMP brushes and standard images)
  wrapHandler('gmp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleBrushLoad(user, data.brushData);
    }
  });
}
