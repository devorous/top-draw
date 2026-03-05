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
    let user = users.get(data.sessionIndex);
    if (!user) {
      // User wasn't in any users list yet — create from scratch
      user = new User(data.sessionIndex, { username: data.name });
      users.set(data.sessionIndex, user);

      const boardData = ui.createUserBoard(data.sessionIndex);
      user.board = boardData.board;
      user.context = boardData.context;
      user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(user.blendMode);
      ui.createRemoteUser(data.sessionIndex, user);
    } else {
      const hadName = !!user.username;
      user.setUsername(data.name);

      if (!hadName) {
        // User existed but had no UI entry yet (was nameless on connect)
        ui.createRemoteUser(data.sessionIndex, user);
      } else {
        ui.updateRemoteName(data.sessionIndex, data.name);
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
