/**
 * BrushModeManager - Manages brush mode switching between classic, fluid (flowPen), and ink
 * Handles persistence to localStorage and mode synchronization with tool selection
 */

export class BrushModeManager {
  constructor(app) {
    this.app = app;
    this.currentMode = this.loadBrushMode();
  }

  /**
   * Get the current brush mode
   * @returns {string} - 'classic', 'fluid', or 'ink'
   */
  getMode() {
    return this.currentMode;
  }

  /**
   * Set brush mode and switch to corresponding tool
   * @param {string} mode - 'classic', 'fluid', or 'ink'
   */
  setMode(mode) {
    // Don't allow mode change while drawing
    if (this.app.self.mousedown) {
      this.app.ui.updateBrushModeDisplay(this.currentMode);
      return;
    }

    this.currentMode = mode;
    this.saveBrushMode();

    const toolName = mode === 'fluid' ? 'flowPen' : mode === 'ink' ? 'ink' : 'brush';
    this.app.selectTool(toolName);
  }

  /**
   * Update mode when tool is switched (keeps mode in sync with active brush tool)
   * @param {string} tool - Tool name
   */
  updateModeFromTool(tool) {
    if (tool === 'brush' || tool === 'flowPen' || tool === 'ink') {
      this.currentMode = tool === 'flowPen' ? 'fluid' : tool === 'ink' ? 'ink' : 'classic';
      this.saveBrushMode();
      this.app.ui.updateBrushModeDisplay(this.currentMode);
    }
  }

  /**
   * Get the tool name for the current brush mode
   * @returns {string} - 'brush', 'flowPen', or 'ink'
   */
  getCurrentToolName() {
    return this.currentMode === 'fluid' ? 'flowPen' : this.currentMode === 'ink' ? 'ink' : 'brush';
  }

  /**
   * Load brush mode from localStorage
   * @returns {string} - 'classic', 'fluid', or 'ink'
   */
  loadBrushMode() {
    try {
      return localStorage.getItem('topDrawBrushMode') || 'ink';
    } catch (e) {
      return 'ink';
    }
  }

  /**
   * Save brush mode to localStorage
   */
  saveBrushMode() {
    try {
      localStorage.setItem('topDrawBrushMode', this.currentMode);
    } catch (e) {
      console.warn('Failed to save brush mode:', e);
    }
  }
}
