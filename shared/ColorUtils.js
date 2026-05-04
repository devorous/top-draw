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
