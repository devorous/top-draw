/**
 * ChatManager - Manages chat functionality
 */

import { MessageType } from '../network/Protocol.js';

export class ChatManager {
  #stateManager = null;
  #wsClient = null;
  #chatElement = null;
  #messageList = null;
  #chatInput = null;

  /**
   * Create a ChatManager
   * @param {StateManager} stateManager - State manager
   * @param {WebSocketClient} wsClient - WebSocket client
   */
  constructor(stateManager, wsClient) {
    this.#stateManager = stateManager;
    this.#wsClient = wsClient;
  }

  /**
   * Initialize chat elements and event listeners
   */
  init() {
    this.#chatElement = document.getElementById('chat');
    this.#messageList = document.getElementById('messageList');
    this.#chatInput = document.getElementById('chatInput');

    if (!this.#chatElement) return;

    // Hide chat initially
    $(this.#chatElement).hide();
    $(this.#chatElement).draggable();

    this.#initEventListeners();
  }

  #initEventListeners() {
    // Chat toggle button
    const chatBtn = document.getElementById('chatBtn');
    if (chatBtn) {
      chatBtn.addEventListener('click', () => {
        $(this.#chatElement).toggle();
      });
    }

    // Chat reset position button
    const chatResetBtn = document.getElementById('chatResetBtn');
    if (chatResetBtn) {
      chatResetBtn.addEventListener('click', () => {
        const boardContainer = document.getElementById('boardContainer');
        if (boardContainer && this.#chatElement) {
          this.#chatElement.style.top = '30px';
          this.#chatElement.style.left = `${boardContainer.offsetWidth - 200}px`;
        }
      });
    }

    // Send message button
    const sendBtn = document.getElementById('sendMessageBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', () => this.#sendMessage());
    }

    // Enter key to send
    if (this.#chatInput) {
      this.#chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.#sendMessage();
        }
      });
    }
  }

  #sendMessage() {
    const message = this.#chatInput?.value?.trim();
    if (!message) return;

    const user = this.#stateManager.get('localUser');
    if (!user) return;

    // Clear input
    this.#chatInput.value = '';

    // Display locally
    this.displayMessage(message, user);

    // Broadcast
    this.#wsClient.broadcast(MessageType.CHAT_MESSAGE, { message });
  }

  /**
   * Display a message in the chat
   * @param {string} message - Message text
   * @param {Object|string} user - User object or 'system'
   */
  displayMessage(message, user) {
    if (!message || !this.#messageList) return;

    const li = document.createElement('li');
    li.className = 'message';

    if (user === 'system') {
      li.className = 'system message';
      li.innerHTML = `<span class="messageText">${this.#escapeHtml(message)}</span>`;
    } else {
      const username = user.username || 'Anonymous';
      li.innerHTML = `
        <span class="messageName">${this.#escapeHtml(username)}: </span>
        <span class="messageText">${this.#escapeHtml(message)}</span>
      `;
    }

    this.#messageList.appendChild(li);

    // Scroll to bottom
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  /**
   * Receive a message from a remote user
   * @param {string} message - Message text
   * @param {Object} user - Remote user
   */
  receiveMessage(message, user) {
    this.displayMessage(message, user);
  }

  /**
   * Display a system message (user joined/left, etc)
   * @param {string} message - System message
   */
  systemMessage(message) {
    this.displayMessage(message, 'system');
  }

  #escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Show the chat panel
   */
  show() {
    if (this.#chatElement) {
      $(this.#chatElement).show();
    }
  }

  /**
   * Hide the chat panel
   */
  hide() {
    if (this.#chatElement) {
      $(this.#chatElement).hide();
    }
  }

  /**
   * Toggle chat visibility
   */
  toggle() {
    if (this.#chatElement) {
      $(this.#chatElement).toggle();
    }
  }
}
