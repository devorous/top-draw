/**
 * Centralized permission system for server-side action authorization.
 *
 * Role tiers (see SessionManager.js):
 *   Room-scoped: GUEST(0) USER(1) TRUSTED(2) HELPER(3) MOD(4) ADMIN(5)
 *   Global:      NOBLE(6) HOLY(7) DEITY(8)
 *
 * To reassign an action to a different tier, change the value in ACTION_MIN_ROLE.
 * To add a new action, add it to Action and ACTION_MIN_ROLE — no other changes needed.
 */

import { Role } from './SessionManager.js';

// ── Action identifiers ──────────────────────────────────────────────
export const Action = Object.freeze({
  // Board actions
  CLEAR_CANVAS:     'clear_canvas',

  // Moderation — room-scoped
  MOD_MUTE:         'mod_mute',         // HELPER+
  MOD_UNMUTE:       'mod_unmute',       // HELPER+
  MOD_UPDATE:       'mod_update_reason',// HELPER+
  MOD_KICK:         'mod_kick',         // MOD+
  MOD_BAN:          'mod_ban',          // MOD+
  MOD_UNBAN:        'mod_unban',        // MOD+
  MOD_WIPE:         'mod_wipe',         // MOD+
  MOD_LIST:         'mod_list',         // MOD+

  // Room management
  ROOM_UPDATE:      'room_update',      // ADMIN+ (or room owner, checked separately)

  // Room management
  ROOM_ROLE_SET:    'room_role_set',    // Room owner, room ADMIN(5)+, or DEITY(8)

  // Deity-exclusive abilities
  VIEW_REAL_IPS:    'view_real_ips',    // DEITY only — unobfuscated IPs in mod list
  PROMOTE_USER:     'promote_user',     // DEITY only — change another user's role
});

// ── Permission map ───────────────────────────────────────────────────
// Every action maps to the minimum Role value required.
// Global ranks (NOBLE+) inherit everything below them automatically.
const ACTION_MIN_ROLE = Object.freeze({
  [Action.CLEAR_CANVAS]:   Role.MOD,     // 4

  [Action.MOD_MUTE]:       Role.HELPER,  // 3
  [Action.MOD_UNMUTE]:     Role.HELPER,  // 3
  [Action.MOD_UPDATE]:     Role.HELPER,  // 3
  [Action.MOD_KICK]:       Role.MOD,     // 4
  [Action.MOD_BAN]:        Role.MOD,     // 4
  [Action.MOD_UNBAN]:      Role.MOD,     // 4
  [Action.MOD_WIPE]:       Role.MOD,     // 4
  [Action.MOD_LIST]:       Role.MOD,     // 4

  [Action.ROOM_UPDATE]:    Role.ADMIN,   // 5
  [Action.ROOM_ROLE_SET]:  Role.ADMIN,   // 5 (also allowed for room owner, checked separately)

  [Action.VIEW_REAL_IPS]:  Role.DEITY,   // 8
  [Action.PROMOTE_USER]:   Role.DEITY,   // 8
});

// ── Public API ──────────────────────────────────────────────────────

/**
 * Check whether a role level is allowed to perform an action.
 * @param {number} role - The user's role level (0–8).
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
 * @param {function} sendTo - sendTo(ws, payload) helper.
 * @param {number} T_MOD_RESULT - The MOD_RESULT message type constant.
 * @returns {boolean} true if the caller may proceed.
 */
export function authorize(ws, action, sendTo, T_MOD_RESULT) {
  if (canPerform(ws.userRole, action)) return true;
  sendTo(ws, { t: T_MOD_RESULT, a: false, authError: 'Insufficient permissions' });
  return false;
}
