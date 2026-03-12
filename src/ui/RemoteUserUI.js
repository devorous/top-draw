/**
 * @fileoverview Manages UI elements for remote users (cursors, boards, user list entries).
 */

/**
 * RemoteUserUI class
 */
export class RemoteUserUI {
  /**
   * @param {Object} elements - DOM element references
   * @param {Object} icons - Tool icons map
   */
  constructor(elements, icons) {
    this.elements = elements;
    this.icons = icons;
    this.cursors = new Map();
  }

  /**
   * Create all UI elements for a new remote user.
   * @param {string} userId - User's session ID
   * @param {Object} userData - User initial state data
   */
  createRemoteUser(userId, userData) {
    const id = `u${userId}`;
    const cursor = document.createElement('div');
    cursor.className = `cursor ${id}`;
    cursor.style.left = `${userData.x}px`;
    cursor.style.top = `${userData.y}px`;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', `circle ${id}`);
    circle.setAttribute('stroke', 'grey');
    circle.setAttribute('stroke-width', '1');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', '10');

    const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    square.setAttribute('class', `square ${id}`);
    square.setAttribute('stroke', 'grey');
    square.setAttribute('stroke-width', '1');
    square.setAttribute('fill', 'none');
    square.setAttribute('x', userData.x - userData.size);
    square.setAttribute('y', userData.y - userData.size);
    square.setAttribute('height', userData.size * 2);
    square.setAttribute('width', userData.size * 2);

    if (userData.tool !== 'imageBrush' && userData.tool !== 'blur') {
      square.style.display = 'none';
    }

    const crosshair = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    crosshair.setAttribute('class', `crosshair ${id}`);
    crosshair.style.display = userData.tool === 'select' ? 'block' : 'none';
    const chSize = 10;
    const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hLine.setAttribute('x1', -chSize);
    hLine.setAttribute('y1', '0');
    hLine.setAttribute('x2', chSize);
    hLine.setAttribute('y2', '0');
    hLine.setAttribute('stroke', 'grey');
    hLine.setAttribute('stroke-width', '1');
    const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vLine.setAttribute('x1', '0');
    vLine.setAttribute('y1', -chSize);
    vLine.setAttribute('x2', '0');
    vLine.setAttribute('y2', chSize);
    vLine.setAttribute('stroke', 'grey');
    vLine.setAttribute('stroke-width', '1');
    crosshair.appendChild(hLine);
    crosshair.appendChild(vLine);

    const name = document.createElement('text');
    name.className = `name ${id}`;
    name.textContent = userData.username || userId;

    const text = document.createElement('text');
    text.className = `text ${id}`;
    text.style.width = '400px';
    text.style.color = `rgb(${userData.color[0]}, ${userData.color[1]}, ${userData.color[2]})`;
    text.style.opacity = userData.color[3] ?? 1;
    text.style.fontSize = `${userData.size + 5}px`;

    if (userData.tool !== 'text') {
      text.style.display = 'none';
    }

    const textInput = document.createElement('text');
    textInput.className = `textInput ${id}`;
    textInput.textContent = userData.text || '';

    const line = document.createElement('text');
    line.textContent = '|';

    text.appendChild(textInput);
    text.appendChild(line);

    this.elements.cursorsSvg.appendChild(circle);
    this.elements.cursorsSvg.appendChild(square);
    this.elements.cursorsSvg.appendChild(crosshair);
    cursor.appendChild(name);
    cursor.appendChild(text);

    document.querySelector('.cursors').appendChild(cursor);

    this.createUserListEntry(userId, userData);
    this.createUserBoard(userId);

    this.cursors.set(userId, { cursor, circle, square, crosshair, text, textInput, name });
  }

  /**
   * Create a dedicated canvas layer for a remote user.
   * @param {string} userId - User's session ID
   * @returns {Object} - Board element and context
   */
  createUserBoard(userId) {
    const id = `u${userId}`;
    const board = document.createElement('canvas');
    board.setAttribute('height', this.elements.board.height);
    board.setAttribute('width', this.elements.board.width);
    board.className = `userBoard ${id}`;
    this.elements.userBoards.appendChild(board);

    const context = board.getContext('2d');
    context.lineCap = 'round';
    context.lineJoin = 'round';

    return { board, context };
  }

