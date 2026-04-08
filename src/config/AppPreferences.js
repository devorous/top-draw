import { getDefaultKeybindings, KEYBIND_ACTIONS_BY_ID } from '../input/keybinds/KeybindRegistry.js';
import { normalizeBinding } from '../input/keybinds/KeybindMatcher.js';

export const APP_PREFERENCES_STORAGE_KEY = 'topDrawAppPreferences';
const APP_PREFERENCES_VERSION = 1;
const SIDEBAR_SIDES = new Set(['left', 'right']);
export const THEME_COLOR_KEYS = [
  'bg-primary',
  'bg-secondary',
  'bg-tertiary',
  'bg-elevated',
  'accent-primary',
  'accent-secondary',
  'accent-hover',
  'text-primary',
  'text-secondary',
  'text-muted'
];

export function createDefaultAppPreferences() {
  return {
    version: APP_PREFERENCES_VERSION,
    general: {
      sidebarSide: 'right',
      themeColors: {}
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

  for (const key of THEME_COLOR_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      sanitized[key] = value.trim();
    }
  }

  return sanitized;
}

function sanitizeSidebarSide(rawSidebarSide) {
  if (typeof rawSidebarSide !== 'string') return 'right';
  const normalized = rawSidebarSide.trim().toLowerCase();
  return SIDEBAR_SIDES.has(normalized) ? normalized : 'right';
}

function sanitizePreferences(rawPreferences) {
  const defaults = createDefaultAppPreferences();
  const parsed = rawPreferences && typeof rawPreferences === 'object' ? rawPreferences : {};

  return {
    version: APP_PREFERENCES_VERSION,
    general: {
      ...defaults.general,
      sidebarSide: sanitizeSidebarSide(parsed.general?.sidebarSide),
      themeColors: sanitizeThemeColors(parsed.general?.themeColors)
    },
    keybinds: sanitizeKeybinds(parsed.keybinds)
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
