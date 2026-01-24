import { User } from './User.js';
import { Board } from './Board.js';
import { ToolManager, BrushTool } from './Tools.js';
import { WebSocketClient } from './WebSocketClient.js';
import { Chat } from './Chat.js';
import { UI } from './UI.js';
import { BrushGallery } from './BrushGallery.js';
import { RemoteUserHandler } from './RemoteUserHandler.js';
import { TouchHandler } from './TouchHandler.js';
import { setupWebSocketHandlers } from './WebSocketHandlers.js';
import { DebugOverlay } from './sync/index.js';

/**
 * Main application class
 */
export class DrawingApp {
  constructor(options = {}) {
    this.sessionIndex = null;  // Assigned by server on connect
    this.users = new Map();    // sessionIndex -> User
    this.connected = false;

    this.board = new Board({
      dimensions: options.dimensions || [720, 1280]
    });
    this.board.app = this; // Allow tools to access wsClient

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();
    this.chat = new Chat({
      onSend: (message) => this.handleChatSend(message)
    });
    this.brushGallery = new BrushGallery({
      onSelect: (brush) => this.handleBrushSelect(brush)
    });

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

    // Tick system for synchronized drawing (90 TPS = ~11ms)
    this.tickRate = 90;
    this.tickInterval = 1000 / this.tickRate; // ~11.11ms
    this.tickTimer = null;
    this.lastTickTime = 0;

    // Input buffer - stores latest pointer state between ticks
    this.inputBuffer = {
      position: null,      // { x, y } - latest pointer position
      lastPosition: null,  // { x, y } - previous position for interpolation
      pressure: 1,
      pointerType: 'mouse',
      movement: { x: 0, y: 0 }, // accumulated movement for panning
      dirty: false         // whether buffer has new data to process
    };
  }

