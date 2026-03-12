/**
 * @fileoverview Color Input Menu - Allows manual RGB/HSV color input.
 */

/**
 * ColorInputMenu class
 */
export class ColorInputMenu {
  /**
   * @param {Object} [options={}] - Configuration options
   */
  constructor(options = {}) {
    this.onColorChange = options.onColorChange || (() => {});
    this.currentMode = 'rgb'; // 'rgb', 'hsv', or 'hex'
    this.isOpen = false;
    this.elements = {};
  }

  /**
   * Initializes the menu component.
   */
  init() {
    this.cacheElements();
    this.setupEventListeners();
  }

  /**
   * Caches DOM element references.
   */
  cacheElements() {
    this.elements = {
      menu: document.getElementById('colorInputMenu'),
      openBtn: document.getElementById('colorInputBtn'),
      closeBtn: document.getElementById('colorInputClose'),
      tabs: document.querySelectorAll('.colorInputTab'),
      rgbMode: document.getElementById('rgbMode'),
      hsvMode: document.getElementById('hsvMode'),
      hexMode: document.getElementById('hexMode'),

      inputR: document.getElementById('inputR'),
      inputG: document.getElementById('inputG'),
      inputB: document.getElementById('inputB'),
      inputA: document.getElementById('inputA'),

      inputH: document.getElementById('inputH'),
      inputS: document.getElementById('inputS'),
      inputV: document.getElementById('inputV'),
      inputA_hsv: document.getElementById('inputA_hsv'),

      inputHex: document.getElementById('inputHex'),
      inputA_hex: document.getElementById('inputA_hex')
    };
  }

