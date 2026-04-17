const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
const POINTER_BUTTON_ALIASES = new Map([
  ['leftclick', 'PointerPrimary'],
  ['leftmouse', 'PointerPrimary'],
  ['primaryclick', 'PointerPrimary'],
  ['pointerprimary', 'PointerPrimary'],
  ['middleclick', 'PointerMiddle'],
  ['middlemouse', 'PointerMiddle'],
  ['pointermiddle', 'PointerMiddle'],
  ['rightclick', 'PointerSecondary'],
  ['rightmouse', 'PointerSecondary'],
  ['secondaryclick', 'PointerSecondary'],
  ['pointersecondary', 'PointerSecondary'],
  ['mouseback', 'PointerBack'],
  ['backmouse', 'PointerBack'],
  ['x1mouse', 'PointerBack'],
  ['pointerback', 'PointerBack'],
  ['mouseforward', 'PointerForward'],
  ['forwardmouse', 'PointerForward'],
  ['x2mouse', 'PointerForward'],
  ['pointerforward', 'PointerForward'],
  ['penbarrel', 'PenBarrel'],
  ['barrelbutton', 'PenBarrel'],
  ['peneraser', 'PenEraser'],
  ['eraserbutton', 'PenEraser']
]);
const CODE_KEY_ALIASES = new Map([
  ['NumpadAdd', 'NumpadAdd'],
  ['NumpadSubtract', 'NumpadSubtract']
]);

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

function normalizePointerButtonToken(token) {
  if (!token || typeof token !== 'string') return null;

  const compact = token.trim().replace(/[\s_-]+/g, '').toLowerCase();
  return POINTER_BUTTON_ALIASES.get(compact) ?? null;
}

function normalizeCodeToken(token) {
  if (!token || typeof token !== 'string') return null;
  return CODE_KEY_ALIASES.get(token.trim()) ?? null;
}

function normalizeModifierKey(key) {
  if (!key) return null;

  switch (key) {
    case 'Control':
      return 'Ctrl';
    case 'Alt':
      return 'Alt';
    case 'Shift':
      return 'Shift';
    case 'Meta':
      return 'Meta';
    default:
      return null;
  }
}

function normalizePointerButton(event) {
  if (!event || typeof event.button !== 'number') return null;

  switch (event.button) {
    case 0:
      return 'PointerPrimary';
    case 1:
      return 'PointerMiddle';
    case 2:
      return event.pointerType === 'pen' ? 'PenBarrel' : 'PointerSecondary';
    case 3:
      return 'PointerBack';
    case 4:
      return 'PointerForward';
    case 5:
      return 'PenEraser';
    default:
      return null;
  }
}

function getEventModifiers(event) {
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

  return modifiers;
}

function isPointerBindingEvent(event) {
  return !!event && typeof event.button === 'number' && typeof event.pointerType === 'string';
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

    const pointerButton = normalizePointerButtonToken(part);
    if (pointerButton) {
      mainKey = pointerButton;
      continue;
    }

    const codeKey = normalizeCodeToken(part);
    if (codeKey) {
      mainKey = codeKey;
      continue;
    }

    mainKey = normalizeMainKey(part);
  }

  if (!mainKey) {
    if (parts.length === 1 && modifiers.length === 1) {
      return modifiers[0];
    }
    return null;
  }

  const ordered = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'].filter((modifier) => modifiers.includes(modifier));
  return [...ordered, mainKey].join('+');
}

export function eventToBinding(event) {
  if (isPointerBindingEvent(event)) {
    const mainKey = normalizePointerButton(event);
    if (!mainKey) return null;

    return normalizeBinding([...getEventModifiers(event), mainKey].join('+'));
  }

  const modifierKey = normalizeModifierKey(event.key);
  if (modifierKey) {
    return normalizeBinding(modifierKey);
  }

  const codeKey = normalizeCodeToken(event.code);
  if (codeKey) {
    return normalizeBinding([...getEventModifiers(event), codeKey].join('+'));
  }

  const mainKey = normalizeMainKey(event.key);
  if (!mainKey) return null;

  return normalizeBinding([...getEventModifiers(event), mainKey].join('+'));
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
      if (part === 'PointerPrimary') return 'Left Click';
      if (part === 'PointerMiddle') return 'Middle Click';
      if (part === 'PointerSecondary') return 'Right Click';
      if (part === 'PointerBack') return 'Mouse Back';
      if (part === 'PointerForward') return 'Mouse Forward';
      if (part === 'PenBarrel') return 'Pen Barrel';
      if (part === 'PenEraser') return 'Pen Eraser';
      if (part === 'NumpadAdd') return 'Numpad +';
      if (part === 'NumpadSubtract') return 'Numpad -';
      return part;
    })
    .join('+');
}
