/**
 * @fileoverview Color Palette Manager - Handles preset swatches, recent colors, and custom swatches.
 */

/**
 * ColorPalette class
 */
export class ColorPalette {
  /**
   * @param {Object} [options={}] - Configuration options
   */
  constructor(options = {}) {
    this.onColorSelect = options.onColorSelect || (() => {});

    this.recentColors = [];
    this.maxRecentColors = 6;

    this.customColors = [];
    this.maxCustomColors = 12;

    this.elements = {
      recentSwatches: null,
      customSwatches: null,
      addCustomSwatch: null
    };

    this.loadCustomColors();
    this.loadRecentColors();
  }

  /**
   * Initializes the color palette UI and state.
   */
  init() {
    this.cacheElements();
    this.renderRecent();
    this.renderCustom();
    this.setupEventListeners();
  }

  /**
   * Caches DOM element references.
   */
  cacheElements() {
    this.elements.recentSwatches = document.getElementById('recentSwatches');
    this.elements.customSwatches = document.getElementById('customSwatches');
    this.elements.addCustomSwatch = document.getElementById('addCustomSwatch');
  }

  /**
   * Sets up event listeners for palette interactions.
   */
  setupEventListeners() {
    if (this.elements.addCustomSwatch) {
      this.elements.addCustomSwatch.addEventListener('click', () => {
        this.onColorSelect((currentColor) => {
          this.addCustomColor(currentColor);
        });
      });
    }
  }

