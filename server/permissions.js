/**
 * Centralized permission system for server-side action authorization.
 *
 * Actions are grouped into tiers. Each tier has a minimum role level.
 * To add a new tier or reassign an action, edit the constants below.
 *
 * Role levels (from SessionManager.js):
 *   GUEST: 0, USER: 1, MOD: 2, ADMIN: 3
 */

import { Role } from './SessionManager.js';

// ── Action identifiers ──────────────────────────────────────────────
export const Action = Object.freeze({
  // Board actions
  CLEAR_CANVAS:   'clear_canvas',

  // Moderation actions
  MOD_KICK:       'mod_kick',
  MOD_MUTE:       'mod_mute',
  MOD_BAN:        'mod_ban',
  MOD_UNMUTE:     'mod_unmute',
  MOD_UNBAN:      'mod_unban',
  MOD_UPDATE:     'mod_update_reason',
  MOD_WIPE:       'mod_wipe',
  MOD_LIST:       'mod_list',

  // Room management
  ROOM_UPDATE:    'room_update',
});

// ── Permission tiers ────────────────────────────────────────────────
// Maps each action to the minimum Role required.
// To create a new tier (e.g. HELPER between USER and MOD), add it to
// the Role enum and slot actions here — no other code changes needed.
const ACTION_MIN_ROLE = Object.freeze({
  [Action.CLEAR_CANVAS]:   Role.MOD,

  [Action.MOD_KICK]:       Role.MOD,
  [Action.MOD_MUTE]:       Role.MOD,
  [Action.MOD_BAN]:        Role.MOD,
  [Action.MOD_UNMUTE]:     Role.MOD,
  [Action.MOD_UNBAN]:      Role.MOD,
  [Action.MOD_UPDATE]:     Role.MOD,
  [Action.MOD_WIPE]:       Role.MOD,
  [Action.MOD_LIST]:       Role.MOD,

  [Action.ROOM_UPDATE]:    Role.USER,
});

// ── Public API ──────────────────────────────────────────────────────

/**
 * Check whether a role is allowed to perform an action.
 * @param {number} role - The user's role level.
 * @param {string} action - An Action constant.
 * @returns {boolean}
 */
export function canPerform(role, action) {
  const minRole = ACTION_MIN_ROLE[action];
  if (minRole === undefined) return false;   // unknown action → deny
  return role >= minRole;
}

/**
 * Convenience: check permission and, if denied, send a MOD_RESULT
 * error back to the client. Returns true if authorized.
 * @param {Object} ws - The WebSocket connection (must have .userRole).
 * @param {string} action - An Action constant.
 * @param {function} sendTo - The sendTo(ws, payload) helper.
 * @param {number} T_MOD_RESULT - The MOD_RESULT message type constant.
 * @returns {boolean} true if the caller may proceed.
 */
export function authorize(ws, action, sendTo, T_MOD_RESULT) {
  if (canPerform(ws.userRole, action)) return true;
  sendTo(ws, { t: T_MOD_RESULT, a: false, authError: 'Insufficient permissions' });
  return false;
}
