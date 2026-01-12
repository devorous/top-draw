/**
 * UserListManager - Manages the user list panel
 */

export class UserListManager {
  #stateManager = null;
  #userList = null;

  // Tool icons cache
  #icons = {
    brush: null,
    text: null,
    erase: null,
    gimp: null
  };

  /**
   * Create a UserListManager
   * @param {StateManager} stateManager - State manager
   */
  constructor(stateManager) {
    this.#stateManager = stateManager;
  }

  /**
   * Initialize user list elements
   */
  init() {
    this.#userList = document.getElementById('userList');

    // Cache tool icons
    this.#icons.brush = document.querySelector('#brushBtn img');
    this.#icons.text = document.querySelector('#textBtn img');
    this.#icons.erase = document.querySelector('#eraseBtn img');
    this.#icons.gimp = document.querySelector('#gimpBtn img');

    // Initialize self entry
    const selfEntry = document.querySelector('.userEntry.self');
    if (selfEntry) {
      const listTool = selfEntry.querySelector('.listTool');
      if (listTool && this.#icons.brush) {
        listTool.appendChild(this.#icons.brush.cloneNode(true));
      }
    }
  }

  /**
   * Update local user's name display
   * @param {string} username - New username
   */
  updateLocalName(username) {
    const boardName = document.querySelector('.name.self');
    const listName = document.querySelector('.listUser.self');

    if (boardName) boardName.textContent = username;
    if (listName) listName.textContent = username;
  }

  /**
   * Update local user's color display
   * @param {Array|string} color - New color
   */
  updateLocalColor(color) {
    const listColor = document.querySelector('.userEntry.self .listColor');
    if (listColor) {
      listColor.style.backgroundColor = this.#formatColor(color);
    }
  }

  /**
   * Update local user's tool display
   * @param {string} tool - Tool name
   */
  updateLocalTool(tool) {
    const selfEntry = document.querySelector('.userEntry.self');
    if (!selfEntry) return;

    const listTool = selfEntry.querySelector('.listTool');
    if (listTool) {
      // Remove current icon
      if (listTool.children[0]) {
        listTool.children[0].remove();
      }

      // Add new icon
      const icon = this.#icons[tool];
      if (icon) {
        listTool.appendChild(icon.cloneNode(true));
      }
    }
  }

  /**
   * Add a user to the user list
   * @param {Object} user - User data
   */
  addUser(user) {
    if (!this.#userList) return;

    const entry = document.createElement('div');
    entry.className = `userEntry ${user.id}`;

    // Tool icon
    const listTool = document.createElement('a');
    listTool.className = `listTool ${user.id}`;
    const toolIcon = this.#icons[user.tool] || this.#icons.brush;
    if (toolIcon) {
      listTool.appendChild(toolIcon.cloneNode(true));
    }

    // Color indicator
    const listColor = document.createElement('a');
    listColor.className = `listColor ${user.id}`;
    listColor.style.backgroundColor = this.#formatColor(user.color);

    // Username
    const listUser = document.createElement('text');
    listUser.className = `listUser ${user.id}`;
    listUser.textContent = user.username || user.id.toString();

    // Active indicator
    const listActive = document.createElement('a');
    listActive.className = `listActive ${user.id}`;

    entry.appendChild(listTool);
    entry.appendChild(listColor);
    entry.appendChild(listUser);
    entry.appendChild(listActive);

    this.#userList.appendChild(entry);
  }

  /**
   * Remove a user from the user list
   * @param {number} userId - User ID
   */
  removeUser(userId) {
    const entry = document.querySelector(`.userEntry.${userId}`);
    if (entry) {
      entry.remove();
    }
  }

  /**
   * Update a user's display in the list
   * @param {number} userId - User ID
   * @param {Object} updates - Properties to update
   */
  updateUser(userId, updates) {
    if (updates.username !== undefined) {
      const listUser = document.querySelector(`.listUser.${userId}`);
      if (listUser) {
        listUser.textContent = updates.username;
      }

      // Also update cursor name
      const cursorName = document.querySelector(`.${userId} .name`);
      if (cursorName) {
        cursorName.textContent = updates.username;
      }
    }

    if (updates.color !== undefined) {
      const listColor = document.querySelector(`.${userId} .listColor`);
      if (listColor) {
        listColor.style.backgroundColor = this.#formatColor(updates.color);
      }
    }

    if (updates.tool !== undefined) {
      const listTool = document.querySelector(`.${userId} .listTool`);
      if (listTool) {
        if (listTool.children[0]) {
          listTool.children[0].remove();
        }
        const icon = this.#icons[updates.tool];
        if (icon) {
          listTool.appendChild(icon.cloneNode(true));
        }
      }
    }
  }

  #formatColor(color) {
    if (typeof color === 'string') return color;
    if (Array.isArray(color)) return `rgba(${color.join(',')})`;
    return '#000';
  }
}
