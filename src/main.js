/**
 * Top-Draw Application Entry Point
 * Bootstraps and wires together all modules
 */

import { stateManager } from './state/StateManager.js';
import { createLocalUserState } from './state/UserState.js';
import { WebSocketClient } from './network/WebSocketClient.js';
import { MessageHandler } from './network/MessageHandler.js';
import { MessageType } from './network/Protocol.js';
import { CanvasManager } from './canvas/CanvasManager.js';
import { DrawingEngine } from './canvas/DrawingEngine.js';
import { ToolManager } from './tools/ToolManager.js';
import { UIManager } from './ui/UIManager.js';
import { ChatManager } from './ui/ChatManager.js';
import { CursorManager } from './ui/CursorManager.js';
import { UserListManager } from './ui/UserListManager.js';
import { ViewportManager } from './viewport/ViewportManager.js';

class TopDrawApp {
  #stateManager = stateManager;
  #wsClient = null;
  #messageHandler = null;
  #canvasManager = null;
  #drawingEngine = null;
  #toolManager = null;
  #uiManager = null;
  #chatManager = null;
  #cursorManager = null;
  #userListManager = null;
  #viewportManager = null;

  constructor() {
    // Generate user ID
    const userID = Math.floor(Math.random() * 9999999);
    this.#stateManager.set('userID', userID);
  }

  /**
   * Initialize the application
   */
  async init() {
    console.log('Initializing Top-Draw...');

    // Wait for DOM
    await this.#waitForDOM();

    // Initialize canvas
    this.#canvasManager = new CanvasManager([1920, 2160]);
    this.#canvasManager.init();

    // Initialize drawing engine
    this.#drawingEngine = new DrawingEngine(this.#canvasManager);

    // Initialize WebSocket
    const userID = this.#stateManager.get('userID');
    this.#wsClient = new WebSocketClient(userID);

    // Initialize tool manager
    this.#toolManager = new ToolManager(
      this.#stateManager,
      this.#canvasManager,
      this.#drawingEngine,
      this.#wsClient
    );

