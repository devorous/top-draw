/**
 * @fileoverview ReplayEngine - Accurate timeline playback using the real RemoteUserHandler.
 * Routes recorded actions through the same code path as live remote users,
 * ensuring pixel-perfect replay of all tools.
 */

import { User } from '../User.js';
import { T, ToolNames } from '../../shared/MessageTypes.js';
import { RemoteUserHandler } from '../remote/RemoteUserHandler.js';
import { LayerManager } from '../canvas/LayerManager.js';
import { ToolManager } from '../tools/Tools.js';

/**
 * Minimal board facade backed by a real LayerManager.
 * Provides the interface that RemoteUserHandler, RemotePenHandler,
 * RemoteInkHandler, and tool instances expect from Board.
 */
class ReplayBoard {
  constructor(width, height) {
    this.dimensions = [height, width];
    this.mirror = false;
    this.backgroundColor = [255, 255, 255, 1];

    // Real offscreen canvases
    this.mainCanvas = document.createElement('canvas');
    this.mainCanvas.width = width;
    this.mainCanvas.height = height;
    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true });

    this.topCanvas = document.createElement('canvas');
    this.topCanvas.width = width;
    this.topCanvas.height = height;
    this.topCtx = this.topCanvas.getContext('2d');

    this.upperLayersCanvas = document.createElement('canvas');
    this.upperLayersCanvas.width = width;
    this.upperLayersCanvas.height = height;
    this.upperLayersCtx = this.upperLayersCanvas.getContext('2d');

    // Real LayerManager for stroke management
    this.layerManager = new LayerManager(width, height);
    this.layerManager.onNeedsUpdate = () => {}; // no-op

    // Stub tile tracking (not needed for replay)
    this.tileGrid = {
      isDirty: () => false,
      getDirtyRects: () => [],
      clear: () => {},
      markDirtyPath: () => {}
    };
    this.tileTracker = null;

    this.activeSelectionLayer = -1;
    this.app = null;
    this._needsComposite = false;
    this._dirtyRects = [];

    // Stubs for selection overlay (not needed for replay)
    this.selectionOverlay = null;
    this.selectionCtx = null;
    this.selectionOverlayPadding = 0;
    this.cursorsSvg = null;
    this.mirrorLine = null;
  }

  getWidth() { return this.dimensions[1]; }
  getHeight() { return this.dimensions[0]; }

  setMirror(m) { this.mirror = !!m; }

  // Stroke lifecycle — delegates to real LayerManager
  beginStroke(user, blendModeOverride) {
    if (user?.panning) return;
    const activeLayer = user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    const blendMode = blendModeOverride ?? user?.blendMode ?? 'source-over';
    this.layerManager.beginUserStroke(activeLayer, userId, blendMode);
  }

  beginStrokeAllLayers(user, blendMode) {
    if (user?.panning) return;
    const userId = user?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.layerManager.beginUserStroke(i, userId, blendMode);
    }
  }

  endStroke(user) {
    const activeLayer = user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    this.layerManager.commitUserStroke(activeLayer, userId);
  }

  endStrokeAllLayers(user) {
    const userId = user?.id ?? 0;
    const batchTimestamp = Date.now();
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      this.layerManager.commitUserStroke(i, userId, { eraseAll: true, timestamp: batchTimestamp });
    }
  }

  getAllLayerContexts(userId) {
    const ctxs = [];
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const ctx = this.layerManager.getUserStrokeContext(i, userId);
      if (ctx) ctxs.push(ctx);
    }
    return ctxs;
  }

  getLayerGroup(index) {
    return this.layerManager?.getLayerGroup(index);
  }

  // Dirty rect tracking — must update active stroke bounds or commits get discarded
  expandDirtyRect(user, x, y, width, height) {
    const activeLayer = user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;
    const active = group.activeStrokeByUser.get(userId);
    if (!active?.dirtyRect) return;
    this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
  }

  expandDirtyRectAllLayers(user, x, y, width, height) {
    const userId = user?.id ?? 0;
    const count = this.layerManager.getLayerCount();
    for (let i = 0; i < count; i++) {
      const group = this.layerManager.layerGroups[i];
      if (!group) continue;
      const active = group.activeStrokeByUser.get(userId);
      if (!active?.dirtyRect) continue;
      this.layerManager._expandDirtyRect(active.dirtyRect, x, y, width, height);
    }
  }

  markDirtyPath(user, points, radius) {
    if (!points || points.length === 0) return;
    const activeLayer = user?.activeLayer ?? 0;
    const userId = user?.id ?? 0;
    const group = this.layerManager.layerGroups[activeLayer];
    if (!group) return;
    const active = group.activeStrokeByUser.get(userId);
    if (!active?.dirtyRect) return;
    for (const pt of points) {
      this.layerManager._expandDirtyRect(active.dirtyRect, pt.x - radius, pt.y - radius, radius * 2, radius * 2);
    }
  }

  checkErasedTilesByIndices() {}

  // Compositing — simplified for replay (no split layer logic, no upper layers)
  compositeAllLayers() {
    if (!this.layerManager) return;
    const totalLayers = this.layerManager.getLayerCount();
    this.layerManager.compositeLayerRange(
      this.mainCtx, 0, totalLayers, this.backgroundColor, []
    );
  }

  // requestUpdate is a no-op — we composite manually at the end
  requestUpdate() {}

  // Selection overlay stubs
  clearTop() {
    this.topCtx.clearRect(0, 0, this.getWidth(), this.getHeight());
  }
  clearSelectionOverlay() {}
  getSelectionCtx() { return null; }
  restoreSelectionCtx() {}

  getActiveLayerBlendMode() { return 'source-over'; }
}


