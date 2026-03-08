import { T, Tool } from '../shared/MessageTypes.js';

/**
 * Clamps a number between min and max inclusive.
 */
const clamp = (num, min, max) => {
  if (num === undefined || num === null || isNaN(num)) return min;
  return Math.min(Math.max(num, min), max);
};

/**
 * Sanitizes a string, trimming it (optional) and limiting its length.
 */
const sanitizeString = (str, maxLength, shouldTrim = true) => {
  if (typeof str !== 'string') return '';
  const val = shouldTrim ? str.trim() : str;
  return val.substring(0, maxLength);
};

/**
 * Validation rules for incoming message fields.
 * Each rule returns a sanitized value for the field.
 */
export const VALIDATION_RULES = {
  // === Tool Settings ===
  [T.CS]: { // Change Size (s: size * 100)
    s: (val) => clamp(val, 25, 10000) // 0.25 to 100.0
  },
  [T.CSP]: { // Change Spacing (sp: spacing * 100)
    sp: (val) => clamp(val, 0, 2000) // 0 to 20.0
  },
  [T.CSM]: { // Change Smoothing (sm: 0-50 integer)
    sm: (val) => clamp(val, 0, 50)
  },
  [T.CHD]: { // Change Hardness (hd: 0-100 integer)
    hd: (val) => clamp(val, 0, 100)
  },
  [T.CBR]: { // Change Blur Radius (br: 0-100 integer)
    br: (val) => clamp(val, 0, 100)
  },
  [T.CP]: { // Change Pressure (p: pressure * 100)
    p: (val) => clamp(val, 0, 100) // 0 to 1.0
  },
  [T.CC]: { // Change Color (c: packed uint32)
    // No easy range check for packed color, but ensure it's a number
    c: (val) => (typeof val === 'number' ? val : 0)
  },
  [T.CT]: { // Change Tool (l: Tool enum)
    l: (val) => clamp(val, 0, Object.keys(Tool).length - 1)
  },
  [T.CL]: { // Change Layer (ly: 0-4)
    ly: (val) => clamp(val, 0, 4)
  },

  // === User Identity ===
  [T.CN]: { // Change Name
    n: (val) => sanitizeString(val, 20)
  },

  // === Chat & Text ===
  [T.MSG]: { // Public Chat Message
    g: (val) => sanitizeString(val, 500)
  },
  [T.DM]: { // Direct Message
    g: (val) => sanitizeString(val, 500)
  },
  [T.KP]: { // Key Press (for text tool sync)
    // Keys can be multi-char (e.g. 'Backspace', 'Enter') or single-char
    // Do NOT trim key presses, as a space is a valid key press.
    k: (val) => sanitizeString(val, 20, false)
  },

  // === Selection & Images ===
  [T.SEL_LIFT]: {
    sx: (val) => clamp(val, -10000, 20000),
    sy: (val) => clamp(val, -10000, 20000),
    sw: (val) => clamp(val, 0, 10000),
    sh: (val) => clamp(val, 0, 10000)
  },
  [T.IMG_PASTE]: {
    sx: (val) => clamp(val, -10000, 20000),
    sy: (val) => clamp(val, -10000, 20000),
    sw: (val) => clamp(val, 0, 10000),
    sh: (val) => clamp(val, 0, 10000),
    g: (val) => (typeof val === 'string' && val.length < 2 * 1024 * 1024 ? val : '') // 2MB limit
  }
};

/**
 * Sanitizes a message object based on its type (t).
 * Returns a new object with only validated/sanitized fields.
 */
export function sanitizeMessage(data) {
  const rules = VALIDATION_RULES[data.t];
  if (!rules) return data; // No rules for this type, return as-is

  const sanitized = { ...data };
  for (const field in rules) {
    if (sanitized[field] !== undefined) {
      sanitized[field] = rules[field](sanitized[field]);
    }
  }
  return sanitized;
}
