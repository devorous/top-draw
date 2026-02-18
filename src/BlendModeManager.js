/**
 * BlendModeManager - Manages blend mode state per tool
 * Each tool can have its own blend mode that persists across tool switches
 */
export class BlendModeManager {
  constructor(app) {
    this.app = app;
    // Store blend mode per tool (persistent across tool switches)
    this.toolBlendModes = this.loadBlendModes();
  }

  /**
   * Get blend mode for a specific tool
   * @param {string} tool - Tool name
   * @returns {string} Blend mode (e.g., 'source-over', 'multiply')
   */
  getBlendMode(tool) {
    return this.toolBlendModes[tool] || 'source-over';
  }

  /**
   * Set blend mode for a specific tool
   * @param {string} tool - Tool name
   * @param {string} blendMode - Blend mode to set
   */
  setBlendMode(tool, blendMode) {
    this.toolBlendModes[tool] = blendMode;
    this.saveBlendModes();

    // Update current user if this is their active tool
    if (this.app.self && this.app.self.tool === tool) {
      this.app.self.setBlendMode(blendMode);

      // Broadcast to other users
      if (this.app.wsClient && this.app.connected) {
        this.app.wsClient.broadcastBlendModeChange(blendMode);
      }
    }
  }

  /**
   * Load blend modes from localStorage
   * @returns {Object} Tool blend mode mappings
   */
  loadBlendModes() {
    try {
      const stored = localStorage.getItem('topDrawBlendModes');
      return stored ? JSON.parse(stored) : this.getDefaultBlendModes();
    } catch (e) {
      console.warn('Failed to load blend modes:', e);
      return this.getDefaultBlendModes();
    }
  }

  /**
   * Save blend modes to localStorage
   */
  saveBlendModes() {
    try {
      localStorage.setItem('topDrawBlendModes', JSON.stringify(this.toolBlendModes));
    } catch (e) {
      console.warn('Failed to save blend modes:', e);
    }
  }

  /**
   * Get default blend modes for all tools
   * @returns {Object} Default blend mode mappings
   */
  getDefaultBlendModes() {
    return {
      brush: 'source-over',
      flowPen: 'source-over',
      ink: 'source-over',
      line: 'source-over',
      rectangle: 'source-over',
      circle: 'source-over',
      text: 'source-over',
      imageBrush: 'source-over',
      blur: 'source-over',
      circleBlur: 'source-over'
      // Note: eraser is not included - it always uses destination-out
    };
  }

  /**
   * Available blend modes with display names
   */
  static BLEND_MODES = {
    'Normal': 'source-over',
    'Multiply': 'multiply',
    'Screen': 'screen',
    'Add': 'lighter',
    'Behind': 'destination-over',
    'Overlay': 'overlay',
    'Darken': 'darken',
    'Lighten': 'lighten',
    'Difference': 'difference',
    'Color Dodge': 'color-dodge',
    'Color Burn': 'color-burn'
  };

  /**
   * Get display name for a blend mode value
   * @param {string} blendMode - Blend mode value
   * @returns {string} Display name
   */
  static getDisplayName(blendMode) {
    for (const [name, value] of Object.entries(BlendModeManager.BLEND_MODES)) {
      if (value === blendMode) return name;
    }
    return 'Normal';
  }
}
