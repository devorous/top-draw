/**
 * WebSocketClient - WebSocket wrapper with auto-reconnect
 */

import { MessageType, createConnectMessage } from './Protocol.js';

export class WebSocketClient extends EventTarget {
  #socket = null;
  #url = '';
  #reconnectAttempts = 0;
  #maxReconnectAttempts = 5;
  #reconnectDelay = 1000;
  #userId = null;
  #userData = null;

  /**
   * Create a WebSocketClient
   * @param {number} userId - User ID
   */
  constructor(userId) {
    super();
    this.#userId = userId;
    this.#buildUrl();
  }

  #buildUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.#url = `${protocol}://${window.location.host}/ws`;
  }

  /**
   * Connect to the WebSocket server
   * @param {Object} userData - User data to send on connect
   */
  connect(userData) {
    this.#userData = userData;

    try {
      this.#socket = new WebSocket(this.#url);
      this.#setupEventHandlers();
    } catch (error) {
      console.error('WebSocket connection error:', error);
      this.#scheduleReconnect();
    }
  }

  #setupEventHandlers() {
    this.#socket.onopen = () => {
      console.log('WebSocket connected!');
      this.#reconnectAttempts = 0;

      // Send connect message
      this.send(createConnectMessage(this.#userId, this.#userData));

      this.dispatchEvent(new CustomEvent('open'));
    };

    this.#socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.dispatchEvent(new CustomEvent('message', { detail: data }));
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };

    this.#socket.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      this.dispatchEvent(new CustomEvent('close', { detail: event }));

      if (!event.wasClean) {
        this.#scheduleReconnect();
      }
    };

    this.#socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };
  }

  #scheduleReconnect() {
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.#reconnectAttempts++;
    const delay = this.#reconnectDelay * Math.pow(2, this.#reconnectAttempts - 1);

    console.log(`Reconnecting in ${delay}ms (attempt ${this.#reconnectAttempts})`);

    setTimeout(() => {
      if (this.#userData) {
        this.connect(this.#userData);
      }
    }, delay);
  }

  /**
   * Send a message to the server
   * @param {Object} data - Message data to send
   */
  send(data) {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket not connected, message not sent:', data);
    }
  }

  /**
   * Send a broadcast message
   * @param {string} type - Message type
   * @param {Object} data - Additional message data
   */
  broadcast(type, data = {}) {
    this.send({
      command: MessageType.BROADCAST,
      type,
      id: this.#userId,
      ...data
    });
  }

  /**
   * Close the WebSocket connection
   */
  close() {
    if (this.#socket) {
      this.#socket.close();
      this.#socket = null;
    }
  }

  /**
   * Check if connected
   * @returns {boolean} True if connected
   */
  get isConnected() {
    return this.#socket && this.#socket.readyState === WebSocket.OPEN;
  }

  /**
   * Get user ID
   * @returns {number} User ID
   */
  get userId() {
    return this.#userId;
  }
}
