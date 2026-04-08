import { getDefaultKeybindings, KEYBIND_ACTIONS_BY_ID } from '../input/keybinds/KeybindRegistry.js';
import { normalizeBinding } from '../input/keybinds/KeybindMatcher.js';

export const APP_PREFERENCES_STORAGE_KEY = 'topDrawAppPreferences';
const APP_PREFERENCES_VERSION = 1;

export function createDefaultAppPreferences() {
  return {
    version: APP_PREFERENCES_VERSION,
    general: {},
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

function sanitizePreferences(rawPreferences) {
  const defaults = createDefaultAppPreferences();
  const parsed = rawPreferences && typeof rawPreferences === 'object' ? rawPreferences : {};

  return {
    version: APP_PREFERENCES_VERSION,
    general: defaults.general,
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
