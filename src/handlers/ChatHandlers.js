/** @fileoverview Handles chat-related WebSocket events including public messages, DMs, and images. */

/**
 * Sets up WebSocket event handlers for chat functionality.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupChatHandlers(wsClient, app) {
  const { users } = app;

  wsClient.on('msg', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addChatMessage(
        user.username,
        data.message,
        `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3] / 255})`,
        data.sessionIndex,
        data.messageId
      );
    }
  });

  wsClient.on('dm', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addChatDM(data.message, data.sessionIndex, false, data.messageId);
    }
  });

  wsClient.on('staff_msg', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addStaffMessage(
        user.username,
        data.message,
        `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3] / 255})`,
        data.sessionIndex,
        data.messageId
      );
    }
  });

  wsClient.on('staff_chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user) {
      app.svelteComponents?.chat?.addStaffImage(data.imageData, user, data.messageId);
    }
  });

  wsClient.on('chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    console.log('[CHAT_IMG] Received image from user', data.sessionIndex);

    const user = users.get(data.sessionIndex);
    if (user) {
      if (data.recipientId !== undefined && data.recipientId !== null) {
        app.svelteComponents.chat?.addDMImage(data.imageData, data.sessionIndex, false, data.messageId);
      } else {
        app.svelteComponents.chat?.addChatImage(data.imageData, user, data.messageId);
      }
    } else {
      console.warn('[CHAT_IMG] User not found for sessionIndex:', data.sessionIndex);
    }
  });

  wsClient.on('chat_reaction', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    app.svelteComponents?.chat?.applyReaction(data);
  });
}
