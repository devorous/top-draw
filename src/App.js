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
      onDisconnect: () => this.handleWSDisconnect()
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

    // Expose app globally for debugging
    window.app = this;

    this.setupEventListeners();
    setupWebSocketHandlers(this);

    this.toolManager.setTool('brush');
    this.ui.updateToolDisplay('brush');

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

    if (elements.pressureSlider) {
      const pressure = Number(elements.pressureSlider.value) / 100;
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
    elements.selectBtn.addEventListener('click', () => this.selectTool('select'));
    elements.brushBtn.addEventListener('click', () => this.selectTool('brush'));
    elements.flowPenBtn.addEventListener('click', () => this.selectTool('flowPen'));
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
    elements.saveBtn.addEventListener('click', () => this.board.saveAsImage());

    elements.chatBtn.addEventListener('click', () => this.chat.toggle());

    elements.sizeSlider.addEventListener('input', (e) => this.handleSizeChange(e));
    elements.spacingSlider.addEventListener('input', (e) => this.handleSpacingChange(e));
    elements.pressureSlider.addEventListener('input', (e) => this.handlePressureSliderChange(e));
    elements.smoothingSlider.addEventListener('input', (e) => this.handleSmoothingChange(e));
    elements.brushFileInput.addEventListener('change', (e) => this.handleBrushFileLoad(e));

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

    // Touch events for pinch-to-zoom
    elements.boards.addEventListener('touchstart', (e) => this.touchHandler.handleTouchStart(e), { passive: false });
    elements.boards.addEventListener('touchmove', (e) => this.touchHandler.handleTouchMove(e), { passive: false });
    elements.boards.addEventListener('touchend', (e) => this.touchHandler.handleTouchEnd(e), { passive: false });

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
    this.ui.showLogin();
  }

  handleWSDisconnect() {
    this.connected = false;
    this.stopTickLoop();
  }

  handleJoin() {
    this.connected = true;
    const name = this.ui.elements.usernameInput.value || 'Anon';
    this.self.setUsername(name);

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(name);

    this.wsClient.broadcastNameChange(name);

    // Broadcast initial settings so other users see correct values
    this.wsClient.broadcastSmoothingChange(this.self.smoothing);
    this.wsClient.broadcastSizeChange(this.self.size);
    this.wsClient.broadcastColorChange(this.self.color);

    // Start the tick loop
    this.startTickLoop();

    // Request canvas sync from server
    this.syncClient.requestSync();
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

    // Only process if we have new input data
    if (!this.inputBuffer.dirty) return;

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

      // 2. Apply smoothing only when actively drawing (not just moving cursor)
      // This ensures dots are placed at exact click position, not lagged
      let broadcastPoints;
      if (this.self.mousedown && !this.self.panning) {
        broadcastPoints = this.applyBroadcastSmoothing(points);
      } else {
        broadcastPoints = points;
      }
      const reducedPoints = this.applyPointReduction(broadcastPoints);
      this.wsClient.broadcastMove(reducedPoints);

      // 3. Process locally for immediate feedback
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

      this.inputBuffer.lastPosition = { x: lastX, y: lastY };
    }

    // Clear points for next tick
    this.inputBuffer.points = [];
    this.inputBuffer.dirty = false;
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
    this.self.setUsername('Offline');

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName('Offline');

    // Start the tick loop (same behavior as online)
    this.startTickLoop();

    // Disconnect WebSocket if it was trying to connect
    if (this.wsClient && this.wsClient.disconnect) {
      this.wsClient.disconnect();
    }
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
      }
      this.self.mousedown = false;
      this.wsClient.broadcastMouseUp();
    }

    this.self.setTool(tool);
    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool);
    this.wsClient.broadcastToolChange(tool);

    // Show/hide brush gallery for imageBrush tool
    if (tool === 'imageBrush') {
      this.brushGallery.show();
    } else {
      this.brushGallery.hide();
    }
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

  handlePressureSliderChange(e) {
    const pressure = Number(e.target.value);
    this.ui.updatePressureValue(pressure);
    // Note: This sets max pressure for pen input, actual pressure comes from pointer events
  }

  handleSmoothingChange(e) {
    const smoothing = Number(e.target.value);
    this.self.setSmoothing(smoothing / 100); // Convert to 0-1 range
    this.ui.updateSmoothingValue(smoothing);
    this.wsClient.broadcastSmoothingChange(smoothing / 100);
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
    const x = e.offsetX;
    const y = e.offsetY;

    // Update cursor immediately for visual responsiveness
    this.ui.updateSelfCursor(x, y, this.self.size);

    // Handle pressure for pen input
    let pressure = 1;
    if (e.pointerType === 'pen' && !this.self.panning) {
      const maxPressure = Number(this.ui.elements.pressureSlider.value) / 100;
      pressure = Math.min(maxPressure, Math.round(e.pressure * 100) / 100);

      // Pressure changes need immediate handling for brush commits
      if (pressure !== this.inputBuffer.pressure) {
        this.self.setPressure(pressure);
        this.inputBuffer.pressure = pressure;

        if (this.self.pressure !== this.self.prevpressure && this.self.mousedown && this.self.tool === 'brush') {
          this.wsClient.broadcastPressureChange(pressure);
          this.commitSelfLine();
        }
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

    if (e.pointerType === 'mouse') {
      this.self.setPressure(1);
      this.inputBuffer.pressure = 1;
      this.wsClient.broadcastPressureChange(1);
    }

    const pos = { x: e.offsetX, y: e.offsetY };

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

    this.wsClient.broadcastMouseDown();

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerDown(this.self, pos, e);

        // Debug: Start tracking stroke points for local user
        this.debugOverlay.startStrokeTracking(this.self.id, true);
        this.debugOverlay.addStrokePoint(this.self.id, pos.x, pos.y, 'pointerDown');

        // If text tool was used to commit text, update UI to clear the text display
        if (this.self.tool === 'text') {
          this.ui.updateSelfTextInput(this.self.text);

          // Focus hidden input for touch keyboard support
          if (e.pointerType === 'touch' && this.ui.elements.touchInput) {
            this.ui.elements.touchInput.focus();
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

    // Process any remaining buffered input before ending stroke
    if (this.inputBuffer.dirty) {
      this.tick();
    }

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerUp(this.self, { x: this.self.x, y: this.self.y }, e);
      }

      // End tracking for debug overlay
      this.debugOverlay.endDrawing(this.self.id);

      // End tracking for region sync
      this.regionTracker.endDrawing(this.self.id);

      // Debug: End stroke tracking for local user
      this.debugOverlay.endStrokeTracking(this.self.id);

      // Debug: Log total mainCtx draws for this stroke
      console.log(`[DrawDebug] LOCAL user=${this.self.id} STROKE END - total mainCtx draws: ${this.self._mainCtxDrawCount || 0}`);
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
    } else {
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

    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine();
    }

    size = Math.round(size * 100) / 100;
    this.self.setSize(size);
    this.ui.elements.sizeSlider.value = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSizeValue(size);
    this.ui.updateSelfTextStyle(size, this.self.color);
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
  }

  // Line utilities

  commitSelfLine() {
    const brushTool = this.toolManager.getTool('brush');
    brushTool.commitCurrentLine(this.self);
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
    } else if (this.connected) {
      // Handle selection tool shortcuts
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
          this.selectTool('brush');
          break;
        case 'p':
          this.selectTool('flowPen');
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
}
