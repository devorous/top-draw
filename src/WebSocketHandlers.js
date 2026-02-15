import { User } from './User.js';

/**
 * Sets up all WebSocket message handlers for the app
 */
export function setupWebSocketHandlers(app) {
  const { wsClient, users, ui, board, chat, remoteUserHandler } = app;

  // Handler map for event replay during sync buffering
  const handlerMap = new Map();

  /**
   * Wrap a handler so that during sync buffering, events are queued
   * instead of processed immediately. The handlerMap stores the original
   * handler so replayBuffer() can call it after sync completes.
   */
  function wrapHandler(eventName, handler) {
    handlerMap.set(eventName, handler);
    wsClient.on(eventName, (data) => {
      if (app.syncClient?.buffering) {
        app.syncClient.bufferEvent(eventName, data);
        return;
      }
      handler(data);
    });
  }

  // --- Non-buffered events (metadata/chat/sync control) ---

  // Users list received
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
          users.set(userData.sessionIndex, user);

          const boardData = ui.createUserBoard(userData.sessionIndex);
          user.board = boardData.board;
          user.context = boardData.context;

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

  // Name change
  wsClient.on('cn', (data) => {
    let user = users.get(data.sessionIndex);
    if (!user) {
      // User wasn't in any users list yet — create from scratch
      user = new User(data.sessionIndex, { username: data.name });
      users.set(data.sessionIndex, user);

      const boardData = ui.createUserBoard(data.sessionIndex);
      user.board = boardData.board;
      user.context = boardData.context;

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

  // Auth result
  wsClient.on('auth_result', (data) => {
    if (app.auth) {
      app.auth.handleAuthResult(data);
    }
  });

  // Moderation notify
  wsClient.on('mod_notify', (data) => {
    const actionNames = ['kicked', 'muted', 'banned', 'unmuted', 'unbanned'];
    const actionName = actionNames[data.actionType] || 'moderated';
    const message = `${data.targetName} was ${actionName} by ${data.issuerName}`;
    if (data.reason) {
      chat.addSystemMessage(`${message} — ${data.reason}`);
    } else {
      chat.addSystemMessage(message);
    }
    ui.showToast(message, 3000);

    // Update muted state on target user
    if (data.actionType === 1) {
      // Muted
      const targetUser = users.get(data.targetSessionIndex);
      if (targetUser) targetUser.isMuted = true;

      // If we are the target, update self muted state
      if (data.targetSessionIndex === app.sessionIndex) {
        app.self.isMuted = true;
        ui.setMutedState(true);
        ui.showToast(`You have been muted${data.reason ? ': ' + data.reason : ''}`, 5000);
      }
    } else if (data.actionType === 3) {
      // Unmuted - find user by name since they might not have a session index in the notify
      for (const [, u] of users) {
        if (u.username === data.targetName) {
          u.isMuted = false;
          break;
        }
      }

      // If we are the target, update self muted state
      if (data.targetSessionIndex === app.sessionIndex || data.targetName === app.self.username) {
        app.self.isMuted = false;
        ui.setMutedState(false);
        ui.showToast('You have been unmuted', 3000);
      }
    }

    // If we are the target of a kick/ban, show a message
    if (data.targetSessionIndex === app.sessionIndex && (data.actionType === 0 || data.actionType === 2)) {
      ui.showToast(`You have been ${actionName}${data.reason ? ': ' + data.reason : ''}`, 5000);
    }

    // Refresh mod panel if open
    if (app.moderation?.panelVisible) {
      wsClient.requestModList();
    }
  });

  // Moderation result (error feedback)
  wsClient.on('mod_result', (data) => {
    if (!data.success && data.error) {
      ui.showToast(data.error, 3000);
    }
    // Refresh mod panel after any action
    if (data.success && app.moderation?.panelVisible) {
      wsClient.requestModList();
    }
  });

  // Moderation list (for mod panel)
  wsClient.on('mod_list', (data) => {
    if (app.moderation) {
      app.moderation.updateModEntries(data.entries);
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

  // --- Buffered events (all events that modify canvas state) ---

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

  // Selection lift - remote user lifted a selection
  wrapHandler('sel_lift', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionLift(user, data.selection, data.lassoPath);
    }
  });

  // Selection move - remote user moved/transformed selection
  wrapHandler('sel_move', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionMove(user, data.corners);
    }
  });

  // Selection commit - remote user committed selection
  wrapHandler('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionCommit(user);
    }
  });

  // Selection delete - remote user deleted selection
  wrapHandler('sel_delete', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionDelete(user);
    }
  });

  // Selection fill - remote user filled selection
  wrapHandler('sel_fill', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionFill(user, data.color);
    }
  });

  // Selection stamp - remote user stamped selection
  wrapHandler('sel_stamp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionStamp(user);
    }
  });

  // Selection cancel - remote user cancelled selection
  wrapHandler('sel_cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionCancel(user);
    }
  });

  // Selection to brush - remote user converted selection to brush
  wrapHandler('sel_to_brush', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionToBrush(user, data.brushData);
    }
  });

  // Image paste - remote user pasted image content
  wrapHandler('img_paste', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleImagePaste(user, data);
    }
  });

  // Pass handler map to sync client for replay
  if (app.syncClient) {
    app.syncClient.setHandlerMap(handlerMap);
  }
}
