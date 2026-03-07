/**
 * WebSocket client for real-time communication with optimized protobuf
 */
import { T, Tool, ToolNames, ToolToEnum } from '../../shared/MessageTypes.js';
import { packColor, unpackColor } from '../../shared/ColorUtils.js';

export class WebSocketClient {
  constructor(options = {}) {
    this.socket = null;
    this.sessionIndex = null;  // Assigned by server
    this.connected = false;
    this.messageHandlers = new Map();
    this.onConnect = options.onConnect || null;
    this.onDisconnect = options.onDisconnect || null;
    this.serverUrl = options.serverUrl || null;
    this.Msg = null;
    this.protoLoaded = false;

    // Message batching to prevent task stacking
    this._messageQueue = [];
    this._processingScheduled = false;

    // Drawing messages that should be batched (high-frequency)
    this._batchableMessages = new Set([
      T.MM, T.MD, T.MU, T.CP, T.CS, T.CT, T.CC,
      T.CSP, T.CSM, T.CHD, T.CBR, T.CL, T.CBM, T.CANCEL
    ]);
  }

  async loadProto() {
    if (this.protoLoaded) return;

    try {
      // Lazy load protobufjs
      const protobuf = await import('protobufjs');

      const baseUrl = import.meta.env.BASE_URL || '/';
      const protoUrl = `${baseUrl}messages.proto`.replace('//', '/');
      console.log('Loading protobuf from:', protoUrl);
      const root = await protobuf.default.load(protoUrl);
      this.Msg = root.lookupType('Msg');
      this.protoLoaded = true;
      console.log('Protobuf loaded on client');
    } catch (err) {
      console.error('Failed to load protobuf:', err);
      throw err;
    }
  }

