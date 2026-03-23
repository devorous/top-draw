/**
 * @fileoverview WebSocket client for real-time communication using Protocol Buffers.
 * Handles connection management, message batching, and binary serialization.
 */

import { T, Tool, ToolNames, ToolToEnum } from '../../shared/MessageTypes.js';
import { packColor, unpackColor } from '../../shared/ColorUtils.js';

/**
 * WebSocketClient manages the bidirectional binary communication with the server.
 * It uses Protocol Buffers for efficient serialization and handles high-frequency
 * message batching to maintain UI performance.
 */
export class WebSocketClient {
  /**
   * @param {Object} [options={}] - Configuration options.
   * @param {Function} [options.onConnect] - Callback for successful connection.
   * @param {Function} [options.onDisconnect] - Callback for disconnection.
   * @param {string} [options.serverUrl] - Optional explicit server URL.
   */
  constructor(options = {}) {
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number|null} */
    this.sessionIndex = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {Map<string, Function>} */
    this.messageHandlers = new Map();
    /** @type {Function|null} */
    this.onConnect = options.onConnect || null;
    /** @type {Function|null} */
    this.onDisconnect = options.onDisconnect || null;
    /** @type {string|null} */
    this.serverUrl = options.serverUrl || null;
    /** @type {Object|null} */
    this.Msg = null;
    /** @type {boolean} */
    this.protoLoaded = false;

    /**
     * @private
     * @type {Array<Object>}
     */
    this._messageQueue = [];
    /**
     * @private
     * @type {boolean}
     */
    this._processingScheduled = false;

