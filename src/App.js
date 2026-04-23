/** @fileoverview Main entry point for the drawing application, coordinating board, tools, UI, and networking. */

import { T, ToolToEnum } from '../shared/MessageTypes.js';
import { packColor } from '../shared/ColorUtils.js';
import { User } from './User.js';
import { Board } from './canvas/Board.js';
import { ToolManager, BrushTool } from './tools/Tools.js';
import { WebSocketClient } from './network/WebSocketClient.js';
import { UI } from './ui/index.js';
import { BrushGalleryLoader } from './ui/BrushGalleryLoader.js';
import { PatternBrushGallery } from './ui/PatternBrushGallery.js';
import { assetLibrary } from './ui/AssetLibrary.js';
import { RemoteUserHandler } from './remote/RemoteUserHandler.js';
import { TouchHandler } from './input/TouchHandler.js';
import { setupWebSocketHandlers } from './network/WebSocketHandlers.js';
import { DebugOverlay, SyncClient } from './sync/index.js';
import { douglasPeucker, distanceBasedCulling } from './utils/drawing.js';
import { Auth } from './auth/Auth.js';
import { Moderation } from './auth/Moderation.js';
import { ColorInputMenu } from './ui/ColorInputMenu.js';
import { LandingPage } from './ui/LandingPage.js';
import { ToolLockManager } from './tools/ToolLockManager.js';
import { InputBufferManager } from './input/InputBufferManager.js';
import { KeyboardHandler } from './input/KeyboardHandler.js';
import { BrushModeManager } from './tools/BrushModeManager.js';
import { BlendModeManager } from './canvas/BlendModeManager.js';
// import { StrokeHistoryPanel } from './ui/StrokeHistoryPanel.js'; // Hidden - stroke history panel disabled
import { PerformanceDebugPanel } from './ui/PerformanceDebugPanel.js';
import { TimeMachine } from './timebar/TimeMachine.svelte.js';
// PerformanceSettings is lazy-loaded by Moderation._showPerformanceSettings()
import { highlight } from './ui/Highlight.js';
import { SaveMode } from './ui/SaveMode.js';
import { HistoryPanel } from './ui/HistoryPanel.js';
import { MirrorRegionController } from './ui/MirrorRegionController.js';
import { BoardViewer } from './ui/BoardViewer.js';
import { SnapshotManager } from './remote/SnapshotManager.js';
import { loadAppPreferences, saveAppPreferences } from './config/AppPreferences.js';
import { getTextFontDefaults, loadTextFont, normalizeTextFont } from './config/textFonts.js';
import {
  copyCanvasToSystemClipboard,
  copyImageDataToSystemClipboard,
  isTauriDesktop,
  openImageViaNativeDialog,
  saveCanvasViaNativeDialog
} from './platform/desktop.js';
import { checkForDesktopUpdates } from './platform/updater.js';
import { ensureClientCanConnect, formatOutdatedClientMessage, getVersionStatus } from './VersionChecker.js';
import { broadcastChatPopoutEvent, focusChatPopout } from './platform/chatPopoutBridge.js';
import initWasm from './wasm/ddraw_wasm.js';

// Svelte UI Components
import { initSvelteUI, syncStoresFromApp, showProfile as showProfileDialog } from './ui/svelte/AppUI.svelte.js';
import { appState, addRecentColor, getCustomPresetKey } from './state.svelte.js';
import ColorWheel from 'reinvented-color-wheel';
import 'reinvented-color-wheel/css/reinvented-color-wheel.css';

const TEXT_FONT_SETTINGS_STORAGE_KEY = 'topDrawTextFontSettings';
const SHAPE_DRAW_MODE_STORAGE_KEY = 'topDrawShapeDrawMode';
const NORMAL_TPS = 60;
const LOW_POWER_TPS = 30;
const LOW_POWER_FPS = 30;
const BLUR_RADIUS_MAX = 10;
const GLITCH_BLUR_RADIUS_MAX = 25;
const COALESCED_INPUT_TOOLS = new Set([
  'brush',
  'flowPen',
  'imageBrush',
  'ink',
  'erase',
  'blur',
  'circleBlur',
  'glitchBlur',
  'pixel',
  'pattern'
]);

function _hexToRgb(hex) {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function _rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6 * 360, s * 100, l * 100];
}

function _hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2 = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [hue2(h + 1/3) * 255, hue2(h) * 255, hue2(h - 1/3) * 255];
}

function _shiftL(hex, delta) {
  const [r, g, b] = _hexToRgb(hex);
  const [h, s, l] = _rgbToHsl(r, g, b);
  return _rgbToHex(..._hslToRgb(h, s, Math.max(0, Math.min(100, l + delta))));
}

function _blend(hex1, hex2, t) {
  const [r1, g1, b1] = _hexToRgb(hex1);
  const [r2, g2, b2] = _hexToRgb(hex2);
  return _rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

const DERIVED_THEME_CSS_KEYS = [
  'bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-elevated',
  'surface-glass', 'surface-overlay',
  'accent-primary', 'accent-secondary', 'accent-hover',
  'accent-glow',
  'text-primary', 'text-secondary', 'text-muted',
  'border-subtle', 'border-active'
];

function applyThemeColors(themeColors = {}) {
  if (typeof document === 'undefined') return;

  const rootStyle = document.documentElement.style;
  const { bg, accent, text } = themeColors ?? {};

  if (bg && accent && text) {
    // Scale the layer step with the base lightness so darker backgrounds
    // stay dark — e.g. near-black bg uses ~2pt steps instead of 5pt.
    const [, , bgL] = _rgbToHsl(..._hexToRgb(bg));
    const step = Math.min(5, Math.max(1.5, bgL * 0.44));

    const vars = {
      'bg-primary':       bg,
      'bg-secondary':     _shiftL(bg, step),
      'bg-tertiary':      _shiftL(bg, step * 2),
      'bg-elevated':      _shiftL(bg, step * 3),
      'surface-glass':    _blend(_shiftL(bg, step * 1.35), '#000000', 0.08),
      'surface-overlay':  _blend(bg, '#000000', 0.5),
      'accent-primary':   accent,
      'accent-secondary': _shiftL(accent, -6),
      'accent-hover':     _shiftL(accent, 4),
      'accent-glow':      _blend(accent, bg, 0.7),
      'text-primary':     text,
      'text-secondary':   _blend(text, bg, 0.38),
      'text-muted':       _blend(text, bg, 0.62),
      'border-subtle':    _blend(text, bg, 0.9),
      'border-active':    _blend(accent, bg, 0.5),
    };
    for (const [key, val] of Object.entries(vars)) {
      rootStyle.setProperty(`--${key}`, val);
    }
  } else {
    for (const key of DERIVED_THEME_CSS_KEYS) {
      rootStyle.removeProperty(`--${key}`);
    }
  }
}

function applySidebarSide(sidebarSide = 'right') {
  if (typeof document === 'undefined') return;

  const normalized = sidebarSide === 'left' ? 'left' : 'right';
  document.documentElement.dataset.sidebarSide = normalized;
}

function applyChatOpacity(opacity) {
  if (typeof document === 'undefined') return;

  const value = Number(opacity);
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0.3, value)) : 0.7;
  document.documentElement.style.setProperty('--chat-opacity', clamped);
}

/**
 * Main Drawing Application class.
 * @class
 */
export class DrawingApp {
  /**
   * @param {Object} options - Application configuration options.
   * @param {Array<number>} [options.dimensions=[1080, 1920]] - Board dimensions.
   * @param {string} [options.serverUrl] - WebSocket server URL.
   */
  constructor(options = {}) {
    this.sessionIndex = null;
    this.users = new Map();
    this.fingerprintIdUserColorCache = new Map(); // Map fingerprint ID -> color for persistent user identification
    this.connected = false;
    this.previousTool = null;
    this.intentionalDisconnect = false;
    this.appPreferences = loadAppPreferences();
    applyThemeColors(this.appPreferences?.general?.themeColors);
    applySidebarSide(this.appPreferences?.general?.sidebarSide);
    applyChatOpacity(this.appPreferences?.general?.chatOpacity);
    this._warnOnNextUnload = false;
    this.supportedCursorStyleTools = ['brush', 'flowPen', 'ink', 'erase'];
    this.toolCursorStyles = this.loadToolCursorStyles();
    this.isOfflineMode = false;

    // Selection state for asynchronous imageData loading
    this._pendingSelLiftImageDataUrl = null;
    this._pendingSelLiftRect = null;
    this._pendingSelLiftLassoPath = null;
    this._pendingSelMoveData = null; // Stores { corners, x, y }
    this._isSelLiftDataLoading = false;

    // Selection state for asynchronous imageData loading
    this._pendingSelLiftImageDataUrl = null;
    this._pendingSelLiftRect = null;
    this._pendingSelLiftLassoPath = null;
    this._pendingSelMoveData = null; // Stores { corners, x, y }
    this._isSelLiftDataLoading = false;

    this.board = new Board({
      dimensions: options.dimensions || [1080, 1920]
    });

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();


    // Vanilla JS components (to be replaced by Svelte)
    // this.chat = new Chat({...});
    // this.colorPalette = new ColorPalette({...});
    // NOTE: Chat and ColorPalette now managed by Svelte components

    this.brushGallery = new BrushGalleryLoader({
      onSelect: (brush) => this.handleBrushSelect(brush),
      onUpload: () => this.ui.elements.brushFileInput?.click(),
      assetLibrary
    });
    this.patternGallery = new PatternBrushGallery({
      onSelect: (brush) => this.handlePatternBrushSelect(brush),
      onUpload: () => this.handlePatternImageBtnClick(),
      assetLibrary
    });

    // Svelte components will be initialized in init()
    this.svelteComponents = null;

    this.colorInputMenu = new ColorInputMenu({
      onColorChange: (rgba) => this.handleColorInputChange(rgba)
    });

    this.colorPicker = null;
    this.colorPickerResizeObserver = null;
    this.primaryColor = [0, 0, 0, 1];
    this.secondaryColor = [255, 255, 255, 1];
    this.activeColorSlot = 'primary';
    this.colorSlotElements = null;
    this.colorPickerHexInput = null;

    this.wsClient = new WebSocketClient({
      serverUrl: options.serverUrl,
      onConnect: (sessionIndex) => this.handleWSConnect(sessionIndex),
      onDisconnect: (code, reason) => this.handleWSDisconnect(code, reason)
    });

    this.self = null;
    this.colorPicker = null;
    this.isOnBoard = false;

    this.remoteUserHandler = null;
    this.touchHandler = null;
    this.debugOverlay = null;
    this.regionTracker = null;
    this.syncClient = null;
    this.mirrorRegionController = null;
    this.auth = null;
    this.moderation = null;
    this.landingPage = null;
    this.roomSettings = null;
    this.currentRoomId = null;
    this.currentRoomData = null;
    this._pendingLandingLogin = false;
    this.selfRole = 0;
    this.moderation = new Moderation();
    // this.profileDialog = new ProfileDialog(); // Now Svelte component

    this.inputBufferManager = new InputBufferManager(this);
    this.wsClient.getLowPowerMode = () => this.inputBufferManager.lowPowerMode;
    this._applyLowPowerPreference();

    this.shapeDrawMode = 'corner-to-corner';
    this.modifierKeys = {
      shift: false,
      alt: false,
      ctrl: false,
      meta: false
    };

    this.pressureEnabled = true;
    this.tabletDetected = false;
    this.tabletThinningWarningShown = false;

    this.eraseAllLayers = false;

    this.brushModeManager = new BrushModeManager(this);

    this.blendModeManager = new BlendModeManager(this);

    this.toolLockManager = new ToolLockManager(this);

    // Keyboard handler
    this.keyboardHandler = new KeyboardHandler(this);
    this._boundSuppressButtonKeyboardActivation = (e) => this.suppressButtonKeyboardActivation(e);

    // boardContainer background pan tracking
    this._containerPanActive = false;
    this._lastPanPointerX = 0;
    this._lastPanPointerY = 0;
    this._boardDragDepth = 0;

    // Right-click drag zoom state
    this._rightDragZoomActive = false;
    this._rightDragZoomPointerId = null;
    this._rightDragZoomStartClientY = 0;
    this._rightDragZoomStartZoom = 1;
    this._rightDragZoomPivotX = 0;
    this._rightDragZoomPivotY = 0;
    this._temporaryZoomPreviousTool = null;

    // Rotate tool state
    this._rotateToolActive = false;  // true while rotate-tool drag is in progress
    this._rotatePivotX = 0;          // boardContainer-relative pivot
    this._rotatePivotY = 0;
    this._rotatePivotClientX = 0;    // page-relative pivot (for angle calculation)
    this._rotatePivotClientY = 0;
    this._rotatePrevAngle = null;    // previous angle from pivot to pointer

    // Stroke history panel (dev mode) - DISABLED
    // this.strokeHistoryPanel = new StrokeHistoryPanel();
    this.strokeHistoryPanel = {
      init: () => {},
      setLayerManager: () => {},
      setActiveLayer: () => {},
      setEnabled: () => {},
      update: () => {},
      queueUpdate: () => {}
    }; // Stub for compatibility

    // Performance debug panel
    this.performanceDebugPanel = new PerformanceDebugPanel(this.inputBufferManager, this);

    // PerformanceSettings lazy-loaded via Moderation when mod role confirmed

    // Save mode (initialized in init() after board is ready)
    this.saveMode = null;

    // History panel (initialized in init() after board is ready)
    this.historyPanel = null;

    // Room preview interval (sends 1/4 scale preview to server every 30s)
    this._previewInterval = null;
    this._previewIntervalMs = 30000;

    // Checkpoint interval (dedicated user sends full board every 60s)
    this._checkpointInterval = null;
    this._checkpointIntervalMs = 60000;
    this._memoryCompactionTimer = null;
    this._memoryCompactionDelayMs = 2500;
    this._versionPollTimer = null;
    this._versionUpdateNoticed = false;
    this._reloadRecommended = false;

    this.snapshotManager = new SnapshotManager(this);
  }

  loadToolCursorStyles() {
    const defaults = {
      brush: 'circle',
      flowPen: 'circle',
      ink: 'circle',
      erase: 'circle'
    };

    try {
      const saved = localStorage.getItem('topDrawToolCursorStyles');
      if (!saved) return { ...defaults };
      const parsed = JSON.parse(saved);
      for (const tool of this.supportedCursorStyleTools) {
        const style = parsed?.[tool];
        if (['circle', 'crosshair', 'dot', 'square'].includes(style)) {
          defaults[tool] = style;
        }
      }
    } catch (error) {
      console.warn('Failed to load tool cursor styles:', error);
    }

    return defaults;
  }

  saveToolCursorStyles() {
    try {
      localStorage.setItem('topDrawToolCursorStyles', JSON.stringify(this.toolCursorStyles));
    } catch (error) {
      console.warn('Failed to save tool cursor styles:', error);
    }
  }

  getCursorStyleForTool(tool) {
    if (!this.supportedCursorStyleTools.includes(tool)) return 'circle';
    return this.toolCursorStyles[tool] || 'circle';
  }

  applyCursorStyleForTool(tool) {
    this.self.setCursorStyle(this.getCursorStyleForTool(tool));
  }

  handleCursorStyleChange(style) {
    const tool = this.self.tool;
    if (!this.supportedCursorStyleTools.includes(tool)) return;
    const nextStyle = ['circle', 'crosshair', 'dot', 'square'].includes(style) ? style : 'circle';
    this.toolCursorStyles[tool] = nextStyle;
    this.self.setCursorStyle(nextStyle);
    this.saveToolCursorStyles();
    this.ui.updateToolDisplay(tool, this.self);
    this.ui.updateSelfCursor(this.self.x, this.self.y, this.self.size);
    this.ui.updateSquarePositions(this.self.size);
    if (nextStyle === 'circle') {
      this.ui.updatePressureCursorRadius(this.self.pressure * this.self.size, this.self.size, this.tabletDetected);
    } else if (nextStyle === 'square') {
      this.ui.updatePressureSquareSize(this.self.pressure * this.self.size, this.self.size, this.tabletDetected);
    }
  }

  normalizeShapeDrawMode(mode) {
    return mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
  }

  isShiftModifierActive() {
    return !!this.modifierKeys.shift;
  }

  updateModifierKeysFromEvent(event) {
    if (!event) return;
    this.modifierKeys.shift = !!event.shiftKey;
    this.modifierKeys.alt = !!event.altKey;
    this.modifierKeys.ctrl = !!event.ctrlKey;
    this.modifierKeys.meta = !!event.metaKey;
  }

  clearModifierKeys() {
    this.modifierKeys.shift = false;
    this.modifierKeys.alt = false;
    this.modifierKeys.ctrl = false;
    this.modifierKeys.meta = false;
  }