/**
 * ReplayEngine provides accurate playback by routing recorded actions
 * through the real RemoteUserHandler, using a real LayerManager and
 * real ToolManager instances for pixel-perfect tool rendering.
 */
export class ReplayEngine {
  constructor() {
    /** @type {Map<number, User>} Bot users keyed by session index */
    this.botUsers = new Map();

    /** @type {HTMLCanvasElement} Main composite output canvas */
    this.outputCanvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.outputCtx = null;

    /** @type {HTMLCanvasElement} Preview/top canvas for active strokes */
    this.topCanvas = null;
    /** @type {CanvasRenderingContext2D} */
    this.topCtx = null;

    /** @type {number} */
    this.width = 0;
    /** @type {number} */
    this.height = 0;

    /** @type {boolean} Mirror mode */
    this.mirror = false;

    /** @type {Array<number>} Background color */
    this.backgroundColor = [255, 255, 255, 1];

    /** @type {Object} Reference to wsClient for decoding */
    this._wsClient = null;

    /** @type {ReplayBoard} */
    this._replayBoard = null;
    /** @type {ToolManager} */
    this._toolManager = null;
    /** @type {RemoteUserHandler} */
    this._remoteHandler = null;
    /** @type {Object} Fake app for RemoteUserHandler */
    this._fakeApp = null;

    /** @type {HTMLCanvasElement} Holds loaded snapshot image */
    this._snapshotCanvas = null;
    this._snapshotCtx = null;
  }

  /**
   * Initialize the replay engine with canvas dimensions.
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @param {Object} wsClient - WebSocket client for message decoding
   */
  init(width, height, wsClient) {
    this.width = width;
    this.height = height;
    this._wsClient = wsClient;

    // Output canvas for final composite
    this.outputCanvas = document.createElement('canvas');
    this.outputCanvas.width = width;
    this.outputCanvas.height = height;
    this.outputCtx = this.outputCanvas.getContext('2d');

    // Top canvas for active stroke preview
    this.topCanvas = document.createElement('canvas');
    this.topCanvas.width = width;
    this.topCanvas.height = height;
    this.topCtx = this.topCanvas.getContext('2d');

    // Snapshot canvas (holds the loaded snapshot image as base)
    this._snapshotCanvas = document.createElement('canvas');
    this._snapshotCanvas.width = width;
    this._snapshotCanvas.height = height;
    this._snapshotCtx = this._snapshotCanvas.getContext('2d');

    this._initReplaySystem();
  }

