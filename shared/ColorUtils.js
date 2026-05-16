/**
 * @fileoverview Shared color utilities — RGBA packing for protobuf,
 * hex/RGB/HSL conversion, and blending helpers used by client UI code.
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
 * Parse a "#RRGGBB" hex string into a [r, g, b] triple (0-255).
 * Accepts strings with or without the leading "#".
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

/**
 * Encode a (r, g, b) triple as "#RRGGBB". Values are clamped to 0-255.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/**
 * Convert RGB (0-255) to HSL where H is 0-360 and S/L are 0-100.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]}
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
 * Convert HSL (H 0-360, S/L 0-100) to RGB (0-255).
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {[number, number, number]}
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
 * Shift the lightness of a "#RRGGBB" color by `delta` (in HSL L percentage points).
 * Clamps to [0, 100].
 * @param {string} hex
 * @param {number} delta
 * @returns {string}
 */
export function shiftLightness(hex, delta) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return rgbToHex(...hslToRgb(h, s, Math.max(0, Math.min(100, l + delta))));
}

/**
 * Linear-blend two "#RRGGBB" colors in RGB space. `t` is 0 (hex1) to 1 (hex2).
 * @param {string} hex1
 * @param {string} hex2
 * @param {number} t
 * @returns {string}
 */
export function blendColors(hex1, hex2, t) {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
