/** @fileoverview Provides validation and sanitization rules for incoming client messages to ensure data integrity and security. */

import { T, Tool } from '../shared/MessageTypes.js';

/**
 * Clamps a numeric value between a minimum and maximum range.
 * @param {number} num - The value to clamp.
 * @param {number} min - The minimum allowed value.
 * @param {number} max - The maximum allowed value.
 * @returns {number} - The clamped value.
 */
const clamp = (num, min, max) => {
  if (num === undefined || num === null || isNaN(num)) return min;
  return Math.min(Math.max(num, min), max);
};

/**
 * Sanitizes a string by optionally trimming and limiting its length.
 * @param {string} str - The string to sanitize.
 * @param {number} maxLength - The maximum allowed length.
 * @param {boolean} [shouldTrim=true] - Whether to trim leading/trailing whitespace.
 * @returns {string} - The sanitized string.
 */
const sanitizeString = (str, maxLength, shouldTrim = true) => {
  if (typeof str !== 'string') return '';
  const val = shouldTrim ? str.trim() : str;
  return val.substring(0, maxLength);
};

/**
 * Validation rules for incoming message fields, mapped by message type.
 * Each rule is a function that returns a sanitized value for a specific field.
 * @type {Object<number, Object<string, function>>}
 */
export const VALIDATION_RULES = {
  [T.CS]: {
    s: (val) => clamp(val, 25, 10000)
  },
  [T.CSP]: {
    sp: (val) => clamp(val, 0, 2000)
  },
  [T.CSM]: {
    sm: (val) => clamp(val, 0, 50)
  },
  [T.CHD]: {
    hd: (val) => clamp(val, 0, 100)
  },
  [T.CBR]: {
    br: (val) => clamp(val, 0, 100)
  },
  [T.CP]: {
    p: (val) => clamp(val, 0, 100)
  },
  [T.CC]: {
    c: (val) => (typeof val === 'number' ? val : 0)
  },
  [T.CT]: {
    l: (val) => clamp(val, 0, Object.keys(Tool).length - 1)
  },
  [T.CL]: {
    ly: (val) => clamp(val, 0, 4)
  },
  [T.CN]: {
    n: (val) => sanitizeString(val, 20)
  },
  [T.MSG]: {
    g: (val) => sanitizeString(val, 500)
  },
  [T.DM]: {
    g: (val) => sanitizeString(val, 500)
  },
  [T.KP]: {
    k: (val) => sanitizeString(val, 20, false)
  },
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
    g: (val) => (typeof val === 'string' && val.length < 2 * 1024 * 1024 ? val : '')
  }
};

/**
 * Sanitizes a message object by applying validation rules based on its type.
 * @param {Object} data - The message data to sanitize.
 * @returns {Object} - A new object containing only sanitized fields.
 */
export function sanitizeMessage(data) {
  const rules = VALIDATION_RULES[data.t];
  if (!rules) return data;

  const sanitized = { ...data };
  for (const field in rules) {
    if (sanitized[field] !== undefined) {
      sanitized[field] = rules[field](sanitized[field]);
    }
  }
  return sanitized;
}
