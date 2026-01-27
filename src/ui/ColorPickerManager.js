/**
 * Color Picker Manager
 * Handles primary/secondary colors and syncs opacity slider with color picker
 */
export class ColorPickerManager {
  constructor(options = {}) {
    this.onColorChange = options.onColorChange || (() => {});
    this.onOpacityChange = options.onOpacityChange || (() => {});

    // Primary and secondary colors
    this.primaryColor = [0, 0, 0, 1];
    this.secondaryColor = [255, 255, 255, 1];
    this.isSecondaryActive = false;

    // External reference to opacity slider
    this.opacitySlider = null;
    this.opacityValue = null;

    // Color picker instance
    this.picker = null;

    // DOM elements
    this.elements = {
      container: null,
      primarySwatch: null,
      secondarySwatch: null,
      swapBtn: null,
      pickerContainer: null
    };

    // Track if we're updating programmatically to avoid loops
    this.isUpdating = false;
  }

  init(pickerContainerId, opacitySlider, opacityValue) {
    this.opacitySlider = opacitySlider;
    this.opacityValue = opacityValue;

    this.createColorSwatches();
    this.setupPicker(pickerContainerId);
    this.setupOpacitySync();
  }

  /**
   * Create the primary/secondary color swatch UI
   */
  createColorSwatches() {
    // Find or create the swatch container before the picker
    const pickerContainer = document.getElementById('pickerContainer');
    if (!pickerContainer) return;

    // Create the swatch container
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

    // Insert before picker container
    pickerContainer.parentNode.insertBefore(container, pickerContainer);

    // Cache elements
    this.elements.container = container;
    this.elements.primarySwatch = document.getElementById('primaryColorSwatch');
    this.elements.secondarySwatch = document.getElementById('secondaryColorSwatch');
    this.elements.swapBtn = document.getElementById('swapColorsBtn');
    this.elements.pickerContainer = pickerContainer;

    // Set initial colors
    this.updateSwatchColors();

    // Setup event listeners
    this.elements.primarySwatch.addEventListener('click', () => this.selectPrimary());
    this.elements.secondarySwatch.addEventListener('click', () => this.selectSecondary());
    this.elements.swapBtn.addEventListener('click', () => this.swapColors());
  }

  /**
   * Setup the vanilla-picker color picker
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

        // Update the active color
        const rgba = color.rgba;
        if (this.isSecondaryActive) {
          this.secondaryColor = [...rgba];
        } else {
          this.primaryColor = [...rgba];
        }

        this.updateSwatchColors();

        // Sync opacity slider with color alpha
        this.syncOpacityFromColor(rgba[3]);

        // Notify callback
        this.onColorChange(rgba);
      }
    });
  }

  /**
   * Setup opacity slider sync
   */
  setupOpacitySync() {
    if (!this.opacitySlider) return;

    this.opacitySlider.addEventListener('input', (e) => {
      if (this.isUpdating) return;

      const opacity = Number(e.target.value) / 100;

      // Update active color's alpha
      if (this.isSecondaryActive) {
        this.secondaryColor[3] = opacity;
        this.updatePickerColor(this.secondaryColor);
      } else {
        this.primaryColor[3] = opacity;
        this.updatePickerColor(this.primaryColor);
      }

      this.updateSwatchColors();

      // Update the value display
      if (this.opacityValue) {
        this.opacityValue.textContent = `${e.target.value}%`;
      }

      // Notify callback
      this.onOpacityChange(opacity);
    });
  }

  /**
   * Sync opacity slider from color alpha
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
   * Update picker color programmatically
   */
  updatePickerColor(color) {
    if (!this.picker) return;

    this.isUpdating = true;
    this.picker.setColor(this.rgbaToString(color));
    this.isUpdating = false;
  }

  /**
   * Select primary color
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
   * Select secondary color
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
   * Swap primary and secondary colors
   */
  swapColors() {
    const temp = [...this.primaryColor];
    this.primaryColor = [...this.secondaryColor];
    this.secondaryColor = temp;

    this.updateSwatchColors();

    // Update picker with new active color
    const activeColor = this.isSecondaryActive ? this.secondaryColor : this.primaryColor;
    this.updatePickerColor(activeColor);
    this.syncOpacityFromColor(activeColor[3]);
    this.onColorChange(activeColor);
  }

  /**
   * Update swatch background colors
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
   * Get the current active color
   */
  getActiveColor() {
    return this.isSecondaryActive ? [...this.secondaryColor] : [...this.primaryColor];
  }

  /**
   * Set the current active color externally (e.g., from palette)
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
   * Convert RGBA array to CSS string
   */
  rgbaToString(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
  }

  /**
   * Handle keyboard shortcut (X to swap)
   */
  handleKeyDown(key) {
    if (key.toLowerCase() === 'x') {
      this.swapColors();
      return true;
    }
    return false;
  }
}
