/**
 * MessageHandler - Routes incoming WebSocket messages to appropriate handlers
 */

import { MessageType } from './Protocol.js';

export class MessageHandler {
  #handlers = new Map();
  #stateManager = null;

  /**
   * Create a MessageHandler
   * @param {StateManager} stateManager - State manager instance
   */
  constructor(stateManager) {
    this.#stateManager = stateManager;
  }

  /**
   * Register a handler for a specific message type
   * @param {string} type - Message type
   * @param {Function} handler - Handler function(data, user)
   */
  on(type, handler) {
    if (!this.#handlers.has(type)) {
      this.#handlers.set(type, []);
    }
    this.#handlers.get(type).push(handler);
  }

  /**
   * Remove a handler for a specific message type
   * @param {string} type - Message type
   * @param {Function} handler - Handler function to remove
   */
  off(type, handler) {
    if (this.#handlers.has(type)) {
      const handlers = this.#handlers.get(type);
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * Handle an incoming message
   * @param {Object} data - Message data
   */
  handle(data) {
    const { command, type } = data;

    // Handle top-level commands
    switch (command) {
      case MessageType.CONNECTED:
        this.#dispatch('connected', data);
        break;

      case MessageType.CURRENT_USERS:
        this.#dispatch('currentUsers', data);
        break;

      case MessageType.BOARD_SETTINGS:
        this.#dispatch('boardSettings', data);
        break;

      case MessageType.USER_LEFT:
        this.#dispatch('userLeft', data);
        break;

      case MessageType.BROADCAST:
        this.#handleBroadcast(data);
        break;

      default:
        console.warn('Unknown command:', command);
    }
  }

  #handleBroadcast(data) {
    const { type, id } = data;
    const user = this.#stateManager.getUser(id);

    if (!user && id !== this.#stateManager.get('userID')) {
      console.warn('Message from unknown user:', id);
      return;
    }

    // Dispatch to registered handlers
    this.#dispatch(type, data, user);
  }

  #dispatch(type, data, user = null) {
    const handlers = this.#handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data, user);
        } catch (error) {
          console.error(`Error in handler for ${type}:`, error);
        }
      }
    }
  }

  /**
   * Register default handlers for common message types
   * @param {Object} managers - Object containing manager instances
   */
  registerDefaultHandlers(managers) {
    const { canvas, tools, ui, viewport, chat } = managers;

    // Connection handlers
    this.on('connected', () => {
      console.log('Connected to server');
    });

    this.on('currentUsers', (data) => {
      this.#handleCurrentUsers(data);
    });

    this.on('boardSettings', (data) => {
      this.#stateManager.set('mirror', data.settings.mirror);
    });

    this.on('userLeft', (data) => {
      this.#handleUserLeft(data);
    });

    // Cursor/pointer handlers - delegate to UI manager
    if (ui) {
      this.on(MessageType.CURSOR_MOVE, (data, user) => {
        ui.handleCursorMove(data, user);
      });
    }

    // Tool-related handlers - delegate to tools
    if (tools) {
      this.on(MessageType.POINTER_DOWN, (data, user) => {
        tools.handlePointerDown(data, user);
      });

      this.on(MessageType.POINTER_UP, (data, user) => {
        tools.handlePointerUp(data, user);
      });

      this.on(MessageType.USER_TOOL, (data, user) => {
        tools.handleToolChange(data, user);
      });
    }

    // Chat handler
    if (chat) {
      this.on(MessageType.CHAT_MESSAGE, (data, user) => {
        chat.receiveMessage(data.message, user);
      });
    }
  }

  #handleCurrentUsers(data) {
    const localUserId = this.#stateManager.get('userID');
    const existingUsers = this.#stateManager.get('users');
    const existingIds = existingUsers.map(u => u.id);

    for (const userData of data.users) {
      if (!existingIds.includes(userData.id) && userData.id !== localUserId) {
        this.#stateManager.addUser(userData.userdata);
        this.#dispatch('userJoined', userData);
      }
    }
  }

  #handleUserLeft(data) {
    const user = this.#stateManager.getUser(data.id);
    if (user) {
      this.#dispatch('userLeaving', { user, id: data.id });
      this.#stateManager.removeUser(data.id);
    }
  }
}