  async connect(userData, roomId = null) {
    await this.loadProto();

    // Close any existing socket cleanly before reconnecting
    if (this.socket) {
      // Null out handlers so the old socket's close event doesn't interfere
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

    this._buildUrl();
    this._tryConnect();
  }

  _buildUrl() {
    let baseUrl;
    if (this.serverUrl) {
      baseUrl = this.serverUrl;
    } else {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const currentPort = window.location.port;

      console.log('[WS] Current port:', currentPort);

      if (currentPort === '3000') {
        // Dev mode - connect directly to backend on port 8000
        baseUrl = `ws://localhost:8000`;
        console.log('[WS] Dev mode - direct connection to backend');
      } else {
        // Production mode
        baseUrl = import.meta.env.VITE_WS_SERVER_URL || `${wsProtocol}://${window.location.host}`;
        console.log('[WS] Using direct connection');
      }
    }

    // Use URL object to reliably manage query parameters
    try {
      const url = new URL(baseUrl);
      if (this._roomId) {
        url.searchParams.set('room', this._roomId);
      }
      this._url = url.toString();
    } catch (err) {
      // Fallback if baseUrl is not a valid full URL (e.g. just a path or relative URL)
      this._url = baseUrl;
      if (this._roomId) {
        const separator = this._url.includes('?') ? '&' : '?';
        this._url += `${separator}room=${encodeURIComponent(this._roomId)}`;
      }
    }

    console.log('[WS] Final WebSocket URL:', this._url);
  }

  _tryConnect() {
    this._connectAttempts++;
    console.log(`Connecting to WebSocket: ${this._url} (attempt ${this._connectAttempts})`);
    this.socket = new WebSocket(this._url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = () => {
      this.connected = true;
      this._connectAttempts = 0;
      const username = this._userData.username || this._userData.name || '';
      console.log('WebSocket connected, sending CONNECT with username:', username);
      console.log('_userData:', this._userData);

      // Send connect with optional name
      this.send({ t: T.CONNECT, n: username });
    };

    this.socket.onmessage = (event) => {
      try {
        const raw = new Uint8Array(event.data);
        // All Msg protobuf messages start with field 1 (tag byte 0x08).
        // Batched frames start with a 4-byte BE length prefix — since messages
        // are always < 16 MB, the first byte of the prefix is 0x00.
        if (raw.length > 4 && raw[0] !== 0x08) {
          // Length-delimited batch: [4-byte len][msg][4-byte len][msg]...
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
      console.log('WebSocket disconnected:', event.code, event.reason);

      // Auto-retry if we never got a session (server wasn't ready yet)
      if (this.sessionIndex === null && this._connectAttempts < 10) {
        const delay = Math.min(1000 * this._connectAttempts, 5000);
        console.log(`Server not ready, retrying in ${delay}ms...`);
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

  handleMessage(data) {
    // Batch high-frequency drawing messages to prevent task stacking
    if (this._batchableMessages.has(data.t)) {
      this._messageQueue.push(data);
      this._scheduleProcessing();
      return;
    }

    // Process non-batchable messages immediately
    this._processMessage(data);
  }

  /**
   * Schedule message queue processing on next animation frame.
   * @private
   */
  _scheduleProcessing() {
    if (!this._processingScheduled) {
      this._processingScheduled = true;
      requestAnimationFrame(() => this._processMessageQueue());
    }
  }

  /**
   * Decode a length-delimited batch frame from the server.
   * Format: [4-byte BE length][protobuf bytes][4-byte BE length][protobuf bytes]...
   * @private
   */
  _decodeBatchedFrame(raw) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let offset = 0;
    while (offset + 4 <= raw.length) {
      const len = view.getUint32(offset);
      offset += 4;
      if (offset + len > raw.length) break; // Incomplete message (shouldn't happen)
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
   * Process queued messages with a time budget to avoid blocking the main thread.
   * If messages remain after the budget is exhausted, reschedule for the next frame.
   * @private
   */
  _processMessageQueue() {
    this._processingScheduled = false;

    const BUDGET_MS = 8; // ~half a frame at 60fps — leaves time for rendering
    const start = performance.now();
    let processed = 0;

    while (this._messageQueue.length > 0) {
      const data = this._messageQueue.shift();
      this._processMessage(data);
      processed++;

      // Check budget every 10 messages to avoid overhead of performance.now()
      if (processed % 10 === 0 && performance.now() - start > BUDGET_MS) {
        break;
      }
    }

    // If messages remain, schedule another pass
    if (this._messageQueue.length > 0) {
      this._scheduleProcessing();
    }
  }

  /**
   * Process a single message (called directly for immediate messages, or from queue for batched).
   * @private
   */
  _processMessage(data) {
    // Debug: log CHAT_IMG messages
    if (data.t === T.CHAT_IMG || data.t === 40) {
      console.log('[_processMessage] Received CHAT_IMG:', {
        type: data.t,
        hasCimg: !!data.cimg,
        cimgLength: data.cimg?.length,
        fromUser: data.u
      });
    }

    switch (data.t) {
      case T.CONNECT:
        // Server assigned us a session index and role
        this.sessionIndex = data.u;
        this.role = data.authRole !== undefined ? data.authRole : 0;
        console.log('Assigned session index:', this.sessionIndex, 'Role:', this.role);
        if (this.onConnect) {
          this.onConnect(this.sessionIndex, this.role);
        }
        break;

      case T.USERS:
        // Convert users data to app format
        const users = (data.us || []).map(u => ({
          sessionIndex: u.u,
          afk: u.a,
          x: u.x,
          y: u.y,
          tool: ToolNames[u.l] || 'brush',
          color: unpackColor(u.c),
          size: (u.s ?? 1000) / 100,
          spacing: (u.sp ?? 0) / 100,
          smoothing: u.sm ?? 15,
          hardness: (u.hd ?? 100),
          pressure: (u.p ?? 100) / 100,
          name: u.n || '',
          text: u.tx || '',
          role: u.role || 0,
          cursorHidden: u.ch || false,
          blurRadius: (u.br ?? 500),
          activeLayer: u.ly ?? 0,
          blendMode: u.bm || 'source-over'
        }));
        this.emit('users', { users });
        break;

      case T.SETTINGS:
        this.emit('settings', { mirror: data.m });
        break;

      case T.LEFT:
        this.emit('left', { sessionIndex: data.u });
        break;

      case T.AFK:
        this.emit('afk', { sessionIndex: data.u, afk: data.a });
        break;

      // Broadcast messages
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
        this.emit('ct', { sessionIndex: data.u, tool: ToolNames[data.l] || 'brush' });
        break;

      case T.CC:
        this.emit('cc', { sessionIndex: data.u, color: unpackColor(data.c) });
        break;

      case T.CSP:
        this.emit('csp', { sessionIndex: data.u, spacing: (data.sp ?? 0) / 100 });
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

      case T.CL:
        this.emit('cl', { sessionIndex: data.u, layerIndex: data.ly ?? 0 });
        break;

      case T.CBM:
        this.emit('cbm', {
          sessionIndex: data.u,
          layerIndex: data.ly ?? null,  // null means legacy (per-user, not per-layer)
          blendMode: data.bm || 'source-over'
        });
        break;

      case T.CN:
        this.emit('cn', {
          sessionIndex: data.u,
          name: data.n,
          size: data.s !== undefined ? data.s / 100 : undefined,
          tool: data.l !== undefined ? ToolNames[data.l] : undefined,
          color: data.c !== undefined ? unpackColor(data.c) : undefined,
          spacing: data.sp !== undefined ? data.sp / 100 : undefined,
          smoothing: data.sm !== undefined ? data.sm : undefined,
          hardness: data.hd !== undefined ? data.hd : undefined,
          blurRadius: data.br !== undefined ? data.br : undefined,
          activeLayer: data.ly !== undefined ? data.ly : undefined,
          blendMode: data.bm || undefined
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

        if (!rawBytes || rawBytes.length === 0) {
          console.warn('[CHAT_IMG] No image data received');
          break;
        }

        console.log('[CHAT_IMG] Received', rawBytes.length, 'bytes');

        // Convert bytes back to base64 data URL
        const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        // Detect image type from first bytes (magic numbers)
        let mimeType = 'image/png'; // default
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
        // Parse lasso path from cr field if present
        let lassoPath = null;
        if (data.cr && data.cr.length >= 6) { // At least 3 points (6 coordinates)
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
        // cr is array: [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]
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
        this.emit('sel_commit', { sessionIndex: data.u });
        break;

      case T.SEL_DELETE:
        this.emit('sel_delete', { sessionIndex: data.u });
        break;

      case T.SEL_FILL:
        this.emit('sel_fill', { sessionIndex: data.u, color: unpackColor(data.c) });
        break;

      case T.SEL_STAMP:
        this.emit('sel_stamp', { sessionIndex: data.u });
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
          imageData: data.g  // Base64 data URL
        });
        break;

      case T.SYNC_PROVIDE:
        // Server is asking us to provide our canvas for a new user
        this.emit('sync_provide', {
          targetUser: data.tu  // The user who needs the canvas
        });
        break;

      case T.SYNC_CANVAS:
        // Receiving canvas data (either from server forwarding, or direct)
        this.emit('sync_canvas', {
          sessionIndex: data.u,
          imageData: data.img  // Uint8Array PNG data
        });
        break;

      case T.SYNC_COMPLETE:
        this.emit('sync_complete', {});
        break;

      case T.SYNC_METADATA:
        console.log('[WebSocketClient] Received SYNC_METADATA:', {
          raw: data,
          syncTotal: data.syncTotal,
          sync_total: data.sync_total,
          allKeys: Object.keys(data)
        });
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
          // protobufjs decodes snake_case proto fields as camelCase JS properties:
          // stroke_ts (uint64) → data.strokeTs (Long object; Number() converts safely)
          // stroke_redo → data.strokeRedo
          // stroke_redo_batch → data.strokeRedoBatch
          timestamp: data.strokeTs ? Number(data.strokeTs) : 0,
          eraseAll: data.a || false,
          isRedo: data.strokeRedo || false,
          redoBatchIdx: data.strokeRedoBatch || 0,
          imageData: data.img
        });
        break;

      case T.SYNC_STROKE_BATCH:
        // Unpack batched strokes and emit individual sync_stroke events
        if (data.strokes && data.strokes.length > 0) {
          console.log(`[Sync] Received batch with ${data.strokes.length} strokes:`, data.strokes.map(s => ({
            layerIdx: s.layerIdx,
            userId: s.userId,
            timestamp: s.timestamp ? Number(s.timestamp) : 0,
            x: s.x, y: s.y
          })));

          for (const stroke of data.strokes) {
            this.emit('sync_stroke', {
              layerIdx: stroke.layerIdx !== undefined ? stroke.layerIdx : data.layerIdx,  // Use per-stroke layerIdx if available
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
              imageData: stroke.img
            });
          }
        }
        break;

      case T.SYNC_STROKES_DONE:
        this.emit('sync_strokes_done', {});
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
          actionType: data.modActionType,
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
            hasPassword: r.hasPassword || false
          }))
        });
        break;
    }
  }

  emit(event, data) {
    const handler = this.messageHandlers.get(event);
    if (handler) {
      handler(data);
    }
  }

  on(event, handler) {
    this.messageHandlers.set(event, handler);
  }

  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.Msg) {
      // Use protobuf for ALL messages
      const message = this.Msg.create(data);
      const buffer = this.Msg.encode(message).finish();
      this.socket.send(buffer);
    }
  }