  /**
   * Build the replay board, tool manager, and remote handler.
   * @private
   */
  _initReplaySystem() {
    // Real board facade with real LayerManager
    this._replayBoard = new ReplayBoard(this.width, this.height);

    // Real ToolManager with all tool instances
    this._toolManager = new ToolManager(this._replayBoard);

    // Stub UI with no-op methods
    const noopUI = {
      updateRemoteCursor: () => {},
      updateRemoteColor: () => {},
      updateRemoteSize: () => {},
      updateRemoteName: () => {},
      updateRemoteToolDisplay: () => {},
      hideRemoteCursor: () => {},
      showRemoteCursor: () => {},
      createRemoteUser: () => {},
      removeRemoteUser: () => {},
      createUserBoard: () => ({ board: document.createElement('canvas'), context: document.createElement('canvas').getContext('2d') }),
      setRemoteTextDomVisible: () => {},
      updateRemoteText: () => {},
      setRemoteUserAfk: () => {},
      updateRemoteUserRank: () => {},
    };

    // Fake app object matching what RemoteUserHandler expects
    this._fakeApp = {
      board: this._replayBoard,
      toolManager: this._toolManager,
      ui: noopUI,
      users: this.botUsers,
      sessionIndex: -9999, // Never matches any real user
      debugOverlay: null,
      self: null,
      blendModeManager: {
        toCSSBlendMode: (bm) => bm || 'normal'
      },
      remoteUserHandler: null, // set below
      connected: false,
      wsClient: null,
      eraseAllLayers: false,
      activeTool: null,
      moderation: null,
      svelteComponents: null,
    };

    // Set board's app reference (needed for compositeAllLayers)
    this._replayBoard.app = this._fakeApp;

    // Real RemoteUserHandler — the same code path as live users
    this._remoteHandler = new RemoteUserHandler(this._fakeApp);
    this._fakeApp.remoteUserHandler = this._remoteHandler;

    // Disable the catchup loop — replay drives all drawing synchronously
    this._remoteHandler.startCatchupLoop = () => {};
    this._remoteHandler.tickCatchup = () => {};
  }

  /**
   * Reset the engine state for a new replay session.
   */
  reset() {
    this.botUsers.clear();
    this.outputCtx?.clearRect(0, 0, this.width, this.height);
    this.topCtx?.clearRect(0, 0, this.width, this.height);
    this._snapshotCtx?.clearRect(0, 0, this.width, this.height);

    // Reinitialize the replay system for a clean slate
    this._initReplaySystem();
  }

  /**
   * Load a snapshot as the base state.
   * @param {Object} snapshot - Snapshot object with canvas data and user states
   * @returns {Promise<void>}
   */
  async loadSnapshot(snapshot) {
    this.reset();

    // Load the snapshot's composited canvas image to the snapshot canvas
    if (snapshot.canvasData) {
      await this._loadImageToCanvas(this._snapshotCtx, snapshot.canvasData);
    }

    // Also load the top canvas (active strokes at snapshot time)
    if (snapshot.topCanvasData) {
      await this._loadImageToCanvas(this.topCtx, snapshot.topCanvasData);
    }

    // Create bot users from snapshot's user drawing states
    const userStates = snapshot.appState?.userDrawingStates || {};
    for (const [idStr, state] of Object.entries(userStates)) {
      this._createBotUser(Number(idStr), state);
    }
  }

  /**
   * Load an image onto a canvas context.
   * @private
   */
  _loadImageToCanvas(ctx, dataUrl) {
    return new Promise((resolve) => {
      if (!dataUrl || !ctx) {
        resolve();
        return;
      }
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = dataUrl;
    });
  }

