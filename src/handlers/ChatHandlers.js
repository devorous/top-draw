/** @fileoverview Handles chat-related WebSocket events including public messages, DMs, and images. */

import { broadcastChatPopoutEvent } from '../platform/chatPopoutBridge.js';

function chatNameColor(color) {
  if (!Array.isArray(color)) return color || '#8ba3c7';
  const [r = 139, g = 163, b = 199] = color;
  const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  if (luminance < 72) return 'var(--role-user)';
  return `rgb(${r}, ${g}, ${b})`;
}

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
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId
      );
      broadcastChatPopoutEvent('addChatMessage', [
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId
      ]);
    }
  });

  wsClient.on('dm', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addChatDM(data.message, data.sessionIndex, false, data.messageId);
      broadcastChatPopoutEvent('addChatDM', [data.message, data.sessionIndex, false, data.messageId]);
    }
  });

  wsClient.on('staff_msg', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user && app.svelteComponents?.chat) {
      app.svelteComponents.chat.addStaffMessage(
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId
      );
      broadcastChatPopoutEvent('addStaffMessage', [
        user.username,
        data.message,
        chatNameColor(user.color),
        data.sessionIndex,
        data.messageId
      ]);
    }
  });

  wsClient.on('staff_chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    const user = users.get(data.sessionIndex);
    if (user) {
      app.svelteComponents?.chat?.addStaffImage(data.imageData, user, data.messageId);
      broadcastChatPopoutEvent('addStaffImage', [data.imageData, user, data.messageId]);
    }
  });

  wsClient.on('chat_img', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    console.log('[CHAT_IMG] Received image from user', data.sessionIndex);

    const user = users.get(data.sessionIndex);
    if (user) {
      if (data.recipientId !== undefined && data.recipientId !== null) {
        app.svelteComponents.chat?.addDMImage(data.imageData, data.sessionIndex, false, data.messageId);
        broadcastChatPopoutEvent('addDMImage', [data.imageData, data.sessionIndex, false, data.messageId]);
      } else {
        app.svelteComponents.chat?.addChatImage(data.imageData, user, data.messageId);
        broadcastChatPopoutEvent('addChatImage', [data.imageData, user, data.messageId]);
      }
    } else {
      console.warn('[CHAT_IMG] User not found for sessionIndex:', data.sessionIndex);
    }
  });

  wsClient.on('chat_reaction', (data) => {
    if (data.sessionIndex === app.sessionIndex) return;
    app.svelteComponents?.chat?.applyReaction(data);
    broadcastChatPopoutEvent('applyReaction', [data]);
  });
}
