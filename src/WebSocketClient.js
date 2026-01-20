/**
 * WebSocket client for real-time communication with optimized protobuf
 */
import protobuf from 'protobufjs';

// Message type enum matching proto
const T = {
  CONNECT: 0, USERS: 1, SETTINGS: 2, LEFT: 3,
  MM: 10, MD: 11, MU: 12, CP: 13, CS: 14, CT: 15, CC: 16,
  CSP: 17, CN: 18, KP: 19, CLR: 20, MIR: 21, MSG: 22, GMP: 23, AFK: 24, PAN: 25
};

// Tool enum matching proto
const Tool = { BRUSH: 0, TEXT: 1, ERASE: 2, GIMP: 3 };
const ToolNames = ['brush', 'text', 'erase', 'gimp'];
const ToolToEnum = { brush: 0, text: 1, erase: 2, gimp: 3 };

// Helper: Pack RGBA array to fixed32
function packColor(rgba) {
  if (!rgba || rgba.length < 4) return 0xFF000000;
  return ((rgba[0] & 0xFF) << 24) | ((rgba[1] & 0xFF) << 16) |
         ((rgba[2] & 0xFF) << 8) | (rgba[3] & 0xFF);
}

// Helper: Unpack fixed32 to RGBA array
function unpackColor(packed) {
  return [
    (packed >>> 24) & 0xFF,
    (packed >>> 16) & 0xFF,
    (packed >>> 8) & 0xFF,
    packed & 0xFF
  ];
}

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
  }

  async loadProto() {
    if (this.protoLoaded) return;

    try {
      const baseUrl = import.meta.env.BASE_URL || '/';
      const protoUrl = `${baseUrl}messages.proto`.replace('//', '/');
      console.log('Loading protobuf from:', protoUrl);
      const root = await protobuf.load(protoUrl);
      this.Msg = root.lookupType('Msg');
      this.protoLoaded = true;
      console.log('Protobuf loaded on client');
    } catch (err) {
      console.error('Failed to load protobuf:', err);
      throw err;
    }
  }

  async connect(userData) {
    await this.loadProto();

    let url;
    if (this.serverUrl) {
      url = this.serverUrl;
    } else {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      if (import.meta.env.DEV) {
        url = `${wsProtocol}://${window.location.host}/ws`;
      } else {
        url = import.meta.env.VITE_WS_SERVER_URL || `${wsProtocol}://${window.location.host}`;
      }
    }

    console.log('Connecting to WebSocket:', url);
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = () => {
      this.connected = true;
      console.log('WebSocket connected, sending CONNECT');

      // Send connect with optional name
      this.send({ t: T.CONNECT, n: userData.name || '' });
    };

    this.socket.onmessage = (event) => {
      try {
        const data = this.Msg.decode(new Uint8Array(event.data));
        this.handleMessage(data);
      } catch (err) {
        console.error('Failed to decode message:', err);
      }
    };

    this.socket.onclose = (event) => {
      this.connected = false;
      console.log('WebSocket disconnected:', event.code, event.reason);
      if (this.onDisconnect) {
        this.onDisconnect();
      }
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleMessage(data) {
    switch (data.t) {
      case T.CONNECT:
        // Server assigned us a session index
        this.sessionIndex = data.u;
        console.log('Assigned session index:', this.sessionIndex);
        if (this.onConnect) {
          this.onConnect(this.sessionIndex);
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
          size: (u.s || 1000) / 100,
          spacing: (u.sp || 10) / 100,
          pressure: (u.p || 100) / 100,
          name: u.n || '',
          text: u.tx || ''
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
          x: data.x,
          y: data.y,
          lastx: data.x - (data.dx || 0),
          lasty: data.y - (data.dy || 0)
        });
        break;

      case T.MD:
        this.emit('md', { sessionIndex: data.u });
        break;

      case T.MU:
        this.emit('mu', { sessionIndex: data.u });
        break;

      case T.CP:
        this.emit('cp', { sessionIndex: data.u, pressure: (data.p || 100) / 100 });
        break;

      case T.CS:
        this.emit('cs', { sessionIndex: data.u, size: (data.s || 1000) / 100 });
        break;

      case T.CT:
        this.emit('ct', { sessionIndex: data.u, tool: ToolNames[data.l] || 'brush' });
        break;

      case T.CC:
        this.emit('cc', { sessionIndex: data.u, color: unpackColor(data.c) });
        break;

      case T.CSP:
        this.emit('csp', { sessionIndex: data.u, spacing: (data.sp || 10) / 100 });
        break;

      case T.CN:
        this.emit('cn', { sessionIndex: data.u, name: data.n });
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

      case T.GMP:
        this.emit('gmp', { sessionIndex: data.u, gimpData: data.g });
        break;

      case T.PAN:
        this.emit('pan', { sessionIndex: data.u, panning: data.a });
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
      const message = this.Msg.create(data);
      const buffer = this.Msg.encode(message).finish();
      this.socket.send(buffer);
    }
  }

  // Broadcast methods
  broadcastMouseMove(x, y, lastx, lasty) {
    this.send({
      t: T.MM,
      x: Math.round(x),
      y: Math.round(y),
      dx: Math.round(x - lastx),
      dy: Math.round(y - lasty)
    });
  }

  broadcastMouseDown() {
    this.send({ t: T.MD });
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

  broadcastPressureChange(pressure) {
    this.send({ t: T.CP, p: Math.round(pressure * 100) });
  }

  broadcastNameChange(name) {
    this.send({ t: T.CN, n: name });
  }

  broadcastKeyPress(key) {
    this.send({ t: T.KP, k: key });
  }

  broadcastPan(value) {
    this.send({ t: T.PAN, a: value });
  }

  broadcastClear() {
    this.send({ t: T.CLR });
  }

  broadcastMirror() {
    this.send({ t: T.MIR });
  }

  broadcastChat(message) {
    this.send({ t: T.MSG, g: message });
  }

  broadcastGimp(gimpData) {
    this.send({ t: T.GMP, g: JSON.stringify(gimpData) });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { T, Tool, ToolNames, ToolToEnum, packColor, unpackColor };
