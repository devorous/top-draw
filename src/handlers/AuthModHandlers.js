/**
 * AuthModHandlers
 *
 * Handles authentication and moderation events:
 * - Auth result (login/register success/failure)
 * - Moderation notifications (user kicked/muted/banned)
 * - Moderation results (action feedback)
 * - Moderation list (active bans/mutes)
 */

export function setupAuthModHandlers(wsClient, app) {
  const { users, ui, chat } = app;

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

  // Room list response
  wsClient.on('room_list_response', (data) => {
    if (app.landingPage) {
      app.landingPage.handleRoomListResponse(data.rooms);
    }
  });
}
