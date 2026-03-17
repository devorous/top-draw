/** @fileoverview Main entry point for the drawing application, coordinating board, tools, UI, and networking. */

import { ToolToEnum } from '../shared/MessageTypes.js';
import { packColor } from '../shared/ColorUtils.js';
import { User } from './User.js';
import { Board } from './canvas/Board.js';
import { ToolManager, BrushTool } from './tools/Tools.js';
import { WebSocketClient } from './network/WebSocketClient.js';
import { Chat } from './ui/Chat.js';
import { UI, ColorPalette } from './ui/index.js';
import { BrushGalleryLoader } from './ui/BrushGalleryLoader.js';
import { RemoteUserHandler } from './remote/RemoteUserHandler.js';
import { TouchHandler } from './input/TouchHandler.js';
import { setupWebSocketHandlers } from './network/WebSocketHandlers.js';
import { DebugOverlay, SyncClient } from './sync/index.js';
import { douglasPeucker, distanceBasedCulling } from './utils/drawing.js';
import { Auth } from './auth/Auth.js';
import { Moderation } from './auth/Moderation.js';
import { ColorInputMenu } from './ui/ColorInputMenu.js';
import { LandingPage } from './ui/LandingPage.js';
import { RoomSettings } from './ui/RoomSettings.js';
import { ToolLockManager } from './tools/ToolLockManager.js';
import { InputBufferManager } from './input/InputBufferManager.js';
import { KeyboardHandler } from './input/KeyboardHandler.js';
import { BrushModeManager } from './tools/BrushModeManager.js';
import { BlendModeManager } from './canvas/BlendModeManager.js';
import { StrokeHistoryPanel } from './ui/StrokeHistoryPanel.js';
import { PerformanceDebugPanel } from './ui/PerformanceDebugPanel.js';
import { PerformanceSettings } from './ui/PerformanceSettings.js';
import { highlight } from './ui/Highlight.js';

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
    this.connected = false;
    this.previousTool = null;

    this.board = new Board({
      dimensions: options.dimensions || [1080, 1920]
    });

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();
    this.chat = new Chat({
      onSend: (message) => this.handleChatSend(message),
      onDM: (message, recipientId) => this.handleDMSend(message, recipientId),
      onSendImage: (imageData, recipientId) => this.handleChatImageSend(imageData, recipientId)
    });
    this.brushGallery = new BrushGalleryLoader({
      onSelect: (brush) => this.handleBrushSelect(brush)
    });
    this.colorPalette = new ColorPalette({
      onColorSelect: (colorOrCallback) => this.handlePaletteColorSelect(colorOrCallback)
    });
    this.colorInputMenu = new ColorInputMenu({
      onColorChange: (rgba) => this.handleColorInputChange(rgba)
    });

    this.colorPicker = null;

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
    this.auth = null;
    this.moderation = null;
    this.landingPage = null;
    this.roomSettings = null;
    this.currentRoomId = null;
    this.currentRoomData = null;
    this.selfRole = 0;
    this.moderation = new Moderation();

    this.inputBufferManager = new InputBufferManager(this);

    this.pressureEnabled = true;
    this.tabletDetected = false;

    this.eraseAllLayers = false;

    this.brushModeManager = new BrushModeManager(this);

    this.blendModeManager = new BlendModeManager(this);

    this.toolLockManager = new ToolLockManager(this);

    // Keyboard handler
    this.keyboardHandler = new KeyboardHandler(this);

    // boardContainer background pan tracking
    this._containerPanActive = false;
    this._lastPanPointerX = 0;
    this._lastPanPointerY = 0;

    // Rotate tool state
    this._rotateToolActive = false;  // true while rotate-tool drag is in progress
    this._rotatePivotX = 0;          // boardContainer-relative pivot
    this._rotatePivotY = 0;
    this._rotatePivotClientX = 0;    // page-relative pivot (for angle calculation)
    this._rotatePivotClientY = 0;
    this._rotatePrevAngle = null;    // previous angle from pivot to pointer

    // Stroke history panel (dev mode)
    this.strokeHistoryPanel = new StrokeHistoryPanel();

    // Performance debug panel
    this.performanceDebugPanel = new PerformanceDebugPanel(this.inputBufferManager, this);

    // Performance settings modal
    this.performanceSettings = new PerformanceSettings();
  }

  /**
   * Initializes the application, components, and event listeners.
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    this.ui.init();
    this.board.init('#boardContainer');
    this.board.setApp(this);
    this.chat.init();
    this.brushGallery.init();
    this.colorPalette.init();
    this.colorInputMenu.init();

    this.createSelf();
    this.initSelfFromUI();
    this.setupColorPicker();

    this.remoteUserHandler = new RemoteUserHandler(this);
    this.touchHandler = new TouchHandler(this);
    this.touchHandler.init(this.ui.elements.boards);

    this.debugOverlay = new DebugOverlay();
    const debugCanvas = document.getElementById('debugOverlay');
    this.debugOverlay.init(debugCanvas, this.board.getWidth(), this.board.getHeight());
    this.debugOverlay.setBoard(this.board);

    this.strokeHistoryPanel.init();
    this.strokeHistoryPanel.setLayerManager(this.board.layerManager);
    this.strokeHistoryPanel.setActiveLayer(this.self?.activeLayer ?? 0);
    this.board.layerManager.strokeHistoryPanel = this.strokeHistoryPanel;
    this.board.layerManager.onHistoryChange = () => this.updateUndoRedoHud();

    this.performanceDebugPanel.init();
    this.performanceSettings.init(this.board);

    this.ui.setupLayerPreviewListeners(this.board.layerManager);

    this.syncClient = new SyncClient();
    this.syncClient.init({
      wsClient: this.wsClient,
      board: this.board
    });

    this.auth = new Auth({
      wsClient: this.wsClient,
      onSuccess: (token, role, username) => this.handleAuthSuccess(token, role, username),
      onError: (error) => this.handleAuthError(error)
    });
    this.auth.init();

    this.landingPage = new LandingPage({
      wsClient: this.wsClient,
      auth: this.auth,
      onRoomSelected: (roomId, password) => this.handleRoomSelected(roomId, password),
      onOffline: () => this.handleOffline()
    });
    this.landingPage.init();

    this.roomSettings = new RoomSettings({
      wsClient: this.wsClient,
      onUpdate: (roomData) => {
        this.currentRoomData = roomData;
      }
    });
    this.roomSettings.init();

    this.moderation.onSync = (sessionIndex) => {
      this.syncClient.requestSync();
      this.ui.showToast('Sync requested');
    };
    this.moderation.onPM = (sessionIndex, user) => {
      if (user) {
        this.chat.selectDMRecipient({
          id: sessionIndex,
          username: user.username,
          color: `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3]})`,
          isSelf: sessionIndex === this.sessionIndex
        });
        this.chat.show();
      }
    };
    this.moderation.onModAction = (actionType, sessionIndex, reason, duration) => {
      this.wsClient.sendModAction(actionType, sessionIndex, reason, duration);
    };
    this.moderation.onRequestModList = ({ showHistory, search } = {}) => {
      this.wsClient.requestModList({ showHistory, search });
    };
    this.moderation.onRevokeEntry = (entryId, entryType, username) => {
      const revokeType = entryType === 'mutes' ? 3 : 4;
      this.wsClient.sendModRevoke(revokeType, username);
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

    window.app = this;

    this.setupEventListeners();
    setupWebSocketHandlers(this);

    const initialTool = this.brushModeManager.getCurrentToolName();
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
  }

  /**
   * Creates the local user instance.
   */
  createSelf() {
    this.self = new User(0, {
      context: this.board.topCtx,
      board: this.board.mainCanvas
    });
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
      this.self.setBlurRadius(Number(elements.blurRadiusSlider.value));
    }

    if (elements.hardnessSlider) {
      this.self.setHardness(Number(elements.hardnessSlider.value));
    }
  }

  /**
   * Sets up the color picker component.
   */
  setupColorPicker() {
    if (typeof Picker !== 'undefined') {
      this.colorPicker = new Picker({
        parent: this.ui.elements.colorPicker,
        popup: false,
        alpha: true,
        editor: true,
        color: '#000',
        onChange: (color) => {
          const rgba = color.rgba;
          this.self.setColor(rgba);
          this.self.setOpacity(rgba[3]);
          this.ui.updateSelfColor(rgba);
          this.ui.updateSelfTextStyle(this.self.size, rgba);
          this.ui.updateopacityValue(rgba[3]);

          const { elements } = this.ui;
          if (elements.opacitySlider) {
            elements.opacitySlider.value = rgba[3] * 100;
          }

          if (this.colorInputMenu) {
            this.colorInputMenu.updateColor(rgba);
          }

          if (this.connected) {
            this.wsClient.broadcastColorChange(rgba);
          }
        }
      });
    }
  }

  /**
   * Sets up global event listeners for UI and board interactions.
   */
  setupEventListeners() {
    const { elements } = this.ui;

    // Form submit triggers join (both logged-in and not-logged-in join buttons are type="submit")
    elements.loginForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleJoin();
    });

    elements.disconnectBtn.addEventListener('click', () => this.disconnect());

    if (elements.menuBtn) {
      elements.menuBtn.addEventListener('click', (e) => {
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

    elements.panBtn.addEventListener('click', () => this.selectTool('pan'));
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
    elements.circleBlurBtn.addEventListener('click', () => {
      // Select whichever circle blur mode is currently active
      const checked = document.querySelector('input[name="circleBlurMode"]:checked');
      const tool = checked && checked.value === 'hard' ? 'circleBlurHard' : 'circleBlur';
      this.selectTool(tool);
    });
    elements.imageBrushBtn.addEventListener('click', () => this.selectTool('imageBrush'));
    elements.uploadBtn.addEventListener('click', () => elements.imageUploadInput.click());
    elements.imageUploadInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.handleImageFile(e.target.files[0]);
      }
    });
    elements.inkdropperBtn.addEventListener('click', () => this.selectTool('inkdropper'));

    elements.clearBtn.addEventListener('click', () => this.handleClear());
    elements.resetBtn.addEventListener('click', () => this.handleResetBoard());
    elements.mirrorBtn.addEventListener('click', () => this.handleToggleMirror());
    elements.devBtn.addEventListener('click', () => this.handleToggleDevMode());
    elements.perfSettingsBtn.addEventListener('click', () => this.performanceSettings.show());
    if (elements.undoBtn) elements.undoBtn.addEventListener('click', () => this.handleUndo());
    elements.plusBtn.addEventListener('click', () => this.handleZoomIn());
    elements.minusBtn.addEventListener('click', () => this.handleZoomOut());
    elements.rotationResetBtn.addEventListener('click', () => this.handleResetBoard());
    elements.saveBtn.addEventListener('click', () => this.board.saveAsImage());

    // Undo/Redo HUD buttons
    if (elements.hudUndoBtn) elements.hudUndoBtn.addEventListener('click', () => this.handleUndo());
    if (elements.hudRedoBtn) elements.hudRedoBtn.addEventListener('click', () => this.handleRedo());

    elements.chatBtn.addEventListener('click', () => this.chat.toggle());
    elements.selfListUser.addEventListener('click', () => this.handleRenameself());

    // Room settings button
    const roomSettingsBtn = document.getElementById('roomSettingsBtn');
    if (roomSettingsBtn) {
      roomSettingsBtn.addEventListener('click', () => this.handleRoomSettings());
    }

    // Mod panel toggle
    if (elements.modBtn) {
      elements.modBtn.addEventListener('click', () => this.moderation.togglePanel());
    }

    // Mod panel close button
    const modPanelCloseBtn = document.getElementById('modPanelCloseBtn');
    if (modPanelCloseBtn) {
      modPanelCloseBtn.addEventListener('click', () => this.moderation.hidePanel());
    }

    // Mod panel tab clicks
    document.querySelectorAll('.modTab').forEach(tab => {
      tab.addEventListener('click', () => this.moderation.setActiveTab(tab.dataset.tab));
    });

    // Mod panel search
    const modSearchInput = document.getElementById('modSearchInput');
    if (modSearchInput) {
      let searchDebounce = null;
      modSearchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => this.moderation.setSearch(modSearchInput.value.trim()), 300);
      });
      modSearchInput.addEventListener('keydown', (e) => e.stopPropagation());
    }

    // Mod panel history toggle
    const modHistoryToggle = document.getElementById('modHistoryToggle');
    if (modHistoryToggle) {
      modHistoryToggle.addEventListener('click', () => {
        this.moderation.setShowHistory(!this.moderation.showHistory);
      });
    }

    // Context menu button clicks
    if (elements.userContextMenu) {
      elements.userContextMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('.menuItem');
        if (btn) {
          this.moderation.handleMenuAction(btn.dataset.action);
        }
      });
    }

    // Right-click on user list entries for context menu
    elements.userList.addEventListener('contextmenu', (e) => {
      const entry = e.target.closest('.userEntry');
      if (entry && entry.dataset.sessionIndex) {
        const sessionIndex = Number(entry.dataset.sessionIndex);
        const user = this.users.get(sessionIndex);
        this.moderation.showContextMenu(e, sessionIndex, user);
      }
    });

    // Click-outside to close context menu and mobile menu
    document.addEventListener('click', (e) => {
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
    };
    elements.pressureMinSlider.addEventListener('input', clampPressureSliders);
    elements.pressureMaxSlider.addEventListener('input', clampPressureSliders);

    // Pressure enable/disable checkbox
    elements.pressureEnabled.addEventListener('change', () => {
      this.pressureEnabled = elements.pressureEnabled.checked;
      elements.pressureDualSlider.style.display = this.pressureEnabled ? '' : 'none';
      elements.pressureValue.style.display = this.pressureEnabled ? '' : 'none';
    });

    // Eraser mode radio buttons
    const eraserModeRadios = document.querySelectorAll('input[name="eraserMode"]');
    eraserModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.eraseAllLayers = (e.target.value === 'all');
        this.wsClient.broadcastEraserModeChange(this.eraseAllLayers);
      });
    });

    // Brush mode radio buttons
    const brushModeRadios = document.querySelectorAll('input[name="brushMode"]');
    brushModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.brushModeManager.setMode(e.target.value);
      });
    });

    // Circle blur mode radio buttons
    const circleBlurModeRadios = document.querySelectorAll('input[name="circleBlurMode"]');
    circleBlurModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const tool = e.target.value === 'hard' ? 'circleBlurHard' : 'circleBlur';
        this.selectTool(tool);
      });
    });

    // Fill advanced mode checkbox
    const fillAdvancedCheck = document.getElementById('fillAdvancedCheck');
    const fillAdvancedHint = document.getElementById('fillAdvancedHint');
    if (fillAdvancedCheck) {
      fillAdvancedCheck.addEventListener('change', (e) => {
        const fillTool = this.toolManager.getTool('fill');
        if (fillTool) fillTool.advancedMode = e.target.checked;
        if (fillAdvancedHint) fillAdvancedHint.style.display = e.target.checked ? 'block' : 'none';
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
        const visible = this.board.layerManager.toggleLayerVisibility(layerIndex);
        btn.classList.toggle('is-hidden', !visible);
        this.board.compositeAllLayers();
      });
    });

    // Editable slider values
    this.ui.makeValueEditable(elements.sizeValue, {
      min: 0.25, max: 100, step: 0.25, suffix: '',
      dragStep: (val) => val >= 5 ? 1 : 0.5,
      onCommit: (val) => {
        this.self.setSize(val);
        elements.sizeSlider.value = val;
        this.ui.updateCursorSize(val);
        this.ui.updateSelfTextStyle(val, this.self.color);
        this.board.mainCtx.lineWidth = val * 2;
        this.wsClient.broadcastSizeChange(val);
      }
    });

    this.ui.makeValueEditable(elements.smoothingValue, {
      min: 0, max: 50, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setSmoothing(val);
        elements.smoothingSlider.value = val;
        this.wsClient.broadcastSmoothingChange(val);
      }
    });

    this.ui.makeValueEditable(elements.spacingValue, {
      min: 0, max: 20, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setSpacing(val);
        elements.spacingSlider.value = val;
        this.wsClient.broadcastSpacingChange(val);
      }
    });

    this.ui.makeValueEditable(elements.hardnessValue, {
      min: 0, max: 100, step: 1, suffix: '',
      onCommit: (val) => {
        this.self.setHardness(val);
        elements.hardnessSlider.value = val;
        this.wsClient.broadcastHardnessChange(val);
      }
    });

    this.ui.makeValueEditable(elements.opacityValue, {
      min: 0, max: 100, step: 1, suffix: '%',
      onCommit: (val) => {
        const opacity = val / 100;
        this.self.setOpacity(opacity);
        elements.opacitySlider.value = val;
        const currentColor = [...this.self.color];
        currentColor[3] = opacity;
        this.self.setColor(currentColor);
        this.colorPicker.setColor(`rgba(${currentColor.join(',')})`);
        if (this.connected) {
          this.wsClient.broadcastColorChange(currentColor);
        }
      }
    });

    if (elements.blurRadiusValue) {
      this.ui.makeValueEditable(elements.blurRadiusValue, {
        min: 1, max: 10, step: 1, suffix: '',
        onCommit: (val) => {
          this.self.setBlurRadius(val);
          elements.blurRadiusSlider.value = val;
          if (this.connected) {
            this.wsClient.broadcastBlurRadiusChange(val);
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

    // All layers toggle for select tool
    const selAllLayersCheck = document.getElementById('selAllLayersCheck');
    if (selAllLayersCheck) {
      selAllLayersCheck.addEventListener('change', (e) => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.toggleCopyAllLayers(e.target.checked);
        }
      });
    }

    // Lock button event listeners
    if (elements.sizeLock) elements.sizeLock.addEventListener('click', () => this.toolLockManager.toggleLock('size'));
    if (elements.pressureLock) elements.pressureLock.addEventListener('click', () => this.toolLockManager.toggleLock('pressure'));
    if (elements.smoothingLock) elements.smoothingLock.addEventListener('click', () => this.toolLockManager.toggleLock('smoothing'));
    if (elements.spacingLock) elements.spacingLock.addEventListener('click', () => this.toolLockManager.toggleLock('spacing'));
    if (elements.hardnessLock) elements.hardnessLock.addEventListener('click', () => this.toolLockManager.toggleLock('hardness'));
    if (elements.opacityLock) elements.opacityLock.addEventListener('click', () => this.toolLockManager.toggleLock('opacity'));
    if (elements.blurRadiusLock) elements.blurRadiusLock.addEventListener('click', () => this.toolLockManager.toggleLock('blurRadius'));
    if (elements.thinningLock) elements.thinningLock.addEventListener('click', () => this.toolLockManager.toggleLock('thinning'));

    elements.board.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    window.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    window.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    window.addEventListener('pointercancel', (e) => this.handlePointerUp(e));

    elements.board.addEventListener('pointerenter', () => {
           this.isOnBoard = true;
    
           // Skip showing cursor during two-finger gestures (except for text tool)
           if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
             if (this.self.tool !== 'text') {
               return;
             }
           }
    
           this.ui.showCursor();      // Refresh tool display to show correct cursor shape
      this.ui.updateToolDisplay(this.self.tool, this.self);

      // Broadcast cursor show to other users
      if (this.connected) {
        this.wsClient.broadcastShowCursor();
      }
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
    elements.boardContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    elements.boardContainer.addEventListener('drop', (e) => this.handleImageDrop(e));

    window.addEventListener('resize', () => this.handleResize());
  }

  // Room selection

  /**
   * Handles room selection and initiates connection.
   * @async
   * @param {string} roomId - The ID of the room to join.
   * @param {string} [password=null] - The room password, if any.
   * @returns {Promise<void>}
   */
  async handleRoomSelected(roomId, password = null) {
    console.log(`[App] Room selected: ${roomId}`);
    this.isOfflineMode = false;
    this.currentRoomId = roomId;
    this.currentRoomPassword = password;

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
   * Starts the application in offline (local-only) mode.
   */
  handleOffline() {
    console.log('[App] Draw Alone mode - creating local room');
    this.isOfflineMode = true;
    this.connected = false;
    this.currentRoomId = 'offline-' + Date.now();

    if (this.wsClient) {
      this.wsClient.disconnect();
    }

    this.sessionIndex = 0;
    this.self.id = 0;
    this.self.setUsername('');
    this.users.set(0, this.self);

    if (this.landingPage) {
      this.landingPage.hide();
    }

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName('');
    this.ui.showConnectionStatus('offline');

    this.inputBufferManager.startTickLoop();

    const url = new URL(window.location);
    url.searchParams.set('room', this.currentRoomId);
    window.history.pushState({}, '', url);
  }

  /**
   * Connects to the discovery room to fetch the list of available rooms.
   * @async
   * @returns {Promise<void>}
   */
  async connectForRoomDiscovery() {
    this.currentRoomId = null;

    if (this.landingPage) {
      this.landingPage.updateConnectionStatus('connecting');
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

  /**
   * Handles successful WebSocket connection.
   * @param {number} sessionIndex - The session index assigned by the server.
   * @param {number} role - The user's role level.
   * @param {string} [assignedUsername] - Unique username assigned by server.
   * @param {string} [ipHash] - IP hash for grouping.
   */
  handleWSConnect(sessionIndex, role, assignedUsername, ipHash) {
    if (this.isOfflineMode) return;

    this.sessionIndex = sessionIndex;
    this.self.id = sessionIndex;
    this.users.set(sessionIndex, this.self);

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
      if (this.moderation) {
        this.moderation.setRole(role);
      }
    }

    if (this.landingPage) {
      this.landingPage.updateConnectionStatus('connected');
    }

    const isDiscoveryConnection = !this.currentRoomId || this.currentRoomId === '_discovery';
    if (isDiscoveryConnection) return;

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
      this.handleJoinAfterConnect();
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

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastToolChange(this.self.tool);
    this.wsClient.broadcastLayerBlendModeChange(this.self.activeLayer, this.self.blendMode);
    this.wsClient.broadcastLayerChange(this.self.activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);

    this.moderation.setRole(this.selfRole);
    this.inputBufferManager.startTickLoop();
  }

  /**
   * Handles WebSocket disconnection.
   * @param {number} code - Disconnection code.
   * @param {string} reason - Disconnection reason.
   */
  handleWSDisconnect(code, reason) {
    this.connected = false;

    if (this.landingPage && this.landingPage.els.landingPage.style.display !== 'none') {
      this.landingPage.updateConnectionStatus('disconnected');
    }

    if (this.inputBufferManager.tickTimer) {
      this.ui.showConnectionStatus('disconnected');
    }

    if (code === 4001 || code === 4002) {
      const label = code === 4001 ? 'Banned' : 'Kicked';
      if (this.auth) {
        this.auth.clearToken();
        this.auth.setRememberMe(false);
      }
      this.showModOverlay(label, reason || '');
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
    this.self.setUsername(username);

    if (this.ui.elements.loginPassword) this.ui.elements.loginPassword.value = '';

    if (this.moderation) {
      this.moderation.setRole(role);
    }

    this.updateRoomSettingsButtonVisibility();

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

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastToolChange(this.self.tool);
    const activeLayer = this.self.activeLayer;
    this.wsClient.broadcastLayerBlendModeChange(activeLayer, this.self.blendMode);
    this.wsClient.broadcastLayerChange(activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);

    this.moderation.setRole(role);
    this.inputBufferManager.startTickLoop();
    this.syncClient.requestSync();

    const roleNames = ['Guest', 'User', 'Moderator', 'Admin'];
    this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
  }

  /**
   * Handles authentication errors.
   * @param {string} error - The error message.
   */
  handleAuthError(error) {
    this.ui.showToast(error, 4000, 'error');

    if (this.landingPage) {
      this.syncClient.hideOverlay();
      this.landingPage.show();
      this.ui.elements.overlay.style.display = 'flex';
    }
  }

  /**
   * Handles the join request from the login dialog.
   */
  handleJoin() {
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

    if (this.landingPage && this.landingPage.isVisible) {
      this.landingPage.joinAsGuest();
      return;
    }

    this.connected = true;
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(name);
    this.ui.showConnectionStatus('connected', this.currentRoomId);

    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastToolChange(this.self.tool);
    const activeLayer = this.self.activeLayer;
    this.wsClient.broadcastLayerBlendModeChange(activeLayer, this.self.blendMode);
    this.wsClient.broadcastLayerChange(activeLayer);
    this.wsClient.broadcastThinningChange(this.self.thinning);
    this.wsClient.broadcastSimulatePressureChange(this.self.simulatePressure);

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
      this.wsClient.broadcastNameChange(name.trim());
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
      await this.wsClient.connect(this.self.toJSON());
    } catch (err) {
      console.error('Reconnect failed:', err);
      this.ui.showConnectionStatus('disconnected');
    }
  }

  /**
   * Opens the room settings dialog.
   */
  handleRoomSettings() {
    if (!this.currentRoomData) {
      this.ui.showToast('Room data not loaded yet', 3000);
      return;
    }

    const canEdit = this.roomSettings.canEdit(
      this.currentRoomData,
      this.selfRole,
      this.auth?.userId
    );

    if (!canEdit) {
      this.ui.showToast('Only room owner or moderators can edit settings', 3000);
      return;
    }

    this.roomSettings.show(this.currentRoomData, this.selfRole, this.auth?.userId);
  }

  /**
   * Updates the visibility of the room settings button based on user permissions.
   */
  updateRoomSettingsButtonVisibility() {
    const btn = document.getElementById('roomSettingsBtn');
    if (!btn) return;

    if (!this.connected || !this.currentRoomData) {
      btn.style.display = 'none';
      return;
    }

    const canEdit = this.roomSettings?.canEdit(
      this.currentRoomData,
      this.selfRole,
      this.auth?.userId
    );

    btn.style.display = canEdit ? 'inline-block' : 'none';
  }

  /**
   * Disconnects from the current room and returns to the landing page.
   * @async
   * @returns {Promise<void>}
   */
  async disconnect() {
    console.log('[App] Exiting room, returning to lobby...');

    if (this.inputBufferManager) {
      this.inputBufferManager.stopTickLoop();
    }

    this.users.forEach((user, sessionIndex) => {
      if (sessionIndex !== this.sessionIndex) {
        this.remoteUserHandler.handleCancel(user);
        this.ui.removeRemoteUser(sessionIndex);
      }
    });
    this.users.clear();
    if (this.self) {
      this.users.set(this.sessionIndex, this.self);
    }

    this.connected = false;
    this.sessionIndex = null;
    if (this.self) this.self.id = null;
    this.currentRoomData = null;

    this.updateRoomSettingsButtonVisibility();

    this.ui.hideCursor();
    this.ui.hideConnectionStatus();

    if (this.wsClient && this.wsClient.connected) {
      this.wsClient.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const url = new URL(window.location);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url);

    if (this.landingPage) {
      this.landingPage.show();
      this.landingPage.selectRoom('lobby');
    }

    this.connectForRoomDiscovery();
  }

  /**
   * Selects a tool and updates application state and UI.
   * @param {string} tool - The name of the tool to select.
   */
  selectTool(tool) {
    if (this.self.tool === 'pan') {
      this.self.panning = false;
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
      this.wsClient.broadcastMouseUp();
    }

    const previousTool = this.self.tool;

    if (tool !== 'inkdropper' && previousTool === 'inkdropper' && tool !== this.previousTool) {
      this.previousTool = null;
    } else if (previousTool !== 'inkdropper' && tool !== 'inkdropper' && this.previousTool) {
      this.previousTool = null;
    }

    if (previousTool && this.toolLockManager.toolLocks[previousTool]) {
      this.toolLockManager.saveCurrentValues(previousTool);
    }

    this.brushModeManager.updateModeFromTool(tool);

    if (tool === 'circleBlur' || tool === 'circleBlurHard') {
      this.ui.updateCircleBlurModeDisplay(tool);
    }

    this.self.setTool(tool);
    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool, this.self);
    this._updateBlurCannotDraw();

    if (tool === 'text') {
      this.ui.updateSelfTextStyle(this.self.size, this.self.color);
      this._updateTextPreview();
    }

    if (tool === 'imageBrush' && this.self.imageBrush) {
      const brush = this.self.imageBrush;
      if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
        this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
      } else {
        this.ui.setBrushPreview(brush.gimpUrl);
      }
    }

    if (tool === 'line' || tool === 'rectangle' || tool === 'circle') {
      this.self.setSmoothing(50);
      this.ui.updateSmoothingValue(50);
    }

    this.ui.updateSelfToolIcon(tool);
    this.wsClient.broadcastToolChange(tool, tool === 'erase' ? this.eraseAllLayers : false);

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

    if (this.toolLockManager.toolLocks[tool]) {
      this.toolLockManager.restoreToolValues(tool);
    }

    this.toolLockManager.updateAllLockButtons(tool);

    // Suggest disabling thinning when tablet user selects ink tool
    if (tool === 'ink' && this.tabletDetected && this.self.thinning > 0) {
      this.ui.showToast('Tablet detected - consider disabling thinning', 4000);
      if (this.ui.elements.thinningSlider) highlight(this.ui.elements.thinningSlider, 4000);
      if (this.ui.elements.simulatePressureCheckbox) highlight(this.ui.elements.simulatePressureCheckbox, 4000);
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
    this.self.imageBrush = brush;

    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
    } else {
      this.ui.setBrushPreview(brush.gimpUrl);
    }

    this.wsClient.broadcastBrush(brush);
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
    if (wasReset) {
      this.self.setBlendMode('source-over');
      this.board.topCanvas.style.mixBlendMode = 'normal';
      this.ui.updateTextPreviewBlendMode('normal');
    }

    if (allowComplex) {
      this.ui.updateBlendModeDisplay(this.self.blendMode);
    }

    const cssMode = this.blendModeManager.toCSSBlendMode(this.self.blendMode);
    this.board.topCanvas.style.mixBlendMode = cssMode;
    this.ui.updateTextPreviewBlendMode(cssMode);

    this.board.compositeAllLayers();

    this.strokeHistoryPanel.setActiveLayer(layerIndex);

    if (this.connected) {
      this.wsClient.broadcastLayerChange(layerIndex);
    }
  }

  /**
   * Show/hide the muted-style cursor indicator when blur is active on a non-zero layer.
   * @private
   */
  _updateBlurCannotDraw() {
    const cannotDraw = this.self.tool === 'blur' && this.self.activeLayer !== 0;
    this._blurCannotDraw = cannotDraw;
    // Reuse the muted indicator visuals (only if not actually muted)
    if (!this.self.isMuted) {
      this.ui.setMutedState(cannotDraw);
    }
    // Hide the square cursor and show crosshair-style muted indicator instead
    if (this.self.tool === 'blur') {
      this.ui.elements.selfSquare.style.display = cannotDraw ? 'none' : 'block';
    }
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
      this.wsClient.broadcastLayerBlendModeChange(activeLayer, blendMode);
    }
  }

  /**
   * Clears the entire board.
   */
  handleClear() {
    this.board.clear();
    this.wsClient.broadcastClear();
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
  }

  /**
   * Toggles canvas mirroring.
   */
  handleToggleMirror() {
    const mirror = this.board.toggleMirror();
    this.ui.updateMirrorDisplay(mirror);
    this.wsClient.broadcastMirror();
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
  }

  /**
   * Zooms out on the canvas.
   */
  handleZoomOut() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomOut(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  /**
   * Resets the canvas rotation to zero.
   */
  handleResetRotation() {
    this.board.resetRotation();
  }

  // Brush/tool settings

  handleSizeChange(e) {
    const size = Number(e.target.value);
    this.self.setSize(size);
    this.ui.updateCursorSize(size);
    this.ui.updateSquarePositions(size);
    // Update pressure indicators only for tools that use pressure
    const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'circleBlurHard'];
    if (pressureTools.includes(this.self.tool)) {
      this.ui.updatePressureCursorRadius(this.self.pressure * size, size);
    }
    if (this.self.tool === 'imageBrush') {
      this.ui.updatePressureSquareSize(this.self.pressure * size, size);
    }
    this.ui.updateSelfTextStyle(size, this.self.color);
    this.ui.updateSizeValue(size);
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
  }

  handleSpacingChange(e) {
    const spacing = Number(e.target.value);
    this.self.setSpacing(spacing);
    this.ui.updateSpacingValue(spacing);
    this.wsClient.broadcastSpacingChange(spacing);
  }

  handleSmoothingChange(e) {
    const smoothing = Number(e.target.value);
    this.self.setSmoothing(smoothing);
    this.ui.updateSmoothingValue(smoothing);
    this.wsClient.broadcastSmoothingChange(smoothing);
  }

  handleHardnessChange(e) {
    const hardness = Number(e.target.value);
    this.self.setHardness(hardness);
    this.ui.updateHardnessValue(hardness);
    this.wsClient.broadcastHardnessChange(hardness);
  }

  handleopacityChange(e) {
    const opacity = Number(e.target.value) / 100; // Convert to 0-1 range

    // Update user opacity (same as color picker alpha)
    this.self.setOpacity(opacity);
    this.ui.updateopacityValue(opacity);

    // Update color picker to match
    const currentColor = [...this.self.color];
    currentColor[3] = opacity;
    this.self.setColor(currentColor);
    this.colorPicker.setColor(`rgba(${currentColor.join(',')})`);

    // Broadcast to other users
    if (this.connected) {
      this.wsClient.broadcastColorChange(currentColor);
    }
  }

  handleBlurRadiusChange(e) {
    const radius = Number(e.target.value);
    this.self.setBlurRadius(radius);
    this.ui.updateBlurRadiusValue(radius);
    if (this.connected) {
      this.wsClient.broadcastBlurRadiusChange(radius);
    }
  }

  handleThinningChange(e) {
    const thinning = Number(e.target.value) / 100; // Convert to 0-1 range
    this.self.setThinning(thinning);
    this.ui.updateThinningValue(Math.round(thinning * 100));
    if (this.connected) {
      this.wsClient.broadcastThinningChange(thinning);
    }
  }

  handleSimulatePressureChange(e) {
    const simulate = e.target.checked;
    this.self.setSimulatePressure(simulate);
    if (this.connected) {
      this.wsClient.broadcastSimulatePressureChange(simulate);
    }
  }

  async handleBrushFileLoad(e) {
    const file = e.target.files[0];
    if (!file) return;

    const brushTool = this.toolManager.getTool('imageBrush');
    const brushData = await brushTool.loadBrush(file, this.self);

    if (brushData) {
      this.ui.setBrushPreview(brushData.gimpUrl || brushData.gBrushes[0].gimpUrl);
      this.wsClient.broadcastBrush(brushData);
    }
  }

  handleChatSend(message) {
    this.chat.addMessage(message, this.self);
    this.wsClient.broadcastChat(message);
  }

  handleDMSend(message, recipientId) {
    if (this.connected) {
      this.wsClient.broadcastDM(message, recipientId);
    }
  }

  handleChatImageSend(imageData, recipientId = null) {
    if (this.connected) {
      if (recipientId) {
        // DM image
        this.chat.addDMImage(imageData, recipientId, true);
      } else {
        // Public chat image
        this.chat.addChatImage(imageData, this.self);
      }
      this.wsClient.broadcastChatImage(imageData, recipientId);
    }
  }

  updateChatUserList() {
    const userList = Array.from(this.users.values()).map(user => ({
      id: user.id,
      username: user.username,
      color: `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3]})`,
      isSelf: user.id === this.sessionIndex
    }));
    this.chat.updateUserList(userList);
  }

  handlePaletteColorSelect(colorOrCallback) {
    // If it's a callback (from the add button), pass the current color
    if (typeof colorOrCallback === 'function') {
      colorOrCallback(this.self.color);
      return;
    }

    // Otherwise, select the color and update picker
    const color = colorOrCallback;
    this.self.setColor(color);
    this.self.setOpacity(color[3]);
    this.ui.updateSelfColor(color);
    this.ui.updateSelfTextStyle(this.self.size, color);

    // Update the color picker to match
    if (this.colorPicker) {
      this.colorPicker.setColor(color);
    }

    if (this.connected) {
      this.wsClient.broadcastColorChange(color);
    }
  }

  handleColorInputChange(rgba) {
    // Update self's color
    this.self.setColor(rgba);
    this.self.setOpacity(rgba[3]);
    this.ui.updateSelfColor(rgba);
    this.ui.updateSelfTextStyle(this.self.size, rgba);
    this.ui.updateopacityValue(rgba[3]);

    // Update the color picker to match
    if (this.colorPicker) {
      this.colorPicker.setColor(rgba);
    }

    // Broadcast to other users if connected
    if (this.connected) {
      this.wsClient.broadcastColorChange(rgba);
    }

    // Add to recent colors
    if (this.colorPalette) {
      this.colorPalette.addRecentColor(rgba);
    }
  }

  // Pointer event handlers

  handlePointerMove(e) {
    // Block local input while syncing
    if (this.syncClient?.isSyncing()) return;

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

    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);
    const x = pos.x;
    const y = pos.y;

    // Text tool: update pending position for touch drag preview
    if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
      this.self._pendingTextPos = { x, y };
      this.self.setPosition(x, y);
      this.ui.updateSelfCursor(x, y, this.self.size);
      
      // Broadcast movement so remote users see the text cursor updating
      if (this.connected) {
        this.wsClient.broadcastMouseMove(x, y);
      }
      return;
    }

    // Update cursor immediately for visual responsiveness
    this.ui.updateSelfCursor(x, y, this.self.size);
    if (this.self.tool === 'text') this._updateTextPreview();

    // Handle pressure for pen input — default to current pressure so non-pen
    // events (e.g. palm touch) mid-stroke don't slam pressure to 1
    let pressure = this.self.pressure;
    if (!this.pressureEnabled) {
      pressure = 1;
    } else if (e.pointerType === 'pen' && !this.self.panning) {
      // On pen lift (e.pressure === 0), always use 0, bypass min/max slider scaling
      if (e.pressure === 0) {
        pressure = 0;
      } else {
        const minP = Number(this.ui.elements.pressureMinSlider.value) / 100;
        const maxP = Number(this.ui.elements.pressureMaxSlider.value) / 100;
        pressure = minP + (maxP - minP) * e.pressure;
        pressure = Math.round(pressure * 100) / 100;
      }

      // Update pressure indicators only for tools that use pressure
      const pressureTools = ['brush', 'flowPen', 'ink', 'erase', 'circleBlur', 'circleBlurHard'];
      if (pressureTools.includes(this.self.tool)) {
        this.ui.updatePressureCursorRadius(pressure * this.self.size, this.self.size);
      }
      if (this.self.tool === 'imageBrush') {
        this.ui.updatePressureSquareSize(pressure * this.self.size, this.self.size);
      }

      // If stroke start was deferred, now we have real pressure - start the stroke
      if (this._pendingPenDown) {
        const pending = this._pendingPenDown;
        this._pendingPenDown = null;
        this.self.setPressure(pressure);
        this.inputBufferManager.inputBuffer.pressure = pressure;
        this.wsClient.broadcastPressureChange(pressure);
        this.wsClient.broadcastMouseDown();

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
        // Commit BEFORE updating pressure so old segment draws at correct width
        if (pressure !== this.self.pressure && this.self.mousedown) {
          this.wsClient.broadcastPressureChange(pressure);
          if (this.self.tool === 'brush') {
            this.commitSelfLine(pressure, this.self.size);
          }
        }
        this.self.setPressure(pressure);
        this.inputBufferManager.inputBuffer.pressure = pressure;
      }
    }

    // Buffer the input for processing
    this.inputBufferManager.inputBuffer.points.push(x, y);
    this.inputBufferManager.inputBuffer.pointerType = e.pointerType;
    this.inputBufferManager.inputBuffer.dirty = true;
    this.board.performanceMonitor.recordInput();

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
      this.debugOverlay.addDrawingPoint(x, y, this.self.size, this.self.id);
    }
  }

  handlePointerDown(e) {
    // Reset smoothing buffer and state for new stroke immediately
    this.inputBufferManager.resetBroadcastSmoothing();
    this.self._mainCtxDrawCount = 0;
    this.self.mousedown = false;

    // Block local input while syncing
    if (this.syncClient?.isSyncing()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      if (this.self.tool !== 'text') {
        this.ui.hideCursor();
      }
      return;
    }

    // Middle-click enables panning mode
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this.self.mousedown = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      this.wsClient.broadcastPan(true);
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

    // Right-click cancels current stroke
    if (e.button === 2) {
      this.cancelCurrentStroke();
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
      this.ui.elements.simulatePressureCheckbox.checked = false;
      if (this.connected) {
        this.wsClient.broadcastSimulatePressureChange(false);
      }

      // Show toast - defer to not block stroke
      setTimeout(() => {
        this.ui.showToast('Tablet detected - disabling thinning', 3000);
      }, 100);
    }

    if (e.pointerType === 'mouse' || !this.pressureEnabled) {
      this.self.setPressure(1);
      this.inputBufferManager.inputBuffer.pressure = 1;
      this.wsClient.broadcastPressureChange(1);
    }

    const pos = this.board.getBoardRelativePos(e.clientX, e.clientY);

    // Initialize input buffer for this stroke
    this.inputBufferManager.inputBuffer.position = pos;
    this.inputBufferManager.inputBuffer.lastPosition = pos;
    this.inputBufferManager.inputBuffer.movement = { x: 0, y: 0 };
    this.inputBufferManager.inputBuffer.pointerType = e.pointerType;

    // Reset broadcast smooth buffer for new stroke
    this.inputBufferManager.broadcastSmoothBuffer.isFirst = true;

    // Fully reset self position state for new stroke to prevent jumping
    this.self.resetPosition(pos.x, pos.y);
    this.ui.updateSelfCursor(pos.x, pos.y, this.self.size);
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
        } else if (e.pointerType === 'pen' && this.pressureEnabled && this.self.tool !== 'text') {
          // Defer pen stroke start until first pointerMove provides real pressure
          this._pendingPenDown = { pos, event: e };
        } else {
          // Standard immediate placement/stroke start
          
          // For tools that use smoothing, send the smoothed initial point instead of raw click.
          // This ensures remote users see perfect parity with the sender.
          const smoothingTools = ['brush', 'flowPen', 'ink', 'imageBrush', 'erase'];
          let broadcastPos = [pos.x, pos.y];
          if (smoothingTools.includes(this.self.tool)) {
            const smoothed = this.inputBufferManager.applyBroadcastSmoothing([pos.x, pos.y]);
            broadcastPos = [smoothed[0], smoothed[1]];
            // Update local self position to match the smoothed broadcast position
            this.self.setPosition(smoothed[0], smoothed[1]);
          }
          this.wsClient.broadcastMouseDown(broadcastPos);

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
        this.colorPalette.addRecentColor(this.self.color);
      }

      // Start tracking for debug overlay (pass tool type, brush size, and user info)
      this.debugOverlay.startDrawing(pos.x, pos.y, this.self.tool, this.self.size, this.self.id, this.self.username);
    }
  }

  handlePointerUp(e) {
    // Pan tool: release clears panning
    if (this.self.tool === 'pan') {
      if (e.button === 0) {
        this.self.panning = false;
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

    // Middle-click release disables panning mode
    if (e.button === 1) {
      this.self.panning = false;
      this.self.mousedown = false;
      this.wsClient.broadcastPan(false);
      return;
    }

    // Only handle left-click release for drawing
    if (e.button !== 0) return;

    // If a two-finger gesture occurred, cancel any pending text placement
    if (this.touchHandler.state.gestureStartedWithTwoFingers) {
      this.self._pendingTextPos = null;
      this.self._pendingTextPointerType = null;
      this.self.mousedown = false;
      this.wsClient.broadcastMouseUp();
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
        // Use a small default pressure for taps (pen didn't move, so no pressure data)
        const tapPressure = 0.5;
        this.self.setPressure(tapPressure);
        this.inputBufferManager.inputBuffer.pressure = tapPressure;
        this.wsClient.broadcastPressureChange(tapPressure);
        this.wsClient.broadcastMouseDown();

        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          tool.onPointerDown(this.self, pending.pos, pending.event);
        }
      }
    }

    // Process any remaining buffered input before ending stroke
    if (this.inputBufferManager.inputBuffer.dirty) {
      this.inputBufferManager.tick();
    }

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();

      // Handle text tool touch placement on lift
      if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
        const textTool = this.toolManager.getTool('text');
        if (textTool) {
          // Broadcast final position before MU so remote users draw it in the right place
          if (this.connected) {
            // Send MD to trigger placement of any previous text and set remote mousedown=true
            this.wsClient.broadcastMouseDown([this.self._pendingTextPos.x, this.self._pendingTextPos.y]);
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
    this.wsClient.broadcastMouseUp();

    // Reset input buffer
    this.inputBufferManager.inputBuffer.dirty = false;
  }

  handlePointerLeave(e) {
    this.isOnBoard = false;

    // Keep cursor visible if drawing or if text tool is active
    if (this.self.mousedown || this.self.tool === 'text') {
      return;
    }

    this.ui.hideCursor();

    // Broadcast cursor hide to other users
    if (this.connected) {
      this.wsClient.broadcastHideCursor();
    }
  }

  // boardContainer pointer handlers: pan by dragging the background (Space held or middle-click)

  handleBoardContainerPointerDown(e) {
    // Only handle events on the boardContainer background itself (not bubbled from canvas/children)
    if (e.target !== this.ui.elements.boardContainer) return;

    // Middle-click: enable panning
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this._lastPanPointerX = e.clientX;
      this._lastPanPointerY = e.clientY;
      this.wsClient.broadcastPan(true);
      this._containerPanActive = true;
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
    if (!this._containerPanActive) return;
    const dx = e.clientX - this._lastPanPointerX;
    const dy = e.clientY - this._lastPanPointerY;
    this.board.pan(dx, dy);
    this._lastPanPointerX = e.clientX;
    this._lastPanPointerY = e.clientY;
  }

  handleBoardContainerPointerUp(e) {
    if (!this._containerPanActive) return;
    this._containerPanActive = false;

    if (e.button === 1) {
      this.self.panning = false;
      this.wsClient.broadcastPan(false);
    }
  }

  // Wheel/zoom handlers

  handleWheel(e) {
    e.preventDefault();

    if (this.self.panning || this.self.tool === 'pan' || this.self.tool === 'rotate') {
      const cursorPos = { x: this.self.x, y: this.self.y };
      if (e.deltaY > 0) {
        this.board.zoomOut(0.1, cursorPos);
      } else {
        this.board.zoomIn(0.1, cursorPos);
      }
      this.ui.updateZoomDisplay(this.board.getZoomPercent());
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

    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine(this.self.pressure, size);
    }

    this.self.setSize(size);
    this.ui.elements.sizeSlider.value = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSquarePositions(size);
    this.ui.updateSizeValue(size);
    this.ui.updateSelfTextStyle(size, this.self.color);
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
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

  // Line utilities

  commitSelfLine(newPressure, newSize) {
    const brushTool = this.toolManager.getTool('brush');
    brushTool.commitCurrentLine(this.self, newPressure, newSize);
  }

  cancelCurrentStroke() {
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

    this.wsClient.broadcastCancel();
  }

  handleUndo() {
    this.board.undo(this.self.activeLayer, this.self.id);
    if (this.connected) this.wsClient.broadcastUndo();
  }

  handleRedo() {
    this.board.redo(this.self.id);
    if (this.connected) this.wsClient.broadcastRedo();
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

    // Auto-collapse sidebar on narrow screens
    const width = window.innerWidth;
    const isNarrow = width < 768;
    
    if (this._wasNarrow !== isNarrow) {
      this.ui.setSidebarCollapsed(isNarrow);
      this._wasNarrow = isNarrow;
    }
  }

  // Image Upload/Drop handlers

  handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const selectTool = this.toolManager.getTool('select');
        if (selectTool) {
          selectTool.pasteImage(img);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  handleImageDrop(e) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      this.handleImageFile(e.dataTransfer.files[0]);
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

  // Tool Locks Management

}
