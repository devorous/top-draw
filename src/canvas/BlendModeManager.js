/**
 * @fileoverview BlendModeManager - Blend mode utilities and per-layer persistence
 */

/**
 * Manages blend modes and their persistence in localStorage.
 * Blend mode is a layer property stored in LayerManager.
 */
export class BlendModeManager {
  /**
   * @param {Object} app - The main application instance
   */
  constructor(app) {
    this.app = app;
  }

  /**
   * Available blend modes with display names
   * @type {Object.<string, string>}
   */
  static BLEND_MODES = {
    'Normal': 'source-over',
    'Multiply': 'multiply',
    'Screen': 'screen',
    'Add': 'lighter',
    'Overlay': 'overlay',
    'Darken': 'darken',
    'Lighten': 'lighten',
    'Difference': 'difference',
    'Color Dodge': 'color-dodge',
    'Color Burn': 'color-burn'
  };

  /**
   * Convert a Canvas 2D globalCompositeOperation value to a CSS mix-blend-mode value.
   * @param {string} canvasBlendMode - Canvas 2D blend mode string
   * @returns {string} CSS mix-blend-mode value
   */
  toCSSBlendMode(canvasBlendMode) {
    const map = {
      'source-over':    'normal',
      'multiply':       'multiply',
      'screen':         'screen',
      'overlay':        'overlay',
      'darken':         'darken',
      'lighten':        'lighten',
      'color-dodge':    'color-dodge',
      'color-burn':     'color-burn',
      'hard-light':     'hard-light',
      'soft-light':     'soft-light',
      'difference':     'difference',
      'exclusion':      'exclusion',
      'hue':            'hue',
      'saturation':     'saturation',
      'color':          'color',
      'luminosity':     'luminosity',
      'lighter':        'plus-lighter',
      'destination-out':  'normal'
    };
    return map[canvasBlendMode] || 'normal';
  }

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

  /**
   * Load per-layer blend modes from localStorage
   * @returns {Object.<string, string>} Layer index to blend mode mapping
   */
  loadLayerBlendModes() {
    try {
      const stored = localStorage.getItem('topDrawLayerBlendModes');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      console.warn('Failed to load layer blend modes:', e);
      return {};
    }
  }

  /**
   * Save per-layer blend modes to localStorage
   * @param {Object.<string, string>} layerBlendModes - Layer index to blend mode mapping
   */
  saveLayerBlendModes(layerBlendModes) {
    try {
      localStorage.setItem('topDrawLayerBlendModes', JSON.stringify(layerBlendModes));
    } catch (e) {
      console.warn('Failed to save layer blend modes:', e);
    }
  }

  /**
   * Restore blend modes from localStorage to LayerManager
   */
  restoreBlendModes() {
    const layerManager = this.app.board?.layerManager;
    if (!layerManager) return;

    const saved = this.loadLayerBlendModes();
    for (const [layerIndex, blendMode] of Object.entries(saved)) {
      const idx = parseInt(layerIndex);
      if (!isNaN(idx) && layerManager.layerGroups[idx]) {
        layerManager.setActiveBlendMode(idx, blendMode);
      }
    }
  }

  /**
   * Save current layer blend modes from LayerManager to localStorage
   */
  persistBlendModes() {
    const layerManager = this.app.board?.layerManager;
    if (!layerManager) return;

    const layerBlendModes = {};
    layerManager.layerGroups.forEach((group, idx) => {
      if (group.activeBlendMode && group.activeBlendMode !== 'source-over') {
        layerBlendModes[idx] = group.activeBlendMode;
      }
    });
    this.saveLayerBlendModes(layerBlendModes);
  }
}
