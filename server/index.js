/** @fileoverview Main entry point for the WebSocket server, handling connections, message routing, and room management. */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import protobuf from 'protobufjs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { connectDB, getDB } from './db.js';
import { handleGalleryList, handleGalleryUpload, handleGalleryItem, handleGalleryLike, handleGalleryFavorite, handleGalleryFavorites, handleGalleryFavoriteCheck, handleGalleryCommentsList, handleGalleryCommentCreate, handleGalleryCommentDelete, handleGalleryDelete, handleGallerySidebar, handleGalleryTagsUpdate } from './gallery.js';
import { handleAuthLogin, handleAuthRegister, handleAuthMe } from './authRoutes.js';
import { handleUserProfile } from './userRoutes.js';
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth.js';
import { issueModAction, revokeModAction, revokeMatchingModActions, updateModActionReason, getModEntries, obfuscateIp, checkBan, checkMute } from './moderation.js';
import { T, Tool, ToolNames, ToolToEnum } from '../shared/MessageTypes.js';
import { packColor, unpackColor } from '../shared/ColorUtils.js';
import { SessionManager, Role } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { RoomManager } from './RoomManager.js';
import { sanitizeMessage } from './validation.js';
import { authorize, Action } from './permissions.js';
import { getRoomRole, setRoomRole, computeEffectiveRole } from './roomRoles.js';
import { authLimiter, uploadLimiter, likeLimiter, wsMessageLimiter, wsConnectionLimiter } from './rateLimit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;

const _fallbackIpSalt = crypto.randomBytes(16).toString('hex');
if (!process.env.IP_SALT) {
  console.warn('[SECURITY] IP_SALT not set — using random salt (IP hashes will change across restarts)');
}

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Rate limit helper
  const clientIp = req.socket.remoteAddress || '';
  function rateLimited(limiter) {
    if (!limiter.check(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
      res.end(JSON.stringify({ error: 'Too many requests, please try again later' }));
      return true;
    }
    return false;
  }

  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  if (path === '/api/gallery/sidebar' && req.method === 'GET') {
    await handleGallerySidebar(req, res);
    return;
  }

  if (path === '/api/gallery' && req.method === 'GET') {
    await handleGalleryList(req, res);
    return;
  }

  if (path === '/api/gallery/upload' && req.method === 'POST') {
    if (rateLimited(uploadLimiter)) return;
    await handleGalleryUpload(req, res);
    return;
  }

  const likeMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/like$/);
  if (likeMatch && req.method === 'POST') {
    if (rateLimited(likeLimiter)) return;
    await handleGalleryLike(req, res, likeMatch[1]);
    return;
  }

  // Single item route (must be after more specific routes)
  const itemMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})$/);
  if (itemMatch && req.method === 'GET') {
    await handleGalleryItem(req, res, itemMatch[1]);
    return;
  }
  if (itemMatch && req.method === 'DELETE') {
    await handleGalleryDelete(req, res, itemMatch[1]);
    return;
  }
  if (itemMatch && req.method === 'PATCH') {
    await handleGalleryTagsUpdate(req, res, itemMatch[1]);
    return;
  }

  // Favorites routes
  if (path === '/api/gallery/favorites' && req.method === 'GET') {
    await handleGalleryFavorites(req, res);
    return;
  }

  const favMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/favorite$/);
  if (favMatch && req.method === 'POST') {
    await handleGalleryFavorite(req, res, favMatch[1]);
    return;
  }
  if (favMatch && req.method === 'GET') {
    await handleGalleryFavoriteCheck(req, res, favMatch[1]);
    return;
  }

  // Comment routes
  const commentsMatch = path.match(/^\/api\/gallery\/([a-f0-9]{24})\/comments$/);
  if (commentsMatch && req.method === 'GET') {
    await handleGalleryCommentsList(req, res, commentsMatch[1]);
    return;
  }
  if (commentsMatch && req.method === 'POST') {
    await handleGalleryCommentCreate(req, res, commentsMatch[1]);
    return;
  }

  const commentDeleteMatch = path.match(/^\/api\/gallery\/comments\/([a-f0-9]{24})$/);
  if (commentDeleteMatch && req.method === 'DELETE') {
    await handleGalleryCommentDelete(req, res, commentDeleteMatch[1]);
    return;
  }

  // Auth routes (HTTP for gallery/non-WebSocket clients)
  if (path === '/api/auth/login' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleAuthLogin(req, res);
    return;
  }

  if (path === '/api/auth/register' && req.method === 'POST') {
    if (rateLimited(authLimiter)) return;
    await handleAuthRegister(req, res);
    return;
  }

  if (path === '/api/auth/me' && req.method === 'GET') {
    await handleAuthMe(req, res);
    return;
  }

  // User profile route
  const userMatch = path.match(/^\/api\/users\/([a-zA-Z0-9_-]+)$/);
  if (userMatch && req.method === 'GET') {
    await handleUserProfile(req, res, userMatch[1]);
    return;
  }


  res.writeHead(404);
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

