/**
 * @fileoverview Color Picker Manager - Handles primary/secondary colors and syncs opacity slider.
 */

/**
 * ColorPickerManager class
 */
export class ColorPickerManager {
  /**
   * @param {Object} [options={}] - Configuration options
   */
  constructor(options = {}) {
    this.onColorChange = options.onColorChange || (() => {});
    this.onOpacityChange = options.onOpacityChange || (() => {});

    this.primaryColor = [0, 0, 0, 1];
    this.secondaryColor = [255, 255, 255, 1];
    this.isSecondaryActive = false;

    this.opacitySlider = null;
    this.opacityValue = null;
    this.picker = null;

    this.elements = {
      container: null,
      primarySwatch: null,
      secondarySwatch: null,
      swapBtn: null,
      pickerContainer: null
    };

    /**
     * Prevents recursive update loops.
     * @type {boolean}
     */
    this.isUpdating = false;
  }

  /**
   * Initializes the manager with DOM elements and external components.
   * @param {string} pickerContainerId - ID for the picker container
   * @param {HTMLElement} opacitySlider - Reference to opacity slider input
   * @param {HTMLElement} opacityValue - Reference to opacity value display
   */
  init(pickerContainerId, opacitySlider, opacityValue) {
    this.opacitySlider = opacitySlider;
    this.opacityValue = opacityValue;

    this.createColorSwatches();
    this.setupPicker(pickerContainerId);
    this.setupOpacitySync();
  }

  /**
   * Create the primary/secondary color swatch UI.
   */
  createColorSwatches() {
    const pickerContainer = document.getElementById('pickerContainer');
    if (!pickerContainer) return;

    const container = document.createElement('div');
    container.id = 'colorSwatches';
    container.className = 'colorSwatches';
    container.innerHTML = `
      <div class="swatchStack">
        <button class="colorSwatch primary active" id="primaryColorSwatch" title="Primary color (X to swap)">
          <span class="swatchLabel">1</span>
        </button>
        <button class="colorSwatch secondary" id="secondaryColorSwatch" title="Secondary color (X to swap)">
          <span class="swatchLabel">2</span>
        </button>
        <button class="swapColors" id="swapColorsBtn" title="Swap colors (X)">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3L5 6.99h3V14h2V6.99h3L9 3z"/>
          </svg>
        </button>
      </div>
    `;

    pickerContainer.parentNode.insertBefore(container, pickerContainer);

    this.elements.container = container;
    this.elements.primarySwatch = document.getElementById('primaryColorSwatch');
    this.elements.secondarySwatch = document.getElementById('secondaryColorSwatch');
    this.elements.swapBtn = document.getElementById('swapColorsBtn');
    this.elements.pickerContainer = pickerContainer;

    this.updateSwatchColors();

    this.elements.primarySwatch.addEventListener('click', () => this.selectPrimary());
    this.elements.secondarySwatch.addEventListener('click', () => this.selectSecondary());
    this.elements.swapBtn.addEventListener('click', () => this.swapColors());
  }

  /**
   * Setup the vanilla-picker color picker.
   * @param {string} containerId - Container element ID
   */
  setupPicker(containerId) {
    const container = document.getElementById(containerId);
    if (!container || typeof Picker === 'undefined') return;

    this.picker = new Picker({
      parent: container,
      popup: false,
      alpha: true,
      editor: true,
      color: this.rgbaToString(this.primaryColor),
      onChange: (color) => {
        if (this.isUpdating) return;

        const rgba = color.rgba;
        if (this.isSecondaryActive) {
          this.secondaryColor = [...rgba];
        } else {
          this.primaryColor = [...rgba];
        }

        this.updateSwatchColors();
        this.syncOpacityFromColor(rgba[3]);
        this.onColorChange(rgba);
      }
    });
  }

