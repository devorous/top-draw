import { getDefaultKeybindings, KEYBIND_ACTIONS_BY_ID } from '../input/keybinds/KeybindRegistry.js';
import { normalizeBinding } from '../input/keybinds/KeybindMatcher.js';
import { sanitizeRightClickActions } from './rightClickActions.js';

export const APP_PREFERENCES_STORAGE_KEY = 'topDrawAppPreferences';
const APP_PREFERENCES_VERSION = 15;
const SIDEBAR_SIDES = new Set(['left', 'right']);
export const LOW_POWER_MODES = new Set(['auto', 'on', 'off']);
// The 3 base colors from which all theme CSS variables are derived.
// Empty string means "use the CSS default".
export const THEME_BASE_COLORS = {
  bg: '#1a1d23',
  accent: '#00d4aa',
  text: '#f0f2f5'
};
export const DEFAULT_SFX_PREFERENCES = Object.freeze({
  volume: 0.7,
  chat: true,
  staff: true,
  inbox: true
});
export const DEFAULT_REPLAY_PREFERENCES = Object.freeze({
  manualSnapshotIntervalMs: 30_000,
  manualMaxLengthMs: 0,
  rollingEnabled: true,
  rollingWindowMs: 120_000
});

export function createDefaultAppPreferences() {
  return {
    version: APP_PREFERENCES_VERSION,
    general: {
      sidebarSide: 'right',
      sidebarWidth: 200,
      toolsWidth: 48,
      themeColors: {},
      localBoardBackgroundColor: null,
      localBoardBackgroundEnabled: true,
      hideOwnLabelAbove150: false,
      showRawPixelsAtHighZoom: true,
      useDesynchronizedBoardContexts: false,
      lowPowerMode: 'auto',
      // Master kill-switch for the always-on background capture systems (rolling
      // DVR tape, gallery time-lapse stills, parity heartbeat). None of them are
      // needed to draw; on a weak machine their periodic full-board work is felt
      // as a stutter, so this lets a user trade the features away for smoothness.
      reduceBackgroundWork: false,
      scrollToZoom: false,
      showFloatingArt: true,
      galleryTimelapseEnabled: true,
      chatOpacity: 0.95,
      // Tool name -> right-click action id; only non-default choices are stored.
      rightClickActions: {},
      sfx: { ...DEFAULT_SFX_PREFERENCES },
      replay: { ...DEFAULT_REPLAY_PREFERENCES }
    },
    keybinds: getDefaultKeybindings()
  };
}

function sanitizeBindingSlot(binding, fallback = null) {
  if (binding === null) return null;
  const normalized = normalizeBinding(binding);
  return normalized ?? fallback;
}

function sanitizeKeybinds(rawKeybinds) {
  const defaults = getDefaultKeybindings();
  const sanitized = {};

  for (const actionId of Object.keys(defaults)) {
    const rawBinding = rawKeybinds?.[actionId];

    if (rawBinding && typeof rawBinding === 'object') {
      const primary = sanitizeBindingSlot(rawBinding.primary, defaults[actionId].primary);
      let secondary = sanitizeBindingSlot(rawBinding.secondary, null);
      if (secondary && secondary === primary) {
        secondary = null;
      }

      sanitized[actionId] = {
        primary,
        secondary
      };
      continue;
    }

    sanitized[actionId] = {
      primary: sanitizeBindingSlot(rawBinding, defaults[actionId].primary),
      secondary: null
    };
  }

  return sanitized;
}

function sanitizeThemeColors(rawThemeColors) {
  const sanitized = {};
  const source = rawThemeColors && typeof rawThemeColors === 'object' ? rawThemeColors : {};

  for (const key of ['bg', 'accent', 'text']) {
    const value = source[key];
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())) {
      sanitized[key] = value.trim().toLowerCase();
    }
  }

  return sanitized;
}

function sanitizeOptionalHexColor(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const value = rawValue.trim();
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return value.toLowerCase();
}

/**
 * Low power mode is tri-state: 'auto' resolves against detectLowPowerDevice()
 * at apply time, 'on'/'off' are explicit overrides.
 *
 * It was a boolean defaulting to false, which made the device detection dead
 * code — App._applyLowPowerPreference() read the preference and overwrote
 * whatever detection had decided, so a machine that scored as low power still
 * ran at 60 TPS and, worse, stayed eligible for uploader duty (scoreProvider
 * returns -Infinity for lowPowerMode clients). Booleans are still accepted so
 * older stored preferences and any external writer keep working.
 */
