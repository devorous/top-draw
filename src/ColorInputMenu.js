/**
 * Color Input Menu - Allows manual RGB/HSV color input
 */
export class ColorInputMenu {
  constructor(options = {}) {
    this.onColorChange = options.onColorChange || (() => {});
    this.currentMode = 'rgb'; // 'rgb', 'hsv', or 'hex'
    this.isOpen = false;
    this.elements = {};
  }

  init() {
    this.cacheElements();
    this.setupEventListeners();
  }

  cacheElements() {
    this.elements = {
      menu: document.getElementById('colorInputMenu'),
      openBtn: document.getElementById('colorInputBtn'),
      closeBtn: document.getElementById('colorInputClose'),
      tabs: document.querySelectorAll('.colorInputTab'),
      rgbMode: document.getElementById('rgbMode'),
      hsvMode: document.getElementById('hsvMode'),
      hexMode: document.getElementById('hexMode'),

      // RGB inputs
      inputR: document.getElementById('inputR'),
      inputG: document.getElementById('inputG'),
      inputB: document.getElementById('inputB'),
      inputA: document.getElementById('inputA'),

      // HSV inputs
      inputH: document.getElementById('inputH'),
      inputS: document.getElementById('inputS'),
      inputV: document.getElementById('inputV'),
      inputA_hsv: document.getElementById('inputA_hsv'),

      // HEX inputs
      inputHex: document.getElementById('inputHex'),
      inputA_hex: document.getElementById('inputA_hex')
    };
  }