  // Broadcast methods

  broadcastMove(points) {
  this.send({ t: T.MM, ps: points });
}

  broadcastStampMove(points, radii) {
  this.send({ t: T.MM, ps: points, rs: radii });
}
  broadcastMouseMove(x, y, lastx, lasty) {
    this.send({
      t: T.MM,
      ps: [x, y]
    });
  }

  broadcastMouseDown(points, radii) {
    this.send({ t: T.MD, ps: points, rs: radii });
  }

  broadcastMouseUp() {
    this.send({ t: T.MU });
  }

  broadcastToolChange(tool) {
    this.send({ t: T.CT, l: ToolToEnum[tool] || 0 });
  }

  broadcastColorChange(color) {
    this.send({ t: T.CC, c: packColor(color) });
  }

  broadcastSizeChange(size) {
    this.send({ t: T.CS, s: Math.round(size * 100) });
  }

  broadcastSpacingChange(spacing) {
    this.send({ t: T.CSP, sp: Math.round(spacing * 100) });
  }

  broadcastSmoothingChange(smoothing) {
    this.send({ t: T.CSM, sm: Math.round(smoothing) });
  }

  broadcastHardnessChange(hardness) {
    this.send({ t: T.CHD, hd: Math.round(hardness) });
  }

  broadcastBlurRadiusChange(radius) {
    this.send({ t: T.CBR, br: Math.round(radius) });
  }

