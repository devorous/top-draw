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
    this.userGroups = new Map(); // ipHash -> { element, userIds: Set }
  }

  /**
   * Create all UI elements for a new remote user.
   * @param {string} userId - User's session ID
   * @param {Object} userData - User initial state data
   */
  createRemoteUser(userId, userData) {
    const id = `u${userId}`;
    // ... (keep existing cursor/svg creation)

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
   * Groups users by IP hash only if multiple users share the same IP.
   * @param {string} userId - User's session ID
   * @param {Object} userData - User state data
   */
  createUserListEntry(userId, userData) {
    const ipHash = userData.ipHash || userData.iph;

    // If no IP hash, just add normally to the flat list
    if (!ipHash) {
      this._createSingleUserEntry(userId, userData, this.elements.userList);
      return;
    }

    // Check if there's ALREADY another user with this IP hash
    let existingUsersWithSameIp = [];
    if (window.app && window.app.users) {
      window.app.users.forEach((u, id) => {
        if (id !== userId && u.ipHash === ipHash && u.username) {
          existingUsersWithSameIp.push(id);
        }
      });
    }

    // If no one else has this IP yet, just add as a normal entry
    if (existingUsersWithSameIp.length === 0) {
      this._createSingleUserEntry(userId, userData, this.elements.userList);
      return;
    }

    // Someone else has this IP. We need a group.
    let group = this.userGroups.get(ipHash);
    if (!group) {
      // Create the group container, using the new user as the initial display user
      group = this._createGroupContainer(ipHash, userId, userData);

      // CAPTURE the existing user(s) who were previously flat in the list
      existingUsersWithSameIp.forEach(otherId => {
        const otherEntry = document.querySelector(`.userEntry.u${otherId}`);
        if (otherEntry && otherEntry.parentElement === this.elements.userList) {
          group.usersContainer.appendChild(otherEntry);
          group.userIds.add(otherId);
        }
      });
    }

    // Add the new user to the group
    group.userIds.add(userId);
    this._createSingleUserEntry(userId, userData, group.usersContainer);
    this._updateGroupSummary(ipHash);
  }

  /**
   * Internal helper to create the group UI container.
   * The header looks like a regular user entry, showing the most recently active user.
   * @param {string} ipHash - IP hash key for the group
   * @param {string} displayUserId - User ID to show in the header initially
   * @param {Object} displayUserData - User data for the header display
   */
  _createGroupContainer(ipHash, displayUserId, displayUserData) {
    const groupEl = document.createElement('div');
    groupEl.className = 'userGroup';
    groupEl.dataset.ipHash = ipHash;

    // Header styled like a regular userEntry
    const groupHeader = document.createElement('div');
    groupHeader.className = 'userEntry groupHeader';
    groupHeader.onclick = () => this.toggleGroup(ipHash);
    groupHeader.oncontextmenu = (e) => {
      if (window.app && window.app.moderation) {
        window.app.moderation.showContextMenu(e, null, null, ipHash);
      }
    };

    const toolEl = document.createElement('a');
    toolEl.className = 'listTool groupHeaderTool';
    const icon = this.icons[displayUserData.tool] || this.icons.brush;
    toolEl.appendChild(icon.cloneNode(true));

    const colorEl = document.createElement('a');
    colorEl.className = 'listColor groupHeaderColor';
    const color = Array.isArray(displayUserData.color) ? displayUserData.color : [0, 0, 0, 1];
    colorEl.style.backgroundColor = `rgba(${color.join(',')})`;

    const nameEl = document.createElement('span');
    nameEl.className = 'listUser groupHeaderName';
    nameEl.textContent = displayUserData.name || displayUserData.username || displayUserId;

    const countBadge = document.createElement('span');
    countBadge.className = 'groupCountBadge';
    countBadge.textContent = '+1';

    groupHeader.appendChild(toolEl);
    groupHeader.appendChild(colorEl);
    groupHeader.appendChild(nameEl);
    groupHeader.appendChild(countBadge);

    groupEl.appendChild(groupHeader);

    const groupUsers = document.createElement('div');
    groupUsers.className = 'groupUsers';
    groupEl.appendChild(groupUsers);

    this.elements.userList.appendChild(groupEl);

    const group = {
      element: groupEl,
      usersContainer: groupUsers,
      userIds: new Set(),
      displayUserId,
      headerToolEl: toolEl,
      headerColorEl: colorEl,
      headerNameEl: nameEl,
      headerCountEl: countBadge,
    };
    this.userGroups.set(ipHash, group);
    return group;
  }

  /**
   * Update the group header to reflect the given user's current data.
   * Call this when a user in the group becomes active.
   * @param {string} ipHash - Group IP hash
   * @param {string} userId - User ID to show in header
   */
  _setGroupDisplayUser(ipHash, userId) {
    const group = this.userGroups.get(ipHash);
    if (!group || group.displayUserId === userId) return;

    group.displayUserId = userId;
    const id = `u${userId}`;

    const srcTool = document.querySelector(`.groupUsers .listTool.${id}`);
    if (srcTool) group.headerToolEl.innerHTML = srcTool.innerHTML;

    const srcColor = document.querySelector(`.groupUsers .listColor.${id}`);
    if (srcColor) group.headerColorEl.style.backgroundColor = srcColor.style.backgroundColor;

    const srcName = document.querySelector(`.groupUsers .listUser.${id}`);
    if (srcName) {
      group.headerNameEl.textContent = srcName.textContent;
      group.headerNameEl.className = 'listUser groupHeaderName';
      if (srcName.classList.contains('admin')) group.headerNameEl.classList.add('admin');
      else if (srcName.classList.contains('mod')) group.headerNameEl.classList.add('mod');
    }
  }

  /**
   * Notify that a user was active — updates the group header to show their name.
   * @param {string} userId - User ID
   */
  notifyUserActive(userId) {
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId)) {
        this._setGroupDisplayUser(ipHash, userId);
        break;
      }
    }
  }

  /**
   * Internal helper to create a single user entry.
   */
  _createSingleUserEntry(userId, userData, container) {
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
    const color = Array.isArray(userData.color) ? userData.color : [0,0,0,1];
    colorEntry.style.backgroundColor = `rgba(${color.join(',')})`;

    const userEntry = document.createElement('span');
    userEntry.className = `listUser ${id}`;
    userEntry.textContent = userData.name || userData.username || userId;

    const role = userData.role;
    if (role === 2) {
      userEntry.classList.add('admin');
    } else if (role === 1) {
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
    syncBtn.onclick = (e) => {
      e.stopPropagation();
      if (window.app && window.app.syncClient) {
        window.app.syncClient.requestSync(userId);
      }
    };

    entry.appendChild(toolEntry);
    entry.appendChild(colorEntry);
    entry.appendChild(userEntry);
    entry.appendChild(activeEntry);
    entry.appendChild(syncBtn);

    container.appendChild(entry);
  }

  _updateGroupSummary(ipHash) {
    const group = this.userGroups.get(ipHash);
    if (!group) return;
    const extra = group.userIds.size - 1;
    group.headerCountEl.textContent = `+${extra}`;
  }

  toggleGroup(ipHash) {
    const group = this.userGroups.get(ipHash);
    if (!group) return;
    group.element.classList.toggle('expanded');
  }

  /**
   * Update remote cursor position.
   * @param {string} userId - User's session ID
   * @param {number} x - Target X
   * @param {number} y - Target Y
   * @param {number} size - Current tool size
   */
  updateRemoteCursor(userId, x, y, size) {
    this.notifyUserActive(userId);
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

    // Propagate to group header if this is the display user
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId) && group.displayUserId === userId) {
        group.headerColorEl.style.backgroundColor = `rgba(${color.join(',')})`;
        break;
      }
    }
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

    // Propagate to group header if this is the display user
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId) && group.displayUserId === userId) {
        group.headerNameEl.textContent = name;
        break;
      }
    }
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
   * Show or hide the DOM text element for a remote user.
   * Used to hide it when blend mode requires canvas rendering instead.
   * @param {string} userId - User's session ID
   * @param {boolean} visible - Whether to show the element
   */
  setRemoteTextDomVisible(userId, visible) {
    const cursorElements = this.cursors.get(userId);
    if (cursorElements && cursorElements.text) {
      cursorElements.text.style.visibility = visible ? '' : 'hidden';
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
    this.removeRemoteUserFromGroup(userId);
  }

  removeRemoteUserFromGroup(userId) {
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId)) {
        group.userIds.delete(userId);
        
        // If only 1 user left, dissolve the group
        if (group.userIds.size === 1) {
          const lastUserId = Array.from(group.userIds)[0];
          const lastEntry = group.usersContainer.querySelector(`.userEntry.u${lastUserId}`);
          if (lastEntry) {
            // Move back to main list (before the group element to maintain rough order)
            this.elements.userList.insertBefore(lastEntry, group.element);
          }
          group.element.remove();
          this.userGroups.delete(ipHash);
        } else if (group.userIds.size === 0) {
          group.element.remove();
          this.userGroups.delete(ipHash);
        } else {
          this._updateGroupSummary(ipHash);
          // If the display user left, promote another user
          if (group.displayUserId === userId) {
            const nextId = Array.from(group.userIds)[0];
            group.displayUserId = nextId;
            this._setGroupDisplayUser(ipHash, nextId);
          }
        }
        break;
      }
    }
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

    // Propagate to group header if this is the display user
    for (const [ipHash, group] of this.userGroups.entries()) {
      if (group.userIds.has(userId) && group.displayUserId === userId) {
        group.headerToolEl.innerHTML = '';
        const icon = this.icons[tool] || this.icons.brush;
        group.headerToolEl.appendChild(icon.cloneNode(true));
        break;
      }
    }
  }
}
