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
  CSP: 17, CN: 18, KP: 19, CLR: 20, MIR: 21, MSG: 22, GMP: 23, AFK: 24, PAN: 25, CANCEL: 26,
  SEL_LIFT: 30, SEL_MOVE: 31, SEL_COMMIT: 32,
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

// Session management
const sessions = new Map();  // odlUserId -> sessionIndex
const users = new Map();     // sessionIndex -> userData
let nextSessionIndex = 0;
const freedIndices = [];     // Reusable indices from disconnected users

const boardSettings = { mirror: false };

// Track pending sync requests: requestingUserIndex -> true
const pendingSyncRequests = new Map();

let Msg;

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
      if (data.ps && data.ps.length >= 2) {
        // Update user state to the LAST point in the batch for continuity
        const len = data.ps.length;
        user.lastx = user.x; // Old position is now last
        user.lasty = user.y;
        user.x = data.ps[len - 2]; // Second to last element is X
        user.y = data.ps[len - 1]; // Last element is Y
      }
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
            color: packColor([0, 0, 0, 1]),
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

        case T.SYNC_REQUEST:
          // New user wants canvas state - find an existing user to provide it
          console.log(`[Sync] User ${ws.sessionIndex} requested sync`);

          // Find another connected user to provide the canvas
          let providerFound = false;
          for (const [sessionIndex, userData] of users) {
            if (sessionIndex !== ws.sessionIndex) {
              // Found another user - ask them to provide canvas
              console.log(`[Sync] Asking user ${sessionIndex} to provide canvas for user ${ws.sessionIndex}`);

              // Track this pending request
              pendingSyncRequests.set(ws.sessionIndex, true);

              // Find the provider's WebSocket and send SYNC_PROVIDE
              for (const client of wss.clients) {
                if (client.sessionIndex === sessionIndex && client.readyState === WebSocket.OPEN) {
                  sendTo(client, {
                    t: T.SYNC_PROVIDE,
                    tu: ws.sessionIndex  // Tell provider who needs the canvas
                  });
                  providerFound = true;
                  break;
                }
              }
              break;
            }
          }

          if (!providerFound) {
            // No other users - just send sync complete (empty canvas)
            console.log(`[Sync] No other users, sending empty sync complete to user ${ws.sessionIndex}`);
            sendTo(ws, { t: T.SYNC_COMPLETE });
          }
          break;

        case T.SYNC_CANVAS:
          // User is providing canvas data - forward to the target user
          const targetUser = data.tu;
          console.log(`[Sync] User ${ws.sessionIndex} providing canvas for user ${targetUser}`);

          // Find the target user's WebSocket and forward the canvas
          for (const client of wss.clients) {
            if (client.sessionIndex === targetUser && client.readyState === WebSocket.OPEN) {
              sendTo(client, {
                t: T.SYNC_CANVAS,
                u: ws.sessionIndex,
                img: data.img
              });

              // Send sync complete to target
              sendTo(client, { t: T.SYNC_COMPLETE });

              // Clear pending request
              pendingSyncRequests.delete(targetUser);
              console.log(`[Sync] Canvas forwarded to user ${targetUser}, sync complete`);
              break;
            }
          }
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
        pendingSyncRequests.clear();
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
