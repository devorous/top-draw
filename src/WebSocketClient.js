/**
 * WebSocket client for real-time communication with optimized protobuf
 */
import protobuf from 'protobufjs';

// Message type enum matching proto
const T = {
  CONNECT: 0, USERS: 1, SETTINGS: 2, LEFT: 3,
  MM: 10, MD: 11, MU: 12, CP: 13, CS: 14, CT: 15, CC: 16,
  CSP: 17, CN: 18, KP: 19, CLR: 20, MIR: 21, MSG: 22, GMP: 23, AFK: 24, PAN: 25, CANCEL: 26,
  HIDE_CURSOR: 27, SHOW_CURSOR: 28, CSM: 29,
  SEL_LIFT: 30, SEL_MOVE: 31, SEL_COMMIT: 32, SEL_DELETE: 33, SEL_FILL: 34, SEL_STAMP: 35, SEL_CANCEL: 36, SEL_TO_BRUSH: 37, IMG_PASTE: 38,
  SYNC_REQUEST: 40, SYNC_PROVIDE: 41, SYNC_CANVAS: 42, SYNC_COMPLETE: 43
};

// Tool enum matching proto
const Tool = { 
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3,
  SELECT: 4, PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8 
};

const ToolNames = [
  'brush', 'text', 'erase', 'imageBrush',
  'select', 'pen', 'line', 'rectangle', 'circle'
];
const ToolToEnum = { 
  brush: 0, text: 1, erase: 2, imageBrush: 3,
  select: 4, pen: 5, line: 6, rectangle: 7, circle: 8 
};

// Helper: Pack RGBA array to fixed32
// Note: RGB values are 0-255, but alpha is 0-1 (from color picker)
function packColor(rgba) {
  if (!rgba || rgba.length < 4) return 0xFF000000;
  const alpha = Math.round(rgba[3] * 255); // Convert 0-1 to 0-255
  return ((rgba[0] & 0xFF) << 24) | ((rgba[1] & 0xFF) << 16) |
         ((rgba[2] & 0xFF) << 8) | (alpha & 0xFF);
}

// Helper: Unpack fixed32 to RGBA array
// Note: Returns alpha as 0-1 (app expects this format)
function unpackColor(packed) {
  return [
    (packed >>> 24) & 0xFF,
    (packed >>> 16) & 0xFF,
    (packed >>> 8) & 0xFF,
    ((packed & 0xFF) / 255) // Convert 0-255 back to 0-1
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
          spacing: (u.sp ?? 0) / 100,
          smoothing: (u.sm ?? 3000) / 100,
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
          ps: data.ps || []
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
        this.emit('csp', { sessionIndex: data.u, spacing: (data.sp ?? 0) / 100 });
        break;

      case T.CSM:
        this.emit('csm', { sessionIndex: data.u, smoothing: (data.sm ?? 3000) / 100 });
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
        this.emit('sel_lift', {
          sessionIndex: data.u,
          selection: { x: data.sx, y: data.sy, width: data.sw, height: data.sh }
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

  broadcastMove(points) {
  // 'ps' is the repeated uint32 field from protobuf
  this.send({ 
    t: T.MM, 
    ps: points 
  });
}
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

  broadcastSmoothingChange(smoothing) {
    this.send({ t: T.CSM, sm: Math.round(smoothing * 100) });
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

  broadcastChat(message) {
    this.send({ t: T.MSG, g: message });
  }

  broadcastBrush(brushData) {
    this.send({ t: T.GMP, g: JSON.stringify(brushData) });
  }

/**
 * Tells others to "lift" pixels from their local canvas.
 */
broadcastSelectionLift(rect) {
  this.send({
    t: T.SEL_LIFT,
    sx: Math.round(rect.x),
    sy: Math.round(rect.y),
    sw: Math.round(rect.width),
    sh: Math.round(rect.height)
  });
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
 */
requestSync() {
  this.send({ t: T.SYNC_REQUEST });
}

/**
 * Send full canvas data to server (in response to SYNC_PROVIDE)
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

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

export { T, Tool, ToolNames, ToolToEnum, packColor, unpackColor };
