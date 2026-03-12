/** @fileoverview Handles chat-related WebSocket events including public messages, DMs, and images. */

/**
 * Sets up WebSocket event handlers for chat functionality.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupChatHandlers(wsClient, app) {
  const { users, chat } = app;

  wsClient.on('msg', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addMessage(data.message, user);
    }
  });

  wsClient.on('dm', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addDMMessage(data.message, data.sessionIndex, false);
    }
  });

  wsClient.on('chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
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
}