    /**
     * @private
     * @type {Set<number>}
     */
    this._batchableMessages = new Set([
      T.MM, T.MD, T.MU, T.CP, T.CS, T.CT, T.CC,
      T.CSP, T.CSM, T.CHD, T.CBR, T.CL, T.CBM, T.CANCEL
    ]);
  }

  /**
   * Lazy-loads the Protocol Buffer schema.
   * @returns {Promise<void>}
   */
  async loadProto() {
    if (this.protoLoaded) return;

    try {
      const protobuf = await import('protobufjs');
      const baseUrl = import.meta.env.BASE_URL || '/';
      const protoUrl = `${baseUrl}messages.proto`.replace('//', '/');
      const root = await protobuf.default.load(protoUrl);
      this.Msg = root.lookupType('Msg');
      this.protoLoaded = true;
      console.log('Protobuf loaded on client');
    } catch (err) {
      console.error('Failed to load protobuf:', err);
      throw err;
    }
  }

  /**
   * Establishes a WebSocket connection to the server.
   *
   * @param {Object} userData - User identification data.
   * @param {string|null} [roomId=null] - The room ID to join.
   * @returns {Promise<void>}
   */
  async connect(userData, roomId = null) {
    await this.loadProto();

    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onopen = null;
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close();
      }
      this.socket = null;
    }
    this.connected = false;
    this.sessionIndex = null;

    this._userData = userData;
    this._roomId = roomId;
    this._connectAttempts = 0;
    this._cancelled = false;

    this._buildUrl();
    this._tryConnect();
  }

  /**
   * Internal helper to construct the WebSocket URL based on environment.
   * @private
   * @returns {void}
   */
  _buildUrl() {
    let baseUrl;
    if (this.serverUrl) {
      baseUrl = this.serverUrl;
    } else {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const currentPort = window.location.port;

      if (currentPort === '3000') {
        baseUrl = `ws://localhost:8000`;
      } else {
        baseUrl = import.meta.env.VITE_WS_SERVER_URL || `${wsProtocol}://${window.location.host}`;
      }
    }

    try {
      const url = new URL(baseUrl);
      if (this._roomId) {
        url.searchParams.set('room', this._roomId);
      }
      this._url = url.toString();
    } catch (err) {
      this._url = baseUrl;
      if (this._roomId) {
        const separator = this._url.includes('?') ? '&' : '?';
        this._url += `${separator}room=${encodeURIComponent(this._roomId)}`;
      }
    }
  }

  /**
   * Initiates the connection attempt and sets up event listeners.
   * @private
   * @returns {void}
   */
  _tryConnect() {
    this._connectAttempts++;
    this.socket = new WebSocket(this._url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = () => {
      this.connected = true;
      this._connectAttempts = 0;
      const username = this._userData.username || this._userData.name || '';
      this.send({ t: T.CONNECT, n: username });
    };

    this.socket.onmessage = (event) => {
      try {
        const raw = new Uint8Array(event.data);
        if (raw.length > 4 && raw[0] !== 0x08) {
          this._decodeBatchedFrame(raw);
        } else {
          const data = this.Msg.decode(raw);
          this.handleMessage(data);
        }
      } catch (err) {
        console.error('Failed to decode message:', err);
      }
    };

    this.socket.onclose = (event) => {
      this.connected = false;
      if (!this._cancelled && this.sessionIndex === null && this._connectAttempts < 10) {
        const delay = Math.min(1000 * this._connectAttempts, 5000);
        setTimeout(() => this._tryConnect(), delay);
        return;
      }

      if (this.onDisconnect) {
        this.onDisconnect(event.code, event.reason);
      }
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  /**
   * Routes incoming messages to batching or immediate processing.
   *
   * @param {Object} data - The decoded message payload.
   * @returns {void}
   */
  handleMessage(data) {
    if (this._batchableMessages.has(data.t)) {
      this._messageQueue.push(data);
      this._scheduleProcessing();
      return;
    }
    this._processMessage(data);
  }

  /**
   * Schedules message queue processing on the next animation frame.
   * @private
   * @returns {void}
   */
  _scheduleProcessing() {
    if (!this._processingScheduled) {
      this._processingScheduled = true;
      requestAnimationFrame(() => this._processMessageQueue());
    }
  }

  /**
   * Decodes a length-delimited batched frame.
   * @private
   * @param {Uint8Array} raw - Raw binary data.
   * @returns {void}
   */
  _decodeBatchedFrame(raw) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let offset = 0;
    while (offset + 4 <= raw.length) {
      const len = view.getUint32(offset);
      offset += 4;
      if (offset + len > raw.length) break;
      const msgBytes = raw.subarray(offset, offset + len);
      offset += len;
      try {
        const data = this.Msg.decode(msgBytes);
        this.handleMessage(data);
      } catch (err) {
        console.error('Failed to decode batched message:', err);
      }
    }
  }

  /**
   * Processes queued messages within a fixed time budget per frame.
   * @private
   * @returns {void}
   */
  _processMessageQueue() {
    this._processingScheduled = false;
    const BUDGET_MS = 8;
    const start = performance.now();
    let processed = 0;

    while (this._messageQueue.length > 0) {
      const data = this._messageQueue.shift();
      this._processMessage(data);
      processed++;

      if (processed % 10 === 0 && performance.now() - start > BUDGET_MS) {
        break;
      }
    }

    if (this._messageQueue.length > 0) {
      this._scheduleProcessing();
    }
  }

  /**
   * Internal router for processing a single message.
   * Emits application-level events based on message type.
   *
   * @private
   * @param {Object} data - Message payload.
   * @returns {void}
   */
  _processMessage(data) {
    switch (data.t) {
      case T.CONNECT:
        this.sessionIndex = data.u;
        this.role = data.authRole !== undefined ? data.authRole : 0;
        if (this.onConnect) {
          this.onConnect(this.sessionIndex, this.role, data.authUsername, data.iph);
        }
        break;

      case T.PING:
        this.send({ t: T.PONG });
        break;

      case T.USERS:
        const users = (data.us || []).map(u => ({
          sessionIndex: u.u,
          afk: u.a,
          x: u.x,
          y: u.y,
          tool: ToolNames[u.l] || 'brush',
          color: unpackColor(u.c),
          size: (u.s ?? 1000) / 100,
          spacing: u.sp ?? 0,
          smoothing: u.sm ?? 15,
          hardness: (u.hd ?? 100),
          pressure: (u.p ?? 100) / 100,
          name: u.n || '',
          text: u.tx || '',
          role: u.role || 0,
          cursorHidden: u.ch || false,
          blurRadius: (u.br ?? 500),
          activeLayer: u.ly ?? 0,
          blendMode: u.bm || 'source-over',
          imageBrush: u.ib,
          ipHash: u.iph,
          thinning: u.th ? (u.th - 1) / 100 : undefined,
          simulatePressure: u.sim !== undefined ? u.sim === 2 : undefined
        }));
        this.emit('users', { users });
        break;

      case T.SETTINGS:
        this.emit('settings', {
          mirror: data.m,
          backgroundColor: data.roomBackgroundColor,
          locked: data.roomLocked,
          maxUsers: data.roomMaxUsers
        });
        break;

      case T.LEFT:
        this.emit('left', { sessionIndex: data.u });
        break;

      case T.AFK:
        this.emit('afk', { sessionIndex: data.u, afk: data.a });
        break;

      case T.MM:
        this.emit('mm', {
          sessionIndex: data.u,
          ps: data.ps || [],
          rs: data.rs || null
        });
        break;

      case T.MD:
        this.emit('md', {
          sessionIndex: data.u,
          ps: data.ps || null,
          rs: data.rs || null
        });
        break;

      case T.MU:
        this.emit('mu', { sessionIndex: data.u });
        break;

      case T.CP:
        this.emit('cp', { sessionIndex: data.u, pressure: (data.p ?? 100) / 100 });
        break;

      case T.CS:
        this.emit('cs', { sessionIndex: data.u, size: (data.s ?? 1000) / 100 });
        break;

      case T.CT:
        this.emit('ct', { sessionIndex: data.u, tool: ToolNames[data.l] || 'brush', eraseAll: data.a || false });
        break;

      case T.CC:
        this.emit('cc', { sessionIndex: data.u, color: unpackColor(data.c) });
        break;

      case T.CSP:
        this.emit('csp', { sessionIndex: data.u, spacing: data.sp ?? 0 });
        break;

      case T.CSM:
        this.emit('csm', { sessionIndex: data.u, smoothing: data.sm ?? 15 });
        break;

      case T.CHD:
        this.emit('chd', { sessionIndex: data.u, hardness: (data.hd ?? 100) });
        break;

      case T.CBR:
        this.emit('cbr', { sessionIndex: data.u, blurRadius: (data.br ?? 500) });
        break;

      case T.CTHN:
        this.emit('cthn', { sessionIndex: data.u, thinning: (data.th ? data.th - 1 : 50) / 100 });
        break;

      case T.CSIM:
        // Offset encoding: 0=not set, 1=false, 2=true
        this.emit('csim', { sessionIndex: data.u, simulatePressure: (data.sim ?? 0) === 2 });
        break;

      case T.FILL:
        this.emit('fill', {
          sessionIndex: data.u,
          x: data.sx,
          y: data.sy,
          layerIndex: data.ly ?? 0,
          expansion: (data.s ?? 0) / 100,
          blurRadius: (data.br ?? 0) / 100
        });
        break;

      case T.CL:
        this.emit('cl', { sessionIndex: data.u, layerIndex: data.ly ?? 0 });
        break;

      case T.CBM:
        this.emit('cbm', {
          sessionIndex: data.u,
          layerIndex: data.ly ?? null,
          blendMode: data.bm || 'source-over'
        });
        break;

      case T.CN:
        this.emit('cn', {
          sessionIndex: data.u,
          name: data.n,
          message: data.g,
          size: data.s !== undefined ? data.s / 100 : undefined,
          tool: data.l !== undefined ? ToolNames[data.l] : undefined,
          color: data.c !== undefined ? unpackColor(data.c) : undefined,
          spacing: data.sp !== undefined ? data.sp / 100 : undefined,
          smoothing: data.sm !== undefined ? data.sm : undefined,
          hardness: data.hd !== undefined ? data.hd : undefined,
          blurRadius: data.br !== undefined ? data.br : undefined,
          activeLayer: data.ly !== undefined ? data.ly : undefined,
          blendMode: data.bm || undefined,
          thinning: data.th ? (data.th - 1) / 100 : undefined,
          simulatePressure: data.sim !== undefined ? data.sim === 2 : undefined
        });
        break;

      case T.KP:
        this.emit('kp', { sessionIndex: data.u, key: data.k });
        break;

      case T.CLR:
        this.emit('clr', { sessionIndex: data.u });
        break;

      case T.MIR:
        this.emit('mir', { sessionIndex: data.u });
        break;

      case T.MSG:
        this.emit('msg', { sessionIndex: data.u, message: data.g });
        break;

      case T.DM:
        this.emit('dm', { sessionIndex: data.u, message: data.g });
        break;

      case T.CHAT_IMG:
        const rawBytes = data.cimg;
        if (!rawBytes || rawBytes.length === 0) break;

        const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        let mimeType = 'image/png';
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) mimeType = 'image/jpeg';
        else if (bytes[0] === 0x47 && bytes[1] === 0x49) mimeType = 'image/gif';
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) mimeType = 'image/webp';

        const imageDataUrl = `data:${mimeType};base64,${base64}`;
        this.emit('chat_img', { sessionIndex: data.u, imageData: imageDataUrl, recipientId: data.r });
        break;

      case T.GMP:
        this.emit('gmp', { sessionIndex: data.u, brushData: data.g });
        break;

      case T.PAN:
        this.emit('pan', { sessionIndex: data.u, panning: data.a });
        break;

      case T.CANCEL:
        this.emit('cancel', { sessionIndex: data.u });
        break;

      case T.HIDE_CURSOR:
        this.emit('hide_cursor', { sessionIndex: data.u });
        break;

      case T.SHOW_CURSOR:
        this.emit('show_cursor', { sessionIndex: data.u });
        break;

      case T.SEL_LIFT:
        let lassoPath = null;
        if (data.cr && data.cr.length >= 6) {
          lassoPath = [];
          for (let i = 0; i < data.cr.length; i += 2) {
            lassoPath.push({ x: data.cr[i], y: data.cr[i + 1] });
          }
        }
        this.emit('sel_lift', {
          sessionIndex: data.u,
          selection: { x: data.sx, y: data.sy, width: data.sw, height: data.sh },
          lassoPath
        });
        break;

      case T.SEL_MOVE:
        const cr = data.cr || [];
        this.emit('sel_move', {
          sessionIndex: data.u,
          corners: {
            tl: { x: cr[0], y: cr[1] },
            tr: { x: cr[2], y: cr[3] },
            br: { x: cr[4], y: cr[5] },
            bl: { x: cr[6], y: cr[7] }
          }
        });
        break;

      case T.SEL_COMMIT:
        this.emit('sel_commit', { sessionIndex: data.u, layerIndex: data.ly ?? 0 });
        break;

      case T.SEL_PENDING: {
        let pendingLassoPath = null;
        if (data.ps && data.ps.length >= 6) {
          pendingLassoPath = [];
          for (let i = 0; i < data.ps.length; i += 2) {
            pendingLassoPath.push({ x: data.ps[i], y: data.ps[i + 1] });
          }
        }
        this.emit('sel_pending', {
          sessionIndex: data.u,
          selection: {
            x: Math.floor(data.sx),
            y: Math.floor(data.sy),
            width: Math.ceil(data.sw),
            height: Math.ceil(data.sh)
          },
          lassoPath: pendingLassoPath
        });
        break;
      }

      case T.SEL_DELETE:
        this.emit('sel_delete', { sessionIndex: data.u, layerIndex: data.ly ?? 0 });
        break;

      case T.SEL_FILL:
        this.emit('sel_fill', { sessionIndex: data.u, color: unpackColor(data.c), layerIndex: data.ly ?? 0 });
        break;

      case T.SEL_STAMP:
        this.emit('sel_stamp', { sessionIndex: data.u, layerIndex: data.ly ?? 0 });
        break;

      case T.SEL_FLIP:
        this.emit('sel_flip', { sessionIndex: data.u });
        break;

      case T.SEL_CANCEL:
        this.emit('sel_cancel', { sessionIndex: data.u });
        break;

      case T.SEL_TO_BRUSH:
        this.emit('sel_to_brush', { sessionIndex: data.u, brushData: data.g });
        break;

      case T.IMG_PASTE:
        this.emit('img_paste', {
          sessionIndex: data.u,
          x: data.sx,
          y: data.sy,
          width: data.sw,
          height: data.sh,
          imageData: data.g
        });
        break;

      case T.SYNC_PROVIDE:
        this.emit('sync_provide', {
          targetUser: data.tu
        });
        break;

      case T.SYNC_CANVAS:
        this.emit('sync_canvas', {
          sessionIndex: data.u,
          imageData: data.img
        });
        break;

      case T.SYNC_COMPLETE:
        this.emit('sync_complete', {});
        break;

      case T.SYNC_METADATA:
        this.emit('sync_metadata', {
          totalCount: data.syncTotal || data.sync_total || 0
        });
        break;

      case T.SYNC_LAYER_BASE:
        this.emit('sync_layer_bin', {
          layerIdx: data.ly,
          blendMode: data.bm || 'source-over',
          imageData: data.img
        });
        break;

      case T.SYNC_STROKE:
        this.emit('sync_stroke', {
          layerIdx: data.ly,
          userId: data.u,
          x: data.sx, y: data.sy, w: data.sw, h: data.sh,
          blendMode: data.bm,
          timestamp: data.stroke_ts ? Number(data.stroke_ts) : 0,
          eraseAll: data.a || false,
          isRedo: data.stroke_redo || false,
          redoBatchIdx: data.stroke_redo_batch || 0,
          imageData: data.img
        });
        break;

      case T.SYNC_STROKE_BATCH:
        if (data.strokes && data.strokes.length > 0) {
          this.emit('sync_stroke_batch', {
            strokes: data.strokes.map(stroke => ({
              layerIdx: stroke.layerIdx !== undefined ? stroke.layerIdx : data.layerIdx,
              userId: stroke.userId,
              x: stroke.x,
              y: stroke.y,
              w: stroke.width,
              h: stroke.height,
              blendMode: stroke.blendMode || 'source-over',
              timestamp: stroke.timestamp ? Number(stroke.timestamp) : 0,
              eraseAll: stroke.eraseAll || false,
              isRedo: stroke.isRedo || false,
              redoBatchIdx: stroke.redoBatch || 0,
              imageData: stroke.img,
              affectedTiles: stroke.affectedTiles || []
            }))
          });
        }
        break;

      case T.SYNC_STROKES_DONE:
        this.emit('sync_strokes_done', {});
        break;

      case T.SYNC_TILE_OWNERSHIP:
        this.emit('sync_tile_ownership', { tiles: data.tiles || [] });
        break;

      case T.TILE_UPDATE:
        this.emit('tile_update', { userId: data.u, tiles: data.tiles || [] });
        break;

      case T.TILE_CLEAR:
        this.emit('tile_clear', { clearedTiles: data.clearedTiles || [] });
        break;

      case T.AUTH_RESULT:
        this.emit('auth_result', {
          success: data.a,
          token: data.authToken || '',
          role: data.authRole || 0,
          username: data.authUsername || '',
          error: data.authError || ''
        });
        break;

      case T.MOD_NOTIFY:
        this.emit('mod_notify', {
          actionType: data.modActionType ?? 0,
          targetName: data.modTargetName || '',
          issuerName: data.modIssuerName || '',
          reason: data.modReason || '',
          targetSessionIndex: data.modTarget
        });
        break;

      case T.MOD_RESULT:
        this.emit('mod_result', {
          success: data.a,
          error: data.authError || ''
        });
        break;

      case T.MOD_LIST:
        this.emit('mod_list', {
          entries: (data.modEntries || []).map(e => ({
            id: e.id,
            type: e.type,
            username: e.username,
            reason: e.reason,
            ip: e.ip,
            issuedBy: e.issuedBy,
            createdAt: e.createdAt,
            expiresAt: e.expiresAt,
            active: e.active
          }))
        });
        break;

      case T.UNDO:
        this.emit('undo', { sessionIndex: data.u });
        break;

      case T.REDO:
        this.emit('redo', { sessionIndex: data.u });
        break;

      case T.MOD_WIPE:
        this.emit('mod_wipe', {
          targetSessionIndex: data.modTarget,
          targetName: data.modTargetName || '',
          issuerName: data.modIssuerName || ''
        });
        break;

      case T.ROOM_LIST_RESPONSE:
        this.emit('room_list_response', {
          rooms: (data.rooms || []).map(r => ({
            id: r.id,
            userCount: r.userCount || 0,
            locked: r.locked || false,
            hasPassword: r.hasPassword || false,
            description: r.description || '',
            ownerId: r.ownerId || null,
            ownerUsername: r.ownerUsername || null
          }))
        });
        break;

      case T.ROOM_OWNERSHIP:
        this.emit('room_ownership', {
          ownerId: data.ownerId || null,
          ownerUsername: data.ownerUsername || null
        });
        break;
    }
  }

  /**
   * Internal helper to trigger registered message handlers.
   *
   * @param {string} event - Event name.
   * @param {Object} data - Event payload.
   * @returns {void}
   */
  emit(event, data) {
    const handler = this.messageHandlers.get(event);
    if (handler) {
      handler(data);
    }
  }

  /**
   * Registers a handler for a specific message event.
   *
   * @param {string} event - Event name.
   * @param {Function} handler - Handler function.
   * @returns {void}
   */
  on(event, handler) {
    this.messageHandlers.set(event, handler);
  }

  /**
   * Encodes and sends a message via WebSocket.
   *
   * @param {Object} data - Message payload to be encoded as protobuf.
   * @returns {void}
   */
  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.Msg) {
      const message = this.Msg.create(data);
      const buffer = this.Msg.encode(message).finish();
      this.socket.send(buffer);
    }
  }

  /**
   * Broadcasts freehand movement points.
   * @param {Array<number>} points - Flattened [x, y, ...] coordinates.
   * @returns {void}
   */
  broadcastMove(points) {
    this.send({ t: T.MM, ps: points });
  }

  /**
   * Broadcasts stamped movement (pen/ink) with radii.
   * @param {Array<number>} points - Flattened coordinates.
   * @param {Array<number>} radii - Flattened radii.
   * @returns {void}
   */
  broadcastStampMove(points, radii) {
    this.send({ t: T.MM, ps: points, rs: radii });
  }

  /**
   * Broadcasts a legacy single mouse movement.
   * @param {number} x - X coordinate.
   * @param {number} y - Y coordinate.
   * @returns {void}
   */
  broadcastMouseMove(x, y) {
    this.send({ t: T.MM, ps: [x, y] });
  }

  /**
   * Broadcasts a mouse down event.
   * @param {Array<number>} points - Initial points.
   * @param {Array<number>|null} radii - Initial radii.
   * @returns {void}
   */
  broadcastMouseDown(points, radii) {
    this.send({ t: T.MD, ps: points, rs: radii });
  }

  /**
   * Broadcasts a mouse up event.
   * @returns {void}
   */
  broadcastMouseUp() {
    this.send({ t: T.MU });
  }

  /**
   * Broadcasts a tool change.
   * @param {string} tool - Tool name.
   * @param {boolean} [eraseAll=false] - Whether to erase all layers.
   * @returns {void}
   */
  broadcastToolChange(tool, eraseAll = false) {
    this.send({ t: T.CT, l: ToolToEnum[tool] || 0, a: eraseAll || false });
  }

  /**
   * Broadcasts a color change.
   * @param {Object} color - {r, g, b, a} color object.
   * @returns {void}
   */
  broadcastColorChange(color) {
    this.send({ t: T.CC, c: packColor(color) });
  }

  /**
   * Broadcasts a brush size change.
   * @param {number} size - New size.
   * @returns {void}
   */
  broadcastSizeChange(size) {
    this.send({ t: T.CS, s: Math.round(size * 100) });
  }

  /**
   * Broadcasts a spacing change.
   * @param {number} spacing - New spacing.
   * @returns {void}
   */
  broadcastSpacingChange(spacing) {
    this.send({ t: T.CSP, sp: Math.round(spacing * 100) });
  }

  /**
   * Broadcasts a smoothing value change.
   * @param {number} smoothing - New smoothing.
   * @returns {void}
   */
  broadcastSmoothingChange(smoothing) {
    this.send({ t: T.CSM, sm: Math.round(smoothing) });
  }

  /**
   * Broadcasts a hardness value change.
   * @param {number} hardness - New hardness (0-100).
   * @returns {void}
   */
  broadcastHardnessChange(hardness) {
    this.send({ t: T.CHD, hd: Math.round(hardness) });
  }

  /**
   * Broadcasts a blur radius change.
   * @param {number} radius - New blur radius.
   * @returns {void}
   */
  broadcastBlurRadiusChange(radius) {
    this.send({ t: T.CBR, br: Math.round(radius) });
  }

  /**
   * Broadcasts an ink thinning change.
   * @param {number} thinning - New thinning value (0-1).
   * @returns {void}
   */
  broadcastThinningChange(thinning) {
    this.send({ t: T.CTHN, th: Math.round(thinning * 100) + 1 });
  }

  /**
   * Broadcasts a simulate pressure change.
   * @param {boolean} simulate - Whether to simulate pressure.
   * @returns {void}
   */
  broadcastSimulatePressureChange(simulate) {
    // Offset encoding: 0=not set, 1=false, 2=true (avoids proto3 zero-default ambiguity)
    this.send({ t: T.CSIM, sim: simulate ? 2 : 1 });
  }

  /**
   * Broadcasts an active layer change.
   * @param {number} layerIndex - New layer index.
   * @returns {void}
   */
  broadcastLayerChange(layerIndex) {
    this.send({ t: T.CL, ly: layerIndex });
  }

  /**
   * Broadcasts a blend mode change for a specific layer.
   * @param {number} layerIndex - Layer index.
   * @param {string} blendMode - Canvas composite operation name.
   * @returns {void}
   */
  broadcastLayerBlendModeChange(layerIndex, blendMode) {
    this.send({ t: T.CBM, ly: layerIndex, bm: blendMode });
  }

  /**
   * Broadcasts a pressure change.
   * @param {number} pressure - New pressure (0.0 - 1.0).
   * @returns {void}
   */
  broadcastPressureChange(pressure) {
    this.send({ t: T.CP, p: Math.round(pressure * 100) });
  }

  /**
   * Broadcasts a username change.
   * @param {string} name - New username.
   * @param {Object} [extraProperties={}] - Additional user properties.
   * @returns {void}
   */
  broadcastNameChange(name, extraProperties = {}) {
    this.send({ t: T.CN, n: name, ...extraProperties });
  }

  /**
   * Broadcasts a single key press (for text tool).
   * @param {string} key - The key pressed.
   * @returns {void}
   */
  broadcastKeyPress(key) {
    this.send({ t: T.KP, k: key });
  }

  /**
   * Broadcasts a pan state change.
   * @param {boolean} value - True if panning.
   * @returns {void}
   */
  broadcastPan(value) {
    this.send({ t: T.PAN, a: value });
  }

  /**
   * Broadcasts a cancellation of the current stroke.
   * @returns {void}
   */
  broadcastCancel() {
    this.send({ t: T.CANCEL });
  }

  /**
   * Broadcasts a request to hide the local cursor.
   * @returns {void}
   */
  broadcastHideCursor() {
    this.send({ t: T.HIDE_CURSOR });
  }

  /**
   * Broadcasts a request to show the local cursor.
   * @returns {void}
   */
  broadcastShowCursor() {
    this.send({ t: T.SHOW_CURSOR });
  }

  /**
   * Broadcasts a clear canvas request.
   * @returns {void}
   */
  broadcastClear() {
    this.send({ t: T.CLR });
  }

  /**
   * Broadcasts a toggle for the mirror line.
   * @returns {void}
   */
  broadcastMirror() {
    this.send({ t: T.MIR });
  }

  /**
   * Broadcasts an undo request.
   * @returns {void}
   */
  broadcastUndo() {
    this.send({ t: T.UNDO });
  }

  /**
   * Broadcasts a redo request.
   * @returns {void}
   */
  broadcastRedo() {
    this.send({ t: T.REDO });
  }

  /**
   * Broadcasts a flood fill event.
   * @param {number} x - Fill seed X position.
   * @param {number} y - Fill seed Y position.
   * @param {number} layerIndex - Target layer index.
   * @param {number} [expansion=0] - Mask expansion in pixels (-40 to 40).
   * @param {number} [blurRadius=0] - Edge blur radius in pixels (0-30).
   */
  broadcastFill(x, y, layerIndex, expansion = 0, blurRadius = 0) {
    this.send({
      t: T.FILL,
      sx: Math.floor(x),
      sy: Math.floor(y),
      ly: layerIndex,
      s: Math.round(expansion * 100),
      br: Math.round(blurRadius * 100)
    });
  }

  /**
   * Broadcasts a public chat message.
   * @param {string} message - Message text.
   * @returns {void}
   */
  broadcastChat(message) {
    this.send({ t: T.MSG, g: message });
  }

  /**
   * Broadcasts an image to the chat or a specific user.
   * @param {string} imageData - Base64 encoded image data URL.
   * @param {number|null} [recipientId=null] - Optional private recipient.
   * @returns {void}
   */
  broadcastChatImage(imageData, recipientId = null) {
    const base64Data = imageData.split(',')[1];
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    if (recipientId !== null) {
      this.send({ t: T.CHAT_IMG, cimg: bytes, r: recipientId });
    } else {
      this.send({ t: T.CHAT_IMG, cimg: bytes });
    }
  }

  /**
   * Broadcasts a private message to a specific user.
   * @param {string} message - Message text.
   * @param {number} recipientId - Recipient session index.
   * @returns {void}
   */
  broadcastDM(message, recipientId) {
    this.send({ t: T.DM, g: message, r: recipientId });
  }

  /**
   * Broadcasts a custom brush configuration.
   * @param {Object} brushData - Brush settings object.
   * @returns {void}
   */
  broadcastBrush(brushData) {
    this.send({ t: T.GMP, g: JSON.stringify(brushData) });
  }

  /**
   * Broadcasts a selection lift (extraction) event.
   * @param {Object} rect - Bounding box {x, y, width, height}.
   * @param {Array<Object>|null} [lassoPath=null] - Optional freehand path.
   * @returns {void}
   */
  broadcastSelectionLift(rect, lassoPath = null, imageData = null) {
    const msg = {
      t: T.SEL_LIFT,
      sx: Math.round(rect.x),
      sy: Math.round(rect.y),
      sw: Math.round(rect.width),
      sh: Math.round(rect.height)
    };

    if (lassoPath && lassoPath.length > 0) {
      msg.cr = lassoPath.flatMap(p => [Math.round(p.x), Math.round(p.y)]);
    }
    if (imageData) {
      msg.g = imageData;
    }
    this.send(msg);
  }

  /**
   * Broadcasts a pending selection marquee.
   * @param {Object} rect - Bounding box.
   * @param {Array<Object>|null} [lassoPath=null] - Optional path.
   * @returns {void}
   */
  broadcastSelectionPending(rect, lassoPath = null) {
    const msg = {
      t: T.SEL_PENDING,
      sx: Math.round(rect.x),
      sy: Math.round(rect.y),
      sw: Math.round(rect.width),
      sh: Math.round(rect.height)
    };

    if (lassoPath && lassoPath.length > 0) {
      msg.ps = lassoPath.flatMap(p => [Math.round(p.x), Math.round(p.y)]);
    }
    this.send(msg);
  }

  /**
   * Broadcasts a selection movement (perspective transform).
   * @param {Object} corners - {tl, tr, br, bl} corner coordinates.
   * @returns {void}
   */
  broadcastSelectionMove(corners) {
    this.send({
      t: T.SEL_MOVE,
      cr: [
        corners.tl.x, corners.tl.y,
        corners.tr.x, corners.tr.y,
        corners.br.x, corners.br.y, 
        corners.bl.x, corners.bl.y
      ]
    });
  }

  /**
   * Broadcasts a selection commit (baking) event.
   * @returns {void}
   */
  broadcastSelectionCommit() {
    this.send({ t: T.SEL_COMMIT });
  }

  /**
   * Broadcasts a selection deletion.
   * @param {number} [layerIndex] - Target layer index.
   * @returns {void}
   */
  broadcastSelectionDelete(layerIndex) {
    const msg = { t: T.SEL_DELETE };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    this.send(msg);
  }

  /**
   * Broadcasts a selection fill event.
   * @param {Object} color - {r, g, b, a} color.
   * @param {number} [layerIndex] - Target layer index.
   * @returns {void}
   */
  broadcastSelectionFill(color, layerIndex) {
    const msg = { t: T.SEL_FILL, c: packColor(color) };
    if (layerIndex !== undefined) msg.ly = layerIndex;
    this.send(msg);
  }

  /**
   * Broadcasts a selection stamp (bake without clearing) event.
   * @returns {void}
   */
  broadcastSelectionStamp() {
    this.send({ t: T.SEL_STAMP });
  }

  /**
   * Broadcasts a selection flip.
   * @returns {void}
   */
  broadcastSelectionFlip() {
    this.send({ t: T.SEL_FLIP });
  }

  /**
   * Broadcasts a selection cancellation.
   * @returns {void}
   */
  broadcastSelectionCancel() {
    this.send({ t: T.SEL_CANCEL });
  }

  /**
   * Broadcasts a selection-to-brush conversion.
   * @param {Object} brushData - Brush configuration.
   * @returns {void}
   */
  broadcastSelectionToBrush(brushData) {
    this.send({ t: T.SEL_TO_BRUSH, g: JSON.stringify(brushData) });
  }

  /**
   * Broadcasts a pasted image to the canvas.
   * @param {number} x - Target X.
   * @param {number} y - Target Y.
   * @param {number} width - Display width.
   * @param {number} height - Display height.
   * @param {string} dataUrl - Base64 image data URL.
   * @returns {void}
   */
  broadcastImagePaste(x, y, width, height, dataUrl) {
    this.send({
      t: T.IMG_PASTE,
      sx: Math.round(x),
      sy: Math.round(y),
      sw: Math.round(width),
      sh: Math.round(height),
      g: dataUrl
    });
  }

  /**
   * Requests a canvas synchronization from the server.
   * @param {number|null} [targetUserId=null] - Specific user ID to sync from.
   * @returns {void}
   */
  requestSync(targetUserId = null) {
    const msg = { t: T.SYNC_REQUEST };
    if (targetUserId !== null) {
      msg.tu = targetUserId;
    }
    this.send(msg);
  }

  /**
   * Sends a layer group's base canvas bin during sync.
   * @param {Uint8Array} imageData - PNG binary data.
   * @param {number} layerIdx - Layer group index.
   * @param {string} blendMode - Target blend mode.
   * @param {number} targetUser - Recipient session index.
   * @returns {void}
   */
  sendSyncLayerBase(imageData, layerIdx, blendMode, targetUser) {
    this.send({ t: T.SYNC_LAYER_BASE, ly: layerIdx, bm: blendMode, img: imageData, tu: targetUser });
  }

  /**
   * Sends batched stroke records during sync.
   * @param {Array<Object>} strokeRecords - Array of serialized stroke data.
   * @param {number} layerIdx - Target layer index.
   * @param {number} targetUser - Recipient session index.
   * @returns {void}
   */
  sendSyncStrokeBatch(strokeRecords, layerIdx, targetUser) {
    const strokes = strokeRecords.map(s => ({
      img: s.img,
      userId: s.userId,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      blendMode: s.blendMode,
      timestamp: s.timestamp,
      isRedo: s.isRedo || false,
      redoBatch: s.redoBatch || 0,
      layerIdx: s.layerIdx,
      affectedTiles: s.affectedTiles || [],
      eraseAll: s.eraseAll || false
    }));

    this.send({
      t: T.SYNC_STROKE_BATCH,
      strokes,
      layerIdx,
      tu: targetUser
    });
  }

  /**
   * Sends sync metadata (total count) to the joining user.
   * @param {number} totalCount - Expected message count.
   * @param {number} targetUser - Recipient session index.
   * @returns {void}
   */
  sendSyncMetadata(totalCount, targetUser) {
    this.send({ t: T.SYNC_METADATA, syncTotal: totalCount, tu: targetUser });
  }

  /**
   * Signals that synchronization message dispatch is complete.
   * @param {number} targetUser - Recipient session index.
   * @returns {void}
   */
  sendSyncStrokesDone(targetUser) {
    this.send({ t: T.SYNC_STROKES_DONE, tu: targetUser });
  }

  /**
   * Sends tile ownership data during sync.
   * @param {Array} tiles - Array of {idx, users} objects.
   * @param {number} targetUser - Recipient session index.
   * @returns {void}
   */
  sendSyncTileOwnership(tiles, targetUser) {
    this.send({ t: T.SYNC_TILE_OWNERSHIP, tiles, tu: targetUser });
  }

  /**
   * Broadcasts real-time tile ownership updates as user draws.
   * @param {Array<number>} tileIndices - Array of tile indices the user now owns.
   * @returns {void}
   */
  broadcastTileUpdate(tileIndices) {
    if (!tileIndices || tileIndices.length === 0) return;
    // Send tiles as array of {idx, users} where users is just [self]
    const tiles = tileIndices.map(idx => ({ idx, users: [] }));
    this.send({ t: T.TILE_UPDATE, tiles });
  }

  /**
   * Broadcasts tiles that are now empty (ownership should be cleared).
   * @param {Array<number>} tileIndices - Array of tile indices that are now empty.
   * @returns {void}
   */
  broadcastTileClear(tileIndices) {
    if (!tileIndices || tileIndices.length === 0) return;
    this.send({ t: T.TILE_CLEAR, clearedTiles: tileIndices });
  }

  /**
   * Sends a user registration request.
   * @param {string} username - Chosen username.
   * @param {string} password - Chosen password.
   * @returns {void}
   */
  sendAuthRegister(username, password, { email = '', secretQuestion = '', secretAnswer = '' } = {}) {
    const msg = { t: T.AUTH_REGISTER, authUsername: username, authPassword: password };
    if (email) msg.authEmail = email;
    if (secretQuestion) msg.authSecretQuestion = secretQuestion;
    if (secretAnswer) msg.authSecretAnswer = secretAnswer;
    this.send(msg);
  }

  /**
   * Sends a user login request.
   * @param {string} username - Username.
   * @param {string} password - Password.
   * @returns {void}
   */
  sendAuthLogin(username, password) {
    this.send({ t: T.AUTH_LOGIN, authUsername: username, authPassword: password });
  }

  /**
   * Sends an authentication token login request.
   * @param {string} token - JWT or session token.
   * @returns {void}
   */
  sendAuthTokenLogin(token) {
    this.send({ t: T.AUTH_LOGIN, authToken: token });
  }

  /**
   * Sends a moderation action request.
   * @param {number} actionType - Type of action (BAN, KICK, etc.).
   * @param {number} targetSessionIndex - Target user ID.
   * @param {string} reason - Optional reason.
   * @param {number} duration - Optional duration in seconds.
   * @returns {void}
   */
  sendModAction(actionType, targetSessionIndex, reason, duration) {
    this.send({
      t: T.MOD_ACTION,
      modActionType: actionType,
      modTarget: targetSessionIndex,
      modReason: reason || '',
      modDuration: duration || 0
    });
  }

  /**
   * Requests the current moderation list (bans/warnings).
   * @param {Object} [params] - Filtering parameters.
   * @returns {void}
   */
  requestModList({ showHistory = false, search = '' } = {}) {
    this.send({ t: T.MOD_LIST, modShowHistory: showHistory, modSearch: search });
  }

  /**
   * Sends a request to wipe all drawings by a specific user.
   * @param {number} targetSessionIndex - Target user ID.
   * @param {string} [targetName] - Target username.
   * @returns {void}
   */
  sendModWipe(targetSessionIndex, targetName) {
    this.send({
      t: T.MOD_WIPE,
      modTarget: targetSessionIndex,
      modTargetName: targetName || ''
    });
  }

  /**
   * Sets a user's room-specific role.
   * @param {string} targetUserId - The target user's ID.
   * @param {number} role - The role value (0-5).
   */
  sendRoomRoleSet(targetSessionIndex, role) {
    this.send({
      t: T.ROOM_ROLE_SET,
      roomRoleTargetId: String(targetSessionIndex),
      roomRoleValue: role
    });
  }

  /**
   * Requests the list of active rooms from the server.
   * @returns {void}
   */
  requestRoomList() {
    this.send({ t: T.ROOM_LIST_REQUEST });
  }

  /**
   * Closes the WebSocket connection.
   * @returns {void}
   */
  disconnect() {
    this._cancelled = true;
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { T, Tool, ToolNames, ToolToEnum, packColor, unpackColor };