  broadcastLayerChange(layerIndex) {
    this.send({ t: T.CL, ly: layerIndex });
  }

  broadcastBlendModeChange(blendMode) {
    // Legacy method - broadcasts without layer index
    console.log(`[WS] Broadcasting blend mode (legacy): ${blendMode}`);
    this.send({ t: T.CBM, bm: blendMode });
  }

  broadcastLayerBlendModeChange(layerIndex, blendMode) {
    console.log(`[WS] Broadcasting layer ${layerIndex} blend mode: ${blendMode}`);
    this.send({ t: T.CBM, ly: layerIndex, bm: blendMode });
  }

  broadcastPressureChange(pressure) {
    this.send({ t: T.CP, p: Math.round(pressure * 100) });
  }

  broadcastNameChange(name, extraProperties = {}) {
    this.send({ t: T.CN, n: name, ...extraProperties });
  }

  broadcastKeyPress(key) {
    this.send({ t: T.KP, k: key });
  }

  broadcastPan(value) {
    this.send({ t: T.PAN, a: value });
  }

  broadcastCancel() {
    this.send({ t: T.CANCEL });
  }

  broadcastHideCursor() {
    this.send({ t: T.HIDE_CURSOR });
  }

  broadcastShowCursor() {
    this.send({ t: T.SHOW_CURSOR });
  }

