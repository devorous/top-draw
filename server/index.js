/** @fileoverview Main entry point for the WebSocket server, handling connections, message routing, and room management. */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB, getDB } from './db.js';
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth.js';
import { issueModAction, revokeModAction, getModEntries, obfuscateIp, checkBan, checkMute } from './moderation.js';
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
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }
  res.writeHead(200);
  res.end();
});

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

/**
 * Extracts the client's IP address from the request, handling proxies.
 * @param {Object} req - The HTTP request object.
 * @returns {string} - The client's IP address.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

/**
 * Validates a username: 1-20 characters, alphanumeric and underscores.
 * @param {string} username - The username to validate.
 * @returns {boolean} - True if valid, false otherwise.
 */
function isValidUsername(username) {
  return /^[a-zA-Z0-9_]{1,20}$/.test(username);
}

/**
 * Initializes the server, connects to the database, and loads protobuf definitions.
 * @returns {Promise<void>}
 */
async function init() {
  const protoPath = path.join(__dirname, '..', 'public', 'messages.proto');
  const root = await protobuf.load(protoPath);
  Msg = root.lookupType('Msg');
  POOLED_MSG = Msg.create();

  try {
    await connectDB();
  } catch (err) {
    console.warn('[Server] Starting without database — auth/moderation disabled');
    console.log(err);
  }

  roomManager = new RoomManager(wss, sendTo);
  roomManager.setMsgEncoder(Msg, createRoomBroadcaster);
  console.log('[Server] RoomManager initialized');

  startBatchTimer();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket server running on port ${PORT}`);
  });
}

/**
 * Broadcasts a payload to all connected clients, optionally excluding one.
 * @param {Object} payload - The message payload to broadcast.
 * @param {number|null} [excludeIndex=null] - The session index to exclude from the broadcast.
 */
function broadcast(payload, excludeIndex = null) {
  for (let key in POOLED_MSG) { if (POOLED_MSG.hasOwnProperty(key)) delete POOLED_MSG[key]; }
  Object.assign(POOLED_MSG, payload);

  const buffer = Msg.encode(POOLED_MSG).finish();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeIndex != null && client.sessionIndex == excludeIndex) {
        return;
      }
      client.send(buffer);
    }
  });
}

/**
 * Broadcasts a payload to all connected clients without exclusion.
 * @param {Object} payload - The message payload to broadcast.
 */
function broadcastToAll(payload) {
  const message = Msg.create(payload);
  const buffer = Msg.encode(message).finish();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buffer);
    }
  });
}

/**
 * Creates a broadcaster function for a specific room.
 * @param {Object} room - The room object.
 * @returns {function(Object): void} - A function that broadcasts a payload to all clients in the room.
 */
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

/**
 * Sends a payload to a specific WebSocket client.
 * @param {WebSocket} ws - The WebSocket client.
 * @param {Object} payload - The message payload to send.
 */
function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    const message = Msg.create(payload);
    ws.send(Msg.encode(message).finish());
  }
}

const MUTED_BLOCKED = new Set([
  T.MM, T.MD, T.MU, T.KP, T.CLR,
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL, T.SEL_STAMP, T.SEL_FLIP, T.SEL_CANCEL, T.SEL_TO_BRUSH,
  T.IMG_PASTE, T.MSG, T.DM, T.CHAT_IMG
]);

/**
 * Handles incoming broadcast-type messages, updating user state and relaying to others.
 * @param {Object} data - The message data.
 * @param {number} sessionIndex - The session index of the sender.
 * @param {Object} room - The room object the sender is in.
 * @returns {Promise<void>}
 */
async function handleBroadcast(data, sessionIndex, room) {
  if (!room) return;
  const user = room.sessionManager.getUser(sessionIndex);
  if (!user) return;

  switch (data.t) {
    case T.MM:
      if (data.ps && data.ps.length >= 2) {
        const len = data.ps.length;
        user.lastx = user.x;
        user.lasty = user.y;
        user.x = data.ps[len - 2];
        user.y = data.ps[len - 1];
      }
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.MD:
      user.mousedown = true;
      room.sessionManager.updateUserActivity(sessionIndex);
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

    case T.CSM:
      user.smoothing = data.sm;
      break;

    case T.CHD:
      user.hardness = data.hd;
      break;

    case T.CBR:
      user.blurRadius = data.br;
      break;

    case T.CL:
      user.activeLayer = data.ly;
      break;

    case T.CBM:
      user.blendMode = data.bm;
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
      room.sessionManager.updateUserActivity(sessionIndex);

      console.log(`[CN] Session ${sessionIndex} changing name to "${data.n}"`);

      const allUsers = room.sessionManager.getJoinedUsers();
      createRoomBroadcaster(room)({
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
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.HIDE_CURSOR:
      user.cursorHidden = true;
      break;

    case T.SHOW_CURSOR:
      user.cursorHidden = false;
      break;

    case T.MIR:
      room.settings.mirror = !room.settings.mirror;
      break;

    case T.MSG:
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.GMP:
      user.imageBrush = data.bd;
      break;
  }

  if (MUTED_BLOCKED.has(data.t)) {
    for (const client of wss.clients) {
      if (client.sessionIndex === sessionIndex && client.isMuted) {
        if (client.userRole >= Role.MOD) {
          break;
        }
        if (data.t === T.MSG || data.t === T.DM || data.t === T.CHAT_IMG) {
          sendTo(client, { t: T.MOD_RESULT, a: false, authError: 'You are muted' });
        }
        return;
      }
    }
  }

  broadcastToRoom(room, { ...data, u: sessionIndex }, sessionIndex);
}

const BATCH_INTERVAL_MS = 16;
const clientOutbox = new Map();
let batchTimerRunning = false;

/**
 * Starts the timer for flushing batched messages to clients.
 */
function startBatchTimer() {
  if (batchTimerRunning) return;
  batchTimerRunning = true;
  setInterval(flushAllOutboxes, BATCH_INTERVAL_MS);
}

/**
 * Flushes all client outboxes, sending concatenated binary frames.
 */
function flushAllOutboxes() {
  for (const [ws, buffers] of clientOutbox) {
    if (buffers.length === 0) continue;

    if (ws.readyState !== WebSocket.OPEN) {
      buffers.length = 0;
      continue;
    }

    if (buffers.length === 1) {
      ws.send(buffers[0]);
    } else {
      let totalLen = 0;
      for (let i = 0; i < buffers.length; i++) totalLen += 4 + buffers[i].length;

      const frame = new Uint8Array(totalLen);
      const view = new DataView(frame.buffer);
      let offset = 0;
      for (let i = 0; i < buffers.length; i++) {
        view.setUint32(offset, buffers[i].length);
        frame.set(buffers[i], offset + 4);
        offset += 4 + buffers[i].length;
      }
      ws.send(frame);
    }

    buffers.length = 0;
  }
}

const BATCHABLE_TYPES = new Set([
  T.MM, T.MD, T.MU, T.CP, T.CS, T.CT, T.CC,
  T.CSP, T.CSM, T.CHD, T.CBR, T.CL, T.CBM, T.CANCEL,
  T.KP, T.HIDE_CURSOR, T.SHOW_CURSOR, T.GMP, T.AFK
]);

/**
 * Broadcasts a payload to all clients in a room, with optional batching for high-frequency messages.
 * @param {Object} room - The room object.
 * @param {Object} payload - The message payload.
 * @param {number|null} [excludeIndex=null] - The session index to exclude.
 */
function broadcastToRoom(room, payload, excludeIndex = null) {
  for (let key in POOLED_MSG) { if (POOLED_MSG.hasOwnProperty(key)) delete POOLED_MSG[key]; }
  Object.assign(POOLED_MSG, payload);

  const buffer = Msg.encode(POOLED_MSG).finish();
  const shouldBatch = BATCHABLE_TYPES.has(payload.t);

  room.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeIndex != null && client.sessionIndex == excludeIndex) {
        return;
      }
      if (shouldBatch) {
        let outbox = clientOutbox.get(client);
        if (!outbox) {
          outbox = [];
          clientOutbox.set(client, outbox);
        }
        outbox.push(buffer.slice());
      } else {
        client.send(buffer);
      }
    }
  });
}

wss.on('connection', (ws, req) => {
  try {
    console.log(`[WS] New connection attempt from ${req.socket.remoteAddress}`);

    ws.clientIp = getClientIp(req);
    ws.userRole = Role.GUEST;
    ws.userId = null;
    ws.username = null;
    ws.isMuted = false;

    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room') || 'default';
    console.log(`[Room] Parsed room ID: ${roomId}`);

    const room = roomManager.getOrCreateRoom(roomId);
    room.addClient(ws);

    console.log(`[Room] Client joined room: ${roomId}, total clients: ${room.getClientCount()}`);

    ws.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        sendTo(ws, { t: T.PING });
      } else {
        clearInterval(ws.pingInterval);
      }
    }, 30000);
  } catch (err) {
    console.error('[WS] Connection handler error:', err);
    ws.close(1011, 'Server error during connection');
  }

  ws.on('message', async (rawData) => {
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
        console.warn(`[WS] Dropping unknown message from session ${ws.sessionIndex ?? 'unassigned'}`);
        return;
      }

      data = sanitizeMessage(data);

      switch (data.t) {
        case T.CONNECT:
          await room.ensureLoaded();

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

          const username = data.n || '';
          console.log(`[CONNECT] Session ${sessionIndex} joining room ${room.id} as "${username}"`);

          room.sessionManager.createUser(
            sessionIndex,
            username,
            Tool.BRUSH,
            packColor([0, 0, 0, 1])
          );

          sendTo(ws, { t: T.CONNECT, u: sessionIndex, authRole: ws.userRole });

          const allUsers = room.sessionManager.getJoinedUsers();
          const roomBroadcaster = createRoomBroadcaster(room);
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

          sendTo(ws, { t: T.SETTINGS, m: room.settings.mirror });
          break;

        case T.SYNC_REQUEST:
          room.syncCoordinator.handleSyncRequest(ws, data);
          break;

        case T.SYNC_CANVAS:
          room.syncCoordinator.handleSyncCanvas(ws, data);
          break;

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

        case T.DM:
          const recipientId = data.r;
          if (recipientId !== undefined && ws.sessionIndex !== undefined) {
            for (const client of wss.clients) {
              if (client.sessionIndex === recipientId && client.readyState === WebSocket.OPEN) {
                sendTo(client, {
                  t: T.DM,
                  u: ws.sessionIndex,
                  g: data.g
                });
                break;
              }
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.CHAT_IMG:
          if (ws.sessionIndex !== undefined) {
            let imageBytes = data.cimg;
            const imageRecipientId = data.r;

            if (!imageBytes || imageBytes.length === 0) break;

            if (Buffer.isBuffer(imageBytes)) {
              imageBytes = new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.length);
            } else if (!(imageBytes instanceof Uint8Array)) {
              imageBytes = new Uint8Array(imageBytes);
            }

            if (imageRecipientId !== undefined) {
              for (const client of wss.clients) {
                if (client.sessionIndex === imageRecipientId && client.readyState === WebSocket.OPEN) {
                  sendTo(client, {
                    t: T.CHAT_IMG,
                    u: ws.sessionIndex,
                    cimg: imageBytes,
                    r: imageRecipientId
                  });
                  break;
                }
              }
            } else {
              broadcastToRoom(room, {
                t: T.CHAT_IMG,
                u: ws.sessionIndex,
                cimg: imageBytes
              }, ws.sessionIndex);
            }
            room.sessionManager.updateUserActivity(ws.sessionIndex);
          }
          break;

        case T.MOD_ACTION: {
          if (ws.userRole < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          const modActionType = data.modActionType;
          const modTargetIndex = data.modTarget;
          const modReason = data.modReason || '';
          const modDuration = data.modDuration || 0;

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
                    duration: modDuration,
                    roomId: room.id
                  });
                }
                if (targetWs) {
                  targetWs.isMuted = true;
                }
                roomBroadcaster({ t: T.HIDE_CURSOR, u: modTargetIndex });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 1,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
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
                    duration: modDuration,
                    roomId: room.id
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
                break;

              case 3: // Unmute
                if (getDB()) {
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
                roomBroadcaster({ t: T.SHOW_CURSOR, u: modTargetIndex });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 3,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
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
                break;
            }

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Mod] Action error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Moderation action failed' });
          }
          break;
        }

        case T.MOD_WIPE: {
          if (ws.userRole < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          const targetIndex = data.modTarget;
          const targetName = data.modTargetName || `User ${targetIndex}`;

          createRoomBroadcaster(room)({
            t: T.MOD_WIPE,
            modTarget: targetIndex,
            modTargetName: targetName,
            modIssuerName: ws.username || `User ${ws.sessionIndex}`
          });

          sendTo(ws, { t: T.MOD_RESULT, a: true });
          break;
        }

        case T.ROOM_LIST_REQUEST: {
          try {
            const rooms = roomManager.getRoomList();
            sendTo(ws, {
              t: T.ROOM_LIST_RESPONSE,
              rooms: rooms.map(r => ({
                id: r.id,
                userCount: r.userCount,
                locked: r.locked,
                hasPassword: r.hasPassword,
                description: r.description || '',
                ownerId: r.ownerId || '',
                ownerUsername: r.ownerUsername || ''
              }))
            });
          } catch (err) {
            console.error('[Room] List error:', err);
          }
          break;
        }

        case T.ROOM_UPDATE: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const isOwner = room.ownerId === ws.userId;
          const isMod = ws.userRole >= Role.MOD;

          if (!isOwner && !isMod) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only room owner or moderators can change settings' });
            break;
          }

          try {
            if (!room.ownerId && data.roomOwnerId === ws.userId) {
              room.ownerId = ws.userId;
              room.ownerUsername = ws.username;
            }

            if (data.roomDescription !== undefined) {
              room.description = (data.roomDescription || '').substring(0, 200);
            }
            if (data.roomLocked !== undefined) {
              room.settings.locked = !!data.roomLocked;
            }
            if (data.roomMaxUsers !== undefined) {
              room.settings.maxUsers = Math.max(0, Math.min(100, data.roomMaxUsers || 0));
            }

            await room.saveToDB();
            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Room] Update error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to update room' });
          }
          break;
        }

        case T.MOD_LIST: {
          if (ws.userRole < Role.MOD) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          try {
            const entries = await getModEntries({
              showHistory: !!data.modShowHistory,
              search: data.modSearch || ''
            });
            sendTo(ws, {
              t: T.MOD_LIST,
              modEntries: entries
            });
          } catch (err) {
            console.error('[Mod] List error:', err);
          }
          break;
        }

        case T.PONG:
          break;

        case T.AUTH_REGISTER: {
          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const regUsername = (data.authUsername || '').trim();
          const regPassword = data.authPassword || '';

          if (!isValidUsername(regUsername)) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Username must be 2-20 characters (letters, numbers, underscores)' });
            break;
          }
          if (regPassword.length < 6) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Password must be at least 6 characters' });
            break;
          }

          try {
            const passwordHash = await hashPassword(regPassword);
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

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              user.role = role;
              user.name = regUsername;
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: role,
              authUsername: regUsername
            });
          } catch (err) {
            if (err.code === 11000) {
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Username already taken' });
            } else {
              console.error('[Auth] Registration error:', err);
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Registration failed' });
            }
          }
          break;
        }

        case T.AUTH_LOGIN: {
          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          try {
            let userDoc = null;

            if (data.authToken) {
              const decoded = verifyToken(data.authToken);
              if (!decoded) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid or expired token' });
                break;
              }

              const { ObjectId } = await import('mongodb');
              userDoc = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
              if (!userDoc) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Account not found' });
                break;
              }
            } else if (data.authUsername && data.authPassword) {
              userDoc = await db.collection('users').findOne(
                { username: data.authUsername },
                { collation: { locale: 'en', strength: 2 } }
              );
              if (!userDoc) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid username or password' });
                break;
              }
              const passwordValid = await verifyPassword(data.authPassword, userDoc.passwordHash);
              if (!passwordValid) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid username or password' });
                break;
              }
            } else {
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Missing credentials' });
              break;
            }

            const banCheck = await db.collection('moderation').findOne({
              type: 'ban',
              active: true,
              $or: [
                { targetUserId: userDoc._id.toString() },
                { targetIp: ws.clientIp }
              ]
            });

            if (banCheck && userDoc.role < Role.MOD) {
              const expiry = banCheck.expiresAt ? ` until ${banCheck.expiresAt.toISOString()}` : ' permanently';
              sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: `You are banned${expiry}. Reason: ${banCheck.reason || 'No reason given'}` });
              ws.close(4001, 'Banned');
              break;
            }

            const muteCheck = await db.collection('moderation').findOne({
              type: 'mute',
              active: true,
              $or: [
                { targetUserId: userDoc._id.toString() },
                { targetIp: ws.clientIp }
              ]
            });
            ws.isMuted = !!muteCheck && userDoc.role < Role.MOD;

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

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              user.role = userDoc.role;
              user.name = userDoc.username;
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: userDoc.role,
              authUsername: userDoc.username
            });

            if (ws.isMuted) {
              sendTo(ws, {
                t: T.MOD_NOTIFY,
                modActionType: 1,
                modTarget: ws.sessionIndex,
                modTargetName: userDoc.username,
                modIssuerName: 'System',
                modReason: muteCheck.reason || ''
              });
            }
          } catch (err) {
            console.error('[Auth] Login error:', err);
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Login failed' });
          }
          break;
        }

        default:
          if (ws.sessionIndex !== undefined) {
            handleBroadcast(data, ws.sessionIndex, room);
          }
          break;
      }
    } catch (err) {
      const preview = Buffer.from(rawData).subarray(0, 32);
      console.error(`[WS] Decode error (${rawData.length} bytes, session ${ws.sessionIndex ?? 'unassigned'}): ${err.message}`);
    }
  });

  ws.on('close', () => {
    clientOutbox.delete(ws);

    if (ws.pingInterval) {
      clearInterval(ws.pingInterval);
    }

    const sessionIndex = ws.sessionIndex;
    const room = roomManager.getRoomByClient(ws);

    if (room) {
      room.removeClient(ws);

      if (sessionIndex !== undefined) {
        room.sessionManager.removeUser(sessionIndex);
        room.sessionManager.freeSessionIndex(sessionIndex);
        broadcastToRoom(room, { t: T.LEFT, u: sessionIndex });

        if (room.sessionManager.getUserCount() === 0) {
          room.settings.mirror = false;
          room.syncCoordinator.clearPendingRequests();
        }
      }

      if (room.getClientCount() === 0) {
        roomManager.cleanupEmptyRooms();
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
