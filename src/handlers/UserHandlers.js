import { User } from '../User.js';

/**
 * UserHandlers
 *
 * Handles user lifecycle events:
 * - User list sync
 * - User join/leave
 * - AFK status changes
 * - Cursor visibility
 * - Board settings
 */

export function setupUserHandlers(wsClient, app) {
  const { users, ui, board, chat } = app;

  // Users list received (initial sync or updates)
  wsClient.on('users', (data) => {
    console.log(`[USERS] Received ${data.users.length} users:`, data.users.map(u => `${u.name || 'unnamed'}(${u.sessionIndex})`).join(', '), `My sessionIndex: ${app.sessionIndex}`);
    data.users.forEach(userData => {
      if (userData.sessionIndex !== app.sessionIndex) {
        let user = users.get(userData.sessionIndex);

        if (!user) {
          const username = userData.name || userData.username || '';

          // Map 'name' to 'username' for User class compatibility
          const userOptions = {
            ...userData,
            username,
            afk: userData.afk || false,
            opacity: userData.color ? userData.color[3] : 1, // Derive opacity from color alpha
            role: userData.role || 0
          };

          // Always create User object and board layer so we can receive events
          user = new User(userData.sessionIndex, userOptions);
          user.setTool(userData.tool);
          users.set(userData.sessionIndex, user);

          // Initialize image brush if present in sync data
          const brushData = userData.ib || userData.imageBrush;
          if (brushData && remoteUserHandler) {
            remoteUserHandler.handleBrushLoad(user, brushData);
          }

          const boardData = ui.createUserBoard(userData.sessionIndex);
          user.board = boardData.board;
          user.context = boardData.context;
          user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(user.blendMode);

          // Only show in user list / cursor if they have a name (have joined)
          if (username) {
            ui.createRemoteUser(userData.sessionIndex, userOptions);

            // Hide cursor if user's cursor was hidden (e.g. pointer off-board)
            if (userData.cursorHidden) {
              ui.hideRemoteCursor(userData.sessionIndex);
            }
          }
        }

        // Apply AFK status
        if (userData.afk) {
          ui.setRemoteUserAfk(userData.sessionIndex, true);
        }
      }
    });

    // Update chat user list for DM functionality
    app.updateChatUserList();
  });

  // Board settings
  wsClient.on('settings', (data) => {
    board.setMirror(data.mirror);
    ui.updateMirrorDisplay(data.mirror);
  });

  // User left
  wsClient.on('left', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addSystemMessage(`${user.username || 'User'} has left the room`);

      // Clean up any active strokes from this user (e.g., if they disconnected mid-stroke)
      if (board.layerManager) {
        board.layerManager.cleanupUserStrokes(data.sessionIndex);
      }

      users.delete(data.sessionIndex);
      ui.removeRemoteUser(data.sessionIndex);

      // Update chat user list
      app.updateChatUserList();
    }
  });

  // AFK status change
  wsClient.on('afk', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setAfk(data.afk);
      ui.setRemoteUserAfk(data.sessionIndex, data.afk);
    }
  });

  // Name change (user joining)
  wsClient.on('cn', (data) => {
    // Skip if this is our own session (defensive check)
    if (data.sessionIndex === app.sessionIndex) {
      return;
    }

    let user = users.get(data.sessionIndex);
    const hadName = user ? !!user.username : false;
    const action = !user ? 'joined (new)' : (!hadName ? 'joined (was nameless)' : 'changed name');
    console.log(`[CN] User ${data.name}(${data.sessionIndex}) ${action}`);
    if (!user) {
      // User wasn't in any users list yet — create from scratch
      const userOptions = {
        username: data.name,
        size: data.size,
        tool: data.tool,
        color: data.color,
        opacity: data.color ? data.color[3] : undefined,
        spacing: data.spacing,
        smoothing: data.smoothing,
        hardness: data.hardness,
        blurRadius: data.blurRadius,
        activeLayer: data.activeLayer,
        blendMode: data.blendMode
      };
      user = new User(data.sessionIndex, userOptions);
      users.set(data.sessionIndex, user);

      const boardData = ui.createUserBoard(data.sessionIndex);
      user.board = boardData.board;
      user.context = boardData.context;
      user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(user.blendMode);
      ui.createRemoteUser(data.sessionIndex, user);
    } else {
      const hadName = !!user.username;
      user.setUsername(data.name);

      // Apply any properties that were bundled with the join message
      if (data.size !== undefined) user.setSize(data.size);
      if (data.tool !== undefined) user.setTool(data.tool);
      if (data.color !== undefined) {
        user.setColor(data.color);
        user.setOpacity(data.color[3]);
      }
      if (data.spacing !== undefined) user.setSpacing(data.spacing);
      if (data.smoothing !== undefined) user.setSmoothing(data.smoothing);
      if (data.hardness !== undefined) user.setHardness(data.hardness);
      if (data.blurRadius !== undefined) user.setBlurRadius(data.blurRadius);
      if (data.activeLayer !== undefined) user.setActiveLayer(data.activeLayer);
      if (data.blendMode !== undefined) user.setBlendMode(data.blendMode);

      if (!hadName) {
        // User existed but had no UI entry yet (was nameless on connect)
        ui.createRemoteUser(data.sessionIndex, user);
      } else {
        ui.updateRemoteName(data.sessionIndex, data.name);
        // Refresh UI for properties that might have changed
        if (data.tool !== undefined) ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
        if (data.color !== undefined) ui.updateRemoteColor(data.sessionIndex, data.color);
        if (data.size !== undefined) ui.updateRemoteSize(data.sessionIndex, data.size);
      }
    }
    chat.addSystemMessage(`${data.name} joined the room`);
    // Update chat user list
    app.updateChatUserList();
  });

  // Hide cursor
  wsClient.on('hide_cursor', (data) => {
    ui.hideRemoteCursor(data.sessionIndex);
  });

  // Show cursor
  wsClient.on('show_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      ui.showRemoteCursor(data.sessionIndex);
      // Refresh tool display to show correct cursor shape
      ui.updateRemoteToolDisplay(data.sessionIndex, user.tool);
    }
  });

  // Pan mode
  wsClient.on('pan', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.panning = data.panning;
    }
  });
}
