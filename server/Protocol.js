/**
 * WebSocket message protocol definitions (Server-side)
 * Mirrors the client-side Protocol.js
 */

const MessageType = {
  // Connection
  CONNECT: 'connect',
  CONNECTED: 'connected',
  CURRENT_USERS: 'currentUsers',
  BOARD_SETTINGS: 'boardSettings',
  USER_LEFT: 'userLeft',
  BROADCAST: 'broadcast',

  // Cursor & Pointer
  CURSOR_MOVE: 'cursor:move',
  POINTER_DOWN: 'pointer:down',
  POINTER_UP: 'pointer:up',

  // User State Changes
  USER_COLOR: 'user:color',
  USER_SIZE: 'user:size',
  USER_TOOL: 'user:tool',
  USER_NAME: 'user:name',
  USER_PRESSURE: 'user:pressure',
  USER_SPACING: 'user:spacing',
  USER_PANNING: 'user:panning',

  // Text Tool
  TEXT_INPUT: 'text:input',

  // GIMP Brush
  BRUSH_GIMP: 'brush:gimp',

  // Board Actions
  BOARD_CLEAR: 'board:clear',
  BOARD_MIRROR: 'board:mirror',

  // Chat
  CHAT_MESSAGE: 'chat:message'
};

module.exports = { MessageType };
