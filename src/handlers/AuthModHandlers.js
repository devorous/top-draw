/** @fileoverview Handles authentication and moderation events from the WebSocket client. */

/**
 * Sets up WebSocket event handlers for authentication and moderation.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupAuthModHandlers(wsClient, app) {
  const { users, ui, chat } = app;

  wsClient.on('auth_result', (data) => {
    if (app.auth) {
      app.auth.handleAuthResult(data);
    }
  });

  wsClient.on('mod_notify', (data) => {
    if (data.actionType === 5) {
      // Reason added after the fact
      if (data.reason) {
        chat.addSystemMessage(`Reason for ${data.targetName}: ${data.reason} (by ${data.issuerName})`);
        ui.showToast(`Reason added for ${data.targetName}`, 2000);
      }
      return;
    }

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
        app._updateBlurCannotDraw();
        ui.showToast('You have been unmuted', 3000);
      }
    }

    if (data.targetSessionIndex === app.sessionIndex && (data.actionType === 0 || data.actionType === 2)) {
      ui.showToast(`You have been ${actionName}${data.reason ? ': ' + data.reason : ''}`, 5000);
    }

    if (app.moderation?.panelVisible) {
      app.moderation._requestList();
    }
  });

  wsClient.on('mod_result', (data) => {
    if (!data.success && data.error) {
      ui.showToast(data.error, 3000);
    }
    // Always refresh room list to sync ownership state after any mod action
    wsClient.requestRoomList();
    if (data.success && app.moderation?.panelVisible) {
      app.moderation._requestList();
    }
  });

  wsClient.on('mod_list', (data) => {
    if (app.moderation) {
      app.moderation.updateModEntries(data.entries);
    }
  });

  wsClient.on('room_list_response', (data) => {
    if (app.landingPage) {
      app.landingPage.handleRoomListResponse(data.rooms);
    }

    if (app.currentRoomId && data.rooms) {
      const currentRoom = data.rooms.find(r => r.id === app.currentRoomId);
      if (currentRoom) {
        app.currentRoomData = currentRoom;
        app.updateRoomSettingsButtonVisibility();
      }
    }
  });

  wsClient.on('room_ownership', (data) => {
    console.log('[room_ownership] received:', data);
    // Update local room data when ownership changes
    if (app.currentRoomData) {
      app.currentRoomData.ownerId = data.ownerId || null;
      app.currentRoomData.ownerUsername = data.ownerUsername || null;
    }
    app.updateRoomSettingsButtonVisibility();

    // Show notification based on current room state after update
    if (app.currentRoomData?.ownerId) {
      const ownerName = app.currentRoomData.ownerUsername || 'Someone';
      ui.showToast(`${ownerName} registered this room`, 3000);
    } else {
      ui.showToast('This room has been unregistered', 3000);
    }
  });

  wsClient.on('mod_wipe', (data) => {
    const targetIndex = data.targetSessionIndex;
    const targetName = data.targetName || `User ${targetIndex}`;
    const issuerName = data.issuerName || 'Moderator';

    // Wipe all strokes from this user across all layers
    if (app.board?.layerManager) {
      const removed = app.board.layerManager.wipeUserStrokes(targetIndex);
      if (removed) {
        app.board.composite();
      }
    }

    // Clear tile ownership for wiped user
    if (app.board?.tileOwnershipManager) {
      app.board.tileOwnershipManager.clearUserOwnership(targetIndex);
    }

    chat.addSystemMessage(`All strokes from ${targetName} were removed by ${issuerName}`);
    ui.showToast(`${targetName}'s strokes wiped by ${issuerName}`, 3000);
  });
}
