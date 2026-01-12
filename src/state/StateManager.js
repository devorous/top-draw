/**
 * StateManager - Central observable state management
 * Uses EventTarget for event-driven updates
 */

export class StateManager extends EventTarget {
  #state = {
    // Connection state
    connected: false,
    userID: null,

    // Users
    users: [],
    localUser: null,

    // Board settings
    mirror: false,
    boardDim: [720, 1280],

    // Viewport
    zoom: 1,
    defaultZoom: 1,
    pan: { x: 0, y: 0 },
    defaultPan: { x: 0, y: 0 }
  };

  /**
   * Get a state value by key
   * @param {string} key - The state key
   * @returns {*} The state value
   */
  get(key) {
    return this.#state[key];
  }

  /**
   * Get entire state (read-only clone)
   * @returns {Object} Cloned state object
   */
  getAll() {
    return { ...this.#state };
  }

  /**
   * Set a state value and emit change event
   * @param {string} key - The state key
   * @param {*} value - The new value
   */
  set(key, value) {
    const old = this.#state[key];
    if (old === value) return;

    this.#state[key] = value;
    this.dispatchEvent(new CustomEvent('change', {
      detail: { key, value, old }
    }));

    // Also emit specific event for this key
    this.dispatchEvent(new CustomEvent(`change:${key}`, {
      detail: { value, old }
    }));
  }

  /**
   * Update multiple state values at once
   * @param {Object} updates - Object with key-value pairs to update
   */
  update(updates) {
    const changes = [];

    for (const [key, value] of Object.entries(updates)) {
      const old = this.#state[key];
      if (old !== value) {
        this.#state[key] = value;
        changes.push({ key, value, old });
      }
    }

    if (changes.length > 0) {
      this.dispatchEvent(new CustomEvent('change:batch', {
        detail: { changes }
      }));

      for (const change of changes) {
        this.dispatchEvent(new CustomEvent(`change:${change.key}`, {
          detail: { value: change.value, old: change.old }
        }));
      }
    }
  }

  /**
   * Subscribe to state changes
   * @param {Function} callback - Called with change event detail
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    const handler = (e) => callback(e.detail);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }

  /**
   * Subscribe to specific key changes
   * @param {string} key - The state key to watch
   * @param {Function} callback - Called with { value, old }
   * @returns {Function} Unsubscribe function
   */
  subscribeKey(key, callback) {
    const handler = (e) => callback(e.detail);
    this.addEventListener(`change:${key}`, handler);
    return () => this.removeEventListener(`change:${key}`, handler);
  }

  /**
   * Get a user by ID
   * @param {number} id - User ID
   * @returns {Object|null} User object or null
   */
  getUser(id) {
    if (id === -1) return 'system';
    return this.#state.users.find(u => u.id === id) || null;
  }

  /**
   * Add a user to the users list
   * @param {Object} user - User object
   */
  addUser(user) {
    const users = [...this.#state.users, user];
    this.set('users', users);
  }

  /**
   * Remove a user by ID
   * @param {number} id - User ID to remove
   */
  removeUser(id) {
    const users = this.#state.users.filter(u => u.id !== id);
    this.set('users', users);
  }

  /**
   * Update a specific user's data
   * @param {number} id - User ID
   * @param {Object} updates - Properties to update
   */
  updateUser(id, updates) {
    const users = this.#state.users.map(u => {
      if (u.id === id) {
        return { ...u, ...updates };
      }
      return u;
    });
    this.set('users', users);
  }
}

// Singleton instance
export const stateManager = new StateManager();
