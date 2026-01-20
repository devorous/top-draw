import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;
const AFK_TIMEOUT = 2 * 60 * 1000;
const AFK_CHECK_INTERVAL = 30 * 1000;

const server = createServer();
const wss = new WebSocketServer({ server });

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

// Session management
const sessions = new Map();  // odlUserId -> sessionIndex
const users = new Map();     // sessionIndex -> userData
let nextSessionIndex = 0;
const freedIndices = [];     // Reusable indices from disconnected users

const boardSettings = { mirror: false };

let Msg;

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

// Allocate session index for new user
function allocateSessionIndex() {
  if (freedIndices.length > 0) {
    return freedIndices.pop();
  }
  return nextSessionIndex++;
}

// Free session index when user disconnects
function freeSessionIndex(index) {
  freedIndices.push(index);
}

async function init() {
  const protoPath = path.join(__dirname, '..', 'public', 'messages.proto');
  const root = await protobuf.load(protoPath);
  Msg = root.lookupType('Msg');
  console.log('Protobuf loaded');

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket server running on port ${PORT}`);
  });
}

function broadcast(payload, excludeIndex = null) {
  const message = Msg.create(payload);
  const buffer = Msg.encode(message).finish();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionIndex !== excludeIndex) {
      client.send(buffer);
    }
  });
}

function broadcastToAll(payload) {
  const message = Msg.create(payload);
  const buffer = Msg.encode(message).finish();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buffer);
    }
  });
}

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    const message = Msg.create(payload);
    ws.send(Msg.encode(message).finish());
  }
}

function updateUserActivity(sessionIndex) {
  const user = users.get(sessionIndex);
  if (user) {
    const wasAfk = user.afk;
    user.lastActivity = Date.now();
    user.afk = false;

    if (wasAfk) {
      broadcastToAll({ t: T.AFK, u: sessionIndex, a: false });
    }
  }
}

function checkAfkUsers() {
  const now = Date.now();
  users.forEach((user, sessionIndex) => {
    if (!user.afk && user.lastActivity && (now - user.lastActivity > AFK_TIMEOUT)) {
      user.afk = true;
      broadcastToAll({ t: T.AFK, u: sessionIndex, a: true });
      console.log(`User ${sessionIndex} marked as AFK`);
    }
  });
}

setInterval(checkAfkUsers, AFK_CHECK_INTERVAL);

function handleBroadcast(data, sessionIndex) {
  const user = users.get(sessionIndex);
  if (!user) return;

  switch (data.t) {
    case T.MM:
      user.x = data.x;
      user.y = data.y;
      // Reconstruct last positions from deltas
      user.lastx = data.x - (data.dx || 0);
      user.lasty = data.y - (data.dy || 0);
      updateUserActivity(sessionIndex);
      break;
    case T.MD:
      user.mousedown = true;
      updateUserActivity(sessionIndex);
      break;
    case T.MU:
      user.mousedown = false;
      if (user.tool === Tool.TEXT) {
        user.text = '';
      }
      break;
    case T.CS:
      user.size = data.s;
      break;
    case T.CSP:
      user.spacing = data.sp;
      break;
    case T.CP:
      user.pressure = data.p;
      break;
    case T.CT:
      user.tool = data.l;
      user.text = '';
      break;
    case T.CC:
      user.color = data.c;
      break;
    case T.CN:
      user.name = data.n;
      updateUserActivity(sessionIndex);
      break;
    case T.KP:
      const key = data.k;
      if (key && key.length === 1) {
        user.text = (user.text || '') + key;
      }
      if (key === 'Enter') {
        user.text = '';
      } else if (key === 'Backspace' && user.text) {
        user.text = user.text.slice(0, -1);
      }
      updateUserActivity(sessionIndex);
      break;
    case T.MIR:
      boardSettings.mirror = !boardSettings.mirror;
      break;
    case T.MSG:
      updateUserActivity(sessionIndex);
      break;
  }

  // Relay to other clients
  broadcast({ ...data, u: sessionIndex }, sessionIndex);
}

wss.on('connection', (ws, req) => {
  ws.on('message', (rawData) => {
    try {
      const data = Msg.decode(new Uint8Array(rawData));

      switch (data.t) {
        case T.CONNECT:
          const sessionIndex = allocateSessionIndex();
          ws.sessionIndex = sessionIndex;

          const newUser = {
            sessionIndex,
            afk: false,
            lastActivity: Date.now(),
            x: 0, y: 0, lastx: 0, lasty: 0,
            mousedown: false,
            tool: Tool.BRUSH,
            color: packColor([0, 0, 0, 255]),
            size: 1000,      // 10.00 * 100
            spacing: 10,     // 0.10 * 100
            pressure: 100,   // 1.00 * 100
            name: data.n || '',
            text: ''
          };
          users.set(sessionIndex, newUser);

          console.log('Connected:', sessionIndex, '| Users:', users.size);

          // Send session index back to connecting user
          sendTo(ws, { t: T.CONNECT, u: sessionIndex });

          // Send current users to all
          broadcastToAll({
            t: T.USERS,
            us: Array.from(users.values()).map(u => ({
              u: u.sessionIndex,
              a: u.afk,
              x: u.x,
              y: u.y,
              l: u.tool,
              c: u.color,
              s: u.size,
              sp: u.spacing,
              p: u.pressure,
              n: u.name,
              tx: u.text
            }))
          });

          // Send board settings to new user
          sendTo(ws, { t: T.SETTINGS, m: boardSettings.mirror });
          break;

        default:
          // All other messages are broadcasts
          if (ws.sessionIndex !== undefined) {
            handleBroadcast(data, ws.sessionIndex);
          }
          break;
      }
    } catch (err) {
      console.error('Error decoding message:', err);
    }
  });

  ws.on('close', () => {
    const sessionIndex = ws.sessionIndex;
    if (sessionIndex !== undefined) {
      console.log('Disconnected:', sessionIndex);
      users.delete(sessionIndex);
      freeSessionIndex(sessionIndex);

      broadcast({ t: T.LEFT, u: sessionIndex });

      console.log('Current users:', users.size);

      if (users.size === 0) {
        boardSettings.mirror = false;
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

init().catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});