  /**
   * Sets up event listeners for inputs and controls.
   */
  setupEventListeners() {
    this.elements.openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.elements.closeBtn.addEventListener('click', () => this.close());

    this.elements.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        this.switchMode(mode);
      });
    });

    ['inputR', 'inputG', 'inputB', 'inputA'].forEach(key => {
      this.elements[key].addEventListener('input', () => this.handleRGBChange());
      this.elements[key].addEventListener('change', () => this.handleRGBChange());
    });

    ['inputH', 'inputS', 'inputV', 'inputA_hsv'].forEach(key => {
      this.elements[key].addEventListener('input', () => this.handleHSVChange());
      this.elements[key].addEventListener('change', () => this.handleHSVChange());
    });

    this.elements.inputHex.addEventListener('input', () => this.handleHexChange());
    this.elements.inputHex.addEventListener('change', () => this.handleHexChange());
    this.elements.inputA_hex.addEventListener('input', () => this.handleHexChange());
    this.elements.inputA_hex.addEventListener('change', () => this.handleHexChange());

    document.addEventListener('click', (e) => {
      if (this.isOpen &&
          !this.elements.menu.contains(e.target) &&
          !this.elements.openBtn.contains(e.target)) {
        this.close();
      }
    });
  }

  /**
   * Toggles the menu visibility.
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Opens the menu.
   */
  open() {
    this.elements.menu.style.display = 'block';
    this.isOpen = true;
  }

  /**
   * Closes the menu.
   */
  close() {
    this.elements.menu.style.display = 'none';
    this.isOpen = false;
  }

  /**
   * Switches the input mode (RGB, HSV, or HEX).
   * @param {string} mode - The mode to switch to
   */
  switchMode(mode) {
    this.currentMode = mode;

    this.elements.tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });

    this.elements.rgbMode.style.display = mode === 'rgb' ? 'flex' : 'none';
    this.elements.hsvMode.style.display = mode === 'hsv' ? 'flex' : 'none';
    this.elements.hexMode.style.display = mode === 'hex' ? 'flex' : 'none';
  }

  /**
   * Handles changes to RGB input fields.
   */
  handleRGBChange() {
    const r = this.clamp(parseInt(this.elements.inputR.value) || 0, 0, 255);
    const g = this.clamp(parseInt(this.elements.inputG.value) || 0, 0, 255);
    const b = this.clamp(parseInt(this.elements.inputB.value) || 0, 0, 255);
    const a = this.clamp(parseInt(this.elements.inputA.value) || 100, 0, 100) / 100;

    this.elements.inputR.value = r;
    this.elements.inputG.value = g;
    this.elements.inputB.value = b;
    this.elements.inputA.value = Math.round(a * 100);

    const hsv = this.rgbToHsv(r, g, b);
    this.elements.inputH.value = Math.round(hsv.h);
    this.elements.inputS.value = Math.round(hsv.s);
    this.elements.inputV.value = Math.round(hsv.v);
    this.elements.inputA_hsv.value = Math.round(a * 100);

    const hex = this.rgbToHex(r, g, b);
    this.elements.inputHex.value = hex;
    this.elements.inputA_hex.value = Math.round(a * 100);

    this.onColorChange([r, g, b, a]);
  }

  /**
   * Handles changes to HSV input fields.
   */
  handleHSVChange() {
    const h = this.clamp(parseInt(this.elements.inputH.value) || 0, 0, 360);
    const s = this.clamp(parseInt(this.elements.inputS.value) || 0, 0, 100);
    const v = this.clamp(parseInt(this.elements.inputV.value) || 0, 0, 100);
    const a = this.clamp(parseInt(this.elements.inputA_hsv.value) || 100, 0, 100) / 100;

    this.elements.inputH.value = h;
    this.elements.inputS.value = s;
    this.elements.inputV.value = v;
    this.elements.inputA_hsv.value = Math.round(a * 100);

    const rgb = this.hsvToRgb(h, s, v);

    this.elements.inputR.value = rgb.r;
    this.elements.inputG.value = rgb.g;
    this.elements.inputB.value = rgb.b;
    this.elements.inputA.value = Math.round(a * 100);

    const hex = this.rgbToHex(rgb.r, rgb.g, rgb.b);
    this.elements.inputHex.value = hex;
    this.elements.inputA_hex.value = Math.round(a * 100);

    this.onColorChange([rgb.r, rgb.g, rgb.b, a]);
  }

  /**
   * Handles changes to HEX input fields.
   */
  handleHexChange() {
    let hex = this.elements.inputHex.value.replace(/[^0-9A-Fa-f]/g, '');
    const a = this.clamp(parseInt(this.elements.inputA_hex.value) || 100, 0, 100) / 100;

    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }

    while (hex.length < 6) {
      hex = '0' + hex;
    }

    hex = hex.substring(0, 6);

    this.elements.inputHex.value = hex.toUpperCase();
    this.elements.inputA_hex.value = Math.round(a * 100);

    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    this.elements.inputR.value = r;
    this.elements.inputG.value = g;
    this.elements.inputB.value = b;
    this.elements.inputA.value = Math.round(a * 100);

    const hsv = this.rgbToHsv(r, g, b);
    this.elements.inputH.value = Math.round(hsv.h);
    this.elements.inputS.value = Math.round(hsv.s);
    this.elements.inputV.value = Math.round(hsv.v);
    this.elements.inputA_hsv.value = Math.round(a * 100);

    this.onColorChange([r, g, b, a]);
  }

  /**
   * Update the menu with a new color from an external source.
   * @param {Array} rgba - [r, g, b, a] where rgb is 0-255 and a is 0-1
   */
  updateColor(rgba) {
    const [r, g, b, a] = rgba;

    this.elements.inputR.value = Math.round(r);
    this.elements.inputG.value = Math.round(g);
    this.elements.inputB.value = Math.round(b);
    this.elements.inputA.value = Math.round(a * 100);

    const hsv = this.rgbToHsv(r, g, b);
    this.elements.inputH.value = Math.round(hsv.h);
    this.elements.inputS.value = Math.round(hsv.s);
    this.elements.inputV.value = Math.round(hsv.v);
    this.elements.inputA_hsv.value = Math.round(a * 100);

    const hex = this.rgbToHex(Math.round(r), Math.round(g), Math.round(b));
    this.elements.inputHex.value = hex;
    this.elements.inputA_hex.value = Math.round(a * 100);
  }

  /**
   * Convert RGB to HSV.
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @returns {Object} {h: 0-360, s: 0-100, v: 0-100}
   */
  rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    let s = max === 0 ? 0 : (delta / max);
    let v = max;

    if (delta !== 0) {
      if (max === r) {
        h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
      } else if (max === g) {
        h = ((b - r) / delta + 2) / 6;
      } else {
        h = ((r - g) / delta + 4) / 6;
      }
    }

    return {
      h: h * 360,
      s: s * 100,
      v: v * 100
    };
  }

  /**
   * Convert HSV to RGB.
   * @param {number} h - Hue (0-360)
   * @param {number} s - Saturation (0-100)
   * @param {number} v - Value (0-100)
   * @returns {Object} {r: 0-255, g: 0-255, b: 0-255}
   */
  hsvToRgb(h, s, v) {
    h /= 360;
    s /= 100;
    v /= 100;

    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
    };
  }

  /**
   * Clamps a value between min and max.
   * @param {number} value - Input value
   * @param {number} min - Minimum limit
   * @param {number} max - Maximum limit
   * @returns {number} - Clamped value
   */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Convert RGB to HEX.
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @returns {string} Hex color code (without #)
   */
  rgbToHex(r, g, b) {
    return [r, g, b]
      .map(x => {
        const hex = x.toString(16).toUpperCase();
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('');
  }
}
