import { User } from './User.js';

/**
 * Sets up all WebSocket message handlers for the app
 */
export function setupWebSocketHandlers(app) {
  const { wsClient, users, ui, board, chat, remoteUserHandler } = app;

  // Users list received
  wsClient.on('users', (data) => {
    data.users.forEach(userData => {
      if (userData.sessionIndex !== app.sessionIndex) {
        let user = users.get(userData.sessionIndex);

        if (!user) {
          // Map 'name' to 'username' for User class compatibility
          const userOptions = {
            ...userData,
            username: userData.name || userData.username || '',
            afk: userData.afk || false,
            opacity: userData.color ? userData.color[3] : 1 // Derive opacity from color alpha
          };

          // Create new remote user
          user = new User(userData.sessionIndex, userOptions);
          users.set(userData.sessionIndex, user);

          const boardData = ui.createUserBoard(userData.sessionIndex);
          user.board = boardData.board;
          user.context = boardData.context;

          ui.createRemoteUser(userData.sessionIndex, userOptions);
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

  // Mouse move
  wsClient.on('mm', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.ps || data.ps.length < 2) return;
    remoteUserHandler.handleMouseMove(user, data);
  });

  // Mouse down
  wsClient.on('md', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseDown(user);
    }
  });

  // Mouse up
  wsClient.on('mu', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseUp(user);
    }
  });

  // Pressure change
  wsClient.on('cp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setPressure(data.pressure);
      if (user.mousedown && user.tool === 'brush') {
        remoteUserHandler.commitLine(user);
      }
    }
  });

  // Size change
  wsClient.on('cs', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSize(data.size);
      ui.updateRemoteSize(data.sessionIndex, data.size);
      if (user.mousedown && user.tool === 'brush') {
        remoteUserHandler.commitLine(user);
      }
    }
  });

  // Tool change
  wsClient.on('ct', (data) => {
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
  wsClient.on('cc', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setColor(data.color);
      user.setOpacity(data.color[3]); // Sync opacity from color alpha (matches local behavior)
      ui.updateRemoteColor(data.sessionIndex, data.color);
    }
  });

  // Spacing change
  wsClient.on('csp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSpacing(data.spacing);
    }
  });

  // Smoothing change
  wsClient.on('csm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSmoothing(data.smoothing);
    }
  });

  // Hardness change
  wsClient.on('chd', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setHardness(data.hardness);
    }
  });

  // Name change
  wsClient.on('cn', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setUsername(data.name);
      ui.updateRemoteName(data.sessionIndex, data.name);
      chat.addSystemMessage(`${data.name} joined the room`);

      // Update chat user list
      app.updateChatUserList();
    }
  });

  // Key press
  wsClient.on('kp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text') {
      remoteUserHandler.handleKeyPress(user, data.key);
    }
  });

  // Clear canvas
  wsClient.on('clr', () => {
    board.clear();
  });

  // Toggle mirror
  wsClient.on('mir', () => {
    const mirror = board.toggleMirror();
    ui.updateMirrorDisplay(mirror);
  });

  // Chat message
  wsClient.on('msg', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addMessage(data.message, user);
    }
  });

  // Direct message
  wsClient.on('dm', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addDMMessage(data.message, data.sessionIndex, false);
    }
  });

  // Chat image
  wsClient.on('chat_img', (data) => {
    console.log('[CHAT_IMG] Received image from user', data.sessionIndex);

    const user = users.get(data.sessionIndex);
    if (user) {
      if (data.recipientId) {
        // DM image - add to DM conversation
        chat.addDMImage(data.imageData, data.sessionIndex, false);
      } else {
        // Public chat image
        chat.addChatImage(data.imageData, user);
      }
    } else {
      console.warn('[CHAT_IMG] User not found for sessionIndex:', data.sessionIndex);
    }
  });

  // Image brush (GIMP brushes and standard images)
  wsClient.on('gmp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleBrushLoad(user, data.brushData);
    }
  });

  // Pan mode
  wsClient.on('pan', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.panning = data.panning;
    }
  });

  // Cancel stroke
  wsClient.on('cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleCancel(user);
    }
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

  // Selection lift - remote user lifted a selection
  wsClient.on('sel_lift', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionLift(user, data.selection);
    }
  });

  // Selection move - remote user moved/transformed selection
  wsClient.on('sel_move', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionMove(user, data.corners);
    }
  });

  // Selection commit - remote user committed selection
  wsClient.on('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionCommit(user);
    }
  });

  // Selection delete - remote user deleted selection
  wsClient.on('sel_delete', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionDelete(user);
    }
  });

  // Selection fill - remote user filled selection
  wsClient.on('sel_fill', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionFill(user, data.color);
    }
  });

  // Selection stamp - remote user stamped selection
  wsClient.on('sel_stamp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionStamp(user);
    }
  });

  // Selection cancel - remote user cancelled selection
  wsClient.on('sel_cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionCancel(user);
    }
  });

  // Selection to brush - remote user converted selection to brush
  wsClient.on('sel_to_brush', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionToBrush(user, data.brushData);
    }
  });

  // Image paste - remote user pasted image content
  wsClient.on('img_paste', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleImagePaste(user, data);
    }
  });

  // Sync provide - server asking us to provide our canvas for a new user
  wsClient.on('sync_provide', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncProvide(data);
    }
  });

  // Sync canvas - receiving canvas data from another user
  wsClient.on('sync_canvas', (data) => {
    if (app.syncClient) {
      app.syncClient.handleSyncCanvas(data);
    }
  });

  // Sync complete - server finished sync process
  wsClient.on('sync_complete', () => {
    if (app.syncClient) {
      app.syncClient.handleSyncComplete();
    }
  });
}