  /**
   * Create user list entry showing tool, color, name, and role badge.
   * @param {string} userId - User's session ID
   * @param {Object} userData - User state data
   */
  createUserListEntry(userId, userData) {
    const id = `u${userId}`;
    const entry = document.createElement('div');
    entry.className = `userEntry ${id}`;
    entry.dataset.sessionIndex = userId;

    const toolEntry = document.createElement('a');
    toolEntry.className = `listTool ${id}`;
    const icon = this.icons[userData.tool] || this.icons.brush;
    toolEntry.appendChild(icon.cloneNode(true));

    const colorEntry = document.createElement('a');
    colorEntry.className = `listColor ${id}`;
    colorEntry.style.backgroundColor = `rgba(${userData.color.join(',')})`;

    const userEntry = document.createElement('span');
    userEntry.className = `listUser ${id}`;
    userEntry.textContent = userData.username || userId;

    if (userData.role === 2) {
      userEntry.classList.add('admin');
    } else if (userData.role === 1) {
      userEntry.classList.add('mod');
    }

    const activeEntry = document.createElement('span');
    activeEntry.className = `listActive ${id}`;

    const syncBtn = document.createElement('a');
    syncBtn.className = `listSync ${id}`;
    syncBtn.title = 'Request canvas sync from this user';
    syncBtn.innerHTML = '&#8635;';
    syncBtn.style.cursor = 'pointer';
    syncBtn.style.opacity = '0.6';
    syncBtn.onclick = () => {
      if (window.app && window.app.syncClient) {
        window.app.syncClient.requestSync(userId);
      }
    };

    entry.appendChild(toolEntry);
    entry.appendChild(colorEntry);
    entry.appendChild(userEntry);
    entry.appendChild(activeEntry);
    entry.appendChild(syncBtn);

    this.elements.userList.appendChild(entry);
  }

  /**
   * Update remote cursor position.
   * @param {string} userId - User's session ID
   * @param {number} x - Target X
   * @param {number} y - Target Y
   * @param {number} size - Current tool size
   */
  updateRemoteCursor(userId, x, y, size) {
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);

    if (cursor) {
      cursor.style.left = `${x - 100}px`;
      cursor.style.top = `${y - 100}px`;
    }
    if (circle) {
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
    }
    if (square) {
      square.setAttribute('x', x - size);
      square.setAttribute('y', y - size);
    }
    if (crosshair) {
      crosshair.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  /**
   * Update remote cursor tool display based on tool type.
   * @param {string} userId - User's session ID
   * @param {string} tool - Current tool name
   */
  updateRemoteToolDisplay(userId, tool) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);
    const text = document.querySelector(`.text.${id}`);

    if (!circle || !square || !crosshair || !text) return;

    circle.style.display = 'none';
    square.style.display = 'none';
    crosshair.style.display = 'none';
    text.style.display = 'none';

