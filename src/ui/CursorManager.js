/**
 * CursorManager - Manages cursor display for all users
 */

import { MessageType } from '../network/Protocol.js';

export class CursorManager {
  #stateManager = null;
  #wsClient = null;
  #canvasManager = null;
  #localCursor = null;
  #localCircle = null;
  #localSquare = null;

  /**
   * Create a CursorManager
   * @param {StateManager} stateManager - State manager
   * @param {WebSocketClient} wsClient - WebSocket client
   * @param {CanvasManager} canvasManager - Canvas manager
   */
  constructor(stateManager, wsClient, canvasManager) {
    this.#stateManager = stateManager;
    this.#wsClient = wsClient;
    this.#canvasManager = canvasManager;
  }

  /**
   * Initialize cursor elements
   */
  init() {
    this.#localCursor = document.querySelector('.cursor.self');
    this.#localCircle = document.querySelector('.circle.self');
    this.#localSquare = document.querySelector('.square.self');

    // Hide cursor initially
    if (this.#localCursor) {
      this.#localCursor.style.display = 'none';
    }
  }

  /**
   * Show the local cursor
   */
  showLocalCursor() {
    if (this.#localCursor) {
      this.#localCursor.style.display = 'block';
    }
  }

  /**
   * Update local cursor position
   * @param {number} x - X position
   * @param {number} y - Y position
   */
  updateLocalPosition(x, y) {
    const user = this.#stateManager.get('localUser');
    if (!user) return;

    user.x = x;
    user.y = y;

    // Update cursor element position
    if (this.#localCursor) {
      this.#localCursor.style.left = `${x - 100}px`;
      this.#localCursor.style.top = `${y - 100}px`;
    }

    if (this.#localCircle) {
      this.#localCircle.setAttribute('cx', x);
      this.#localCircle.setAttribute('cy', y);
    }

    if (this.#localSquare) {
      this.#localSquare.setAttribute('x', x - user.size);
      this.#localSquare.setAttribute('y', y - user.size);
    }

    // Broadcast position
    this.#wsClient.broadcast(MessageType.CURSOR_MOVE, { x, y });
  }

  /**
   * Update remote user cursor position
   * @param {Object} data - Message data with x, y
   * @param {Object} user - Remote user
   */
  updateRemotePosition(data, user) {
    if (!user) return;

    // Update user state
    if (user.lastx === null) {
      user.lastx = data.x;
      user.lasty = data.y;
    }

    user.x = data.x;
    user.y = data.y;

    // Update cursor elements
    const cursor = document.querySelector(`.cursor.${user.id}`);
    const circle = document.querySelector(`.circle.${user.id}`);
    const square = document.querySelector(`.square.${user.id}`);

    if (cursor) {
      cursor.style.left = `${data.x - 100}px`;
      cursor.style.top = `${data.y - 100}px`;
    }

    if (circle) {
      circle.setAttribute('cx', data.x);
      circle.setAttribute('cy', data.y);
    }

    if (square) {
      square.setAttribute('x', data.x - user.size);
      square.setAttribute('y', data.y - user.size);
    }

    // Update last position
    user.lastx = data.x;
    user.lasty = data.y;
  }

  /**
   * Create cursor elements for a new user
   * @param {Object} user - User data
   */
  createUserCursor(user) {
    const cursorsSvg = document.getElementById('cursorsSvg');
    const cursorsContainer = document.querySelector('.cursors');

    if (!cursorsSvg || !cursorsContainer) return;

    // Create circle cursor
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', `circle ${user.id}`);
    circle.setAttribute('stroke', 'grey');
    circle.setAttribute('stroke-width', '1');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', user.size || 10);
    cursorsSvg.appendChild(circle);

    // Create square cursor (for gimp tool)
    const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    square.setAttribute('class', `square ${user.id}`);
    square.setAttribute('stroke', 'grey');
    square.setAttribute('stroke-width', '1');
    square.setAttribute('fill', 'none');
    square.setAttribute('x', user.x - user.size);
    square.setAttribute('y', user.y - user.size);
    square.setAttribute('width', (user.size || 10) * 2);
    square.setAttribute('height', (user.size || 10) * 2);
    if (user.tool !== 'gimp') {
      square.style.display = 'none';
    }
    cursorsSvg.appendChild(square);

    // Create cursor div with name and text input
    const cursor = document.createElement('div');
    cursor.className = `cursor ${user.id}`;
    cursor.style.left = `${user.x}px`;
    cursor.style.top = `${user.y}px`;

    const name = document.createElement('text');
    name.className = `name ${user.id}`;
    name.textContent = user.username || user.id.toString();

    const text = document.createElement('text');
    text.className = `text ${user.id}`;
    text.style.width = '400px';
    text.style.color = this.#formatColor(user.color);
    text.style.fontSize = `${(user.size || 10) + 5}px`;
    if (user.tool !== 'text') {
      text.style.display = 'none';
    }

    const textInput = document.createElement('text');
    textInput.className = `textInput ${user.id}`;
    textInput.textContent = user.text || '';

    const line = document.createElement('text');
    line.textContent = '|';

    text.appendChild(textInput);
    text.appendChild(line);
    cursor.appendChild(name);
    cursor.appendChild(text);
    cursorsContainer.appendChild(cursor);
  }

  /**
   * Remove cursor elements for a user
   * @param {number} userId - User ID
   */
  removeUserCursor(userId) {
    const elements = document.querySelectorAll(`.${userId}`);
    elements.forEach(el => el.remove());
  }

  /**
   * Update cursor size display
   * @param {Object} user - User object
   * @param {number} size - New size
   */
  updateSize(user, size) {
    const circle = document.querySelector(`.circle.${user.id}`);
    const square = document.querySelector(`.square.${user.id}`);
    const text = document.querySelector(`.${user.id} .text`);

    if (circle) {
      circle.setAttribute('r', size);
    }

    if (square) {
      square.setAttribute('width', size * 2);
      square.setAttribute('height', size * 2);
    }

    if (text) {
      text.style.fontSize = `${size + 5}px`;
    }
  }

  /**
   * Update cursor color display
   * @param {Object} user - User object
   * @param {Array|string} color - New color
   */
  updateColor(user, color) {
    const text = document.querySelector(`.${user.id} .text`);
    if (text) {
      text.style.color = this.#formatColor(color);
    }
  }

  #formatColor(color) {
    if (typeof color === 'string') return color;
    if (Array.isArray(color)) return `rgba(${color.join(',')})`;
    return '#000';
  }
}
