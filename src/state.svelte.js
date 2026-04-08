class DrawingState {
  // Tool & Drawing
  currentTool = $state('brush');
  currentColor = $state([0, 0, 0, 255]);
  currentSize = $state(10);
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

  // Color Palette
  recentColors = $state([]);
  customColors = $state([]);

  // UI
  boardMenuOpen = $state(null); // null | 'blend' | 'layers'
  profileDialog = $state({ visible: false, username: null, data: null, loading: false, error: null });
  roomSettingsVisible = $state(false);
  appSettingsVisible = $state(false);
  appSettingsTab = $state('general');
  appPreferences = $state(null);
  adminPanelVisible = $state(false);
  colorPaletteVisible = $state(true);
  patternPreviewVisible = $state(false);
  patternPreviewCollapsed = $state(false);
  toastState = $state({ text: '', visible: false });
  connectionState = $state({ connected: false, roomId: null, text: '' });

  // Snapshots
  snapshots = $state([]);
  snapshotMenuVisible = $state(false);

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

export function addRecentColor(color) {
  appState.recentColors = [
    [...color],
    ...appState.recentColors.filter(c => !colorsEqual(c, color))
  ].slice(0, 6);
}

export function addCustomColor(color) {
  const exists = appState.customColors.some(c => colorsEqual(c, color));
  if (exists || appState.customColors.length >= 12) return;
  appState.customColors = [...appState.customColors, [...color]];
}

export function removeCustomColor(color) {
  appState.customColors = appState.customColors.filter(c => !colorsEqual(c, color));
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

export function toggleSnapshotMenu() {
  appState.snapshotMenuVisible = !appState.snapshotMenuVisible;
}

export function openMessengerWithUser(id, name) {
  appState.messengerTargetUser = { id, name };
  appState.messengerVisible = true;
}
