/**
 * @fileoverview WebSocket client for real-time communication using Protocol Buffers.
 * Handles connection management, message batching, and binary serialization.
 */

import { T, Tool, ToolNames, ToolToEnum } from '../../shared/MessageTypes.js';
import { packColor, unpackColor } from '../../shared/ColorUtils.js';
import { normalizeTextFont } from '../config/textFonts.js';
import { ClientIdentity } from './ClientIdentity.js';

function hasOwnField(message, key) {
  return !!message && Object.prototype.hasOwnProperty.call(message, key);
}

// ps wire format: quantized to 0.1px, delta-encoded within each packet.
// Keep these helpers in sync with messages.proto `repeated sint32 ps` docs.
const PS_SCALE = 10;

/**
 * Encode an absolute float [x0, y0, x1, y1, ...] array into quantized sint32
 * delta-encoded form. First pair absolute, rest deltas from previous pair.
 * Returns a new array — does not mutate input.
 * @param {number[]} floats
 * @returns {number[]}
 */
function encodePs(floats) {
  const n = floats.length;
  if (n < 2) return [];
  const out = new Array(n);
  let prevX = Math.round(floats[0] * PS_SCALE);
  let prevY = Math.round(floats[1] * PS_SCALE);
  out[0] = prevX;
  out[1] = prevY;
  for (let i = 2; i < n; i += 2) {
    const qx = Math.round(floats[i] * PS_SCALE);
    const qy = Math.round(floats[i + 1] * PS_SCALE);
    out[i] = qx - prevX;
    out[i + 1] = qy - prevY;
    prevX = qx;
    prevY = qy;
  }
  return out;
}

/**
 * Decode quantized delta-encoded sint32 array back to absolute float pixels.
 * @param {number[]} ints
 * @returns {number[]}
 */
