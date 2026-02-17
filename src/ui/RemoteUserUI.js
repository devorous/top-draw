/**
 * RemoteUserUI
 *
 * Manages UI elements for remote users:
 * - Remote cursors (circle, square, crosshair, text)
 * - Remote user boards (per-user canvas layers)
 * - User list entries with tool, color, name, role badge
 * - AFK state visualization
 *
 * Responsibilities:
 * - Create/remove remote user UI elements
 * - Update cursor positions, tool displays, colors, names
 * - Track remote user state in cursors Map
 */
export class RemoteUserUI {
  constructor(elements, icons) {
    this.elements = elements;
    this.icons = icons;
    this.cursors = new Map(); // userId -> { cursor, circle, square, crosshair, text, textInput, name }
  }

  /**
   * Create all UI elements for a new remote user
   * - Cursor elements (div + SVG shapes)
   * - User board canvas
   * - User list entry
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

    // Crosshair cursor for select tool
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
    text.style.color = `rgba(${userData.color.join(',')})`;
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
   * Create a dedicated canvas layer for a remote user
   * Each user gets their own board to avoid expensive compositing
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
   * Create user list entry showing tool icon, color, name, and role badge
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

    // Role badge (hidden by default, shown when role > 0)
    const roleBadge = document.createElement('span');
    roleBadge.className = `roleBadge ${id}`;
    roleBadge.style.display = 'none';
    if (userData.role === 2) {
      roleBadge.textContent = 'admin';
      roleBadge.classList.add('admin');
      roleBadge.style.display = '';
    } else if (userData.role === 1) {
      roleBadge.textContent = 'mod';
      roleBadge.classList.add('mod');
      roleBadge.style.display = '';
    }

    const activeEntry = document.createElement('span');
    activeEntry.className = `listActive ${id}`;

    entry.appendChild(toolEntry);
    entry.appendChild(colorEntry);
    entry.appendChild(userEntry);
    entry.appendChild(roleBadge);
    entry.appendChild(activeEntry);

    this.elements.userList.appendChild(entry);
  }

  /**
   * Update remote cursor position
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
   * Update remote cursor tool display
   * Shows/hides circle, square, crosshair, text based on tool
   */
  updateRemoteToolDisplay(userId, tool) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);
    const text = document.querySelector(`.text.${id}`);

    if (!circle || !square || !crosshair || !text) return;

    // Hide all by default
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
   * Update remote user's brush/tool size
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
   * Update remote user's color (stroke for cursor, background for list entry)
   */
  updateRemoteColor(userId, color) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const text = document.querySelector(`.text.${id}`);
    const colorEntry = document.querySelector(`.listColor.${id}`);

    if (circle) circle.setAttribute('stroke', `rgba(${color.join(',')})`);
    if (text) text.style.color = `rgba(${color.join(',')})`;
    if (colorEntry) colorEntry.style.backgroundColor = `rgba(${color.join(',')})`;
  }

  /**
   * Update remote user's name
   */
  updateRemoteName(userId, name) {
    const id = `u${userId}`;
    const nameEl = document.querySelector(`.name.${id}`);
    const userEl = document.querySelector(`.listUser.${id}`);

    if (nameEl) nameEl.textContent = name;
    if (userEl) userEl.textContent = name;
  }

  /**
   * Update remote user's text input (for text tool)
   */
  updateRemoteText(userId, textContent) {
    const cursorElements = this.cursors.get(userId);
    if (cursorElements && cursorElements.textInput) {
      cursorElements.textInput.textContent = textContent;
    }
  }

  /**
   * Set remote user's AFK state (gray out when AFK)
   */
  setRemoteUserAfk(userId, afk) {
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const userEntry = document.querySelector(`.userEntry.${id}`);
    const activeEntry = document.querySelector(`.listActive.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);

    if (afk) {
      // Gray out cursor elements
      if (cursor) cursor.style.opacity = '0.5';
      if (circle) circle.style.opacity = '0.5';
      if (square) square.style.opacity = '0.5';
      if (crosshair) crosshair.style.opacity = '0.5';

      // Gray out list entry
      if (userEntry) userEntry.style.opacity = '0.5';
      if (activeEntry) activeEntry.textContent = '(AFK)';
    } else {
      // Restore opacity
      if (cursor) cursor.style.opacity = '1';
      if (circle) circle.style.opacity = '1';
      if (square) square.style.opacity = '1';
      if (crosshair) crosshair.style.opacity = '1';

      // Restore list entry
      if (userEntry) userEntry.style.opacity = '1';
      if (activeEntry) activeEntry.textContent = '';
    }
  }

  /**
   * Remove all UI elements for a remote user
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
   * Get remote user's canvas board
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
   * Hide remote user's cursor
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
   * Show remote user's cursor
   */
  showRemoteCursor(userId) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;

    cursorElements.cursor.style.display = 'block';
    // Note: circle, square, crosshair, text visibility is managed by updateRemoteToolDisplay()
    // This will be called after showing to restore the correct cursor shape
  }

  /**
   * Update tool icon in user list
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