function sanitizeLowPowerMode(rawMode) {
  if (rawMode === true) return 'on';
  if (rawMode === false) return 'off';
  if (typeof rawMode !== 'string') return 'auto';
  const normalized = rawMode.trim().toLowerCase();
  return LOW_POWER_MODES.has(normalized) ? normalized : 'auto';
}

function sanitizeSidebarSide(rawSidebarSide) {
  if (typeof rawSidebarSide !== 'string') return 'right';
  const normalized = rawSidebarSide.trim().toLowerCase();
  return SIDEBAR_SIDES.has(normalized) ? normalized : 'right';
}

function sanitizeSidebarWidth(rawWidth) {
  const width = parseInt(rawWidth, 10);
  return isNaN(width) ? 200 : Math.min(Math.max(width, 160), 400);
}

function sanitizeToolsWidth(rawWidth) {
  const width = parseInt(rawWidth, 10);
  return isNaN(width) ? 48 : Math.min(Math.max(width, 32), 64);
}

function sanitizeChatOpacity(rawOpacity) {
  const value = Number(rawOpacity);
  if (!Number.isFinite(value)) return 0.95;
  return Math.min(1, Math.max(0.3, value));
}

function sanitizeSfxVolume(rawVolume) {
  const value = Number(rawVolume);
  if (!Number.isFinite(value)) return DEFAULT_SFX_PREFERENCES.volume;
  return Math.min(1, Math.max(0, value));
}

function sanitizeSfx(rawSfx) {
  const source = rawSfx && typeof rawSfx === 'object' ? rawSfx : {};
  return {
    volume: sanitizeSfxVolume(source.volume),
    chat: source.chat !== undefined ? !!source.chat : DEFAULT_SFX_PREFERENCES.chat,
    staff: source.staff !== undefined ? !!source.staff : DEFAULT_SFX_PREFERENCES.staff,
    inbox: source.inbox !== undefined ? !!source.inbox : DEFAULT_SFX_PREFERENCES.inbox
  };
}

function sanitizeOptionMs(rawValue, allowedValues, fallback) {
  const value = Number(rawValue);
  return allowedValues.includes(value) ? value : fallback;
}

function sanitizeReplay(rawReplay) {
  const source = rawReplay && typeof rawReplay === 'object' ? rawReplay : {};
  return {
    manualSnapshotIntervalMs: sanitizeOptionMs(
      source.manualSnapshotIntervalMs,
      [30_000, 60_000, 120_000, 300_000],
      DEFAULT_REPLAY_PREFERENCES.manualSnapshotIntervalMs
    ),
    manualMaxLengthMs: sanitizeOptionMs(
      source.manualMaxLengthMs,
      [0, 120_000, 300_000, 600_000, 1_800_000, 3_600_000],
      DEFAULT_REPLAY_PREFERENCES.manualMaxLengthMs
    ),
    rollingEnabled: source.rollingEnabled !== undefined
      ? !!source.rollingEnabled
      : DEFAULT_REPLAY_PREFERENCES.rollingEnabled,
    rollingWindowMs: sanitizeOptionMs(
      source.rollingWindowMs,
      [30_000, 60_000, 120_000, 300_000, 600_000],
      DEFAULT_REPLAY_PREFERENCES.rollingWindowMs
    )
  };
}

