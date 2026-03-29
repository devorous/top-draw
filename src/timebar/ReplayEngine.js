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
    this.layerManager.onNeedsUpdate = () => {
      if (this._onLayerUpdate) this._onLayerUpdate();
    };

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

  endStroke(user, extraProps = {}) {
    // Blur/glitch blur tools always create their stroke on layer 0
    const isBlurFilter = extraProps.filterType === 'blur' || extraProps.filterType === 'glitchBlur';
    const activeLayer = isBlurFilter ? 0 : (user?.activeLayer ?? 0);
    const userId = user?.id ?? 0;
    this.layerManager.commitUserStroke(activeLayer, userId, extraProps);
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

  getLayerContext(layerIndex, userId, createBlendMode = 'source-over') {
    return this.layerManager?.getLayerContext(layerIndex, userId, createBlendMode) ?? this.mainCtx;
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

  // Compositing — no-op during action processing.
  // The real composite is driven by _compositeOutput() after all actions finish,
  // which ensures the snapshot is in place so blur filters have source content.
  compositeAllLayers() {}

  // Called by _compositeOutput when the snapshot base is ready.
  _doComposite() {
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

    /** @type {Map<string, Object>} Cache for pattern brush images */
    this._patternCache = new Map();

    /** @type {HTMLCanvasElement} Holds loaded snapshot image */
    this._snapshotCanvas = null;
    this._snapshotCtx = null;

    /** @type {Function|null} Called when async operations (blur worker) update the output */
    this.onOutputUpdate = null;
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

    // Set localUserId to a non-matching value so all glitchBlur strokes are
    // treated as "remote" and wait for GLITCH_RESULT instead of computing WASM
    this._replayBoard.layerManager.localUserId = -9999;

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
      1 // Set color alpha to 1, use user.opacity for the actual transparency
    ];
    const botOpacity = color[3] > 1 ? color[3] / 255 : color[3];

    const bot = new User(id, {
      username: state.username || `User ${id}`,
      role: state.role ?? 0,
      x: state.x || 0,
      y: state.y || 0,
      color: normalizedColor,
      opacity: botOpacity,
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
  async processActions(actions, upToTimestamp = Infinity) {
    // Bake the snapshot into layer 0's flatCanvas BEFORE action processing
    // so that: (a) tools that read pixels (CircleBlur) can sample from mainCtx,
    // (b) overflow strokes baked during processing are drawn ON TOP of the snapshot
    //     rather than being wiped when _compositeOutput runs.
    if (this._snapshotCanvas) {
      const layer0 = this._replayBoard.layerManager.layerGroups[0];
      if (layer0) {
        if (!layer0.flatCanvas) {
          layer0.flatCanvas = document.createElement('canvas');
          layer0.flatCanvas.width = this.width;
          layer0.flatCanvas.height = this.height;
          layer0.flatCtx = layer0.flatCanvas.getContext('2d');
        }
        layer0.flatCtx.clearRect(0, 0, this.width, this.height);
        layer0.flatCtx.drawImage(this._snapshotCanvas, 0, 0);
      }
      // Also populate mainCtx so pixel-sampling tools work during processing
      this._replayBoard.mainCtx.drawImage(this._snapshotCanvas, 0, 0);
    }

    // Pre-load all brush images before processing actions so that
    // imageBrush stamps don't execute before the Image objects are ready.
    // Also pre-load glitch result images for deterministic replay.
    await Promise.all([
      this._preloadBrushImages(actions, upToTimestamp),
      this._preloadPatternImages(actions, upToTimestamp),
      this._preloadGlitchResults(actions, upToTimestamp)
    ]);

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;

      // Force a composite update BEFORE any sampling tool (like circleBlur)
      // processes its stamps, otherwise it will sample from a stale or empty mainCtx.
      const msg = action.msg;
      if (msg && msg.u != null && (msg.t === T.MD || msg.t === T.MM)) {
        const user = this._getOrCreateBot(msg.u);
        if (user.tool === 'circleBlur' || user.tool === 'inkdropper' || user.tool === 'fill') {
          this._replayBoard._doComposite();
        }
      }

      this._processAction(action.msg);
    }

    // Composite the final result
    this._compositeOutput();
  }

  /**
   * Internal helper to ensure a value is a standard array of numbers.
   * Handles cases where TypedArrays might have been serialized to JSON as objects.
   * @param {*} val - Value to check
   * @returns {number[]}
   * @private
   */
  _ensureArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    
    // Check for typed array or object-like serialization: {"0": 1, "1": 2}
    if (typeof val === 'object') {
      const keys = Object.keys(val).filter(k => !isNaN(k));
      if (keys.length > 0) {
        const arr = new Array(keys.length);
        for (const k of keys) {
          arr[parseInt(k, 10)] = Number(val[k]);
        }
        return arr;
      }
      
      // Handle TypedArrays directly if they aren't standard arrays
      if (val.length !== undefined) {
        return Array.from(val);
      }
    }
    return [Number(val)];
  }

  /**
   * Process a single action message (already decoded JSON).
   * Routes drawing actions through the real RemoteUserHandler.
   * @private
   */
  _processAction(msg) {
    if (!msg) return;

    const userId = msg.u;
    if (userId == null) return;

    const user = this._getOrCreateBot(userId);

    try {
      switch (msg.t) {
        case T.MD:
          this._remoteHandler.handleMouseDown(user, { 
            ps: this._ensureArray(msg.ps), 
            rs: this._ensureArray(msg.rs) 
          });
          break;

        case T.MM:
          this._remoteHandler.handleMouseMove(user, { 
            ps: this._ensureArray(msg.ps), 
            rs: this._ensureArray(msg.rs) 
          });
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
              (c >>> 24) & 0xFF,
              (c >>> 16) & 0xFF,
              (c >>> 8) & 0xFF,
              1 // Set color alpha to 1, use user.opacity for the actual transparency
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
          if (msg.ps && msg.ps.length >= 2) {
            user.setPosition(msg.ps[0], msg.ps[1]);
            this._remoteHandler.handleFloodFill(user, msg.ps[0], msg.ps[1], msg.c, msg.ly);
          }
          break;

        case T.GMP:
          // Brush images were pre-loaded into _brushCache by _preloadBrushImages().
          // Apply the cached brush to the user synchronously.
          if (msg.g) {
            const brushKey = typeof msg.g === 'string' ? msg.g : JSON.stringify(msg.g);
            const cached = this._brushCache?.get(brushKey);
            if (cached) {
              user.imageBrush = cached;
            }
          }
          break;

        case T.GPT:
          // Pattern images were pre-loaded into _patternCache by _preloadPatternImages().
          if (msg.pb) {
            const cached = this._patternCache?.get(msg.pb);
            if (cached) {
              user.patternBrush = cached;
              this._remoteHandler.handlePatternBrushLoad(user, msg.pb);
            }
          }
          break;

        case T.GLITCH_RESULT:
          // Glitch result images were pre-loaded into _glitchResultCache by _preloadGlitchResults().
          // Apply the cached result to the user's most recent glitchBlur stroke.
          if (msg.g) {
            const glitchKey = `${userId}_${msg.sx}_${msg.sy}_${msg.sw}_${msg.sh}`;
            const cached = this._glitchResultCache?.get(glitchKey);
            console.log('[ReplayEngine] GLITCH_RESULT:', { userId, bounds: { x: msg.sx, y: msg.sy, w: msg.sw, h: msg.sh }, hasCached: !!cached });
            if (cached) {
              const bounds = { x: Number(msg.sx), y: Number(msg.sy), width: Number(msg.sw), height: Number(msg.sh) };
              this._replayBoard.layerManager?.applyRemoteGlitchResult(userId, cached, bounds);
            }
          }
          break;

        case T.SEL_START:
          this._remoteHandler.selectionHandler.handleSelectionStart(user, { x: msg.x, y: msg.y });
          break;
        case T.SEL_UPDATE:
          this._remoteHandler.selectionHandler.handleSelectionUpdate(user, { x: msg.x, y: msg.y });
          break;
        case T.SEL_END:
          this._remoteHandler.selectionHandler.handleSelectionEnd(user);
          break;
        case T.SEL_MOVE:
          this._remoteHandler.selectionHandler.handleSelectionMove(user, { x: msg.x, y: msg.y });
          break;
        case T.SEL_PASTE:
          this._remoteHandler.selectionHandler.handleSelectionPaste(user);
          break;
        case T.SEL_CLEAR:
          this._remoteHandler.selectionHandler.handleSelectionClear(user);
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
    if (!this.outputCtx) return;

    //    Composite all layers (background + snapshot base + strokes + filters)
    //    into the replay board's mainCtx. Blur filters will now read from
    //    mainCtx which contains the snapshot content beneath them.
    this._replayBoard._doComposite();

    //    Render everything to the output canvas
    this._renderToOutput();

    //    Set up callback so that when async blur worker finishes,
    //    we re-composite and update the replay canvas automatically.
    //    We check needsComposite to avoid infinite loops if nothing changed.
    this._replayBoard._onLayerUpdate = () => {
      if (this._replayBoard.layerManager?.needsComposite) {
        this._replayBoard._doComposite();
        this._renderToOutput();
        // Notify TimeMachine to refresh the visible replay canvas
        if (this.onOutputUpdate) this.onOutputUpdate();
      }
    };
  }

  /**
   * Internal helper to draw the current board state and user previews to the output canvas.
   * @private
   */
  _renderToOutput() {
    const ctx = this.outputCtx;
    if (!ctx) return;

    //  Copy the fully composited result (snapshot base + strokes + filters)
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this._replayBoard.mainCanvas, 0, 0);

    //  Draw the replay board's topCanvas (pixel brush preview, etc.)
    if (this._replayBoard.topCanvas) {
      ctx.drawImage(this._replayBoard.topCanvas, 0, 0);
    }

    //  Draw per-user preview canvases (in-progress strokes / shape previews)
    for (const user of this.botUsers.values()) {
      if (user.board) {
        const blendMode = user.blendMode || 'source-over';
        ctx.save();
        
        // Handle CSS filter for blur tools to avoid showing raw mask stamps
        if (user.tool === 'blur' || user.tool === 'glitchBlur') {
          const radius = user.blurRadius || 5;
          ctx.filter = `blur(${radius * 0.5}px)`;
        }

        if (user.board.style?.mixBlendMode && user.board.style.mixBlendMode !== 'normal') {
          ctx.globalCompositeOperation = user.board.style.mixBlendMode;
        } else {
          ctx.globalCompositeOperation = blendMode === 'source-over' ? 'source-over' : blendMode;
        }
        
        ctx.drawImage(user.board, 0, 0);
        ctx.restore();
      }
    }

    // 4. Draw the snapshot's top canvas overlay (active strokes at snapshot time)
    if (this.topCanvas) {
      ctx.drawImage(this.topCanvas, 0, 0);
    }
  }

  /**
   * Clear cached blur results from all stroke stacks so they are
   * re-computed against the current canvas content on the next composite.
   * @private
   */
  _clearBlurCaches() {
    const lm = this._replayBoard?.layerManager;
    if (!lm) return;
    for (const group of lm.layerGroups) {
      for (const stroke of group.strokeStack) {
        if (stroke.filterType) {
          delete stroke._cachedBlurResult;
          delete stroke._cachedPreview;
          delete stroke._isBlurring;
        }
      }
    }
  }

  /**
   * Pre-load all brush images from T.GMP messages into a cache so they
   * can be applied synchronously when the T.GMP action is processed.
   * @param {Array} actions - Actions to scan
   * @param {number} upToTimestamp - Only consider actions up to this time
   * @private
   */
  async _preloadBrushImages(actions, upToTimestamp) {
    this._brushCache = new Map();
    const loadPromises = [];

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.GMP || !action.msg.g) continue;

      const raw = action.msg.g;
      const brushKey = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (this._brushCache.has(brushKey)) continue; // already queued

      const brushData = typeof raw === 'string' ? JSON.parse(raw) : { ...raw };

      if (brushData.type === 'gbr' || brushData.type === 'image') {
        // Reserve slot immediately so duplicates are skipped
        this._brushCache.set(brushKey, null);
        loadPromises.push(new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            brushData.image = image;
            this._brushCache.set(brushKey, brushData);
            resolve();
          };
          image.onerror = () => resolve();
          image.src = brushData.gimpUrl;
        }));
      } else if (brushData.type === 'gih' && brushData.gBrushes?.length > 0) {
        this._brushCache.set(brushKey, null);
        loadPromises.push(new Promise((resolve) => {
          let loadedCount = 0;
          const totalImages = brushData.gBrushes.length;
          const images = brushData.gBrushes.map((brush) => {
            const img = new Image();
            img.onload = () => {
              loadedCount++;
              if (loadedCount === totalImages) {
                brushData.images = images;
                brushData.index = 0;
                brushData.ncells = images.length;
                if (!brushData.cellwidth && brushData.gBrushes[0]) {
                  brushData.cellwidth = brushData.gBrushes[0].width || 32;
                  brushData.cellheight = brushData.gBrushes[0].height || 32;
                }
                if (brushData.dimensions?.length > 0) {
                  for (const dim of brushData.dimensions) {
                    dim.currentIndex = 0;
                  }
                  brushData.getNextBrush = function(context) {
                    let idx = 0;
                    for (const dim of this.dimensions) {
                      idx = dim.currentIndex;
                      dim.currentIndex = (dim.currentIndex + 1) % (dim.size || this.ncells);
                    }
                    return { brush: this.gBrushes[idx], index: idx };
                  };
                  brushData.reset = function() {
                    for (const dim of this.dimensions) dim.currentIndex = 0;
                  };
                }
                this._brushCache.set(brushKey, brushData);
                resolve();
              }
            };
            img.onerror = () => {
              loadedCount++;
              if (loadedCount === totalImages) resolve();
            };
            img.src = brush.gimpUrl;
            return img;
          });
        }));
      }
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  /**
   * Pre-load all pattern images from T.GPT messages.
   * @param {Array} actions - Actions to scan
   * @param {number} upToTimestamp - Only consider actions up to this time
   * @private
   */
  async _preloadPatternImages(actions, upToTimestamp) {
    this._patternCache = new Map();
    const loadPromises = [];

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.GPT || !action.msg.pb) continue;

      const patternDataStr = action.msg.pb;
      if (this._patternCache.has(patternDataStr)) continue;

      let patternData;
      try {
        patternData = JSON.parse(patternDataStr);
      } catch (e) {
        continue;
      }

      if (patternData.url) {
        this._patternCache.set(patternDataStr, null);
        loadPromises.push(new Promise((resolve) => {
          const image = new Image();
          image.onload = () => {
            patternData.image = image;
            this._patternCache.set(patternDataStr, patternData);
            resolve();
          };
          image.onerror = () => resolve();
          image.src = patternData.url;
        }));
      }
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  /**
   * Pre-load all glitch result images from T.GLITCH_RESULT messages into a cache
   * so they can be applied synchronously when the action is processed.
   * @param {Array} actions - Actions to scan
   * @param {number} upToTimestamp - Only consider actions up to this time
   * @private
   */
  async _preloadGlitchResults(actions, upToTimestamp) {
    this._glitchResultCache = new Map();
    const loadPromises = [];
    let glitchResultCount = 0;

    for (const action of actions) {
      if (action.timestamp > upToTimestamp) break;
      if (action.msg?.t !== T.GLITCH_RESULT || !action.msg.g) continue;

      glitchResultCount++;
      const msg = action.msg;
      const glitchKey = `${msg.u}_${msg.sx}_${msg.sy}_${msg.sw}_${msg.sh}`;
      if (this._glitchResultCache.has(glitchKey)) continue;

      // Reserve slot immediately so duplicates are skipped
      this._glitchResultCache.set(glitchKey, null);

      loadPromises.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          // Convert to canvas for use as _cachedBlurResult
          const canvas = document.createElement('canvas');
          canvas.width = msg.sw;
          canvas.height = msg.sh;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, msg.sw, msg.sh);
          this._glitchResultCache.set(glitchKey, canvas);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = msg.g;
      }));
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }

    console.log('[ReplayEngine] Pre-loaded glitch results:', glitchResultCount, 'unique:', this._glitchResultCache.size);
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