// Messenger: username -> WebSocket
const messengerClients = new Map();

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
 * Generates an obfuscated hash from an IP address.
 * @param {string} ip - The IP address.
 * @returns {string} - The obfuscated hash.
 */
function getIpHash(ip) {
  // We use a salt (you might want to make this persistent/env var)
  const salt = process.env.IP_SALT || _fallbackIpSalt;
  return crypto.createHash('sha256').update(ip + salt).digest('hex').substring(0, 12);
}

/**
 * Maps user objects to a format suitable for the USERS broadcast.
 * @param {Array<Object>} users - The list of user objects.
 * @returns {Array<Object>} - The mapped user objects.
 */
function mapUsersForBroadcast(users) {
  return users.map(u => ({
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
    ib: u.imageBrush,
    pb: u.patternBrush,
    pm: u.patternMode || false,
    iph: u.ipHash,
    th: u.thinning,
    sim: u.simulatePressure,
    rn: u.registeredName || '',
    mt: !!u.isMuted
  }));
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

const INACTIVE_FILTERED_TYPES = new Set([
  T.MM, T.MD, T.MU, T.CP, T.CS, T.CT, T.CC, T.CSP, T.CSM, T.CHD, T.CBR,
  T.CL, T.CBM, T.PAN, T.CANCEL, T.KP, T.HIDE_CURSOR, T.SHOW_CURSOR, T.GMP,
  T.GPT, T.CPM, T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE,
  T.SEL_FILL, T.SEL_STAMP, T.SEL_CANCEL, T.SEL_TO_BRUSH, T.SEL_FLIP,
  T.SEL_PENDING, T.IMG_PASTE, T.CLR, T.UNDO, T.REDO, T.FILL, T.CTHN,
  T.CSIM, T.GLITCH_RESULT, T.TILE_UPDATE, T.TILE_CLEAR
]);

function shouldSkipInactiveRecipient(room, client, messageType) {
  if (!room || !INACTIVE_FILTERED_TYPES.has(messageType)) return false;
  const user = room.sessionManager.getUser(client.sessionIndex);
  return !!user?.afk;
}

const MUTED_BLOCKED = new Set([
  T.MM, T.MD, T.MU, T.KP, T.CLR,
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL, T.SEL_STAMP, T.SEL_FLIP, T.SEL_CANCEL, T.SEL_TO_BRUSH,
  T.IMG_PASTE, T.MSG, T.DM, T.CHAT_IMG, T.GLITCH_RESULT
]);

/**
 * Handles incoming broadcast-type messages, updating user state and relaying to others.
 * @param {Object} data - The message data.
 * @param {number} sessionIndex - The session index of the sender.
 * @param {Object} room - The room object the sender is in.
 * @returns {Promise<void>}
 */
async function handleBroadcast(data, sessionIndex, room, ws) {
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
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CS:
      user.size = data.s;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CSP:
      user.spacing = data.sp;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CSM:
      user.smoothing = data.sm;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CHD:
      user.hardness = data.hd;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CBR:
      user.blurRadius = data.br;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CL:
      user.activeLayer = data.ly;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CBM:
      user.blendMode = data.bm;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CP:
      user.pressure = data.p;
      break;

    case T.CT:
      user.tool = data.l;
      user.text = '';
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CC:
      user.color = data.c;
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.CN:
      const uniqueName = room.sessionManager.getUniqueName(data.n, sessionIndex);
      user.name = uniqueName;
      room.sessionManager.updateUserActivity(sessionIndex);

      console.log(`[CN] Session ${sessionIndex} changing name to "${data.n}" (unique: "${uniqueName}")`);

      const allUsers = room.sessionManager.getJoinedUsers();
      const cnBroadcaster = createRoomBroadcaster(room);
      
      if (!room.sessionManager.isDiscovery) {
        cnBroadcaster({
          t: T.USERS,
          us: mapUsersForBroadcast(allUsers)
        });
      } else {
        sendTo(ws, {
          t: T.USERS,
          us: mapUsersForBroadcast(allUsers)
        });
      }
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

    case T.MIRROR_REGION: {
      try {
        if (data.mirrorRegionsJson && data.mirrorRegionsJson.length > 10000) {
          console.warn('[MirrorRegion] Payload too large');
          break;
        }
        const payload = data.mirrorRegionsJson ? JSON.parse(data.mirrorRegionsJson) : null;
        if (!payload || typeof payload !== 'object' || !payload.action) break;

        if (payload.action === 'create' && payload.region) {
          const region = payload.region;
          // Strict type and range validation
          if (typeof region.x !== 'number' || typeof region.y !== 'number' ||
              typeof region.width !== 'number' || typeof region.height !== 'number') break;
          const x = Math.max(0, Math.min(20000, Math.floor(region.x)));
          const y = Math.max(0, Math.min(20000, Math.floor(region.y)));
          const width = Math.max(1, Math.min(10000, Math.floor(region.width)));
          const height = Math.max(1, Math.min(10000, Math.floor(region.height)));
          if (!['horizontal', 'vertical'].includes(region.axis)) break;
          const axis = region.axis;
          const showLine = region.showLine !== false;
          const id = String(region.id || `mr_${Date.now()}`);

          room.settings.mirrorRegions = [
            ...(room.settings.mirrorRegions || []),
            {
              id,
              x,
              y,
              width,
              height,
              axis,
              showLine,
              owner: region.owner || region.createdBy || ws.userId || null
            }
          ];
        } else if (payload.action === 'remove' && payload.id) {
          room.settings.mirrorRegions = (room.settings.mirrorRegions || []).filter(region => region.id !== payload.id);
        }
      } catch (err) {
        console.warn('[MirrorRegion] Invalid payload', err);
      }
      break;
    }

    case T.MSG:
      room.sessionManager.updateUserActivity(sessionIndex);
      break;

    case T.GMP:
      user.imageBrush = data.g;
      break;

    case T.GPT:
      user.patternBrush = data.g;
      break;

    case T.CPM:
      user.patternMode = data.pm || false;
      break;

    case T.IMG_PASTE:
      user.activeImage = { sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, g: data.g };
      user.activeSelectionCorners = null;
      break;

    case T.SEL_LIFT:
      if (data.g) {
        user.activeImage = { sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, g: data.g };
        user.activeSelectionCorners = null;
        // Strip image data from relay — existing users reconstruct the floating image from their canvas
        broadcastToRoom(room, { t: T.SEL_LIFT, u: sessionIndex, sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, cr: data.cr }, sessionIndex);
        return;
      }
      break;

    case T.SEL_MOVE:
      if (data.cr) {
        user.activeSelectionCorners = Array.from(data.cr);
      }
      break;

    case T.SEL_COMMIT:
    case T.SEL_CANCEL:
    case T.SEL_STAMP:
    case T.SEL_DELETE:
    case T.SEL_FILL:
    case T.SEL_TO_BRUSH:
      user.activeImage = null;
      user.activeSelectionCorners = null;
      break;

    case T.CTHN:
      user.thinning = data.th;
      break;

    case T.CSIM:
      user.simulatePressure = data.sim;
      break;
  }

  // Permission-gated actions inside the broadcast path
  if (data.t === T.CLR) {
    if (!authorize(ws, Action.CLEAR_CANVAS, sendTo, T.MOD_RESULT)) return;
    // Clear all tile data when canvas is cleared
    room.clearAllTiles();
  }

  if (MUTED_BLOCKED.has(data.t)) {
    for (const client of wss.clients) {
      if (client.sessionIndex === sessionIndex && client.isMuted) {
        if (client.userRole >= Role.MOD) {  // MOD(4)+ are exempt from mute
          break;
        }
        if (data.t === T.MSG || data.t === T.DM || data.t === T.CHAT_IMG) {
          sendTo(client, { t: T.MOD_RESULT, a: false, authError: 'You are muted' });
        }
        return;
      }
    }
  }

  if (data.t === T.MIRROR_REGION) {
    broadcastToRoom(room, {
      t: T.SETTINGS,
      m: room.settings.mirror,
      mirrorRegionsJson: JSON.stringify(room.settings.mirrorRegions || []),
      roomBackgroundColor: room.settings.backgroundColor,
      roomLocked: room.settings.locked,
      roomMaxUsers: room.settings.maxUsers,
      roomModInactiveImmune: room.settings.modInactiveImmune
    });
    return;
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
  T.KP, T.HIDE_CURSOR, T.SHOW_CURSOR, T.GMP, T.GPT, T.AFK,
  T.CTHN, T.CSIM, T.FILL
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
        if (shouldSkipInactiveRecipient(room, client, payload.t)) {
          return;
        }
        let outbox = clientOutbox.get(client);
        if (!outbox) {
          outbox = [];
          clientOutbox.set(client, outbox);
        }
        outbox.push(buffer.slice());
      } else {
        if (shouldSkipInactiveRecipient(room, client, payload.t)) {
          return;
        }
        client.send(buffer);
      }
    }
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Fork: messenger connections use /messenger path
  if (url.pathname === '/messenger') {
    const userId = url.searchParams.get('userId');
    if (!userId) { ws.close(); return; }

    messengerClients.set(userId, ws);
    console.log(`[Messenger] ${userId} connected`);

    ws.on('message', async (data) => {
      try {
        const { type, payload } = JSON.parse(data);
        const db = getDB();

        if (type === 'init_chat') {
          const history = await db.collection('messages')
            .find({ room_id: payload.roomId })
            .sort({ timestamp: -1 }).limit(50).toArray();
          ws.send(JSON.stringify({ type: 'history', payload: history.reverse() }));

        } else if (type === 'get_inbox') {
          const inbox = await db.collection('messages').aggregate([
            { $match: { $or: [{ sender_id: payload.userId }, { receiver_id: payload.userId }] } },
            { $sort: { timestamp: -1 } },
            { $group: { _id: '$room_id', latestMessage: { $first: '$$ROOT' } } },
            { $sort: { 'latestMessage.timestamp': -1 } }
          ]).toArray();
          ws.send(JSON.stringify({ type: 'inbox', payload: inbox.map(i => i.latestMessage) }));

        } else if (type === 'send_message') {
          const { room_id, sender_id, receiver_id, encrypted_content, iv } = payload;
          const msgDoc = { room_id, sender_id, receiver_id, encrypted_content, iv, timestamp: Date.now() };
          await db.collection('messages').insertOne(msgDoc);

          if (messengerClients.has(receiver_id)) {
            messengerClients.get(receiver_id).send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
          }
          ws.send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
        }
      } catch (err) {
        console.error('[Messenger] Message error:', err);
      }
    });

    ws.on('close', () => {
      messengerClients.delete(userId);
      console.log(`[Messenger] ${userId} disconnected`);
    });

    return;
  }

  // Drawing server connection
  try {
    // Rate limit new connections per IP
    const connIp = req.socket.remoteAddress || '';
    if (!wsConnectionLimiter.check(connIp)) {
      console.warn(`[WS] Connection rate limited: ${connIp}`);
      ws.close(1008, 'Too many connections');
      return;
    }

    console.log(`[WS] New connection attempt from ${req.socket.remoteAddress}`);

    ws.clientIp = getClientIp(req);
    ws.userRole = Role.GUEST;
    ws.globalRole = Role.GUEST;
    ws.roomRole = 0;
    ws.userId = null;
    ws.username = null;
    ws.isMuted = false;

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
    // Per-connection message rate limiting
    const wsKey = ws.clientIp || 'unknown';
    if (!wsMessageLimiter.check(wsKey)) {
      return; // Silently drop excess messages
    }

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
              const ipBan = await checkBan(null, ws.clientIp, room.id);
              if (ipBan) {
                const reason = ipBan.reason || '';
                sendTo(ws, { t: T.MOD_RESULT, a: false, authError: `You are banned${reason ? ': ' + reason : ''}` });
                ws.close(4001, 'Banned');
                return;
              }

              // Check for IP-based mute (guests)
              const ipMute = await checkMute(null, ws.clientIp, room.id);
              if (ipMute) {
                ws.isMuted = true;
              }
            } catch (err) {
              console.error('[Mod] IP ban/mute check error:', err);
            }
          }

          // Check room capacity
          if (room.settings.maxUsers > 0) {
            const currentCount = room.getClientCount();
            if (currentCount >= room.settings.maxUsers) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Room is full' });
              ws.close(4003, 'Room full');
              return;
            }
          }

          const sessionIndex = room.sessionManager.allocateSessionIndex();
          ws.sessionIndex = sessionIndex;

          const username = room.sessionManager.getUniqueName(data.n || 'Guest');
          console.log(`[CONNECT] Session ${sessionIndex} joining room ${room.id} as "${username}"`);

          room.sessionManager.createUser(
            sessionIndex,
            username,
            Tool.BRUSH,
            packColor([0, 0, 0, 1]),
            getIpHash(ws.clientIp)
          );
          const createdUser = room.sessionManager.getUser(sessionIndex);
          if (createdUser) {
            createdUser.isMuted = !!ws.isMuted;
          }

          sendTo(ws, { t: T.CONNECT, u: sessionIndex, authRole: ws.userRole, authUsername: username });

          const allUsers = room.sessionManager.getJoinedUsers();
          const roomBroadcaster = createRoomBroadcaster(room);

          if (!room.sessionManager.isDiscovery) {
            roomBroadcaster({
              t: T.USERS,
              us: mapUsersForBroadcast(allUsers)
            });
          } else {
            // In discovery, only send to self, no broadcast
            sendTo(ws, {
              t: T.USERS,
              us: mapUsersForBroadcast(allUsers)
            });
          }

          sendTo(ws, {
            t: T.SETTINGS,
            m: room.settings.mirror,
            mirrorRegionsJson: JSON.stringify(room.settings.mirrorRegions || []),
            roomBackgroundColor: room.settings.backgroundColor,
            roomLocked: room.settings.locked,
            roomMaxUsers: room.settings.maxUsers,
            roomModInactiveImmune: room.settings.modInactiveImmune
          });

          // If user is muted (IP-based for guests), hide their cursor for everyone
          if (ws.isMuted) {
            roomBroadcaster({ t: T.HIDE_CURSOR, u: sessionIndex });
          }
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

        case T.SYNC_TILE_OWNERSHIP:
          room.syncCoordinator.handleSyncTileOwnership(ws, data);
          break;

        case T.TILE_UPDATE:
          // Real-time tile update - server tracks which tiles are now occupied
          if (data.tiles && Array.isArray(data.tiles)) {
            const tileIndices = data.tiles.map(t => typeof t === 'number' ? t : t.idx);
            room.markTilesDirty(ws.sessionIndex, tileIndices);
            // Relay to other clients with sender's user ID
            broadcastToRoom(room, {
              t: T.TILE_UPDATE,
              u: ws.sessionIndex,
              tiles: data.tiles
            }, ws.sessionIndex);
          }
          break;

        case T.TILE_CLEAR:
          // Tiles that are now empty - clear from server and relay to all clients
          if (data.clearedTiles && Array.isArray(data.clearedTiles)) {
            // Clear from server's tile dirty set
            room.clearTiles(data.clearedTiles);
            
            // Relay to other clients
            broadcastToRoom(room, {
              t: T.TILE_CLEAR,
              clearedTiles: data.clearedTiles
            }, ws.sessionIndex);
          }
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
          const modActionType = data.modActionType ?? 0;
          const MOD_ACTION_MAP = [Action.MOD_KICK, Action.MOD_MUTE, Action.MOD_BAN, Action.MOD_UNMUTE, Action.MOD_UNBAN, Action.MOD_UPDATE];
          const requiredAction = MOD_ACTION_MAP[modActionType];
          if (!requiredAction || !authorize(ws, requiredAction, sendTo, T.MOD_RESULT)) {
            console.log(`[MOD] REJECTED - insufficient role (role=${ws.userRole}, actionType=${modActionType})`);
            break;
          }
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
          const targetRole = Math.max(targetWs?.userRole || 0, targetUser?.role || 0);

          const rejectProtectedTarget = (message) => {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: message });
          };

          try {
            const roomBroadcaster = createRoomBroadcaster(room);

            console.log(`[Mod] MOD_ACTION received: type=${modActionType}, target=${modTargetIndex}, targetWs=${!!targetWs}`);
            switch (modActionType) {
              case 0: // Kick
                if (targetRole > (ws.userRole || 0)) {
                  rejectProtectedTarget('Cannot kick a user with a higher role than your own');
                  break;
                }
                console.log(`[MOD] KICKING sessionIndex=${modTargetIndex}, targetWs=${!!targetWs}`);
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 0,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                if (targetWs) {
                  console.log(`[MOD] CLOSING ws for sessionIndex=${modTargetIndex}`);
                  targetWs.close(4002, 'Kicked');
                } else {
                  console.log(`[MOD] TARGET NOT FOUND for sessionIndex=${modTargetIndex}`);
                  console.log(`[MOD] All client sessionIndexes:`, [...wss.clients].map(c => c.sessionIndex));
                }
                break;

              case 1: { // Mute
                if (targetRole >= Role.MOD) {
                  rejectProtectedTarget('Users with MOD rank or higher cannot be muted');
                  break;
                }
                if (targetRole > (ws.userRole || 0)) {
                  rejectProtectedTarget('Cannot mute a user with a higher role than your own');
                  break;
                }
                const isGlobalMute = (ws.globalRole || 0) >= Role.HOLY;
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
                    roomId: isGlobalMute ? null : room.id
                  });
                }
                if (targetWs) {
                  targetWs.isMuted = true;
                }
                if (targetUser) {
                  targetUser.isMuted = true;
                }
                roomBroadcaster({ t: T.HIDE_CURSOR, u: modTargetIndex });
                roomBroadcaster({
                  t: T.USERS,
                  us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
                });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 1,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 2: { // Ban
                if (targetRole > (ws.userRole || 0)) {
                  rejectProtectedTarget('Cannot ban a user with a higher role than your own');
                  break;
                }
                // Ban immunity: HOLY(7)+ can't be room-banned; room owner can't be banned from own room
                if (targetWs?.globalRole >= Role.HOLY) {
                  sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot ban users with global HOLY+ rank' });
                  break;
                }
                if (room.ownerId && targetWs?.userId === room.ownerId) {
                  sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot ban the room owner' });
                  break;
                }
                const isGlobalBan = (ws.globalRole || 0) >= Role.HOLY;
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
                    roomId: isGlobalBan ? null : room.id
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
              }

              case 3: // Unmute
                if (getDB()) {
                  const revokeEntryId = (data.modReason || '').trim();
                  const hasSpecificEntryId = /^[a-f0-9]{24}$/i.test(revokeEntryId);

                  if (hasSpecificEntryId) {
                    await revokeModAction(revokeEntryId, ws.userId);
                  } else {
                    await revokeMatchingModActions({
                      type: 'mute',
                      targetUserId: targetWs?.userId || null,
                      targetIp: targetWs?.clientIp || null,
                      targetUsername: targetName || null,
                      roomId: room.id,
                      revokedById: ws.userId
                    });
                  }
                }

                let stillMuted = false;
                if (targetWs) {
                  const remainingMute = await checkMute(targetWs.userId || null, targetWs.clientIp || null, room.id);
                  stillMuted = !!remainingMute && (targetWs.userRole || 0) < Role.MOD;
                  targetWs.isMuted = stillMuted;
                }
                if (targetUser) {
                  targetUser.isMuted = stillMuted;
                }
                if (!stillMuted) {
                  roomBroadcaster({ t: T.SHOW_CURSOR, u: modTargetIndex });
                }
                roomBroadcaster({
                  t: T.USERS,
                  us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
                });
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 3,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;

              case 5: { // Update reason for an existing kick/mute/ban
                // modDuration is repurposed here to carry the original action code (0=kick,1=mute,2=ban)
                const origActionCode = modDuration;
                if (origActionCode === 1 || origActionCode === 2) {
                  const type = origActionCode === 1 ? 'mute' : 'ban';
                  if (getDB()) {
                    await updateModActionReason(
                      targetWs?.userId || null,
                      targetWs?.clientIp || null,
                      type,
                      modReason
                    );
                  }
                }
                roomBroadcaster({
                  t: T.MOD_NOTIFY,
                  modActionType: 5,
                  modTarget: modTargetIndex,
                  modTargetName: targetName,
                  modIssuerName: ws.username || `User ${ws.sessionIndex}`,
                  modReason: modReason
                });
                break;
              }

              case 4: // Unban
                if (getDB()) {
                  const revokeEntryId = (data.modReason || '').trim();
                  const hasSpecificEntryId = /^[a-f0-9]{24}$/i.test(revokeEntryId);

                  if (hasSpecificEntryId) {
                    await revokeModAction(revokeEntryId, ws.userId);
                  } else {
                    await revokeMatchingModActions({
                      type: 'ban',
                      targetUserId: targetWs?.userId || null,
                      targetIp: targetWs?.clientIp || null,
                      targetUsername: targetName || null,
                      roomId: room.id,
                      revokedById: ws.userId
                    });
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
          if (!authorize(ws, Action.MOD_WIPE, sendTo, T.MOD_RESULT)) break;

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
                backgroundColor: r.backgroundColor || '#ffffff',
                ownerId: r.ownerId || '',
                ownerUsername: r.ownerUsername || '',
                preview: r.preview || null
              }))
            });
          } catch (err) {
            console.error('[Room] List error:', err);
          }
          break;
        }

        case T.ROOM_PREVIEW: {
          // Store preview image for this room (sent by any user in the room)
          if (data.img && data.img.length > 0) {
            // Limit preview size to 100KB to prevent abuse
            if (data.img.length <= 100 * 1024) {
              room.setPreview(Buffer.from(data.img));
            }
          }
          break;
        }

        case T.ROOM_UPDATE: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const isOwner = room.ownerId === ws.userId;
          const isMod = ws.userRole >= Role.ADMIN;  // ADMIN(5)+ can update any room

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
              room.settings.maxUsers = Math.max(2, Math.min(60, data.roomMaxUsers || 40));
            }
            if (data.roomBackgroundColor !== undefined) {
              const hex = data.roomBackgroundColor;
              if (hex && /^#[0-9A-Fa-f]{6}$/.test(hex)) {
                room.settings.backgroundColor = hex;
              }
            }
            if (data.roomModInactiveImmune !== undefined) {
              room.settings.modInactiveImmune = !!data.roomModInactiveImmune;
              room.sessionManager.checkAfkUsers();
            }

            await room.saveToDB();

            // Broadcast updated settings to all clients in the room
            const roomBroadcaster = createRoomBroadcaster(room);
            roomBroadcaster({
              t: T.SETTINGS,
              m: room.settings.mirror,
              mirrorRegionsJson: JSON.stringify(room.settings.mirrorRegions || []),
              roomBackgroundColor: room.settings.backgroundColor,
              roomLocked: room.settings.locked,
              roomMaxUsers: room.settings.maxUsers,
              roomModInactiveImmune: room.settings.modInactiveImmune
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Room] Update error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to update room' });
          }
          break;
        }

        case T.ROOM_REGISTER: {
          // Claim ownership of an unowned room
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in to register a room' });
            break;
          }

          if (room.ownerId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'This room already has an owner' });
            break;
          }

          // Prevent registering lobby or discovery rooms
          if (room.id === 'lobby' || room.id === '_discovery') {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot register this room' });
            break;
          }

          try {
            room.ownerId = ws.userId;
            room.ownerUsername = ws.username;
            await room.saveToDB();

            // Update the registering user's effective role to OWNER(6)
            ws.roomRole = Role.OWNER;
            ws.userRole = computeEffectiveRole(ws.globalRole || 0, Role.OWNER);

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) user.role = ws.userRole;

            // Notify the user of their new role
            sendTo(ws, { t: T.AUTH_RESULT, a: true, authRole: ws.userRole });

            // Broadcast updated user list so everyone sees the new role
            createRoomBroadcaster(room)({
              t: T.USERS,
              us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
            });

            // Broadcast ownership change to all clients in the room
            createRoomBroadcaster(room)({
              t: T.ROOM_OWNERSHIP,
              ownerId: room.ownerId,
              ownerUsername: room.ownerUsername
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
            console.log(`[Room] ${ws.username} registered as owner of room "${room.id}"`);
          } catch (err) {
            console.error('[Room] Register error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to register room' });
          }
          break;
        }

        case T.ROOM_UNREGISTER: {
          // Release ownership of a room (owner or DEITY only)
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          if (!room.ownerId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'This room is not registered' });
            break;
          }

          // Only room owner or DEITY can unregister
          const isRoomOwner = room.ownerId === ws.userId;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;

          if (!isRoomOwner && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only room owner or DEITY can unregister a room' });
            break;
          }

          try {
            const previousOwnerId = room.ownerId;
            room.ownerId = null;
            room.ownerUsername = null;
            await room.saveToDB();

            // If the unregistering user was the owner, reset their room role
            if (isRoomOwner) {
              ws.roomRole = 0;
              ws.userRole = computeEffectiveRole(ws.globalRole || 0, 0);

              const user = room.sessionManager.getUser(ws.sessionIndex);
              if (user) user.role = ws.userRole;

              // Notify the user of their new role
              sendTo(ws, { t: T.AUTH_RESULT, a: true, authRole: ws.userRole });
            }

            // Broadcast updated user list
            createRoomBroadcaster(room)({
              t: T.USERS,
              us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
            });

            // Broadcast ownership change to all clients in the room
            createRoomBroadcaster(room)({
              t: T.ROOM_OWNERSHIP,
              ownerId: null,
              ownerUsername: null
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
            console.log(`[Room] ${ws.username} unregistered room "${room.id}" (previous owner: ${previousOwnerId})`);
          } catch (err) {
            console.error('[Room] Unregister error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to unregister room' });
          }
          break;
        }

        case T.MOD_LIST: {
          if (!authorize(ws, Action.MOD_LIST, sendTo, T.MOD_RESULT)) break;

          try {
            const entries = await getModEntries({
              showHistory: !!data.modShowHistory,
              search: data.modSearch || '',
              roomId: room.id
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

        case T.ROOM_ROLE_SET: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const targetSessionIdx = parseInt(data.roomRoleTargetId, 10);
          const newRole = data.roomRoleValue;

          if (newRole == null || newRole < 0 || newRole > Role.ADMIN) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Invalid role value (0-5)' });
            break;
          }

          // Resolve target session index to their ws/userId
          let targetClient = null;
          for (const client of room.clients) {
            if (client.sessionIndex === targetSessionIdx && client.readyState === WebSocket.OPEN) {
              targetClient = client;
              break;
            }
          }

          if (!targetClient || !targetClient.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Target user not found or not logged in' });
            break;
          }

          const targetUserId = targetClient.userId;

          // Permission: room owner, effective ADMIN(5)+ in room, or global DEITY(9)
          const isOwner = room.ownerId === ws.userId;
          const isRoomAdmin = ws.userRole >= Role.ADMIN;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;

          if (!isOwner && !isRoomAdmin && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          // Can't assign role >= your own effective role (unless DEITY)
          if (!isDeity && newRole >= ws.userRole) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot assign role equal to or higher than your own' });
            break;
          }

          try {
            if (newRole === 0) {
              const { removeRoomRole } = await import('./roomRoles.js');
              await removeRoomRole(room.id, targetUserId);
            } else {
              await setRoomRole(room.id, targetUserId, newRole, ws.userId);
            }

            // Update their effective role live
            targetClient.roomRole = newRole;
            const effective = computeEffectiveRole(targetClient.globalRole || 0, newRole);
            targetClient.userRole = effective;

            const targetUser = room.sessionManager.getUser(targetClient.sessionIndex);
            if (targetUser) targetUser.role = effective;

            // Notify the target user of their new role
            sendTo(targetClient, { t: T.AUTH_RESULT, a: true, authRole: effective });

            // Re-broadcast user list so all clients see updated role badge
            createRoomBroadcaster(room)({
              t: T.USERS,
              us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Room] Role set error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to set room role' });
          }
          break;
        }

        case T.AUTH_REGISTER: {
          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const regUsername = (data.authUsername || '').trim();
          const regPassword = data.authPassword || '';
          const regEmail = (data.authEmail || '').trim();
          const regSecretQuestion = (data.authSecretQuestion || '').trim();
          const regSecretAnswer = (data.authSecretAnswer || '').trim();

          if (!isValidUsername(regUsername)) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Username must be 2-20 characters (letters, numbers, underscores)' });
            break;
          }
          if (regPassword.length < 6) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Password must be at least 6 characters' });
            break;
          }
          if (regSecretQuestion && !regSecretAnswer) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Secret answer is required when providing a secret question' });
            break;
          }

          try {
            const passwordHash = await hashPassword(regPassword);
            // Hash the secret answer the same way as passwords (bcrypt)
            const secretAnswerHash = regSecretAnswer ? await hashPassword(regSecretAnswer.toLowerCase()) : null;
            const userCount = await db.collection('users').countDocuments();
            const role = userCount === 0 ? Role.DEITY : Role.USER;

            const newUserDoc = {
              username: regUsername,
              passwordHash,
              role,
              createdAt: new Date(),
              lastLoginAt: new Date(),
              lastIp: ws.clientIp,
              ipHistory: [ws.clientIp]
            };
            if (regEmail) newUserDoc.email = regEmail;
            if (regSecretQuestion) {
              newUserDoc.secretQuestion = regSecretQuestion;
              newUserDoc.secretAnswerHash = secretAnswerHash;
            }

            const result = await db.collection('users').insertOne(newUserDoc);
            const token = generateToken({ userId: result.insertedId.toString(), username: regUsername, role });

            ws.userId = result.insertedId.toString();
            ws.globalRole = role;
            ws.roomRole = 0;
            ws.userRole = role;  // No room role yet for new registration
            ws.username = regUsername;

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              const uniqueName = room.sessionManager.getUniqueName(regUsername, ws.sessionIndex);
              user.role = role;
              user.name = uniqueName;
              user.registeredName = regUsername;
              // ws.username remains the original registered username for AUTH_RESULT
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: role,
              authUsername: regUsername
            });

            createRoomBroadcaster(room)({
              t: T.USERS,
              us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
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
          console.log(`[Auth] AUTH_LOGIN from session ${ws.sessionIndex} in room ${room.id} (token: ${!!data.authToken}, user/pass: ${!!data.authUsername})`);
          const db = getDB();
          if (!db) {
            console.log('[Auth] DB not available, rejecting');
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          try {
            let userDoc = null;

            if (data.authToken) {
              const decoded = verifyToken(data.authToken);
              if (!decoded) {
                console.log('[Auth] Token invalid/expired');
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

            // Room-scoped ban check (matches room bans + global bans)
            const banCheck = await checkBan(userDoc._id.toString(), ws.clientIp, room.id);

            if (banCheck) {
              const globalRole = userDoc.role;
              const isRoomBan = banCheck.roomId != null;
              // HOLY(7)+ are immune to room bans; room owner immune to own-room bans
              const isImmune = (isRoomBan && globalRole >= Role.HOLY)
                || (isRoomBan && room.ownerId === userDoc._id.toString());

              if (!isImmune && globalRole < Role.MOD) {
                const expiry = banCheck.expiresAt ? ` until ${banCheck.expiresAt.toISOString()}` : ' permanently';
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: `You are banned${expiry}. Reason: ${banCheck.reason || 'No reason given'}` });
                ws.close(4001, 'Banned');
                break;
              }
            }

            // Room-scoped mute check
            const muteCheck = await checkMute(userDoc._id.toString(), ws.clientIp, room.id);
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

            // Compute effective role: max(global, room-specific, owner status)
            const roomRoleDoc = await getRoomRole(room.id, userDoc._id.toString());
            let roomRoleVal = roomRoleDoc?.role || 0;
            // Room owner automatically gets OWNER(6) role in their room
            if (room.ownerId === userDoc._id.toString()) {
              roomRoleVal = Math.max(roomRoleVal, Role.OWNER);
            }
            const effectiveRole = computeEffectiveRole(userDoc.role, roomRoleVal);

            ws.userId = userDoc._id.toString();
            ws.globalRole = userDoc.role;
            ws.roomRole = roomRoleVal;
            ws.userRole = effectiveRole;
            ws.username = userDoc.username;
            console.log(`[Auth] Login success: ${userDoc.username} (global=${userDoc.role}, room=${roomRoleVal}, effective=${effectiveRole}) in room ${room.id}`);

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              const uniqueName = room.sessionManager.getUniqueName(userDoc.username, ws.sessionIndex);
              user.role = effectiveRole;
              user.name = uniqueName;
              user.registeredName = userDoc.username;
              user.isMuted = !!ws.isMuted;
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: effectiveRole,
              authUsername: userDoc.username
            });

            createRoomBroadcaster(room)({
              t: T.USERS,
              us: mapUsersForBroadcast(room.sessionManager.getJoinedUsers())
            });

            if (ws.isMuted) {
              // Hide cursor for all other users
              createRoomBroadcaster(room)({ t: T.HIDE_CURSOR, u: ws.sessionIndex });

              // Notify the muted user
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
            handleBroadcast(data, ws.sessionIndex, room, ws);
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
              room.settings.mirrorRegions = [];
              room.syncCoordinator.clearPendingRequests();
              room.setPreview(null);
            // Clear tile data when room empties - stale data shouldn't persist
            room.clearAllTiles();
            roomManager.broadcastRoomListUpdate();
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
