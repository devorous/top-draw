/**
 * ChatHandlers
 *
 * Handles chat-related events:
 * - Public chat messages
 * - Direct messages (DMs)
 * - Chat images (public and DM)
 */

export function setupChatHandlers(wsClient, app) {
  const { users, chat } = app;

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
}