  broadcastClear() {
    this.send({ t: T.CLR });
  }

  broadcastMirror() {
    this.send({ t: T.MIR });
  }

  broadcastUndo() {
    this.send({ t: T.UNDO });
  }

  broadcastRedo() {
    this.send({ t: T.REDO });
  }

  broadcastChat(message) {
    this.send({ t: T.MSG, g: message });
  }

  broadcastChatImage(imageData, recipientId = null) {
    // Convert base64 data URL to bytes
    const base64Data = imageData.split(',')[1];
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    console.log('[CHAT_IMG] Sending', bytes.length, 'bytes, recipientId:', recipientId);

    if (recipientId !== null) {
      // Send as DM with image
      this.send({ t: T.CHAT_IMG, cimg: bytes, r: recipientId });
    } else {
      // Send to all
      this.send({ t: T.CHAT_IMG, cimg: bytes });
    }
  }

  broadcastDM(message, recipientId) {
    this.send({ t: T.DM, g: message, r: recipientId });
  }

  broadcastBrush(brushData) {
    this.send({ t: T.GMP, g: JSON.stringify(brushData) });
  }

/**
 * Tells others to "lift" pixels from their local canvas.
 * @param {Object} rect - Selection rectangle {x, y, width, height}
 * @param {Array<{x: number, y: number}>|null} lassoPath - Optional lasso path for non-rectangular selections
 */
broadcastSelectionLift(rect, lassoPath = null) {
  const msg = {
    t: T.SEL_LIFT,
    sx: Math.round(rect.x),
    sy: Math.round(rect.y),
    sw: Math.round(rect.width),
    sh: Math.round(rect.height)
  };

  // Send lasso path as flattened coordinates [x1, y1, x2, y2, ...]
  if (lassoPath && lassoPath.length > 0) {
    msg.cr = lassoPath.flatMap(p => [Math.round(p.x), Math.round(p.y)]);
  }

  this.send(msg);
}

/**
 * Sends the 8 corner coordinates for movement/perspective.
 * @param {Object} corners - { tl: {x,y}, tr: {x,y}, bl: {x,y}, br: {x,y} }
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

/*
 Tells others to "bake" the floating layer onto their main canvas.
 */
broadcastSelectionCommit() {
  this.send({ t: T.SEL_COMMIT });
}

broadcastSelectionDelete() {
  this.send({ t: T.SEL_DELETE });
}

broadcastSelectionFill(color) {
  this.send({ t: T.SEL_FILL, c: packColor(color) });
}

broadcastSelectionStamp() {
  this.send({ t: T.SEL_STAMP });
}

broadcastSelectionCancel() {
  this.send({ t: T.SEL_CANCEL });
}

broadcastSelectionToBrush(brushData) {
  this.send({ t: T.SEL_TO_BRUSH, g: JSON.stringify(brushData) });
}

/**
 * Broadcast pasted image data
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} dataUrl - Base64 data URL of the image
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
 * Request canvas sync (sent when joining)
 * @param {number|null} targetUserId - Optional: specific user to sync from
 */
requestSync(targetUserId = null) {
  const msg = { t: T.SYNC_REQUEST };
  if (targetUserId !== null) {
    msg.tu = targetUserId;
  }
  this.send(msg);
}

/**
 * Send full canvas data to server (legacy, in response to SYNC_PROVIDE)
 * @param {Uint8Array} imageData - PNG image data of full canvas
 * @param {number} targetUser - The user who needs the canvas
 */
sendCanvasData(imageData, targetUser) {
  this.send({
    t: T.SYNC_CANVAS,
    img: imageData,
    tu: targetUser
  });
}

/**
 * Send a layer group's base canvas PNG during structured sync.
 * @param {Uint8Array} imageData - PNG of the baked base canvas
 * @param {number} layerIdx - Layer group index (0-based)
 * @param {string} blendMode - Blend mode for this layer bin
 * @param {number} targetUser - Joiner's session index
 */
sendSyncLayerBase(imageData, layerIdx, blendMode, targetUser) {
  this.send({ t: T.SYNC_LAYER_BASE, ly: layerIdx, bm: blendMode, img: imageData, tu: targetUser });
}

/**
 * Send a single stroke record during structured sync.
 * @param {Object} opts
 */
sendSyncStroke({ targetUser, layerIdx, userId, x, y, w, h, blendMode, timestamp, eraseAll, isRedo, redoBatchIdx, imageData }) {
  this.send({
    t: T.SYNC_STROKE,
    tu: targetUser,
    ly: layerIdx,
    u: userId,
    sx: x, sy: y, sw: w, sh: h,
    bm: blendMode,
    // protobufjs maps camelCase JS keys to snake_case proto fields:
    // strokeTs → stroke_ts, strokeRedo → stroke_redo, strokeRedoBatch → stroke_redo_batch
    strokeTs: timestamp,
    a: eraseAll || false,
    strokeRedo: isRedo || false,
    strokeRedoBatch: redoBatchIdx || 0,
    img: imageData
  });
}

/**
 * Send batched strokes for a layer group (new efficient sync).
 * @param {Array} strokeRecords - Array of stroke objects with {img, userId, x, y, width, height, blendMode, timestamp, isRedo, redoBatch}
 * @param {number} layerIdx - Layer group index
 * @param {number} targetUser - Target user session index
 */
sendSyncStrokeBatch(strokeRecords, layerIdx, targetUser) {
  // Map stroke records to protobuf StrokeRecord format
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
    layerIdx: s.layerIdx  // Include per-stroke layer index
  }));

  this.send({
    t: T.SYNC_STROKE_BATCH,
    strokes,
    layerIdx,  // Kept for backward compat, but strokes now have individual layerIdx
    tu: targetUser
  });
}