  async init() {
    this.ui.init();
    this.board.init('#boardContainer');
    this.chat.init();
    this.brushGallery.init();

    this.createSelf();
    this.setupColorPicker();

    // Initialize handlers
    this.remoteUserHandler = new RemoteUserHandler(this);
    this.touchHandler = new TouchHandler(this);

    // Initialize debug overlay for dev mode
    this.debugOverlay = new DebugOverlay();
    const debugCanvas = document.getElementById('debugOverlay');
    console.log('[App] Debug overlay canvas element:', debugCanvas);
    this.debugOverlay.init(debugCanvas, this.board.getWidth(), this.board.getHeight());

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

  setupColorPicker() {
    if (typeof Picker !== 'undefined') {
      this.colorPicker = new Picker({
        parent: this.ui.elements.colorPicker,
        popup: false,
        alpha: true,
        editor: true,
        color: '#000',
        onChange: (color) => {
          this.self.setColor(color.rgba);
          this.ui.updateSelfColor(color.rgba);
          this.ui.updateSelfTextStyle(this.self.size, color.rgba);
          if (this.connected) {
            this.wsClient.broadcastColorChange(color.rgba);
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
    elements.penBtn.addEventListener('click', () => this.selectTool('pen'));
    elements.lineBtn.addEventListener('click', () => this.selectTool('line'));
    elements.rectangleBtn.addEventListener('click', () => this.selectTool('rectangle'));
    elements.circleBtn.addEventListener('click', () => this.selectTool('circle'));
    elements.textBtn.addEventListener('click', () => this.selectTool('text'));
    elements.eraseBtn.addEventListener('click', () => this.selectTool('erase'));
    elements.gimpBtn.addEventListener('click', () => this.selectTool('gimp'));

    elements.clearBtn.addEventListener('click', () => this.handleClear());
    elements.resetBtn.addEventListener('click', () => this.handleResetBoard());
    elements.mirrorBtn.addEventListener('click', () => this.handleToggleMirror());
    elements.devBtn.addEventListener('click', () => this.handleToggleDevMode());
    elements.plusBtn.addEventListener('click', () => this.handleZoomIn());
    elements.minusBtn.addEventListener('click', () => this.handleZoomOut());
    elements.saveBtn.addEventListener('click', () => this.board.saveAsImage());

    elements.chatBtn.addEventListener('click', () => this.chat.toggle());
    elements.chatResetBtn.addEventListener('click', () => this.chat.resetPosition());

    elements.sizeSlider.addEventListener('input', (e) => this.handleSizeChange(e));
    elements.spacingSlider.addEventListener('input', (e) => this.handleSpacingChange(e));
    elements.gimpFileInput.addEventListener('change', (e) => this.handleGimpFileLoad(e));

    elements.board.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    elements.board.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    elements.board.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    elements.board.addEventListener('pointerenter', () => { this.isOnBoard = true; });
    elements.board.addEventListener('pointerleave', (e) => this.handlePointerLeave(e));
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

    // Start the tick loop
    this.startTickLoop();
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

    const { position, lastPosition, pressure, movement } = this.inputBuffer;

    // Handle panning movement
    if (this.self.panning && this.self.mousedown && (movement.x !== 0 || movement.y !== 0)) {
      this.board.pan(movement.x, movement.y);
      this.inputBuffer.movement = { x: 0, y: 0 }; // Reset accumulated movement
    }

    // Process drawing if we have position data
    if (position) {
      const x = position.x;
      const y = position.y;
      const lastX = lastPosition ? lastPosition.x : x;
      const lastY = lastPosition ? lastPosition.y : y;

      // Update self position
      this.self.setPosition(x, y);
      this.ui.updateSelfCursor(x, y, this.self.size);

      // Broadcast position
      this.wsClient.broadcastMouseMove(x, y, lastX, lastY);

      // Process tool input if drawing
      if (this.self.mousedown && !this.self.panning) {
        const tool = this.toolManager.getCurrentTool();
        if (tool) {
          tool.onPointerMove(this.self, { x, y }, { x: lastX, y: lastY });
        }
      }

      // Update last position for next tick
      this.inputBuffer.lastPosition = { x, y };
    }

    this.inputBuffer.dirty = false;
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
      } else if (this.self.tool === 'pen' && this.self.penPoints && this.self.penPoints.length > 0) {
        const penTool = this.toolManager.getTool('pen');
        penTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      }
      this.self.mousedown = false;
      this.wsClient.broadcastMouseUp();
    }

    this.self.setTool(tool);
    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool);
    this.wsClient.broadcastToolChange(tool);

    // Show/hide brush gallery for gimp tool
    if (tool === 'gimp') {
      this.brushGallery.show();
    } else {
      this.brushGallery.hide();
    }
  }

  handleBrushSelect(brush) {
    // Apply the selected brush to self
    this.self.gBrush = brush;

    // Update the preview image
    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      this.ui.setGimpPreview(brush.gBrushes[0].gimpUrl);
    } else {
      this.ui.setGimpPreview(brush.gimpUrl);
    }

    // Broadcast brush to other users
    this.wsClient.broadcastGimp(brush);
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
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
  }

  handleSpacingChange(e) {
    const spacing = Number(e.target.value);
    this.self.setSpacing(spacing);
    this.wsClient.broadcastSpacingChange(spacing);
  }

  async handleGimpFileLoad(e) {
    const file = e.target.files[0];
    if (!file) return;

    const gimpTool = this.toolManager.getTool('gimp');
    const gimpData = await gimpTool.loadBrush(file, this.self);

    if (gimpData) {
      this.ui.setGimpPreview(gimpData.gimpUrl || gimpData.gBrushes[0].gimpUrl);
      this.wsClient.broadcastGimp(gimpData);
    }
  }

  handleChatSend(message) {
    this.chat.addMessage(message, this.self);
    this.wsClient.broadcastChat(message);
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

    // Buffer the input for tick processing
    this.inputBuffer.position = { x, y };
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

    // Set self position immediately for pointerDown
    this.self.setPosition(pos.x, pos.y);
    this.self.lastx = this.self.x;
    this.self.lasty = this.self.y;
    this.self.mousedown = true;
    this.self.spaceIndex = 0;

    this.wsClient.broadcastMouseDown();

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerDown(this.self, pos, e);

        // If text tool was used to commit text, update UI to clear the text display
        if (this.self.tool === 'text') {
          this.ui.updateSelfTextInput(this.self.text);

          // Focus hidden input for touch keyboard support
          if (e.pointerType === 'touch' && this.ui.elements.touchInput) {
            this.ui.elements.touchInput.focus();
          }
        }
      }

      // Start tracking for debug overlay (pass tool type, brush size, and user info)
      this.debugOverlay.startDrawing(pos.x, pos.y, this.self.tool, this.self.size, this.self.id, this.self.username);
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
    }

    this.self.mousedown = false;
    this.wsClient.broadcastMouseUp();

    // Reset input buffer
    this.inputBuffer.dirty = false;
  }

  handlePointerLeave(e) {
    this.isOnBoard = false;
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
    const penTool = this.toolManager.getTool('pen');
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
          this.selectTool('pen');
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
          this.selectTool('gimp');
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
