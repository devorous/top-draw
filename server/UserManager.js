/**
 * UserManager - Manages connected users
 */

const { MessageType } = require('./Protocol');

class UserManager {
  #users = [];

  /**
   * Get all users
   * @returns {Array} Array of user objects
   */
  getAllUsers() {
    return [...this.#users];
  }

  /**
   * Get a user by ID
   * @param {number} id - User ID
   * @returns {Object|null} User object or null
   */
  getUser(id) {
    return this.#users.find(u => u.id === id) || null;
  }

  /**
   * Add a new user
   * @param {Object} userData - User data from connect message
   * @returns {Object} The added user
   */
  addUser(userData) {
    const user = {
      id: userData.id,
      userdata: userData.userdata
    };
    this.#users.push(user);
    return user;
  }

  /**
   * Remove a user by ID
   * @param {number} id - User ID
   * @returns {Object|null} Removed user or null
   */
  removeUser(id) {
    const index = this.#users.findIndex(u => u.id === id);
    if (index !== -1) {
      const [removed] = this.#users.splice(index, 1);
      return removed;
    }
    return null;
  }

  /**
   * Update a user's data based on message type
   * @param {Object} data - Message data
   */
  updateUser(data) {
    const user = this.getUser(data.id);
    if (!user || !user.userdata) return;

    const userdata = user.userdata;

    switch (data.type) {
      case MessageType.CURSOR_MOVE:
        userdata.x = data.x;
        userdata.y = data.y;
        userdata.lastx = data.lastx;
        userdata.lasty = data.lasty;
        break;

      case MessageType.POINTER_DOWN:
        userdata.mousedown = true;
        break;

      case MessageType.POINTER_UP:
        userdata.mousedown = false;
        if (userdata.tool === 'text') {
          userdata.text = '';
        }
        break;

      case MessageType.USER_SIZE:
        userdata.size = data.size;
        break;

      case MessageType.USER_NAME:
        userdata.username = data.name;
        break;

      case MessageType.USER_TOOL:
        userdata.tool = data.tool;
        userdata.text = '';
        break;

      case MessageType.USER_COLOR:
        userdata.color = data.color;
        break;

      case MessageType.USER_PRESSURE:
        userdata.pressure = data.pressure;
        break;

      case MessageType.USER_SPACING:
        userdata.spacing = data.spacing;
        break;

      case MessageType.USER_PANNING:
        userdata.panning = data.value;
        break;

      case MessageType.TEXT_INPUT:
        const key = data.key;
        if (key.length === 1) {
          userdata.text = (userdata.text || '') + key;
        }
        switch (key) {
          case 'Enter':
            userdata.text = '';
            break;
          case 'Backspace':
            if (userdata.text) {
              userdata.text = userdata.text.slice(0, -1);
            }
            break;
        }
        break;
    }
  }

  /**
   * Get count of connected users
   * @returns {number} User count
   */
  get count() {
    return this.#users.length;
  }

  /**
   * Check if any users are connected
   * @returns {boolean}
   */
  get hasUsers() {
    return this.#users.length > 0;
  }
}

module.exports = { UserManager };