  /**
   * Create or update a bot user with the given state.
   * Creates a full User object with per-user preview canvas, just like real remote users.
   * @private
   */
  _createBotUser(id, state = {}) {
    const color = state.color || [0, 0, 0, 255];
    // Normalize color alpha to 0-1 range if needed
    const normalizedColor = [
      color[0],
      color[1],
      color[2],
      color[3] > 1 ? color[3] / 255 : color[3]
    ];

    const bot = new User(id, {
      username: state.username || `User ${id}`,
      role: state.role ?? 0,
      x: state.x || 0,
      y: state.y || 0,
      color: normalizedColor,
      opacity: normalizedColor[3],
      size: state.size || 10,
      tool: state.tool || 'brush',
      pressure: state.pressure ?? 1,
      thinning: state.thinning ?? 0.5,
      simulatePressure: state.simulatePressure ?? true,
      blendMode: state.blendMode || 'source-over',
      activeLayer: state.activeLayer ?? 2,
      spacing: state.spacing ?? 0,
      smoothing: state.smoothing ?? 15,
      hardness: state.hardness ?? 100
    });

    // Per-user preview canvas — same as what UI.createUserBoard provides
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = this.width;
    previewCanvas.height = this.height;
    bot.board = previewCanvas;
    bot.context = previewCanvas.getContext('2d');

    // Initialize smoothBuffer for handlers
    bot.smoothBuffer = { x: 0, y: 0, isFirst: true };

    this.botUsers.set(id, bot);
    return bot;
  }

  /**
   * Get or create a bot user.
   * @private
   */
  _getOrCreateBot(id) {
    if (!this.botUsers.has(id)) {
      this._createBotUser(id);
    }
    return this.botUsers.get(id);
  }

  /**
   * Process a batch of actions.
   * @param {Array<{timestamp: number, msg: Object}>} actions - Actions to replay (JSON messages)
   * @param {number} [upToTimestamp] - Only process actions up to this timestamp
   */
  processActions(actions, upToTimestamp = Infinity) {
    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      this._processAction(action.msg);
    }

