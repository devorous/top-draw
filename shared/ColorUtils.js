/**
 * @fileoverview Shared color packing/unpacking utilities
 * Used by both client and server for RGBA color encoding in protobuf
 */

/**
 * Pack RGBA array to fixed32 for protobuf
 * Note: RGB values are 0-255, but alpha is 0-1 (from color picker)
 * @param {number[]} rgba - Array of [r, g, b, a] where rgb is 0-255 and a is 0-1
 * @returns {number} Packed 32-bit color value
 */
export function packColor(rgba) {
  if (!rgba || rgba.length < 4) return 0xFF000000;
  const alpha = Math.round(rgba[3] * 255);
  return ((rgba[0] & 0xFF) << 24) | ((rgba[1] & 0xFF) << 16) |
         ((rgba[2] & 0xFF) << 8) | (alpha & 0xFF);
}

/**
 * Unpack fixed32 to RGBA array
 * Note: Returns alpha as 0-1 (app expects this format)
 * @param {number} packed - Packed 32-bit color value
 * @returns {number[]} Array of [r, g, b, a] where rgb is 0-255 and a is 0-1
 */
export function unpackColor(packed) {
  return [
    (packed >>> 24) & 0xFF,
    (packed >>> 16) & 0xFF,
    (packed >>> 8) & 0xFF,
    ((packed & 0xFF) / 255)
  ];
}

/**
 * Converts a hex color string to an RGB array.
 * @param {string} hex - Hex color string (e.g., "#ffffff" or "ffffff")
 * @returns {number[]} [r, g, b] where each is 0-255
 */
export function hexToRgb(hex) {
  const c = hex.replace('#', '');
  if (c.length === 3) {
    return [
      parseInt(c.slice(0, 1).repeat(2), 16),
      parseInt(c.slice(1, 2).repeat(2), 16),
      parseInt(c.slice(2, 3).repeat(2), 16)
    ];
  }
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

/**
 * Converts RGB values to a hex color string.
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} Hex color string (e.g., "#ffffff")
 */
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/**
 * Converts RGB values to HSL array.
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {number[]} [h (0-360), s (0-100), l (0-100)]
 */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6 * 360, s * 100, l * 100];
}

/**
 * Converts HSL values to RGB array.
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-100)
 * @param {number} l - Lightness (0-100)
 * @returns {number[]} [r, g, b] where each is 0-255
 */
export function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2 = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2(h + 1 / 3) * 255, hue2(h) * 255, hue2(h - 1 / 3) * 255];
}

/**
 * Shifts the lightness of a hex color.
 * @param {string} hex - Hex color string
 * @param {number} delta - Lightness delta (-100 to 100)
 * @returns {string} New hex color string
 */
export function shiftL(hex, delta) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return rgbToHex(...hslToRgb(h, s, Math.max(0, Math.min(100, l + delta))));
}

/**
 * Blends two hex colors.
 * @param {string} hex1 - First hex color
 * @param {string} hex2 - Second hex color
 * @param {number} t - Blend factor (0-1)
 * @returns {string} Blended hex color
 */
export function blend(hex1, hex2, t) {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
