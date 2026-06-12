/**
 * @fileoverview Manages brush mode switching between classic, pixel, fluid (flowPen), and ink.
 * Handles persistence to localStorage and mode synchronization with tool selection.
 */

/**
 * BrushModeManager handles the brush mode state and transitions.
 */
export class BrushModeManager {
  /**
   * @param {Object} app - The main application instance.
   */
  constructor(app) {
    this.app = app;
    this.currentMode = this.loadBrushMode();
  }

  /**
   * Get the current brush mode.
   * @returns {string} - 'classic', 'pixel', 'fluid', or 'ink'.
   */
  getMode() {
    return this.currentMode;
  }

  /**
   * Set brush mode and switch to corresponding tool.
   * @param {string} mode - 'classic', 'pixel', 'fluid', or 'ink'.
   */
  setMode(mode) {
    if (this.app.self.mousedown) {
      this.app.ui.updateBrushModeDisplay(this.currentMode);
      return;
    }

    this.currentMode = mode;
    this.saveBrushMode();

    this.app.selectTool(BrushModeManager._modeToToolName(mode));
  }

  /**
   * Maps a brush mode to its corresponding tool name.
   * @param {string} mode - 'classic', 'pixel', 'fluid', or 'ink'.
   * @returns {string} - 'brush', 'pixel', 'flowPen', or 'ink'.
   */
  static _modeToToolName(mode) {
    return mode === 'pixel' ? 'pixel' : mode === 'fluid' ? 'flowPen' : mode === 'ink' ? 'ink' : 'brush';
  }

  /**
   * Update mode when tool is switched.
   * @param {string} tool - Tool name.
   */
  updateModeFromTool(tool) {
    if (tool === 'brush' || tool === 'pixel' || tool === 'flowPen' || tool === 'ink') {
      this.currentMode = tool === 'pixel' ? 'pixel' : tool === 'flowPen' ? 'fluid' : tool === 'ink' ? 'ink' : 'classic';
      this.saveBrushMode();
      this.app.ui.updateBrushModeDisplay(this.currentMode);
    }
  }

  /**
   * Get the tool name for the current brush mode.
   * @returns {string} - 'brush', 'pixel', 'flowPen', or 'ink'.
   */
  getCurrentToolName() {
    return BrushModeManager._modeToToolName(this.currentMode);
  }

  /**
   * Load brush mode from localStorage.
   * @returns {string} - 'classic', 'pixel', 'fluid', or 'ink'.
   */
  loadBrushMode() {
    try {
      return localStorage.getItem('topDrawBrushMode') || 'ink';
    } catch (e) {
      return 'ink';
    }
  }

  /**
   * Save brush mode to localStorage.
   */
  saveBrushMode() {
    try {
      localStorage.setItem('topDrawBrushMode', this.currentMode);
    } catch (e) {
      console.warn('Failed to save brush mode:', e);
    }
  }
}