  /**
   * Create a swatch element.
   * @param {Array} color - [r, g, b, a] color array
   * @param {string} [type='preset'] - Swatch category type
   * @returns {HTMLElement} - The created button element
   */
  createSwatch(color, type = 'preset') {
    const swatch = document.createElement('button');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = this.colorToRgba(color);
    swatch.title = this.colorToHex(color);
    swatch.dataset.type = type;
    swatch.dataset.color = JSON.stringify(color);

    swatch.addEventListener('click', () => {
      this.selectColor(color);
    });

    if (type === 'custom') {
      swatch.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.removeCustomColor(color);
      });
      swatch.title += ' (right-click to remove)';
    }

    return swatch;
  }

  /**
   * Render recent color swatches.
   */
  renderRecent() {
    if (!this.elements.recentSwatches) return;

    this.elements.recentSwatches.innerHTML = '';

    for (let i = 0; i < this.maxRecentColors; i++) {
      if (i < this.recentColors.length) {
        const swatch = this.createSwatch(this.recentColors[i], 'recent');
        this.elements.recentSwatches.appendChild(swatch);
      } else {
        const empty = document.createElement('div');
        empty.className = 'swatch empty';
        this.elements.recentSwatches.appendChild(empty);
      }
    }
  }

  /**
   * Render custom color swatches.
   */
  renderCustom() {
    if (!this.elements.customSwatches) return;

    const addBtn = this.elements.addCustomSwatch;
    this.elements.customSwatches.innerHTML = '';

    this.customColors.forEach(color => {
      const swatch = this.createSwatch(color, 'custom');
      this.elements.customSwatches.appendChild(swatch);
    });

    if (addBtn && this.customColors.length < this.maxCustomColors) {
      this.elements.customSwatches.appendChild(addBtn);
    }
  }

  /**
   * Select a color and notify callback.
   * @param {Array} color - [r, g, b, a] color array
   */
  selectColor(color) {
    this.onColorSelect(color);
  }

  /**
   * Add a color to recent colors list.
   * @param {Array} color - [r, g, b, a] color array
   */
  addRecentColor(color) {
    if (this.recentColors.length > 0 && this.colorsEqual(this.recentColors[0], color)) {
      return;
    }

    this.recentColors = this.recentColors.filter(c => !this.colorsEqual(c, color));
    this.recentColors.unshift([...color]);

    if (this.recentColors.length > this.maxRecentColors) {
      this.recentColors.pop();
    }

    this.saveRecentColors();
    this.renderRecent();
  }

  /**
   * Add a color to custom swatches.
   * @param {Array} color - [r, g, b, a] color array
   */
  addCustomColor(color) {
    if (this.customColors.some(c => this.colorsEqual(c, color))) {
      return;
    }

    if (this.customColors.length >= this.maxCustomColors) {
      this.customColors.shift();
    }

    this.customColors.push([...color]);
    this.saveCustomColors();
    this.renderCustom();
  }

  /**
   * Remove a custom color swatch.
   * @param {Array} color - [r, g, b, a] color array
   */
  removeCustomColor(color) {
    this.customColors = this.customColors.filter(c => !this.colorsEqual(c, color));
    this.saveCustomColors();
    this.renderCustom();
  }

  /**
   * Check if two colors are equal.
   * @param {Array} a - Color A [r, g, b, a]
   * @param {Array} b - Color B [r, g, b, a]
   * @returns {boolean} - True if equal
   */
  colorsEqual(a, b) {
    if (!a || !b) return false;
    const a3 = (a[3] > 0 && a[3] < 0.01) ? 1.0 : a[3];
    const b3 = (b[3] > 0 && b[3] < 0.01) ? 1.0 : b[3];
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a3 === b3;
  }

  /**
   * Convert color array to rgba string.
   * @param {Array} color - [r, g, b, a] color array
   * @returns {string} - CSS rgba string
   */
  colorToRgba(color) {
    if (!color) return 'rgba(0,0,0,1)';
    let alpha = color[3];
    if (alpha > 0 && alpha < 0.01) alpha = 1.0;
    if (alpha > 1) alpha = alpha / 255;
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
  }

  /**
   * Convert color array to hex string.
   * @param {Array} color - [r, g, b, a] color array
   * @returns {string} - Hex string (e.g., #FFFFFF)
   */
  colorToHex(color) {
    if (!color) return '#000000';
    const r = Math.round(color[0]).toString(16).padStart(2, '0');
    const g = Math.round(color[1]).toString(16).padStart(2, '0');
    const b = Math.round(color[2]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toUpperCase();
  }

  /**
   * Save custom colors to localStorage.
   */
  saveCustomColors() {
    try {
      const cleanColors = this.customColors.map(c => {
        const copy = [...c];
        if (copy[3] > 0 && copy[3] < 0.01) copy[3] = 1.0;
        return copy;
      });
      localStorage.setItem('topdraw_customColors', JSON.stringify(cleanColors));
    } catch (e) {
      console.warn('Failed to save custom colors:', e);
    }
  }

  /**
   * Load custom colors from localStorage.
   */
  loadCustomColors() {
    try {
      const saved = localStorage.getItem('topdraw_customColors');
      if (saved) {
        this.customColors = JSON.parse(saved);
        this.customColors.forEach(c => {
          if (c[3] > 0 && c[3] < 0.01) c[3] = 1.0;
        });
      }
    } catch (e) {
      console.warn('Failed to load custom colors:', e);
      this.customColors = [];
    }
  }

  /**
   * Save recent colors to localStorage.
   */
  saveRecentColors() {
    try {
      const cleanColors = this.recentColors.map(c => {
        const copy = [...c];
        if (copy[3] > 0 && copy[3] < 0.01) copy[3] = 1.0;
        return copy;
      });
      localStorage.setItem('topdraw_recentColors', JSON.stringify(cleanColors));
    } catch (e) {
      console.warn('Failed to save recent colors:', e);
    }
  }

  /**
   * Load recent colors from localStorage.
   */
  loadRecentColors() {
    try {
      const saved = localStorage.getItem('topdraw_recentColors');
      if (saved) {
        this.recentColors = JSON.parse(saved);
        this.recentColors.forEach(c => {
          if (c[3] > 0 && c[3] < 0.01) c[3] = 1.0;
        });
      }
    } catch (e) {
      console.warn('Failed to load recent colors:', e);
      this.recentColors = [];
    }
  }
}