function decodePs(ints) {
  const n = ints.length;
  if (n < 2) return [];
  const out = new Array(n);
  let accX = ints[0];
  let accY = ints[1];
  out[0] = accX / PS_SCALE;
  out[1] = accY / PS_SCALE;
  for (let i = 2; i < n; i += 2) {
    accX += ints[i];
    accY += ints[i + 1];
    out[i] = accX / PS_SCALE;
    out[i + 1] = accY / PS_SCALE;
  }
  return out;
}

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
    /** @type {number|null} */
    this._reconnectTimer = null;

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
      // Drawing events — must stay in receive order relative to each other.
      // KP/TEXT_APPLY must queue with MD/MU so remote text commits can't race
      // with stale or future pointer events.
      T.MM, T.MD, T.MU, T.KP, T.TEXT_APPLY, T.CP, T.CS, T.CT, T.CC,
      T.CSP, T.CSM, T.CHD, T.CBR, T.CL, T.CBM, T.CANCEL, T.CF,
      // Tool-parameter changes that affect how an in-progress stroke is rendered.
      // Must stay ordered with the drawing events above.
      T.CTHN, T.CSIM, T.GMP, T.GPT, T.CPM, T.CSDM,
      // Canvas-state operations that mutate the stroke history.
      // These MUST be queued so they execute AFTER any drawing events (MD/MM/MU)
      // that preceded them in real time.  If they bypass the queue they can
      // execute on a stale stroke stack while the tab is hidden (rAF-throttled),
      // causing a different stroke history than every other client (desync).
      T.UNDO, T.REDO, T.CLR, T.FILL,
      // Selection operations — all mutate canvas state in ways that must stay
      // ordered with the surrounding drawing events.
      T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL,
      T.SEL_STAMP, T.SEL_CANCEL, T.SEL_TO_BRUSH, T.SEL_FLIP, T.SEL_PENDING,
      // Image paste and async computation results must also respect draw order.
      T.IMG_PASTE, T.GLITCH_RESULT,
    ]);

    this.clientIdentity = new ClientIdentity();
  }

  _encodeChatImageDataUrl(imageData, maxBytes = 5 * 1024 * 1024) {
    if (typeof imageData !== 'string') {
      return { ok: false, error: 'Invalid chat image data' };
    }

    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(imageData);
    if (!match) {
      return { ok: false, error: 'Invalid chat image format' };
    }

    try {
      const base64Data = match[2].replace(/\s+/g, '');
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      if (bytes.length === 0) {
        return { ok: false, error: 'Chat image is empty' };
      }

      if (bytes.length > maxBytes) {
        return { ok: false, error: 'Chat image is too large' };
      }

      return { ok: true, bytes };
    } catch {
      return { ok: false, error: 'Failed to encode chat image' };
    }
  }

  /**
   * Lazy-loads the Protocol Buffer schema.
   * @returns {Promise<void>}
   */
  async loadProto() {
    if (this.protoLoaded) return;

    try {
      const protobuf = await import('protobufjs');
      const protoUrl = `../messages.proto?v=${Date.now()}`;
      const response = await fetch(protoUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch protobuf schema: ${response.status}`);
      }
      const protoSource = await response.text();
      console.log('[PROTO DEBUG] fetched from', response.url, 'size:', protoSource.length, 'has room_board_size?', protoSource.includes('room_board_size'));
      const root = protobuf.default.parse(protoSource).root;
      this.Msg = root.lookupType('Msg');
      this.protoLoaded = true;
      console.log('[PROTO DEBUG] room_board_size field in client Msg?',
        Object.keys(this.Msg.fields).filter(k => k.toLowerCase().includes('board')),
        'total fields:', Object.keys(this.Msg.fields).length);
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

    this._clearReconnectTimer();

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
    this._identityPayload = await this.clientIdentity.getPayload({ waitForFingerprintMs: 1200 });
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
        // In Vite dev we proxy WebSocket traffic through `/ws`, which keeps the
        // client aligned with the current origin instead of assuming the backend
        // is directly reachable at localhost:8000 from the browser.
        baseUrl = `${wsProtocol}://${window.location.host}/ws`;
      } else {
        baseUrl = import.meta.env.VITE_WS_SERVER_URL || `${wsProtocol}://${window.location.host}`;
      }
    }

    try {
      const url = new URL(baseUrl);
      if (this._roomId) {
        url.searchParams.set('room', this._roomId);
      }
      if (this._identityPayload?.clientDeviceId) {
        url.searchParams.set('deviceId', this._identityPayload.clientDeviceId);
      }
      if (this._identityPayload?.clientFingerprintId) {
        url.searchParams.set('fingerprintId', this._identityPayload.clientFingerprintId);
      }
      if (this._identityPayload?.clientIdentityJson) {
        url.searchParams.set('identity', this._identityPayload.clientIdentityJson);
      }
      this._url = url.toString();
    } catch (err) {
      this._url = baseUrl;
      if (this._roomId) {
        const separator = this._url.includes('?') ? '&' : '?';
        this._url += `${separator}room=${encodeURIComponent(this._roomId)}`;
      }
      const extraParams = [];
      if (this._identityPayload?.clientDeviceId) {
        extraParams.push(`deviceId=${encodeURIComponent(this._identityPayload.clientDeviceId)}`);
      }
      if (this._identityPayload?.clientFingerprintId) {
        extraParams.push(`fingerprintId=${encodeURIComponent(this._identityPayload.clientFingerprintId)}`);
      }
      if (this._identityPayload?.clientIdentityJson) {
        extraParams.push(`identity=${encodeURIComponent(this._identityPayload.clientIdentityJson)}`);
      }
      if (extraParams.length) {
        const separator = this._url.includes('?') ? '&' : '?';
        this._url += `${separator}${extraParams.join('&')}`;
      }
    }
  }

  /**
   * Initiates the connection attempt and sets up event listeners.
   * @private
   * @returns {void}
   */
  _tryConnect() {
    if (this._cancelled) return;
    this._clearReconnectTimer();
    if (this.socket && (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )) {
      return;
    }

    this._connectAttempts++;
    this.socket = new WebSocket(this._url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = async () => {
      this._clearReconnectTimer();
      this.connected = true;
      this._connectAttempts = 0;
      const username = this._userData.username || this._userData.name || '';
      const identityPayload = await this.clientIdentity.getPayload({ waitForFingerprintMs: 1200 });
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.send({ t: T.CONNECT, n: username, ...identityPayload });

      // Replay a recent bandwidth measurement so the new room/server has a
      // baseline before the next probe tick. Cached by _runProbe echo handler.
      try {
        const cached = JSON.parse(localStorage.getItem('topDrawUploadBps') || 'null');
        if (cached && typeof cached.bps === 'number' && cached.bps > 0) {
          const age = Date.now() - (cached.ts || 0);
          if (age < 10 * 60_000) {
            this.send({ t: T.BW_REPORT, uploadBps: Math.round(cached.bps) });
          }
        }
      } catch (_) {}
    };

    this.socket.onmessage = (event) => {
      try {
        const raw = new Uint8Array(event.data);

        if (raw.length > 4 && raw[0] !== 0x08) {
          this._decodeBatchedFrame(raw);
        } else {
          const data = this.Msg.decode(raw);
          // Reconstruct absolute float points from quantized deltas on the wire.
          if (Array.isArray(data.ps) && data.ps.length >= 2) {
            data.ps = decodePs(data.ps);
          }

          // Record decoded message for TimeMachine (JSON, not protobuf)
          if (window.app?.TimeMachine) {
            window.app.TimeMachine.recordAction(data, 'inbound');
          }

          this.handleMessage(data);
        }
      } catch (err) {
        console.error('Failed to decode message:', err);
      }
    };

    this.socket.onclose = (event) => {
      this.connected = false;
      if (this._shouldRetryConnect(event) && this.sessionIndex === null && this._connectAttempts < 10) {
        const delay = Math.min(1000 * this._connectAttempts, 5000);
        this._clearReconnectTimer();
        this._reconnectTimer = window.setTimeout(() => {
          this._reconnectTimer = null;
          this._tryConnect();
        }, delay);
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
   * Clears any pending reconnect timer.
   * @private
   * @returns {void}
   */
  _clearReconnectTimer() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Determines whether a closed connection should be retried automatically.
   * @private
   * @param {CloseEvent} event
   * @returns {boolean}
   */
  _shouldRetryConnect(event) {
    if (this._cancelled) return false;

    const nonRetryableCodes = new Set([
      1000, // Normal closure
      1008, // Policy violation / throttled before handshake
      4001, // Banned
      4002, // Kicked
      4003, // Room full
      4401, // Unauthorized
      4408  // Rate limit exceeded
    ]);

    return !nonRetryableCodes.has(event.code);
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
      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (isHidden) {
        const defer = typeof queueMicrotask === 'function'
          ? queueMicrotask
          : (fn) => Promise.resolve().then(fn);
        // Hidden tabs heavily throttle timers/rAF; drain promptly to avoid
        // multi-second remote stroke stalls and segment jumps.
        defer(() => this._processMessageQueue(true));
      } else {
        requestAnimationFrame(() => this._processMessageQueue(false));
      }
    }
  }

  /**
   * Decodes a length-delimited batched frame.
   * Instead of decoding all messages synchronously (which blocks the main
   * thread on slow devices), slices the raw bytes for each message and pushes
   * them into the queue as Uint8Arrays. They are decoded lazily under the
   * time budget in _processMessageQueue.
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
      // slice() copies the bytes so the original buffer can be GC'd after
      // the onmessage handler returns.
      this._messageQueue.push(raw.slice(offset, offset + len));
      offset += len;
    }
    this._scheduleProcessing();
  }

  /**
   * Processes queued messages within a fixed time budget per frame.
   * Items in the queue may be raw Uint8Arrays (from batched frames, decoded
   * here lazily) or pre-decoded message objects (from handleMessage).
   * @private
   * @returns {void}
   */
  _processMessageQueue(forceDrain = false) {
    this._processingScheduled = false;
    const BUDGET_MS = forceDrain ? Number.POSITIVE_INFINITY : 8;
    const start = performance.now();
    let processed = 0;

    while (this._messageQueue.length > 0) {
      const item = this._messageQueue.shift();

      let data;
      if (item instanceof Uint8Array) {
        try {
          data = this.Msg.decode(item);
          if (Array.isArray(data.ps) && data.ps.length >= 2) {
            data.ps = decodePs(data.ps);
          }
          if (window.app?.TimeMachine) {
            window.app.TimeMachine.recordAction(data, 'inbound');
          }
        } catch (err) {
          console.error('Failed to decode batched message:', err);
          processed++;
          if (!forceDrain && processed % 10 === 0 && performance.now() - start > BUDGET_MS) break;
          continue;
        }
      } else {
        data = item;
      }

      this._processMessage(data);
      processed++;

      if (!forceDrain && processed % 10 === 0 && performance.now() - start > BUDGET_MS) {
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
        this.send({
          t: T.PONG,
          lowPowerMode: this.getLowPowerMode ? !!this.getLowPowerMode() : false,
          tabHidden: typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false
        });
        break;

      case T.BW_PROBE_START:
        this._runProbe(data.probeId, data.probeTotal || 20, data.probeBlobSize || 30720);
        break;

      case T.BW_REPORT:
        // Server echoes our measured bps back so we can persist it across reconnects.
        if (data.uploadBps && data.uploadBps > 0) {
          try {
            localStorage.setItem('topDrawUploadBps', JSON.stringify({
              bps: data.uploadBps,
              ts: Date.now()
            }));
          } catch (_) {}
        }
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
          spacing: u.sp !== undefined ? u.sp / 100 : 0,
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
          simulatePressure: u.sim !== undefined ? u.sim === 2 : undefined,
          patternBrush: u.pb,
          patternScale: u.patternScale,
          patternShape: u.patternShape,
          patternName: u.patternName,
          font: normalizeTextFont(u.fo),
          textPositionMultiplier: u.tm,
          textPositionOffset: u.to,
          registeredName: u.rn || '',
          isMuted: !!u.mt,
          visibleIp: u.vip || ''
        }));
        this.emit('users', { users });
        break;

      case T.SETTINGS:
        let mirrorRegions = [];
        if (data.mirrorRegionsJson) {
          try {
            mirrorRegions = JSON.parse(data.mirrorRegionsJson);
          } catch (err) {
            console.warn('[WebSocketClient] Failed to parse mirror regions payload', err);
          }
        }
        this.emit('settings', {
          mirror: data.m,
          mirrorRegions,
          backgroundColor: data.roomBackgroundColor,
          locked: data.roomLocked,
          maxUsers: data.roomMaxUsers,
          modInactiveImmune: data.roomModInactiveImmune,
          joinPolicy: data.roomJoinPolicy || 'open',
          autoMuteGuests: !!data.roomAutoMuteGuests,
          autoMuteVpnUsers: !!data.roomAutoMuteVpnUsers,
          hideChatNotifications: !!data.roomHideChatNotifications,
          dedicatedReplayUser: data.roomDedicatedReplayUser || null,
          electedUploader: data.electedUploader || null,
          private: !!data.roomPrivate,
          floatingGallerySeed: data.roomFloatingGallerySeed || 0,
          floatingGalleryIncludeIds: Array.isArray(data.roomFloatingGalleryIncludeIds)
            ? data.roomFloatingGalleryIncludeIds
            : [],
          floatingGalleryExcludeIds: Array.isArray(data.roomFloatingGalleryExcludeIds)
            ? data.roomFloatingGalleryExcludeIds
            : [],
          boardSize: data.roomBoardSize || '1080p'
        });
        console.log('[SETTINGS DEBUG] received data.roomBoardSize =', JSON.stringify(data.roomBoardSize));
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
        this.emit('csp', { sessionIndex: data.u, spacing: data.sp !== undefined ? data.sp / 100 : 0 });
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
          simulatePressure: data.sim !== undefined ? data.sim === 2 : undefined,
          patternScale: data.patternScale,
          patternShape: data.patternShape,
          patternName: data.patternName
        });
        break;

      case T.KP:
        this.emit('kp', { sessionIndex: data.u, key: data.k });
        break;

      case T.TEXT_APPLY:
        this.emit('text_apply', {
          sessionIndex: data.u,
          text: data.g || '',
          position: {
            x: Array.isArray(data.ps) ? data.ps[0] : 0,
            y: Array.isArray(data.ps) ? data.ps[1] : 0
          },
          size: (data.s ?? 1000) / 100,
          color: unpackColor(data.c),
          opacity: (data.p ?? 100) / 100,
          layerIndex: data.ly ?? 0,
          blendMode: data.bm || 'source-over',
          font: normalizeTextFont(data.fo),
          textPositionMultiplier: data.tm,
          textPositionOffset: data.to
        });
        break;

      case T.CLR:
        this.emit('clr', { sessionIndex: data.u });
        break;

      case T.MIR:
        this.emit('mir', { sessionIndex: data.u });
        break;

      case T.MSG:
        this.emit('msg', { sessionIndex: data.u, message: data.g, messageId: data.chatMessageId });
        break;

      case T.STAFF_MSG:
        this.emit('staff_msg', { sessionIndex: data.u, message: data.g, messageId: data.chatMessageId });
        break;

      case T.GLOBAL_MESSAGE:
        this.emit('global_message', {
          message: data.g || '',
          kind: data.k || 'notice',
          issuer: data.n || 'Server',
          persistent: !!data.a
        });
        break;

      case T.DM:
        this.emit('dm', { sessionIndex: data.u, message: data.g, messageId: data.chatMessageId });
        break;

      case T.CHAT_IMG:
      case T.STAFF_CHAT_IMG:
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
        this.emit(data.t === T.STAFF_CHAT_IMG ? 'staff_chat_img' : 'chat_img', {
          sessionIndex: data.u,
          imageData: imageDataUrl,
          recipientId: hasOwnField(data, 'r') ? data.r : null,
          messageId: data.chatMessageId
        });
        break;

      case T.CHAT_REACTION:
        this.emit('chat_reaction', {
          sessionIndex: data.u,
          messageId: data.chatMessageId,
          emoji: data.chatReaction,
          remove: !!data.chatReactionRemove,
          recipientId: hasOwnField(data, 'r') ? data.r : null
        });
        break;

      case T.FLOATING_ART_UPDATE:
        try {
          const item = JSON.parse(data.fa);
          this.emit('floating_art_update', { item });
        } catch (err) {
          console.error('[FloatingArt] Failed to parse item:', err);
        }
        break;

      case T.GMP:
        this.emit('gmp', { sessionIndex: data.u, brushData: data.g });
        break;

      case T.GPT:
        this.emit('gpt', { sessionIndex: data.u, patternData: data.g });
        break;

      case T.CPM:
        this.emit('cpm', { sessionIndex: data.u, patternMode: data.pm });
        break;

      case T.CF:
        this.emit('cf', {
          sessionIndex: data.u,
          font: normalizeTextFont(data.fo),
          textPositionMultiplier: data.tm,
          textPositionOffset: data.to
        });
        break;

      case T.CSDM:
        this.emit('csdm', {
          sessionIndex: data.u,
          shapeDrawMode: data.sdm || 'corner-to-corner'
        });
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
          lassoPath,
          imageData: data.g || null
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

      case T.GLITCH_RESULT:
        this.emit('glitch_result', {
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
          providerSessionIndex: hasOwnField(data, 'u') ? data.u : null,
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
            backgroundColor: r.backgroundColor || '#ffffff',
            ownerId: r.ownerId || null,
            ownerUsername: r.ownerUsername || null,
            preview: r.preview || null
          }))
        });
        break;

      case T.ROOM_OWNERSHIP:
        this.emit('room_ownership', {
          ownerId: data.ownerId || null,
          ownerUsername: data.ownerUsername || null
        });
        break;

      case T.ROOM_ROLE_LIST_RESPONSE:
        this.emit('room_role_list', {
          entries: (data.roomRoles || []).map(entry => ({
            userId: entry.userId || '',
            username: entry.username || '',
            role: entry.role || 0,
            updatedBy: entry.updatedBy || '',
            updatedByUsername: entry.updatedByUsername || '',
            updatedAt: Number(entry.updatedAt || 0),
            previousRole: entry.previousRole || 0,
            changeType: entry.changeType || 'assigned',
            isOwner: !!entry.isOwner
          }))
        });
        break;

      case T.BOARD_SNAPSHOT_LIST_RESPONSE:
        this.emit('board_snapshot_list', { snapshotList: data.snapshotList || [] });
        break;

      case T.BOARD_SNAPSHOT_RESTORE:
        this.emit('board_snapshot_restore', {
          snapshotLayers: data.snapshotLayers,
          snapshotId: data.snapshotId,
          snapshotTs: data.snapshotTs,
          snapshotIssuer: data.snapshotIssuer
        });
        break;

      case T.BOARD_SNAPSHOT_REGION_RESTORE:
        this.emit('board_snapshot_region_restore', {
          snapshotLayers: data.snapshotLayers,
          snapshotId: data.snapshotId,
          isLasso: data.a,
          sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh,
          cr: data.cr
        });
        break;

      case T.BOARD_SNAPSHOT_JOIN_NOTIFY:
        this.emit('board_snapshot_join_notify', {
          snapshotId: data.snapshotId,
          snapshotTs: data.snapshotTs,
          snapshotIssuer: data.snapshotIssuer,
          snapshotThumb: data.snapshotThumb
        });
        break;

      case T.BOARD_SNAPSHOT_REQUEST:
        this.emit('board_snapshot_request');
        break;

      case T.BOARD_SNAPSHOT_SAVE:
        // Private response to a BOARD_SNAPSHOT_GET request (not a broadcast restore)
        if (data.snapshotId && !data.a) {
          this.emit('board_snapshot_get_response', {
            snapshotId: data.snapshotId,
            snapshotTs: data.snapshotTs,
            snapshotIssuer: data.snapshotIssuer,
            snapshotLayers: data.snapshotLayers
          });
        }
        break;

      case T.REPLAY_RESPONSE:
        this.emit('replay_response', {
          checkpointId: data.checkpointId || null,
          checkpointImg: data.checkpointImg || null,
          deltas: data.replayDeltasJson ? JSON.parse(data.replayDeltasJson) : []
        });
        break;

      case T.CHECKPOINT_LIST_RESPONSE:
        this.emit('checkpoint_list_response', {
          checkpoints: data.checkpointList || []
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
      // ps is transmitted as quantized delta-encoded sint32 on the wire.
      // Encode into a cloned payload so the original (absolute floats) reaches
      // TimeMachine unchanged.
      let encData = data;
      if (Array.isArray(data.ps) && data.ps.length >= 2) {
        encData = { ...data, ps: encodePs(data.ps) };
      }
      const message = this.Msg.create(encData);
      if (data.roomBoardSize !== undefined) {
        console.log('[SEND DEBUG] data.roomBoardSize =', JSON.stringify(data.roomBoardSize),
          ', message.roomBoardSize =', JSON.stringify(message.roomBoardSize),
          ', field in schema:', !!this.Msg.fields.roomBoardSize);
      }
      const buffer = this.Msg.encode(message).finish();
      this.socket.send(buffer);

      // Record outgoing messages for TimeMachine (JSON with sessionIndex)
      if (window.app?.TimeMachine && this.sessionIndex != null) {
        window.app.TimeMachine.recordAction({ ...data, u: this.sessionIndex }, 'outbound');
      }
    }
  }

  /**
   * Respond to a server bandwidth probe. Generates `total` random blobs of size
   * `blobSize` and pushes them back-to-back. Server times from first chunk arrival
   * to last and derives bytes/sec.
   * @param {string} probeId
   * @param {number} total
   * @param {number} blobSize
   * @private
   */
  _runProbe(probeId, total, blobSize) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.Msg) return;
    if (!probeId || total <= 0 || blobSize <= 0) return;

    for (let seq = 0; seq < total; seq++) {
      const bytes = new Uint8Array(blobSize);
      // Random data is required: compressible/zeroed buffers would inflate
      // measured throughput on connections that use WebSocket compression.
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        // getRandomValues has a 64KB quota — chunk if needed
        const MAX = 65536;
        for (let off = 0; off < blobSize; off += MAX) {
          crypto.getRandomValues(bytes.subarray(off, Math.min(off + MAX, blobSize)));
        }
      }
      const message = this.Msg.create({
        t: T.BW_PROBE_CHUNK,
        probeId,
        probeSeq: seq,
        probeData: bytes
      });
      this.socket.send(this.Msg.encode(message).finish());
    }
  }

  /**
   * Returns the best currently-available identity payload without waiting.
   * This keeps auth messages from being dropped during reconnect races.
   * @returns {Object}
   */
  _getImmediateIdentityPayload() {
    return {
      clientDeviceId: this.clientIdentity.deviceId || '',
      clientFingerprintId: this.clientIdentity.cachedFingerprintId || '',
      clientIdentityJson: this.clientIdentity.cachedIdentityJson || '',
      client_device_id: this.clientIdentity.deviceId || '',
      client_fingerprint_id: this.clientIdentity.cachedFingerprintId || '',
      client_identity_json: this.clientIdentity.cachedIdentityJson || '',
    };
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
   * Broadcasts eraser scope mode changes while preserving current tool state.
   * @param {boolean} eraseAll - True to erase all layers, false for active layer only.
   * @param {string} [tool='erase'] - Current local tool to preserve for peers.
   * @returns {void}
   */
  broadcastEraserModeChange(eraseAll, tool = 'erase') {
    this.send({ t: T.CT, l: ToolToEnum[tool] || 0, a: !!eraseAll });
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
   * Broadcasts an explicit text application payload.
   * @param {Object} payload - Fully specified text draw payload.
   * @returns {void}
   */
  broadcastTextApply(payload) {
    if (!payload?.text) return;
    this.send({
      t: T.TEXT_APPLY,
      g: payload.text,
      ps: [payload.x, payload.y],
      s: Math.round((payload.size ?? 10) * 100),
      c: packColor(payload.color),
      p: Math.round((payload.opacity ?? 1) * 100),
      ly: payload.layerIndex ?? 0,
      bm: payload.blendMode || 'source-over',
      fo: payload.font,
      tm: payload.textPositionMultiplier ?? 0,
      to: payload.textPositionOffset ?? 0
    });
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
   * Broadcasts a mirror region creation/update payload.
   * @param {Object} payload
   * @returns {void}
   */
  broadcastMirrorRegion(payload) {
    this.send({
      t: T.MIRROR_REGION,
      mirrorRegionsJson: JSON.stringify(payload)
    });
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
  broadcastChat(message, messageId) {
    this.send({ t: T.MSG, g: message, chatMessageId: messageId });
  }

  /**
   * Broadcasts a staff-only chat message.
   * @param {string} message
   * @param {string} messageId
   * @returns {void}
   */
  broadcastStaffChat(message, messageId) {
    this.send({ t: T.STAFF_MSG, g: message, chatMessageId: messageId });
  }

  /**
   * Broadcasts a staff-only image.
   * @param {string} imageData
   * @param {string} messageId
   * @returns {{ok: boolean, error?: string}}
   */
  broadcastStaffChatImage(imageData, messageId = '') {
    const encoded = this._encodeChatImageDataUrl(imageData);
    if (!encoded.ok) return encoded;
    this.send({ t: T.STAFF_CHAT_IMG, cimg: encoded.bytes, chatMessageId: messageId });
    return { ok: true };
  }

  /**
   * Broadcasts an image to the chat or a specific user.
   * @param {string} imageData - Base64 encoded image data URL.
   * @param {number|null} [recipientId=null] - Optional private recipient.
   * @returns {{ok: boolean, error?: string}}
   */
  broadcastChatImage(imageData, recipientId = null, messageId = '') {
    const encoded = this._encodeChatImageDataUrl(imageData);
    if (!encoded.ok) return encoded;

    if (recipientId !== null) {
      this.send({ t: T.CHAT_IMG, cimg: encoded.bytes, r: recipientId, chatMessageId: messageId });
    } else {
      this.send({ t: T.CHAT_IMG, cimg: encoded.bytes, chatMessageId: messageId });
    }
    return { ok: true };
  }

  /**
   * Broadcasts a private message to a specific user.
   * @param {string} message - Message text.
   * @param {number} recipientId - Recipient session index.
   * @returns {void}
   */
  broadcastDM(message, recipientId, messageId) {
    this.send({ t: T.DM, g: message, r: recipientId, chatMessageId: messageId });
  }

  /**
   * Broadcasts a chat reaction toggle.
   * @param {{messageId: string, emoji: string, remove?: boolean, recipientId?: number|null}} payload
   * @returns {void}
   */
  broadcastChatReaction({ messageId, emoji, remove = false, recipientId = null }) {
    const message = {
      t: T.CHAT_REACTION,
      chatMessageId: messageId,
      chatReaction: emoji,
      chatReactionRemove: remove
    };
    if (recipientId !== null && recipientId !== undefined) {
      message.r = recipientId;
    }
    this.send(message);
  }

  /**
   * Broadcasts a custom brush configuration.
   * @param {Object} brushData - Brush settings object.
   * @returns {void}
   */
  broadcastBrush(brushData) {
    this.send({ t: T.GMP, g: JSON.stringify(brushData) });
  }

  broadcastPatternBrush(patternData) {
    this.send({ t: T.GPT, g: JSON.stringify(patternData) });
  }

  /**
   * Broadcasts pattern mode toggle (for fill/select pattern fills).
   * @param {boolean} enabled - Whether pattern mode is enabled.
   * @returns {void}
   */
  broadcastPatternMode(enabled) {
    this.send({ t: T.CPM, pm: enabled });
  }

  /**
   * Broadcasts shape draw mode change.
   * @param {string} mode - 'corner-to-corner' or 'center-scaling'.
   * @returns {void}
   */
  broadcastShapeDrawModeChange(mode) {
    this.send({ t: T.CSDM, sdm: mode });
  }

  /**
   * Broadcasts a font change.
   * @param {string} font - The new font family.
   * @returns {void}
   */
  broadcastFontChange(font, textPositionMultiplier, textPositionOffset) {
    this.send({
      t: T.CF,
      fo: font,
      tm: textPositionMultiplier,
      to: textPositionOffset
    });
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
      msg.cr = lassoPath.flatMap(p => [p.x, p.y]);
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
      msg.ps = lassoPath.flatMap(p => [p.x, p.y]);
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
   * Broadcasts a computed glitch blur result image for deterministic sync.
   * @param {number} x - Top-left X of the blur region.
   * @param {number} y - Top-left Y of the blur region.
   * @param {number} width - Width of the blur region.
   * @param {number} height - Height of the blur region.
   * @param {string} dataUrl - Base64 PNG data URL of the blur result.
   */
  broadcastGlitchResult(x, y, width, height, dataUrl) {
    this.send({
      t: T.GLITCH_RESULT,
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
    const identityPayload = this._getImmediateIdentityPayload();
    const msg = { t: T.AUTH_REGISTER, authUsername: username, authPassword: password, ...identityPayload };
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
    const identityPayload = this._getImmediateIdentityPayload();
    this.send({ t: T.AUTH_LOGIN, authUsername: username, authPassword: password, ...identityPayload });
  }

  /**
   * Sends an authentication token login request.
   * @param {string} token - JWT or session token.
   * @returns {void}
   */
  sendAuthTokenLogin(token) {
    const identityPayload = this._getImmediateIdentityPayload();
    this.send({ t: T.AUTH_LOGIN, authToken: token, ...identityPayload });
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
   * Sends a revoke request for an existing moderation entry.
   * `modReason` is repurposed here to carry the entry id for revoke actions.
   * @param {number} actionType - 3=unmute, 4=unban
   * @param {string} entryId - Moderation entry id to revoke
   * @param {string} [targetName] - Target username for UI notifications/fallback lookup
   * @returns {void}
   */
  sendModRevoke(actionType, entryId, targetName = '') {
    this.send({
      t: T.MOD_ACTION,
      modActionType: actionType,
      modTargetName: targetName || '',
      modReason: entryId || ''
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
  sendRoomRoleSet(targetSessionIndex, role, targetUsername = '') {
    this.send({
      t: T.ROOM_ROLE_SET,
      roomRoleTargetId: String(targetSessionIndex || ''),
      roomRoleTargetName: targetUsername || '',
      roomRoleValue: role
    });
  }

  /**
   * Sets a user's global role (User/Noble/Holy). DEITY only.
   * @param {string} targetUsername - The target user's username.
   * @param {number} newGlobalRole - The new global role (1=User, 7=Noble, 8=Holy).
   */
  sendGlobalRoleSet(targetUsername, newGlobalRole) {
    this.send({
      t: T.GLOBAL_ROLE_SET,
      targetUsername: targetUsername,
      newGlobalRole: newGlobalRole
    });
  }

  sendGlobalMessage(message, { kind = 'staff', persistent = false } = {}) {
    this.send({
      t: T.GLOBAL_MESSAGE,
      g: message,
      k: kind,
      a: !!persistent
    });
  }

  /**
   * Requests the moderation roster for the current room.
   * @returns {void}
   */
  requestRoomRoleList() {
    this.send({ t: T.ROOM_ROLE_LIST_REQUEST });
  }

  /**
   * Requests the list of active rooms from the server.
   * @returns {void}
   */
  requestRoomList() {
    this.send({ t: T.ROOM_LIST_REQUEST });
  }

  /**
   * Sends a room preview image to the server.
   * @param {Uint8Array} imageData - PNG image data at 1/4 scale
   * @returns {void}
   */
  broadcastRoomPreview(imageData) {
    this.send({ t: T.ROOM_PREVIEW, img: imageData });
  }

  broadcastCheckpoint(imageData) {
    this.send({ t: T.CHECKPOINT_UPLOAD, checkpointImg: imageData });
  }

  requestReplay(startTs, endTs) {
    this.send({ t: T.REPLAY_REQUEST, replayStartTs: startTs, replayEndTs: endTs });
  }

  requestCheckpointList() {
    this.send({ t: T.CHECKPOINT_LIST });
  }

  requestSnapshotGet(snapshotId) {
    this.send({ t: T.BOARD_SNAPSHOT_GET, snapshotId });
  }

  /**
   * Closes the WebSocket connection.
   * @returns {void}
   */
  disconnect() {
    this._cancelled = true;
    this._clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { T, Tool, ToolNames, ToolToEnum, packColor, unpackColor };
