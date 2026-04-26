class DrawingState {
  // Tool & Drawing
  currentTool = $state('brush');
  currentColor = $state([0, 0, 0, 255]);
  currentSize = $state(10);
  currentToolSettings = $state({});
  currentPressure = $state(1.0);
  pressureEnabled = $state(true);
  blendMode = $state('source-over');

  // Layer
  activeLayer = $state(2);
  layerVisibility = $state({ 0: true, 1: true, 2: true });
  layerManager = $state(null);

  // User
  users = $state(new Map());
  self = $state(null);
  sessionIndex = $state(null);
  selfRole = $state(0);
  username = $state('');

  // Room
  currentRoomId = $state(null);
  currentRoomData = $state(null);
  connected = $state(false);
  board = $state(null);

  // Chat
  chatUnreadCount = $state(0);
  chatVisible = $state(false);
  dmRecipient = $state(null);

  // Messenger (1-1 E2EE)
  messengerVisible = $state(false);
  messengerTargetUser = $state(null); // { id, name }
  messengerUnreadCount = $state(0);

  // Color Palette
  recentColors = $state([]);
  customColors = $state(loadCustomColors());
  activeCustomPresetKey = $state(null);

  // UI
  boardMenuOpen = $state(null); // null | 'blend' | 'layers'
  profileDialog = $state({ visible: false, username: null, data: null, loading: false, error: null });
  galleryItemDialog = $state({ visible: false, itemId: null });
  roomSettingsVisible = $state(false);
  appSettingsVisible = $state(false);
  appSettingsTab = $state('general');
  appPreferences = $state(null);
  adminPanelVisible = $state(false);
  colorPaletteVisible = $state(true);
  patternPreviewVisible = $state(false);
  patternPreviewCollapsed = $state(false);
  patternPreviewMode = $state('pattern');
  imageBrushPreviewUrl = $state('');
  toastState = $state({ text: '', visible: false });
  connectionState = $state({ connected: false, roomId: null, text: '' });

  // Snapshots
  snapshots = $state([]);
  snapshotHasMore = $state(true);
  snapshotListVersion = $state(0);
  snapshotMenuVisible = $state(false);
  snapshotSource = $state('remote'); // 'remote' | 'local'

  // Derived
  get currentColorRgba() {
    const [r, g, b, a] = this.currentColor;
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  }

  get currentColorHex() {
    const [r, g, b] = this.currentColor;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  get isModerator() {
    return this.selfRole >= 4;
  }

  get userCount() {
    return this.users.size;
  }
}

export const appState = new DrawingState();

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

// ============================================================================
// Helper functions
// ============================================================================

function colorsEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function normalizeCustomPreset(item) {
  if (Array.isArray(item)) {
    return { color: [...item], tool: null, size: null, settings: null };
  }

  if (!item || !Array.isArray(item.color)) {
    return null;
  }

  return {
    color: [...item.color],
    tool: item.tool || null,
    size: item.size != null ? item.size : null,
    settings: item.settings && typeof item.settings === 'object' ? { ...item.settings } : null
  };
}

function saveCustomColors() {
  try {
    localStorage.setItem('topdraw_customColors', JSON.stringify(appState.customColors));
  } catch (e) {
    console.warn('Failed to save custom colors:', e);
  }
}

export function getCustomPresetKey(preset) {
  const normalized = normalizeCustomPreset(preset);
  if (!normalized) return null;

  return JSON.stringify({
    color: normalized.color,
    tool: normalized.tool,
    size: normalized.size,
    settings: normalized.settings || null
  });
}

function loadCustomColors() {
  try {
    const saved = localStorage.getItem('topdraw_customColors');
    if (!saved) return [];
    return JSON.parse(saved).map(normalizeCustomPreset).filter(Boolean);
  } catch (e) {
    console.warn('Failed to load custom colors:', e);
    return [];
  }
}

export function addRecentColor(color) {
  appState.recentColors = [
    [...color],
    ...appState.recentColors.filter(c => !colorsEqual(c, color))
  ].slice(0, 6);
}

export function addCustomColor(color, settings = {}) {
  const tool = settings.tool || null;
  const size = settings.size != null ? settings.size : null;
  const toolSettings = settings.settings && typeof settings.settings === 'object' ? { ...settings.settings } : null;
  const colorlessTools = ['erase', 'blur', 'circleBlur', 'glitchBlur', 'select', 'pan', 'zoom', 'rotate', 'inkdropper'];
  const normalizedColor = colorlessTools.includes(tool) ? [0, 0, 0, 0] : [...color];

  const exists = appState.customColors.some(item => {
    const preset = normalizeCustomPreset(item);
    return preset &&
      colorsEqual(preset.color, normalizedColor) &&
      preset.tool === tool &&
      preset.size === size &&
      JSON.stringify(preset.settings || null) === JSON.stringify(toolSettings || null);
  });

  if (exists || appState.customColors.length >= 12) return;
  appState.customColors = [...appState.customColors, { color: normalizedColor, tool, size, settings: toolSettings }];
  saveCustomColors();
}

export function removeCustomColor(presetToRemove) {
  const target = normalizeCustomPreset(presetToRemove);
  if (!target) return;

  appState.customColors = appState.customColors.filter(item => {
    const preset = normalizeCustomPreset(item);
    return !preset ||
      !colorsEqual(preset.color, target.color) ||
      preset.tool !== target.tool ||
      preset.size !== target.size ||
      JSON.stringify(preset.settings || null) !== JSON.stringify(target.settings || null);
  });
  saveCustomColors();
}

export function toggleLayerVisibility(layerIndex) {
  appState.layerVisibility = {
    ...appState.layerVisibility,
    [layerIndex]: !appState.layerVisibility[layerIndex]
  };
}

export function showProfile(username) {
  appState.profileDialog = { visible: true, username, data: null, loading: true, error: null };

  fetch(`${API_BASE}/api/users/${encodeURIComponent(username)}`)
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load profile');
      }
      return data;
    })
    .then(data => {
      appState.profileDialog = { ...appState.profileDialog, loading: false, data };
    })
    .catch((err) => {
      appState.profileDialog = {
        ...appState.profileDialog,
        loading: false,
        error: err?.message || 'Connection error'
      };
    });
}

export function toggleMessenger() {
  appState.messengerVisible = !appState.messengerVisible;
  console.log('Messenger visible:', appState.messengerVisible);
}

export function clearSnapshotHistoryState() {
  const hadSnapshotState = appState.snapshots.length > 0 || !appState.snapshotHasMore;
  appState.snapshots = [];
  appState.snapshotHasMore = true;
  if (hadSnapshotState) {
    appState.snapshotListVersion += 1;
  }
}

export function openSnapshotMenu() {
  appState.snapshotMenuVisible = true;
}

export function closeSnapshotMenu() {
  if (!appState.snapshotMenuVisible) return;
  appState.snapshotMenuVisible = false;
  clearSnapshotHistoryState();
}

export function toggleSnapshotMenu() {
  if (appState.snapshotMenuVisible) {
    closeSnapshotMenu();
    return;
  }

  openSnapshotMenu();
}

export function openLocalSnapshotMenu() {
  appState.snapshotSource = 'local';
  appState.snapshotMenuVisible = true;
}

export function setSnapshotSource(source) {
  if (appState.snapshotSource === source) return;
  appState.snapshotSource = source;
  clearSnapshotHistoryState();
}

export function openMessengerWithUser(id, name) {
  appState.messengerTargetUser = { id, name };
  appState.messengerVisible = true;
}