    // Initialize UI managers
    this.#chatManager = new ChatManager(this.#stateManager, this.#wsClient);
    this.#cursorManager = new CursorManager(this.#stateManager, this.#wsClient, this.#canvasManager);
    this.#userListManager = new UserListManager(this.#stateManager);
    this.#uiManager = new UIManager(
      this.#stateManager,
      this.#toolManager,
      this.#wsClient,
      this.#canvasManager
    );

    // Initialize viewport
    this.#viewportManager = new ViewportManager(
      this.#stateManager,
      this.#wsClient,
      this.#canvasManager
    );

    // Initialize message handler
    this.#messageHandler = new MessageHandler(this.#stateManager);

    // Initialize all components
    this.#chatManager.init();
    this.#cursorManager.init();
    this.#userListManager.init();
    this.#uiManager.init();
    this.#viewportManager.init();

    // Setup event handlers
    this.#setupCanvasEvents();
    this.#setupKeyboardEvents();
    this.#setupWebSocketEvents();
    this.#setupMessageHandlers();
    this.#setupJoinHandler();

    // Create local user state
    this.#createLocalUser();

    console.log('Top-Draw initialized!');
  }

  #waitForDOM() {
    return new Promise(resolve => {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', resolve);
      } else {
        resolve();
      }
    });
  }

  #createLocalUser() {
    const userID = this.#stateManager.get('userID');
    const localUser = createLocalUserState(
      userID,
      this.#canvasManager.topCtx,
      this.#canvasManager.mainCanvas
    );

    this.#stateManager.set('localUser', localUser);
    this.#stateManager.addUser(localUser);

    // Set initial username display
    const userlistName = document.querySelector('.listUser.self');
    if (userlistName) {
      userlistName.textContent = userID.toString();
    }
  }

  #setupCanvasEvents() {
    const board = this.#canvasManager.mainCanvas;

    board.addEventListener('pointermove', (e) => {
      const user = this.#stateManager.get('localUser');
      if (!user) return;

      // Handle pen pressure
      if (e.pointerType === 'pen' && !user.panning) {
        const maxPressure = user.maxPressure || 1;
        const pressure = Math.min(maxPressure, Math.round(e.pressure * 100) / 100);

        if (pressure !== user.prevpressure && user.mousedown && user.tool === 'brush') {
          user.pressure = pressure;
          this.#wsClient.broadcast(MessageType.USER_PRESSURE, { pressure });

          // Notify brush tool of pressure change
          const brushTool = this.#toolManager.getTool('brush');
          if (brushTool) {
            brushTool.handlePressureChange(pressure);
          }
        }
        user.prevpressure = pressure;
      }

      // Update cursor position
      this.#cursorManager.updateLocalPosition(e.offsetX, e.offsetY);

      // Handle panning
      if (user.panning && user.mousedown) {
        this.#viewportManager.handlePan(e);
      } else {
        // Tool handling
        this.#toolManager.handlePointerMove(e);
      }

      user.lastx = user.x;
      user.lasty = user.y;
    });

    board.addEventListener('pointerdown', (e) => {
      const user = this.#stateManager.get('localUser');
      if (!user) return;

      if (e.pointerType === 'mouse') {
        user.pressure = 1;
        user.prevpressure = 1;
        this.#wsClient.broadcast(MessageType.USER_PRESSURE, { pressure: 1 });
      }

      user.mousedown = true;
      this.#toolManager.handlePointerDown(e);
    });

    board.addEventListener('pointerup', (e) => {
      const user = this.#stateManager.get('localUser');
      if (!user) return;

      user.mousedown = false;
      this.#toolManager.handlePointerUp(e);
    });

    board.addEventListener('pointerout', (e) => {
      this.#toolManager.handlePointerOut(e);
    });

    board.addEventListener('wheel', (e) => {
      e.preventDefault();
      const user = this.#stateManager.get('localUser');
      if (!user) return;

      if (user.panning) {
        this.#viewportManager.handleWheel(e);
      } else {
        this.#uiManager.handleWheelSize(e);
      }
    });
  }

  #setupKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      const user = this.#stateManager.get('localUser');
      if (!user) return;

      // Prevent quick search
      if (e.key === '/' || e.key === "'") {
        e.preventDefault();
      }

      // Space for panning
      if (e.key === ' ' && user.tool !== 'text' && !user.panning && !user.mousedown) {
        this.#viewportManager.startPanning();
      }

      // Broadcast keypress
      this.#wsClient.broadcast(MessageType.TEXT_INPUT, { key: e.key });

      // Tool-specific handling
      this.#toolManager.handleKeyDown(e);
    });

    document.addEventListener('keyup', (e) => {
      const user = this.#stateManager.get('localUser');
      if (!user) return;

      if (e.key === ' ' && user.tool !== 'text') {
        this.#viewportManager.stopPanning();
      }

      this.#toolManager.handleKeyUp(e);
    });
  }

  #setupWebSocketEvents() {
    this.#wsClient.addEventListener('open', () => {
      console.log('WebSocket connected!');
      document.getElementById('login')?.style.setProperty('display', 'block');
      document.getElementById('connecting')?.style.setProperty('display', 'none');
    });

    this.#wsClient.addEventListener('message', (e) => {
      this.#messageHandler.handle(e.detail);
    });

    this.#wsClient.addEventListener('close', () => {
      console.log('WebSocket disconnected');
    });

    this.#wsClient.addEventListener('reconnectFailed', () => {
      console.error('Failed to reconnect to server');
    });
  }

  #setupMessageHandlers() {
    // User join/leave
    this.#messageHandler.on('currentUsers', (data) => {
      const localUserId = this.#stateManager.get('userID');

      for (const userData of data.users) {
        if (userData.id !== localUserId) {
          const existingUser = this.#stateManager.getUser(userData.id);
          if (!existingUser) {
            // Add user to state
            this.#stateManager.addUser(userData.userdata);

            // Create cursor and board for user
            this.#cursorManager.createUserCursor(userData.userdata);
            this.#canvasManager.createUserBoard(userData.id);
            this.#userListManager.addUser(userData.userdata);

            console.log('User joined:', userData.id);
          }
        }
      }
    });

    this.#messageHandler.on('userLeaving', (data) => {
      const { user, id } = data;
      this.#chatManager.systemMessage(`${user.username || id} has left the room`);
      this.#cursorManager.removeUserCursor(id);
      this.#canvasManager.removeUserBoard(id);
      this.#userListManager.removeUser(id);
    });

    this.#messageHandler.on('boardSettings', (data) => {
      this.#stateManager.set('mirror', data.settings.mirror);

      const mirrorLine = document.querySelector('.mirrorLine');
      const mirrorText = document.querySelector('.mirrorOption');

      if (mirrorLine) {
        mirrorLine.style.display = data.settings.mirror ? 'block' : 'none';
      }
      if (mirrorText) {
        mirrorText.textContent = data.settings.mirror ? 'ON' : 'OFF';
      }
    });

    // Cursor movement
    this.#messageHandler.on(MessageType.CURSOR_MOVE, (data, user) => {
      if (user) {
        this.#cursorManager.updateRemotePosition(data, user);
        this.#toolManager.handleRemotePointerMove(data, user);
      }
    });

    // Pointer events
    this.#messageHandler.on(MessageType.POINTER_DOWN, (data, user) => {
      if (user) {
        this.#toolManager.handleRemotePointerDown(data, user);
      }
    });

    this.#messageHandler.on(MessageType.POINTER_UP, (data, user) => {
      if (user) {
        this.#toolManager.handleRemotePointerUp(data, user);
      }
    });

    // User state changes
    this.#messageHandler.on(MessageType.USER_SIZE, (data, user) => {
      if (user) {
        user.size = data.size;
        this.#cursorManager.updateSize(user, data.size);
      }
    });

    this.#messageHandler.on(MessageType.USER_COLOR, (data, user) => {
      if (user) {
        user.color = data.color;
        this.#cursorManager.updateColor(user, data.color);
        this.#userListManager.updateUser(user.id, { color: data.color });
      }
    });

    this.#messageHandler.on(MessageType.USER_TOOL, (data, user) => {
      if (user) {
        this.#toolManager.handleToolChange(data, user);
        this.#userListManager.updateUser(user.id, { tool: data.tool });
      }
    });

    this.#messageHandler.on(MessageType.USER_NAME, (data, user) => {
      if (user) {
        user.username = data.name;
        this.#chatManager.systemMessage(`${data.name} joined the room`);
        this.#userListManager.updateUser(user.id, { username: data.name });
      }
    });

    this.#messageHandler.on(MessageType.USER_PRESSURE, (data, user) => {
      if (user) {
        user.pressure = data.pressure;
      }
    });

    this.#messageHandler.on(MessageType.USER_PANNING, (data, user) => {
      if (user) {
        user.panning = data.value;
      }
    });

    // Text input
    this.#messageHandler.on(MessageType.TEXT_INPUT, (data, user) => {
      if (user && user.tool === 'text') {
        const textTool = this.#toolManager.getTool('text');
        if (textTool) {
          textTool.handleRemoteKeyDown(data, user);
        }
      }
    });

    // GIMP brush
    this.#messageHandler.on(MessageType.BRUSH_GIMP, async (data, user) => {
      if (user) {
        const gimpTool = this.#toolManager.getTool('gimp');
        if (gimpTool) {
          await gimpTool.handleRemoteBrushData(data, user);
        }
      }
    });

    // Board actions
    this.#messageHandler.on(MessageType.BOARD_CLEAR, () => {
      this.#canvasManager.clearAll();
    });

    this.#messageHandler.on(MessageType.BOARD_MIRROR, () => {
      const mirror = !this.#stateManager.get('mirror');
      this.#stateManager.set('mirror', mirror);

      const mirrorLine = document.querySelector('.mirrorLine');
      const mirrorText = document.querySelector('.mirrorOption');

      if (mirrorLine) {
        mirrorLine.style.display = mirror ? 'block' : 'none';
      }
      if (mirrorText) {
        mirrorText.textContent = mirror ? 'ON' : 'OFF';
      }
    });

    // Chat
    this.#messageHandler.on(MessageType.CHAT_MESSAGE, (data, user) => {
      if (user) {
        this.#chatManager.receiveMessage(data.message, user);
      }
    });
  }

  #setupJoinHandler() {
    const joinBtn = document.getElementById('joinBtn');
    const usernameInput = document.getElementById('usernameInput');

    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        const user = this.#stateManager.get('localUser');
        let name = usernameInput?.value?.trim() || 'Anon';

        user.username = name;
        this.#stateManager.set('connected', true);

        // Hide overlay
        const overlay = document.getElementById('overlay');
        if (overlay) {
          overlay.style.display = 'none';
        }

        // Show cursor
        this.#cursorManager.showLocalCursor();

        // Update displays
        this.#userListManager.updateLocalName(name);

        // Broadcast name
        this.#wsClient.broadcast(MessageType.USER_NAME, { name });
      });
    }
  }

  /**
   * Start the application - connect to server
   */
  start() {
    const localUser = this.#stateManager.get('localUser');
    this.#wsClient.connect(localUser);
  }
}

// Initialize and start the app
const app = new TopDrawApp();
app.init().then(() => {
  app.start();
});

export { app };