    // Composite the final result
    this._compositeOutput();
  }

  /**
   * Process a single action message (already decoded JSON).
   * Routes drawing actions through the real RemoteUserHandler.
   * @private
   */
  _processAction(msg) {
    if (!msg) return;

    const userId = msg.u;
    if (userId === undefined) return;

    const user = this._getOrCreateBot(userId);

    try {
      switch (msg.t) {
        case T.MD:
          this._remoteHandler.handleMouseDown(user, { ps: msg.ps || [], rs: msg.rs || [] });
          break;

        case T.MM:
          this._remoteHandler.handleMouseMove(user, { ps: msg.ps || [], rs: msg.rs || [] });
          break;

        case T.MU:
          this._remoteHandler.handleMouseUp(user);
          break;

        case T.CT:
          if (msg.l !== undefined) {
            const newTool = ToolNames[msg.l] || 'brush';
            user.setTool(newTool);
          }
          if (msg.a !== undefined) {
            user.eraseAllLayers = msg.a;
          }
          break;

        case T.CC:
          if (msg.c !== undefined) {
            const c = msg.c;
            user.setColor([
              (c >> 24) & 0xFF,
              (c >> 16) & 0xFF,
              (c >> 8) & 0xFF,
              ((c & 0xFF) / 255)
            ]);
            user.setOpacity((c & 0xFF) / 255);
          }
          break;

        case T.CS:
          if (msg.s !== undefined) {
            user.setSize(msg.s / 100);
          }
          break;

        case T.CP:
          if (msg.p !== undefined) {
            user.setPressure((msg.p ?? 100) / 100);
          }
          break;

        case T.CSP:
          if (msg.sp !== undefined) {
            user.setSpacing(msg.sp);
          }
          break;

        case T.CSM:
          if (msg.sm !== undefined) {
            user.setSmoothing(msg.sm);
          }
          break;

        case T.CHD:
          if (msg.hd !== undefined) {
            user.setHardness(msg.hd);
          }
          break;

        case T.CTHN:
          if (msg.th !== undefined) {
            user.setThinning((msg.th - 1) / 100);
          }
          break;

        case T.CSIM:
          if (msg.sim !== undefined) {
            user.setSimulatePressure(msg.sim === 2);
          }
          break;

        case T.CBM:
          if (msg.bm !== undefined) {
            user.setBlendMode(msg.bm);
          }
          break;

        case T.CL:
          if (msg.ly !== undefined) {
            user.setActiveLayer(msg.ly);
          }
          break;

        case T.CBR:
          if (msg.br !== undefined) {
            user.setBlurRadius(msg.br);
          }
          break;

        case T.MIR:
          this.mirror = !this.mirror;
          this._replayBoard.mirror = this.mirror;
          break;

        case T.CLR:
          // Clear all layers in the replay LayerManager
          this._replayBoard.layerManager.clearAll();
          this._snapshotCtx?.clearRect(0, 0, this.width, this.height);
          break;

        case T.CANCEL:
          // Cancel current stroke — clean up user state
          if (user.mousedown) {
            user.mousedown = false;
            user.clearLine();
            user._inkStrokeActive = false;
            user._penStrokeActive = false;
            user.startPos = null;
            // Discard the active stroke for this user
            const lm = this._replayBoard.layerManager;
            if (user.eraseAllLayers) {
              const count = lm.getLayerCount();
              for (let i = 0; i < count; i++) {
                lm.cancelUserStroke?.(i, user.id);
              }
            } else {
              lm.cancelUserStroke?.(user.activeLayer, user.id);
            }
          }
          break;

        case T.KP:
          if (msg.k !== undefined) {
            this._remoteHandler.handleKeyPress(user, msg.k);
          }
          break;

        case T.FILL:
          // Flood fill — update position; actual pixels are in the snapshot
          if (msg.ps && msg.ps.length >= 2) {
            user.setPosition(msg.ps[0], msg.ps[1]);
          }
          break;
      }
    } catch (err) {
      console.warn(`[ReplayEngine] Error processing action t=${msg.t} for user ${userId}:`, err);
    }
  }

  /**
   * Composite the final output: snapshot + LayerManager strokes + per-user previews.
   * @private
   */
  _compositeOutput() {
    const ctx = this.outputCtx;
    if (!ctx) return;

    // 1. Clear output
    ctx.clearRect(0, 0, this.width, this.height);

    // 2. Draw background color
    const [r, g, b, a] = this._replayBoard.backgroundColor;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    ctx.fillRect(0, 0, this.width, this.height);

    // 3. Draw the snapshot (base state before replayed actions)
    if (this._snapshotCanvas) {
      ctx.drawImage(this._snapshotCanvas, 0, 0);
    }

    // 4. Composite LayerManager strokes on top (these are the replayed actions)
    //    Use a temporary canvas so we can layer it properly
    this._replayBoard.compositeAllLayers();
    // The board's mainCtx now has background + all strokes composited.
    // But we already drew the snapshot as background, so we need just the strokes.
    // Composite the board output with transparent background to get only strokes.
    const strokeCanvas = document.createElement('canvas');
    strokeCanvas.width = this.width;
    strokeCanvas.height = this.height;
    const strokeCtx = strokeCanvas.getContext('2d');
    this._replayBoard.layerManager.compositeLayerRange(
      strokeCtx, 0, this._replayBoard.layerManager.getLayerCount(), null, []
    );
    ctx.drawImage(strokeCanvas, 0, 0);

    // 5. Draw the replay board's topCanvas (pixel brush preview, etc.)
    if (this._replayBoard.topCanvas) {
      ctx.drawImage(this._replayBoard.topCanvas, 0, 0);
    }

    // 6. Draw per-user preview canvases (in-progress strokes / shape previews)
    for (const user of this.botUsers.values()) {
      if (user.board) {
        const blendMode = user.blendMode || 'source-over';
        ctx.save();
        if (user.board.style?.mixBlendMode) {
          ctx.globalCompositeOperation = user.board.style.mixBlendMode;
        } else {
          ctx.globalCompositeOperation = blendMode === 'source-over' ? 'source-over' : blendMode;
        }
        ctx.drawImage(user.board, 0, 0);
        ctx.restore();
      }
    }

    // 7. Draw the snapshot's top canvas overlay (active strokes at snapshot time)
    if (this.topCanvas) {
      ctx.drawImage(this.topCanvas, 0, 0);
    }
  }

  /**
   * Get the current replay state as a data URL.
   * @returns {string} Data URL of composited canvas
   */
  getPreviewDataUrl() {
    return this.outputCanvas.toDataURL('image/png');
  }

  /**
   * Get width.
   * @returns {number}
   */
  getWidth() {
    return this.width;
  }

  /**
   * Get height.
   * @returns {number}
   */
  getHeight() {
    return this.height;
  }
}