function sanitizePreferences(rawPreferences) {
  const defaults = createDefaultAppPreferences();
  const parsed = rawPreferences && typeof rawPreferences === 'object' ? rawPreferences : {};
  const parsedVersion = Number(parsed.version) || 0;
  const migratedKeybinds = parsed.keybinds && typeof parsed.keybinds === 'object'
    ? JSON.parse(JSON.stringify(parsed.keybinds))
    : parsed.keybinds;

  if (parsedVersion < 2 && migratedKeybinds?.['tool.swapColors']) {
    const binding = migratedKeybinds['tool.swapColors'];
    if (binding && typeof binding === 'object') {
      if (binding.primary === 'Ctrl+Space') binding.primary = 'Shift+Space';
      if (binding.secondary === 'Ctrl+Space') binding.secondary = 'Shift+Space';
    } else if (binding === 'Ctrl+Space') {
      migratedKeybinds['tool.swapColors'] = 'Shift+Space';
    }
  }

  if (parsedVersion < 3 && migratedKeybinds?.['tool.swapColors']) {
    const binding = migratedKeybinds['tool.swapColors'];
    if (binding && typeof binding === 'object') {
      if (binding.primary === 'Shift+Space' || binding.primary === 'Ctrl+Space') {
        binding.primary = 'X';
      }
      if (binding.secondary === 'Shift+Space' || binding.secondary === 'Ctrl+Space') {
        binding.secondary = null;
      }
    } else if (binding === 'Shift+Space' || binding === 'Ctrl+Space') {
      migratedKeybinds['tool.swapColors'] = 'X';
    }
  }

  const migratedShowRawPixelsAtHighZoom = parsedVersion < 4
    ? true
    : !!parsed.general?.showRawPixelsAtHighZoom;
  const migratedUseDesynchronizedBoardContexts = false;
  // v15: boolean -> tri-state. A stored `true` is a deliberate opt-in and is
  // preserved as 'on'; a stored `false` is almost always the untouched old
  // default rather than a decision, so it becomes 'auto' — which is the whole
  // point of the change, since those are the users whose weak machines were
  // never being detected.
  const migratedLowPowerMode = parsedVersion < 6
    ? 'auto'
    : parsedVersion < 15
      ? (parsed.general?.lowPowerMode === true ? 'on' : 'auto')
      : sanitizeLowPowerMode(parsed.general?.lowPowerMode);

  const migratedShowFloatingArt = parsedVersion < 8
    ? true
    : parsed.general?.showFloatingArt !== undefined ? !!parsed.general.showFloatingArt : true;

  const migratedScrollToZoom = parsedVersion < 9
    ? false
    : !!parsed.general?.scrollToZoom;

  let migratedSfx = parsed.general?.sfx;
  if (parsedVersion < 10) {
    migratedSfx = { ...(migratedSfx && typeof migratedSfx === 'object' ? migratedSfx : {}), volume: DEFAULT_SFX_PREFERENCES.volume };
  }

  return {
    version: APP_PREFERENCES_VERSION,
    general: {
      ...defaults.general,
      sidebarSide: sanitizeSidebarSide(parsed.general?.sidebarSide),
      sidebarWidth: sanitizeSidebarWidth(parsed.general?.sidebarWidth),
      toolsWidth: sanitizeToolsWidth(parsed.general?.toolsWidth),
      themeColors: sanitizeThemeColors(parsed.general?.themeColors),
      localBoardBackgroundColor: sanitizeOptionalHexColor(parsed.general?.localBoardBackgroundColor),
      localBoardBackgroundEnabled: parsed.general?.localBoardBackgroundEnabled !== undefined
        ? !!parsed.general.localBoardBackgroundEnabled
        : true,
      hideOwnLabelAbove150: !!parsed.general?.hideOwnLabelAbove150,
      showRawPixelsAtHighZoom: migratedShowRawPixelsAtHighZoom,
      useDesynchronizedBoardContexts: migratedUseDesynchronizedBoardContexts,
      lowPowerMode: migratedLowPowerMode,
      reduceBackgroundWork: !!parsed.general?.reduceBackgroundWork,
      scrollToZoom: migratedScrollToZoom,
      showFloatingArt: migratedShowFloatingArt,
      galleryTimelapseEnabled: parsed.general?.galleryTimelapseEnabled !== undefined
        ? !!parsed.general.galleryTimelapseEnabled
        : true,
      chatOpacity: sanitizeChatOpacity(parsed.general?.chatOpacity),
      rightClickActions: sanitizeRightClickActions(parsed.general?.rightClickActions),
      sfx: sanitizeSfx(migratedSfx),
      replay: sanitizeReplay(parsed.general?.replay)
    },
    keybinds: sanitizeKeybinds(migratedKeybinds)
  };
}

export function loadAppPreferences() {
  try {
    const raw = localStorage.getItem(APP_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return createDefaultAppPreferences();
    }

    return sanitizePreferences(JSON.parse(raw));
  } catch {
    return createDefaultAppPreferences();
  }
}

export function saveAppPreferences(preferences) {
  const sanitized = sanitizePreferences(preferences);
  localStorage.setItem(APP_PREFERENCES_STORAGE_KEY, JSON.stringify(sanitized));
  return sanitized;
}

export function getEffectiveKeybinding(preferences, actionId) {
  return getEffectiveKeybindings(preferences, actionId)[0] ?? null;
}

export function getEffectiveKeybindings(preferences, actionId) {
  if (!KEYBIND_ACTIONS_BY_ID[actionId]) return [];

  const defaults = getDefaultKeybindings()[actionId];
  const rawBinding = preferences?.keybinds?.[actionId];

  if (rawBinding === null) {
    return [];
  }

  if (rawBinding && typeof rawBinding === 'object') {
    const bindings = [
      sanitizeBindingSlot(rawBinding.primary, defaults.primary),
      sanitizeBindingSlot(rawBinding.secondary, null)
    ].filter(Boolean);

    return [...new Set(bindings)];
  }

  const primary = sanitizeBindingSlot(rawBinding, defaults.primary);
  return primary ? [primary] : [];
}
