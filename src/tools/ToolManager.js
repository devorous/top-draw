/**
 * ToolManager - Manages tool switching and delegation
 */

import { BrushTool } from './BrushTool.js';
import { TextTool } from './TextTool.js';
import { EraseTool } from './EraseTool.js';
import { GimpBrushTool } from './GimpBrushTool.js';
import { MessageType } from '../network/Protocol.js';

export class ToolManager {
  #tools = new Map();
  #currentTool = null;
  #stateManager = null;
  #wsClient = null;

  /**
   * Create a ToolManager
   * @param {StateManager} stateManager - State manager
   * @param {CanvasManager} canvasManager - Canvas manager
   * @param {DrawingEngine} drawingEngine - Drawing engine
   * @param {WebSocketClient} wsClient - WebSocket client
   */
  constructor(stateManager, canvasManager, drawingEngine, wsClient) {
    this.#stateManager = stateManager;
    this.#wsClient = wsClient;

    // Create tools
    this.#tools.set('brush', new BrushTool(stateManager, canvasManager, drawingEngine, wsClient));
    this.#tools.set('text', new TextTool(stateManager, canvasManager, drawingEngine, wsClient));
    this.#tools.set('erase', new EraseTool(stateManager, canvasManager, drawingEngine, wsClient));
    this.#tools.set('gimp', new GimpBrushTool(stateManager, canvasManager, drawingEngine, wsClient));

    // Default to brush
    this.#currentTool = this.#tools.get('brush');
  }

  /**
   * Get a tool by name
   * @param {string} name - Tool name
   * @returns {Tool|null}
   */
  getTool(name) {
    return this.#tools.get(name) || null;
  }

  /**
   * Get current active tool
   * @returns {Tool}
   */
  get currentTool() {
    return this.#currentTool;
  }

  /**
   * Get current tool name
   * @returns {string}
   */
  get currentToolName() {
    return this.#currentTool ? this.#currentTool.name : null;
  }

  /**
   * Switch to a different tool
   * @param {string} name - Tool name to switch to
   */
  switchTool(name) {
    const newTool = this.#tools.get(name);
    if (!newTool) {
      console.warn(`Unknown tool: ${name}`);
      return;
    }

    if (this.#currentTool === newTool) {
      return;
    }

    // Deactivate current tool
    if (this.#currentTool) {
      this.#currentTool.deactivate();
    }

    // Update local user state
    const localUser = this.#stateManager.get('localUser');
    if (localUser) {
      localUser.tool = name;
    }

    // Activate new tool
    this.#currentTool = newTool;
    this.#currentTool.activate();

    // Broadcast tool change
    this.#wsClient.broadcast(MessageType.USER_TOOL, { tool: name });

    // Update UI
    this.#updateToolUI(name);
  }

  #updateToolUI(name) {
    // Update button selection
    const selectedBtn = document.querySelector('.btn.selected');
    if (selectedBtn) {
      selectedBtn.classList.remove('selected');
    }

    const newBtn = document.getElementById(`${name}Btn`);
    if (newBtn) {
      newBtn.classList.add('selected');
    }

    // Update user list icon
    const userEntry = document.querySelector('.userEntry.self');
    if (userEntry) {
      const listTool = userEntry.querySelector('.listTool');
      if (listTool && listTool.children[0]) {
        listTool.children[0].remove();
      }
      const icon = this.#getToolIcon(name);
      if (icon && listTool) {
        listTool.appendChild(icon.cloneNode(true));
      }
    }
  }

  #getToolIcon(name) {
    const icons = {
      brush: document.querySelector('#brushBtn img'),
      text: document.querySelector('#textBtn img'),
      erase: document.querySelector('#eraseBtn img'),
      gimp: document.querySelector('#gimpBtn img')
    };
    return icons[name] || null;
  }

  /**
   * Handle pointer down event
   * @param {PointerEvent} e - Pointer event
   */
  handlePointerDown(e) {
    if (this.#currentTool) {
      this.#currentTool.onPointerDown(e);
    }
  }

  /**
   * Handle pointer move event
   * @param {PointerEvent} e - Pointer event
   */
  handlePointerMove(e) {
    if (this.#currentTool) {
      this.#currentTool.onPointerMove(e);
    }
  }

  /**
   * Handle pointer up event
   * @param {PointerEvent} e - Pointer event
   */
  handlePointerUp(e) {
    if (this.#currentTool) {
      this.#currentTool.onPointerUp(e);
    }
  }

  /**
   * Handle pointer out event
   * @param {PointerEvent} e - Pointer event
   */
  handlePointerOut(e) {
    if (this.#currentTool) {
      this.#currentTool.onPointerOut(e);
    }
  }

  /**
   * Handle key down event
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeyDown(e) {
    if (this.#currentTool) {
      this.#currentTool.onKeyDown(e);
    }
  }

  /**
   * Handle key up event
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeyUp(e) {
    if (this.#currentTool) {
      this.#currentTool.onKeyUp(e);
    }
  }

  /**
   * Handle size change (from wheel)
   * @param {number} sizeDelta - Size change amount
   */
  handleSizeChange(sizeDelta) {
    if (this.#currentTool) {
      this.#currentTool.onSizeChange(sizeDelta);
    }
  }

  /**
   * Handle remote pointer down
   * @param {Object} data - Message data
   * @param {Object} user - Remote user
   */
  handleRemotePointerDown(data, user) {
    const tool = this.#tools.get(user.tool);
    if (tool) {
      tool.handleRemotePointerDown(data, user);
    }
  }

  /**
   * Handle remote pointer move
   * @param {Object} data - Message data
   * @param {Object} user - Remote user
   */
  handleRemotePointerMove(data, user) {
    const tool = this.#tools.get(user.tool);
    if (tool) {
      tool.handleRemotePointerMove(data, user);
    }
  }

  /**
   * Handle remote pointer up
   * @param {Object} data - Message data
   * @param {Object} user - Remote user
   */
  handleRemotePointerUp(data, user) {
    const tool = this.#tools.get(user.tool);
    if (tool) {
      tool.handleRemotePointerUp(data, user);
    }
  }

  /**
   * Handle remote tool change
   * @param {Object} data - Message data with tool property
   * @param {Object} user - Remote user
   */
  handleToolChange(data, user) {
    user.tool = data.tool;

    // Update user's cursor display
    const userCircle = document.querySelector(`.circle.${user.id}`);
    const userSquare = document.querySelector(`.square.${user.id}`);
    const userText = document.querySelector(`.${user.id} .text`);

    if (userCircle) userCircle.style.display = 'none';
    if (userSquare) userSquare.style.display = 'none';
    if (userText) userText.style.display = 'none';

    const tool = this.#tools.get(data.tool);
    if (tool) {
      const cursorClass = tool.getCursorClass();
      if (cursorClass === 'circle' && userCircle) {
        userCircle.style.display = 'block';
      } else if (cursorClass === 'square' && userSquare) {
        userSquare.style.display = 'block';
      } else if (cursorClass === 'text' && userText) {
        userText.style.display = 'block';
      }
    }

    // Update user list icon
    const listTool = document.querySelector(`.${user.id} .listTool`);
    if (listTool) {
      if (listTool.children[0]) {
        listTool.children[0].remove();
      }
      const icon = this.#getToolIcon(data.tool);
      if (icon) {
        listTool.appendChild(icon.cloneNode(true));
      }
    }
  }
}
