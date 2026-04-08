const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

function isMacPlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
}

function normalizeMainKey(key) {
  if (!key) return null;

  const normalized = key.length === 1 ? key : key.trim();

  switch (normalized) {
    case ' ':
    case 'Spacebar':
      return 'Space';
    case ',':
      return 'Comma';
    case '.':
      return 'Period';
    case '/':
      return 'Slash';
    case '\\':
      return 'Backslash';
    case '\'':
      return 'Quote';
    case ';':
      return 'Semicolon';
    case '[':
      return 'BracketLeft';
    case ']':
      return 'BracketRight';
    case '`':
      return 'Backquote';
    case '-':
      return 'Minus';
    case '=':
      return 'Equal';
    case 'Esc':
      return 'Escape';
    case 'Del':
      return 'Delete';
    default:
      break;
  }

  if (MODIFIER_KEYS.has(normalized)) {
    return null;
  }

  if (normalized.length === 1) {
    return normalized.toUpperCase();
  }

  return normalized;
}

export function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'string') return null;

  const parts = binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  const modifiers = [];
  let mainKey = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod') {
      if (!modifiers.includes('Mod')) modifiers.push('Mod');
      continue;
    }
    if (lower === 'ctrl' || lower === 'control') {
      if (!modifiers.includes('Ctrl')) modifiers.push('Ctrl');
      continue;
    }
    if (lower === 'alt' || lower === 'option') {
      if (!modifiers.includes('Alt')) modifiers.push('Alt');
      continue;
    }
    if (lower === 'shift') {
      if (!modifiers.includes('Shift')) modifiers.push('Shift');
      continue;
    }
    if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
      if (!modifiers.includes('Meta')) modifiers.push('Meta');
      continue;
    }

    mainKey = normalizeMainKey(part);
  }

  if (!mainKey) return null;

  const ordered = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'].filter((modifier) => modifiers.includes(modifier));
  return [...ordered, mainKey].join('+');
}

export function eventToBinding(event) {
  const mainKey = normalizeMainKey(event.key);
  if (!mainKey) return null;

  const modifiers = [];
  const mac = isMacPlatform();

  if (event.ctrlKey) {
    modifiers.push(mac ? 'Ctrl' : 'Mod');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  if (event.metaKey) {
    modifiers.push(mac ? 'Mod' : 'Meta');
  }

  return normalizeBinding([...modifiers, mainKey].join('+'));
}

export function formatBindingForDisplay(binding) {
  const normalized = normalizeBinding(binding);
  if (!normalized) return 'Unbound';

  const mac = isMacPlatform();
  return normalized
    .split('+')
    .map((part) => {
      if (part === 'Mod') return mac ? 'Cmd' : 'Ctrl';
      if (part === 'Meta') return 'Meta';
      if (part === 'Ctrl') return 'Ctrl';
      if (part === 'Alt') return mac ? 'Option' : 'Alt';
      return part;
    })
    .join('+');
}
