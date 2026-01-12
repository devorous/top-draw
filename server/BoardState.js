/**
 * BoardState - Manages shared board settings
 */

class BoardState {
  #settings = {
    mirror: false
  };

  /**
   * Get all settings
   * @returns {Object} Settings object
   */
  getSettings() {
    return { ...this.#settings };
  }

  /**
   * Get a specific setting
   * @param {string} key - Setting key
   * @returns {*} Setting value
   */
  get(key) {
    return this.#settings[key];
  }

  /**
   * Set a setting value
   * @param {string} key - Setting key
   * @param {*} value - Setting value
   */
  set(key, value) {
    this.#settings[key] = value;
  }

  /**
   * Toggle mirror mode
   * @returns {boolean} New mirror state
   */
  toggleMirror() {
    this.#settings.mirror = !this.#settings.mirror;
    return this.#settings.mirror;
  }

  /**
   * Reset to default settings
   */
  reset() {
    this.#settings = {
      mirror: false
    };
  }
}

module.exports = { BoardState };