/**
 * Send sync metadata (total message count) to joiner.
 * @param {number} totalCount - Total number of sync messages that will be sent
 * @param {number} targetUser - Joiner's session index
 */
sendSyncMetadata(totalCount, targetUser) {
  console.log('[WebSocketClient] Sending SYNC_METADATA:', { totalCount, targetUser });
  // Use camelCase for protobufjs (it converts sync_total proto field to syncTotal in JS)
  this.send({ t: T.SYNC_METADATA, syncTotal: totalCount, tu: targetUser });
}

/**
 * Signal that all stroke data has been sent.
 * @param {number} targetUser - Joiner's session index
 */
sendSyncStrokesDone(targetUser) {
  this.send({ t: T.SYNC_STROKES_DONE, tu: targetUser });
}

  // Auth methods

  sendAuthRegister(username, password) {
    this.send({ t: T.AUTH_REGISTER, authUsername: username, authPassword: password });
  }

  sendAuthLogin(username, password) {
    this.send({ t: T.AUTH_LOGIN, authUsername: username, authPassword: password });
  }

  sendAuthTokenLogin(token) {
    this.send({ t: T.AUTH_LOGIN, authToken: token });
  }

  // Moderation methods

  sendModAction(actionType, targetSessionIndex, reason, duration) {
    this.send({
      t: T.MOD_ACTION,
      modActionType: actionType,
      modTarget: targetSessionIndex,
      modReason: reason || '',
      modDuration: duration || 0
    });
  }

  sendModRevoke(actionType, targetName) {
    this.send({
      t: T.MOD_ACTION,
      modActionType: actionType,
      modTarget: 0,
      modTargetName: targetName,
      modReason: ''
    });
  }

  requestModList() {
    this.send({ t: T.MOD_LIST });
  }

  sendModWipe(targetSessionIndex, targetName) {
    this.send({
      t: T.MOD_WIPE,
      modTarget: targetSessionIndex,
      modTargetName: targetName || ''
    });
  }

  requestRoomList() {
    this.send({ t: T.ROOM_LIST_REQUEST });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { T, Tool, ToolNames, ToolToEnum, packColor, unpackColor };
