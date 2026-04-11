/**
 * @fileoverview Lazy-loads SelectTool and its dependencies only when first activated.
 * This keeps the initial bundle size smaller.
 */

/**
 * Base tool class.
 */
class Tool {
  /**
   * @param {string} name - The name of the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  /**
   * Called when the tool is activated.
   */
  activate() {}

  /**
   * Called when the tool is deactivated.
   */
  deactivate() {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}

/**
 * Stub that lazy-loads real SelectTool on first use.
 */
export class SelectToolLoader extends Tool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    super('select', board);
    this.realTool = null;
    this.loadingPromise = null;
    this._patternMode = false; // Store pattern mode even before real tool loads
  }

  /**
   * Gets the pattern mode.
   * @returns {boolean}
   */
  get patternMode() {
    return this.realTool ? this.realTool.patternMode : this._patternMode;
  }

  /**
   * Sets the pattern mode.
   * @param {boolean} value
   */
  set patternMode(value) {
    this._patternMode = value;
    if (this.realTool) {
      this.realTool.patternMode = value;
    }
  }

  /**
   * Loads the real SelectTool module.
   * @returns {Promise<Object>} - The real tool instance.
   */
  async loadRealTool() {
    if (this.realTool) {
      return this.realTool;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = import('./SelectTool.js')
      .then(module => {
        this.realTool = new module.SelectTool(this.board);
        // Transfer stored pattern mode to real tool
        if (this._patternMode !== undefined) {
          this.realTool.patternMode = this._patternMode;
        }
        this.loadingPromise = null;
        return this.realTool;
      })
      .catch(error => {
        this.loadingPromise = null;
        console.error('Failed to load SelectTool:', error);
        throw error;
      });

    return this.loadingPromise;
  }

  /**
   * Activates the tool and loads the real tool if necessary.
   */
  async activate() {
    if (!this.realTool) {
      await this.loadRealTool();
    }

    if (this.realTool) {
      this.realTool.activate();
    }
  }

  /**
   * Deactivates the tool.
   */
  deactivate() {
    if (this.realTool) {
      this.realTool.deactivate();
    }
  }

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  async onPointerDown(user, pos, e) {
    if (!this.realTool) {
      await this.loadRealTool();
    }

    if (this.realTool) {
      this.realTool.onPointerDown(user, pos, e);
    }
  }

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {
    if (this.realTool) {
      this.realTool.onPointerMove(user, pos, lastPos, e);
    }
  }

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {
    if (this.realTool) {
      this.realTool.onPointerUp(user, pos, e);
    }
  }

  /**
   * Sets the selection mode.
   * @param {string} mode - The selection mode.
   */
  setMode(mode) {
    if (this.realTool) {
      this.realTool.setMode(mode);
    }
  }

  /**
   * Clears the current selection.
   */
  clearSelection() {
    if (this.realTool) {
      this.realTool.clearSelection();
    }
  }

  /**
   * Commits the current selection.
   */
  commitSelection() {
    if (this.realTool) {
      this.realTool.commitSelection();
    }
  }

  /**
   * Handles the copy action.
   * @returns {boolean} - Success or failure.
   */
  handleCopy() {
    if (this.realTool) {
      return this.realTool.handleCopy();
    }
    return false;
  }

  /**
   * Handles the cut action.
   * @returns {boolean} - Success or failure.
   */
  handleCut() {
    if (this.realTool) {
      return this.realTool.handleCut();
    }
    return false;
  }

  /**
   * Handles the paste action.
   * @returns {boolean} - Success or failure.
   */
  handlePaste() {
    if (this.realTool) {
      return this.realTool.handlePaste();
    }
    return false;
  }

  /**
   * Handles the select all action.
   */
  handleSelectAll() {
    if (this.realTool) {
      this.realTool.handleSelectAll();
    }
  }

  /**
   * Handles the deselect action.
   */
  handleDeselect() {
    if (this.realTool) {
      this.realTool.handleDeselect();
    }
  }

  /**
   * Handles the delete action.
   */
  handleDelete() {
    if (this.realTool) {
      this.realTool.handleDelete();
    }
  }

  /**
   * Copy the current selection.
   * @returns {Promise}
   */
  async copy() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.copy();
  }

  /**
   * Cut the current selection.
   * @returns {Promise}
   */
  async cut() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.cut();
  }

  /**
   * Paste from clipboard.
   * @returns {Promise}
   */
  async paste() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.paste();
  }

  /**
   * Clone the current selection in place as a floating duplicate.
   * @returns {Promise}
   */
  async clone() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.clone();
  }

  /**
   * Checks if there is an active selection.
   * @returns {boolean}
   */
  hasSelection() {
    return this.realTool ? this.realTool.hasSelection() : false;
  }

  /**
   * Checks if there is content in the clipboard.
   * @returns {boolean}
   */
  hasClipboard() {
    return this.realTool ? this.realTool.hasClipboard() : false;
  }

  /**
   * Pastes an image from a source.
   * @param {string} imageSource - The image source URL.
   * @returns {Promise<boolean>}
   */
  async pasteImage(imageSource) {
    if (!this.realTool) {
      await this.loadRealTool();
    }
    if (this.realTool) {
      return this.realTool.pasteImage(imageSource);
    }
    return false;
  }

  /**
   * Toggles all-layers copy/cut mode.
   * @param {boolean} [value]
   */
  toggleCopyAllLayers(value) {
    if (this.realTool) {
      this.realTool.toggleCopyAllLayers(value);
    }
  }

  /**
   * Gets the current selection mode.
   * @returns {string}
   */
  getMode() {
    return this.realTool ? this.realTool.mode : 'lasso';
  }

  /**
   * Deselects the current selection.
   */
  deselect() {
    if (this.realTool) {
      this.realTool.deselect?.();
    }
  }

  /**
   * Proxy for drawing the selection box.
   * @param {CanvasRenderingContext2D} ctx 
   * @param {Object} startPos 
   * @param {Object} endPos 
   */
  drawSelectionBox(ctx, startPos, endPos) {
    if (this.realTool) {
      this.realTool.drawSelectionBox(ctx, startPos, endPos);
    }
  }

  /**
   * Proxy for drawing the lasso preview.
   * @param {CanvasRenderingContext2D} ctx 
   * @param {Array} points 
   */
  drawLassoPreview(ctx, points) {
    if (this.realTool) {
      this.realTool.drawLassoPreview(ctx, points);
    }
  }
}
