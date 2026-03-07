import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB, getDB } from './db.js';
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth.js';
import { issueModAction, revokeModAction, getActiveModEntries, obfuscateIp, checkBan, checkMute } from './moderation.js';
import { T, Tool, ToolNames, ToolToEnum } from '../shared/MessageTypes.js';
import { packColor, unpackColor } from '../shared/ColorUtils.js';
import { SessionManager, Role } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { RoomManager } from './RoomManager.js';
import { sanitizeMessage } from './validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;

const server = createServer((req, res) => {
  // Handle HTTP requests (health check, debugging)
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }
  // For WebSocket upgrade requests, do nothing - ws library handles them
  res.writeHead(200);
  res.end();
});

// Add error handlers
server.on('error', (err) => {
  console.error('[HTTP Server] Error:', err);
});

const wss = new WebSocketServer({ server });

wss.on('error', (err) => {
  console.error('[WebSocket Server] Error:', err);
});

let Msg;
let POOLED_MSG;
let roomManager;

// Extract client IP, handling X-Forwarded-For for proxies (Koyeb)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

// Username validation: 3-20 chars, alphanumeric + underscores
function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{2,20}$/.test(username);
}

async function init() {
  // Connect to MongoDB (non-fatal if not configured)

  const protoPath = path.join(__dirname, '..', 'public', 'messages.proto');
  const root = await protobuf.load(protoPath); // Assign to a local 'root'
  Msg = root.lookupType('Msg');
  POOLED_MSG = Msg.create();

  try {
    await connectDB();
  } catch (err) {
    console.warn('[Server] Starting without database — auth/moderation disabled');
    console.log(err);
  }

  // Initialize room manager
  roomManager = new RoomManager(wss, sendTo);
  roomManager.setMsgEncoder(Msg, createRoomBroadcaster);
  console.log('[Server] RoomManager initialized');

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket server running on port ${PORT}`);
  });
}
function broadcast(payload, excludeIndex = null) {
  // Clear old data to prevent "ghost" properties from previous messages
  for (let key in POOLED_MSG) { if (POOLED_MSG.hasOwnProperty(key)) delete POOLED_MSG[key]; }
  Object.assign(POOLED_MSG, payload);

  const buffer = Msg.encode(POOLED_MSG).finish();

  let sentCount = 0;
  let skippedSender = false;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeIndex != null && client.sessionIndex == excludeIndex) {
        skippedSender = true;
        return;
      }
      client.send(buffer);
      sentCount++;
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

// Broadcast to all clients in a specific room (used by SessionManager)
function createRoomBroadcaster(room) {
  return (payload) => {
    const message = Msg.create(payload);
    const buffer = Msg.encode(message).finish();

    room.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(buffer);
      }
    });
  };
}

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    const message = Msg.create(payload);
    ws.send(Msg.encode(message).finish());
  }
}


// Message types blocked for muted users (drawing + chat + cursor movement)
const MUTED_BLOCKED = new Set([
  T.MM, T.MD, T.MU, T.KP, T.CLR,
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL, T.SEL_STAMP, T.SEL_CANCEL, T.SEL_TO_BRUSH,
  T.IMG_PASTE, T.MSG, T.DM, T.CHAT_IMG
]);

async function handleBroadcast(data, sessionIndex, room) {
  if (!room) return;
  const user = room.sessionManager.getUser(sessionIndex);
  if (!user) return;

  switch (data.t) {
    case T.MM: // Mouse move — data.ps is a flat [x1,y1,x2,y2,...] point stream batched per tick
      if (data.ps && data.ps.length >= 2) {
        // Track the last position so late-joining clients get accurate cursor placement in USERS list
        const len = data.ps.length;
        user.lastx = user.x;
        user.lasty = user.y;
        user.x = data.ps[len - 2];
        user.y = data.ps[len - 1];
      }
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.MD: // Mouse down — marks user as actively drawing
      user.mousedown = true;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.MU: // Mouse up — stroke ended; clear text tool buffer (text commits on pointer up)
      user.mousedown = false;
      if (user.tool === Tool.TEXT) {
        user.text = '';
      }
      break;

    case T.CS: // Change size — data.s is size * 100 (e.g. 1000 = 10px)
      user.size = data.s;
      break;

    case T.CSP: // Change spacing — data.sp is spacing * 100 (e.g. 10 = 0.10 = 10% of brush diameter)
      user.spacing = data.sp;
      break;

    case T.CSM: // Change smoothing — data.sm is 0-50 integer
      user.smoothing = data.sm;
      break;

    case T.CHD: // Change hardness — data.hd is 0-100 integer
      user.hardness = data.hd;
      break;

    case T.CBR: // Change blur radius — data.br is 0-100 integer
      user.blurRadius = data.br;
      break;

    case T.CL: // Change active layer — data.ly is layer index (0-4)
      user.activeLayer = data.ly;
      break;

    case T.CBM: // Change blend mode — data.bm is blend mode string (e.g. 'source-over', 'multiply')
      user.blendMode = data.bm;
      break;

    case T.CP: // Change pressure — data.p is pressure * 100 (e.g. 100 = 1.0 = full pressure)
      user.pressure = data.p;
      break;

    case T.CT: // Change tool — data.l is the Tool enum value; reset text buffer since tool changed
      user.tool = data.l;
      user.text = '';
      break;

    case T.CC: // Change color — data.c is a packed RGBA fixed32 (see packColor/unpackColor helpers)
      user.color = data.c;
      break;

    case T.CN: // Change name - user is changing their display name (not joining)
      const oldName = user.name;
      user.name = data.n;
      room.sessionManager.updateUserActivity(sessionIndex);

      console.log(`[CN] Session ${sessionIndex} changing name from "${oldName}" to "${data.n}"`);

      // Broadcast updated USERS list to everyone
      const roomBroadcaster = createRoomBroadcaster(room);
      const allUsers = room.sessionManager.getJoinedUsers();
      roomBroadcaster({
        t: T.USERS,
        us: allUsers.map(u => ({
          u: u.sessionIndex,
          a: u.afk,
          x: u.x,
          y: u.y,
          l: u.tool,
          c: u.color,
          s: u.size,
          sp: u.spacing,
          sm: u.smoothing,
          hd: u.hardness,
          p: u.pressure,
          n: u.name,
          tx: u.text,
          role: u.role || Role.GUEST,
          ch: u.cursorHidden || false,
          br: u.blurRadius || 500,
          ly: u.activeLayer || 0,
          bm: u.blendMode || 'source-over',
          ib: u.imageBrush
        }))
      });
      break;

    case T.KP: // Key press — only relevant to the text tool; server mirrors the text buffer for USERS sync
      const key = data.k;
      if (key && key.length === 1) {
        user.text = (user.text || '') + key;   // Printable character
      }
      if (key === 'Enter') {
        user.text = '';                          // Enter commits and clears
      } else if (key === 'Backspace' && user.text) {
        user.text = user.text.slice(0, -1);     // Backspace removes last char
      }
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.HIDE_CURSOR: // Cursor left the canvas area — stop rendering this user's cursor on all clients
      user.cursorHidden = true;
      break;

    case T.SHOW_CURSOR: // Cursor entered the canvas area — resume rendering
      user.cursorHidden = false;
      break;

    case T.MIR: // Toggle mirror mode — server owns this state so late joiners get the correct setting via SETTINGS
      room.settings.mirror = !room.settings.mirror;
      break;

    case T.MSG: // Chat message — no server-side state change needed, just bump activity timestamp
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.GMP: // Image brush load — data.bd is the GIMP brush metadata (JSON string or object)
      user.imageBrush = data.bd;
      break;
  }

  // Mute enforcement: block drawing + chat from muted users
  // Allow cursor movement (MM) and UI state changes (CT, CC, CS, etc.) through
  if (MUTED_BLOCKED.has(data.t)) {
    for (const client of wss.clients) {
      if (client.sessionIndex === sessionIndex && client.isMuted) {
        // Only send error feedback for chat (not every draw attempt)
        if (data.t === T.MSG || data.t === T.DM || data.t === T.CHAT_IMG) {
          sendTo(client, { t: T.MOD_RESULT, a: false, authError: 'You are muted' });
        }
        return; // Don't relay
      }
    }
  }

  // Relay to other clients in the same room
  broadcastToRoom(room, { ...data, u: sessionIndex }, sessionIndex);
}

// Broadcast to all clients in a specific room
function broadcastToRoom(room, payload, excludeIndex = null) {
  // Clear old data to prevent "ghost" properties from previous messages
  for (let key in POOLED_MSG) { if (POOLED_MSG.hasOwnProperty(key)) delete POOLED_MSG[key]; }
  Object.assign(POOLED_MSG, payload);

  const buffer = Msg.encode(POOLED_MSG).finish();

  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeIndex != null && client.sessionIndex == excludeIndex) {
        return;
      }
      client.send(buffer);
    }
  });
}

wss.on('connection', (ws, req) => {
  try {
    console.log(`[WS] New connection attempt from ${req.socket.remoteAddress}`);

    ws.clientIp = getClientIp(req);
    ws.userRole = Role.ADMIN; // TODO: TEMPORARY - All users are admin for testing
    ws.userId = null;
    ws.username = null;
    ws.isMuted = false;

    // Parse room ID from query parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room') || 'default';
    console.log(`[Room] Parsed room ID: ${roomId}`);

    // Get or create room
    const room = roomManager.getOrCreateRoom(roomId);
    room.addClient(ws);

    console.log(`[Room] Client joined room: ${roomId}, total clients: ${room.getClientCount()}`);
  } catch (err) {
    console.error('[WS] Connection handler error:', err);
    ws.close(1011, 'Server error during connection');
  }

  ws.on('message', async (rawData) => {
    // Get room for this connection
    const room = roomManager.getRoomByClient(ws);
    if (!room) {
      console.warn('[WS] Message from client not in any room');
      return;
    }

    try {
      let data;

      const firstByte = rawData[0];

      if (firstByte === 0x7B || firstByte === 0x22) {
        const jsonString = rawData.toString('utf8');
        data = JSON.parse(jsonString);
      } else if (firstByte === 0x08) {
        data = Msg.decode(new Uint8Array(rawData));
      } else {
        // Not JSON, not valid protobuf for our schema — skip
        console.warn(`[WS] Dropping unknown message: first byte 0x${firstByte.toString(16)}, length ${rawData.length}, from session ${ws.sessionIndex ?? 'unassigned'}`);
        return;
      }

      // Sanitize input data
      data = sanitizeMessage(data);

      // Debug: Log message type for CHAT_IMG
      if (data.t === T.CHAT_IMG || data.t === 40) {
        console.log('[DEBUG] Received CHAT_IMG message:', {
          type: data.t,
          expectedType: T.CHAT_IMG,
          hasCimg: !!data.cimg,
          sessionIndex: ws.sessionIndex
        });
      }

      switch (data.t) {
        // Client handshake — assign a session index and send the full user list + board settings
        case T.CONNECT:
          // IP ban enforcement on connect
          if (getDB()) {
            try {
              const ipBan = await getDB().collection('moderation').findOne({
                type: 'ban', active: true, targetIp: ws.clientIp
              });
              if (ipBan) {
                const reason = ipBan.reason || '';
                sendTo(ws, { t: T.MOD_RESULT, a: false, authError: `You are banned${reason ? ': ' + reason : ''}` });
                ws.close(4001, 'Banned');
                return;
              }
            } catch (err) {
              console.error('[Mod] IP ban check error:', err);
            }
          }

          const sessionIndex = room.sessionManager.allocateSessionIndex();
          ws.sessionIndex = sessionIndex;

          // User joins with their username immediately - no spectator mode
          const username = data.n || '';
          console.log(`[CONNECT] Session ${sessionIndex} joining room ${room.id} as "${username}"`);

          const newUser = room.sessionManager.createUser(
            sessionIndex,
            username,
            Tool.BRUSH,
            packColor([0, 0, 0, 1])
          );

          console.log(`[CONNECT] Room ${room.id} now has ${room.sessionManager.getUserCount()} users`);

          // Send session index and role back to connecting user
          sendTo(ws, { t: T.CONNECT, u: sessionIndex, authRole: ws.userRole });

          // Broadcast complete user list to everyone (including new user)
          const allUsers = room.sessionManager.getJoinedUsers();
          const roomBroadcaster = createRoomBroadcaster(room);
          console.log(`[CONNECT] Broadcasting user list to all: ${allUsers.length} users:`,
            allUsers.map(u => `${u.name}(${u.sessionIndex})`).join(', '));
          roomBroadcaster({
            t: T.USERS,
            us: allUsers.map(u => ({
              u: u.sessionIndex,
              a: u.afk,
              x: u.x,
              y: u.y,
              l: u.tool,
              c: u.color,
              s: u.size,
              sp: u.spacing,
              sm: u.smoothing,
              hd: u.hardness,
              p: u.pressure,
              n: u.name,
              tx: u.text,
              role: u.role || Role.GUEST,
              ch: u.cursorHidden || false,
              br: u.blurRadius || 500,
              ly: u.activeLayer || 0,
              bm: u.blendMode || 'source-over',
              ib: u.imageBrush
            }))
          });

          // Send board settings to new user
          sendTo(ws, { t: T.SETTINGS, m: room.settings.mirror });
          break;

        // Canvas sync handshake (step 1 of 3) — new client asks for the current canvas state.
        // Server picks a provider and sends them SYNC_PROVIDE (step 2).
        // Provider replies with SYNC_CANVAS (step 3), which the server forwards + sends SYNC_COMPLETE.
        case T.SYNC_REQUEST:
          room.syncCoordinator.handleSyncRequest(ws, data);
          break;

        // Canvas sync (step 3, legacy) — provider sends PNG via data.img; server routes it to data.tu
        case T.SYNC_CANVAS:
          room.syncCoordinator.handleSyncCanvas(ws, data);
          break;

        // Structured stroke sync — provider sends metadata, then per-layer base canvases and stroke records
        case T.SYNC_METADATA:
          room.syncCoordinator.handleSyncMetadata(ws, data);
          break;

        case T.SYNC_LAYER_BASE:
          room.syncCoordinator.handleSyncLayerBase(ws, data);
          break;

        case T.SYNC_STROKE:
          room.syncCoordinator.handleSyncStroke(ws, data);
          break;

        case T.SYNC_STROKE_BATCH:
          room.syncCoordinator.handleSyncStrokeBatch(ws, data);
          break;

        case T.SYNC_STROKES_DONE:
          room.syncCoordinator.handleSyncStrokesDone(ws, data);
          break;

        // Direct message — data.r is the recipient's session index, data.g is the message text
        case T.DM:
          // Direct message - send only to the specified recipient
          const recipientId = data.r;
          if (recipientId !== undefined && ws.sessionIndex !== undefined) {
            // Find the recipient's WebSocket and send the message
            for (const client of wss.clients) {
              if (client.sessionIndex === recipientId && client.readyState === WebSocket.OPEN) {
                sendTo(client, {
                  t: T.DM,
                  u: ws.sessionIndex,
                  g: data.g
                });
                console.log(`[DM] User ${ws.sessionIndex} -> User ${recipientId}`);
                break;
              }
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        // Chat image — data.cimg is raw PNG bytes; data.r (optional) targets a specific user for a DM image.
        // Protobuf sends bytes as Buffer on Node; we normalise to Uint8Array before re-encoding.
        case T.CHAT_IMG:
          // Chat image - send to recipient (if DM) or broadcast to all
          if (ws.sessionIndex !== undefined) {
            let imageBytes = data.cimg;
            const imageRecipientId = data.r;

            console.log(`[CHAT_IMG] Raw data.cimg type: ${imageBytes?.constructor?.name}, length: ${imageBytes?.length}`);

            if (!imageBytes || imageBytes.length === 0) {
              console.log(`[CHAT_IMG] No image data received from user ${ws.sessionIndex}`);
              break;
            }

            // Ensure we have a proper Uint8Array for protobuf encoding
            if (Buffer.isBuffer(imageBytes)) {
              imageBytes = new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.length);
            } else if (!(imageBytes instanceof Uint8Array)) {
              imageBytes = new Uint8Array(imageBytes);
            }

            console.log(`[CHAT_IMG] Processed bytes type: ${imageBytes.constructor.name}, length: ${imageBytes.length}`);

            if (imageRecipientId !== undefined) {
              // DM image - send only to recipient
              for (const client of wss.clients) {
                if (client.sessionIndex === imageRecipientId && client.readyState === WebSocket.OPEN) {
                  sendTo(client, {
                    t: T.CHAT_IMG,
                    u: ws.sessionIndex,
                    cimg: imageBytes,
                    r: imageRecipientId
                  });
                  console.log(`[CHAT_IMG DM] User ${ws.sessionIndex} -> User ${imageRecipientId}`);
                  break;
                }
              }
            } else {
              // Public chat image - broadcast to all in room except sender
              broadcastToRoom(room, {
                t: T.CHAT_IMG,
                u: ws.sessionIndex,
                cimg: imageBytes
              }, ws.sessionIndex);
              console.log(`[CHAT_IMG] User ${ws.sessionIndex} broadcast image to room`);
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        // Moderation action — mod_action_type: 0=kick, 1=mute, 2=ban, 3=unmute, 4=unban
        // mod_target is the session index; mod_target_name, mod_reason, mod_duration are optional context.
        // Kick/mute/ban are written to the DB (if available) for persistence across reconnects.
        case T.MOD_ACTION: {
          // Verify requester is mod or admin
          if (ws.userRole < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          // Use camelCase - protobufjs converts snake_case proto fields to camelCase
          const modActionType = data.modActionType; // 0=kick,1=mute,2=ban,3=unmute,4=unban
          const modTargetIndex = data.modTarget;
          const modReason = data.modReason || '';
          const modDuration = data.modDuration || 0;

          // Find target WebSocket
          let targetWs = null;
          for (const client of wss.clients) {
            if (client.sessionIndex === modTargetIndex && client.readyState === WebSocket.OPEN) {
              targetWs = client;
              break;
            }
          }

          const targetUser = room.sessionManager.getUser(modTargetIndex);
          const targetName = data.modTargetName || targetWs?.username || targetUser?.name || `User ${modTargetIndex}`;

          try {
            const roomBroadcaster = createRoomBroadcaster(room);

            switch (modActionType) {
              case 0: // Kick
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 0,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                if (targetWs) {
                  targetWs.close(4002, 'Kicked');
                }
                console.log(`[Mod] ${ws.username} kicked ${targetName}`);
                break;

              case 1: // Mute
                if (getDB()) {
                  await issueModAction({
                    type: 'mute',
                    targetUserId: targetWs?.userId || null,
                    targetUsername: targetName,
                    targetIp: targetWs?.clientIp || null,
                    reason: modReason,
                    issuedBy: ws.userId || null,
                    issuedByUsername: ws.username || '',
                    duration: modDuration
                  });
                }
                if (targetWs) {
                  targetWs.isMuted = true;
                }
                // Hide muted user's cursor for everyone
                roomBroadcaster({ t: T.HIDE_CURSOR, u: modTargetIndex });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 1,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                console.log(`[Mod] ${ws.username} muted ${targetName}`);
                break;

              case 2: // Ban
                if (getDB()) {
                  await issueModAction({
                    type: 'ban',
                    targetUserId: targetWs?.userId || null,
                    targetUsername: targetName,
                    targetIp: targetWs?.clientIp || null,
                    reason: modReason,
                    issuedBy: ws.userId || null,
                    issuedByUsername: ws.username || '',
                    duration: modDuration
                  });
                }
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 2,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                if (targetWs) {
                  targetWs.close(4001, 'Banned');
                }
                console.log(`[Mod] ${ws.username} banned ${targetName}`);
                break;

              case 3: // Unmute
                if (getDB()) {
                  // Find and revoke active mute for this user
                  const db = getDB();
                  const activeMute = await db.collection('moderation').findOne({
                    type: 'mute',
                    active: true,
                    targetUsername: targetName
                  });
                  if (activeMute) {
                    await revokeModAction(activeMute._id.toString(), ws.userId);
                  }
                }
                if (targetWs) {
                  targetWs.isMuted = false;
                }
                // Restore unmuted user's cursor
                roomBroadcaster({ t: T.SHOW_CURSOR, u: modTargetIndex });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 3,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                console.log(`[Mod] ${ws.username} unmuted ${targetName}`);
                break;

              case 4: // Unban
                if (getDB()) {
                  const db = getDB();
                  const activeBan = await db.collection('moderation').findOne({
                    type: 'ban',
                    active: true,
                    targetUsername: targetName
                  });
                  if (activeBan) {
                    await revokeModAction(activeBan._id.toString(), ws.userId);
                  }
                }
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 4,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                console.log(`[Mod] ${ws.username} unbanned ${targetName}`);
                break;
            }

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Mod] Action error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Moderation action failed' });
          }
          break;
        }

        // Wipe user — remove all strokes from a specific user (mod action)
        case T.MOD_WIPE: {
          if (ws.userRole < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          const targetIndex = data.modTarget;
          const targetName = data.modTargetName || `User ${targetIndex}`;

          // Broadcast to all clients in the room to wipe this user's strokes
          const roomBroadcaster = createRoomBroadcaster(room);
          roomBroadcaster({
            t: T.MOD_WIPE,
            modTarget: targetIndex,
            modTargetName: targetName,
            modIssuerName: ws.username || `User ${ws.sessionIndex}`
          });

          console.log(`[Mod] ${ws.username} wiped all strokes from ${targetName}`);
          sendTo(ws, { t: T.MOD_RESULT, a: true });
          break;
        }

        // Room list request — returns list of active rooms
        case T.ROOM_LIST_REQUEST: {
          try {
            const rooms = roomManager.getRoomList();
            sendTo(ws, {
              t: T.ROOM_LIST_RESPONSE,
              rooms: rooms.map(r => ({
                id: r.id,
                userCount: r.userCount,
                locked: r.locked,
                hasPassword: r.hasPassword
              }))
            });
          } catch (err) {
            console.error('[Room] List error:', err);
          }
          break;
        }

        // Mod panel request — returns all active bans/mutes as a repeated ModEntry list (mod_entries)
        case T.MOD_LIST: {
          // Verify requester is mod or admin
          if (ws.userRole < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          try {
            const entries = await getActiveModEntries();
            sendTo(ws, {
              t: T.MOD_LIST,
              modEntries: entries
            });
          } catch (err) {
            console.error('[Mod] List error:', err);
          }
          break;
        }

        // Register a new account — authUsername + authPassword required.
        // First ever registration is auto-promoted to admin (Role.ADMIN).
        // On success replies with AUTH_RESULT containing a JWT (authToken) and the assigned role.
        case T.AUTH_REGISTER: {
          const db = getDB();
          if (!db) {
            const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Database not available' };
            sendTo(ws, errorResponse);
            break;
          }

          const regUsername = (data.authUsername || '').trim();
          const regPassword = data.authPassword || '';

          if (!isValidUsername(regUsername)) {
            const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Username must be 2-20 characters (letters, numbers, underscores)' };
            sendTo(ws, errorResponse);
            break;
          }
          if (regPassword.length < 6) {
            const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Password must be at least 6 characters' };
            sendTo(ws, errorResponse);
            break;
          }

          try {
            const passwordHash = await hashPassword(regPassword);

            // Check if this is the first user (auto-promote to admin)
            const userCount = await db.collection('users').countDocuments();
            const role = userCount === 0 ? Role.ADMIN : Role.USER;

            const newUserDoc = {
              username: regUsername,
              passwordHash,
              role,
              createdAt: new Date(),
              lastLoginAt: new Date(),
              lastIp: ws.clientIp,
              ipHistory: [ws.clientIp]
            };

            const result = await db.collection('users').insertOne(newUserDoc);

            const token = generateToken({ userId: result.insertedId.toString(), username: regUsername, role });

            ws.userId = result.insertedId.toString();
            ws.userRole = role;
            ws.username = regUsername;

            // Update user record with role
            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              user.role = role;
              user.name = regUsername;
            }

            console.log(`[Auth] Registered: ${regUsername} (role: ${role}, first user: ${userCount === 0})`);

            const successResponse = {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: role,
              authUsername: regUsername
            };
            sendTo(ws, successResponse);
          } catch (err) {
            if (err.code === 11000) {
              const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Username already taken' };
                sendTo(ws, errorResponse);
            } else {
              console.error('[Auth] Registration error:', err);
              const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Registration failed' };
                sendTo(ws, errorResponse);
            }
          }
          break;
        }

        // Login — supports two modes:
        //   Token mode:    authToken present → verify JWT and look up user by stored ID
        //   Password mode: authUsername + authPassword → bcrypt verify
        // After auth: checks active bans (closes socket 4001 if banned), loads mute state,
        // refreshes lastLoginAt + IP history, and returns a fresh JWT via AUTH_RESULT.
        case T.AUTH_LOGIN: {
          const db = getDB();
          if (!db) {
            const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Database not available' };
            sendTo(ws, errorResponse);
            break;
          }

          try {
            let userDoc = null;

            if (data.authToken) {
              // Token-based login
              const decoded = verifyToken(data.authToken);
              if (!decoded) {
                const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Invalid or expired token' };
                    sendTo(ws, errorResponse);
                break;
              }

              const { ObjectId } = await import('mongodb');
              userDoc = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
              if (!userDoc) {
                const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Account not found' };
                    sendTo(ws, errorResponse);
                break;
              }
            } else if (data.authUsername && data.authPassword) {
              // Password-based login
              userDoc = await db.collection('users').findOne(
                { username: data.authUsername },
                { collation: { locale: 'en', strength: 2 } }
              );
              if (!userDoc) {
                const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Invalid username or password' };
                sendTo(ws, errorResponse);
                break;
              }
              const passwordValid = await verifyPassword(data.authPassword, userDoc.passwordHash);
              if (!passwordValid) {
                const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Invalid username or password' };
                sendTo(ws, errorResponse);
                break;
              }
            } else {
              const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Missing credentials' };
                sendTo(ws, errorResponse);
              break;
            }

            // Check for active bans
            const banCheck = await db.collection('moderation').findOne({
              type: 'ban',
              active: true,
              $or: [
                { targetUserId: userDoc._id.toString() },
                { targetIp: ws.clientIp }
              ]
            });

            // Moderators and admins bypass bans
            if (banCheck) {
              console.log(`[Auth] Ban check: user=${userDoc.username}, role=${userDoc.role}, Role.MOD=${Role.MOD}, bypass=${userDoc.role >= Role.MOD}`);
            }
            if (banCheck && userDoc.role < Role.MOD) {
              const expiry = banCheck.expiresAt ? ` until ${banCheck.expiresAt.toISOString()}` : ' permanently';
              const errorResponse = { t: T.AUTH_RESULT, a: false, authError: `You are banned${expiry}. Reason: ${banCheck.reason || 'No reason given'}` };
              sendTo(ws, errorResponse);
              ws.close(4001, 'Banned');
              break;
            }
            // Check for active mutes
            const muteCheck = await db.collection('moderation').findOne({
              type: 'mute',
              active: true,
              $or: [
                { targetUserId: userDoc._id.toString() },
                { targetIp: ws.clientIp }
              ]
            });
            // Moderators and admins bypass mutes
            ws.isMuted = !!muteCheck && userDoc.role < Role.MOD;

            // Update login info
            const ipHistory = userDoc.ipHistory || [];
            if (!ipHistory.includes(ws.clientIp)) {
              ipHistory.push(ws.clientIp);
            }

            await db.collection('users').updateOne(
              { _id: userDoc._id },
              { $set: { lastLoginAt: new Date(), lastIp: ws.clientIp, ipHistory } }
            );

            const token = generateToken({
              userId: userDoc._id.toString(),
              username: userDoc.username,
              role: userDoc.role
            });

            ws.userId = userDoc._id.toString();
            ws.userRole = userDoc.role;
            ws.username = userDoc.username;

            // Update user record with role
            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              user.role = userDoc.role;
              user.name = userDoc.username;
            }

            console.log(`[Auth] Login: ${userDoc.username} (role: ${userDoc.role}${ws.isMuted ? ', muted' : ''})`);

            const successResponse = {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: userDoc.role,
              authUsername: userDoc.username
            };
            sendTo(ws, successResponse);

            // Notify user if they are muted
            if (ws.isMuted) {
              sendTo(ws, {
                t: T.MOD_NOTIFY,
                mod_action_type: 1,
                mod_target: ws.sessionIndex,
                mod_target_name: userDoc.username,
                mod_issuer_name: 'System',
                mod_reason: muteCheck.reason || ''
              });
            }
          } catch (err) {
            console.error('[Auth] Login error:', err);
            const errorResponse = { t: T.AUTH_RESULT, a: false, authError: 'Login failed' };
            sendTo(ws, errorResponse);
          }
          break;
        }

        // All drawing/tool/cursor messages — relay to other clients after updating server-side user state.
        // handleBroadcast also enforces mute (blocks draw + chat) and mirrors board state changes.
        default:
          if (ws.sessionIndex !== undefined) {
            handleBroadcast(data, ws.sessionIndex, room);
          }
          break;
      }
    } catch (err) {
      // Log first 32 bytes as hex for diagnosis
      const preview = Buffer.from(rawData).subarray(0, 32);
      console.error(`[WS] Decode error (${rawData.length} bytes, session ${ws.sessionIndex ?? 'unassigned'}): ${err.message}`);
      console.error(`[WS] Hex: ${preview.toString('hex')} | ASCII: ${preview.toString('ascii').replace(/[^\x20-\x7e]/g, '.')}`);
    }
  });

  ws.on('close', () => {
    const sessionIndex = ws.sessionIndex;
    const room = roomManager.getRoomByClient(ws);

    if (room) {
      // Always remove client from room (even if they never got a sessionIndex)
      room.removeClient(ws);

      // Only do session cleanup if they had a session
      if (sessionIndex !== undefined) {
        console.log('Disconnected:', sessionIndex, 'from room:', room.id);
        room.sessionManager.removeUser(sessionIndex);
        room.sessionManager.freeSessionIndex(sessionIndex);

        // Broadcast to room
        broadcastToRoom(room, { t: T.LEFT, u: sessionIndex });

        console.log('Current users in room', room.id, ':', room.sessionManager.getUserCount());

        if (room.sessionManager.getUserCount() === 0) {
          room.settings.mirror = false;
          room.syncCoordinator.clearPendingRequests();
        }
      } else {
        console.log('Disconnected: client without session from room:', room.id);
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
