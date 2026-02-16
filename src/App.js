import { User } from './User.js';
import { Board } from './Board.js';
import { ToolManager, BrushTool } from './Tools.js';
import { WebSocketClient } from './WebSocketClient.js';
import { Chat } from './Chat.js';
import { UI, ColorPalette } from './ui/index.js';
import { BrushGallery } from './BrushGallery.js';
import { RemoteUserHandler } from './RemoteUserHandler.js';
import { TouchHandler } from './TouchHandler.js';
import { setupWebSocketHandlers } from './WebSocketHandlers.js';
import { DebugOverlay, RegionTracker, SyncClient } from './sync/index.js';
import { douglasPeucker, distanceBasedCulling } from './utils/drawing.js';
import { Auth } from './Auth.js';
import { Moderation } from './Moderation.js';

export class DrawingApp {
  constructor(options = {}) {
    this.sessionIndex = null;  // Assigned by server on connect
    this.users = new Map();    // sessionIndex -> User
    this.connected = false;

    this.board = new Board({
      dimensions: options.dimensions || [1080, 1920]
    });
    this.board.app = this; // Allow tools to access wsClient

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();
    this.chat = new Chat({
      onSend: (message) => this.handleChatSend(message),
      onDM: (message, recipientId) => this.handleDMSend(message, recipientId),
      onSendImage: (imageData, recipientId) => this.handleChatImageSend(imageData, recipientId)
    });
    this.brushGallery = new BrushGallery({
      onSelect: (brush) => this.handleBrushSelect(brush)
    });
    this.colorPalette = new ColorPalette({
      onColorSelect: (colorOrCallback) => this.handlePaletteColorSelect(colorOrCallback)
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

    // Handlers initialized in init()
    this.remoteUserHandler = null;
    this.touchHandler = null;
    this.debugOverlay = null;
    this.regionTracker = null;
    this.syncClient = null;
    this.auth = null;
    this.moderation = null;
    this.selfRole = 0; // 0=guest
    this.moderation = new Moderation();

    // Tick system for synchronized drawing (90 TPS = ~11ms)
    this.tickRate = 90;
    this.tickInterval = 1000 / this.tickRate; // ~11.11ms
    this.tickTimer = null;
    this.lastTickTime = 0;

    // Input buffer - stores latest pointer state between ticks
    this.inputBuffer = {
      points: [],      // Array of [x1, y1, x2, y2, ...]
      lastPosition: null,  // { x, y } - previous position for interpolation
      pressure: 1,
      pointerType: 'mouse',
      movement: { x: 0, y: 0 }, // accumulated movement for panning
      dirty: false         // whether buffer has new data to process
    };

    // Point reduction configuration
    this.pointReduction = {
      enabled: options.enablePointReduction !== false, // true by default
      algorithm: options.reductionAlgorithm || 'douglas-peucker', // 'douglas-peucker' or 'distance-based'
      // Epsilon mapping for Douglas-Peucker (based on smoothing %)
      minEpsilon: 0.1,
      maxEpsilon: 5.0,
      // Distance threshold for distance-based culling (based on smoothing %)
      minDistance: 0.5,
      maxDistance: 10.0
    };

    // Baseline smoothing configuration - always-on light smoothing
    this.baselineSmoothing = {
      enabled: true,
      emaFactor: 0.12,        // 12% baseline EMA (light stabilization)
      pointReduction: {
        minEpsilon: 0.3,      // Always reduce some points
        maxEpsilon: 4.0       // Scales with total smoothing
      }
    };

    // EMA buffer for broadcast smoothing
    this.broadcastSmoothBuffer = { x: 0, y: 0, isFirst: true };

    // Pressure enabled state (checkbox)
    this.pressureEnabled = true;

    // Brush mode: 'classic' (BrushTool) or 'fluid' (FlowPenTool)
    this.brushMode = this.loadBrushMode();

    // Tool-specific locked values
    this.toolLocks = this.loadToolLocks();
  }

  async init() {
    this.ui.init();
    this.board.init('#boardContainer');
    this.chat.init();
    this.brushGallery.init();
    this.colorPalette.init();

    this.createSelf();
    this.initSelfFromUI(); // Sync self's settings from UI slider values
    this.setupColorPicker();

    // Initialize handlers
    this.remoteUserHandler = new RemoteUserHandler(this);
    this.touchHandler = new TouchHandler(this);
    this.touchHandler.init(this.ui.elements.boards);

    // Initialize debug overlay for dev mode
    this.debugOverlay = new DebugOverlay();
    const debugCanvas = document.getElementById('debugOverlay');
    console.log('[App] Debug overlay canvas element:', debugCanvas);
    this.debugOverlay.init(debugCanvas, this.board.getWidth(), this.board.getHeight());

    // Initialize region tracker for canvas sync
    this.regionTracker = new RegionTracker();
    this.regionTracker.init(this.board.mainCanvas);

    // Initialize sync client
    this.syncClient = new SyncClient();
    this.syncClient.init({
      wsClient: this.wsClient,
      board: this.board
    });

    // Initialize auth
    this.auth = new Auth({
      wsClient: this.wsClient,
      onSuccess: (token, role, username) => this.handleAuthSuccess(token, role, username),
      onError: (error) => this.handleAuthError(error)
    });
    this.auth.init();

    // Wire moderation callbacks
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
    this.moderation.onRequestModList = () => {
      this.wsClient.requestModList();
    };
    this.moderation.onRevokeEntry = (entryId, entryType, username) => {
      // Revoke: unmute=3, unban=4
      const revokeType = entryType === 'mutes' ? 3 : 4;
      this.wsClient.sendModRevoke(revokeType, username);
    };

    // Expose app globally for debugging
    window.app = this;

    this.setupEventListeners();
    setupWebSocketHandlers(this);

    const initialTool = this.brushMode === 'fluid' ? 'flowPen' : this.brushMode === 'ink' ? 'ink' : 'brush';
    this.self.setTool(initialTool);
    this.toolManager.setTool(initialTool);
    this.ui.updateToolDisplay(initialTool);
    this.ui.updateBrushModeDisplay(this.brushMode);

    // Restore locked values for initial tool and update lock button states
    if (this.toolLocks[initialTool]) {
      this.restoreLockedValues(initialTool);
      this.updateAllLockButtons(initialTool);
    }

    await this.wsClient.connect(this.self.toJSON());
  }

  createSelf() {
    // Create self with temporary ID, will be updated when server assigns sessionIndex
    this.self = new User(0, {
      context: this.board.topCtx,
      board: this.board.mainCanvas
    });
  }

  initSelfFromUI() {
    // Initialize self's settings from UI slider values
    const { elements } = this.ui;

    if (elements.smoothingSlider) {
      const smoothing = Number(elements.smoothingSlider.value) / 100;
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
  }

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
          this.self.setOpacity(rgba[3]); // Opacity comes from color alpha
          this.ui.updateSelfColor(rgba);
          this.ui.updateSelfTextStyle(this.self.size, rgba);
          this.ui.updateImageBrushOpacityValue(rgba[3]); // Sync with image brush opacity slider

          // Update image brush opacity slider position
          const { elements } = this.ui;
          if (elements.imageBrushOpacitySlider) {
            elements.imageBrushOpacitySlider.value = rgba[3] * 100;
          }

          if (this.connected) {
            this.wsClient.broadcastColorChange(rgba);
          }
        }
      });
    }
  }

  setupEventListeners() {
    const { elements } = this.ui;

    elements.joinBtn.addEventListener('click', () => this.handleJoin());
    elements.offlineBtn.addEventListener('click', () => this.startOfflineMode());
    elements.loginOfflineBtn.addEventListener('click', () => this.startOfflineMode());
    elements.reconnectBtn.addEventListener('click', () => this.reconnect());
    elements.disconnectBtn.addEventListener('click', () => this.disconnect());
    elements.selectBtn.addEventListener('click', () => this.selectTool('select'));
    elements.brushBtn.addEventListener('click', () => {
      const tool = this.brushMode === 'fluid' ? 'flowPen' : this.brushMode === 'ink' ? 'ink' : 'brush';
      this.selectTool(tool);
    });
    elements.lineBtn.addEventListener('click', () => this.selectTool('line'));
    elements.rectangleBtn.addEventListener('click', () => this.selectTool('rectangle'));
    elements.circleBtn.addEventListener('click', () => this.selectTool('circle'));
    elements.textBtn.addEventListener('click', () => this.selectTool('text'));
    elements.eraseBtn.addEventListener('click', () => this.selectTool('erase'));
    elements.imageBrushBtn.addEventListener('click', () => this.selectTool('imageBrush'));

    elements.clearBtn.addEventListener('click', () => this.handleClear());
    elements.resetBtn.addEventListener('click', () => this.handleResetBoard());
    elements.mirrorBtn.addEventListener('click', () => this.handleToggleMirror());
    elements.devBtn.addEventListener('click', () => this.handleToggleDevMode());
    elements.plusBtn.addEventListener('click', () => this.handleZoomIn());
    elements.minusBtn.addEventListener('click', () => this.handleZoomOut());
    elements.rotationResetBtn.addEventListener('click', () => this.handleResetRotation());
    elements.saveBtn.addEventListener('click', () => this.board.saveAsImage());

    elements.chatBtn.addEventListener('click', () => this.chat.toggle());
    elements.selfListUser.addEventListener('click', () => this.handleRenameself());

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

    // Click-outside to close context menu
    document.addEventListener('click', (e) => {
      if (elements.userContextMenu && !elements.userContextMenu.contains(e.target)) {
        this.moderation.hideContextMenu();
      }
    });

    elements.sizeSlider.addEventListener('input', (e) => this.handleSizeChange(e));
    elements.spacingSlider.addEventListener('input', (e) => this.handleSpacingChange(e));
    elements.smoothingSlider.addEventListener('input', (e) => this.handleSmoothingChange(e));
    elements.hardnessSlider.addEventListener('input', (e) => this.handleHardnessChange(e));
    elements.imageBrushOpacitySlider.addEventListener('input', (e) => this.handleImageBrushOpacityChange(e));
    elements.brushFileInput.addEventListener('change', (e) => this.handleBrushFileLoad(e));

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

    // Brush mode radio buttons
    const brushModeRadios = document.querySelectorAll('input[name="brushMode"]');
    brushModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.handleBrushModeChange(e.target.value);
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
      min: 0, max: 100, step: 1, suffix: '%',
      onCommit: (val) => {
        this.self.setSmoothing(val / 100);
        elements.smoothingSlider.value = val;
        this.wsClient.broadcastSmoothingChange(val / 100);
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
      min: 0, max: 100, step: 1, suffix: '%',
      onCommit: (val) => {
        this.self.setHardness(val / 100);
        elements.hardnessSlider.value = val;
        this.wsClient.broadcastHardnessChange(val / 100);
      }
    });

    this.ui.makeValueEditable(elements.imageBrushOpacityValue, {
      min: 0, max: 100, step: 1, suffix: '%',
      onCommit: (val) => {
        const opacity = val / 100;
        this.self.setOpacity(opacity);
        elements.imageBrushOpacitySlider.value = val;
        const currentColor = [...this.self.color];
        currentColor[3] = opacity;
        this.self.setColor(currentColor);
        this.colorPicker.setColor(`rgba(${currentColor.join(',')})`);
        if (this.connected) {
          this.wsClient.broadcastColorChange(currentColor);
        }
      }
    });

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

    // Lock button event listeners
    if (elements.sizeLock) elements.sizeLock.addEventListener('click', () => this.toggleLock('size'));
    if (elements.pressureLock) elements.pressureLock.addEventListener('click', () => this.toggleLock('pressure'));
    if (elements.smoothingLock) elements.smoothingLock.addEventListener('click', () => this.toggleLock('smoothing'));
    if (elements.spacingLock) elements.spacingLock.addEventListener('click', () => this.toggleLock('spacing'));
    if (elements.hardnessLock) elements.hardnessLock.addEventListener('click', () => this.toggleLock('hardness'));
    if (elements.imageBrushOpacityLock) elements.imageBrushOpacityLock.addEventListener('click', () => this.toggleLock('imageBrushOpacity'));

    elements.board.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    elements.board.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    elements.board.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    elements.board.addEventListener('pointerenter', () => {
      this.isOnBoard = true;
      this.ui.showCursor();
      // Refresh tool display to show correct cursor shape
      this.ui.updateToolDisplay(this.self.tool);

      // Broadcast cursor show to other users
      if (this.connected) {
        this.wsClient.broadcastShowCursor();
      }
    });
    elements.board.addEventListener('pointerleave', (e) => this.handlePointerLeave(e));

    // Also listen for pointerup on document to catch releases outside the board
    // This ensures eraser regions and other strokes finalize properly
    document.addEventListener('pointerup', (e) => {
      if (this.self.mousedown) {
        this.handlePointerUp(e);
      }
    });
    elements.board.addEventListener('wheel', (e) => this.handleWheel(e));
    elements.board.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cancelCurrentStroke();
    });
    elements.boardContainer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    // Touch gestures are now handled by Hammer.js in TouchHandler.init()

    // Hidden input for touch keyboard (text tool)
    if (elements.touchInput) {
      elements.touchInput.addEventListener('input', (e) => this.touchHandler.handleTouchInput(e));
      elements.touchInput.addEventListener('blur', () => this.touchHandler.handleTouchInputBlur());
    }

    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keyup', (e) => this.handleKeyUp(e));

    window.addEventListener('resize', () => this.handleResize());
  }

  // Connection lifecycle

  handleWSConnect(sessionIndex) {
    this.sessionIndex = sessionIndex;
    this.self.id = sessionIndex;
    this.users.set(sessionIndex, this.self);
    this.wsClient.broadcastToolChange(this.self.tool);

    // Request sync immediately on connect (before login/username selection)
    // so the board is already syncing while the user enters their name
    this.syncClient.requestSync();

    // Attempt auto-login with stored token
    if (this.auth && this.auth.attemptAutoLogin()) {
      // Wait for auth_result callback
      return;
    }

    // No stored token — show login dialog
    this.ui.showLogin();
    this.ui.elements.overlay.style.display = 'flex';
    // Pre-fill with current username if reconnecting
    if (this.self.username && this.self.username !== 'Offline') {
      this.ui.elements.loginUsername.value = this.self.username;
    }
  }

  handleWSDisconnect(code, reason) {
    this.connected = false;
    // Don't stop the tick loop - drawing should continue locally
    if (this.tickTimer) {
      this.ui.showConnectionStatus('disconnected');
    }

    // Handle moderation close codes — reconnect and show login so they can re-auth
    if (code === 4001 || code === 4002) {
      const label = code === 4001 ? 'banned' : 'kicked';
      this.ui.showToast(`You have been ${label}${reason ? ': ' + reason : ''}`, 5000);

      // Clear stored token so auto-login doesn't repeat the rejection
      if (this.auth) {
        this.auth.clearToken();
        this.auth.setRememberMe(false);
      }

      // Reconnect — handleWSConnect will show login form since token is cleared
      this.reconnect();
    }
  }

  handleAuthSuccess(token, role, username) {
    this.selfRole = role;
    this.self.role = role;
    this.self.setUsername(username);

    this.connected = true;
    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(username);
    this.ui.showConnectionStatus('connected');

    this.wsClient.broadcastNameChange(username);
    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastToolChange(this.self.tool);

    // Update moderation UI visibility based on role
    this.moderation.setRole(role);

    this.startTickLoop();
    this.syncClient.requestSync();

    const roleNames = ['Guest', 'User', 'Moderator', 'Admin'];
    this.ui.showToast(`Logged in as ${username} (${roleNames[role] || 'Guest'})`, 3000);
    console.log(`[Auth] Logged in as ${username} (${roleNames[role] || 'Guest'})`);
  }

  handleAuthError(error) {
    // Show login form with error
    this.ui.showLogin();
    this.ui.elements.overlay.style.display = 'flex';
    this.ui.showToast(error, 4000);
  }

  handleJoin() {
    this.connected = true;
    const name = this.ui.elements.loginUsername.value || 'Anon';
    this.self.setUsername(name);

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(name);
    this.ui.showConnectionStatus('connected');

    this.wsClient.broadcastNameChange(name);

    // Broadcast initial settings so other users see correct values
    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);
    this.wsClient.broadcastToolChange(this.self.tool);

    // Set sessionIndex on self user entry for context menu
    if (this.ui.elements.selfUserEntry) {
      this.ui.elements.selfUserEntry.dataset.sessionIndex = this.sessionIndex;
    }

    // Update moderation UI visibility based on role
    this.moderation.setRole(this.selfRole);

    // Start the tick loop (no-op if already running from a reconnect)
    this.startTickLoop();

    // Request canvas sync from server
    this.syncClient.requestSync();
  }

  handleRenameself() {
    if (!this.tickTimer) return; // Not in drawing mode yet
    const name = prompt('Enter your name:', this.self.username);
    if (name !== null && name.trim() !== '') {
      this.self.setUsername(name.trim());
      this.ui.updateSelfName(name.trim());
      this.wsClient.broadcastNameChange(name.trim());
    }
  }

  // Tick system methods

  startTickLoop() {
    if (this.tickTimer) return; // Already running

    this.lastTickTime = performance.now();
    this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
  }

  stopTickLoop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  tick() {
    const now = performance.now();
    this.lastTickTime = now;

    // Skip local drawing while syncing
    if (this.syncClient?.isSyncing()) return;

    // Only process if we have new input data OR need to catch up smoothing
    const needsCatchup = this.needsSmoothingCatchup();
    if (!this.inputBuffer.dirty && !needsCatchup) return;

    const { points, movement } = this.inputBuffer;

    // Handle panning movement
    if (this.self.panning && this.self.mousedown && (movement.x !== 0 || movement.y !== 0)) {
      this.board.pan(movement.x, movement.y);
      this.inputBuffer.movement = { x: 0, y: 0 }; // Reset accumulated movement
    }

    // Process drawing if we have position data
    if (points.length >= 2) {
      // 1. Update self state with the LATEST point in the batch
      const lastX = points[points.length - 2];
      const lastY = points[points.length - 1];
      this.self.setPosition(lastX, lastY);

      // 2. Process locally for immediate feedback (must run before broadcast for flowPen stamp buffer)
      if (this.self.mousedown && !this.self.panning) {
        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          // We iterate through the batch locally so the user sees smooth lines
          for (let i = 0; i < points.length; i += 2) {
              const currentPos = { x: points[i], y: points[i+1] };
              const prevPos = i === 0 ? (this.inputBuffer.lastPosition || currentPos) : { x: points[i-2], y: points[i-1] };
              tool.onPointerMove(this.self, currentPos, prevPos);

              // Debug: Track each point processed locally
              this.debugOverlay.addStrokePoint(this.self.id, currentPos.x, currentPos.y, 'tick');
          }
        }
      }

      // 3. Broadcast to remote users
      if (this.self.tool === 'flowPen' && this.self.mousedown && !this.self.panning) {
        // FlowPen: send exact stamp positions (already generated by tool.onPointerMove above)
        const tool = this.toolManager.getCurrentTool();
        const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
        if (stampPs.length > 0) {
          this.wsClient.broadcastStampMove(stampPs, stampRs);
        }
      } else if (this.self.tool === 'ink' && this.self.mousedown && !this.self.panning) {
        // Ink: send raw points + pressures via rs field
        const tool = this.toolManager.getCurrentTool();
        const { ps: fhPs, rs: fhRs } = tool.drainPointBuffer();
        if (fhPs.length > 0) {
          this.wsClient.broadcastStampMove(fhPs, fhRs);
        }
      } else {
        let broadcastPoints;
        if (this.self.mousedown && !this.self.panning) {
          broadcastPoints = this.applyBroadcastSmoothing(points);
          broadcastPoints = this.applyPointReduction(broadcastPoints);
        } else {
          broadcastPoints = points;
        }
        if (broadcastPoints.length > 0) {
          this.wsClient.broadcastMove(broadcastPoints);
        }
      }

      this.inputBuffer.lastPosition = { x: lastX, y: lastY };
    }

    // Smoothing catch-up: continue drawing towards target even when pointer is still
    if (needsCatchup) {
      this.processSmoothingCatchup();
    }

    // Clear points for next tick
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
  }

  /**
   * Check if smoothing needs to catch up to the target position
   * @returns {boolean} - True if catch-up is needed
   */
  needsSmoothingCatchup() {
    // Only catch up when actively drawing (not panning, mouse is down)
    if (!this.self.mousedown || this.self.panning) return false;

    const tool = this.toolManager.getCurrentTool();
    if (!tool || !tool.smoothBuffer) return false;

    // Only catch up for tools that use EMA smoothing (not ink - it uses its own streamline)
    const smoothingTools = ['brush', 'flowPen'];
    if (!smoothingTools.includes(this.self.tool)) return false;

    // Check if smoothing is enabled
    if (!this.self.smoothing || this.self.smoothing === 0) return false;

    // Calculate distance from smoothed position to target
    const dx = this.self.x - tool.smoothBuffer.x;
    const dy = this.self.y - tool.smoothBuffer.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Need catch-up if distance > 1 pixel
    return distance > 1;
  }

  /**
   * Process smoothing catch-up to continue drawing towards target
   */
  processSmoothingCatchup() {
    const tool = this.toolManager.getCurrentTool();
    if (!tool || !tool.smoothBuffer) return;

    // Calculate distance to determine catch-up speed
    const dx = this.self.x - tool.smoothBuffer.x;
    const dy = this.self.y - tool.smoothBuffer.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Scale catch-up iterations based on distance for faster convergence
    // Farther away = more iterations per tick
    let iterations = 1;
    if (distance > 100) iterations = 8;
    else if (distance > 50) iterations = 5;
    else if (distance > 20) iterations = 3;
    else if (distance > 10) iterations = 2;

    // Generate a synthetic pointer move towards the target
    const targetPos = { x: this.self.x, y: this.self.y };
    let prevPos = { x: tool.smoothBuffer.x, y: tool.smoothBuffer.y };

    // Process multiple catch-up steps for faster convergence
    for (let i = 0; i < iterations; i++) {
      tool.onPointerMove(this.self, targetPos, prevPos);
      prevPos = { x: tool.smoothBuffer.x, y: tool.smoothBuffer.y };

      // Check if we've converged (within 1 pixel)
      const dx = this.self.x - tool.smoothBuffer.x;
      const dy = this.self.y - tool.smoothBuffer.y;
      if (Math.sqrt(dx * dx + dy * dy) <= 1) break;
    }

    // Broadcast the final catch-up position
    if (this.self.tool === 'flowPen') {
      const { ps: stampPs, rs: stampRs } = tool.drainStampBuffer();
      if (stampPs.length > 0) {
        this.wsClient.broadcastStampMove(stampPs, stampRs);
      }
    } else {
      const points = [targetPos.x, targetPos.y];
      const broadcastPoints = this.applyBroadcastSmoothing(points);
      const reducedPoints = this.applyPointReduction(broadcastPoints);
      this.wsClient.broadcastMove(reducedPoints);
    }

    // Track for debug overlay
    this.debugOverlay.addStrokePoint(this.self.id, targetPos.x, targetPos.y, 'catchup');
    this.debugOverlay.addDrawingPoint(targetPos.x, targetPos.y, this.self.size, this.self.id);
    this.regionTracker.addDrawingPoint(targetPos.x, targetPos.y, this.self.size, this.self.id);
  }

  /**
   * Apply Level 1 point reduction to reduce bandwidth before network broadcast
   * @param {Array} points - Flat array [x1, y1, x2, y2, ...]
   * @returns {Array} - Reduced flat array
   */
  applyPointReduction(points) {
    // Skip reduction if disabled or insufficient points
    if (!this.pointReduction.enabled || points.length < 4) {
      return points;
    }

    const userSmoothing = this.self.smoothing * 100; // Convert 0-1 to 0-100
    const baseline = this.baselineSmoothing.pointReduction;

    // Convert flat array [x1, y1, x2, y2, ...] to point objects
    const pointObjects = [];
    for (let i = 0; i < points.length; i += 2) {
      pointObjects.push({ x: points[i], y: points[i + 1] });
    }

    let reduced;

    if (this.pointReduction.algorithm === 'douglas-peucker') {
      // Always apply at least baseline reduction, scale up with user smoothing
      const epsilon = baseline.minEpsilon +
        (baseline.maxEpsilon - baseline.minEpsilon) * (userSmoothing / 100);

      reduced = douglasPeucker(pointObjects, epsilon);
    } else if (this.pointReduction.algorithm === 'distance-based') {
      // Calculate distance threshold based on smoothing level
      const { minDistance, maxDistance } = this.pointReduction;
      const threshold = minDistance + (maxDistance - minDistance) * (userSmoothing / 100);

      reduced = distanceBasedCulling(pointObjects, threshold);
    } else {
      // Invalid algorithm, return original
      console.warn(`Invalid point reduction algorithm: ${this.pointReduction.algorithm}`);
      return points;
    }

    // Convert back to flat array
    const result = [];
    for (const p of reduced) {
      result.push(p.x, p.y);
    }

    return result;
  }

  /**
   * Apply EMA smoothing to points before broadcast
   * This must match BrushTool.smoothPosition() exactly so remote users
   * see the smoothed position (with lag), not the raw cursor position
   * @param {Array} points - Flat array [x1, y1, x2, y2, ...]
   * @returns {Array} - Smoothed flat array
   */
  applyBroadcastSmoothing(points) {
    if (points.length < 2) {
      return points;
    }

    // Match BrushTool.smoothPosition() formula exactly:
    // totalSmoothing = baseline + userSmoothing * (1 - baseline)
    // factor = 1 - totalSmoothing * 0.9
    const baselineEma = 0.12;
    const userSmoothing = this.self.smoothing || 0;
    const totalSmoothing = baselineEma + userSmoothing * (1 - baselineEma);
    const factor = 1 - totalSmoothing * 0.9;

    const result = [];

    for (let i = 0; i < points.length; i += 2) {
      if (this.broadcastSmoothBuffer.isFirst) {
        this.broadcastSmoothBuffer.x = points[i];
        this.broadcastSmoothBuffer.y = points[i + 1];
        this.broadcastSmoothBuffer.isFirst = false;
      } else {
        this.broadcastSmoothBuffer.x += (points[i] - this.broadcastSmoothBuffer.x) * factor;
        this.broadcastSmoothBuffer.y += (points[i + 1] - this.broadcastSmoothBuffer.y) * factor;
      }
      result.push(this.broadcastSmoothBuffer.x, this.broadcastSmoothBuffer.y);
    }
    return result;
  }

  startOfflineMode() {
    // Set up offline mode - no server connection needed
    this.connected = true;
    this.sessionIndex = 1;
    this.self.id = 1;
    this.self.setUsername(this.ui.elements.loginUsername.value || 'Offline');

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(this.self.username);
    this.ui.hideConnectionStatus();

    // Start the tick loop (same behavior as online)
    this.startTickLoop();

    // Disconnect WebSocket if it was trying to connect
    if (this.wsClient && this.wsClient.disconnect) {
      this.wsClient.disconnect();
    }
  }

  async reconnect() {
    this.ui.showConnectionStatus('connecting');

    // Clean up old socket before reconnecting
    if (this.wsClient) {
      this.wsClient.disconnect();
    }

    try {
      await this.wsClient.connect(this.self.toJSON());
      // handleWSConnect will show the login dialog on success
    } catch (err) {
      console.error('Reconnect failed:', err);
      this.ui.showConnectionStatus('disconnected');
    }
  }

  disconnect() {
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
    // handleWSDisconnect will update the UI via the onclose callback

    // Clear stored auth so auto-login doesn't bypass the login form
    if (this.auth) {
      this.auth.clearToken();
      this.auth.setRememberMe(false);
    }
    this.selfRole = 0;
    this.moderation.setRole(0);

    // Return to login dialog
    this.ui.hideCursor();
    this.ui.hideConnectionStatus();
    this.ui.showLogin();
    this.ui.elements.overlay.style.display = 'flex';
  }

  // Tool management

  selectTool(tool) {
    // Commit any in-progress stroke before switching tools
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

    // Save current values for previous tool if locked
    if (previousTool && this.toolLocks[previousTool]) {
      this.saveLockedValues(previousTool);
    }

    // Update brush mode state when switching to brush/flowPen/ink
    if (tool === 'brush' || tool === 'flowPen' || tool === 'ink') {
      this.brushMode = tool === 'flowPen' ? 'fluid' : tool === 'ink' ? 'ink' : 'classic';
      this.saveBrushMode();
      this.ui.updateBrushModeDisplay(this.brushMode);
    }

    this.self.setTool(tool);
    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool);
    this.wsClient.broadcastToolChange(tool);

    // Restore locked values for new tool
    if (this.toolLocks[tool]) {
      this.restoreLockedValues(tool);
    }

    // Update lock button states
    this.updateAllLockButtons(tool);

    // Show/hide brush gallery for imageBrush tool
    if (tool === 'imageBrush') {
      this.brushGallery.show();
    } else {
      this.brushGallery.hide();
    }
  }

  handleBrushModeChange(mode) {
    if (this.self.mousedown) {
      this.ui.updateBrushModeDisplay(this.brushMode);
      return;
    }

    this.brushMode = mode;
    this.saveBrushMode();

    const toolName = mode === 'fluid' ? 'flowPen' : mode === 'ink' ? 'ink' : 'brush';
    this.selectTool(toolName);
  }

  loadBrushMode() {
    try {
      return localStorage.getItem('topDrawBrushMode') || 'ink';
    } catch (e) {
      return 'ink';
    }
  }

  saveBrushMode() {
    try {
      localStorage.setItem('topDrawBrushMode', this.brushMode);
    } catch (e) {}
  }

  handleBrushSelect(brush) {
    // Apply the selected brush to self
    this.self.imageBrush = brush;

    // Update the preview image
    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      this.ui.setBrushPreview(brush.gBrushes[0].gimpUrl);
    } else {
      this.ui.setBrushPreview(brush.gimpUrl);
    }

    // Broadcast brush to other users
    this.wsClient.broadcastBrush(brush);
  }

  // Canvas controls

  handleClear() {
    this.board.clear();
    this.wsClient.broadcastClear();
  }

  handleResetBoard() {
    this.board.resetView();
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  handleToggleMirror() {
    const mirror = this.board.toggleMirror();
    this.ui.updateMirrorDisplay(mirror);
    this.wsClient.broadcastMirror();
  }

  handleToggleDevMode() {
    console.log('[App] handleToggleDevMode called');
    const enabled = this.debugOverlay.toggle();
    this.ui.updateDevModeDisplay(enabled);
    console.log('[App] Dev mode now:', enabled);
  }

  handleZoomIn() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomIn(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  handleZoomOut() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomOut(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  handleResetRotation() {
    this.board.resetRotation();
  }

  // Brush/tool settings

  handleSizeChange(e) {
    const size = Number(e.target.value);
    this.self.setSize(size);
    this.ui.updateCursorSize(size);
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
    this.self.setSmoothing(smoothing / 100); // Convert to 0-1 range
    this.ui.updateSmoothingValue(smoothing);
    this.wsClient.broadcastSmoothingChange(smoothing / 100);
  }

  handleHardnessChange(e) {
    const hardness = Number(e.target.value);
    this.self.setHardness(hardness / 100); // Convert to 0-1 range
    this.ui.updateHardnessValue(hardness / 100);
    this.wsClient.broadcastHardnessChange(hardness / 100);
  }

  handleImageBrushOpacityChange(e) {
    const opacity = Number(e.target.value) / 100; // Convert to 0-1 range

    // Update user opacity (same as color picker alpha)
    this.self.setOpacity(opacity);
    this.ui.updateImageBrushOpacityValue(opacity);

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

  // Pointer event handlers

  handlePointerMove(e) {
    // Block local input while syncing
    if (this.syncClient?.isSyncing()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      return;
    }

    const x = Math.round(e.offsetX * 100) / 100;
    const y = Math.round(e.offsetY * 100) / 100;

    // Update cursor immediately for visual responsiveness
    this.ui.updateSelfCursor(x, y, this.self.size);

    // Handle pressure for pen input
    let pressure = 1;
    if (!this.pressureEnabled) {
      pressure = 1;
    } else if (e.pointerType === 'pen' && !this.self.panning) {
      const minP = Number(this.ui.elements.pressureMinSlider.value) / 100;
      const maxP = Number(this.ui.elements.pressureMaxSlider.value) / 100;
      pressure = minP + (maxP - minP) * e.pressure;
      pressure = Math.round(pressure * 100) / 100;

      // If stroke start was deferred, now we have real pressure - start the stroke
      if (this._pendingPenDown) {
        const pending = this._pendingPenDown;
        this._pendingPenDown = null;
        this.self.setPressure(pressure);
        this.inputBuffer.pressure = pressure;
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
      } else if (pressure !== this.inputBuffer.pressure) {
        // Commit BEFORE updating pressure so old segment draws at correct width
        if (pressure !== this.self.pressure && this.self.mousedown) {
          this.wsClient.broadcastPressureChange(pressure);
          if (this.self.tool === 'brush') {
            this.commitSelfLine(pressure, this.self.size);
          }
        }
        this.self.setPressure(pressure);
        this.inputBuffer.pressure = pressure;
      }
    }

    // Buffer the input for processing
    this.inputBuffer.points.push(x, y);
    this.inputBuffer.pointerType = e.pointerType;
    this.inputBuffer.dirty = true;

    // Accumulate movement for panning (since multiple events may occur between ticks)
    if (this.self.panning && this.self.mousedown) {
      this.inputBuffer.movement.x += e.movementX;
      this.inputBuffer.movement.y += e.movementY;
    }

    // Track drawing for debug overlay (pass brush size and user info)
    if (this.self.mousedown && !this.self.panning) {
      this.debugOverlay.addDrawingPoint(x, y, this.self.size, this.self.id);
      this.regionTracker.addDrawingPoint(x, y, this.self.size, this.self.id);
    }
  }

  handlePointerDown(e) {
    // Block local input while syncing
    if (this.syncClient?.isSyncing()) return;

    // Skip drawing during two-finger gestures
    if (this.touchHandler.state.isPinching || this.touchHandler.state.gestureStartedWithTwoFingers) {
      return;
    }

    // Middle-click enables panning mode
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this.wsClient.broadcastPan(true);
      return;
    }

    // Right-click cancels current stroke
    if (e.button === 2) {
      this.cancelCurrentStroke();
      return;
    }

    // Only draw with left-click (button === 0)
    if (e.button !== 0) return;

    // Block drawing when muted (allow panning)
    if (this.self.isMuted && !this.self.panning) {
      if (!this._lastMuteToast || Date.now() - this._lastMuteToast > 3000) {
        this.ui.showToast('You are muted', 2000);
        this._lastMuteToast = Date.now();
      }
      return;
    }

    if (e.pointerType === 'mouse' || !this.pressureEnabled) {
      this.self.setPressure(1);
      this.inputBuffer.pressure = 1;
      this.wsClient.broadcastPressureChange(1);
    }

    const pos = { x: Math.round(e.offsetX * 100) / 100, y: Math.round(e.offsetY * 100) / 100 };

    // Initialize input buffer for this stroke
    this.inputBuffer.position = pos;
    this.inputBuffer.lastPosition = pos;
    this.inputBuffer.movement = { x: 0, y: 0 };
    this.inputBuffer.pointerType = e.pointerType;

    // Reset broadcast smooth buffer for new stroke
    this.broadcastSmoothBuffer.isFirst = true;

    // Set self position immediately for pointerDown
    this.self.setPosition(pos.x, pos.y);
    this.self.lastx = this.self.x;
    this.self.lasty = this.self.y;
    this.self.mousedown = true;
    this.self.spaceIndex = 0;
    this.self._mainCtxDrawCount = 0; // Reset draw counter for this stroke

    // Defer broadcastMouseDown for pen input — pressure isn't known yet at pointerDown,
    // so sending MD now would cause the remote side to draw the initial dot at max size.
    // It will be sent when _pendingPenDown is resolved in handlePointerMove.
    const deferBroadcast = e.pointerType === 'pen' && this.pressureEnabled && !this.self.panning;
    if (!deferBroadcast) {
      this.wsClient.broadcastMouseDown();
    }

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        // For text tool with touch, don't commit immediately - wait for pointerUp
        // to allow two-finger gestures to cancel the text placement
        if (this.self.tool === 'text' && e.pointerType === 'touch') {
          // Store pending text position but don't call onPointerDown yet
          this.self._pendingTextPos = pos;
          this.self._pendingTextPointerType = e.pointerType;

          // Focus hidden input for touch keyboard support
          if (this.ui.elements.touchInput) {
            this.ui.elements.touchInput.focus();
          }
        } else if (e.pointerType === 'pen' && this.pressureEnabled) {
          // Defer pen stroke start until first pointerMove provides real pressure
          this._pendingPenDown = { pos, event: e };
        } else {
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
          }
        }
      }

      // Add current color to recent colors when starting to draw
      if (this.self.tool !== 'erase' && this.self.tool !== 'select') {
        this.colorPalette.addRecentColor(this.self.color);
      }

      // Start tracking for debug overlay (pass tool type, brush size, and user info)
      this.debugOverlay.startDrawing(pos.x, pos.y, this.self.tool, this.self.size, this.self.id, this.self.username);

      // Start tracking for region sync
      this.regionTracker.startDrawing(pos.x, pos.y, this.self.tool, this.self.size, this.self.id, this.self.username);
    }
  }

  handlePointerUp(e) {
    // Middle-click release disables panning mode
    if (e.button === 1) {
      this.self.panning = false;
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
      this.inputBuffer.dirty = false;
      return;
    }

    // Clear pending pen down if pen lifted without moving
    this._pendingPenDown = null;

    // Process any remaining buffered input before ending stroke
    if (this.inputBuffer.dirty) {
      this.tick();
    }

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();

      // Handle text tool touch placement on lift
      if (this.self.tool === 'text' && this.self._pendingTextPos && e.pointerType === 'touch') {
        const textTool = this.toolManager.getTool('text');
        if (textTool) {
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

      // End tracking for region sync
      this.regionTracker.endDrawing(this.self.id);

      // Debug: End stroke tracking for local user
      this.debugOverlay.endStrokeTracking(this.self.id);

    }

    this.self.mousedown = false;
    this.wsClient.broadcastMouseUp();

    // Reset input buffer
    this.inputBuffer.dirty = false;
  }

  handlePointerLeave(e) {
    this.isOnBoard = false;
    this.ui.hideCursor();

    // Broadcast cursor hide to other users
    if (this.connected) {
      this.wsClient.broadcastHideCursor();
    }
  }

  // Wheel/zoom handlers

  handleWheel(e) {
    e.preventDefault();

    if (this.self.panning) {
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
    this.ui.updateSizeValue(size);
    this.ui.updateSelfTextStyle(size, this.self.color);
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
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

    // Clear the top canvas AFTER all tool state is reset
    // This ensures no residual preview remains
    this.board.clearTop();

    // Cancel debug overlay tracking
    this.debugOverlay.cancelDrawing(this.self.id);

    this.wsClient.broadcastCancel();
  }

  // Keyboard handlers

  handleKeyDown(e) {
    // Close context menu on Escape
    if (e.key === 'Escape' && this.ui.elements.userContextMenu?.style.display !== 'none') {
      this.moderation.hideContextMenu();
      return;
    }

    if (e.key === '/' || e.key === "'") {
      e.preventDefault();
    }

    if (e.key === ' ' && this.self.tool !== 'text' && !this.self.panning && !this.self.mousedown) {
      this.self.panning = true;
      this.wsClient.broadcastPan(true);
    }

    this.wsClient.broadcastKeyPress(e.key);

    if (this.self.tool === 'text') {
      const textTool = this.toolManager.getTool('text');
      const text = textTool.onKeyPress(this.self, e.key);
      this.ui.updateSelfTextInput(text);
    } else if (this.tickTimer) {
      // Handle shortcuts only when in drawing mode (tick loop running)
      const selectTool = this.toolManager.getTool('select');

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'c':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.copy();
            }
            return;
          case 'x':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.cut();
            }
            return;
          case 'v':
            if (selectTool && selectTool.hasClipboard()) {
              e.preventDefault();
              this.selectTool('select');
              selectTool.paste();
            }
            return;
          case 'a':
            e.preventDefault();
            this.selectTool('select');
            selectTool.selectAll();
            return;
          case 'd':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.deselect();
            }
            return;
        }
      }

      // Delete/Backspace to delete selection
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.self.tool === 'select') {
        if (selectTool && selectTool.hasSelection()) {
          e.preventDefault();
          selectTool.deleteSelection();
        }
        return;
      }

      // Escape to deselect
      if (e.key === 'Escape' && this.self.tool === 'select') {
        if (selectTool && selectTool.hasSelection()) {
          selectTool.deselect();
        }
        return;
      }

      switch (e.key) {
        case 's':
          this.selectTool('select');
          break;
        case 'b':
          this.selectTool(this.brushMode === 'fluid' ? 'flowPen' : this.brushMode === 'ink' ? 'ink' : 'brush');
          break;
        case 'p':
          if (this.self.tool === 'brush' || this.self.tool === 'flowPen' || this.self.tool === 'ink') {
            // Cycle: classic -> fluid -> ink -> classic
            const nextMode = this.brushMode === 'classic' ? 'fluid' : this.brushMode === 'fluid' ? 'ink' : 'classic';
            this.handleBrushModeChange(nextMode);
          } else {
            this.brushMode = 'fluid';
            this.selectTool('flowPen');
          }
          break;
        case 'l':
          this.selectTool('line');
          break;
        case 'r':
          this.selectTool('rectangle');
          break;
        case 'c':
          this.selectTool('circle');
          break;
        case 't':
          this.selectTool('text');
          break;
        case 'e':
          this.selectTool('erase');
          break;
        case 'g':
          this.selectTool('imageBrush');
          break;
      }
    }
  }

  handleKeyUp(e) {
    if (e.key === ' ' && this.self.tool !== 'text') {
      this.self.panning = false;
      this.wsClient.broadcastPan(false);
    }
  }

  handleResize() {
    this.board.calculateDefaultView();
  }

  // Tool Locks Management

  loadToolLocks() {
    try {
      const saved = localStorage.getItem('topDrawToolLocks');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load tool locks:', e);
    }

    // Default structure
    return this.getDefaultToolLocks();
  }

  getDefaultToolLocks() {
    const tools = ['brush', 'flowPen', 'ink', 'line', 'rectangle', 'circle', 'imageBrush', 'erase', 'text', 'select'];
    const locks = {};

    tools.forEach(tool => {
      locks[tool] = {
        size: { locked: false, value: 10 },
        pressure: { locked: false, min: 0, max: 100, enabled: true },
        smoothing: { locked: false, value: 0.3 },
        spacing: { locked: false, value: 0 },
        hardness: { locked: false, value: 1.0 },
        imageBrushOpacity: { locked: false, value: 1.0 }
      };
    });

    return locks;
  }

  saveToolLocks() {
    try {
      localStorage.setItem('topDrawToolLocks', JSON.stringify(this.toolLocks));
    } catch (e) {
      console.warn('Failed to save tool locks:', e);
    }
  }

  saveLockedValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    // Save current values for locked properties
    if (locks.size?.locked) locks.size.value = this.self.size;
    if (locks.pressure?.locked) {
      locks.pressure.min = Number(this.ui.elements.pressureMinSlider.value);
      locks.pressure.max = Number(this.ui.elements.pressureMaxSlider.value);
      locks.pressure.enabled = this.pressureEnabled;
    }
    if (locks.smoothing?.locked) locks.smoothing.value = this.self.smoothing;
    if (locks.spacing?.locked) locks.spacing.value = this.self.spacing;
    if (locks.hardness?.locked) locks.hardness.value = this.self.hardness;
    if (locks.imageBrushOpacity?.locked) {
      // imageBrushOpacity is derived from color alpha
      locks.imageBrushOpacity.value = this.self.opacity;
    }

    this.saveToolLocks();
  }

  restoreLockedValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { elements } = this.ui;

    // Restore locked values
    if (locks.size?.locked) {
      this.self.setSize(locks.size.value);
      this.ui.updateSizeValue(locks.size.value);
      this.ui.updateCursorSize(locks.size.value);
      if (elements.sizeSlider) elements.sizeSlider.value = locks.size.value;
      if (this.connected) {
        this.wsClient.broadcastSizeChange(locks.size.value);
      }
    }
    if (locks.pressure?.locked) {
      // Backward compat: if old lock has .value instead of .min/.max
      let pMin, pMax, pEnabled;
      if (locks.pressure.value !== undefined && locks.pressure.min === undefined) {
        pMin = 0;
        pMax = Math.round(locks.pressure.value * 100);
        pEnabled = true;
      } else {
        pMin = locks.pressure.min ?? 0;
        pMax = locks.pressure.max ?? 100;
        pEnabled = locks.pressure.enabled ?? true;
      }
      if (elements.pressureMinSlider) elements.pressureMinSlider.value = pMin;
      if (elements.pressureMaxSlider) elements.pressureMaxSlider.value = pMax;
      this.ui.updatePressureValue(pMin, pMax);
      this.pressureEnabled = pEnabled;
      if (elements.pressureEnabled) elements.pressureEnabled.checked = pEnabled;
      if (elements.pressureDualSlider) elements.pressureDualSlider.style.display = pEnabled ? '' : 'none';
    }
    if (locks.smoothing?.locked) {
      this.self.setSmoothing(locks.smoothing.value);
      this.ui.updateSmoothingValue(locks.smoothing.value * 100);
      if (elements.smoothingSlider) elements.smoothingSlider.value = locks.smoothing.value * 100;
      if (this.connected) {
        this.wsClient.broadcastSmoothingChange(locks.smoothing.value);
      }
    }
    if (locks.spacing?.locked) {
      this.self.setSpacing(locks.spacing.value);
      this.ui.updateSpacingValue(locks.spacing.value);
      if (elements.spacingSlider) elements.spacingSlider.value = locks.spacing.value;
      if (this.connected) {
        this.wsClient.broadcastSpacingChange(locks.spacing.value);
      }
    }
    if (locks.hardness?.locked) {
      this.self.setHardness(locks.hardness.value);
      this.ui.updateHardnessValue(locks.hardness.value * 100);
      if (elements.hardnessSlider) elements.hardnessSlider.value = locks.hardness.value * 100;
      if (this.connected) {
        this.wsClient.broadcastHardnessChange(locks.hardness.value);
      }
    }
    if (locks.imageBrushOpacity?.locked) {
      // Update color alpha (opacity)
      const currentColor = [...this.self.color];
      currentColor[3] = locks.imageBrushOpacity.value;
      this.self.setColor(currentColor);
      this.self.setOpacity(locks.imageBrushOpacity.value);
      this.ui.updateImageBrushOpacityValue(locks.imageBrushOpacity.value);
      if (elements.imageBrushOpacitySlider) elements.imageBrushOpacitySlider.value = locks.imageBrushOpacity.value * 100;

      // Update color picker to reflect the locked opacity
      if (this.colorPicker) {
        this.colorPicker.setColor(`rgba(${currentColor.join(',')})`, true);
      }

      if (this.connected) {
        this.wsClient.broadcastColorChange(currentColor);
      }
    }
  }

  updateAllLockButtons(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    this.ui.updateLockButton('size', locks.size?.locked || false);
    this.ui.updateLockButton('pressure', locks.pressure?.locked || false);
    this.ui.updateLockButton('smoothing', locks.smoothing?.locked || false);
    this.ui.updateLockButton('spacing', locks.spacing?.locked || false);
    this.ui.updateLockButton('hardness', locks.hardness?.locked || false);
    this.ui.updateLockButton('imageBrushOpacity', locks.imageBrushOpacity?.locked || false);
  }

  toggleLock(property) {
    const tool = this.self.tool;
    if (!this.toolLocks[tool]) return;

    const lock = this.toolLocks[tool][property];
    if (!lock) {
      // Initialize lock if it doesn't exist
      this.toolLocks[tool][property] = { locked: false, value: this.self[property] || 0 };
      return;
    }

    // Toggle lock state
    lock.locked = !lock.locked;

    // If locking, save current value
    if (lock.locked) {
      if (property === 'pressure') {
        lock.min = Number(this.ui.elements.pressureMinSlider.value);
        lock.max = Number(this.ui.elements.pressureMaxSlider.value);
        lock.enabled = this.pressureEnabled;
      } else if (property === 'imageBrushOpacity') {
        lock.value = this.self.opacity;
      } else {
        lock.value = this.self[property];
      }
    }

    // Update UI
    this.ui.updateLockButton(property, lock.locked);

    // Save to localStorage
    this.saveToolLocks();

    console.log(`${property} ${lock.locked ? 'locked' : 'unlocked'} for ${tool} tool at value ${lock.value}`);
  }
}