  /**
   * Setup opacity slider sync.
   */
  setupOpacitySync() {
    if (!this.opacitySlider) return;

    this.opacitySlider.addEventListener('input', (e) => {
      if (this.isUpdating) return;

      const opacity = Number(e.target.value) / 100;

      if (this.isSecondaryActive) {
        this.secondaryColor[3] = opacity;
        this.updatePickerColor(this.secondaryColor);
      } else {
        this.primaryColor[3] = opacity;
        this.updatePickerColor(this.primaryColor);
      }

      this.updateSwatchColors();

      if (this.opacityValue) {
        this.opacityValue.textContent = `${e.target.value}%`;
      }

      this.onOpacityChange(opacity);
    });
  }

  /**
   * Sync opacity slider from color alpha.
   * @param {number} alpha - Alpha value (0-1)
   */
  syncOpacityFromColor(alpha) {
    if (!this.opacitySlider) return;

    this.isUpdating = true;
    const percent = Math.round(alpha * 100);
    this.opacitySlider.value = percent;

    if (this.opacityValue) {
      this.opacityValue.textContent = `${percent}%`;
    }

    this.onOpacityChange(alpha);
    this.isUpdating = false;
  }

  /**
   * Update picker color programmatically.
   * @param {Array} color - [r, g, b, a] color array
   */
  updatePickerColor(color) {
    if (!this.picker) return;

    this.isUpdating = true;
    this.picker.setColor(this.rgbaToString(color));
    this.isUpdating = false;
  }

  /**
   * Select primary color.
   */
  selectPrimary() {
    this.isSecondaryActive = false;
    this.elements.primarySwatch.classList.add('active');
    this.elements.secondarySwatch.classList.remove('active');

    this.updatePickerColor(this.primaryColor);
    this.syncOpacityFromColor(this.primaryColor[3]);
    this.onColorChange(this.primaryColor);
  }

  /**
   * Select secondary color.
   */
  selectSecondary() {
    this.isSecondaryActive = true;
    this.elements.secondarySwatch.classList.add('active');
    this.elements.primarySwatch.classList.remove('active');

    this.updatePickerColor(this.secondaryColor);
    this.syncOpacityFromColor(this.secondaryColor[3]);
    this.onColorChange(this.secondaryColor);
  }

  /**
   * Swap primary and secondary colors.
   */
  swapColors() {
    const temp = [...this.primaryColor];
    this.primaryColor = [...this.secondaryColor];
    this.secondaryColor = temp;

    this.updateSwatchColors();

    const activeColor = this.isSecondaryActive ? this.secondaryColor : this.primaryColor;
    this.updatePickerColor(activeColor);
    this.syncOpacityFromColor(activeColor[3]);
    this.onColorChange(activeColor);
  }

  /**
   * Update swatch background colors.
   */
  updateSwatchColors() {
    if (this.elements.primarySwatch) {
      this.elements.primarySwatch.style.backgroundColor = this.rgbaToString(this.primaryColor);
    }
    if (this.elements.secondarySwatch) {
      this.elements.secondarySwatch.style.backgroundColor = this.rgbaToString(this.secondaryColor);
    }
  }

  /**
   * Get the current active color.
   * @returns {Array} - [r, g, b, a] color array
   */
  getActiveColor() {
    return this.isSecondaryActive ? [...this.secondaryColor] : [...this.primaryColor];
  }

  /**
   * Set the current active color externally.
   * @param {Array} color - [r, g, b, a] color array
   */
  setActiveColor(color) {
    if (this.isSecondaryActive) {
      this.secondaryColor = [...color];
    } else {
      this.primaryColor = [...color];
    }

    this.updateSwatchColors();
    this.updatePickerColor(color);
    this.syncOpacityFromColor(color[3]);
  }

  /**
   * Convert RGBA array to CSS string.
   * @param {Array} color - [r, g, b, a] color array
   * @returns {string} - CSS rgba string
   */
  rgbaToString(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
  }

  /**
   * Handle keyboard shortcuts.
   * @param {string} key - Key code
   * @returns {boolean} - True if shortcut was handled
   */
  handleKeyDown(key) {
    if (key.toLowerCase() === 'x') {
      this.swapColors();
      return true;
    }
    return false;
  }
}
