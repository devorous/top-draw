/**
 * Color Palette Manager
 * Handles preset swatches, recent colors, and custom swatches
 */
export class ColorPalette {
  constructor(options = {}) {
    this.onColorSelect = options.onColorSelect || (() => {});

    // Recent colors (auto-populated)
    this.recentColors = [];
    this.maxRecentColors = 6;

    // Custom swatches (user-saved)
    this.customColors = [];
    this.maxCustomColors = 12;

    // DOM elements
    this.elements = {
      recentSwatches: null,
      customSwatches: null,
      addCustomSwatch: null
    };

    // Load saved custom colors from localStorage
    this.loadCustomColors();
    this.loadRecentColors();
  }

  init() {
    this.cacheElements();
    this.renderRecent();
    this.renderCustom();
    this.setupEventListeners();
  }

  cacheElements() {
    this.elements.recentSwatches = document.getElementById('recentSwatches');
    this.elements.customSwatches = document.getElementById('customSwatches');
    this.elements.addCustomSwatch = document.getElementById('addCustomSwatch');
  }

  setupEventListeners() {
    // Add custom swatch button
    if (this.elements.addCustomSwatch) {
      this.elements.addCustomSwatch.addEventListener('click', () => {
        this.onColorSelect((currentColor) => {
          this.addCustomColor(currentColor);
        });
      });
    }
  }

  /**
   * Create a swatch element
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

    // Right-click to remove custom swatches
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
   * Render recent color swatches
   */
  renderRecent() {
    if (!this.elements.recentSwatches) return;

    this.elements.recentSwatches.innerHTML = '';

    // Show recent colors or empty placeholders
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
   * Render custom color swatches
   */
  renderCustom() {
    if (!this.elements.customSwatches) return;

    // Clear all except the add button
    const addBtn = this.elements.addCustomSwatch;
    this.elements.customSwatches.innerHTML = '';

    // Add custom swatches
    this.customColors.forEach(color => {
      const swatch = this.createSwatch(color, 'custom');
      this.elements.customSwatches.appendChild(swatch);
    });

    // Re-add the add button at the end
    if (addBtn && this.customColors.length < this.maxCustomColors) {
      this.elements.customSwatches.appendChild(addBtn);
    }
  }

  /**
   * Select a color and notify callback
   */
  selectColor(color) {
    this.onColorSelect(color);
  }

  /**
   * Add a color to recent colors
   */
  addRecentColor(color) {
    // Don't add if it's the same as the most recent
    if (this.recentColors.length > 0 && this.colorsEqual(this.recentColors[0], color)) {
      return;
    }

    // Remove if already exists elsewhere
    this.recentColors = this.recentColors.filter(c => !this.colorsEqual(c, color));

    // Add to front
    this.recentColors.unshift([...color]);

    // Limit size
    if (this.recentColors.length > this.maxRecentColors) {
      this.recentColors.pop();
    }

    this.saveRecentColors();
    this.renderRecent();
  }

  /**
   * Add a custom color swatch
   */
  addCustomColor(color) {
    // Check if already exists
    if (this.customColors.some(c => this.colorsEqual(c, color))) {
      return;
    }

    // Check max limit
    if (this.customColors.length >= this.maxCustomColors) {
      // Remove oldest
      this.customColors.shift();
    }

    this.customColors.push([...color]);
    this.saveCustomColors();
    this.renderCustom();
  }

  /**
   * Remove a custom color swatch
   */
  removeCustomColor(color) {
    this.customColors = this.customColors.filter(c => !this.colorsEqual(c, color));
    this.saveCustomColors();
    this.renderCustom();
  }

  /**
   * Check if two colors are equal
   */
  colorsEqual(a, b) {
    if (!a || !b) return false;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  }

  /**
   * Convert color array to rgba string
   */
  colorToRgba(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
  }

  /**
   * Convert color array to hex string
   */
  colorToHex(color) {
    const r = color[0].toString(16).padStart(2, '0');
    const g = color[1].toString(16).padStart(2, '0');
    const b = color[2].toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toUpperCase();
  }

  /**
   * Save custom colors to localStorage
   */
  saveCustomColors() {
    try {
      localStorage.setItem('topdraw_customColors', JSON.stringify(this.customColors));
    } catch (e) {
      console.warn('Failed to save custom colors:', e);
    }
  }

  /**
   * Load custom colors from localStorage
   */
  loadCustomColors() {
    try {
      const saved = localStorage.getItem('topdraw_customColors');
      if (saved) {
        this.customColors = JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load custom colors:', e);
      this.customColors = [];
    }
  }

  /**
   * Save recent colors to localStorage
   */
  saveRecentColors() {
    try {
      localStorage.setItem('topdraw_recentColors', JSON.stringify(this.recentColors));
    } catch (e) {
      console.warn('Failed to save recent colors:', e);
    }
  }

  /**
   * Load recent colors from localStorage
   */
  loadRecentColors() {
    try {
      const saved = localStorage.getItem('topdraw_recentColors');
      if (saved) {
        this.recentColors = JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load recent colors:', e);
      this.recentColors = [];
    }
  }
}