  setupEventListeners() {
    // Open/close buttons
    this.elements.openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.elements.closeBtn.addEventListener('click', () => this.close());

    // Tab switching
    this.elements.tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        this.switchMode(mode);
      });
    });

    // RGB input changes
    ['inputR', 'inputG', 'inputB', 'inputA'].forEach(key => {
      this.elements[key].addEventListener('input', () => this.handleRGBChange());
      this.elements[key].addEventListener('change', () => this.handleRGBChange());
    });

    // HSV input changes
    ['inputH', 'inputS', 'inputV', 'inputA_hsv'].forEach(key => {
      this.elements[key].addEventListener('input', () => this.handleHSVChange());
      this.elements[key].addEventListener('change', () => this.handleHSVChange());
    });

    // HEX input changes
    this.elements.inputHex.addEventListener('input', () => this.handleHexChange());
    this.elements.inputHex.addEventListener('change', () => this.handleHexChange());
    this.elements.inputA_hex.addEventListener('input', () => this.handleHexChange());
    this.elements.inputA_hex.addEventListener('change', () => this.handleHexChange());

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this.isOpen &&
          !this.elements.menu.contains(e.target) &&
          !this.elements.openBtn.contains(e.target)) {
        this.close();
      }
    });
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.elements.menu.style.display = 'block';
    this.isOpen = true;
  }

  close() {
    this.elements.menu.style.display = 'none';
    this.isOpen = false;
  }

  switchMode(mode) {
    this.currentMode = mode;

    // Update tabs
    this.elements.tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });

    // Show/hide modes
    this.elements.rgbMode.style.display = mode === 'rgb' ? 'flex' : 'none';
    this.elements.hsvMode.style.display = mode === 'hsv' ? 'flex' : 'none';
    this.elements.hexMode.style.display = mode === 'hex' ? 'flex' : 'none';
  }

  handleRGBChange() {
    const r = this.clamp(parseInt(this.elements.inputR.value) || 0, 0, 255);
    const g = this.clamp(parseInt(this.elements.inputG.value) || 0, 0, 255);
    const b = this.clamp(parseInt(this.elements.inputB.value) || 0, 0, 255);
    const a = this.clamp(parseInt(this.elements.inputA.value) || 100, 0, 100) / 100;

    // Update input fields to clamped values
    this.elements.inputR.value = r;
    this.elements.inputG.value = g;
    this.elements.inputB.value = b;
    this.elements.inputA.value = Math.round(a * 100);

    // Update HSV fields
    const hsv = this.rgbToHsv(r, g, b);
    this.elements.inputH.value = Math.round(hsv.h);
    this.elements.inputS.value = Math.round(hsv.s);
    this.elements.inputV.value = Math.round(hsv.v);
    this.elements.inputA_hsv.value = Math.round(a * 100);

    // Update HEX fields
    const hex = this.rgbToHex(r, g, b);
    this.elements.inputHex.value = hex;
    this.elements.inputA_hex.value = Math.round(a * 100);

    // Trigger callback
    this.onColorChange([r, g, b, a]);
  }

  handleHSVChange() {
    const h = this.clamp(parseInt(this.elements.inputH.value) || 0, 0, 360);
    const s = this.clamp(parseInt(this.elements.inputS.value) || 0, 0, 100);
    const v = this.clamp(parseInt(this.elements.inputV.value) || 0, 0, 100);
    const a = this.clamp(parseInt(this.elements.inputA_hsv.value) || 100, 0, 100) / 100;

    // Update input fields to clamped values
    this.elements.inputH.value = h;
    this.elements.inputS.value = s;
    this.elements.inputV.value = v;
    this.elements.inputA_hsv.value = Math.round(a * 100);

    // Convert to RGB
    const rgb = this.hsvToRgb(h, s, v);

    // Update RGB fields
    this.elements.inputR.value = rgb.r;
    this.elements.inputG.value = rgb.g;
    this.elements.inputB.value = rgb.b;
    this.elements.inputA.value = Math.round(a * 100);

    // Update HEX fields
    const hex = this.rgbToHex(rgb.r, rgb.g, rgb.b);
    this.elements.inputHex.value = hex;
    this.elements.inputA_hex.value = Math.round(a * 100);

    // Trigger callback
    this.onColorChange([rgb.r, rgb.g, rgb.b, a]);
  }

  handleHexChange() {
    let hex = this.elements.inputHex.value.replace(/[^0-9A-Fa-f]/g, '');
    const a = this.clamp(parseInt(this.elements.inputA_hex.value) || 100, 0, 100) / 100;

    // Handle 3-digit hex shorthand (e.g., #RGB -> #RRGGBB)
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }

    // Pad with zeros if needed
    while (hex.length < 6) {
      hex = '0' + hex;
    }

    // Truncate if too long
    hex = hex.substring(0, 6);

    // Update input field to cleaned value
    this.elements.inputHex.value = hex.toUpperCase();
    this.elements.inputA_hex.value = Math.round(a * 100);

    // Parse hex to RGB
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);

    // Update RGB fields
    this.elements.inputR.value = r;
    this.elements.inputG.value = g;
    this.elements.inputB.value = b;
    this.elements.inputA.value = Math.round(a * 100);

    // Update HSV fields
    const hsv = this.rgbToHsv(r, g, b);
    this.elements.inputH.value = Math.round(hsv.h);
    this.elements.inputS.value = Math.round(hsv.s);
    this.elements.inputV.value = Math.round(hsv.v);
    this.elements.inputA_hsv.value = Math.round(a * 100);

    // Trigger callback
    this.onColorChange([r, g, b, a]);
  }

  /**
   * Update the menu with a new color (from external source like color picker)
   * @param {Array} rgba - [r, g, b, a] where rgb is 0-255 and a is 0-1
   */
  updateColor(rgba) {
    const [r, g, b, a] = rgba;

    // Update RGB fields
    this.elements.inputR.value = Math.round(r);
    this.elements.inputG.value = Math.round(g);
    this.elements.inputB.value = Math.round(b);
    this.elements.inputA.value = Math.round(a * 100);

    // Update HSV fields
    const hsv = this.rgbToHsv(r, g, b);
    this.elements.inputH.value = Math.round(hsv.h);
    this.elements.inputS.value = Math.round(hsv.s);
    this.elements.inputV.value = Math.round(hsv.v);
    this.elements.inputA_hsv.value = Math.round(a * 100);

    // Update HEX fields
    const hex = this.rgbToHex(Math.round(r), Math.round(g), Math.round(b));
    this.elements.inputHex.value = hex;
    this.elements.inputA_hex.value = Math.round(a * 100);
  }

  /**
   * Convert RGB to HSV
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
   * Convert HSV to RGB
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

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Convert RGB to HEX
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
