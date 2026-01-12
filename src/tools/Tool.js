/**
 * Tool - Base class for drawing tools
 */

export class Tool {
  name = '';
  state = null;
  canvas = null;
  drawing = null;
  ws = null;

  /**
   * Create a Tool
   * @param {string} name - Tool name
   * @param {StateManager} stateManager - State manager
   * @param {CanvasManager} canvasManager - Canvas manager
   * @param {DrawingEngine} drawingEngine - Drawing engine
   * @param {WebSocketClient} wsClient - WebSocket client
   */
  constructor(name, stateManager, canvasManager, drawingEngine, wsClient) {
    this.name = name;
    this.state = stateManager;
    this.canvas = canvasManager;
    this.drawing = drawingEngine;
    this.ws = wsClient;
  }

  /**
   * Get the local user state
   * @returns {Object} Local user state
   */
  get localUser() {
    return this.state.get('localUser');
  }

  /**
   * Check if mirror mode is enabled
   * @returns {boolean}
   */
  get mirror() {
    return this.state.get('mirror');
  }

  /**
   * Called when pointer is pressed
   * @param {PointerEvent} e - Pointer event
   */
  onPointerDown(e) {}

  /**
   * Called when pointer moves
   * @param {PointerEvent} e - Pointer event
   */
  onPointerMove(e) {}

  /**
   * Called when pointer is released
   * @param {PointerEvent} e - Pointer event
   */
  onPointerUp(e) {}

  /**
   * Called when pointer leaves canvas
   * @param {PointerEvent} e - Pointer event
   */
  onPointerOut(e) {}

  /**
   * Called on key press
   * @param {KeyboardEvent} e - Keyboard event
   */
  onKeyDown(e) {}

  /**
   * Called on key release
   * @param {KeyboardEvent} e - Keyboard event
   */
  onKeyUp(e) {}

  /**
   * Called when wheel scrolls (for size adjustment)
   * @param {WheelEvent} e - Wheel event
   * @param {number} sizeDelta - Size change amount
   */
  onSizeChange(sizeDelta) {}

  /**
   * Called when tool is activated
   */
  activate() {}

  /**
   * Called when tool is deactivated
   */
  deactivate() {}

  /**
   * Handle remote user's pointer down
   * @param {Object} data - Message data
   * @param {Object} user - Remote user state
   */
  handleRemotePointerDown(data, user) {}

  /**
   * Handle remote user's pointer move
   * @param {Object} data - Message data
   * @param {Object} user - Remote user state
   */
  handleRemotePointerMove(data, user) {}

  /**
   * Handle remote user's pointer up
   * @param {Object} data - Message data
   * @param {Object} user - Remote user state
   */
  handleRemotePointerUp(data, user) {}

  /**
   * Get cursor element class for this tool
   * @returns {string} CSS class name
   */
  getCursorClass() {
    return 'circle';
  }

  /**
   * Update local user state
   * @param {Object} updates - Properties to update
   */
  updateLocalUser(updates) {
    const localUser = this.state.get('localUser');
    Object.assign(localUser, updates);
    this.state.set('localUser', localUser);
  }
}
