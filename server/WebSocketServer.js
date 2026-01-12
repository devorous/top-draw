/**
 * WebSocketServer - WebSocket server wrapper
 */

const WebSocket = require('ws');
const { MessageType } = require('./Protocol');
const { UserManager } = require('./UserManager');
const { BoardState } = require('./BoardState');

class WebSocketServer {
  #wss = null;
  #userManager = null;
  #boardState = null;

  /**
   * Create a WebSocketServer
   * @param {http.Server} server - HTTP server to attach to
   */
  constructor(server) {
    this.#wss = new WebSocket.Server({ server });
    this.#userManager = new UserManager();
    this.#boardState = new BoardState();

    this.#setupEventHandlers();
  }

  #setupEventHandlers() {
    this.#wss.on('connection', (ws, req) => {
      console.log('New connection from:', req.socket.remoteAddress);

      ws.id = '';

      ws.on('message', (rawData) => {
        try {
          const data = JSON.parse(rawData);
          this.#handleMessage(ws, data);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      });

      ws.on('close', () => {
        console.log('Disconnected:', ws.id);
        this.#handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });
  }

  #handleMessage(ws, data) {
    switch (data.command) {
      case MessageType.CONNECT:
        this.#handleConnect(ws, data);
        break;

      case MessageType.BROADCAST:
        this.#handleBroadcast(ws, data);
        break;

      default:
        console.warn('Unknown command:', data.command);
    }
  }

  #handleConnect(ws, data) {
    ws.id = data.id;

    // Add user to manager
    this.#userManager.addUser(data);

    // Send current users to all clients
    this.#broadcast({
      command: MessageType.CURRENT_USERS,
      users: this.#userManager.getAllUsers()
    });

    // Send board settings
    this.#broadcast({
      command: MessageType.BOARD_SETTINGS,
      settings: this.#boardState.getSettings()
    });

    // Send connected confirmation to the new user
    this.#sendTo(ws.id, {
      command: MessageType.CONNECTED,
      id: data.id
    });

    console.log(`User ${data.id} connected. Total users: ${this.#userManager.count}`);
  }

  #handleBroadcast(ws, data) {
    // Update user state
    this.#userManager.updateUser(data);

    // Handle special message types
    if (data.type === MessageType.BOARD_MIRROR) {
      this.#boardState.toggleMirror();
    }

    // Broadcast to all other clients
    this.#broadcast(data, ws.id);
  }

  #handleDisconnect(ws) {
    const user = this.#userManager.removeUser(ws.id);

    if (user) {
      // Notify other clients
      this.#broadcast({
        command: MessageType.USER_LEFT,
        id: ws.id
      });

      console.log(`User ${ws.id} disconnected. Remaining users: ${this.#userManager.count}`);

      // Reset board state if no users left
      if (!this.#userManager.hasUsers) {
        this.#boardState.reset();
        console.log('All users disconnected. Board state reset.');
      }
    }
  }

  /**
   * Broadcast a message to all clients except the sender
   * @param {Object} data - Message data
   * @param {number} excludeId - ID to exclude from broadcast
   */
  #broadcast(data, excludeId = null) {
    const message = JSON.stringify(data);

    this.#wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        // For connected confirmation, only send to that client
        if (data.command === MessageType.CONNECTED) {
          if (data.id === client.id) {
            client.send(message);
          }
        } else if (client.id !== excludeId) {
          // Send to all except sender
          client.send(message);
        }
      }
    });
  }

  /**
   * Send a message to a specific client
   * @param {number} id - Client ID
   * @param {Object} data - Message data
   */
  #sendTo(id, data) {
    const message = JSON.stringify(data);

    this.#wss.clients.forEach((client) => {
      if (client.id === id && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /**
   * Get the user manager
   * @returns {UserManager}
   */
  get userManager() {
    return this.#userManager;
  }

  /**
   * Get the board state
   * @returns {BoardState}
   */
  get boardState() {
    return this.#boardState;
  }

  /**
   * Get connected client count
   * @returns {number}
   */
  get clientCount() {
    return this.#wss.clients.size;
  }
}

module.exports = { WebSocketServer };
