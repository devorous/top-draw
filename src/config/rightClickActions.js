/**
 * @fileoverview Per-tool right-click action registry.
 *
 * Right-click used to be hardcoded: the `contextmenu` handler cancelled the
 * in-progress stroke while right-drag zoomed around the click point. Both
 * behaviours are now selectable per tool, so a tool can trade the zoom drag
 * for something it actually cares about (Select flips lasso/rectangle).
 */

/** Action ids in the order they should appear in the dropdown. */
export const RIGHT_CLICK_ACTIONS = Object.freeze([
  { id: 'cancel', label: 'Cancel Stroke' },
  { id: 'selectionMode', label: 'Toggle Selection Mode' },
  { id: 'layerMode', label: 'Toggle Layer Mode' },
  { id: 'eyedropper', label: 'Pick Colour' },
  { id: 'zoom', label: 'Zoom Drag' },
  { id: 'none', label: 'Nothing' }
]);

const ACTION_IDS = new Set(RIGHT_CLICK_ACTIONS.map(a => a.id));

/** Actions offered to any painting tool that has no entry below. */
const STROKE_TOOL_ACTIONS = ['cancel', 'eyedropper', 'zoom', 'none'];

/** Tools whose right-click options differ from the painting-tool default. */
const TOOL_CONFIG = Object.freeze({
  // Select: lasso/rect is the toggle reached for most, with layer mode next.
  select: { default: 'selectionMode', actions: ['selectionMode', 'layerMode', 'cancel', 'eyedropper', 'zoom', 'none'] },
  // Eraser has a layer mode too, but cancelling a bad erase matters more.
  erase: { default: 'cancel', actions: ['cancel', 'layerMode', 'eyedropper', 'zoom', 'none'] },

  // Tools with no stroke to cancel keep the old right-drag zoom.
  fill: { default: 'zoom', actions: ['zoom', 'eyedropper', 'none'] },
  inkdropper: { default: 'zoom', actions: ['zoom', 'none'] },
  pan: { default: 'zoom', actions: ['zoom', 'none'] },
  zoom: { default: 'zoom', actions: ['zoom', 'none'] },
  rotate: { default: 'zoom', actions: ['zoom', 'none'] }
});

/**
 * Action ids valid for a tool, in dropdown order.
 * @param {string} tool - Tool name.
 * @returns {string[]}
 */
export function getRightClickActionsForTool(tool) {
  return TOOL_CONFIG[tool]?.actions ?? STROKE_TOOL_ACTIONS;
}

/**
 * The out-of-the-box action for a tool.
 * @param {string} tool - Tool name.
 * @returns {string}
 */
export function getDefaultRightClickAction(tool) {
  return TOOL_CONFIG[tool]?.default ?? 'cancel';
}

/**
 * Resolves the stored preference for a tool, falling back to the default when
 * the stored value is unknown or not offered for that tool.
 * @param {Object|null|undefined} prefs - Map of tool name to action id.
 * @param {string} tool - Tool name.
 * @returns {string}
 */
export function resolveRightClickAction(prefs, tool) {
  const stored = prefs?.[tool];
  if (stored && ACTION_IDS.has(stored) && getRightClickActionsForTool(tool).includes(stored)) {
    return stored;
  }
  return getDefaultRightClickAction(tool);
}

/**
 * Drops unknown tools/actions from a persisted preference map.
 * @param {Object} raw - Untrusted stored map.
 * @returns {Object} Sanitized map (only entries that differ from the default).
 */
export function sanitizeRightClickActions(raw) {
  const sanitized = {};
  if (!raw || typeof raw !== 'object') return sanitized;

  for (const [tool, action] of Object.entries(raw)) {
    if (typeof tool !== 'string' || typeof action !== 'string') continue;
    if (!ACTION_IDS.has(action)) continue;
    if (!getRightClickActionsForTool(tool).includes(action)) continue;
    if (action === getDefaultRightClickAction(tool)) continue;
    sanitized[tool] = action;
  }

  return sanitized;
}

/**
 * Label for an action id.
 * @param {string} actionId
 * @returns {string}
 */
export function getRightClickActionLabel(actionId) {
  return RIGHT_CLICK_ACTIONS.find(a => a.id === actionId)?.label ?? actionId;
}
