/**
 * UserState - Factory for creating user state objects
 */

/**
 * Create a new user state object with defaults
 * @param {number} id - User ID
 * @param {Object} overrides - Optional property overrides
 * @returns {Object} User state object
 */
export function createUserState(id, overrides = {}) {
  return {
    id,
    x: 0,
    y: 0,
    lastx: null,
    lasty: null,
    size: 10,
    pressure: 1,
    prevpressure: 1,
    spacing: 0,
    smoothing: 3,
    spaceIndex: 0,
    color: '#000',
    tool: 'brush',
    text: '',
    mousedown: false,
    panning: false,
    username: '',
    gBrush: null,
    blendMode: 'source-over',
    currentLine: [],
    lineLength: 0,
    context: null,
    board: null,
    ...overrides
  };
}

/**
 * Create a local user state (self) with additional properties
 * @param {number} id - User ID
 * @param {CanvasRenderingContext2D} context - Canvas context
 * @param {HTMLCanvasElement} board - Canvas element
 * @returns {Object} Local user state object
 */
export function createLocalUserState(id, context, board) {
  return createUserState(id, {
    context,
    board
  });
}

/**
 * Clone a user state object
 * @param {Object} user - User state to clone
 * @returns {Object} Cloned user state
 */
export function cloneUserState(user) {
  return {
    ...user,
    currentLine: [...user.currentLine]
  };
}