  applyShapeDrawMode(mode, { broadcast = false, persist = true } = {}) {
    const normalizedMode = this.normalizeShapeDrawMode(mode);
    this.shapeDrawMode = normalizedMode;

    const rectangleTool = this.toolManager.getTool('rectangle');
    const circleTool = this.toolManager.getTool('circle');
    if (rectangleTool?.setDrawMode) rectangleTool.setDrawMode(normalizedMode);
    if (circleTool?.setDrawMode) circleTool.setDrawMode(normalizedMode);

    document.querySelectorAll('input[name="shapeDrawMode"]').forEach((radio) => {
      radio.checked = radio.value === normalizedMode;
    });

    if (persist) {
      localStorage.setItem(SHAPE_DRAW_MODE_STORAGE_KEY, normalizedMode);
    }

    if (broadcast && this.connected && this.wsClient) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastShapeDrawModeChange(normalizedMode));
    }
  }

  getConstrainedShapeDragPoint(rawX, rawY) {
    if (!this.self?.mousedown || this.self.panning) return { x: rawX, y: rawY };
    if (this.self.tool !== 'rectangle' && this.self.tool !== 'circle') return { x: rawX, y: rawY };

    const tool = this.toolManager?.getCurrentTool?.();
    const start = tool?.startPos;
    if (!start) return { x: rawX, y: rawY };

    const mode = this.normalizeShapeDrawMode(this.shapeDrawMode);
    const dx = rawX - start.x;
    const dy = rawY - start.y;

    // Center-scaling shapes are always perfect square/circle, so normalize the drag vector.
    if (mode === 'center-scaling') {
      if (this.self.tool === 'rectangle') {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
        const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
        return {
          x: start.x + sx * side,
          y: start.y + sy * side
        };
      }
      return { x: rawX, y: rawY };
    }

    // Corner mode: only constrain when Shift is held.
    if (!this.isShiftModifierActive()) {
      return { x: rawX, y: rawY };
    }

    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx === 0 ? (dy < 0 ? -1 : 1) : Math.sign(dx);
    const sy = dy === 0 ? (dx < 0 ? -1 : 1) : Math.sign(dy);
    return {
      x: start.x + sx * side,
      y: start.y + sy * side
    };
  }

  /**
   * Initializes the application, components, and event listeners.
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    window.app = this; // Set global reference early
    await initWasm();
    this.ui.init();
    this.ui.applySidebarWidths(this.appPreferences);
    this.createSelf();
    this.board.setUseDesynchronizedBoardContexts(this.appPreferences?.general?.useDesynchronizedBoardContexts);
    this.board.init('#boardContainer');
    this.board.setApp(this);
    this._applyLowPowerPreference();
    this.board.setShowRawPixelsAtHighZoom(this.appPreferences?.general?.showRawPixelsAtHighZoom);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.ui.setHideOwnLabelZoom(this.appPreferences?.general?.hideOwnLabelAbove150);
    appState.board = this.board;
    appState.appPreferences = this.appPreferences;
    TimeMachine.init(this.board, this.wsClient);
    this.TimeMachine = TimeMachine; // Expose for WebSocketClient recording

    // Initialize Svelte UI components
    this.svelteComponents = initSvelteUI(this);

    // Legacy components (still vanilla JS)
    // this.chat.init(); // Now Svelte
    // this.colorPalette.init(); // Now Svelte
    this.brushGallery.init();
    this.patternGallery.init();
    this.colorInputMenu.init();

    // Wire color input menu changes to sync with color wheel
    this.colorInputMenu.onColorChange = (rgba) => {
      const hsv = this.rgbToHsv(rgba[0], rgba[1], rgba[2]);
      if (this.colorPicker) {
        this.colorPicker.setColor(hsv);
      }
    };

    this.initSelfFromUI();
    this.setupColorPicker();

    this.remoteUserHandler = new RemoteUserHandler(this);
    this.touchHandler = new TouchHandler(this);
    this.touchHandler.init(this.ui.elements.boardContainer);
    this.saveMode = new SaveMode(this);
    this.historyPanel = new HistoryPanel(this);
    this.mirrorRegionController = new MirrorRegionController(this);
    this.mirrorRegionController.init();
    this.boardViewer = new BoardViewer(this);
    this.boardViewer.init();

    this.debugOverlay = new DebugOverlay();
    const debugCanvas = document.getElementById('debugOverlay');
    this.debugOverlay.init(debugCanvas, this.board.getWidth(), this.board.getHeight());
    this.debugOverlay.setBoard(this.board);
    this.debugOverlay.setInputBufferManager(this.inputBufferManager);
    this.debugOverlay.setTileTracker(this.board.tileTracker);

    this.strokeHistoryPanel.init();
    this._bindLayerManagerDependencies();

    this.performanceDebugPanel.init();
    // PerformanceSettings.init() called lazily by Moderation._showPerformanceSettings()

    this.ui.setupLayerPreviewListeners(this.board.layerManager);
    this.ui.attachFontChangeListener(this); // Attach font change listener

    // Sync initial app state to Svelte stores
    syncStoresFromApp(this);

    this.syncClient = new SyncClient();
    this.syncClient.init({
      wsClient: this.wsClient,
      board: this.board,
      app: this
    });
    this.syncClient.onSyncComplete = () => {
      console.log('[App] Sync complete');
      this.updateRecordingButtonState();
    };

    this.auth = new Auth({
      wsClient: this.wsClient,
      onSuccess: (token, role, username) => this.handleAuthSuccess(token, role, username),
      onError: (error) => this.handleAuthError(error)
    });
    this.auth.init();

    this.landingPage = new LandingPage({
      wsClient: this.wsClient,
      auth: this.auth,
      onRoomSelected: (roomId, password, settings) => this.handleRoomSelected(roomId, password, settings),
      onOffline: () => this.handleOffline()
    });
    this.landingPage.init();

    // RoomSettings now Svelte component (initialized in initSvelteUI)
    // this.roomSettings = new RoomSettings({...});
    // this.roomSettings.init();

    this.moderation.onProfile = (username) => {
      showProfileDialog(username);
    };
    this.moderation.onSync = (sessionIndex) => {
      this.syncClient.requestSync(sessionIndex);
      this.ui.showToast('Sync requested');
    };
    this.moderation.onSpectate = (sessionIndex) => {
      this.boardViewer?.spectateUser(sessionIndex);
    };
    this.moderation.onPM = (sessionIndex, user) => {
      if (!this.svelteComponents?.chat) return;

      const targetUser = user || this.users.get(sessionIndex);
      if (!targetUser || (targetUser.id === undefined && sessionIndex === undefined)) {
        appState.chatVisible = true;
        return;
      }
      this.svelteComponents.chat.openDM(targetUser.id ?? sessionIndex, targetUser);
    };
    this.moderation.onModAction = (actionType, sessionIndex, reason, duration) => {
      this.wsClient.sendModAction(actionType, sessionIndex, reason, duration);
    };
    this.moderation.onModUpdateReason = (originalActionCode, sessionIndex, reason) => {
      // Reuse modDuration to carry the original action code so server knows which entry to update
      this.wsClient.sendModAction(5, sessionIndex, reason, originalActionCode);
    };
    this.moderation.onModGroupUpdateReason = (action, ipHash, reason) => {
      const group = this.ui.remoteUserUI.userGroups.get(ipHash);
      if (!group) return;
      const actionCodes = { kick: 0, mute: 1, ban: 2 };
      const actionCode = actionCodes[action];
      group.userIds.forEach(userId => {
        this.wsClient.sendModAction(5, userId, reason, actionCode);
      });
    };
    this.moderation.onRequestModList = ({ showHistory, search } = {}) => {
      this.wsClient.requestModList({ showHistory, search });
    };
    this.moderation.onRevokeEntry = (entryId, entryType, username) => {
      const revokeType = entryType === 'mutes' ? 3 : entryType === 'shadowbans' ? 7 : 4;
      this.wsClient.sendModRevoke(revokeType, entryId, username);
    };
    this.moderation.onModWipe = (sessionIndex, targetName) => {
      this.wsClient.sendModWipe(sessionIndex, targetName);
    };

    this.moderation.onModGroupAction = (action, ipHash, reason, duration) => {
      const group = this.ui.remoteUserUI.userGroups.get(ipHash);
      if (!group) return;

      const actionCodes = { kick: 0, mute: 1, ban: 2 };
      const actionCode = actionCodes[action];

      console.log(`[Mod] Group action "${action}" on IP group ${ipHash} (${group.userIds.size} users)`);
      
      group.userIds.forEach(userId => {
        if (action === 'wipe') {
          const user = this.users.get(userId);
          this.wsClient.sendModWipe(userId, user?.name || '');
        } else {
          this.wsClient.sendModAction(actionCode, userId, reason, duration);
        }
      });
    };

    this.moderation.onClear = () => this.handleClear();
    this.moderation.onToggleDevMode = () => this.handleToggleDevMode();
    this.moderation.onRoomRoleSet = (targetSessionIndex, role) => {
      this.wsClient.sendRoomRoleSet(targetSessionIndex, role);
    };
    this.moderation.onGlobalRoleSet = (targetUsername, newGlobalRole) => {
      this.wsClient.sendGlobalRoleSet(targetUsername, newGlobalRole);
    };

      window.app = this;

      this.setupEventListeners();
      this.ui.updateTextPositionMultiplierValue(this.self.textPositionMultiplier);
      this.ui.updateTextPositionOffsetValue(this.self.textPositionOffset);
      this.updateAuthenticatedActionVisibility();
    this.updateRecordingButtonState();
    setupWebSocketHandlers(this);

    const initialTool = this.brushModeManager.getCurrentToolName();
    this.applyCursorStyleForTool(initialTool);
    this.self.setTool(initialTool);
    this.toolManager.setTool(initialTool);
    this.ui.updateToolDisplay(initialTool, this.self);
    this.ui.updateBrushModeDisplay(this.brushModeManager.getMode());
    this.ui.updateActiveLayerDisplay(this.self.activeLayer);
    this.ui.updateBlurToolState(this.self.activeLayer);
    this.ui.updateBlendModeForLayer(
      this.board.layerManager.getLayerAllowComplexBlendModes(this.self.activeLayer)
    );

    if (this.toolLockManager.toolLocks[initialTool]) {
      this.toolLockManager.restoreToolValues(initialTool);
      this.toolLockManager.updateAllLockButtons(initialTool);
    }

    this.connectForRoomDiscovery();
    this.startVersionPolling();
  }

  /**
   * Creates the local user instance.
   */
  createSelf() {
    this.self = new User(0, {
      context: this.board.topCtx,
      board: this.board.mainCanvas
    });
    this.applyCursorStyleForTool(this.self.tool);

    this._migrateLegacyTextFontSettings();
    this._migrateTextFontPresetDefaults();
    this._applyStoredTextFontSettings(this.self.font);
  }

  _getStoredTextFontSettings() {
    try {
      const rawSettings = localStorage.getItem(TEXT_FONT_SETTINGS_STORAGE_KEY);
      if (!rawSettings) return {};

      const parsedSettings = JSON.parse(rawSettings);
      return parsedSettings && typeof parsedSettings === 'object' ? parsedSettings : {};
    } catch {
      return {};
    }
  }

  _getResolvedTextFontSettings(font) {
    const normalizedFont = normalizeTextFont(font);
    const defaults = getTextFontDefaults(normalizedFont);
    const storedSettings = this._getStoredTextFontSettings()[normalizedFont];

    return {
      font: normalizedFont,
      textPositionMultiplier: Number(storedSettings?.textPositionMultiplier ?? defaults.textPositionMultiplier),
      textPositionOffset: Number(storedSettings?.textPositionOffset ?? defaults.textPositionOffset)
    };
  }

  _applyStoredTextFontSettings(font) {
    const settings = this._getResolvedTextFontSettings(font);
    this.self.setTextPositionMultiplier(settings.textPositionMultiplier);
    this.self.setTextPositionOffset(settings.textPositionOffset);
  }

  _saveTextFontSettings(font = this.self?.font) {
    if (!font || !this.self) return;

    const normalizedFont = normalizeTextFont(font);
    const settings = this._getStoredTextFontSettings();
    settings[normalizedFont] = {
      textPositionMultiplier: this.self.textPositionMultiplier,
      textPositionOffset: this.self.textPositionOffset
    };

    localStorage.setItem(TEXT_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  _migrateLegacyTextFontSettings() {
    const legacyMultiplier = localStorage.getItem('topDrawTextPositionMultiplier');
    const legacyOffset = localStorage.getItem('topDrawTextPositionOffset');

    if (legacyMultiplier === null && legacyOffset === null) return;

    let textPositionMultiplier = Number(legacyMultiplier);
    let textPositionOffset = Number(legacyOffset);

    if (!Number.isFinite(textPositionMultiplier)) {
      textPositionMultiplier = getTextFontDefaults(this.self.font).textPositionMultiplier;
    }

    if (!Number.isFinite(textPositionOffset)) {
      textPositionOffset = getTextFontDefaults(this.self.font).textPositionOffset;
    }

    // Migrate the old absolute-baseline defaults to the new correction-based defaults.
    if (textPositionMultiplier === 0.66 && textPositionOffset === -3) {
      textPositionMultiplier = 0;
      textPositionOffset = 0;
    }

    const settings = this._getStoredTextFontSettings();
    const normalizedFont = normalizeTextFont(this.self.font);
    if (!settings[normalizedFont]) {
      settings[normalizedFont] = {
        textPositionMultiplier,
        textPositionOffset
      };
      localStorage.setItem(TEXT_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }

    localStorage.removeItem('topDrawTextPositionMultiplier');
    localStorage.removeItem('topDrawTextPositionOffset');
  }

  _migrateTextFontPresetDefaults() {
    const settings = this._getStoredTextFontSettings();
    const tangerineSettings = settings['Tangerine, cursive'];
    if (!tangerineSettings) return;

    // Tangerine ended up sitting correctly with neutral applied correction.
    // If a user still has the old baked-in preset, update it once without
    // touching any custom tuning they may have already made.
    if (Number(tangerineSettings.textPositionMultiplier) === 0.25 && Number(tangerineSettings.textPositionOffset) === 0) {
      settings['Tangerine, cursive'] = {
        textPositionMultiplier: 0,
        textPositionOffset: 0
      };
      localStorage.setItem(TEXT_FONT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }
  }

  /**
   * Initializes self's settings from UI slider values.
   */
  initSelfFromUI() {
    const { elements } = this.ui;

    if (elements.smoothingSlider) {
      const smoothing = Number(elements.smoothingSlider.value);
      this.self.setSmoothing(smoothing);
    }

    if (elements.sizeSlider) {
      const size = Number(elements.sizeSlider.value);
      this.self.setSize(size);
    }

    if (elements.spacingSlider) {
      const spacing = Number(elements.spacingSlider.value);
      this.self.setSpacing(spacing);
    }

    if (elements.pressureMaxSlider) {
      const pressure = Number(elements.pressureMaxSlider.value) / 100;
      this.self.setPressure(pressure);
    }

    if (elements.blurRadiusSlider) {
      this.self.setBlurRadius(this.clampBlurRadiusForTool(Number(elements.blurRadiusSlider.value)));
    }

    if (elements.hardnessSlider) {
      this.self.setHardness(Number(elements.hardnessSlider.value));
    }

    // Load thinning (simulate pressure) preference from localStorage
    const savedSimulatePressure = localStorage.getItem('topDrawSimulatePressure');
    if (savedSimulatePressure !== null) {
      const simulate = savedSimulatePressure === 'true';
      this.self.setSimulatePressure(simulate);
      this.ui.updateSimulatePressure(simulate);
    }

    const savedShapeDrawMode = localStorage.getItem(SHAPE_DRAW_MODE_STORAGE_KEY);
    this.applyShapeDrawMode(savedShapeDrawMode, { broadcast: false, persist: false });
  }

  /**
   * Sets up the color picker component.
   */
  setupColorPicker() {
    try {
      const container = document.getElementById('colorPicker');
      if (!container) {
        console.warn('[App] Color picker container #colorPicker not found');
        return;
      }

      let suppressChange = false;
      const parseColorValue = (value) => {
        if (Array.isArray(value)) {
          return value;
        }

        if (typeof value !== 'string') {
          return null;
        }

        const rgbaMatch = value.match(/^rgba?\(([^)]+)\)$/i);
        if (rgbaMatch) {
          const parts = rgbaMatch[1].split(',').map(part => Number(part.trim()));
          if (parts.length >= 3 && parts.every(part => Number.isFinite(part))) {
            return [parts[0], parts[1], parts[2], parts[3] ?? this.self?.opacity ?? 1];
          }
        }

        const hslMatch = value.match(/^hsla?\(([^)]+)\)$/i);
        if (hslMatch) {
          const parts = hslMatch[1].split(',').map(part => part.trim());
          if (parts.length >= 3) {
            const h = Number(parts[0]);
            const s = Number(parts[1].replace('%', ''));
            const l = Number(parts[2].replace('%', ''));
            if (Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l)) {
              const [r, g, b] = _hslToRgb(h, s, l);
              return [Math.round(r), Math.round(g), Math.round(b), this.self?.opacity ?? 1];
            }
          }
        }

        return null;
      };

      const syncHexInput = (rgba) => {
        if (this.colorPickerHexInput) {
          this.colorPickerHexInput.value = _rgbToHex(rgba[0], rgba[1], rgba[2]).toUpperCase();
        }
      };

      const getWheelDiameter = () => {
        const bounds = container.getBoundingClientRect();
        const styles = getComputedStyle(container);
        const horizontalPadding = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
        const availableWidth = Math.floor((bounds.width || container.clientWidth || 0) - horizontalPadding);
        const maxDiameter = 200;
        const minDiameter = 120;
        return Math.max(minDiameter, Math.min(maxDiameter, availableWidth));
      };

      const getWheelMetrics = () => {
        const diameter = getWheelDiameter();
        const scale = diameter / 200;
        return {
          diameter,
          thickness: Math.max(12, Math.round(20 * scale)),
          handleDiameter: Math.max(12, Math.round(16 * scale))
        };
      };

      container.innerHTML = '';
      this._setupColorSlotControls(container);
      this._setupColorPickerHexInput(container);
      this.primaryColor = this.self?.color ? [...this.self.color] : [0, 0, 0, 1];
      this.activeColorSlot = 'primary';
      this._syncActiveColorSlot(this.primaryColor);
      this._updateColorSlotUI();
      syncHexInput(this.primaryColor);
      const initialMetrics = getWheelMetrics();
      const wheel = new ColorWheel({
        appendTo: container,
        rgb: this.self?.color ? this.self.color.slice(0, 3) : [0, 0, 0],
        wheelDiameter: initialMetrics.diameter,
        wheelThickness: initialMetrics.thickness,
        handleDiameter: initialMetrics.handleDiameter,
        wheelReflectsSaturation: false,
        onChange: (color) => {
          if (suppressChange) return;

          const rgb = this.hsvToRgb(color.hsv[0], color.hsv[1], color.hsv[2]);
          const opacity = this.ui.elements.opacitySlider?.value ? parseInt(this.ui.elements.opacitySlider.value) / 100 : 1;
          const rgba = [rgb.r, rgb.g, rgb.b, opacity];

          this.commitSelfEraserSegment(this.self.pressure, this.self.size, opacity);
          this.self.setColor(rgba);
          this.self.setOpacity(opacity);
          this._syncActiveColorSlot(rgba);
          syncHexInput(rgba);
          this.ui.updateSelfColor(rgba);
          this.ui.updateSelfTextStyle(this.self.size, rgba, this.self.font);
          this.ui.updateopacityValue(opacity);

          const { elements } = this.ui;
          if (elements.opacitySlider) {
            elements.opacitySlider.value = opacity * 100;
          }

          if (this.colorInputMenu) {
            this.colorInputMenu.updateColor(rgba);
          }

          const patternTool = this.toolManager.getTool('pattern');
          if (patternTool) {
            patternTool._tileCache.clear();
            patternTool.updatePreview(this.self);
          }

          const fillTool = this.toolManager.getTool('fill');
          if (fillTool && fillTool._patternTileCache) {
            fillTool._patternTileCache.clear();
          }

          const selectTool = this.toolManager.getTool('select');
          if (selectTool && selectTool._patternTileCache) {
            selectTool._patternTileCache.clear();
          }

          if (this.connected) {
            this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(rgba));
          }
        }
      });

      wheel.element = wheel.rootElement;
      wheel.setColor = (value, silent = false) => {
        const rgba = parseColorValue(value);
        if (!rgba) {
          console.warn('[App] Unsupported color picker value:', value);
          return;
        }

        suppressChange = silent;
        wheel.rgb = rgba.slice(0, 3);
        suppressChange = false;
        this._syncActiveColorSlot(rgba);
        syncHexInput(rgba);
      };

      const resizeWheel = () => {
        const nextMetrics = getWheelMetrics();
        if (
          nextMetrics.diameter === wheel.wheelDiameter &&
          nextMetrics.thickness === wheel.wheelThickness &&
          nextMetrics.handleDiameter === wheel.handleDiameter
        ) return;

        wheel.wheelDiameter = nextMetrics.diameter;
        wheel.wheelThickness = nextMetrics.thickness;
        wheel.handleDiameter = nextMetrics.handleDiameter;
        wheel.redraw();
      };

      this.colorPickerResizeObserver?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        this.colorPickerResizeObserver = new ResizeObserver(() => resizeWheel());
        this.colorPickerResizeObserver.observe(container);
      }

      this.colorPicker = wheel;
    } catch (err) {
      console.error('[App] Failed to setup color picker:', err);
    }
  }

  _setupColorSlotControls(container) {
    container.querySelector('.colorSlotControls')?.remove();

    const controls = document.createElement('div');
    controls.className = 'colorSlotControls';
    controls.innerHTML = `
      <button type="button" class="colorSlotSwatch secondary" data-slot="secondary" title="Secondary color"></button>
      <button type="button" class="colorSlotSwatch primary active" data-slot="primary" title="Primary color"></button>
      <button type="button" class="colorSlotSwap" title="Swap colors" aria-label="Swap primary and secondary colors"></button>
    `;

    const [secondaryButton, primaryButton, swapButton] = controls.children;
    primaryButton.addEventListener('click', () => this.selectColorSlot('primary'));
    secondaryButton.addEventListener('click', () => this.selectColorSlot('secondary'));
    swapButton.addEventListener('click', () => this.swapColorSlots());

    container.prepend(controls);
    this.colorSlotElements = {
      controls,
      primaryButton,
      secondaryButton,
      swapButton
    };
  }

  _setupColorPickerHexInput(container) {
    container.querySelector('.colorPickerHexField')?.remove();

    const field = document.createElement('div');
    field.className = 'colorPickerHexField';
    field.innerHTML = `
      <input id="colorPickerHexInput" type="text" inputmode="text" maxlength="6" spellcheck="false" autocomplete="off">
    `;

    const input = field.querySelector('input');
    const commitHex = () => {
      let hex = input.value.replace(/[^0-9A-Fa-f]/g, '');
      if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
      }
      if (hex.length === 0) {
        hex = _rgbToHex(this.self.color[0], this.self.color[1], this.self.color[2]);
      }
      while (hex.length < 6) {
        hex = `0${hex}`;
      }
      hex = hex.substring(0, 6).toUpperCase();
      input.value = hex;

      const color = [
        parseInt(hex.substring(0, 2), 16),
        parseInt(hex.substring(2, 4), 16),
        parseInt(hex.substring(4, 6), 16),
        this.self?.color?.[3] ?? 1
      ];
      this.handleColorInputChange(color);
    };

    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9A-Fa-f]/g, '').substring(0, 6).toUpperCase();
    });
    input.addEventListener('change', commitHex);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitHex();
        input.blur();
      }
    });

    container.prepend(field);
    this.colorPickerHexInput = input;
  }

  _syncActiveColorSlot(rgba) {
    const normalized = [...rgba];
    if (this.activeColorSlot === 'secondary') {
      this.secondaryColor = normalized;
    } else {
      this.primaryColor = normalized;
    }
    this._updateColorSlotUI();
  }

  _updateColorSlotUI() {
    if (!this.colorSlotElements) return;

    this.colorSlotElements.primaryButton.style.backgroundColor = `rgba(${this.primaryColor.join(',')})`;
    this.colorSlotElements.secondaryButton.style.backgroundColor = `rgba(${this.secondaryColor.join(',')})`;
    this.colorSlotElements.primaryButton.classList.toggle('active', this.activeColorSlot === 'primary');
    this.colorSlotElements.secondaryButton.classList.toggle('active', this.activeColorSlot === 'secondary');
  }

  selectColorSlot(slot) {
    if (slot !== 'primary' && slot !== 'secondary') return;

    this.activeColorSlot = slot;
    const color = slot === 'primary' ? [...this.primaryColor] : [...this.secondaryColor];
    this.handlePaletteColorSelect(color);
    this._updateColorSlotUI();
  }

  swapColorSlots() {
    [this.primaryColor, this.secondaryColor] = [this.secondaryColor, this.primaryColor];
    const currentSlot = this.activeColorSlot;
    this._updateColorSlotUI();
    this.selectColorSlot(currentSlot);
  }

  /**
   * Convert HSV to RGB.
   * @param {number} h - Hue (0-360)
   * @param {number} s - Saturation (0-100)
   * @param {number} v - Value (0-100)
   * @returns {Object} {r: 0-255, g: 0-255, b: 0-255}
   */
  hsvToRgb(h, s, v) {
    h = h / 360;
    s = s / 100;
    v = v / 100;

    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
    };
  }

  /**
   * Convert RGB to HSV.
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @returns {Array} [h: 0-360, s: 0-100, v: 0-100]
   */
  rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    let s = max === 0 ? 0 : (delta / max);
    let v = max;

    if (delta !== 0) {
      if (max === r) {
        h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
      } else if (max === g) {
        h = ((b - r) / delta + 2) / 6;
      } else {
        h = ((r - g) / delta + 4) / 6;
      }
    }

    return [h * 360, s * 100, v * 100];
  }

  /**
   * Sets up global event listeners for UI and board interactions.
   */
  setupEventListeners() {
    const { elements } = this.ui;
    this._ensureUserContextMenu();

    document.addEventListener('keydown', this._boundSuppressButtonKeyboardActivation, true);
    document.addEventListener('keyup', this._boundSuppressButtonKeyboardActivation, true);

    // Blur buttons/checkboxes after click so they don't capture keyboard focus (Space key, Ctrl+Z, etc)
    document.addEventListener('click', (e) => {
      const el = e.target.closest('button, [role="button"], input[type="checkbox"]');
      if (el) {
        setTimeout(() => el.blur(), 0);
      }
    }, true);

    // Also blur selects on change so keyboard-selected options don't keep focus trapped.
    document.addEventListener('change', (e) => {
      const select = e.target instanceof Element ? e.target.closest('select') : null;
      if (select) {
        setTimeout(() => select.blur(), 0);
      }
    }, true);

    // Form submit triggers join (both logged-in and not-logged-in join buttons are type="submit")
    elements.loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleJoin();
    });

    elements.disconnectBtn.addEventListener('click', () => this.disconnect());
    if (elements.recordBtn) {
      elements.recordBtn.addEventListener('click', () => this.handleStartRecording());
    }

    // Disconnection banner buttons
    if (elements.retryConnectionBtn) {
      elements.retryConnectionBtn.addEventListener('click', () => this.handleRetryConnection());
    }
    if (elements.switchToOfflineBtn) {
      elements.switchToOfflineBtn.addEventListener('click', () => this.handleSwitchToOffline());
    }

    if (elements.menuBtn) {
      this.bindPressAction(elements.menuBtn, (e) => {
        e.stopPropagation();
        this.ui.toggleMenu();
      });
    }

    if (elements.sidebarToggleBtn) {
      elements.sidebarToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ui.toggleSidebar();
        // Recalculate view after the sidebar transition finishes (approx 300ms)
        setTimeout(() => this.board.calculateDefaultView(), 350);
      });
    }

    if (elements.fullscreenBtn) {
      if (isTauriDesktop()) {
        elements.fullscreenBtn.style.display = 'none';
      } else {
        elements.fullscreenBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (document.fullscreenElement) {
              await document.exitFullscreen();
            } else {
              await document.documentElement.requestFullscreen();
            }
          } catch (err) {
            console.warn('[App] Fullscreen toggle failed:', err);
          }
        });
      }
    }

    elements.panBtn.addEventListener('click', () => this.selectTool('pan'));
    elements.zoomBtn.addEventListener('click', () => this.selectTool('zoom'));
    elements.rotateBtn.addEventListener('click', () => this.selectTool('rotate'));
    elements.selectBtn.addEventListener('click', () => this.selectTool('select'));
    elements.brushBtn.addEventListener('click', () => {
      this.selectTool(this.brushModeManager.getCurrentToolName());
    });
    elements.lineBtn.addEventListener('click', () => this.selectTool('line'));
    elements.rectangleBtn.addEventListener('click', () => this.selectTool('rectangle'));
    elements.circleBtn.addEventListener('click', () => this.selectTool('circle'));
    elements.textBtn.addEventListener('click', () => this.selectTool('text'));
    elements.fillBtn.addEventListener('click', () => this.selectTool('fill'));
    elements.eraseBtn.addEventListener('click', () => this.selectTool('erase'));
    elements.blurBtn.addEventListener('click', () => this.selectTool('blur'));
    elements.circleBlurBtn.addEventListener('click', () => this.selectTool('circleBlur'));
    elements.glitchBlurBtn.addEventListener('click', () => this.selectTool('glitchBlur'));
    elements.imageBrushBtn.addEventListener('click', () => this.selectTool('imageBrush'));
    if (elements.patternBtn) {
      elements.patternBtn.addEventListener('click', () => this.selectTool('pattern'));
    }
    elements.uploadBtn.addEventListener('click', async () => {
      if (!this.canUseImageFeatures(true)) return;
      if (isTauriDesktop()) {
        try {
          const selectedImage = await openImageViaNativeDialog();
          if (selectedImage?.dataUrl) {
            this.handleImageDataUrl(selectedImage.dataUrl);
          }
        } catch (error) {
          console.error('[Desktop] Native image import failed:', error);
          this.ui.showToast('Image picker failed, falling back to browser upload', 3000, 'error');
          elements.imageUploadInput.click();
        }
        return;
      }

      elements.imageUploadInput.click();
    });
    elements.imageUploadInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleImageFile(e.target.files[0]);
      }
    });
    elements.inkdropperBtn.addEventListener('click', () => this.selectTool('inkdropper'));

    // Clear/Dev/Perf/Mod buttons + mod panel are injected dynamically by
    // Moderation._injectModUI() when the user's role is confirmed as mod+.
    // Their event listeners are wired there, not here.

    this.bindPressAction(elements.resetBtn, () => this.handleResetBoard());
    this.bindPressAction(elements.flipCanvasBtn, () => this.handleToggleCanvasFlip());
    this.bindPressAction(elements.mirrorBtn, () => this.handleToggleMirror());
    if (elements.undoBtn) elements.undoBtn.addEventListener('click', () => this.handleUndo());
    elements.plusBtn.addEventListener('click', () => this.handleZoomIn());
    elements.minusBtn.addEventListener('click', () => this.handleZoomOut());
    elements.rotationResetBtn.addEventListener('click', () => this.handleResetBoard());
    elements.saveBtn.addEventListener('click', () => {
      if (appState.snapshotMenuVisible && this.snapshotPreviewCanvas) {
        this.openSaveDialogForCanvas(this.snapshotPreviewCanvas);
        return;
      }
      this.openSaveDialog();
    });
    if (elements.historyBtn) elements.historyBtn.addEventListener('click', () => this.historyPanel?.open());
    if (elements.saveModeCloseBtn) elements.saveModeCloseBtn.addEventListener('click', () => this.closeSaveDialog());
    if (elements.saveModeCancelBtn) elements.saveModeCancelBtn.addEventListener('click', () => this.closeSaveDialog());
    if (elements.saveModeOverlay) elements.saveModeOverlay.addEventListener('click', (e) => {
      if (e.target === elements.saveModeOverlay) this.closeSaveDialog();
    });
    if (elements.saveLocallyBtn) elements.saveLocallyBtn.addEventListener('click', () => this.performSave(true));
    if (elements.saveToGalleryBtn) elements.saveToGalleryBtn.addEventListener('click', () => this.performSave(false));

    // Undo/Redo HUD buttons
    if (elements.hudUndoBtn) elements.hudUndoBtn.addEventListener('click', () => this.handleUndo());
    if (elements.hudRedoBtn) elements.hudRedoBtn.addEventListener('click', () => this.handleRedo());

    elements.chatBtn.addEventListener('click', () => {
      if (focusChatPopout()) return;
      appState.chatVisible = !appState.chatVisible;
      if (appState.chatVisible) appState.chatUnreadCount = 0;
    });
    if (elements.adminTopBtn) {
      elements.adminTopBtn.addEventListener('click', () => {
        if (this.selfRole < 9) return;
        appState.adminPanelVisible = true;
      });
    }
    elements.inboxBtn.addEventListener('click', () => {
      if (this.selfRole < 1) return;
      appState.messengerVisible = !appState.messengerVisible;
    });
    elements.selfListUser.addEventListener('click', () => this.handleRenameself());

    this.ensureAppSettingsButton();
    const appSettingsBtn = document.getElementById('appSettingsBtn');
    if (appSettingsBtn) {
      appSettingsBtn.addEventListener('click', () => this.handleAppSettings());
    }
    this.scheduleTopbarCollapseUpdate();

    // Room settings button
    const roomSettingsBtn = document.getElementById('roomSettingsBtn');
    if (roomSettingsBtn) {
      roomSettingsBtn.addEventListener('click', () => this.handleRoomSettings());
    }

    // Register room button
    const registerRoomBtn = document.getElementById('registerRoomBtn');
    if (registerRoomBtn) {
      registerRoomBtn.addEventListener('click', () => this.handleRegisterRoom());
    }

    // Context menu button clicks
    if (elements.userContextMenu) {
      elements.userContextMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('.menuItem');
        if (btn) {
          this.moderation.handleMenuAction(btn.dataset.action, btn.dataset);
        }
      });
    }

    // Right-click on user list entries for context menu
    elements.userList.addEventListener('contextmenu', (e) => {
      const entry = e.target.closest('.userEntry');
      if (!entry) return;

      // Self entry — show self context menu with role info
      if (entry.classList.contains('self')) {
        e.preventDefault();
        e.stopPropagation();
        this._showSelfContextMenu(e);
        return;
      }

      if (entry.dataset.sessionIndex) {
        const sessionIndex = Number(entry.dataset.sessionIndex);
        const user = this.users.get(sessionIndex);
        this.moderation.showContextMenu(e, sessionIndex, user);
      }
    });

    // Click-outside to close context menu and mobile menu
    document.addEventListener('click', (e) => {
      const selfMenu = document.getElementById('selfContextMenu');
      if (selfMenu && !selfMenu.contains(e.target)) {
        selfMenu.style.display = 'none';
      }
      if (elements.userContextMenu && !elements.userContextMenu.contains(e.target)) {
        this.moderation.hideContextMenu();
      }
      if (elements.collapsibleBtns && !elements.collapsibleBtns.contains(e.target) && !elements.menuBtn.contains(e.target)) {
        this.ui.closeMenu();
      }
    });

    elements.sizeSlider.addEventListener('input', (e) => this.handleSizeChange(e));
    elements.spacingSlider.addEventListener('input', (e) => this.handleSpacingChange(e));
    elements.smoothingSlider.addEventListener('input', (e) => this.handleSmoothingChange(e));
    elements.hardnessSlider.addEventListener('input', (e) => this.handleHardnessChange(e));
    elements.opacitySlider.addEventListener('input', (e) => this.handleopacityChange(e));
    if (elements.blurRadiusSlider) {
      elements.blurRadiusSlider.addEventListener('input', (e) => this.handleBlurRadiusChange(e));
    }

    elements.brushFileInput.addEventListener('change', (e) => this.handleBrushFileLoad(e));

    if (elements.thinningSlider) {
      elements.thinningSlider.addEventListener('input', (e) => this.handleThinningChange(e));
    }
    if (elements.simulatePressureCheckbox) {
      elements.simulatePressureCheckbox.addEventListener('change', (e) => this.handleSimulatePressureChange(e));
    }

    // Dual pressure slider handlers
    const clampPressureSliders = () => {
      const minVal = Number(elements.pressureMinSlider.value);
      const maxVal = Number(elements.pressureMaxSlider.value);
      if (minVal > maxVal) {
        elements.pressureMinSlider.value = maxVal;
      }
      this.ui.updatePressureValue(
        Number(elements.pressureMinSlider.value),
        Number(elements.pressureMaxSlider.value)
      );
      this.clearActiveCustomPreset();
      this.updateCurrentToolPresetSettings();
    };
    elements.pressureMinSlider.addEventListener('input', clampPressureSliders);
    elements.pressureMaxSlider.addEventListener('input', clampPressureSliders);

    // Pressure enable/disable checkbox
    elements.pressureEnabled.addEventListener('change', () => {
      this.pressureEnabled = elements.pressureEnabled.checked;
      elements.pressureDualSlider.style.display = this.pressureEnabled ? '' : 'none';
      elements.pressureValue.style.display = this.pressureEnabled ? '' : 'none';
      this.clearActiveCustomPreset();
      this.updateCurrentToolPresetSettings();
    });

    // Thinning enable/disable checkbox
    if (elements.thinningEnabled) {
      elements.thinningEnabled.addEventListener('change', (e) => {
        // Update visibility
        if (elements.thinningSliderContainer) {
          elements.thinningSliderContainer.style.display = elements.thinningEnabled.checked ? '' : 'none';
        }
        if (elements.thinningValue) {
          elements.thinningValue.style.display = elements.thinningEnabled.checked ? '' : 'none';
        }
        // Update simulate pressure state
        const simulate = e.target.checked;
        this.self.setSimulatePressure(simulate);
        localStorage.setItem('topDrawSimulatePressure', simulate);
        if (this.connected) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSimulatePressureChange(simulate));
        }
      });
    }

    // Eraser mode radio buttons
    const eraserModeRadios = document.querySelectorAll('input[name="eraserMode"]');
    eraserModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.eraseAllLayers = (e.target.value === 'all');
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastEraserModeChange(this.eraseAllLayers, this.self.tool));
      });
    });

    // Brush mode radio buttons
    const brushModeRadios = document.querySelectorAll('input[name="brushMode"]');
    brushModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.brushModeManager.setMode(e.target.value);
      });
    });

    // Shape draw mode radio buttons
    const shapeDrawModeRadios = document.querySelectorAll('input[name="shapeDrawMode"]');
    shapeDrawModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.applyShapeDrawMode(e.target.value, { broadcast: true, persist: true });
      });
    });


    // Fill advanced mode checkbox
    const fillAdvancedCheck = document.getElementById('fillAdvancedCheck');
    const fillAdvancedSettings = document.getElementById('fillAdvancedSettings');
    if (fillAdvancedCheck) {
      // Sync checkbox to tool's default (advanced on by default)
      const fillTool = this.toolManager.getTool('fill');
      if (fillTool) {
        fillAdvancedCheck.checked = fillTool.advancedMode;
        if (fillAdvancedSettings) fillAdvancedSettings.style.display = fillTool.advancedMode ? 'block' : 'none';
      }
      fillAdvancedCheck.addEventListener('change', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        if (fillTool) fillTool.advancedMode = e.target.checked; // setter resets values when disabled
        if (fillAdvancedSettings) fillAdvancedSettings.style.display = e.target.checked ? 'block' : 'none';
      });
    }

    // Fill advanced sliders
    const fillExpansionSlider = document.getElementById('fillExpansionSlider');
    const fillExpansionValue = document.getElementById('fillExpansionValue');
    if (fillExpansionSlider) {
      fillExpansionSlider.addEventListener('input', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        const val = Math.round(Number(e.target.value) * 10) / 10;
        if (fillTool) fillTool._expansion = val;
        if (fillExpansionValue) fillExpansionValue.textContent = val;
      });
    }
    const fillBlurSlider = document.getElementById('fillBlurSlider');
    const fillBlurValue = document.getElementById('fillBlurValue');
    if (fillBlurSlider) {
      fillBlurSlider.addEventListener('input', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        const val = Math.round(Number(e.target.value) * 10) / 10;
        if (fillTool) fillTool._blurRadius = val;
        if (fillBlurValue) fillBlurValue.textContent = val.toFixed(1);
      });
    }

    // Fill pattern mode checkbox
    const fillPatternCheck = document.getElementById('fillPatternCheck');
    const fillPatternSettings = document.getElementById('fillPatternSettings');
    if (fillPatternCheck) {
      const fillTool = this.toolManager.getTool('fill');
      if (fillTool) {
        fillPatternCheck.checked = fillTool.patternMode || false;
        if (fillPatternSettings) fillPatternSettings.style.display = fillTool.patternMode ? 'block' : 'none';
      }
      fillPatternCheck.addEventListener('change', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        if (fillTool) fillTool.patternMode = e.target.checked;
        if (fillPatternSettings) fillPatternSettings.style.display = e.target.checked ? 'block' : 'none';

        this.self.patternMode = e.target.checked;
        if (this.connected && this.wsClient) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternMode(e.target.checked));
        }

        appState.patternPreviewVisible = e.target.checked;
        const patternTool = this.toolManager.getTool('pattern');
        if (patternTool && e.target.checked) {
          patternTool.updatePreview(this.self);
        }
      });
    }

    // Selection pattern mode checkbox
    const selectionPatternCheck = document.getElementById('selectionPatternCheck');
    const selectionPatternSettings = document.getElementById('selectionPatternSettings');
    if (selectionPatternCheck) {
      const selectTool = this.toolManager.getTool('select');
      if (selectTool) {
        selectionPatternCheck.checked = selectTool.patternMode || false;
        if (selectionPatternSettings) selectionPatternSettings.style.display = selectTool.patternMode ? 'block' : 'none';
      }
      selectionPatternCheck.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) selectTool.patternMode = e.target.checked;
        if (selectionPatternSettings) selectionPatternSettings.style.display = e.target.checked ? 'block' : 'none';

        // Sync pattern mode to user object and broadcast
        this.self.patternMode = e.target.checked;
        if (this.connected && this.wsClient) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternMode(e.target.checked));
        }

        // Show/hide pattern preview window
        appState.patternPreviewVisible = e.target.checked;

        // Update preview if pattern tool exists
        const patternTool = this.toolManager.getTool('pattern');
        if (patternTool && e.target.checked) {
          patternTool.updatePreview(this.self);
        }
      });
    }

    // Blend mode select
    if (elements.blendModeSelect) {
      elements.blendModeSelect.addEventListener('change', (e) => {
        // Only handle user-initiated changes, not programmatic updates
        if (!this.ui._updatingBlendMode) {
          this.handleBlendModeChange(e.target.value);
        }
      });
    }

    // Layer selection buttons
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const layerIndex = parseInt(btn.dataset.layer);
        this.handleLayerSelect(layerIndex);
      });
    });

    // Layer visibility toggles
    const layerVisibilityButtons = document.querySelectorAll('.layerVisibility');
    layerVisibilityButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const layerIndex = parseInt(btn.dataset.layer);
        const visible = this.handleLayerVisibilityToggle(layerIndex);
        btn.classList.toggle('is-hidden', !visible);
      });
    });

    // Editable slider values
    this.ui.makeValueEditable(elements.sizeValue, {
      min: 0.25, max: 100, step: 0.25, suffix: '',
      dragStep: (val) => val >= 5 ? 1 : 0.5,
      onCommit: (val) => {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSizeChange(val));
        if (this.self.mousedown && this.self.tool === 'brush') {
          this.commitSelfLine(this.self.pressure, val);
        }
        this.self.setSize(val);
        elements.sizeSlider.value = val;
        this.ui.updateCursorSize(val);
        this.ui.updateSelfTextStyle(val, this.self.color, this.self.font);
        this.board.mainCtx.lineWidth = val * 2;
      }
    });

    // Keeping the text tuning controls dormant for now.
    // if (elements.textPositionMultiplierSlider) {
    //   elements.textPositionMultiplierSlider.addEventListener('input', (e) => {
    //     this.handleTextPositionMultiplierChange(Number(e.target.value));
    //   });
    //   this.ui.makeValueEditable(elements.textPositionMultiplierValue, {
    //     min: -1,
    //     max: 1,
    //     step: 0.01,
    //     suffix: '',
    //     onCommit: (val) => this.handleTextPositionMultiplierChange(val)
    //   });
    // }

    // if (elements.textPositionOffsetSlider) {
    //   elements.textPositionOffsetSlider.addEventListener('input', (e) => {
    //     this.handleTextPositionOffsetChange(Number(e.target.value));
    //   });
    //   this.ui.makeValueEditable(elements.textPositionOffsetValue, {
    //     min: -20,
    //     max: 20,
    //     step: 0.25,
    //     suffix: '',
    //     onCommit: (val) => this.handleTextPositionOffsetChange(val)
    //   });
    // }

    this.ui.makeValueEditable(elements.smoothingValue, {
      min: 0, max: 50, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setSmoothing(val);
        elements.smoothingSlider.value = val;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSmoothingChange(val));
      }
    });

    this.ui.makeValueEditable(elements.spacingValue, {
      min: 0, max: 50, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setSpacing(val);
        elements.spacingSlider.value = val;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSpacingChange(val));
      }
    });

    this.ui.makeValueEditable(elements.hardnessValue, {
      min: 0, max: 100, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setHardness(val);
        elements.hardnessSlider.value = val;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHardnessChange(val));
      }
    });

    this.ui.makeValueEditable(elements.opacityValue, {
      min: 0, max: 100, step: 1, suffix: '%',
      onCommit: (val) => {
        const opacity = val / 100;
        this.commitSelfEraserSegment(this.self.pressure, this.self.size, opacity);
        this.self.setOpacity(opacity);
        elements.opacitySlider.value = val;
        const currentColor = [...this.self.color];
        currentColor[3] = opacity;
        this.self.setColor(currentColor);
        this.colorPicker.setColor(`rgba(${currentColor.join(',')})`);
        if (this.connected) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(currentColor));
        }
      }
    });

    if (elements.blurRadiusValue) {
      this.ui.makeValueEditable(elements.blurRadiusValue, {
        min: 1, max: () => this.getBlurRadiusMaxForTool(), step: 1, suffix: '',
        onCommit: (val) => {
          const radius = this.setSelfBlurRadiusForCurrentTool(val);
          elements.blurRadiusSlider.value = radius;
          if (this.connected) {
            this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBlurRadiusChange(radius));
          }
        }
      });
    }

    // Pressure range value: drag to adjust max pressure, click to edit both
    {
      const pressureSpan = elements.pressureValue;
      const DRAG_THRESHOLD = 3;
      let dragState = null;

      const openPressureEditor = () => {
        if (pressureSpan.querySelector('.sliderValueInput')) return;

        const minVal = Number(elements.pressureMinSlider.value);
        const maxVal = Number(elements.pressureMaxSlider.value);
        const originalText = pressureSpan.textContent;

        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.className = 'sliderValueInput';
        minInput.min = 0;
        minInput.max = 100;
        minInput.step = 1;
        minInput.value = minVal;
        minInput.style.width = '36px';

        const sep = document.createTextNode('-');

        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.className = 'sliderValueInput';
        maxInput.min = 0;
        maxInput.max = 100;
        maxInput.step = 1;
        maxInput.value = maxVal;
        maxInput.style.width = '36px';

        pressureSpan.textContent = '';
        pressureSpan.appendChild(minInput);
        pressureSpan.appendChild(sep);
        pressureSpan.appendChild(maxInput);
        minInput.focus();
        minInput.select();

        const commit = () => {
          let mn = Math.max(0, Math.min(100, parseInt(minInput.value) || 0));
          let mx = Math.max(0, Math.min(100, parseInt(maxInput.value) || 100));
          if (mn > mx) mn = mx;
          elements.pressureMinSlider.value = mn;
          elements.pressureMaxSlider.value = mx;
          this.ui.updatePressureValue(mn, mx);
        };

        const cancel = () => {
          pressureSpan.textContent = originalText;
        };

        const onKey = (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            minInput.removeEventListener('blur', onBlur);
            maxInput.removeEventListener('blur', onBlur);
            commit();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            minInput.removeEventListener('blur', onBlur);
            maxInput.removeEventListener('blur', onBlur);
            cancel();
          }
          ke.stopPropagation();
        };

        const onBlur = (be) => {
          setTimeout(() => {
            if (document.activeElement !== minInput && document.activeElement !== maxInput) {
              commit();
            }
          }, 0);
        };

        minInput.addEventListener('keydown', onKey);
        maxInput.addEventListener('keydown', onKey);
        minInput.addEventListener('blur', onBlur);
        maxInput.addEventListener('blur', onBlur);
      };

      pressureSpan.addEventListener('pointerdown', (e) => {
        if (pressureSpan.querySelector('.sliderValueInput')) return;
        e.preventDefault();

        dragState = {
          startY: e.clientY,
          startMax: Number(elements.pressureMaxSlider.value),
          startMin: Number(elements.pressureMinSlider.value),
          dragging: false,
          pointerId: e.pointerId
        };

        pressureSpan.setPointerCapture(e.pointerId);
      });

      pressureSpan.addEventListener('pointermove', (e) => {
        if (!dragState) return;

        const dy = dragState.startY - e.clientY;

        if (!dragState.dragging) {
          if (Math.abs(dy) < DRAG_THRESHOLD) return;
          dragState.dragging = true;
          pressureSpan.classList.add('dragging');
          document.body.classList.add('parameter-dragging');
        }

        let sensitivity = 1;
        if (e.shiftKey) sensitivity = 10;
        else if (e.altKey) sensitivity = 0.1;

        let mx = Math.round(dragState.startMax + dy * sensitivity);
        mx = Math.max(dragState.startMin, Math.min(100, mx));

        elements.pressureMaxSlider.value = mx;
        this.ui.updatePressureValue(dragState.startMin, mx);
      });

      const endPressureDrag = () => {
        if (!dragState) return;
        const wasDragging = dragState.dragging;
        pressureSpan.classList.remove('dragging');
        document.body.classList.remove('parameter-dragging');
        dragState = null;

        if (!wasDragging) {
          openPressureEditor();
        }
      };

      pressureSpan.addEventListener('pointerup', endPressureDrag);
      pressureSpan.addEventListener('pointercancel', endPressureDrag);
    }

    // Selection mode radio buttons
    const selectionModeRadios = document.querySelectorAll('input[name="selectionMode"]');
    selectionModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.setMode(e.target.value);
        }
      });
    });

    // Layer mode radio buttons for select tool
    document.querySelectorAll('input[name="selectionLayerMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.toggleCopyAllLayers(e.target.value === 'all');
        }
      });
    });

    if (elements.cursorStyleSelect) {
      elements.cursorStyleSelect.addEventListener('change', (e) => {
        this.handleCursorStyleChange(e.target.value);
      });
    }

    // Lock button event listeners
    const handleLockClick = (property, e) => {
      if (e.shiftKey) {
        this.toolLockManager.toggleAllLocksForCurrentTool(property);
      } else {
        this.toolLockManager.toggleLock(property);
      }
    };
    if (elements.sizeLock) elements.sizeLock.addEventListener('click', (e) => handleLockClick('size', e));
    if (elements.pressureLock) elements.pressureLock.addEventListener('click', (e) => handleLockClick('pressure', e));
    if (elements.smoothingLock) elements.smoothingLock.addEventListener('click', (e) => handleLockClick('smoothing', e));
    if (elements.spacingLock) elements.spacingLock.addEventListener('click', (e) => handleLockClick('spacing', e));
    if (elements.hardnessLock) elements.hardnessLock.addEventListener('click', (e) => handleLockClick('hardness', e));
    if (elements.opacityLock) elements.opacityLock.addEventListener('click', (e) => handleLockClick('opacity', e));
    if (elements.blurRadiusLock) elements.blurRadiusLock.addEventListener('click', (e) => handleLockClick('blurRadius', e));
    if (elements.thinningLock) elements.thinningLock.addEventListener('click', (e) => handleLockClick('thinning', e));

    elements.board.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    window.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    window.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    window.addEventListener('pointercancel', (e) => this.handlePointerUp(e));
    window.addEventListener('keydown', (e) => this.updateModifierKeysFromEvent(e), true);
    window.addEventListener('keyup', (e) => this.updateModifierKeysFromEvent(e), true);
    window.addEventListener('blur', () => this.clearModifierKeys());

    elements.board.addEventListener('pointerenter', (e) => {
      this.syncBoardHoverState(true, { forceRefresh: true, event: e });
    });
    elements.board.addEventListener('pointerleave', (e) => this.handlePointerLeave(e));

    elements.board.addEventListener('wheel', (e) => this.handleWheel(e));
    elements.board.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.self.tool !== 'pan' && this.self.tool !== 'rotate') {
        this.cancelCurrentStroke();
      }
    });
    elements.boardContainer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.self.tool !== 'pan' && this.self.tool !== 'rotate') {
        this.cancelCurrentStroke();
      }
    });

    // boardContainer: middle-click to pan anywhere, and pan/rotate by dragging the background
    elements.boardContainer.addEventListener('pointerdown', (e) => this.handleBoardContainerPointerDown(e));
    elements.boardContainer.addEventListener('pointermove', (e) => this.handleBoardContainerPointerMove(e));
    elements.boardContainer.addEventListener('pointerup', (e) => this.handleBoardContainerPointerUp(e));
    elements.boardContainer.addEventListener('pointercancel', () => { this._containerPanActive = false; });

    // Touch gestures are now handled by Hammer.js in TouchHandler.init()

    // Hidden input for touch keyboard (text tool)
    if (elements.touchInput) {
      elements.touchInput.addEventListener('beforeinput', (e) => this.touchHandler.handleTouchBeforeInput(e));
      elements.touchInput.addEventListener('blur', () => this.touchHandler.handleTouchInputBlur());
    }

    // Initialize keyboard handler
    this.keyboardHandler.init();

    // Drag and drop images
    elements.boardContainer.addEventListener('dragenter', (e) => this.handleBoardImageDragEnter(e));
    elements.boardContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.handleBoardImageDragOver(e);
      e.dataTransfer.dropEffect = 'copy';
    });
    elements.boardContainer.addEventListener('dragleave', (e) => this.handleBoardImageDragLeave(e));
    elements.boardContainer.addEventListener('drop', (e) => this.handleImageDrop(e));

    window.addEventListener('resize', () => this.handleResize());

    window.addEventListener('beforeunload', (e) => {
      if (!this._warnOnNextUnload) return;

      e.preventDefault();
      e.returnValue = '';

      // If the user stays on the page, clear the flag on the next tick so
      // normal tab close behavior is preserved until they press Ctrl/Cmd+R again.
      setTimeout(() => {
        this._warnOnNextUnload = false;
      }, 0);
    });

    // Push a sentinel state so the back button doesn't immediately leave the page.
    // On popstate (back/forward), show a confirmation dialog instead of navigating away.
    if (!window.history.state?._topDrawSentinel) {
      window.history.pushState({ _topDrawSentinel: true }, '');
    }
    window.addEventListener('popstate', (e) => {
      if (!e.state?._topDrawSentinel) {
        // Re-push sentinel so back button is re-armed
        window.history.pushState({ _topDrawSentinel: true }, '');
        if (window.confirm('Are you sure you want to leave DDraw?')) {
          window.history.go(-2);
        }
      }
    });

    // Pattern options listeners
    if (elements.patternScaleSlider) {
      elements.patternScaleSlider.addEventListener('input', (e) => this.handlePatternScaleChange(e));
    }
    if (elements.patternTypeSelect) {
      elements.patternTypeSelect.addEventListener('change', (e) => this.handlePatternTypeChange(e));
    }
    if (elements.patternImageBtn) {
      elements.patternImageBtn.addEventListener('click', () => this.handlePatternImageBtnClick());
    }
    if (elements.patternImageUploadInput) {
      elements.patternImageUploadInput.addEventListener('change', (e) => this.handlePatternImageUpload(e));
    }
    if (elements.patternShapeUploadBtn) {
      elements.patternShapeUploadBtn.addEventListener('click', () => this.handlePatternShapeUploadBtnClick());
    }
    if (elements.patternShapeUploadInput) {
      elements.patternShapeUploadInput.addEventListener('change', (e) => this.handlePatternShapeUpload(e));
    }
    if (elements.patternRotationSlider) {
      elements.patternRotationSlider.addEventListener('input', (e) => this.handlePatternRotationChange(e));
    }
    if (elements.patternSpacingSlider) {
      elements.patternSpacingSlider.addEventListener('input', (e) => this.handlePatternSpacingChange(e));
    }
    if (elements.patternOffsetXSlider) {
      elements.patternOffsetXSlider.addEventListener('input', (e) => this.handlePatternOffsetXChange(e));
    }
    if (elements.patternOffsetYSlider) {
      elements.patternOffsetYSlider.addEventListener('input', (e) => this.handlePatternOffsetYChange(e));
    }
    if (elements.patternColorModeRadios) {
      elements.patternColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handlePatternColorModeChange(e));
      });
    }

    // Fill pattern settings (reuse same handlers as pattern tool since they share user properties)
    if (elements.fillPatternScaleSlider) {
      elements.fillPatternScaleSlider.addEventListener('input', (e) => this.handlePatternScaleChange(e));
    }
    if (elements.fillPatternRotationSlider) {
      elements.fillPatternRotationSlider.addEventListener('input', (e) => this.handlePatternRotationChange(e));
    }
    if (elements.fillPatternSpacingSlider) {
      elements.fillPatternSpacingSlider.addEventListener('input', (e) => this.handlePatternSpacingChange(e));
    }
    if (elements.fillPatternOffsetXSlider) {
      elements.fillPatternOffsetXSlider.addEventListener('input', (e) => this.handlePatternOffsetXChange(e));
    }
    if (elements.fillPatternOffsetYSlider) {
      elements.fillPatternOffsetYSlider.addEventListener('input', (e) => this.handlePatternOffsetYChange(e));
    }
    if (elements.fillPatternColorModeRadios) {
      elements.fillPatternColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handlePatternColorModeChange(e));
      });
    }

    // Selection pattern settings (reuse same handlers as pattern tool since they share user properties)
    if (elements.selectionPatternScaleSlider) {
      elements.selectionPatternScaleSlider.addEventListener('input', (e) => this.handlePatternScaleChange(e));
    }
    if (elements.selectionPatternRotationSlider) {
      elements.selectionPatternRotationSlider.addEventListener('input', (e) => this.handlePatternRotationChange(e));
    }
    if (elements.selectionPatternSpacingSlider) {
      elements.selectionPatternSpacingSlider.addEventListener('input', (e) => this.handlePatternSpacingChange(e));
    }
    if (elements.selectionPatternOffsetXSlider) {
      elements.selectionPatternOffsetXSlider.addEventListener('input', (e) => this.handlePatternOffsetXChange(e));
    }
    if (elements.selectionPatternOffsetYSlider) {
      elements.selectionPatternOffsetYSlider.addEventListener('input', (e) => this.handlePatternOffsetYChange(e));
    }
    if (elements.selectionPatternColorModeRadios) {
      elements.selectionPatternColorModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => this.handlePatternColorModeChange(e));
      });
    }
  }

  handlePatternScaleChange(e) {
    const scale = Number(e.target.value);
    this.self.patternScale = scale;
    if (this.ui.elements.patternScaleValue) {
      this.ui.elements.patternScaleValue.textContent = `${scale}%`;
    }
    if (this.ui.elements.fillPatternScaleValue) {
      this.ui.elements.fillPatternScaleValue.textContent = `${scale}%`;
    }
    if (this.ui.elements.selectionPatternScaleValue) {
      this.ui.elements.selectionPatternScaleValue.textContent = `${scale}%`;
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool && patternTool.updatePreview) {
      patternTool.updatePreview(this.self);
    }

    if (this.connected && this.self.patternBrush) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  handlePatternImageBtnClick() {
    if (!this.canUseImageFeatures(true)) return;
    this.ui.elements.patternImageUploadInput?.click();
  }

  handlePatternImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!this.canUseImageFeatures(true)) {
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const customBrush = assetLibrary.addCustomAsset({
          kind: 'pattern',
          type: 'image',
          fileName: file.name,
          fileType: file.name.split('.').pop().toLowerCase(),
          dataUrl: event.target.result,
          gimpUrl: event.target.result,
          brushName: file.name.replace(/\.[^/.]+$/, '') || 'Uploaded Image'
        });
        const runtimeBrush = {
          ...customBrush,
          type: 'image',
          image: img,
          gimpUrl: event.target.result,
          width: img.width,
          height: img.height
        };
        this.patternGallery.registerBrush(runtimeBrush);
        this.handlePatternBrushSelect(runtimeBrush);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  handlePatternRotationChange(e) {
    const rotation = Number(e.target.value);
    this.self.patternRotation = rotation;
    if (this.ui.elements.patternRotationValue) {
      this.ui.elements.patternRotationValue.textContent = `${rotation}°`;
    }
    if (this.ui.elements.fillPatternRotationValue) {
      this.ui.elements.fillPatternRotationValue.textContent = `${rotation}°`;
    }
    if (this.ui.elements.selectionPatternRotationValue) {
      this.ui.elements.selectionPatternRotationValue.textContent = `${rotation}°`;
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool && patternTool.updatePreview) {
      patternTool.updatePreview(this.self);
    }

    if (this.connected && this.self.patternBrush) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  handlePatternSpacingChange(e) {
    const spacing = Number(e.target.value);
    this.self.patternSpacing = spacing;
    if (this.ui.elements.patternSpacingValue) {
      this.ui.elements.patternSpacingValue.textContent = spacing;
    }
    if (this.ui.elements.fillPatternSpacingValue) {
      this.ui.elements.fillPatternSpacingValue.textContent = spacing;
    }
    if (this.ui.elements.selectionPatternSpacingValue) {
      this.ui.elements.selectionPatternSpacingValue.textContent = spacing;
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool && patternTool.updatePreview) {
      patternTool.updatePreview(this.self);
    }

    if (this.connected && this.self.patternBrush) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  handlePatternOffsetXChange(e) {
    const offsetX = Number(e.target.value);
    this.self.patternOffsetX = offsetX;
    if (this.ui.elements.patternOffsetXValue) {
      this.ui.elements.patternOffsetXValue.textContent = offsetX;
    }
    if (this.ui.elements.fillPatternOffsetXValue) {
      this.ui.elements.fillPatternOffsetXValue.textContent = offsetX;
    }
    if (this.ui.elements.selectionPatternOffsetXValue) {
      this.ui.elements.selectionPatternOffsetXValue.textContent = offsetX;
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool && patternTool.updatePreview) {
      patternTool.updatePreview(this.self);
    }

    if (this.connected && this.self.patternBrush) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  handlePatternOffsetYChange(e) {
    const offsetY = Number(e.target.value);
    this.self.patternOffsetY = offsetY;
    if (this.ui.elements.patternOffsetYValue) {
      this.ui.elements.patternOffsetYValue.textContent = offsetY;
    }
    if (this.ui.elements.fillPatternOffsetYValue) {
      this.ui.elements.fillPatternOffsetYValue.textContent = offsetY;
    }
    if (this.ui.elements.selectionPatternOffsetYValue) {
      this.ui.elements.selectionPatternOffsetYValue.textContent = offsetY;
    }

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool && patternTool.updatePreview) {
      patternTool.updatePreview(this.self);
    }

    if (this.connected && this.self.patternBrush) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  handlePatternColorModeChange(e) {
    const colorMode = e.target.value;
    this.self.patternColorMode = colorMode;

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      // Clear cache so tiles are regenerated with new color mode
      patternTool._tileCache.clear();
      if (patternTool.updatePreview) {
        patternTool.updatePreview(this.self);
      }
    }

    // Sync all radio groups (pattern, fill pattern, and selection pattern)
    document.querySelectorAll('input[name="patternColorMode"], input[name="fillPatternColorMode"], input[name="selectionPatternColorMode"]').forEach(r => r.checked = r.value === colorMode);

    if (this.connected && this.self.patternBrush) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  _buildPatternPayload() {
    const brush = this.self.patternBrush;
    if (!brush) return null;
    // Strip non-serializable Image/HTMLImageElement references, keep data URLs
    const brushData = { type: brush.type, brushName: brush.brushName, fileName: brush.fileName, width: brush.width, height: brush.height };
    if (brush.gimpUrl) brushData.gimpUrl = brush.gimpUrl;
    if (brush.svgContent) brushData.svgContent = brush.svgContent;
    if (brush.colorDepth !== undefined) brushData.colorDepth = brush.colorDepth;
    if (brush.gBrushes) brushData.gBrushes = brush.gBrushes.map(b => ({ gimpUrl: b.gimpUrl, width: b.width, height: b.height }));
    return {
      brush: brushData,
      scale: this.self.patternScale ?? 100,
      rotation: this.self.patternRotation ?? 0,
      spacing: this.self.patternSpacing ?? 0,
      offsetX: this.self.patternOffsetX ?? 0,
      offsetY: this.self.patternOffsetY ?? 0,
      colorMode: this.self.patternColorMode ?? 'original'
    };
  }

  handlePatternBrushSelect(brush) {
    this.self.patternBrush = brush;

    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool && patternTool.updatePreview) {
      patternTool.updatePreview(this.self);
    }

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
    }
  }

  // Room selection

  /**
   * Handles room selection and initiates connection.
   * @async
   * @param {string} roomId - The ID of the room to join.
   * @param {string} [password=null] - The room password, if any.
   * @returns {Promise<void>}
   */
  async handleRoomSelected(roomId, password = null, pendingSettings = null) {
    // Handle /go/offline as draw alone mode
    if (roomId === 'offline') {
      this.handleOffline();
      return;
    }

    this.resetRoomState({ preserveRemoteVisuals: false, clearBoard: true });

    this.isOfflineMode = false;
    this.currentRoomId = roomId;
    this.currentRoomPassword = password;
    this._pendingRoomSettings = pendingSettings || null;

    const usernameInput = this.ui.elements.loginUsername;
    if (usernameInput && usernameInput.value && !this.self.username) {
      const username = usernameInput.value.trim() || 'Guest';
      this.self.setUsername(username);
    }

    this.users.clear();
    this.connected = false;
    this.sessionIndex = null;
    if (this.self) this.self.id = null;

    this.syncClient.showOverlay();
    this.syncClient.updateProgress('Connecting...');

    const versionStatus = await ensureClientCanConnect({ showWarning: true });
    if (!versionStatus.allowed) {
      this.syncClient.hideOverlay();
      this.showUpdateRequiredNotice(versionStatus);
      if (this.landingPage) {
        this.landingPage.show();
        this.landingPage.showError(formatOutdatedClientMessage(versionStatus));
        this.landingPage.updateConnectionStatus('disconnected');
      }
      return;
    }

    try {
      await this.wsClient.connect(this.self.toJSON(), roomId);
    } catch (err) {
      console.error('Failed to connect to room:', err);
      this.ui.showToast('Failed to connect to room', 3000);
      if (this.landingPage) {
        this.landingPage.show();
        this.connectForRoomDiscovery();
      }
    }
  }

  /**
   * Starts a room join from the landing page without waiting for discovery to connect.
   * @param {string|null} [roomId=null] - Explicit room to join, or current landing selection.
   * @param {string|null} [password=null] - Optional password to use for auth-on-connect.
   * @returns {Promise<void>}
   */
  async startLandingJoin(roomId = null, password = null) {
    let resolvedRoomId = roomId || this.landingPage?.els.roomIdInput?.value.trim() || this.landingPage?.selectedRoom || 'lobby';

    if (resolvedRoomId !== 'lobby') {
      if (!/^[a-zA-Z0-9_-]+$/.test(resolvedRoomId)) {
        this.landingPage?.showError('Room name can only contain letters, numbers, dashes, and underscores');
        return;
      }
      if (resolvedRoomId.length < 2 || resolvedRoomId.length > 20) {
        this.landingPage?.showError('Room name must be 2-20 characters');
        return;
      }
    }

    let name = this.auth?.getJoinUsername();
    if (!name) {
      name = this.ui.elements.loginUsername?.value.trim();
    }
    if (!name) {
      let tabId = sessionStorage.getItem('tabId');
      if (!tabId) {
        tabId = Math.random().toString(36).substring(2, 8);
        sessionStorage.setItem('tabId', tabId);
      }
      name = `Guest-${tabId}`;
    }

    this.self.setUsername(name);

    const pendingPassword = password ?? ((!this.auth?.isLoggedIn && this.ui.elements.loginPassword?.value) || '');
    this._pendingPassword = pendingPassword || null;
    this.landingPage?.clearError();

    if (this.landingPage) {
      this.landingPage.selectRoom(resolvedRoomId);
      this.landingPage.hide();
    }

    const newPath = resolvedRoomId === 'offline' ? '/go/offline' : `/go/${resolvedRoomId}`;
    if (window.location.pathname !== newPath) {
      window.history.pushState({ room: resolvedRoomId }, '', newPath);
    }

    await this.handleRoomSelected(resolvedRoomId, password);
  }

  /**
   * Authenticates from the landing page without immediately joining a room.
   */
  async handleLandingLogin() {
    if (!this.auth || this.auth.isLoggedIn) return;

    const username = this.ui.elements.loginUsername?.value.trim();
    const password = this.ui.elements.loginPassword?.value;

    if (!username || !password) {
      this.landingPage?.showError('Please enter username and password');
      return;
    }

    this.landingPage?.clearError();

    if (this.wsClient.connected && (!this.currentRoomId || this.currentRoomId === '_discovery')) {
      this.auth.handleLogin();
      return;
    }

    this._pendingLandingLogin = true;
    await this.connectForRoomDiscovery();
  }

  /**
   * Starts the application in offline (local-only) mode.
   * If the user has entered credentials, attempts to authenticate first.
   */
  async handleOffline() {
    const hasPassword = !this.auth?.isLoggedIn && this.ui.elements.loginPassword?.value;
    const hasToken = this.auth?.getStoredToken();

    // If user has credentials or a stored token, try to authenticate before going offline
    if (hasPassword || hasToken) {
      await this._authenticateThenGoOffline();
      return;
    }

    this._enterOfflineMode();
  }

  /**
   * Attempts to connect and authenticate, then enters offline mode regardless of outcome.
   */
  async _authenticateThenGoOffline() {
    this._pendingOffline = true;

    // Safety timeout — if auth doesn't complete in 5s, go offline anyway
    this._offlineAuthTimeout = setTimeout(() => {
      if (this._pendingOffline) {
        console.log('[App] Auth timed out before offline mode');
        this._pendingOffline = false;
        this._enterOfflineMode();
      }
    }, 5000);

    try {
      // Connect to discovery room for authentication
      await this.wsClient.connect(this.self.toJSON(), '_discovery');
      // handleWSConnect will trigger login; auth result will call _enterOfflineMode
    } catch (err) {
      console.log('[App] Could not connect for auth before offline mode:', err.message);
      clearTimeout(this._offlineAuthTimeout);
      this._pendingOffline = false;
      this._enterOfflineMode();
    }
  }

  /**
   * Actually enters offline drawing mode.
   */
  _enterOfflineMode() {
    console.log('[App] Draw Alone mode - creating local room');
    this.resetRoomState({ preserveRemoteVisuals: false, clearBoard: true });
    this.isOfflineMode = true;
    this.connected = false;
    this.currentRoomId = 'offline-' + Date.now();

    // Cancel any pending auth attempt so it doesn't interrupt offline drawing
    this.auth?.setLoading(false);

    if (this.wsClient) {
      this.wsClient.disconnect();
    }

    this.sessionIndex = 0;
    this.self.id = 0;
    const offlineUsername = this.auth?.getJoinUsername() || this.ui.elements.loginUsername?.value.trim() || '';
    this.self.setUsername(offlineUsername);
    this.users.set(0, this.self);

    if (this.landingPage) {
      this.landingPage.hide();
    }

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(offlineUsername);
    this.ui.showConnectionStatus('offline');

    this.inputBufferManager.startTickLoop();
    if (!this._visibilityEligibilityHandler && typeof document !== 'undefined') {
      this._visibilityEligibilityHandler = () => this._updatePreviewUploadEligibility();
      document.addEventListener('visibilitychange', this._visibilityEligibilityHandler);
    }

    // Update URL to /go/offline
    if (window.location.pathname !== '/go/offline') {
      window.history.pushState({ room: 'offline' }, '', '/go/offline');
    }
  }

  /**
   * Connects to the discovery room to fetch the list of available rooms.
   * @async
   * @returns {Promise<void>}
   */
  async connectForRoomDiscovery() {
    this.currentRoomId = null;
    TimeMachine.stop();
    this.updateRecordingButtonState();

    if (this.landingPage) {
      this.landingPage.updateConnectionStatus('connecting');
    }

    const versionStatus = await ensureClientCanConnect({ showWarning: false });
    if (!versionStatus.allowed) {
      this.showUpdateRequiredNotice(versionStatus);
      if (this.landingPage) {
        this.landingPage.updateConnectionStatus('disconnected');
        this.landingPage.showError(formatOutdatedClientMessage(versionStatus));
      }
      return;
    }

    try {
      await this.wsClient.connect(this.self.toJSON(), '_discovery');
    } catch (err) {
      console.error('[App] Discovery connection failed:', err);
      if (this.landingPage) {
        this.landingPage.updateConnectionStatus('disconnected');
      }
    }
  }

  _bindLayerManagerDependencies() {
    if (!this.board?.layerManager) return;
    this.strokeHistoryPanel.setLayerManager(this.board.layerManager);
    this.strokeHistoryPanel.setActiveLayer(this.self?.activeLayer ?? 0);
    this.board.layerManager.strokeHistoryPanel = this.strokeHistoryPanel;
    this.board.layerManager.onHistoryChange = () => this.updateUndoRedoHud();
    this.board.layerManager.localUserId = this.self?.id ?? null;
    this.debugOverlay?.setPixelsWorker?.(this.board.layerManager._pixelsWorker);
  }

  hasRemoteUsers() {
    for (const id of this.users.keys()) {
      if (Number(id) !== Number(this.sessionIndex)) {
        return true;
      }
    }
    return false;
  }

  cancelMemoryCompaction() {
    if (this._memoryCompactionTimer) {
      clearTimeout(this._memoryCompactionTimer);
      this._memoryCompactionTimer = null;
    }
  }

  scheduleMemoryCompaction(reason = 'remote-idle') {
    this.cancelMemoryCompaction();
    if (this.hasRemoteUsers()) return;

    this._memoryCompactionTimer = setTimeout(() => {
      this._memoryCompactionTimer = null;
      this.compactMemory({ reason });
    }, this._memoryCompactionDelayMs);
  }

  compactMemory(options = {}) {
    if (!this.board?.layerManager) return false;
    if (this.hasRemoteUsers()) return false;
    if (this.syncClient?.isSyncing?.()) {
      this.scheduleMemoryCompaction('sync-busy');
      return false;
    }
    if (this.self?.mousedown) {
      this.scheduleMemoryCompaction('local-active');
      return false;
    }

    const selectTool = this.toolManager.getTool('select');
    if (selectTool?.isSelecting || selectTool?.isDragging || selectTool?.floatingCanvas) {
      this.scheduleMemoryCompaction('selection-active');
      return false;
    }

    const layerStats = this.board.layerManager.getDebugStats?.();
    if ((layerStats?.activeStrokes ?? 0) > 0) {
      this.scheduleMemoryCompaction('strokes-active');
      return false;
    }

    this.remoteUserHandler?.resetTransientState?.();
    this.toolManager.getTool('fill')?.compactMemory?.({ recycleWorker: true });
    this.board.layerManager.compactTransientState?.({ recycleWorker: true, clearReplayCaches: true });
    this.debugOverlay?.setPixelsWorker?.(this.board.layerManager._pixelsWorker);
    this.board.requestUpdate();
    this.updateCleanupDebugStats();
    console.log('[Memory] Compacted renderer state:', options.reason || 'manual');
    return true;
  }

  cleanupRemoteUserState(userId, options = {}) {
    const preserveVisuals = options.preserveVisuals === true;
    const requestUpdate = options.requestUpdate !== false;
    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId)) return;
    if (this.sessionIndex !== null && numericUserId === Number(this.sessionIndex)) return;

    const user = this.users.get(numericUserId);
    if (user) {
      this.remoteUserHandler?.cleanupUserState?.(user, { preserveVisuals });
      this.users.delete(numericUserId);
    } else {
      this.board.layerManager?.deepCleanupUserState?.(numericUserId, { preserveVisuals });
    }

    this.ui.removeRemoteUser(numericUserId);
    if (requestUpdate) {
      this.board.requestUpdate();
    }
    if (this.hasRemoteUsers()) {
      this.cancelMemoryCompaction();
    } else {
      this.scheduleMemoryCompaction('last-remote-left');
    }
    this.updateCleanupDebugStats();
  }

  resetRoomState(options = {}) {
    const preserveRemoteVisuals = options.preserveRemoteVisuals === true;
    const clearBoard = options.clearBoard !== false;

    this.cancelMemoryCompaction();
    this.stopPreviewInterval();
    this.stopCheckpointInterval();
    this.syncClient?.resetForRoomChange?.();
    this.remoteUserHandler?.resetTransientState?.();
    this._resetLocalTransientState();

    const remoteIds = new Set();
    this.users.forEach((_, sessionIndex) => {
      if (sessionIndex !== this.sessionIndex) {
        remoteIds.add(Number(sessionIndex));
      }
    });
    this.ui.remoteUserUI?.cursors?.forEach?.((_, userId) => {
      if (Number(userId) !== Number(this.sessionIndex)) {
        remoteIds.add(Number(userId));
      }
    });

    for (const userId of remoteIds) {
      this.cleanupRemoteUserState(userId, { preserveVisuals: preserveRemoteVisuals, requestUpdate: false });
    }

    if (clearBoard && this.board) {
      this.board.activeSelectionLayer = -1;
      this.board.setMirror(false);
      this.board.setMirrorRegions([]);
      this.board.rebuildRenderingState({ preserveSnapshot: false });
      this._bindLayerManagerDependencies();
      this.toolManager.getTool('fill')?.compactMemory?.({ recycleWorker: true });
      this.remoteUserHandler?.resetTransientState?.();
      this.board.setBackgroundColor('#ffffff');
    }

    this.currentRoomData = null;
    appState.currentRoomData = null;
    this.updateRoomSettingsButtonVisibility();
    this.updateCleanupDebugStats();
  }

  _resetLocalTransientState() {
    if (!this.self) return;

    this.self.clearLine();
    this.self.mousedown = false;
    this.self.panning = false;
    this.self.penPoints = [];
    this.self._inkPoints = [];
    this.self.remoteTarget = null;

    const penTool = this.toolManager.getTool('flowPen');
    penTool?.clearStroke?.();

    const inkTool = this.toolManager.getTool('ink');
    inkTool?.clearStroke?.();

    const pixelTool = this.toolManager.getTool('pixel');
    pixelTool?.clearStroke?.(this.self);

    const lineTool = this.toolManager.getTool('line');
    if (lineTool) lineTool.startPos = null;
    const rectangleTool = this.toolManager.getTool('rectangle');
    if (rectangleTool) rectangleTool.startPos = null;
    const circleTool = this.toolManager.getTool('circle');
    if (circleTool) circleTool.startPos = null;

    const selectTool = this.toolManager.getTool('select');
    if (selectTool) {
      selectTool.isSelecting = false;
      selectTool.isDragging = false;
      selectTool.startPos = null;
      selectTool.floatingCanvas = null;
      selectTool.floatingCtx = null;
      selectTool.selection = null;
      selectTool.corners = null;
      selectTool.originalCorners = null;
      selectTool.lassoPath = null;
      selectTool._cachedTransform = null;
      selectTool.pendingSelectionBroadcast = null;
    }

    const fillTool = this.toolManager.getTool('fill');
    fillTool?._cancelInteractive?.();

    this.board.cancelStroke(this.self);
    this.board.clearTop();
    this.debugOverlay?.cancelDrawing?.(this.self.id);
  }

  getCleanupDebugStats() {
    const remoteBoards = typeof document !== 'undefined' ? document.querySelectorAll('.userBoard').length : 0;
    const remoteCursors = typeof document !== 'undefined' ? document.querySelectorAll('.cursor').length : 0;
    return {
      remoteUsers: [...this.users.keys()].filter((id) => id !== this.sessionIndex).length,
      remoteBoards,
      remoteCursors,
      ...(this.board.layerManager?.getDebugStats?.() || {}),
      ...(this.remoteUserHandler?.getDebugStats?.() || {})
    };
  }

  updateCleanupDebugStats() {
    const stats = this.getCleanupDebugStats();
    if (typeof window !== 'undefined') {
      window.__topDrawCleanupStats = stats;
    }
    return stats;
  }

  /**
   * Handles successful WebSocket connection.
   * @param {number} sessionIndex - The session index assigned by the server.
   * @param {number} role - The user's role level.
   * @param {string} [assignedUsername] - Unique username assigned by server.
   * @param {string} [ipHash] - IP hash for grouping.
   */
  handleWSConnect(sessionIndex, role, assignedUsername, ipHash) {
    if (this.isOfflineMode) return;
    this.cancelMemoryCompaction();

    this.sessionIndex = sessionIndex;
    appState.sessionIndex = sessionIndex;
    this.self.id = sessionIndex;
    this.users.set(sessionIndex, this.self);
    this.board.layerManager.localUserId = sessionIndex;

    if (assignedUsername) {
      this.self.setUsername(assignedUsername);
      this.ui.updateSelfName(assignedUsername);
    }

    if (ipHash) {
      this.self.ipHash = ipHash;
    }

    if (role !== undefined) {
      this.selfRole = role;
      this.self.role = role;
      appState.selfRole = role;
      if (this.moderation) {
        this.moderation.setRole(role);
      }
      this.ui.updateSelfRole(role);
      this.updateAuthenticatedActionVisibility(role);
    }

    if (this.landingPage) {
      this.landingPage.updateConnectionStatus('connected');
    }

    this.updateRecordingButtonState();

    const isDiscoveryConnection = !this.currentRoomId || this.currentRoomId === '_discovery';
    if (isDiscoveryConnection) {
      if (this._pendingLandingLogin) {
        this._pendingLandingLogin = false;
        this.auth?.handleLogin();
      } else if (this._pendingOffline) {
        // Authenticate before entering offline mode
        const hasPassword = !this.auth?.isLoggedIn && this.ui.elements.loginPassword?.value;
        if (hasPassword) {
          this.auth?.handleLogin();
        } else if (this.auth?.attemptAutoLogin()) {
          // Auto-login with stored token; auth result will trigger _enterOfflineMode
        } else {
          // No credentials to try — go offline immediately
          this._pendingOffline = false;
          this._enterOfflineMode();
        }
      }
      return;
    }

    this.wsClient.broadcastToolChange(this.self.tool);
    this.users.set(sessionIndex, this.self);
    this.wsClient.requestRoomList();

    this.syncClient.hasCompletedSync = false;
    this.syncClient.syncing = false;
    this.syncClient.buffering = false;
    this.syncClient.eventBuffer = [];
    if (this.syncClient.syncTimeout) {
      clearTimeout(this.syncClient.syncTimeout);
      this.syncClient.syncTimeout = null;
    }

    this._needsSync = true;

    if (this._pendingPassword && this.self.username) {
      this.wsClient.sendAuthLogin(this.self.username, this._pendingPassword);
      this._pendingPassword = null;
      return;
    }
    this._pendingPassword = null;

    if (this.auth && this.auth.attemptAutoLogin()) {
      return;
    }

    if (this.landingPage && this.self.username) {
      this.handleJoinAfterConnect();
      return;
    }

    this.ui.showLogin();
    this.ui.elements.overlay.style.display = 'flex';
    if (this.self.username) {
      this.ui.elements.loginUsername.value = this.self.username;
    }
  }

  /**
   * Completes the join process after successful connection and authentication.
   */
  handleJoinAfterConnect() {
    this.connected = true;
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(this.self.username);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    this.ui.hideDisconnectionBanner();

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastFontChange(
      this.self.font,
      this.self.textPositionMultiplier,
      this.self.textPositionOffset
    );
    this.wsClient.broadcastToolChange(this.self.tool);
    this.wsClient.broadcastSpacingChange(this.self.spacing);
    this.wsClient.broadcastHardnessChange(this.self.hardness);
    this.wsClient.broadcastLayerBlendModeChange(this.self.activeLayer, this.self.blendMode);
    this.wsClient.broadcastLayerChange(this.self.activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);
    if (this.self.patternBrush) {
      this.wsClient.broadcastPatternBrush(this._buildPatternPayload());
    }

    this.moderation.setRole(this.selfRole);
    this.inputBufferManager.startTickLoop();

    // Apply pending room settings from "Create Room" dialog
    if (this._pendingRoomSettings) {
      const s = this._pendingRoomSettings;
      this._pendingRoomSettings = null;
      this.wsClient.send({
        t: T.ROOM_UPDATE,
        roomDescription: s.roomDescription,
        roomBackgroundColor: s.roomBackgroundColor,
        roomLocked: s.roomLocked,
        roomMaxUsers: s.roomMaxUsers,
        roomJoinPolicy: s.roomJoinPolicy,
        roomPrivate: s.roomPrivate
      });
    }

    // Eligibility determined by election or manual pin — let the handler decide
    this._updatePreviewUploadEligibility();
  }

  /**
   * Handles WebSocket disconnection.
   * @param {number} code - Disconnection code.
   * @param {string} reason - Disconnection reason.
   */
  handleWSDisconnect(code, reason) {
    this.connected = false;

    this.stopPreviewInterval();
    this.stopCheckpointInterval();
    TimeMachine.stop();
    this.updateRecordingButtonState();

    // Don't show disconnection UI if disconnect was intentional
    if (this.intentionalDisconnect) {
      this.intentionalDisconnect = false;
      return;
    }

    // Don't show disconnection UI if we're in offline mode
    if (this.isOfflineMode) {
      console.log('[App] Already in offline mode, ignoring disconnect');
      return;
    }

    if (this.landingPage && this.landingPage.els.landingPage.style.display !== 'none') {
      this.landingPage.updateConnectionStatus('disconnected');
      // Don't show banner on landing page
      return;
    }

    this.ui.showConnectionStatus('disconnected');

    if (code === 4001 || code === 4002) {
      const label = code === 4001 ? 'Banned' : 'Kicked';
      if (this.auth) {
        this.auth.clearToken();
        this.auth.setRememberMe(false);
      }
      this.showModOverlay(label, reason || '');
    } else if (code === 4000 || String(reason || '').includes('server-restarting')) {
      this.handleServerUpdateNotice({
        message: 'Ddraw is updating. Reload once the update finishes, or keep drawing offline.',
        kind: 'restart',
        issuer: 'Server',
        persistent: true
      });
    } else {
      // Show disconnection banner if we're in a room (not on landing page)
      console.log('[App] Showing disconnection banner');
      this.ui.showDisconnectionBanner();
    }
  }

  startVersionPolling() {
    if (this._versionPollTimer || typeof window === 'undefined') return;
    this._versionPollTimer = window.setInterval(() => {
      if (this.isOfflineMode) return;
      void this.checkForRuntimeUpdate();
    }, 60000);
  }

  async checkForRuntimeUpdate({ force = true } = {}) {
    if (this._versionUpdateNoticed) return;
    const status = await getVersionStatus({ force });
    const latest = status?.serverVersion?.latest || status?.latestVersion;
    if (!latest || !status.clientVersion || latest === status.clientVersion) return;

    this._versionUpdateNoticed = true;
    this.showUpdateAvailableNotice(status);
  }

  async showUpdateAvailableNotice(versionStatus = {}) {
    this._reloadRecommended = true;
    const latest = versionStatus.latestVersion || versionStatus.serverVersion?.latest || 'the latest version';
    this.ui.showDisconnectionBanner({
      message: `A new Ddraw version is available (${latest}). Reload to update, or continue offline.`,
      icon: '!',
      retryLabel: isTauriDesktop() ? 'Update App' : 'Reload App',
      offlineLabel: 'Continue Offline'
    });

    if (isTauriDesktop()) {
      await this._promptDesktopUpdateFromRuntimeNotice();
    }
  }

  showUpdateRequiredNotice(versionStatus = {}) {
    this._reloadRecommended = true;
    this.ui.showToast('Update required before connecting online', 3500, 'error');
    this.ui.showDisconnectionBanner({
      message: `${formatOutdatedClientMessage(versionStatus)} You can still draw offline.`,
      icon: '!',
      retryLabel: isTauriDesktop() ? 'Update App' : 'Reload App',
      offlineLabel: 'Continue Offline'
    });
  }

  async handleServerUpdateNotice(data = {}) {
    this._reloadRecommended = true;
    this.ui.showToast(data.message || 'Ddraw is updating', 5000);
    this.ui.showDisconnectionBanner({
      message: data.message || 'Ddraw is updating. Reload in a moment, or continue offline.',
      icon: '!',
      retryLabel: isTauriDesktop() ? 'Update App' : 'Reload App',
      offlineLabel: 'Continue Offline'
    });

    if (isTauriDesktop()) {
      await this._promptDesktopUpdateFromRuntimeNotice();
    }
  }

  async _promptDesktopUpdateFromRuntimeNotice() {
    this.ui.showToast('Checking for desktop update...', 2500);

    const result = await checkForDesktopUpdates({ silent: false });
    if (result.status === 'up-to-date') {
      this.ui.showToast('Update is not ready yet. Try again in a moment.', 3500);
    } else if (result.status === 'error') {
      this.ui.showToast('Desktop update check failed. Restart the app to try again.', 4500, 'error');
    }
  }

  /**
   * Displays a moderation overlay for kicks or bans.
   * @param {string} title - Overlay title.
   * @param {string} reason - Reason for the moderation action.
   */
  showModOverlay(title, reason) {
    document.getElementById('modOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modOverlay';
    overlay.className = 'modOverlay';
    overlay.innerHTML = `
      <div class="modOverlayBox">
        <h3>${title}</h3>
        ${reason ? `<p class="modOverlayReason">${reason}</p>` : ''}
        <button class="btn" id="modOverlayReturnBtn">Return to Room Selection</button>
      </div>
    `;

    document.getElementById('boardContainer')?.appendChild(overlay);

    overlay.querySelector('#modOverlayReturnBtn').addEventListener('click', () => {
      overlay.remove();
      this.disconnect();
    });
  }

  /**
   * Handles successful authentication.
   * @param {string} token - The authentication token.
   * @param {number} role - The user's role level.
   * @param {string} username - The user's verified username.
   */
  handleAuthSuccess(token, role, username) {
    this.selfRole = role;
    this.self.role = role;
    appState.selfRole = role;
    this.self.setUsername(username);
    appState.username = username;

    if (this.ui.elements.loginPassword) this.ui.elements.loginPassword.value = '';

    if (this.moderation) {
      this.moderation.setRole(role);
    }

    this.ui.updateSelfRole(role);

    this.updateRoomSettingsButtonVisibility();
    this.updateGalleryButtonVisibility(role);
    this.updateAuthenticatedActionVisibility(role);

    if (this._pendingOffline) {
      this._pendingOffline = false;
      if (this._offlineAuthTimeout) { clearTimeout(this._offlineAuthTimeout); this._offlineAuthTimeout = null; }
      const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
      this._enterOfflineMode();
      this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
      return;
    }

    if (this.landingPage && this.landingPage.isVisible) {
      this.landingPage.isAuthenticated = true;
      this.landingPage.authToken = token;
      this.landingPage.username = username;
      return;
    }

    if (this.currentRoomId && this.wsClient.connected) {
      if (this.connected) return;
      this.handleJoinAfterConnect();
      return;
    }

    this.connected = true;
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(username);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    this.ui.hideDisconnectionBanner();

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastFontChange(
      this.self.font,
      this.self.textPositionMultiplier,
      this.self.textPositionOffset
    );
    this.wsClient.broadcastToolChange(this.self.tool);
    const activeLayer = this.self.activeLayer;
    this.wsClient.broadcastLayerBlendModeChange(activeLayer, this.self.blendMode);
    this.wsClient.broadcastLayerChange(activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);
    if (this.self.patternBrush) {
      this.wsClient.broadcastPatternBrush(this._buildPatternPayload());
    }

    this.moderation.setRole(role);
    this.inputBufferManager.startTickLoop();
    this.syncClient.requestSync();

    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
  }

  _showSelfContextMenu(e) {
    const menu = document.getElementById('selfContextMenu');
    if (!menu) return;

    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    const role = this.selfRole || 0;
    const nameEl = document.getElementById('selfRoleName');
    if (nameEl) {
      nameEl.textContent = roleNames[role] || 'Guest';
      nameEl.className = 'selfRoleName';
      const rankClass = role >= 9 ? 'rank-deity' : role >= 8 ? 'rank-holy' : role >= 7 ? 'rank-noble'
        : role >= 5 ? 'rank-admin' : role >= 4 ? 'rank-mod' : role >= 3 ? 'rank-helper'
        : role >= 2 ? 'rank-trusted'
        : role >= 1 ? 'rank-user' : 'rank-guest';
      if (rankClass) nameEl.classList.add(rankClass);
    }

    const profileBtn = document.getElementById('selfProfileBtn');
    if (profileBtn) {
      const canShowProfile = this.selfRole >= 1 && (this.self.registeredName || this.self.username);
      profileBtn.style.display = canShowProfile ? '' : 'none';
      profileBtn.onclick = () => {
        menu.style.display = 'none';
        showProfileDialog(this.self.registeredName || this.self.username);
      };
    }

    menu.style.display = 'flex';
    const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 10);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  /**
   * Handles authentication errors.
   * @param {string} error - The error message.
   */
  handleAuthError(error) {
    if (this._pendingOffline) {
      this._pendingOffline = false;
      if (this._offlineAuthTimeout) { clearTimeout(this._offlineAuthTimeout); this._offlineAuthTimeout = null; }
      console.log('[App] Auth failed before offline mode:', error);
      this._enterOfflineMode();
      return;
    }

    if (this.isOfflineMode) return;

    if (this.landingPage) {
      this.syncClient.hideOverlay();
      this.landingPage.show();
      this.landingPage.showError(error);
      this.ui.elements.overlay.style.display = 'flex';
      return;
    }

    this.ui.showToast(error, 4000, 'error');
  }

  /**
   * Handles the join request from the login dialog.
   */
  handleJoin() {
    if (this.landingPage && this.landingPage.isVisible) {
      void this.startLandingJoin();
      return;
    }

    let name = this.auth?.getJoinUsername();
    if (!name) {
      name = this.ui.elements.loginUsername?.value.trim();
    }
    if (!name) {
      let tabId = sessionStorage.getItem('tabId');
      if (!tabId) {
        tabId = Math.random().toString(36).substring(2, 8);
        sessionStorage.setItem('tabId', tabId);
      }
      name = `Guest-${tabId}`;
    }
    this.self.setUsername(name);

    const password = (!this.auth?.isLoggedIn && this.ui.elements.loginPassword?.value) || '';
    this._pendingPassword = password || null;

    this.connected = true;
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(name);
    this.ui.showConnectionStatus('connected', this.currentRoomId);
    this.ui.hideDisconnectionBanner();

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastFontChange(
      this.self.font,
      this.self.textPositionMultiplier,
      this.self.textPositionOffset
    );
    this.wsClient.broadcastToolChange(this.self.tool);
    const activeLayer = this.self.activeLayer;
    this.wsClient.broadcastLayerBlendModeChange(activeLayer, this.self.blendMode);
    this.wsClient.broadcastLayerChange(activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);
    if (this.self.patternBrush) {
      this.wsClient.broadcastPatternBrush(this._buildPatternPayload());
    }

    if (this.ui.elements.selfUserEntry) {
      this.ui.elements.selfUserEntry.dataset.sessionIndex = this.sessionIndex;
    }

    this.moderation.setRole(this.selfRole);
    this.inputBufferManager.startTickLoop();
    this.syncClient.requestSync();
  }

  /**
   * Prompts the user to rename themselves.
   */
  handleRenameself() {
    if (!this.inputBufferManager.tickTimer) return;
    const name = prompt('Enter your name:', this.self.username);
    if (name !== null && name.trim() !== '') {
      this.self.setUsername(name.trim());
      this.ui.updateSelfName(name.trim());
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastNameChange(name.trim()));
    }
  }

  /**
   * Starts local drawing mode without a server connection.
   */
  startOfflineMode() {
    this.connected = true;
    this.sessionIndex = 1;
    this.self.id = 1;
    const username = this.auth?.getJoinUsername() || this.ui.elements.loginUsername?.value || '';
    this.self.setUsername(username);

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(this.self.username);
    this.ui.hideConnectionStatus();

    this.inputBufferManager.startTickLoop();

    if (this.wsClient && this.wsClient.disconnect) {
      this.wsClient.disconnect();
    }
  }

  /**
   * Attempts to reconnect to the last used room.
   * @async
   * @returns {Promise<void>}
   */
  async reconnect() {
    this.ui.showConnectionStatus('connecting');

    if (this.wsClient) {
      this.wsClient.disconnect();
    }

    try {
      // Try to preserve the room from currentRoomId, or fall back to URL
      let reconnectRoomId = this.currentRoomId;
      if (!reconnectRoomId || reconnectRoomId === '_discovery') {
        const urlRoom = this.landingPage?.getRoomFromURL();
        reconnectRoomId = urlRoom || 'lobby';
      }
      await this.wsClient.connect(this.self.toJSON(), reconnectRoomId);
      // Connection successful - banner will be hidden by handleJoinAfterConnect
    } catch (err) {
      console.error('Reconnect failed:', err);
      this.ui.showConnectionStatus('disconnected');
      this.ui.setRetryButtonState(false);
      throw err; // Re-throw so handleRetryConnection knows it failed
    }
  }

  /**
   * Handles retry connection button click from disconnection banner.
   */
  async handleRetryConnection() {
    if (this._reloadRecommended) {
      if (isTauriDesktop()) {
        await this._promptDesktopUpdateFromRuntimeNotice();
        return;
      }

      window.location.reload();
      return;
    }

    this.ui.setRetryButtonState(true);

    try {
      await this.checkForRuntimeUpdate({ force: true });
      if (this._reloadRecommended) {
        this.ui.setRetryButtonState(false);
        return;
      }
      await this.reconnect();
      // On success, banner will be hidden by handleJoinAfterConnect
    } catch (err) {
      // reconnect() already resets button state on error
      console.log('[App] Retry connection failed, user can try again');
    }
  }

  /**
   * Handles switch to offline mode button click from disconnection banner.
   */
  handleSwitchToOffline() {
    this.ui.hideDisconnectionBanner();
    this.handleOffline();
  }

  ensureAppSettingsButton() {
    const collapsible = document.getElementById('collapsibleBtns');
    if (!collapsible || document.getElementById('appSettingsBtn')) return;

    const appSettingsBtn = document.createElement('a');
    appSettingsBtn.className = 'btn';
    appSettingsBtn.id = 'appSettingsBtn';
    appSettingsBtn.innerHTML = `
      <span class="btnText">Settings</span>
      <span class="btnIcon" style="display: none;"><img src="../images/settings-icon.svg" alt="Settings"></span>
    `;
    collapsible.appendChild(appSettingsBtn);
  }

  scheduleTopbarCollapseUpdate() {
    if (this._topbarCollapseFrame) {
      cancelAnimationFrame(this._topbarCollapseFrame);
    }

    this._topbarCollapseFrame = requestAnimationFrame(() => {
      this._topbarCollapseFrame = null;
      this.updateTopbarCollapseState();
    });
  }

  updateTopbarCollapseState() {
    const toolbar = document.querySelector('.boardBtns');
    if (!toolbar) return;

    toolbar.classList.remove(
      'force-right-icon-collapse',
      'force-left-icon-collapse',
      'force-menu-collapse'
    );

    const isOverflowing = () => toolbar.scrollWidth - toolbar.clientWidth > 1;

    if (isOverflowing()) {
      toolbar.classList.add('force-right-icon-collapse');
    }

    if (isOverflowing()) {
      toolbar.classList.add('force-left-icon-collapse');
    }

    if (isOverflowing()) {
      toolbar.classList.add('force-menu-collapse');
    } else {
      this.ui?.closeMenu?.();
    }
  }

  handleAppSettings() {
    appState.appSettingsTab = appState.appSettingsTab || 'general';
    appState.appSettingsVisible = true;
  }

  _applyLowPowerPreference() {
    const lowPowerEnabled = !!this.appPreferences?.general?.lowPowerMode;
    const targetTickRate = lowPowerEnabled ? LOW_POWER_TPS : NORMAL_TPS;
    const targetFPS = lowPowerEnabled ? LOW_POWER_FPS : 0;

    if (this.inputBufferManager?.tickRate !== targetTickRate) {
      this.inputBufferManager.setTickRate(targetTickRate);
    }

    if (this.board?.targetFPS !== targetFPS) {
      this.board.setTargetFPS(targetFPS);
    }
  }

  setAppPreferences(preferences) {
    this.appPreferences = saveAppPreferences(preferences);
    applyThemeColors(this.appPreferences?.general?.themeColors);
    applySidebarSide(this.appPreferences?.general?.sidebarSide);
    applyChatOpacity(this.appPreferences?.general?.chatOpacity);
    this.ui.setHideOwnLabelZoom(this.appPreferences?.general?.hideOwnLabelAbove150);
    this.board?.setShowRawPixelsAtHighZoom?.(this.appPreferences?.general?.showRawPixelsAtHighZoom);
    const desyncChangeNeedsRefresh = this.board?.setUseDesynchronizedBoardContexts?.(this.appPreferences?.general?.useDesynchronizedBoardContexts);
    if (desyncChangeNeedsRefresh) {
      this.ui?.showToast?.('Low-latency canvas setting will apply after refresh', 3500);
    }
    this._applyLowPowerPreference();
    appState.appPreferences = this.appPreferences;
    return this.appPreferences;
  }

  requestRefreshUnloadWarning() {
    this._warnOnNextUnload = true;
  }

  /**
   * Opens the room settings dialog.
   */
  handleRoomSettings() {
    if (!this.currentRoomData) {
      this.ui.showToast('Room data not loaded yet', 3000);
      return;
    }

    // Check permissions before opening settings
    const hasOwner = !!this.currentRoomData?.ownerId;
    const canEdit = hasOwner && (this.selfRole >= 5); // ADMIN+ or higher

    if (!canEdit) {
      this.ui.showToast('Only room owner or moderators can edit settings', 3000);
      return;
    }

    // Update stores and show dialog
    appState.currentRoomData = this.currentRoomData;
    appState.selfRole = this.selfRole;
    appState.username = this.self?.username || '';
    appState.roomSettingsVisible = true;
  }

  /**
   * Registers the current user as room owner.
   */
  handleRegisterRoom() {
    if (this.selfRole < 1) {
      this.ui.showToast('You must be logged in to register a room', 3000);
      return;
    }

    if (this.currentRoomData?.ownerId) {
      this.ui.showToast('This room already has an owner', 3000);
      return;
    }

    this.wsClient.send({ t: T.ROOM_REGISTER });

    // Optimistically update local room data
    if (this.self?.username) {
      if (!this.currentRoomData) {
        this.currentRoomData = { id: this.currentRoomId };
      }
      this.currentRoomData.ownerId = 'self';
      this.currentRoomData.ownerUsername = this.self.username;
      this.updateRoomSettingsButtonVisibility();
    }

    this.ui.showToast('Registering room...');
  }

  /**
   * Updates the visibility of room settings and register buttons based on user permissions.
   */
  updateRoomSettingsButtonVisibility() {
    const settingsBtn = document.getElementById('roomSettingsBtn');
    const registerBtn = document.getElementById('registerRoomBtn');

    // Use wsClient.connected instead of this.connected since this.connected
    // may not be set yet when auth completes
    const isConnected = this.wsClient?.connected && this.currentRoomId;

    if (!isConnected) {
      if (settingsBtn) settingsBtn.style.display = 'none';
      if (registerBtn) registerBtn.style.display = 'none';
      this.scheduleTopbarCollapseUpdate();
      return;
    }

    const isLoggedIn = this.selfRole >= 1;

    // If we don't have room data yet, show register button for logged-in users
    // (assumes room is likely unregistered if data hasn't loaded)
    if (!this.currentRoomData) {
      if (settingsBtn) settingsBtn.style.display = 'none';
      if (registerBtn) registerBtn.style.display = isLoggedIn ? 'inline-block' : 'none';
      this.scheduleTopbarCollapseUpdate();
      return;
    }

    const hasOwner = !!this.currentRoomData.ownerId;
    const canEdit = hasOwner && this.selfRole >= 5;

    // Show Register Room button if room is unregistered and user is logged in
    if (registerBtn) {
      registerBtn.style.display = (!hasOwner && isLoggedIn) ? 'inline-block' : 'none';
    }

    // Show Room Settings button only if room is registered and user can edit
    if (settingsBtn) {
      settingsBtn.style.display = (hasOwner && canEdit) ? 'inline-flex' : 'none';
    }

    this.scheduleTopbarCollapseUpdate();
  }

  /**
   * Shows or hides the "Save to Gallery" section in the save overlay based on auth role.
   * @param {number} role - The user's role level.
   */
  updateGalleryButtonVisibility(role) {
    const el = this.ui.elements.saveModeGallery;
    if (!el) return;
    el.style.display = role >= 1 ? '' : 'none';
  }

  updateAuthenticatedActionVisibility(role = this.selfRole) {
    const isAuthenticated = role >= 1;
    const { adminTopBtn, inboxBtn, uploadBtn } = this.ui.elements;

    if (adminTopBtn) {
      adminTopBtn.style.display = role >= 9 ? '' : 'none';
    }

    if (inboxBtn) {
      inboxBtn.style.display = isAuthenticated ? '' : 'none';
    }

    if (uploadBtn) {
      uploadBtn.style.display = isAuthenticated ? '' : 'none';
    }

    if (!isAuthenticated) {
      appState.messengerVisible = false;
    }

    this.scheduleTopbarCollapseUpdate();
  }

  updateRecordingButtonState() {
    const btn = this.ui?.elements?.recordBtn;
    if (!btn) return;

    const connectedToRoom = !!this.currentRoomId && !this.isOfflineMode;
    const waitingForSync = connectedToRoom && !!this.syncClient && !this.syncClient.hasCompletedSync;

    btn.classList.toggle('is-recording', TimeMachine.isStarted);
    btn.classList.toggle('disabled', waitingForSync);
    btn.setAttribute('aria-disabled', waitingForSync ? 'true' : 'false');

    if (TimeMachine.isStarted) {
      btn.title = 'Timeline active (click to close)';
      btn.setAttribute('aria-label', 'Close timeline');
    } else if (waitingForSync) {
      btn.title = 'Timeline becomes available after room sync completes';
      btn.setAttribute('aria-label', 'Timeline unavailable until sync completes');
    } else {
      btn.title = 'Open Timeline';
      btn.setAttribute('aria-label', 'Open timeline');
    }
  }

  handleStartRecording() {
    if (TimeMachine.isStarted) {
      TimeMachine.stop();
      this.updateRecordingButtonState();
      this.ui.showToast('Timeline closed', 2000);
      return;
    }

    const connectedToRoom = !!this.currentRoomId && !this.isOfflineMode;
    if (connectedToRoom && this.syncClient && !this.syncClient.hasCompletedSync) {
      this.ui.showToast('Please wait for sync to finish before opening the timeline', 2500);
      this.updateRecordingButtonState();
      return;
    }

    TimeMachine.start();
    this.updateRecordingButtonState();
    this.ui.showToast('Loading timeline…', 2000);
  }

  canUseImageFeatures(showToast = false) {
    const allowed = this.selfRole >= 1;
    if (!allowed && showToast) {
      this.ui?.showToast('Only registered users can upload, copy, or paste images', 3000);
    }
    return allowed;
  }

  /** Opens the interactive save mode with visual selection. */
  openSaveDialog() {
    if (this.saveMode) {
      this.saveMode.open();
    }
  }

  openSaveDialogForCanvas(sourceCanvas) {
    if (!this.saveMode || !sourceCanvas) {
      this.openSaveDialog();
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    this.saveMode.openWithCanvas(canvas, { fixedSelection: false });
  }

  /** Closes the interactive save mode. */
  closeSaveDialog() {
    if (this.saveMode) {
      this.saveMode.close();
    }
  }

  /**
   * Performs the save action from the save mode overlay.
   * @param {boolean} locally - If true, downloads the file. If false, uploads to gallery.
   */
  async performSave(locally) {
    const { saveAreaSelection, saveTransparent } = this.ui.elements;
    const isSelection = saveAreaSelection?.checked;
    const transparent = saveTransparent?.checked ?? false;

    if (isSelection) {
      const selectTool = this.toolManager.tools.select;
      let canvas = selectTool?.getSelectionExportCanvas();
      if (!canvas) { this.ui.showToast('No active selection'); return; }

      if (!transparent) {
        const out = document.createElement('canvas');
        out.width = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext('2d');
        const [r, g, b, a] = this.board.backgroundColor;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, 0, 0);
        canvas = out;
      }

      if (locally) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const saved = await this.saveCanvasLocally(canvas, `selection-${ts}.png`, 'Selection saved!');
        if (!saved) return;
      } else {
        await this.handleSaveToGallery(canvas);
      }
    } else {
      const canvas = this.board.getExportCanvas(transparent);

      if (locally) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const saved = await this.saveCanvasLocally(canvas, `board-${ts}.png`, 'Image saved!');
        if (!saved) return;
      } else {
        await this.handleSaveToGallery(canvas);
      }
    }

    this.closeSaveDialog();
  }

  /**
   * Uploads a canvas to the gallery. Uses mainCanvas if no canvas is provided.
   * @param {HTMLCanvasElement} [canvas]
   * @async
   */
  async handleSaveToGallery(canvas, metadata = {}) {
    const token = localStorage.getItem('topDrawAuthToken');
    if (!token) {
      this.ui.showToast('Log in to save to the gallery');
      return;
    }

    const targetCanvas = canvas ?? this.board.mainCanvas;
    const btn = this.ui.elements.saveToGalleryBtn;
    const originalText = btn?.textContent;
    if (btn) btn.textContent = 'Saving...';
    this.ui.showSavingPopup('Saving to gallery...');

    try {
      const imageData = targetCanvas.toDataURL('image/png');
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const res = await fetch(`${apiBase}/api/gallery/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ imageData, title: metadata.title || '' }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.duplicate) {
          this.ui.showToast('This image is already in the gallery', 3000, 'error');
        } else {
          this.ui.showToast(`Gallery save failed: ${data.error || res.status}`, 3000, 'error');
          await this._offerLocalSave(targetCanvas);
        }
        return;
      }

      this.ui.showToast('Saved to gallery!');
    } catch (err) {
      console.error('[Gallery] Save error:', err);
      this.ui.showToast(`Gallery save failed: ${err.message}`, 3000, 'error');
      await this._offerLocalSave(targetCanvas);
    } finally {
      this.ui.hideSavingPopup();
      if (btn && originalText) btn.textContent = originalText;
    }
  }

  /**
   * Triggers a local download of the canvas as a fallback when gallery upload fails.
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  async _offerLocalSave(canvas) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    await this.saveCanvasLocally(canvas, `drawing-${ts}.png`, 'Saved locally instead');
  }

  /**
   * Disconnects from the current room and returns to the landing page.
   * @async
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.inputBufferManager) {
      this.inputBufferManager.stopTickLoop();
    }

    this.resetRoomState({ preserveRemoteVisuals: false, clearBoard: true });
    this.users.clear();
    if (this.self) {
      this.users.set(this.sessionIndex, this.self);
    }

    this.connected = false;
    this.isOfflineMode = false;
    this.sessionIndex = null;
    appState.sessionIndex = null;
    if (this.self) this.self.id = null;
    this.currentRoomData = null;

    this.updateRoomSettingsButtonVisibility();

    this.ui.hideCursor();
    this.ui.hideConnectionStatus();
    this.ui.hideDisconnectionBanner();

    if (this.wsClient && this.wsClient.connected) {
      this.intentionalDisconnect = true;
      this.wsClient.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (this.landingPage) {
      this.landingPage.show();
      const urlRoom = this.landingPage.getRoomFromURL();
      this.landingPage.selectRoom(urlRoom || 'lobby');
    }

    this.connectForRoomDiscovery();
  }

  /**
   * Selects a tool and updates application state and UI.
   * @param {string} tool - The name of the tool to select.
   */
  selectTool(tool) {
    this.clearActiveCustomPreset();
    if (this.self.tool === 'pan') {
      this.self.panning = false;
    }
    if (this.self.tool === 'zoom') {
      this._rightDragZoomActive = false;
      this._rightDragZoomPointerId = null;
    }
    if (this.self.tool === 'rotate') {
      this._rotateToolActive = false;
      this._rotatePrevAngle = null;
    }

    if (this.self.mousedown) {
      if (this.self.tool === 'brush' && this.self.currentLine.length > 0) {
        const brushTool = this.toolManager.getTool('brush');
        brushTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      } else if (this.self.tool === 'flowPen' && this.self.penPoints && this.self.penPoints.length > 0) {
        const penTool = this.toolManager.getTool('flowPen');
        penTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      } else if (this.self.tool === 'ink') {
        const inkTool = this.toolManager.getTool('ink');
        if (inkTool && inkTool.inputPoints && inkTool.inputPoints.length > 0) {
          inkTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
        }
      }
      this.self.mousedown = false;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseUp());
    }

    const previousTool = this.self.tool;

    // Handle inkdropper and text tool previousTool logic
    if ((tool === 'inkdropper' || tool === 'text') && previousTool !== 'inkdropper' && previousTool !== 'text') {
      // Switching TO inkdropper/text - always remember the previous tool
      this.previousTool = previousTool;
    } else if ((previousTool === 'inkdropper' || previousTool === 'text') && tool !== this.previousTool) {
      // Switching FROM inkdropper/text to a different tool (not the previous one)
      this.previousTool = null;
    } else if (previousTool !== 'inkdropper' && previousTool !== 'text' && tool !== 'inkdropper' && tool !== 'text' && this.previousTool) {
      // Normal tool switching (not involving inkdropper or text)
      this.previousTool = null;
    }

    if (previousTool === 'zoom' && tool !== 'zoom' && this._temporaryZoomPreviousTool) {
      this._temporaryZoomPreviousTool = null;
    }

    if (previousTool && this.toolLockManager.toolLocks[previousTool]) {
      this.toolLockManager.saveCurrentValues(previousTool);
    }

    if (this.mirrorRegionController?.isActive()) {
      this.mirrorRegionController.cancel();
    }

    this.brushModeManager.updateModeFromTool(tool);

    if (previousTool === 'text' && tool !== 'text') {
      this.self._pendingTextPos = null;
      this.self._pendingTextPointerType = null;
      this.ui.updateSelfTextInput('');
      if (this.ui.elements.selfTextInput) {
        this.ui.elements.selfTextInput.style.visibility = '';
      }
      if (this.ui.elements.touchInput) {
        this.ui.elements.touchInput.value = ' ';
        this.ui.elements.touchInput.blur();
      }
      this.board.clearTop();
    }

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastToolChange(tool, tool === 'erase' ? this.eraseAllLayers : false));
    }

    this.applyCursorStyleForTool(tool);
    this.self.setTool(tool);
    appState.currentTool = tool;

    // Restore locked tool values before activation so any activate-time preview
    // uses the new tool's resolved settings instead of the previous tool's state.
    if (this.toolLockManager.toolLocks[tool]) {
      this.toolLockManager.restoreToolValues(tool);
    }

    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool, this.self);
    this.applyBlurRadiusLimitForTool(tool, { broadcast: this.connected });
    this._updateBlurCannotDraw();

    if (tool === 'pan') {
      if (this.connected) this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHideCursor());
    } else if (previousTool === 'pan') {
      if (this.connected) this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastShowCursor());
    }

    if (tool === 'text') {
      this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
      this._updateTextPreview();
    }

    if (tool === 'imageBrush' && this.self.imageBrush) {
      const brush = this.self.imageBrush;
      if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
        this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
      } else {
        this.ui.setBrushPreview(brush.previewUrl || brush.gimpUrl);
      }
    }

    if (tool === 'pattern') {
      // Ensure we have a default pattern (circle) if none is set
      if (!this.self.patternBrush) {
        if (this.patternGallery.selectedBrush) {
          this.self.patternBrush = this.patternGallery.selectedBrush;
        } else {
          // Fallback: create a default circle pattern
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 40;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ccc';
          ctx.beginPath();
          ctx.arc(20, 20, 18, 0, Math.PI * 2);
          ctx.fill();
          const circleImg = new Image();
          circleImg.src = canvas.toDataURL();
          this.self.patternBrush = {
            type: 'image',
            brushName: 'Circle',
            gimpUrl: canvas.toDataURL(),
            image: circleImg
          };
        }
      }
      // Broadcast pattern state when switching to pattern tool
      if (this.self.patternBrush && this.connected) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPatternBrush(this._buildPatternPayload()));
      }
    }

    if (tool === 'line' || tool === 'rectangle' || tool === 'circle') {
      this.self.setSmoothing(50);
      this.ui.updateSmoothingValue(50);
    }

    this.ui.updateSelfToolIcon(tool);

    if (tool === 'erase') {
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    } else {
      const cssMode = this.blendModeManager.toCSSBlendMode(this.self.blendMode);
      this.board.topCanvas.style.mixBlendMode = cssMode;
      this.ui.updateTextPreviewBlendMode(cssMode);
    }

    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(this.self.activeLayer);
    const wasReset = this.ui.updateBlendModeForLayer(allowComplex);
    if (wasReset) {
      this.self.setBlendMode('source-over');
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    }

    const blendModeOptions = this.ui.elements.blendModeOptions;
    if (blendModeOptions && !this.ui.toolSupportsBlendMode(tool)) {
      blendModeOptions.style.display = 'none';
    }

    this.toolLockManager.updateAllLockButtons(tool);
    this.updateCurrentToolPresetSettings();

    // Auto-disable thinning when tablet user selects ink tool (only if using real pressure)
    // Only warn once and only when simulatePressure is false (tablet mode where thinning still applies)
    if (tool === 'ink' && this.tabletDetected && !this.tabletThinningWarningShown && !this.self.simulatePressure) {
      const elements = this.ui.elements;
      if (elements.thinningEnabled && elements.thinningEnabled.checked) {
        elements.thinningEnabled.checked = false;
        if (elements.thinningSliderContainer) {
          elements.thinningSliderContainer.style.display = 'none';
        }
        if (elements.thinningValue) {
          elements.thinningValue.style.display = 'none';
        }
        this.ui.showToast('Tablet detected - thinning disabled', 3000);
        this.tabletThinningWarningShown = true;
      }
    }

    if (tool === 'imageBrush') {
      this.brushGallery.show();
    } else {
      this.brushGallery.hide();
    }
  }

  /**
   * Handles brush selection from the gallery.
   * @param {Object} brush - Selected brush configuration.
   */
  handleBrushSelect(brush) {
    // Queue the brush change FIRST (snapshots pending strokes with old brush)
    // BEFORE setting the new brush locally
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBrush(brush));

    // NOW set the new brush so future strokes use it
    this.self.imageBrush = brush;

    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
    } else {
      this.ui.setBrushPreview(brush.previewUrl || brush.gimpUrl);
    }
  }

  /**
   * Handles font selection change from the UI dropdown.
   * @param {string} font - The selected font family string.
   */
  handleFontChange(font) {
    const nextFont = normalizeTextFont(font);

    // Queue broadcast using current values
    if (this.connected) {
      const snapshot = {
        font: nextFont,
        mult: this.self.textPositionMultiplier,
        off: this.self.textPositionOffset
      };
      this.inputBufferManager.queueBroadcast(() => 
        this.wsClient.broadcastFontChange(snapshot.font, snapshot.mult, snapshot.off)
      );
    }

    //Local update
    this.self.setFont(font);
    this._applyStoredTextFontSettings(this.self.font);
    this.ui.updateTextPositionMultiplierValue(this.self.textPositionMultiplier);
    this.ui.updateTextPositionOffsetValue(this.self.textPositionOffset);
    this.ui.updateSelfTextStyle(this.self.size, this.self.color, font);
    this._updateTextPreview();
    this._refreshTextRenderingAfterFontLoad(nextFont);
  }

  handleTextPositionMultiplierChange(multiplier) {
    this.self.setTextPositionMultiplier(multiplier);
    this._saveTextFontSettings();
    this.ui.updateTextPositionMultiplierValue(this.self.textPositionMultiplier);
    this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
    this._updateTextPreview();
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastFontChange(
        this.self.font,
        this.self.textPositionMultiplier,
        this.self.textPositionOffset
      ));
    }
  }

  handleTextPositionOffsetChange(offset) {
    this.self.setTextPositionOffset(offset);
    this._saveTextFontSettings();
    this.ui.updateTextPositionOffsetValue(this.self.textPositionOffset);
    this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
    this._updateTextPreview();
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastFontChange(
        this.self.font,
        this.self.textPositionMultiplier,
        this.self.textPositionOffset
      ));
    }
  }

  /**
   * Handles layer selection.
   * @param {number} layerIndex - Index of the layer to select.
   */
  handleLayerSelect(layerIndex) {
    this.self.setActiveLayer(layerIndex);
    this.ui.updateActiveLayerDisplay(layerIndex);
    this.ui.updateBlurToolState(layerIndex);
    this._updateBlurCannotDraw();

    const allowComplex = this.board.layerManager.getLayerAllowComplexBlendModes(layerIndex);
    const wasReset = this.ui.updateBlendModeForLayer(allowComplex);
    if (!allowComplex || wasReset) {
      this.self.setBlendMode('source-over');
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    }

    if (allowComplex) {
      this.ui.updateBlendModeDisplay(this.self.blendMode);
    }

    const effectiveBlendMode = allowComplex ? this.self.blendMode : 'source-over';
    const cssMode = this.blendModeManager.toCSSBlendMode(effectiveBlendMode);
    this.board.topCanvas.style.mixBlendMode = cssMode;
    this.ui.updateTextPreviewBlendMode(cssMode);

    this.board.compositeAllLayers();

    this.strokeHistoryPanel.setActiveLayer(layerIndex);

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastLayerChange(layerIndex));
    }
  }

  handleLayerVisibilityToggle(layerIndex) {
    const visible = this.board.layerManager.toggleLayerVisibility(layerIndex);
    appState.layerVisibility = {
      ...appState.layerVisibility,
      [layerIndex]: visible
    };

    if (!visible && this.self.activeLayer === layerIndex) {
      if (this.self.mousedown && !this.self.panning) {
        this.cancelCurrentStroke();
      } else {
        this.board.clearTop();
      }
    }

    this.board.compositeAllLayers();
    this.refreshRemoteLayerVisibilityStates();
    this._updateBlurCannotDraw();
    return visible;
  }

  refreshRemoteLayerVisibilityStates(userId = null) {
    if (!this.ui?.remoteUserUI) return;

    const refreshUser = (user) => {
      if (!user || user.id === this.self?.id) return;
      const hiddenLayer = !this.board.layerManager.isLayerVisible(user.activeLayer);
      this.ui.remoteUserUI.updateRemoteLayerVisibility(user.id, hiddenLayer);
    };

    if (userId !== null && userId !== undefined) {
      refreshUser(this.users.get(userId));
      return;
    }

    this.users.forEach((user) => refreshUser(user));
  }

  /**
   * Show/hide the muted-style cursor indicator when blur is active on a non-zero layer.
   * @private
   */
  _updateBlurCannotDraw() {
    const cannotDraw = (this.self.tool === 'blur' || this.self.tool === 'glitchBlur') && this.self.activeLayer !== 0;
    this._blurCannotDraw = cannotDraw;
    this._updateCursorDrawState();
  }

  _updateCursorDrawState() {
    const hiddenLayerCannotDraw =
      this.self.tool !== 'pan' &&
      this.self.tool !== 'rotate' &&
      !this.self.panning &&
      !this.board.layerManager.isLayerVisible(this.self.activeLayer);
    this._hiddenLayerCannotDraw = hiddenLayerCannotDraw;

    const cannotDraw = this._blurCannotDraw || hiddenLayerCannotDraw;

    if (!this.self.isMuted) {
      this.ui.setMutedState(cannotDraw);
    }

    if (!cannotDraw) {
      if (this.isOnBoard && this.ui?.elements?.selfCursor?.style.display !== 'none') {
        this.ui.updateToolDisplay(this.self.tool, this.self);
      }
      return;
    }

    const {
      selfCircle,
      selfPressureCircle,
      selfSquare,
      selfPressureSquare,
      selfCrosshair,
      selfHand,
      selfText
    } = this.ui.elements;

    if (selfCircle) selfCircle.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfSquare) selfSquare.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfCrosshair) selfCrosshair.style.display = 'none';
    if (selfHand) selfHand.style.display = 'none';
    if (selfText) selfText.style.display = 'none';
  }

  /**
   * Handles blend mode change for the active layer.
   * @param {string} blendMode - The canvas blend mode to apply.
   */
  handleBlendModeChange(blendMode) {
    const activeLayer = this.self.activeLayer;

    if (!this.board.layerManager.getLayerAllowComplexBlendModes(activeLayer)) {
      blendMode = 'source-over';
    }

    this.self.setBlendMode(blendMode);
    this.board.createActiveLayerBlendSubLayer(blendMode);
    const cssMode = this.blendModeManager.toCSSBlendMode(blendMode);
    this.board.topCanvas.style.mixBlendMode = cssMode;
    this.ui.updateTextPreviewBlendMode(cssMode);
    this._updateTextPreview();

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastLayerBlendModeChange(activeLayer, blendMode));
    }
  }

  /**
   * Clears the entire board.
   */
  handleClear() {
    if (!this.moderation || !this.moderation.isMod()) {
      this.ui.showToast('Only moderators can clear the canvas', 3000, 'error');
      return;
    }
    this.board.clear();
    this.board.tileTracker?.clear();
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastClear());
    if (this.debugOverlay) {
      this.debugOverlay.clearAll();
    }
  }

  /**
   * Resets the board's view transformation (zoom and pan).
   */
  handleResetBoard() {
    this.board.resetView();
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.boardViewer?.setMainZoom(this.board.zoom);
  }

  /**
   * Toggles a local-only horizontal flip of the canvas viewport.
   */
  handleToggleCanvasFlip() {
    const enabled = this.board.toggleCanvasFlip();
    this.ui.updateCanvasFlipDisplay(enabled);
  }

  _ensureUserContextMenu() {
    if (this.ui.elements.userContextMenu) return;

    const menu = document.createElement('div');
    menu.id = 'userContextMenu';
    menu.className = 'contextMenu';
    menu.style.display = 'none';
    menu.innerHTML = `
      <button type="button" class="menuItem" data-action="profile">Profile</button>
      <button type="button" class="menuItem" data-action="sync">Sync</button>
      <button type="button" class="menuItem" data-action="spectate">Spectate</button>
      <button type="button" class="menuItem" data-action="pm">Message</button>
      <div class="menuDivider"></div>
      <button type="button" class="menuItem" data-action="mute">Mute</button>
      <button type="button" class="menuItem danger" data-action="kick">Kick</button>
      <button type="button" class="menuItem danger" data-action="ban">Ban</button>
      <button type="button" class="menuItem danger" data-action="wipe">Wipe Strokes</button>
      <div class="menuDivider adminOnly"></div>
      <button type="button" class="menuItem adminOnly" data-action="promote">Promote</button>
      <button type="button" class="menuItem adminOnly" data-action="demote">Demote</button>
      <button type="button" class="menuItem deityOnly" data-action="promoteNoble">Promote Noble</button>
      <button type="button" class="menuItem deityOnly" data-action="promoteHoly">Promote Holy</button>
      <button type="button" class="menuItem deityOnly" data-action="demoteGlobal">Demote Global</button>
      <button type="button" class="menuItem deityOnly" data-action="shadowban">Shadowban</button>
    `;
    document.body.appendChild(menu);
    this.ui.elements.userContextMenu = menu;
  }

  /**
   * Binds a button-like element so touch/pen pointer releases activate
   * immediately without waiting for a synthesized click.
   * @param {HTMLElement|null} element
   * @param {(event: Event) => void} handler
   */
  bindPressAction(element, handler) {
    if (!element || typeof handler !== 'function') return;

    let lastPointerActivationAt = 0;
    const activationWindowMs = 400;

    element.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      lastPointerActivationAt = performance.now();
      e.preventDefault();
      handler(e);
    });

    element.addEventListener('click', (e) => {
      if (performance.now() - lastPointerActivationAt < activationWindowMs) {
        e.preventDefault();
        return;
      }
      handler(e);
    });
  }

  /**
   * Disables keyboard button activation and focus navigation while the drawing UI is active.
   * This keeps focused controls from re-firing on Space/Enter and stops Tab from
   * cycling through the app chrome during drawing.
   * @param {KeyboardEvent} event
   */
  suppressButtonKeyboardActivation(event) {
    if (!event) {
      return;
    }

    if (this.landingPage?.isVisible) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const editableTarget = target?.closest('input, textarea, select, [contenteditable="true"]');

    if (event.key === 'Tab' || event.key === 'Alt') {
      if (!editableTarget) {
        event.preventDefault();
      }
      return;
    }

    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') {
      return;
    }

    const buttonTarget = target
      ? target.closest('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')
      : null;

    if (!buttonTarget || buttonTarget.disabled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Toggles canvas mirroring.
   */
  handleToggleMirror() {
    this.mirrorRegionController?.begin();
  }

  /**
   * Toggles development mode overlays and panels.
   */
  handleToggleDevMode() {
    const enabled = this.debugOverlay.toggle();
    this.ui.updateDevModeDisplay(enabled);
    this.strokeHistoryPanel.setEnabled(enabled);
    // Also show performance debug panel when dev mode is enabled
    if (enabled && this.performanceDebugPanel && !this.performanceDebugPanel.enabled) {
      this.performanceDebugPanel.toggle();
      this.performanceDebugPanel.update();
    }
  }

  /**
   * Zooms in on the canvas.
   */
  handleZoomIn() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomIn(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.boardViewer?.setMainZoom(this.board.zoom);
  }

  /**
   * Zooms out on the canvas.
   */
  handleZoomOut() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomOut(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
    this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
    this.boardViewer?.setMainZoom(this.board.zoom);
  }

  /**
   * Resets the canvas rotation to zero.
   */
  handleResetRotation() {
    this.board.resetRotation();
  }

  // Brush/tool settings

  handleSizeChange(e) {
    this.clearActiveCustomPreset();
    const size = Number(e.target.value);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSizeChange(size));
    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine(this.self.pressure, size);
    }
    this.self.setSize(size);
    appState.currentSize = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSquarePositions(size);
    const cursorStyle = this.ui.getCursorStyleForTool(this.self.tool, this.self);
    // Update pressure indicators only for tools that use pressure
    const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur'];
    if (pressureTools.includes(this.self.tool) && cursorStyle === 'circle') {
      this.ui.updatePressureCursorRadius(this.self.pressure * size, size, this.tabletDetected);
    }
    if ((this.self.tool === 'imageBrush' || cursorStyle === 'square') && this.self.tool !== 'glitchBlur') {
      this.ui.updatePressureSquareSize(this.self.pressure * size, size, this.tabletDetected);
    }
    this.ui.updateSelfTextStyle(size, this.self.color, this.self.font);
    this.ui.updateSizeValue(size);
    this.board.mainCtx.lineWidth = size * 2;
    this.updateCurrentToolPresetSettings();
  }

  handleSpacingChange(e) {
    this.clearActiveCustomPreset();
    const spacing = Number(e.target.value);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSpacingChange(spacing));
    this.self.setSpacing(spacing);
    this.ui.updateSpacingValue(spacing);
    this.updateCurrentToolPresetSettings();
  }

  handleSmoothingChange(e) {
    this.clearActiveCustomPreset();
    const smoothing = Number(e.target.value);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSmoothingChange(smoothing));
    this.self.setSmoothing(smoothing);
    this.ui.updateSmoothingValue(smoothing);
    this.updateCurrentToolPresetSettings();
  }

  handleHardnessChange(e) {
    this.clearActiveCustomPreset();
    const hardness = Number(e.target.value);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHardnessChange(hardness));
    this.self.setHardness(hardness);
    this.ui.updateHardnessValue(hardness);
    this.updateCurrentToolPresetSettings();
  }

  handleopacityChange(e) {
    this.clearActiveCustomPreset();
    const opacity = Number(e.target.value) / 100; // Convert to 0-1 range
    this.commitSelfEraserSegment(this.self.pressure, this.self.size, opacity);

    // Update user opacity (same as color picker alpha)
    const currentColor = [...this.self.color];
    currentColor[3] = opacity;
    
    // Broadcast to other users
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(currentColor));
    }

    this.self.setOpacity(opacity);
    this.ui.updateopacityValue(opacity);

    // Update color picker to match
    this.self.setColor(currentColor);
    this.colorPicker.setColor(`rgba(${currentColor.join(',')})`);
    appState.currentColor = [...currentColor];
    this.updateCurrentToolPresetSettings();
  }

  handleBlurRadiusChange(e) {
    this.clearActiveCustomPreset();
    const radius = this.setSelfBlurRadiusForCurrentTool(Number(e.target.value));
    if (e.target) e.target.value = radius;
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBlurRadiusChange(radius));
    }
    this.ui.updateBlurRadiusValue(radius);
    this.updateCurrentToolPresetSettings();
  }

  getBlurRadiusMaxForTool(toolName = this.self?.tool) {
    return toolName === 'blur' ? BLUR_RADIUS_MAX : GLITCH_BLUR_RADIUS_MAX;
  }

  clampBlurRadiusForTool(radius, toolName = this.self?.tool) {
    const value = Number(radius);
    const max = this.getBlurRadiusMaxForTool(toolName);
    return Math.max(1, Math.min(max, Number.isFinite(value) ? value : 5));
  }

  setSelfBlurRadiusForCurrentTool(radius) {
    const clamped = this.clampBlurRadiusForTool(radius);
    this.self.setBlurRadius(clamped);
    return clamped;
  }

  applyBlurRadiusLimitForTool(toolName = this.self?.tool, options = {}) {
    const max = this.getBlurRadiusMaxForTool(toolName);
    const slider = this.ui?.elements?.blurRadiusSlider;
    if (slider) {
      slider.max = String(max);
    }

    const clamped = this.clampBlurRadiusForTool(this.self.blurRadius, toolName);
    const changed = clamped !== this.self.blurRadius;
    if (changed) {
      this.self.setBlurRadius(clamped);
    }
    if (slider) {
      slider.value = clamped;
    }
    this.ui.updateBlurRadiusValue(clamped);

    if (changed && options.broadcast && this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBlurRadiusChange(clamped));
    }
  }

  handleThinningChange(e) {
    this.clearActiveCustomPreset();
    const thinning = Number(e.target.value) / 100; // Convert to 0-1 range
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastThinningChange(thinning));
    }
    this.self.setThinning(thinning);
    this.ui.updateThinningValue(Math.round(thinning * 100));
    this.updateCurrentToolPresetSettings();
  }

  handleSimulatePressureChange(e) {
    const simulate = e.target.checked;
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSimulatePressureChange(simulate));
    }
    this.self.setSimulatePressure(simulate);
  }

  async handleBrushFileLoad(e) {
    const file = e.target.files[0];
    if (!file) return;

    const brushTool = this.toolManager.getTool('imageBrush');
    const brushData = await brushTool.loadBrush(file, this.self);

    if (brushData) {
      const lowerType = file.name.split('.').pop().toLowerCase();
      if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(lowerType)) {
        const customAsset = assetLibrary.addCustomAsset({
          kind: 'imageBrush',
          type: brushData.type,
          fileName: file.name,
          fileType: lowerType,
          dataUrl: brushData.previewUrl || brushData.gimpUrl,
          gimpUrl: brushData.previewUrl || brushData.gimpUrl,
          svgContent: brushData.svgContent || null,
          brushName: brushData.brushName || file.name.replace(/\.[^/.]+$/, '')
        });
        if (this.brushGallery.realGallery) {
          this.brushGallery.realGallery.registerBrush({
            ...brushData,
            ...customAsset,
            image: brushData.image,
            images: brushData.images
          });
        }
      }

      // Clone brushData without image/images properties for transmission
      const broadcastData = { ...brushData };
      delete broadcastData.image;
      delete broadcastData.images;

      // Queue the brush change (snapshots pending strokes with old brush FIRST)
      // BEFORE updating this.self.imageBrush
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastBrush(broadcastData));

      // NOW update to the new brush for future strokes
      this.self.imageBrush = brushData;
      this.ui.setBrushPreview(brushData.previewUrl || brushData.gimpUrl || brushData.gBrushes[0].gimpUrl);
    }
    e.target.value = '';
  }

  handleChatSend(message) {
    const messageId = this._createChatMessageId();
    // Show immediately in chat (Svelte component handles its own state)
    if (this.svelteComponents?.chat) {
      this.svelteComponents.chat.addChatMessage(
        this.self.username,
        message,
        this._chatNameColor(this.self.color),
        this.sessionIndex,
        messageId
      );
    }
    broadcastChatPopoutEvent('addChatMessage', [
      this.self.username,
      message,
      this._chatNameColor(this.self.color),
      this.sessionIndex,
      messageId
    ]);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastChat(message, messageId));
  }

  handleStaffChatSend(message) {
    const messageId = this._createChatMessageId();
    if (this.svelteComponents?.chat) {
      this.svelteComponents.chat.addStaffMessage(
        this.self.username,
        message,
        this._chatNameColor(this.self.color),
        this.sessionIndex,
        messageId
      );
    }
    broadcastChatPopoutEvent('addStaffMessage', [
      this.self.username,
      message,
      this._chatNameColor(this.self.color),
      this.sessionIndex,
      messageId
    ]);
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastStaffChat(message, messageId));
  }

  handleStaffChatImageSend(imageData) {
    if (!this.connected) return;

    const messageId = this._createChatMessageId();
    this.inputBufferManager.queueBroadcast(() => {
      const result = this.wsClient.broadcastStaffChatImage(imageData, messageId);
      if (!result?.ok) {
        this.ui?.showToast(result?.error || 'Failed to send chat image', 3000, 'error');
        return;
      }

      this.svelteComponents?.chat?.addStaffImage(imageData, this.self, messageId);
      broadcastChatPopoutEvent('addStaffImage', [imageData, this._chatPopoutUser(this.self, this.sessionIndex), messageId]);
    });
  }

  handleDMSend(message, recipientId) {
    if (this.connected) {
      const messageId = this._createChatMessageId();
      this.svelteComponents?.chat?.addChatDM(message, recipientId, true, messageId);
      broadcastChatPopoutEvent('addChatDM', [message, recipientId, true, messageId]);
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastDM(message, recipientId, messageId));
    }
  }

  handleChatImageSend(imageData, recipientId = null) {
    if (!this.connected) return;

    const messageId = this._createChatMessageId();
    this.inputBufferManager.queueBroadcast(() => {
      const result = this.wsClient.broadcastChatImage(imageData, recipientId, messageId);
      if (!result?.ok) {
        this.ui?.showToast(result?.error || 'Failed to send chat image', 3000, 'error');
        return;
      }

      if (recipientId !== null && recipientId !== undefined) {
        this.svelteComponents?.chat?.addDMImage(imageData, recipientId, true, messageId);
        broadcastChatPopoutEvent('addDMImage', [imageData, recipientId, true, messageId]);
      } else {
        this.svelteComponents?.chat?.addChatImage(imageData, this.self, messageId);
        broadcastChatPopoutEvent('addChatImage', [imageData, this._chatPopoutUser(this.self, this.sessionIndex), messageId]);
      }
    });
  }

  handleChatReaction(payload) {
    if (this.connected && payload?.messageId && payload?.emoji) {
      broadcastChatPopoutEvent('applyReaction', [payload]);
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastChatReaction(payload));
    }
  }

  _createChatMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  _chatNameColor(color) {
    if (!Array.isArray(color)) return color || '#8ba3c7';
    const [r = 139, g = 163, b = 199] = color;
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    if (luminance < 72) return 'var(--role-user)';
    return `rgb(${r}, ${g}, ${b})`;
  }

  _chatPopoutUser(user, fallbackSessionIndex = null) {
    if (!user || typeof user !== 'object') return null;
    return {
      id: user.id ?? user.sessionIndex ?? fallbackSessionIndex ?? null,
      sessionIndex: user.sessionIndex ?? user.id ?? fallbackSessionIndex ?? null,
      username: user.username || user.name || '',
      name: user.name || user.username || '',
      color: user.color,
      registeredName: user.registeredName || '',
      role: user.role || 0,
      visibleIp: user.visibleIp || '',
      tool: user.tool || 'brush',
      afk: !!user.afk
    };
  }

  updateChatUserList() {
    // Update the users store for Svelte Chat component
    const userMap = new Map();
    this.users.forEach((user, id) => {
      if (id !== this.sessionIndex) { // Exclude self
        userMap.set(id, {
          id,
          username: user.username || user.name || '',
          color: this._chatNameColor(user.color),
          registeredName: user.registeredName || '',
          role: user.role || 0,
          visibleIp: user.visibleIp || '',
          tool: user.tool || 'brush',
          afk: !!user.afk,
          isSelf: false
        });
      }
    });

    // Update the users store
    appState.users = userMap;
  }

  handlePaletteColorSelect(colorOrCallback) {
    // If it's a callback (from the add button), pass the current color
    if (typeof colorOrCallback === 'function') {
      colorOrCallback(this.self.color);
      return;
    }

    // Otherwise, select the color and update picker
    this.clearActiveCustomPreset();
    const color = colorOrCallback;
    this.self.setColor(color);
    this.self.setOpacity(color[3]);
    appState.currentColor = [...color];
    this._syncActiveColorSlot(color);
    this.ui.updateSelfColor(color);
    this.ui.updateSelfTextStyle(this.self.size, color, this.self.font);
    this.ui.updateopacityValue(color[3]);

    // Update the color picker to match
    if (this.colorPicker) {
      this.colorPicker.setColor(`rgba(${color.join(',')})`);
    }

    // Update pattern tools when color changes (for tinted color modes)
    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      patternTool._tileCache.clear();
      patternTool.updatePreview(this.self);
    }

    const fillTool = this.toolManager.getTool('fill');
    if (fillTool && fillTool._patternTileCache) {
      fillTool._patternTileCache.clear();
    }

    const selectTool = this.toolManager.getTool('select');
    if (selectTool && selectTool._patternTileCache) {
      selectTool._patternTileCache.clear();
    }

    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(color));
    }

    addRecentColor(color);
    this.updateCurrentToolPresetSettings();
  }

  getCurrentToolPresetSettings(toolName = this.self?.tool) {
    const lockConfig = this.toolLockManager?.toolLocks?.[toolName];
    if (!this.self || !lockConfig) return {};

    const settings = {};
    for (const property of Object.keys(lockConfig)) {
      if (property === 'pressure') {
        settings.pressureMin = Number(this.ui.elements.pressureMinSlider?.value ?? 0);
        settings.pressureMax = Number(this.ui.elements.pressureMaxSlider?.value ?? 100);
        settings.pressureEnabled = !!this.pressureEnabled;
      } else if (property === 'opacity') {
        settings.opacity = this.self.opacity;
      } else {
        settings[property] = this.self[property];
      }
    }

    return settings;
  }

  updateCurrentToolPresetSettings() {
    if (!this.self) return;
    appState.currentTool = this.self.tool;
    appState.currentSize = this.self.size;
    appState.currentColor = [...this.self.color];
    appState.currentToolSettings = this.getCurrentToolPresetSettings();
  }

  clearActiveCustomPreset() {
    appState.activeCustomPresetKey = null;
  }

  applyCustomPreset(preset) {
    if (!preset?.color) return;

    if (preset.tool) {
      this.selectTool(preset.tool);
    }

    const colorlessTools = ['erase', 'blur', 'circleBlur', 'glitchBlur', 'select', 'pan', 'zoom', 'rotate', 'inkdropper'];
    if (!colorlessTools.includes(preset.tool)) {
      this.handlePaletteColorSelect(preset.color);
    }

    if (preset.size != null) {
      this.handleSizeChange({ target: { value: preset.size } });
    }

    if (preset.settings) {
      this.applyCustomPresetSettings(preset.settings);
    }

    this.updateCurrentToolPresetSettings();
    appState.activeCustomPresetKey = getCustomPresetKey(preset);
  }

  applyCustomPresetSettings(settings) {
    for (const [property, value] of Object.entries(settings)) {
      if (property === 'size') this.handleSizeChange({ target: { value } });
      else if (property === 'spacing') this.handleSpacingChange({ target: { value } });
      else if (property === 'smoothing') this.handleSmoothingChange({ target: { value } });
      else if (property === 'hardness') this.handleHardnessChange({ target: { value } });
      else if (property === 'opacity') this.handleopacityChange({ target: { value: value * 100 } });
      else if (property === 'blurRadius') this.handleBlurRadiusChange({ target: { value } });
      else if (property === 'thinning') this.handleThinningChange({ target: { value: value * 100 } });
      else if (property === 'pressureMin' && this.ui.elements.pressureMinSlider) {
        this.ui.elements.pressureMinSlider.value = value;
        this.ui.updatePressureValue(value, Number(this.ui.elements.pressureMaxSlider?.value ?? 100));
      } else if (property === 'pressureMax' && this.ui.elements.pressureMaxSlider) {
        this.ui.elements.pressureMaxSlider.value = value;
        this.ui.updatePressureValue(Number(this.ui.elements.pressureMinSlider?.value ?? 0), value);
      } else if (property === 'pressureEnabled') {
        this.pressureEnabled = !!value;
        if (this.ui.elements.pressureEnabled) this.ui.elements.pressureEnabled.checked = !!value;
        if (this.ui.elements.pressureDualSlider) this.ui.elements.pressureDualSlider.style.display = value ? '' : 'none';
      }
    }
  }

  handleColorInputChange(rgba) {
    this.commitSelfEraserSegment(this.self.pressure, this.self.size, rgba[3]);
    // Update self's color
    this.self.setColor(rgba);
    this.self.setOpacity(rgba[3]);
    this.ui.updateSelfColor(rgba);
    this.ui.updateSelfTextStyle(this.self.size, rgba, this.self.font);
    this.ui.updateopacityValue(rgba[3]);

    // Update the color picker to match
    if (this.colorPicker) {
      this.colorPicker.setColor(rgba);
    }

    // Update pattern tools when color changes (for tinted color modes)
    const patternTool = this.toolManager.getTool('pattern');
    if (patternTool) {
      patternTool._tileCache.clear();
      patternTool.updatePreview(this.self);
    }

    const fillTool = this.toolManager.getTool('fill');
    if (fillTool && fillTool._patternTileCache) {
      fillTool._patternTileCache.clear();
    }

    const selectTool = this.toolManager.getTool('select');
    if (selectTool && selectTool._patternTileCache) {
      selectTool._patternTileCache.clear();
    }

    // Broadcast to other users if connected
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastColorChange(rgba));
    }

    // Add to recent colors (Svelte store)
    addRecentColor(rgba);
    appState.currentColor = [...rgba];
    this.updateCurrentToolPresetSettings();
  }

  // Pointer event handlers

  isPointerOverBoard(clientX, clientY) {
    const boardSurfaceEl = this.ui?.elements?.boards || this.ui?.elements?.board;
    if (!boardSurfaceEl || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;

    // The drawable surface is continuously transformed by pan/zoom/rotate, so a
    // cached bounding rect quickly becomes stale and causes false "off board"
    // results in parts of the visible canvas.
    const rect = boardSurfaceEl.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;

    // Treat all board-owned layers as valid hover targets while still rejecting
    // unrelated UI that overlaps the board area.
    const topEl = document.elementFromPoint(clientX, clientY);
    return topEl !== null && boardSurfaceEl.contains(topEl);
  }

  syncBoardHoverState(isOnBoard, { forceRefresh = false, event = null } = {}) {
    const cursorHidden = this.ui?.elements?.selfCursor?.style.display === 'none';
    const shouldRefresh = forceRefresh || (isOnBoard && cursorHidden);
    if (this.isOnBoard === isOnBoard && !shouldRefresh) {
      return;
    }

    this.isOnBoard = isOnBoard;

    if (isOnBoard) {
      const inTouchGesture =
        this.touchHandler.state.isPinching ||
        this.touchHandler.state.gestureStartedWithTwoFingers;
      if (inTouchGesture && this.self.tool !== 'text') {
        return;
      }

      this.ui.showCursor();
      const isTextWithContent = this.self.tool === 'text' && this.self.text;
      if (this.self.panning && this.self.tool !== 'pan' && !isTextWithContent) {
        this.ui.showPanCursor();
      } else {
        this.ui.updateToolDisplay(this.self.tool, this.self);
        this._updateBlurCannotDraw();
      }
      if (this.connected) {
        if ((this.self.panning || this.self.tool === 'pan') && !isTextWithContent) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHideCursor());
        } else {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastShowCursor());
        }
      }
      return;
    }

    if (this.self.mousedown || this.self.tool === 'text') {
      return;
    }

    // Some stylus drivers emit leave during hover/contact transitions. If the
    // pointer is still physically over the board, keep the cursor visible.
    if (event && this.isPointerOverBoard(event.clientX, event.clientY)) {
      this.isOnBoard = true;
      if (shouldRefresh) {
        this.ui.showCursor();
        if (this.self.panning && this.self.tool !== 'pan') {
          this.ui.showPanCursor();
        } else {
          this.ui.updateToolDisplay(this.self.tool, this.self);
          this._updateBlurCannotDraw();
        }
      }
      return;
    }

    this.ui.hideCursor();
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHideCursor());
    }
  }

  _toolMutatesCanvas(toolName = this.self?.tool) {
    return !['pan', 'zoom', 'rotate', 'inkdropper'].includes(toolName);
  }

  _toolUsesPressure(toolName = this.self?.tool) {
    return ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur', 'imageBrush'].includes(toolName);
  }

  _getPointerSamplePressure(e, fallbackPressure = this.self?.pressure ?? 1, fallbackPointerType = e.pointerType) {
    if (!this._toolUsesPressure(this.self.tool) || !this.pressureEnabled) {
      return 1;
    }
    const pointerType = e.pointerType || fallbackPointerType;
    if (pointerType !== 'pen' || this.self.panning) {
      return fallbackPressure;
    }
    if (e.pressure === 0) {
      return this.self.mousedown ? fallbackPressure : 0;
    }
    const minP = Number(this.ui.elements.pressureMinSlider.value) / 100;
    const maxP = Number(this.ui.elements.pressureMaxSlider.value) / 100;
    const mappedPressure = minP + (maxP - minP) * e.pressure;
    return Math.round(mappedPressure * 100) / 100;
  }

  _bufferPointerSample(e, fallbackPointerType = e.pointerType) {
    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    const constrainedPos = this.getConstrainedShapeDragPoint(pos.x, pos.y);
    const pressure = this._getPointerSamplePressure(e, this.self?.pressure ?? 1, fallbackPointerType);
    this.inputBufferManager.inputBuffer.points.push(constrainedPos.x, constrainedPos.y, pressure);
    this.inputBufferManager.inputBuffer.pointerType = e.pointerType || fallbackPointerType;
    this.inputBufferManager.inputBuffer.dirty = true;
    return constrainedPos;
  }

  _isPointerOnUiControl(eventTarget) {
    if (!(eventTarget instanceof Element)) return false;
    return !!eventTarget.closest(
      'input, select, textarea, button, .slider, .sliderValue, .dual-slider, #toolSliders, #toolExtras'
    );
  }

  _isCanvasRegionLocked(pos, previousPos = null) {
    if (!this.board || !this._toolMutatesCanvas()) return false;
    if (!this.board.hasInteractionBlocks?.()) return false;
    if (previousPos && this.board.segmentIntersectsInteractionBlock(previousPos, pos)) return true;
    return this.board.isPointInInteractionBlock(pos);
  }

  _notifyCanvasRegionLocked() {
    if (this._lastInteractionBlockToast && Date.now() - this._lastInteractionBlockToast < 1500) {
      return;
    }
    this._lastInteractionBlockToast = Date.now();
    this.ui.showToast('That region is being restored right now', 2000);
  }

  _cancelBlockedCanvasInteraction() {
    this._pendingPenDown = null;
    this.inputBufferManager.inputBuffer.points = [];
    this.inputBufferManager.inputBuffer.dirty = false;
    this.cancelCurrentStroke();
  }

  handlePointerMove(e) {
    this.updateModifierKeysFromEvent(e);

    const hasActiveBoardInteraction =
      this.self.mousedown ||
      this.self.panning ||
      this._containerPanActive ||
      this._rightDragZoomActive ||
      this._rotateToolActive ||
      !!this.self._pendingTextPos;
    if (!hasActiveBoardInteraction && this._isPointerOnUiControl(e.target)) {
      return;
    }

    if (this.mirrorRegionController?.isActive()) {
      const consumed = this.mirrorRegionController.handlePointerMove(e);
      if (consumed) return;
    }

    // Block local input while syncing
    if (this.syncClient?.isSyncing() || this.syncClient?.isCanvasInputBlocked()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      if (this.self.tool !== 'text') {
        this.ui.hideCursor();
      }
      return;
    }

    // Rotate tool: compute angle from pivot to pointer and apply delta
    if (this._rotateToolActive) {
      const currAngle = Math.atan2(
        e.clientY - this._rotatePivotClientY,
        e.clientX - this._rotatePivotClientX
      );
      if (this._rotatePrevAngle !== null) {
        let delta = currAngle - this._rotatePrevAngle;
        // Unwrap to [-π, π] to avoid jumps when crossing ±180°
        if (delta > Math.PI)  delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        const newRotation = this.board.rotation + delta * (180 / Math.PI);
        this.board.setRotationAround(newRotation, this._rotatePivotX, this._rotatePivotY);
      }
      this._rotatePrevAngle = currAngle;
      return;
    }

    if (this._rightDragZoomActive && e.pointerId === this._rightDragZoomPointerId) {
      const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
      const deltaY = e.clientY - this._rightDragZoomStartClientY;
      const zoomFactor = Math.pow(2, -deltaY / 240);
        this.board.setZoomAround(
          this._rightDragZoomStartZoom * zoomFactor,
          this._rightDragZoomPivotX,
          this._rightDragZoomPivotY
        );
        this.ui.updateZoomDisplay(this.board.getZoomPercent());
        this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
        this.boardViewer?.setMainZoom(this.board.zoom);
        return;
    }

    // Pointer moves are listened to on window so active drags can continue off-canvas.
    // When the pointer is simply hovering outside the board, suppress local buffering
    // and remote broadcasts so replay/history do not accumulate phantom cursor moves.
    this.syncBoardHoverState(this.isPointerOverBoard(e.clientX, e.clientY), { event: e });
    if (!this.isOnBoard && !hasActiveBoardInteraction) {
      return;
    }

    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    const x = pos.x;
    const y = pos.y;

    if (this.self.mousedown && !this.self.panning) {
      const previousPos = this.inputBufferManager.inputBuffer.lastPosition || { x: this.self.x, y: this.self.y };
      if (this._isCanvasRegionLocked(pos, previousPos)) {
        this._cancelBlockedCanvasInteraction();
        this._notifyCanvasRegionLocked();
        return;
      }
    }

    // Text tool: update pending position for touch drag preview
    if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
      this.self._pendingTextPos = { x, y };
      this.self.setPosition(x, y);
      this.ui.updateSelfCursor(x, y, this.self.size);
      
      // Broadcast movement so remote users see the text cursor updating
      if (this.connected) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseMove(x, y));
      }
      return;
    }

    // Update cursor immediately for visual responsiveness
    this.ui.updateSelfCursor(x, y, this.self.size);
    if (this.self.tool === 'text') this._updateTextPreview();
    if (this.self.tool === 'inkdropper') {
      const tool = this.toolManager.getCurrentTool();
      tool?.onPointerMove?.(this.self, pos, this.inputBufferManager.inputBuffer.lastPosition || pos, e);
      if (!this.self.mousedown) return;
    }

    // Handle pressure for pen input — default to current pressure so non-pen
    // events (e.g. palm touch) mid-stroke don't slam pressure to 1
    let pressure = this.self.pressure;
    const toolUsesPressure = this._toolUsesPressure(this.self.tool);
    if (!toolUsesPressure || !this.pressureEnabled) {
      pressure = 1;
    } else if (e.pointerType === 'pen' && !this.self.panning) {
      // On pen lift (e.pressure === 0), keep the last known pressure if mid-stroke.
      // The browser fires a 0-pressure pointerMove just before pointerUp; processing
      // it would cause zero-size drawing artifacts. The stroke end is handled by pointerUp.
      if (e.pressure === 0) {
        pressure = this.self.mousedown ? this.self.pressure : 0;
      } else {
        const minP = Number(this.ui.elements.pressureMinSlider.value) / 100;
        const maxP = Number(this.ui.elements.pressureMaxSlider.value) / 100;
        pressure = minP + (maxP - minP) * e.pressure;
        pressure = Math.round(pressure * 100) / 100;
      }

      // Update pressure indicators only for tools that use pressure
      const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur'];
      const cursorStyle = this.ui.getCursorStyleForTool(this.self.tool, this.self);
      if (pressureTools.includes(this.self.tool) && cursorStyle === 'circle') {
        this.ui.updatePressureCursorRadius(pressure * this.self.size, this.self.size, this.tabletDetected);
      }
      if ((this.self.tool === 'imageBrush' || cursorStyle === 'square') && this.self.tool !== 'glitchBlur') {
        this.ui.updatePressureSquareSize(pressure * this.self.size, this.self.size, this.tabletDetected);
      }

      // If stroke start was deferred, now we have real pressure - start the stroke
      if (this._pendingPenDown) {
        const pending = this._pendingPenDown;
        this._pendingPenDown = null;
        this.self.setPressure(pressure);
        this.inputBufferManager.inputBuffer.pressure = pressure;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(pressure));
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseDown([pending.pos.x, pending.pos.y]));

        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          tool.onPointerDown(this.self, pending.pos, pending.event);

          // Discard initial stamp from buffer — remote already stamps via handlePenDown (MD)
          if (this.self.tool === 'flowPen' && tool.drainStampBuffer) {
            tool.drainStampBuffer();
          }
          if (this.self.tool === 'ink' && tool.drainPointBuffer) {
            tool.drainPointBuffer();
          }

          this.debugOverlay.startStrokeTracking(this.self.id, true);
          this.debugOverlay.addStrokePoint(this.self.id, pending.pos.x, pending.pos.y, 'pointerDown');
        }
      } else if (pressure !== this.inputBufferManager.inputBuffer.pressure) {
        // Brush still commits per segment before updating pressure.
        if (pressure !== this.self.pressure && this.self.mousedown) {
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(pressure));
          if (this.self.tool === 'brush') {
            this.commitSelfLine(pressure, this.self.size);
          }
        }
        this.self.setPressure(pressure);
        this.inputBufferManager.inputBuffer.pressure = pressure;
      }
    }

    const pushBufferedSample = (sampleEvent) => {
      const sampleConstrainedPos = this._bufferPointerSample(sampleEvent, e.pointerType);
      return {
        x: sampleConstrainedPos.x,
        y: sampleConstrainedPos.y,
        pointerType: sampleEvent.pointerType || e.pointerType,
      };
    };

    const shouldUseCoalescedSamples =
      this.self.mousedown &&
      !this.self.panning &&
      COALESCED_INPUT_TOOLS.has(this.self.tool);
    const coalescedSamples = shouldUseCoalescedSamples ? e.getCoalescedEvents?.() : null;
    const samples = shouldUseCoalescedSamples && coalescedSamples?.length ? coalescedSamples : [e];

    let lastBufferedSample = null;
    for (const sample of samples) {
      lastBufferedSample = pushBufferedSample(sample);
    }

    this.inputBufferManager.inputBuffer.pointerType = lastBufferedSample?.pointerType || e.pointerType;
    this.inputBufferManager.requestLocalFrame();
    // Handle panning instantaneously (bypasses input buffer for better responsiveness)
    if (this.self.panning && this.self.mousedown) {
      const dx = e.clientX - this._lastPanPointerX;
      const dy = e.clientY - this._lastPanPointerY;
      this.board.pan(dx, dy);
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
    }

    // Track drawing for debug overlay (pass brush size and user info)
    if (this.self.mousedown && !this.self.panning) {
      const debugPoint = lastBufferedSample || { x, y };
      this.debugOverlay.addDrawingPoint(debugPoint.x, debugPoint.y, this.self.size, this.self.id);
    }
  }

  handlePointerDown(e) {
    this.updateModifierKeysFromEvent(e);

    if (this.mirrorRegionController?.isActive()) {
      const consumed = this.mirrorRegionController.handlePointerDown(e);
      if (consumed) return;
    }

    // Reset smoothing buffer and state for new stroke immediately
    this.inputBufferManager.resetBroadcastSmoothing();
    this.self._mainCtxDrawCount = 0;
    this.self.mousedown = false;

    // Block local input while not yet connected (connecting overlay is showing)
    if (!this.connected && !this.isOfflineMode) return;

    // Block local input while syncing
    if (this.syncClient?.isSyncing() || this.syncClient?.isCanvasInputBlocked()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      if (this.self.tool !== 'text') {
        this.ui.hideCursor();
      }
      return;
    }

    if (this.keyboardHandler?.handlePointerDown(e)) {
      return;
    }

    this.syncBoardHoverState(true, { forceRefresh: true, event: e });

    // Middle-click enables panning mode
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this.self.mousedown = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(true));

      const isTextWithContent = this.self.tool === 'text' && this.self.text;
      if (!isTextWithContent) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHideCursor());
        this.ui.showPanCursor();
      }
      return;
    }

    // Pan tool: left drag pans the canvas
    if (this.self.tool === 'pan') {
      if (e.button === 0) {
        this.self.panning = true;
        this.self.mousedown = true;
        this._lastPanPointerX = e.clientX;
        this._lastPanPointerY = e.clientY;
      }
      return;
    }

    if (this.self.tool === 'zoom') {
      if (e.button === 0) {
        const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
        const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
        this._rightDragZoomActive = true;
        this._rightDragZoomPointerId = e.pointerId;
        this._rightDragZoomStartClientY = e.clientY;
        this._rightDragZoomStartZoom = this.board.zoom;
        this._rightDragZoomPivotX = e.clientX - containerRect.left;
        this._rightDragZoomPivotY = e.clientY - containerRect.top;
        this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
        this.ui.showZoomCursor();
        this.self.mousedown = true;
        e.target.setPointerCapture?.(e.pointerId);
      }
      return;
    }

    // Rotate tool: left drag rotates around the click point
    if (this.self.tool === 'rotate') {
      if (e.button === 0) {
        const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
        this._rotatePivotX = e.clientX - containerRect.left;
        this._rotatePivotY = e.clientY - containerRect.top;
        this._rotatePivotClientX = e.clientX;
        this._rotatePivotClientY = e.clientY;
        this._rotatePrevAngle = null;
        this._rotateToolActive = true;
        this.self.mousedown = true;
        e.target.setPointerCapture(e.pointerId);
      }
      return;
    }

    // Right-click drag zooms around the clicked point
    if (e.button === 2) {
      e.preventDefault();
      const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
      const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      this._rightDragZoomActive = true;
      this._rightDragZoomPointerId = e.pointerId;
      this._rightDragZoomStartClientY = e.clientY;
      this._rightDragZoomStartZoom = this.board.zoom;
      this._rightDragZoomPivotX = e.clientX - containerRect.left;
      this._rightDragZoomPivotY = e.clientY - containerRect.top;
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
      this.ui.showZoomCursor();
      e.target.setPointerCapture?.(e.pointerId);
      return;
    }

    // Only draw with left-click (button === 0)
    if (e.button !== 0) return;

    // Block drawing on invisible layers
    if (!this.self.panning && !this.board.layerManager.isLayerVisible(this.self.activeLayer)) {
      if (!this._lastInvisibleToast || Date.now() - this._lastInvisibleToast > 3000) {
        this.ui.showToast('Selected layer is hidden', 2000);
        this._lastInvisibleToast = Date.now();
      }
      return;
    }

    // Block drawing when muted (allow panning)
    if (this.self.isMuted && !this.self.panning) {
      if (!this._lastMuteToast || Date.now() - this._lastMuteToast > 3000) {
        this.ui.showToast('You are muted', 2000);
        this._lastMuteToast = Date.now();
      }
      return;
    }

    // Block blur tool on non-base layers (allow panning)
    if (this._blurCannotDraw && !this.self.panning) {
      if (!this._lastBlurLayerToast || Date.now() - this._lastBlurLayerToast > 3000) {
        this.ui.showToast('Blur only works on Layer 1', 2000);
        this._lastBlurLayerToast = Date.now();
      }
      return;
    }

    // Detect tablet on first pen event
    if (e.pointerType === 'pen' && !this.tabletDetected) {
      this.tabletDetected = true;

      // Auto-disable thinning for tablet users
      this.self.setSimulatePressure(false);
      localStorage.setItem('topDrawSimulatePressure', 'false');
      if (this.ui.elements.thinningEnabled) {
        this.ui.elements.thinningEnabled.checked = false;
      }
      if (this.connected) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSimulatePressureChange(false));
      }

      // Show toast - defer to not block stroke
      setTimeout(() => {
        this.ui.showToast('Tablet detected - disabling thinning', 3000);
      }, 100);
    }

    const toolUsesPressure = this._toolUsesPressure(this.self.tool);
    if (toolUsesPressure) {
      if (e.pointerType === 'mouse' || !this.pressureEnabled) {
        this.self.setPressure(1);
        this.inputBufferManager.inputBuffer.pressure = 1;
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(1));
      } else if (e.pointerType === 'pen' && this.pressureEnabled) {
        // Start pen input at 0 pressure until real pressure data arrives
        this.self.setPressure(0);
        this.inputBufferManager.inputBuffer.pressure = 0;
      }
    } else {
      // Non-pressure tools keep pressure at full to avoid side effects.
      this.self.setPressure(1);
      this.inputBufferManager.inputBuffer.pressure = 1;
    }

    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    if (this._isCanvasRegionLocked(pos)) {
      this._notifyCanvasRegionLocked();
      return;
    }

    // Initialize input buffer for this stroke
    this.inputBufferManager.inputBuffer.position = pos;
    this.inputBufferManager.inputBuffer.lastPosition = pos;
    this.inputBufferManager.inputBuffer.movement = { x: 0, y: 0 };
    this.inputBufferManager.inputBuffer.pointerType = e.pointerType;

    // Reset broadcast smooth buffer for new stroke
    this.inputBufferManager.broadcastSmoothBuffer.isFirst = true;

    // Fully reset self position state for new stroke to prevent jumping
    this.self.resetPosition(pos.x, pos.y);
    // For pen input that will be deferred, update cursor with estimated pressure to avoid showing full-size dot
    if (e.pointerType === 'pen' && this.pressureEnabled && this.self.tool !== 'text' && toolUsesPressure) {
      const estimatedPressure = 0.5; // Reasonable default for initial pen pressure
      const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'glitchBlur'];
      const cursorStyle = this.ui.getCursorStyleForTool(this.self.tool, this.self);
      if (pressureTools.includes(this.self.tool) && cursorStyle === 'circle') {
        this.ui.updatePressureCursorRadius(estimatedPressure * this.self.size, this.self.size, this.tabletDetected);
      } else if ((this.self.tool === 'imageBrush' || cursorStyle === 'square') && this.self.tool !== 'glitchBlur') {
        this.ui.updatePressureSquareSize(estimatedPressure * this.self.size, this.self.size, this.tabletDetected);
      }
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
    } else {
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
    }
    this.self.mousedown = true;
    this.self.spaceIndex = 0;
    this.self._mainCtxDrawCount = 0; // Reset draw counter for this stroke

    // If panning (e.g. via Space key), initialize pan tracking coordinates
    if (this.self.panning) {
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
    }

    // Reset smoothing buffer for new stroke
    this.inputBufferManager.resetBroadcastSmoothing();

    // Defer broadcastMouseDown for pen input — pressure isn't known yet at pointerDown,
    // so sending MD now would cause the remote side to draw the initial dot at max size.
    // It will be sent when _pendingPenDown is resolved in handlePointerMove.
    // Also don't broadcast if panning to prevent unwanted dots when space+click panning.
    // Touch and mouse should broadcast immediately to enable "dots" (single clicks/taps).
    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        // For text tool with touch, don't commit immediately - wait for pointerUp
        // to allow two-finger gestures to cancel the text placement
        if (this.self.tool === 'text' && e.pointerType === 'touch') {
          this.self.mousedown = true;
          // Store pending text position but don't call onPointerDown yet
          this.self._pendingTextPos = pos;
          this.self._pendingTextPointerType = e.pointerType;

          // Update local position so the cursor/preview follows the touch immediately
          this.self.setPosition(pos.x, pos.y);
          this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);

          // Focus hidden input for touch keyboard support
          this.ui.activateTouchInput(e.clientX, e.clientY);
          
          // DO NOT broadcastMouseDown here. We wait until pointerUp for text+touch.
        } else if (e.pointerType === 'pen' && this.pressureEnabled && this.self.tool !== 'text' && toolUsesPressure) {
          // Defer pen stroke start until first pointerMove provides real pressure
          this._pendingPenDown = { pos, event: e };
        } else {
          // Standard immediate placement/stroke start
          
          // For tools that use smoothing, send the smoothed initial point instead of raw click.
          // This ensures remote users see perfect parity with the sender.
          const smoothingTools = ['brush', 'flowPen', 'ink', 'imageBrush'];
          let broadcastPos = [pos.x, pos.y];
          if (smoothingTools.includes(this.self.tool)) {
            const smoothed = this.inputBufferManager.applyBroadcastSmoothing([pos.x, pos.y]);
            broadcastPos = [smoothed[0], smoothed[1]];
            // Update local self position to match the smoothed broadcast position
            this.self.setPosition(smoothed[0], smoothed[1]);
          }
          if (this.self.tool === 'text' && this.self.text) {
            this._broadcastExplicitTextApply({ x: this.self.x, y: this.self.y });
          }
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseDown(broadcastPos));

          tool.onPointerDown(this.self, pos, e);

          // Discard initial stamp from buffer — remote already stamps via handlePenDown (MD)
          if (this.self.tool === 'flowPen' && tool.drainStampBuffer) {
            tool.drainStampBuffer();
          }
          if (this.self.tool === 'ink' && tool.drainPointBuffer) {
            tool.drainPointBuffer();
          }

          // Debug: Start tracking stroke points for local user
          this.debugOverlay.startStrokeTracking(this.self.id, true);
          this.debugOverlay.addStrokePoint(this.self.id, pos.x, pos.y, 'pointerDown');

          // If text tool was used to commit text, update UI to clear the text display
          if (this.self.tool === 'text') {
            this.ui.updateSelfTextInput(this.self.text);
            this._updateTextPreview();
          }
        }
      }

      // Add current color to recent colors when starting to draw
      if (this.self.tool !== 'erase' && this.self.tool !== 'select') {
        addRecentColor(this.self.color);
      }

      // Start tracking for debug overlay (pass tool type, brush size, and user info)
      this.debugOverlay.startDrawing(pos.x, pos.y, this.self.tool, this.self.size, this.self.id, this.self.username);
    }
  }

  _broadcastExplicitTextApply(position = null) {
    if (!this.connected || !this.wsClient || !this.self?.text) return;
    const snapshot = {
      text: this.self.text,
      x: position?.x ?? this.self.x,
      y: position?.y ?? this.self.y,
      size: this.self.size,
      color: [...this.self.color], // spread to clone the array
      opacity: this.self.opacity,
      layerIndex: this.self.activeLayer ?? 0,
      blendMode: this.self.blendMode || 'source-over',
      font: this.self.font,
      textPositionMultiplier: this.self.textPositionMultiplier,
      textPositionOffset: this.self.textPositionOffset
    };

    this.inputBufferManager.queueBroadcast(() => {
      this.wsClient.broadcastTextApply(snapshot);
    });
  }

  handlePointerUp(e) {
    this.updateModifierKeysFromEvent(e);

    if (this.mirrorRegionController?.isActive()) {
      const consumed = this.mirrorRegionController.handlePointerUp(e);
      if (consumed) return;
    }

    if (this.keyboardHandler?.handlePointerUp(e)) return;

    // Block local input while syncing
    if (this.syncClient?.isSyncing() || this.syncClient?.isCanvasInputBlocked()) return;
    if (this._rightDragZoomActive && e.pointerId === this._rightDragZoomPointerId) {
      this._rightDragZoomActive = false;
      this._rightDragZoomPointerId = null;
      if (this.self.tool === 'zoom') {
        this.self.mousedown = false;
      }
        this.ui.hidePanCursor(this.self.tool, this.self);
        this.ui.updateZoomDisplay(this.board.getZoomPercent());
        this.boardViewer?.setMainZoom(this.board.zoom);
        this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
        return;
    }

    // Middle-click release disables temporary panning regardless of active tool
    if (e.button === 1) {
      this.self.panning = false;
      this.self.mousedown = false;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(false));
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastShowCursor());
      this.ui.hidePanCursor(this.self.tool, this.self);
      return;
    }

    // Pan tool: release clears panning
    if (this.self.tool === 'pan') {
      if (e.button === 0) {
        this.self.panning = false;
        this.self.mousedown = false;
      }
      return;
    }

    if (this.self.tool === 'zoom') {
      if (e.button === 0) {
        this.self.mousedown = false;
      }
      return;
    }

    // Rotate tool: release ends rotation
    if (this.self.tool === 'rotate') {
      if (e.button === 0) {
        this._rotateToolActive = false;
        this._rotatePrevAngle = null;
        this.self.mousedown = false;
      }
      return;
    }

    // Only handle left-click release for drawing
    if (e.button !== 0) return;

    // If a two-finger gesture occurred, cancel any pending text placement
    if (this.touchHandler.state.gestureStartedWithTwoFingers) {
      this.self._pendingTextPos = null;
      this.self._pendingTextPointerType = null;
      this.self.mousedown = false;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseUp());
      this.inputBufferManager.inputBuffer.dirty = false;
      return;
    }

    // If pointer was lifted without moving, flush the pending stroke as a single dot.
    // This applies to pen (which deactivates MD broadcast) and any other input
    // that might have finished before the first tick occurred.
    if (this._pendingPenDown || (this.self.mousedown && this.self._mainCtxDrawCount === 0)) {
      const pending = this._pendingPenDown;
      this._pendingPenDown = null;

      // For pen deactivation, we need to manually start the stroke now.
      // For touch/mouse, the stroke already started in handlePointerDown.
      if (pending) {
        // Pen was lifted without moving - pressure starts at 0, so tap will be invisible or tiny
        // This is correct behavior: dots should only appear with intentional pen pressure
        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          // Keep remote pressure state in sync for deferred pen taps. Without this,
          // remote clients reuse the previous stroke's pressure when MD arrives,
          // which can produce a large start dot for pressure-sensitive tools.
          if (this._toolUsesPressure(this.self.tool)) {
            this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPressureChange(this.self.pressure));
          }
          this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseDown([pending.pos.x, pending.pos.y]));
          tool.onPointerDown(this.self, pending.pos, pending.event);
        }
      }
    }

    const shouldBufferPointerUp =
      this.self.mousedown &&
      !this.self.panning &&
      COALESCED_INPUT_TOOLS.has(this.self.tool);
    if (shouldBufferPointerUp) {
      this._bufferPointerSample(e);
    }

    // Flush any locally-rendered-but-not-yet-sent points before ending the stroke.
    this.inputBufferManager.processLocalFrame();
    this.inputBufferManager.flushPendingNetwork();

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();

      // Handle text tool touch placement on lift
      if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
        const textTool = this.toolManager.getTool('text');
        if (textTool) {
          // Broadcast final position before MU so remote users draw it in the right place
          if (this.connected) {
            if (this.self.text) {
              this._broadcastExplicitTextApply(this.self._pendingTextPos);
            }
            this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseDown([this.self._pendingTextPos.x, this.self._pendingTextPos.y]));
          }
          textTool.onPointerDown(this.self, this.self._pendingTextPos, e);
          this.ui.updateSelfTextInput(this.self.text);
        }
        this.self._pendingTextPos = null;
        this.self._pendingTextPointerType = null;
      } else if (tool) {
        tool.onPointerUp(this.self, { x: this.self.x, y: this.self.y }, e);

        // Flush any stamps generated by onPointerUp (e.g. final position stamps)
        if (this.self.tool === 'flowPen' && tool.stampBuffer && tool.stampBuffer.length > 0) {
          const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
          if (stampPs.length > 0) {
            this.wsClient.broadcastStampMove(stampPs, stampRs);
          }
        }

        // Flush ink point buffer on pointer up
        if (this.self.tool === 'ink' && tool.pointBuffer && tool.pointBuffer.length > 0) {
          const { ps: fhPs, rs: fhRs } = tool.drainPointBuffer();
          if (fhPs.length > 0) {
            this.wsClient.broadcastStampMove(fhPs, fhRs);
          }
        }
      }

      // End tracking for debug overlay
      this.debugOverlay.endDrawing(this.self.id);

      // Debug: End stroke tracking for local user
      this.debugOverlay.endStrokeTracking(this.self.id);

    }

    this.self.mousedown = false;
    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastMouseUp());

    // Reset input buffer
    this.inputBufferManager.inputBuffer.dirty = false;
  }

  handlePointerLeave(e) {
    this.syncBoardHoverState(false, { forceRefresh: true, event: e });
    if (this.self.tool === 'inkdropper') {
      this.board.clearTop();
    }
  }

  // boardContainer pointer handlers: pan by dragging the background (Space held or middle-click)

  handleBoardContainerPointerDown(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    // Only handle events on the boardContainer background itself (not bubbled from canvas/children)
    if (e.target !== this.ui.elements.boardContainer) return;

    if (this.keyboardHandler?.handlePointerDown(e)) return;

    // Check if select tool is active and has a handle at this position
    if (e.button === 0 && this.self.tool === 'select' && !this.self.panning) {
      const selectToolLoader = this.toolManager.tools.select;
      const selectTool = selectToolLoader?.realTool;
      if (selectTool && selectTool.selection) {
        const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
        const handle = selectTool.getHandleAtPoint(pos);
        if (handle) {
          // Forward to handlePointerDown - treat it as if clicked on the canvas
          this.handlePointerDown(e);
          return;
        }
        // Clicking on the background (not a handle) with an active selection: commit and deselect
        selectTool.deselect();
        return;
      }
    }

    // Middle-click: enable panning
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(true));

      const isTextWithContent = this.self.tool === 'text' && this.self.text;
      if (!isTextWithContent) {
        this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastHideCursor());
        this.ui.showPanCursor();
      }

      this._containerPanActive = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (this.self.tool === 'zoom' && e.button === 0) {
      const containerRect = this.ui.elements.boardContainer.getBoundingClientRect();
      const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
      this._rightDragZoomActive = true;
      this._rightDragZoomPointerId = e.pointerId;
      this._rightDragZoomStartClientY = e.clientY;
      this._rightDragZoomStartZoom = this.board.zoom;
      this._rightDragZoomPivotX = e.clientX - containerRect.left;
      this._rightDragZoomPivotY = e.clientY - containerRect.top;
      this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
      this.ui.showZoomCursor();
      this.self.mousedown = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    // Left-click on background: pan if space is held
    if (this.self.panning) {
      this._containerPanActive = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  handleBoardContainerPointerMove(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    // Update select tool cursor when hovering over handles in the gray area
    if (this.self.tool === 'select' && !this._containerPanActive) {
      const selectToolLoader = this.toolManager.tools.select;
      const selectTool = selectToolLoader?.realTool;
      if (selectTool && selectTool.selection) {
        const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
        selectTool.updateCursor(pos);
      }
    }

    if (!this._containerPanActive) return;
    const dx = e.clientX - this._lastPanPointerX;
    const dy = e.clientY - this._lastPanPointerY;
    this.board.pan(dx, dy);
    this._lastPanPointerX = e.clientX;
    this._lastPanPointerY = e.clientY;
  }

  handleBoardContainerPointerUp(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    if (this.keyboardHandler?.handlePointerUp(e)) return;
    if (!this._containerPanActive) return;
    this._containerPanActive = false;

    if (e.button === 1) {
      this.self.panning = false;
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastPan(false));
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastShowCursor());
      this.ui.hidePanCursor(this.self.tool, this.self);
    }
  }

  // Wheel/zoom handlers

  handleWheel(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    e.preventDefault();

    if (this.self.panning || this.self.tool === 'pan' || this.self.tool === 'zoom' || this.self.tool === 'rotate') {
      const cursorPos = { x: this.self.x, y: this.self.y };
      if (e.deltaY > 0) {
        this.board.zoomOut(0.1, cursorPos);
      } else {
        this.board.zoomIn(0.1, cursorPos);
      }
      this.ui.updateZoomDisplay(this.board.getZoomPercent());
      this.ui.updateCursorStrokeWidthsForZoom(this.board.zoom);
      this.boardViewer?.setMainZoom(this.board.zoom);
    } else if (!(this.self.tool === 'ink' && this.self.mousedown)) {
      this.handleSizeScroll(e.deltaY);
    }
  }

  handleSizeScroll(deltaY) {
    let size = this.self.size;
    let step = 1;

    // Variable size changing
    if (size < 2) step = 0.25;
    else if (size < 4) step = 0.5;
    else if (size <= 30) step = 1;
    else step = 2;

    if (deltaY > 0 && size - step > 0) {
      size -= step;
    } else if (deltaY < 0 && size + step < 100) {
      size += step;
    } else {
      return;
    }

    size = Math.round(size * 100) / 100;

    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastSizeChange(size));
    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine(this.self.pressure, size);
    }
    this.self.setSize(size);
    this.ui.elements.sizeSlider.value = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSquarePositions(size);
    this.ui.updateSizeValue(size);
    this.ui.updateSelfTextStyle(size, this.self.color, this.self.font);
    this.board.mainCtx.lineWidth = size * 2;
  }

  adjustToolSize(direction) {
    if (direction === 0) return;
    this.handleSizeScroll(direction > 0 ? -1 : 1);
  }

  /**
   * Updates the text preview, using canvas rendering when a blend mode is active
   * so that the preview correctly shows the blend effect against the canvas below.
   */
  _updateTextPreview() {
    if (this.self.tool !== 'text') return;
    const useCanvas = this.self.blendMode && this.self.blendMode !== 'source-over';
    if (useCanvas) {
      // Hide DOM element, draw to topCanvas (which already has mixBlendMode CSS applied)
      this.ui.elements.selfTextInput.style.visibility = 'hidden';
      this.board.clearTop();
      const textTool = this.toolManager.getTool('text');
      if (textTool) textTool.renderPreview(this.self);
    } else if (this.ui.elements.selfTextInput.style.visibility === 'hidden') {
      // Restore DOM element when switching back to normal blend mode
      this.ui.elements.selfTextInput.style.visibility = '';
      this.board.clearTop();
    }
  }

  _refreshTextRenderingAfterFontLoad(font) {
    const targetFont = normalizeTextFont(font);
    loadTextFont(targetFont).then(() => {
      if (this.self?.font === targetFont) {
        this.ui.updateSelfTextStyle(this.self.size, this.self.color, this.self.font);
        this._updateTextPreview();
      }

      for (const [userId, user] of this.users.entries()) {
        if (!user || userId === this.sessionIndex || user.font !== targetFont) continue;

        this.ui.updateRemoteFont(userId, user.font);
        this.ui.updateRemoteTextLayout(userId, user);

        if (user.tool === 'text' && user.text) {
          if (user.blendMode && user.blendMode !== 'source-over') {
            this.remoteUserHandler?._renderRemoteTextToCanvas?.(user);
          } else {
            this.ui.updateRemoteText(userId, user.text);
          }
        }
      }
    });
  }

  // Line utilities

  commitSelfLine(newPressure, newSize) {
    const brushTool = this.toolManager.getTool('brush');
    brushTool.commitCurrentLine(this.self, newPressure, newSize);
  }

  commitSelfEraserSegment(newPressure = this.self.pressure, newSize = this.self.size, newOpacity = this.self.opacity) {
    if (!this.self?.mousedown || this.self.tool !== 'erase') return;
    const eraserTool = this.toolManager.getTool('erase');
    eraserTool?.commitCurrentLine(this.self, newPressure, newSize, newOpacity);
  }

  cancelCurrentStroke() {
    this.inputBufferManager.discardPendingStrokeInput();

    // Clear brush stroke data
    this.self.clearLine();

    // Clear pen stroke data
    this.self.penPoints = [];
    const penTool = this.toolManager.getTool('flowPen');
    if (penTool && penTool.clearStroke) {
      penTool.clearStroke();
    }

    // Clear ink stroke data
    const inkTool = this.toolManager.getTool('ink');
    if (inkTool && inkTool.clearStroke) {
      inkTool.clearStroke();
    }

    // Clear pixel brush stroke data
    const pixelTool = this.toolManager.getTool('pixel');
    if (pixelTool && pixelTool.clearStroke) {
      pixelTool.clearStroke(this.self);
    }

    // Clear shape tool data
    const lineTool = this.toolManager.getTool('line');
    if (lineTool) lineTool.startPos = null;
    const rectangleTool = this.toolManager.getTool('rectangle');
    if (rectangleTool) rectangleTool.startPos = null;
    const circleTool = this.toolManager.getTool('circle');
    if (circleTool) circleTool.startPos = null;

    // Clear select tool state
    const selectTool = this.toolManager.getTool('select');
    if (selectTool) {
      selectTool.isSelecting = false;
      selectTool.isDragging = false;
      selectTool.startPos = null;
    }

    this.self.mousedown = false;

    // Cancel active stroke in LayerManager (prevent zombie strokes)
    this.board.cancelStroke(this.self);

    // Clear the top canvas AFTER all tool state is reset
    // This ensures no residual preview remains
    this.board.clearTop();

    // Cancel debug overlay tracking
    this.debugOverlay.cancelDrawing(this.self.id);

    this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastCancel(), { snapshot: false });
  }

  hasCurrentStrokeInProgress() {
    if (this.self?.mousedown) return true;

    const userId = this.self?.id;
    if (userId === undefined || !this.board?.layerManager?.layerGroups) return false;

    return this.board.layerManager.layerGroups.some(group => group?.activeStrokeByUser?.has(userId));
  }

  handleUndo() {
    if (this.hasCurrentStrokeInProgress()) {
      this.cancelCurrentStroke();
      return;
    }

    this.board.undo(this.self.activeLayer, this.self.id);
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastUndo());
    }
  }

  handleRedo() {
    this.board.redo(this.self.id);
    if (this.connected) {
      this.inputBufferManager.queueBroadcast(() => this.wsClient.broadcastRedo());
    }
  }

  updateUndoRedoHud() {
    const lm = this.board.layerManager;
    const { hudUndoBtn, hudRedoBtn } = this.ui.elements;
    if (!lm || !hudUndoBtn || !hudRedoBtn) return;

    const userId = this.self?.id;
    const canUndo = lm.layerGroups.some(g => g.strokeStack.some(r => r.userId === userId));
    const canRedo = (lm.redoStackByUser.get(userId) ?? []).length > 0;

    hudUndoBtn.style.display = canUndo ? '' : 'none';
    hudRedoBtn.style.display = canRedo ? '' : 'none';
  }

  // Keyboard handlers

  handleResize() {
    this.board.calculateDefaultView();
    this.scheduleTopbarCollapseUpdate();

    // Auto-collapse sidebar on narrow screens
    const width = window.innerWidth;
    const isNarrow = width < 768;
    
    if (this._wasNarrow !== isNarrow) {
      this.ui.setSidebarCollapsed(isNarrow);
      this._wasNarrow = isNarrow;
    }
  }

  // Image Upload/Drop handlers

  async saveCanvasLocally(canvas, suggestedName, successMessage = 'Image saved!') {
    if (isTauriDesktop()) {
      try {
        const result = await saveCanvasViaNativeDialog(canvas, suggestedName);
        if (result?.saved) {
          this.ui.showToast(successMessage);
          return true;
        }
        return false;
      } catch (error) {
        console.error('[Desktop] Native save failed:', error);
        this.ui.showToast('Native save failed, using browser download instead', 3000, 'error');
      }
    }

    const link = document.createElement('a');
    link.download = suggestedName;
    link.href = canvas.toDataURL('image/png');
    link.click();
    this.ui.showToast(successMessage);
    return true;
  }

  async copyCanvasToClipboard(canvas, options = {}) {
    const copied = await copyCanvasToSystemClipboard(canvas);
    if (copied) {
      if (!options.silent) this.ui.showToast('Copied to clipboard!');
      return true;
    }

    if (!options.silent) {
      this.ui.showToast('Clipboard copy is not available here', 3000, 'error');
    }
    return false;
  }

  async copyImageDataToClipboard(clipboardData, options = {}) {
    if (!clipboardData?.imageData || !clipboardData?.width || !clipboardData?.height) {
      return false;
    }

    const copied = await copyImageDataToSystemClipboard(
      clipboardData.imageData,
      clipboardData.width,
      clipboardData.height
    );

    if (copied) {
      if (!options.silent) this.ui.showToast('Copied to clipboard!');
      return true;
    }

    if (!options.silent) {
      this.ui.showToast('Clipboard copy is not available here', 3000, 'error');
    }
    return false;
  }

  handleImageDataUrl(dataUrl) {
    if (!dataUrl || !this.canUseImageFeatures(true)) return;

    const img = new Image();
    img.onload = () => {
      const selectTool = this.toolManager.getTool('select');
      if (selectTool) {
        selectTool.pasteImage(img);
      }
    };
    img.src = dataUrl;
  }

  isImageFilename(name = '') {
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i.test(name);
  }

  isImageFile(file) {
    if (!file) return false;
    if (file.type?.startsWith('image/')) return true;
    return this.isImageFilename(file.name || '');
  }

  isImageDropPayload(dataTransfer) {
    if (!dataTransfer) return false;

    const items = [...(dataTransfer.items || [])];
    if (items.some((item) => item.type?.startsWith('image/'))) return true;

    const files = [...(dataTransfer.files || [])];
    if (files.some((file) => this.isImageFile(file))) return true;

    // Some desktop drags expose file items with empty MIME/type until drop.
    return items.some((item) => item.kind === 'file');
  }

  handleImageFile(file) {
    if (!this.isImageFile(file)) return;
    if (!this.canUseImageFeatures(true)) return;

    const reader = new FileReader();
    reader.onload = (e) => this.handleImageDataUrl(e.target.result);
    reader.readAsDataURL(file);
  }

  handleImageDrop(e) {
    if (this.syncClient?.isCanvasInputBlocked()) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this.clearBoardImageDragState();
    if (!this.canUseImageFeatures(true)) return;
    const files = [...(e.dataTransfer?.files || [])];
    const imageFile = files.find((file) => this.isImageFile(file));
    if (imageFile) {
      this.handleImageFile(imageFile);
    } else if (files.length > 0) {
      this.ui.showToast('Dropped file is not a supported image', 3000, 'error');
    } else {
      // Handle dropped image URLs if any
      const html = e.dataTransfer.getData('text/html');
      const match = html && html.match(/src="?([^"\s]+)"?/);
      if (match && match[1]) {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          const selectTool = this.toolManager.getTool('select');
          if (selectTool) {
            selectTool.pasteImage(img);
          }
        };
        img.src = match[1];
      }
    }
  }

  handleBoardImageDragEnter(e) {
    if (!this.isImageDropPayload(e.dataTransfer)) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this._boardDragDepth += 1;
    this.ui.elements.boardContainer?.classList.add('image-dragover');
  }

  handleBoardImageDragOver(e) {
    if (!this.isImageDropPayload(e.dataTransfer)) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this.ui.elements.boardContainer?.classList.add('image-dragover');
  }

  handleBoardImageDragLeave(e) {
    if (!this.isImageDropPayload(e.dataTransfer)) return;
    if (e.target?.closest?.('.chat-shell')) return;
    e.preventDefault();
    this._boardDragDepth = Math.max(0, this._boardDragDepth - 1);
    if (this._boardDragDepth === 0) {
      this.ui.elements.boardContainer?.classList.remove('image-dragover');
    }
  }

  clearBoardImageDragState() {
    this._boardDragDepth = 0;
    this.ui.elements.boardContainer?.classList.remove('image-dragover');
  }

  // Tool Locks Management

  // Room Preview

  /**
   * Starts the periodic room preview capture and broadcast.
   * Sends a 1/4 scale canvas preview to the server every 30 seconds.
   */
  startPreviewInterval() {
    this.stopPreviewInterval();

    // Send initial preview after a short delay to ensure canvas is rendered
    setTimeout(() => this.captureAndSendPreview(), 2000);

    this._previewInterval = setInterval(() => {
      this.captureAndSendPreview();
    }, this._previewIntervalMs);
  }

  /**
   * Stops the periodic room preview capture.
   */
  stopPreviewInterval() {
    if (this._previewInterval) {
      clearInterval(this._previewInterval);
      this._previewInterval = null;
    }
  }

  /**
   * Checks whether this client is the designated preview uploader and
   * starts/stops the preview and checkpoint intervals accordingly.
   */
  _updatePreviewUploadEligibility() {
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const myName = this.self?.registeredName || this.self?.username;
    // Manual pin takes priority over auto-elected user
    const activeUploader = this.currentRoomData?.dedicatedReplayUser
      || this.currentRoomData?.electedUploader
      || null;

    if (isHidden) {
      this.stopPreviewInterval();
      this.stopCheckpointInterval();
      return;
    }

    if (activeUploader) {
      if (myName && myName === activeUploader) {
        this.stopPreviewInterval();
        this.startCheckpointInterval();
      } else {
        this.stopPreviewInterval();
        this.stopCheckpointInterval();
      }
    } else {
      // No election result yet — fall back to legacy preview for everyone
      this.stopCheckpointInterval();
      if (!this._previewInterval) this.startPreviewInterval();
    }
  }

  startCheckpointInterval() {
    this.stopCheckpointInterval();
    setTimeout(() => this.captureAndSendCheckpoint(), 3000);
    this._checkpointInterval = setInterval(() => {
      this.captureAndSendCheckpoint();
    }, this._checkpointIntervalMs);
  }

  stopCheckpointInterval() {
    if (this._checkpointInterval) {
      clearInterval(this._checkpointInterval);
      this._checkpointInterval = null;
    }
  }

  /**
   * Captures the full board and sends it as a checkpoint for replay.
   * The server also uses this as the room preview.
   */
  captureAndSendCheckpoint() {
    if (!this.connected || !this.wsClient || this.isOfflineMode) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    try {
      const mainCanvas = this.board.mainCanvas;
      if (!mainCanvas) return;

      // Create a half-scale canvas to balance quality and bandwidth
      const scale = 0.5;
      const cpCanvas = document.createElement('canvas');
      cpCanvas.width = Math.floor(mainCanvas.width * scale);
      cpCanvas.height = Math.floor(mainCanvas.height * scale);

      const ctx = cpCanvas.getContext('2d');

      // Fill with background color
      const [r, g, b] = this.board.backgroundColor;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, cpCanvas.width, cpCanvas.height);

      // Draw scaled main canvas
      ctx.drawImage(mainCanvas, 0, 0, cpCanvas.width, cpCanvas.height);

      // Convert to PNG and send (allow up to 4MB for checkpoint)
      cpCanvas.toBlob((blob) => {
        if (blob && blob.size <= 4 * 1024 * 1024) {
          blob.arrayBuffer().then((buffer) => {
            this.wsClient.broadcastCheckpoint(new Uint8Array(buffer));
          });
        }
      }, 'image/png');
    } catch (err) {
      console.error('[App] Checkpoint capture error:', err);
    }
  }

  /**
   * Captures the current board at 1/4 scale and sends it to the server.
   */
  captureAndSendPreview() {
    if (!this.connected || !this.wsClient || this.isOfflineMode) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    try {
      const mainCanvas = this.board.mainCanvas;
      if (!mainCanvas) return;

      // Create a 1/4 scale canvas
      const scale = 0.25;
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = Math.floor(mainCanvas.width * scale);
      previewCanvas.height = Math.floor(mainCanvas.height * scale);

      const ctx = previewCanvas.getContext('2d');

      // Fill with background color
      const [r, g, b] = this.board.backgroundColor;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);

      // Draw scaled main canvas
      ctx.drawImage(mainCanvas, 0, 0, previewCanvas.width, previewCanvas.height);

      // Convert to PNG blob and send
      previewCanvas.toBlob((blob) => {
        if (blob && blob.size <= 100 * 1024) { // Limit to 100KB
          blob.arrayBuffer().then((buffer) => {
            this.wsClient.broadcastRoomPreview(new Uint8Array(buffer));
          });
        }
      }, 'image/png', 0.7);
    } catch (err) {
      console.error('[App] Preview capture error:', err);
    }
  }

  get usersByName() {
    const m = new Map();
    this.users.forEach((user, id) => {
      m.set(user.username || `#${id}`, user);
    });
    return m;
  }
}