    switch (tool) {
      case 'select':
        crosshair.style.display = 'block';
        break;
      case 'brush':
      case 'flowPen':
      case 'ink':
      case 'line':
      case 'rectangle':
      case 'circle':
      case 'erase':
      case 'circleBlur':
      case 'circleBlurHard':
        circle.style.display = 'block';
        break;
      case 'text':
        text.style.display = 'block';
        break;
      case 'blur':
      case 'imageBrush':
        square.style.display = 'block';
        break;
    }
  }

  /**
   * Update remote user's tool size.
   * @param {string} userId - User's session ID
   * @param {number} size - Current tool size
   */
  updateRemoteSize(userId, size) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const text = document.querySelector(`.text.${id}`);

    if (circle) circle.setAttribute('r', size);
    if (square) {
      square.setAttribute('width', size * 2);
      square.setAttribute('height', size * 2);
    }
    if (text) text.style.fontSize = `${size + 5}px`;
  }

  /**
   * Update remote user's color.
   * @param {string} userId - User's session ID
   * @param {Array} color - [r, g, b, a] color array
   */
  updateRemoteColor(userId, color) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const text = document.querySelector(`.text.${id}`);
    const colorEntry = document.querySelector(`.listColor.${id}`);

    if (circle) circle.setAttribute('stroke', `rgba(${color.join(',')})`);
    if (text) {
      const [r, g, b, a] = color;
      text.style.color = `rgba(${r}, ${g}, ${b}, ${a * a})`;
    }
    if (colorEntry) colorEntry.style.backgroundColor = `rgba(${color.join(',')})`;
  }

  /**
   * Update remote user's name display.
   * @param {string} userId - User's session ID
   * @param {string} name - New username
   */
  updateRemoteName(userId, name) {
    const id = `u${userId}`;
    const nameEl = document.querySelector(`.name.${id}`);
    const userEl = document.querySelector(`.listUser.${id}`);

    if (nameEl) nameEl.textContent = name;
    if (userEl) userEl.textContent = name;
  }

  /**
   * Update remote user's text input (for text tool).
   * @param {string} userId - User's session ID
   * @param {string} textContent - New text content
   */
  updateRemoteText(userId, textContent) {
    const cursorElements = this.cursors.get(userId);
    if (cursorElements && cursorElements.textInput) {
      cursorElements.textInput.textContent = textContent;
    }
  }

  /**
   * Set remote user's AFK state visualization.
   * @param {string} userId - User's session ID
   * @param {boolean} afk - Whether the user is AFK
   */
  setRemoteUserAfk(userId, afk) {
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const userEntry = document.querySelector(`.userEntry.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);

    const opacity = afk ? '0.5' : '1';
    if (cursor) cursor.style.opacity = opacity;
    if (circle) circle.style.opacity = opacity;
    if (square) square.style.opacity = opacity;
    if (crosshair) crosshair.style.opacity = opacity;
    if (userEntry) userEntry.style.opacity = opacity;
  }

  /**
   * Remove all UI elements for a remote user.
   * @param {string} userId - User's session ID
   */
  removeRemoteUser(userId) {
    const id = `u${userId}`;
    document.querySelector(`.cursor.${id}`)?.remove();
    document.querySelector(`.circle.${id}`)?.remove();
    document.querySelector(`.square.${id}`)?.remove();
    document.querySelector(`.crosshair.${id}`)?.remove();
    document.querySelector(`.userEntry.${id}`)?.remove();
    document.querySelector(`.userBoard.${id}`)?.remove();
    this.cursors.delete(userId);
  }

  /**
   * Get remote user's canvas board elements.
   * @param {string} userId - User's session ID
   * @returns {Object|null} - Board and context or null
   */
  getRemoteUserBoard(userId) {
    const id = `u${userId}`;
    const board = document.querySelector(`.userBoard.${id}`);
    if (!board) return null;
    return {
      board,
      context: board.getContext('2d')
    };
  }

  /**
   * Hide remote user's cursor elements.
   * @param {string} userId - User's session ID
   */
  hideRemoteCursor(userId) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;

    cursorElements.cursor.style.display = 'none';
    cursorElements.circle.style.display = 'none';
    cursorElements.square.style.display = 'none';
    cursorElements.crosshair.style.display = 'none';
    cursorElements.text.style.display = 'none';
  }

  /**
   * Show remote user's cursor elements.
   * @param {string} userId - User's session ID
   */
  showRemoteCursor(userId) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;

    cursorElements.cursor.style.display = 'block';
  }

  /**
   * Update tool icon in user list for a remote user.
   * @param {string} userId - User's session ID
   * @param {string} tool - Tool name
   */
  updateRemoteToolIcon(userId, tool) {
    const id = `u${userId}`;
    const toolEntry = document.querySelector(`.listTool.${id}`);
    if (toolEntry) {
      toolEntry.innerHTML = '';
      const icon = this.icons[tool] || this.icons.brush;
      toolEntry.appendChild(icon.cloneNode(true));
    }
  }
}
