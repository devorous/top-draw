/**
 * @fileoverview Svelte stores for global application state.
 * Centralizes state management for reactive UI updates.
 */

import { writable, derived, get } from 'svelte/store';

// ============================================================================
// Tool & Drawing State
// ============================================================================

/** Current active tool */
export const currentTool = writable('brush');

/** Current drawing color [r, g, b, a] */
export const currentColor = writable([0, 0, 0, 255]);

/** Current brush/pen size */
export const currentSize = writable(10);

/** Current pressure sensitivity */
export const currentPressure = writable(1.0);

/** Pressure sensitivity enabled/disabled */
export const pressureEnabled = writable(true);

/** Current blend mode */
export const blendMode = writable('source-over');

// ============================================================================
// Layer State
// ============================================================================

/** Active layer index */
export const activeLayer = writable(2); // Default to layer 2 (top)

/** Layer visibility map: { layerIndex: boolean } */
export const layerVisibility = writable({
  0: true,
  1: true,
  2: true
});

/** Layer manager reference (set by App) */
export const layerManager = writable(null);

// ============================================================================
// User State
// ============================================================================

/** Map of all connected users (sessionIndex -> User) */
export const users = writable(new Map());

/** Self user data */
export const self = writable(null);

/** Current session index */
export const sessionIndex = writable(null);

/** Current user role (0-8) */
export const selfRole = writable(0);

/** Current username */
export const username = writable('');

// ============================================================================
// Room State
// ============================================================================

/** Current room ID */
export const currentRoomId = writable(null);

/** Current room data (settings, description, etc.) */
export const currentRoomData = writable(null);

/** WebSocket connection status */
export const connected = writable(false);

// ============================================================================
// Chat State
// ============================================================================

/** Unread chat message count */
export const chatUnreadCount = writable(0);

/** Chat visibility */
export const chatVisible = writable(false);

/** DM recipient (null for global chat) */
export const dmRecipient = writable(null);

// ============================================================================
// Color Palette State
// ============================================================================

/** Recent colors array [[r,g,b,a], ...] */
export const recentColors = writable([]);

/** Custom saved colors array [[r,g,b,a], ...] */
export const customColors = writable([]);

// ============================================================================
// UI State
// ============================================================================

/** Board menu panel visibility (blend mode, layers) */
export const boardMenuOpen = writable(null); // null | 'blend' | 'layers'

/** Profile dialog state */
export const profileDialogState = writable({
  visible: false,
  username: null,
  data: null,
  loading: false,
  error: null
});

/** Room settings dialog visibility */
export const roomSettingsVisible = writable(false);

/** Color palette visibility */
export const colorPaletteVisible = writable(true);

// ============================================================================
// Derived Stores
// ============================================================================

/** Formatted current color as rgba() string */
export const currentColorRgba = derived(
  currentColor,
  $color => `rgba(${$color[0]}, ${$color[1]}, ${$color[2]}, ${$color[3] / 255})`
);

/** Formatted current color as hex string */
export const currentColorHex = derived(
  currentColor,
  $color => {
    const r = $color[0].toString(16).padStart(2, '0');
    const g = $color[1].toString(16).padStart(2, '0');
    const b = $color[2].toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
);

/** User count (excluding self) */
export const userCount = derived(
  users,
  $users => $users.size
);

/** Is current user moderator or higher (role >= 4) */
export const isModerator = derived(
  selfRole,
  $role => $role >= 4
);

// ============================================================================
// Store Helpers
// ============================================================================

/**
 * Toggle layer visibility
 * @param {number} layerIndex - Layer index to toggle
 */
export function toggleLayerVisibility(layerIndex) {
  layerVisibility.update(vis => ({
    ...vis,
    [layerIndex]: !vis[layerIndex]
  }));
}

/**
 * Set active layer and update visibility
 * @param {number} layerIndex - Layer index to activate
 */
export function setActiveLayer(layerIndex) {
  activeLayer.set(layerIndex);
}

/**
 * Update user in users map
 * @param {number} userId - Session index
 * @param {Object} userData - User data
 */
export function updateUser(userId, userData) {
  users.update(u => {
    const newMap = new Map(u);
    newMap.set(userId, userData);
    return newMap;
  });
}

/**
 * Remove user from users map
 * @param {number} userId - Session index
 */
export function removeUser(userId) {
  users.update(u => {
    const newMap = new Map(u);
    newMap.delete(userId);
    return newMap;
  });
}

/**
 * Add recent color (dedupe and limit)
 * @param {Array} color - [r, g, b, a]
 */
export function addRecentColor(color) {
  recentColors.update(colors => {
    const filtered = colors.filter(c =>
      !(c[0] === color[0] && c[1] === color[1] && c[2] === color[2] && c[3] === color[3])
    );
    return [[...color], ...filtered].slice(0, 6);
  });
}

/**
 * Add custom color
 * @param {Array} color - [r, g, b, a]
 */
export function addCustomColor(color) {
  customColors.update(colors => {
    const exists = colors.some(c =>
      c[0] === color[0] && c[1] === color[1] && c[2] === color[2] && c[3] === color[3]
    );
    if (exists || colors.length >= 12) return colors;
    return [...colors, [...color]];
  });
}

/**
 * Remove custom color
 * @param {Array} color - [r, g, b, a]
 */
export function removeCustomColor(color) {
  customColors.update(colors =>
    colors.filter(c =>
      !(c[0] === color[0] && c[1] === color[1] && c[2] === color[2] && c[3] === color[3])
    )
  );
}
