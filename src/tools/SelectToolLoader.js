/**
 * SelectToolLoader
 *
 * Lazy-loads SelectTool and its dependencies (homography.js) only when first activated.
 * This keeps ~150 KB of selection/transform code out of initial bundle.
 */

/**
 * Base tool class (matches Tool interface)
 */
class Tool {
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}
}

/**
 * Stub that lazy-loads real SelectTool on first use
 */
export class SelectToolLoader extends Tool {
  constructor(board) {
    super('select', board);
    this.realTool = null;
    this.loadingPromise = null;
  }

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

  async activate() {
    // Load real tool on first activation
    if (!this.realTool) {
      await this.loadRealTool();
    }

    if (this.realTool) {
      this.realTool.activate();
    }
  }

  deactivate() {
    if (this.realTool) {
      this.realTool.deactivate();
    }
  }

  async onPointerDown(user, pos, e) {
    // Ensure tool is loaded before handling pointer down
    if (!this.realTool) {
      await this.loadRealTool();
    }

    if (this.realTool) {
      this.realTool.onPointerDown(user, pos, e);
    }
  }

  onPointerMove(user, pos, lastPos, e) {
    if (this.realTool) {
      this.realTool.onPointerMove(user, pos, lastPos, e);
    }
  }

  onPointerUp(user, pos, e) {
    if (this.realTool) {
      this.realTool.onPointerUp(user, pos, e);
    }
  }

  // Proxy all other methods that might be called
  setMode(mode) {
    if (this.realTool) {
      this.realTool.setMode(mode);
    }
  }

  clearSelection() {
    if (this.realTool) {
      this.realTool.clearSelection();
    }
  }

  commitSelection() {
    if (this.realTool) {
      this.realTool.commitSelection();
    }
  }

  handleCopy() {
    if (this.realTool) {
      return this.realTool.handleCopy();
    }
    return false;
  }

  handleCut() {
    if (this.realTool) {
      return this.realTool.handleCut();
    }
    return false;
  }

  handlePaste() {
    if (this.realTool) {
      return this.realTool.handlePaste();
    }
    return false;
  }

  handleSelectAll() {
    if (this.realTool) {
      this.realTool.handleSelectAll();
    }
  }

  handleDeselect() {
    if (this.realTool) {
      this.realTool.handleDeselect();
    }
  }

  handleDelete() {
    if (this.realTool) {
      this.realTool.handleDelete();
    }
  }

  // BEGIN: Added proxy methods for copy/paste
  async copy() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.copy();
  }

  async cut() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.cut();
  }

  async paste() {
    if (!this.realTool) await this.loadRealTool();
    if (this.realTool) return this.realTool.paste();
  }

  hasSelection() {
    return this.realTool ? this.realTool.hasSelection() : false;
  }

  hasClipboard() {
    return this.realTool ? this.realTool.hasClipboard() : false;
  }
  // END: Added proxy methods

  async pasteImage(imageSource) {
    if (!this.realTool) {
      await this.loadRealTool();
    }
    if (this.realTool) {
      return this.realTool.pasteImage(imageSource);
    }
    return false;
  }

  getMode() {
    return this.realTool ? this.realTool.mode : 'lasso';
  }
}
