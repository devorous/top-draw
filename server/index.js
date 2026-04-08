/** @fileoverview Main entry point for the WebSocket server, handling connections, message routing, and room management. */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import protobuf from 'protobufjs';
import { ObjectId } from 'mongodb';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { connectDB, getDB } from './db.js';
import { handleGalleryList, handleGalleryUpload, handleGalleryItem, handleGalleryLike, handleGalleryFavorite, handleGalleryFavorites, handleGalleryFavoriteCheck, handleGalleryCommentsList, handleGalleryCommentCreate, handleGalleryCommentDelete, handleGalleryDelete, handleGallerySidebar, handleGalleryTagsUpdate } from './gallery.js';
import { handleAuthLogin, handleAuthRegister, handleAuthMe } from './authRoutes.js';
import { handleUserProfile } from './userRoutes.js';
import { handleSnapshotSave, handleSnapshotList, handleSnapshotRestore, handleSnapshotDelete, handleSnapshotGet, handleSnapshotRegionRestore } from './snapshots.js';
import { handleCheckpointUpload, handleCheckpointList, handleCheckpointGet } from './checkpoints.js';
import { getRecorder, removeRecorder, getReplayData } from './deltaRecorder.js';
import { startElection, stopElection } from './uploaderElection.js';
import { hashPassword, verifyPassword, generateToken, verifyToken } from './auth.js';
import { issueModAction, revokeModAction, revokeMatchingModActions, updateModActionReason, getModEntries, obfuscateIp, checkBan, checkMute } from './moderation.js';
import { T, Tool, ToolNames, ToolToEnum } from '../shared/MessageTypes.js';
import { packColor, unpackColor } from '../shared/ColorUtils.js';
import { SessionManager, Role, RoleNames } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { RoomManager } from './RoomManager.js';
import { sanitizeMessage } from './validation.js';
import { authorize, Action } from './permissions.js';
import { getRoomRole, setRoomRole, computeEffectiveRole, getRoomRoleRoster } from './roomRoles.js';
import { getClientIp, httpRateLimiter, messengerRateLimiter, wsRateLimiter } from './security.js';
import { getAsnCheckStatus, lookupAsnForIp, initAsnCheck, isVpnAsn } from './asnCheck.js';
import { authLimiter, uploadLimiter, likeLimiter, wsMessageLimiter, wsConnectionLimiter, feedbackLimiter } from './rateLimit.js';
import { getUsernameValidationMessage, isValidUsername, normalizeUsername } from '../shared/identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8000;
const DISABLE_RATE_LIMITS = process.env.DISABLE_RATE_LIMITS === 'true';
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MESSENGER_QUERY_LIMIT = { max: 30, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_CONNECTION_LIMIT = { max: 60, windowMs: 60 * 1000, blockMs: 10 * 60 * 1000 };
const MESSENGER_CONNECTION_LIMIT = { max: 20, windowMs: 60 * 1000, blockMs: 10 * 60 * 1000 };
const MESSENGER_MESSAGE_LIMIT = { max: 120, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_DRAW_LIMIT = { max: 5000, windowMs: 10 * 1000, blockMs: 15 * 1000 };
const WS_CHAT_LIMIT = { max: 20, windowMs: 10 * 1000, blockMs: 30 * 1000 };
const WS_CHAT_IMAGE_LIMIT = { max: 4, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_HEAVY_IMAGE_LIMIT = { max: 180, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_GLITCH_RESULT_LIMIT = { max: 360, windowMs: 60 * 1000, blockMs: 60 * 1000 };
const WS_AUTH_LIMIT = { max: 8, windowMs: 10 * 60 * 1000, blockMs: 15 * 60 * 1000 };
const WS_ADMIN_LIMIT = { max: 60, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const VALID_ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ROOM_JOIN_POLICIES = new Set(['open', 'registered', 'trusted']);
const ADMIN_COLLECTIONS = new Set([
  'users',
  'rooms',
  'moderation',
  'room_roles',
  'gallery',
  'favorites',
  'comments',
  'messages'
]);

function getJoinPolicyMinRole(joinPolicy) {
  if (joinPolicy === 'trusted') return Role.TRUSTED;
  if (joinPolicy === 'registered') return Role.USER;
  return Role.GUEST;
}

function sanitizeRoomId(roomId) {
  const normalized = String(roomId || 'default').trim();
  return VALID_ROOM_ID_RE.test(normalized) ? normalized : 'default';
}

function rateLimitKey(prefix, ip, suffix = '') {
  return suffix ? `${prefix}:${ip}:${suffix}` : `${prefix}:${ip}`;
}

function shouldAllowWsMessage(ws, data) {
  const ip = ws.clientIp || 'unknown';
  let config = WS_DRAW_LIMIT;
  let suffix = 'default';

  switch (data.t) {
    case T.MM:
    case T.MD:
    case T.MU:
    case T.CP:
    case T.CS:
    case T.CSP:
    case T.CSM:
    case T.CHD:
    case T.CBR:
    case T.CC:
    case T.CT:
    case T.CF:
    case T.CL:
    case T.CBM:
    case T.KP:
    case T.FILL:
    case T.TEXT_APPLY:
      suffix = 'draw';
      config = WS_DRAW_LIMIT;
      break;

    case T.MSG:
    case T.DM:
      suffix = 'chat';
      config = WS_CHAT_LIMIT;
      break;

    case T.CHAT_IMG:
      suffix = 'chatimg';
      config = WS_CHAT_IMAGE_LIMIT;
      break;

    case T.GLITCH_RESULT:
      suffix = 'glitch';
      config = WS_GLITCH_RESULT_LIMIT;
      break;

    case T.IMG_PASTE:
    case T.SEL_LIFT:
    case T.ROOM_PREVIEW:
    case T.SYNC_CANVAS:
    case T.SYNC_LAYER_BASE:
    case T.SYNC_STROKE:
    case T.SYNC_STROKE_BATCH:
    case T.BOARD_SNAPSHOT_SAVE:
    case T.BOARD_SNAPSHOT_RESTORE:
    case T.CHECKPOINT_UPLOAD:
      suffix = 'heavy';
      config = WS_HEAVY_IMAGE_LIMIT;
      break;

    case T.AUTH_LOGIN:
    case T.AUTH_REGISTER:
      suffix = 'auth';
      config = WS_AUTH_LIMIT;
      break;

    case T.MOD_ACTION:
    case T.MOD_WIPE:
    case T.MOD_LIST:
    case T.ROOM_UPDATE:
    case T.ROOM_ROLE_SET:
    case T.ROOM_ROLE_LIST_REQUEST:
    case T.ROOM_REGISTER:
    case T.ROOM_UNREGISTER:
    case T.GLOBAL_ROLE_SET:
    case T.BOARD_SNAPSHOT_LIST_REQUEST:
    case T.BOARD_SNAPSHOT_DELETE:
    case T.CHECKPOINT_LIST:
    case T.CHECKPOINT_GET:
    case T.REPLAY_REQUEST:
      suffix = 'admin';
      config = WS_ADMIN_LIMIT;
      break;
  }

  const limiterScope = suffix === 'auth' ? ip : (ws.rateLimitId || ip);
  return wsRateLimiter.consume(rateLimitKey('wsmsg', limiterScope, suffix), config).allowed;
}

function isValidMessengerRoomId(roomId, currentUserId, otherUserId) {
  if (!roomId || !currentUserId || !otherUserId) return false;
  const [a, b] = [String(currentUserId), String(otherUserId)].sort();
  return roomId === `${a}:${b}`;
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Payload too large')); return; }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function getAdminHttpUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return null;

  const decoded = verifyToken(token);
  if (!decoded?.userId || !ObjectId.isValid(decoded.userId)) return null;

  const db = getDB();
  if (!db) return null;

  const user = await db.collection('users').findOne(
    { _id: new ObjectId(decoded.userId) },
    { projection: { username: 1, role: 1 } }
  );
  if (!user || (user.role || 0) < Role.DEITY) return null;
  return user;
}

function sanitizeAdminDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;

  const seen = new WeakSet();
  const redactKeys = new Set([
    'passwordHash',
    'secretAnswerHash',
    'authToken',
    'encrypted_content',
    'iv',
    'ipHistory',
    'lastIp'
  ]);

  const walk = (value) => {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return `[binary ${value.length} bytes]`;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object') {
      if (typeof value.toHexString === 'function') return value.toHexString();
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const out = {};
      for (const [key, nested] of Object.entries(value)) {
        out[key] = redactKeys.has(key) ? '[redacted]' : walk(nested);
      }
      return out;
    }
    return value;
  };

  return walk(doc);
}

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

  if (path === '/api/feedback' && req.method === 'POST') {
    if (rateLimited(feedbackLimiter)) return;

    let body;
    try {
      const raw = await readBody(req, 8192);
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'Invalid request body' });
      return;
    }

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const page = body?.page === 'landing' ? 'landing' : 'app';

    if (text.length < 1 || text.length > 2000) {
      json(res, 422, { error: 'Feedback must be between 1 and 2000 characters.' });
      return;
    }

    const db = getDB();
    if (!db) {
      json(res, 503, { error: 'Database unavailable' });
      return;
    }

    try {
      await db.collection('feedback').insertOne({
        text,
        page,
        submittedAt: new Date(),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
      });
      json(res, 201, { ok: true });
    } catch (err) {
      console.error('[Feedback] Insert error:', err);
      json(res, 500, { error: 'Failed to save feedback' });
    }
    return;
  }

  // User profile route
  const userMatch = path.match(/^\/api\/users\/([a-zA-Z0-9_-]+)$/);
  if (userMatch && req.method === 'GET') {
    await handleUserProfile(req, res, userMatch[1]);
    return;
  }

  // Messenger: check if a username exists
  if (path === '/api/messenger/check-user' && req.method === 'GET') {
    const clientIp = getClientIp(req);
    const lookupLimit = httpRateLimiter.consume(rateLimitKey('messenger:lookup', clientIp), MESSENGER_QUERY_LIMIT);
    const corsHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (!lookupLimit.allowed) {
      res.writeHead(429, corsHeaders);
      res.end(JSON.stringify({ exists: false, error: 'Too many lookup requests' }));
      return;
    }

    const username = new URL(req.url, `http://${req.headers.host}`).searchParams.get('username');
    if (!username) { res.writeHead(400, corsHeaders); res.end(JSON.stringify({ exists: false })); return; }
    try {
      const db = getDB();
      const user = await db.collection('users').findOne(
        { username: String(username).trim() },
        { projection: { username: 1 }, collation: { locale: 'en', strength: 2 } }
      );
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ exists: !!user, username: user?.username || null }));
    } catch { res.writeHead(500, corsHeaders); res.end(JSON.stringify({ exists: false })); }
    return;
  }

  if (path === '/api/admin/stats' && req.method === 'GET') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const db = getDB();
    const activeRooms = roomManager
      ? [...roomManager.rooms.values()].filter(room => room.id !== '_discovery' && room.getClientCount() > 0)
      : [];

    const rooms = activeRooms
      .map(room => ({
        id: room.id,
        userCount: room.getClientCount(),
        ownerUsername: room.ownerUsername || '',
        locked: !!room.settings?.locked
      }))
      .sort((a, b) => b.userCount - a.userCount || a.id.localeCompare(b.id));

    json(res, 200, {
      activeUsers: rooms.reduce((sum, room) => sum + room.userCount, 0),
      activeRooms: rooms.length,
      registeredUsers: db ? await db.collection('users').countDocuments() : 0,
      dbAvailable: !!db,
      rooms
    });
    return;
  }

  if (path === '/api/admin/live' && req.method === 'GET') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const activeRooms = roomManager
      ? [...roomManager.rooms.values()].filter(r => r.id !== '_discovery' && r.getClientCount() > 0)
      : [];

    const db = getDB();
    const rooms = await Promise.all(activeRooms.map(async room => {
      const candidates = (room._electionCandidates || []).map(c => ({
        username: c.username,
        ping: c.ping != null ? Math.round(c.ping) : null,
        lowPower: c.lowPower,
        hidden: !!c.hidden,
        active: c.active,
        score: Math.round(c.score * 10) / 10
      }));

      // In-memory snapshot buffer stats
      const snaps = room.snapshots || [];
      const snapshotInfo = {
        buffered: snaps.length,
        oldest: snaps.length ? snaps[0].ts : null,
        newest: snaps.length ? snaps[snaps.length - 1].ts : null,
        lastCheckpointTs: room._lastCheckpointTs || null
      };

      // DB checkpoint count (lightweight)
      let dbCheckpoints = 0;
      if (db) {
        try {
          dbCheckpoints = await db.collection('checkpoints').countDocuments({ roomId: room.id });
        } catch (_) {}
      }

      return {
        id: room.id,
        userCount: room.getClientCount(),
        dedicatedUploader: room.settings.dedicatedReplayUser || null,
        electedUploader: room._electedUploader || null,
        candidates,
        snapshots: snapshotInfo,
        dbCheckpoints
      };
    }));

    json(res, 200, { rooms });
    return;
  }

  const adminCollectionMatch = path.match(/^\/api\/admin\/collections\/([a-zA-Z0-9_-]+)$/);
  if (adminCollectionMatch && req.method === 'GET') {
    const adminUser = await getAdminHttpUser(req);
    if (!adminUser) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }

    const collectionName = adminCollectionMatch[1];
    if (!ADMIN_COLLECTIONS.has(collectionName)) {
      json(res, 404, { error: 'Collection not available' });
      return;
    }

    const db = getDB();
    if (!db) {
      json(res, 503, { error: 'Database unavailable' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 25));

    const collection = db.collection(collectionName);
    const [documents, total] = await Promise.all([
      collection.find({}).sort({ _id: -1 }).limit(limit).toArray(),
      collection.countDocuments()
    ]);

    json(res, 200, {
      collection: collectionName,
      total,
      documents: documents.map(sanitizeAdminDoc)
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on('error', (err) => {
  console.error('[HTTP Server] Error:', err);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

wss.on('error', (err) => {
  console.error('[WebSocket Server] Error:', err);
});

let Msg;
let POOLED_MSG;
let roomManager;

// Messenger: username -> WebSocket
const messengerClients = new Map();

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
function getRoomClientBySessionIndex(room, sessionIndex) {
  if (!room || sessionIndex === undefined || sessionIndex === null) return null;

  for (const client of room.clients) {
    if (client.sessionIndex === sessionIndex) {
      return client;
    }
  }

  return null;
}

function canViewerSeeTargetIp(viewer, targetUser) {
  if (!viewer || !targetUser) return false;

  const viewerRole = viewer.userRole || Role.GUEST;
  const targetRole = targetUser.role || Role.GUEST;

  return viewerRole >= Role.MOD && viewerRole > targetRole;
}

function getVisibleIpForViewer(viewer, targetUser, room) {
  if (!canViewerSeeTargetIp(viewer, targetUser)) return '';

  const targetClient = getRoomClientBySessionIndex(room, targetUser.sessionIndex);
  const targetIp = targetClient?.clientIp || '';
  if (!targetIp) return '';

  return (viewer.userRole || Role.GUEST) >= Role.DEITY
    ? targetIp
    : obfuscateIp(targetIp);
}

function mapUsersForBroadcast(users, viewer = null, room = null) {
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
    fo: u.font || '',
    tm: u.textPositionMultiplier ?? 0,
    to: u.textPositionOffset ?? 0,
    iph: u.ipHash,
    th: u.thinning,
    sim: u.simulatePressure,
    rn: u.registeredName || '',
    mt: !!u.isMuted,
    vip: room ? getVisibleIpForViewer(viewer, u, room) : ''
  }));
}

function sendUsersToClient(ws, room, users = null) {
  if (!ws || !room) return;

  const joinedUsers = users || room.sessionManager.getJoinedUsers();
  sendTo(ws, {
    t: T.USERS,
    us: mapUsersForBroadcast(joinedUsers, ws, room)
  });
}

function isVpnAutoMuteExempt(role) {
  return (role || 0) >= Role.MOD;
}

async function determineMutedStateForClient(client, room, {
  userId = client.userId || null,
  effectiveRole = client.userRole || Role.GUEST
} = {}) {
  let muteReason = '';
  let shouldMute = false;
  const vpnFlagged = isVpnAsn(client.clientAsn);
  client.isVpnNetwork = vpnFlagged;
  client.isVPN = vpnFlagged;

  if (getDB()) {
    const muteCheck = await checkMute(userId, client.clientIp, room.id);
    if (muteCheck && effectiveRole < Role.MOD) {
      shouldMute = true;
      muteReason = muteCheck.reason || '';
    }
  }

  if (!userId && room.settings.autoMuteGuests) {
    shouldMute = true;
    if (!muteReason) muteReason = 'Guests are auto-muted in this room until they log in.';
  }

  if (room.settings.autoMuteVpnUsers && vpnFlagged && !isVpnAutoMuteExempt(effectiveRole)) {
    shouldMute = true;
    if (!muteReason) muteReason = 'VPN or datacenter connections are auto-muted in this room.';
  }

  return { shouldMute, muteReason };
}

function logVpnAutoMuteContext(client, room, contextLabel) {
  if (!room.settings.autoMuteVpnUsers) return;

  const status = getAsnCheckStatus();
  if (!client.clientAsn) {
    console.warn(`[ASN] ${contextLabel}: no ASN resolved for ${client.clientIp} in room ${room.id}; VPN auto-mute cannot evaluate this connection.`);
    return;
  }

  if (!status.ready) {
    console.warn(`[ASN] ${contextLabel}: ASN list not ready yet for ASN ${client.clientAsn} in room ${room.id}.`);
    return;
  }

  console.log(`[ASN] ${contextLabel}: ASN ${client.clientAsn} for ${client.clientIp} in room ${room.id} flagged=${isVpnAsn(client.clientAsn)}`);
}

function logAsnHandshakeContext(client, roomId = '') {
  const status = getAsnCheckStatus();
  const roomLabel = roomId || 'unknown-room';

  if (!client.clientAsn) {
    if (status.dbLoaded) {
      console.warn(`[ASN] WS handshake: no ASN resolved for ${client.clientIp} (room=${roomLabel}). IP may not be in the MaxMind database.`);
    } else {
      console.warn(`[ASN] WS handshake: MaxMind database not loaded; cannot resolve ASN for ${client.clientIp} (room=${roomLabel}).`);
    }
    return;
  }

  if (!status.ready) {
    console.warn(`[ASN] WS handshake: ASN ${client.clientAsn} resolved for ${client.clientIp} (room=${roomLabel}) but VPN blocklist is not ready yet.`);
    return;
  }

  console.log(`[ASN] WS handshake: ASN ${client.clientAsn} for ${client.clientIp} (room=${roomLabel}) flagged=${isVpnAsn(client.clientAsn)}`);
}

async function applyMuteStateToClient(client, room, options = {}) {
  const { shouldMute, muteReason } = await determineMutedStateForClient(client, room, options);
  client.isMuted = shouldMute;

  const roomUser = room.sessionManager.getUser(client.sessionIndex);
  if (roomUser) {
    roomUser.isMuted = shouldMute;
    roomUser.isVPN = !!client.isVPN;
  }

  return { shouldMute, muteReason };
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
  initAsnCheck();

  startBatchTimer();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WebSocket server running on port ${PORT}`);
    if (DISABLE_RATE_LIMITS) console.warn('[SERVER] ⚠ Rate limits DISABLED (DISABLE_RATE_LIMITS=true)');
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
    if (payload?.t === T.USERS) {
      const joinedUsers = room.sessionManager.getJoinedUsers();
      room.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          sendUsersToClient(client, room, joinedUsers);
        }
      });
      return;
    }

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
 * Broadcasts the latest USERS payload to everyone in a room.
 * @param {Object} room
 * @returns {void}
 */
function broadcastUsersForRoom(room) {
  if (!room) return;
  createRoomBroadcaster(room)({
    t: T.USERS
  });
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
  T.CL, T.CBM, T.PAN, T.CANCEL, T.KP, T.TEXT_APPLY, T.HIDE_CURSOR, T.SHOW_CURSOR, T.GMP,
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
  T.MM, T.MD, T.MU, T.KP, T.TEXT_APPLY, T.CLR,
  T.SEL_LIFT, T.SEL_MOVE, T.SEL_COMMIT, T.SEL_DELETE, T.SEL_FILL, T.SEL_STAMP, T.SEL_FLIP, T.SEL_CANCEL, T.SEL_TO_BRUSH,
  T.IMG_PASTE, T.MSG, T.DM, T.CHAT_IMG, T.GLITCH_RESULT,
  T.MIR, T.MIRROR_REGION
]);

/**
 * Builds the T.SETTINGS payload for a room.
 * Single source of truth — used by join, MIRROR_REGION, and ROOM_UPDATE broadcasts.
 * @param {Room} room
 * @returns {Object}
 */
function buildSettingsPayload(room) {
  return {
    t: T.SETTINGS,
    m: room.settings.mirror,
    mirrorRegionsJson: JSON.stringify(room.settings.mirrorRegions || []),
    roomBackgroundColor: room.settings.backgroundColor,
    roomLocked: room.settings.locked,
    roomMaxUsers: room.settings.maxUsers,
    roomModInactiveImmune: room.settings.modInactiveImmune,
    roomJoinPolicy: room.settings.joinPolicy,
    roomAutoMuteGuests: room.settings.autoMuteGuests,
    roomAutoMuteVpnUsers: room.settings.autoMuteVpnUsers,
    roomDedicatedReplayUser: room.settings.dedicatedReplayUser,
    electedUploader: room._electedUploader || ''
  };
}

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

    case T.TEXT_APPLY:
      user.text = '';
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

    case T.CF:
      user.font = data.fo;
      user.textPositionMultiplier = data.tm;
      user.textPositionOffset = data.to;
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
          t: T.USERS
        });
      } else {
        sendUsersToClient(ws, room, allUsers);
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

        if ((payload.action === 'create' || payload.action === 'update') && payload.region) {
          const region = payload.region;
          const x = Math.max(0, Math.floor(region.x || 0));
          const y = Math.max(0, Math.floor(region.y || 0));
          const width = Math.max(1, Math.floor(region.width || 0));
          const height = Math.max(1, Math.floor(region.height || 0));
          const mode = ['horizontal', 'quad', 'rotational', 'radial'].includes(region.mode || region.axis)
            ? (region.mode || region.axis)
            : 'vertical';
          const slices = Math.max(3, Math.min(16, Math.floor(Number(region.slices || 6)) || 6));
          const showLine = region.showLine !== false;
          const id = String(region.id || `mr_${Date.now()}`);

          const nextRegion = {
            id,
            x,
            y,
            width,
            height,
            mode,
            axis: mode,
            slices: mode === 'radial' ? slices : undefined,
            showLine,
            owner: region.owner || region.createdBy || ws.userId || null
          };

          if (payload.action === 'update') {
            room.settings.mirrorRegions = (room.settings.mirrorRegions || []).map(existing =>
              existing.id === id ? nextRegion : existing
            );
          } else {
            room.settings.mirrorRegions = [
              ...(room.settings.mirrorRegions || []),
              nextRegion
            ];
          }
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
        // Forward the lifted snapshot so remote clients reuse the sender's exact pixels
        // instead of attempting to recapture from their own canvases.
        broadcastToRoom(room, { t: T.SEL_LIFT, u: sessionIndex, sx: data.sx, sy: data.sy, sw: data.sw, sh: data.sh, cr: data.cr, g: data.g }, sessionIndex);
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
    broadcastToRoom(room, buildSettingsPayload(room));
    return;
  }

  // Record delta for replay system
  const outgoing = { ...data, u: sessionIndex };
  if (room.settings.dedicatedReplayUser || room._electedUploader) {
    getRecorder(room.id).record(outgoing);
  }

  broadcastToRoom(room, outgoing, sessionIndex);
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
  T.KP, T.TEXT_APPLY, T.HIDE_CURSOR, T.SHOW_CURSOR, T.GMP, T.GPT, T.AFK,
  T.CTHN, T.CSIM, T.FILL, T.CF
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
    const clientIp = getClientIp(req);
    const connectionLimit = messengerRateLimiter.consume(rateLimitKey('messenger:connect', clientIp), MESSENGER_CONNECTION_LIMIT);
    if (!connectionLimit.allowed) {
      ws.close(4408, 'Rate limit exceeded');
      return;
    }

    const userId = String(url.searchParams.get('userId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    const decoded = verifyToken(token);
    if (!userId || !decoded?.username || decoded.username !== userId) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    ws.clientIp = clientIp;
    ws.userId = decoded.userId || null;
    ws.username = decoded.username;

    messengerClients.set(ws.username, ws);
    console.log(`[Messenger] ${ws.username} connected`);

    ws.on('message', async (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        const type = String(envelope?.type || '');
        const payload = envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
        const db = getDB();
        if (!db || !type) return;

        const actionLimit = messengerRateLimiter.consume(
          rateLimitKey('messenger:message', clientIp, type),
          MESSENGER_MESSAGE_LIMIT
        );
        if (!actionLimit.allowed) {
          ws.close(4408, 'Rate limit exceeded');
          return;
        }

        if (type === 'init_chat') {
          const roomId = String(payload.roomId || '').trim();
          const participants = roomId.split(':');
          if (participants.length !== 2 || !participants.includes(ws.username)) return;

          const history = await db.collection('messages')
            .find({ room_id: roomId })
            .sort({ timestamp: -1 })
            .limit(50)
            .toArray();
          ws.send(JSON.stringify({ type: 'history', payload: history.reverse() }));

        } else if (type === 'get_inbox') {
          const inbox = await db.collection('messages').aggregate([
            { $match: { $or: [{ sender_id: ws.username }, { receiver_id: ws.username }] } },
            { $sort: { timestamp: -1 } },
            { $group: { _id: '$room_id', latestMessage: { $first: '$$ROOT' } } },
            { $sort: { 'latestMessage.timestamp': -1 } }
          ]).toArray();
          ws.send(JSON.stringify({ type: 'inbox', payload: inbox.map(i => i.latestMessage) }));

        } else if (type === 'send_message') {
          const receiverId = String(payload.receiver_id || '').trim();
          const roomId = String(payload.room_id || '').trim();
          const encryptedContent = String(payload.encrypted_content || '').trim();
          const iv = String(payload.iv || '').trim();

          if (!receiverId || !roomId || !encryptedContent || !iv) return;
          if (receiverId.length > 32 || encryptedContent.length > 16384 || iv.length > 256) return;
          if (!isValidMessengerRoomId(roomId, ws.username, receiverId)) return;

          const msgDoc = {
            room_id: roomId,
            sender_id: ws.username,
            receiver_id: receiverId,
            encrypted_content: encryptedContent,
            iv,
            timestamp: Date.now()
          };
          await db.collection('messages').insertOne(msgDoc);

          if (messengerClients.has(receiverId)) {
            messengerClients.get(receiverId).send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
          }
          ws.send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
        }
      } catch (err) {
        console.error('[Messenger] Message error:', err);
      }
    });

    ws.on('close', () => {
      messengerClients.delete(ws.username);
      console.log(`[Messenger] ${ws.username} disconnected`);
    });

    return;
  }

  // Drawing server connection
  try {
    // Rate limit new connections per IP
    const connIp = getClientIp(req);
    if (!DISABLE_RATE_LIMITS && !wsConnectionLimiter.check(connIp)) {
      console.warn(`[WS] Connection rate limited: ${connIp}`);
      ws.close(1008, 'Too many connections');
      return;
    }

    console.log(`[WS] New connection attempt from ${req.socket.remoteAddress}`);

    ws.clientIp = connIp;
    if (!DISABLE_RATE_LIMITS) {
      const connectionLimit = wsRateLimiter.consume(rateLimitKey('ws:connect', ws.clientIp), WS_CONNECTION_LIMIT);
      if (!connectionLimit.allowed) {
        ws.close(4408, 'Rate limit exceeded');
        return;
      }
    }

    ws.userRole = Role.GUEST;
    ws.globalRole = Role.GUEST;
    ws.roomRole = 0;
    ws.userId = null;
    ws.username = null;
    ws.isMuted = false;
    ws.clientAsn = lookupAsnForIp(ws.clientIp);
    ws.isVpnNetwork = isVpnAsn(ws.clientAsn);
    ws.isVPN = ws.isVpnNetwork;
    ws.rateLimitId = crypto.randomUUID();

    const roomId = sanitizeRoomId(url.searchParams.get('room'));
    logAsnHandshakeContext(ws, roomId);
    console.log(`[Room] Parsed room ID: ${roomId}`);

    const room = roomManager.getOrCreateRoom(roomId);
    room.addClient(ws);

    console.log(`[Room] Client joined room: ${roomId}, total clients: ${room.getClientCount()}`);

    ws.pingRtt = null;
    ws.lowPowerMode = false;
    ws.tabHidden = false;
    ws.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.pingSentAt = Date.now();
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
    if (!DISABLE_RATE_LIMITS) {
      const wsKey = ws.clientIp || 'unknown';
      if (!wsMessageLimiter.check(wsKey)) {
        return; // Silently drop excess messages
      }
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

      data = await sanitizeMessage(data);
      if (!data) {
        console.warn(`[WS] Rejected invalid message from session ${ws.sessionIndex ?? 'unassigned'}`);
        ws.close(1008, 'Invalid message');
        return;
      }

      if (!DISABLE_RATE_LIMITS && !shouldAllowWsMessage(ws, data)) {
        console.warn(`[WS] Rate limited message from ${ws.clientIp} (type=${data.t})`);
        ws.close(4408, 'Rate limit exceeded');
        return;
      }

      switch (data.t) {
        case T.CONNECT:
          await room.ensureLoaded();

          if (getDB()) {
            try {
              logVpnAutoMuteContext(ws, room, 'Guest connect');
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
              if (room.settings.autoMuteGuests) {
                ws.isMuted = true;
              }
              if (room.settings.autoMuteVpnUsers && isVpnAsn(ws.clientAsn)) {
                ws.isVpnNetwork = true;
                ws.isMuted = true;
                console.warn(`[Security] Auto-muted guest on VPN ASN ${ws.clientAsn || 'unknown'} in room ${room.id}`);
              }
            } catch (err) {
              console.error('[Mod] IP ban/mute check error:', err);
            }
          }

          // Check room capacity
          if (!DISABLE_RATE_LIMITS && room.settings.maxUsers > 0) {
            const currentCount = room.getClientCount();
            if (currentCount >= room.settings.maxUsers) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Room is full' });
              ws.close(4003, 'Room full');
              return;
            }
          }

          const sessionIndex = room.sessionManager.allocateSessionIndex();
          ws.sessionIndex = sessionIndex;

          const requestedUsername = normalizeUsername(data.n || '');
          const username = room.sessionManager.getUniqueName(requestedUsername || 'Guest');
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
            createdUser.isVPN = !!ws.isVPN;
          }

          sendTo(ws, { t: T.CONNECT, u: sessionIndex, authRole: ws.userRole, authUsername: username });

          const allUsers = room.sessionManager.getJoinedUsers();
          const roomBroadcaster = createRoomBroadcaster(room);

          const requiresAuthToAppear = getJoinPolicyMinRole(room.settings.joinPolicy) > Role.GUEST;
          const shouldBroadcastJoin = !requiresAuthToAppear;

          if (!room.sessionManager.isDiscovery && shouldBroadcastJoin) {
            roomBroadcaster({
              t: T.USERS
            });
          } else {
            // In discovery, only send to self, no broadcast
            sendUsersToClient(ws, room, allUsers);
          }

          sendTo(ws, buildSettingsPayload(room));

          // Start/continue election when first user joins (auto mode only)
          if (room.getClientCount() === 1 && !room.settings.dedicatedReplayUser) {
            startElection(room, (r) => broadcastToRoom(r, buildSettingsPayload(r)));
          }

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
          room.syncCoordinator.handleSyncDirtyTiles(ws, data);
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
                  t: T.USERS
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
                  t: T.USERS
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
            const autoMuteGuestsChanged = data.roomAutoMuteGuests !== undefined;
            const autoMuteVpnUsersChanged = data.roomAutoMuteVpnUsers !== undefined;
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
            if (data.roomJoinPolicy !== undefined) {
              const joinPolicy = String(data.roomJoinPolicy || 'open');
              room.settings.joinPolicy = ROOM_JOIN_POLICIES.has(joinPolicy) ? joinPolicy : 'open';
            }
            if (data.roomAutoMuteGuests !== undefined) {
              room.settings.autoMuteGuests = !!data.roomAutoMuteGuests;
            }
            if (data.roomAutoMuteVpnUsers !== undefined) {
              room.settings.autoMuteVpnUsers = !!data.roomAutoMuteVpnUsers;
            }
            if (data.roomDedicatedReplayUser !== undefined) {
              // null clears the dedicated user, otherwise store the username string
              room.settings.dedicatedReplayUser = data.roomDedicatedReplayUser || null;
            }

            await room.saveToDB();

            if (autoMuteGuestsChanged || autoMuteVpnUsersChanged) {
              for (const client of room.clients) {
                const effectiveRole = client.userRole || Role.GUEST;
                const { shouldMute } = await applyMuteStateToClient(client, room, {
                  userId: client.userId || null,
                  effectiveRole
                });
                createRoomBroadcaster(room)({
                  t: shouldMute ? T.HIDE_CURSOR : T.SHOW_CURSOR,
                  u: client.sessionIndex
                });
              }
            }

            // If dedicatedReplayUser changed, start/stop election accordingly
            if (room.settings.dedicatedReplayUser) {
              stopElection(room);
            } else if (!room._electionTimer) {
              startElection(room, (r) => broadcastToRoom(r, buildSettingsPayload(r)));
            }

            // Broadcast updated settings to all clients in the room
            const roomBroadcaster = createRoomBroadcaster(room);
            roomBroadcaster(buildSettingsPayload(room));
            if (autoMuteGuestsChanged || autoMuteVpnUsersChanged) {
              roomBroadcaster({
                t: T.USERS
              });
            }

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
            room.updateSnapshotTimer();

            // Broadcast updated user list so everyone sees the new role
            createRoomBroadcaster(room)({
              t: T.USERS
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
              t: T.USERS
            });

            // Broadcast ownership change to all clients in the room
            createRoomBroadcaster(room)({
              t: T.ROOM_OWNERSHIP,
              ownerId: null,
              ownerUsername: null
            });

            room.updateSnapshotTimer();

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
          if (ws.pingSentAt) {
            ws.pingRtt = Date.now() - ws.pingSentAt;
            ws.pingSentAt = null;
          }
          ws.lowPowerMode = !!data.lowPowerMode;
          ws.tabHidden = !!data.tabHidden;
          break;

        case T.ROOM_ROLE_SET: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const targetIdentifier = String(data.roomRoleTargetId || '').trim();
          const targetUsernameLookup = String(data.roomRoleTargetName || '').trim();
          const newRole = data.roomRoleValue;

          if (newRole == null || newRole < 0 || newRole > Role.ADMIN) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Invalid role value (0-5)' });
            break;
          }

          if (!targetIdentifier && !targetUsernameLookup) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Missing target user' });
            break;
          }

          // Resolve target by online session index first, then fall back to a persisted user id.
          let targetClient = null;
          let targetUserId = '';
          let targetUsername = '';
          const targetSessionIdx = Number.parseInt(targetIdentifier, 10);

          if (targetIdentifier && Number.isInteger(targetSessionIdx) && String(targetSessionIdx) === targetIdentifier) {
            for (const client of room.clients) {
              if (client.sessionIndex === targetSessionIdx && client.readyState === WebSocket.OPEN) {
                targetClient = client;
                break;
              }
            }
          }

          if (targetClient?.userId) {
            targetUserId = targetClient.userId;
            targetUsername = targetClient.username || '';
          } else {
            const db = getDB();
            if (!db) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Database not available' });
              break;
            }

            let targetUserDoc = null;
            if (targetIdentifier && ObjectId.isValid(targetIdentifier)) {
              targetUserId = targetIdentifier;
              targetUserDoc = await db.collection('users').findOne(
                { _id: new ObjectId(targetUserId) },
                { projection: { username: 1, role: 1 } }
              );
            } else if (targetUsernameLookup) {
              targetUserDoc = await db.collection('users').findOne(
                { username: targetUsernameLookup },
                { collation: { locale: 'en', strength: 2 }, projection: { username: 1, role: 1 } }
              );
              targetUserId = targetUserDoc?._id?.toString() || '';
            }

            if (!targetUserDoc || !targetUserId) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Target user not found' });
              break;
            }
            targetUsername = targetUserDoc.username || '';
          }

          // Permission: room owner, effective ADMIN(5)+ in room, or global DEITY(9)
          const isOwner = room.ownerId === ws.userId;
          const isRoomAdmin = ws.userRole >= Role.ADMIN;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;

          if (!isOwner && !isRoomAdmin && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          if (room.ownerId && targetUserId === room.ownerId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Room owner role is managed by room ownership' });
            break;
          }

          // Can't assign role >= your own effective role (unless DEITY)
          if (!isDeity && newRole >= ws.userRole) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot assign role equal to or higher than your own' });
            break;
          }

          try {
            const existingRoleDoc = await getRoomRole(room.id, targetUserId);
            const previousRole = existingRoleDoc?.role || 0;
            if (newRole === 0) {
              const { removeRoomRole } = await import('./roomRoles.js');
              await removeRoomRole(room.id, targetUserId);
            } else {
              await setRoomRole(room.id, {
                userId: targetUserId,
                username: targetUsername,
                role: newRole,
                assignedBy: ws.userId,
                assignedByUsername: ws.username || '',
                previousRole
              });
            }

            // Update their effective role live
            if (targetClient) {
              targetClient.roomRole = newRole;
              const effective = computeEffectiveRole(targetClient.globalRole || 0, newRole);
              targetClient.userRole = effective;

              const targetUser = room.sessionManager.getUser(targetClient.sessionIndex);
              if (targetUser) targetUser.role = effective;

              const { shouldMute } = await applyMuteStateToClient(targetClient, room, {
                userId: targetClient.userId || null,
                effectiveRole: effective
              });

              // Notify the target user of their new role
              sendTo(targetClient, { t: T.AUTH_RESULT, a: true, authRole: effective });

              createRoomBroadcaster(room)({
                t: shouldMute ? T.HIDE_CURSOR : T.SHOW_CURSOR,
                u: targetClient.sessionIndex
              });
            }

            // Re-broadcast user list so all clients see updated role badge
            createRoomBroadcaster(room)({
              t: T.USERS
            });

            sendTo(ws, { t: T.MOD_RESULT, a: true });
          } catch (err) {
            console.error('[Room] Role set error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to set room role' });
          }
          break;
        }

        case T.ROOM_ROLE_LIST_REQUEST: {
          if (!ws.userId) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Must be logged in' });
            break;
          }

          const isOwner = room.ownerId === ws.userId;
          const isRoomAdmin = ws.userRole >= Role.ADMIN;
          const isDeity = (ws.globalRole || 0) >= Role.DEITY;
          if (!isOwner && !isRoomAdmin && !isDeity) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Insufficient permissions' });
            break;
          }

          try {
            const roster = await getRoomRoleRoster(room);
            sendTo(ws, {
              t: T.ROOM_ROLE_LIST_RESPONSE,
              roomRoles: roster.map(entry => ({
                userId: entry.userId,
                username: entry.username,
                role: entry.role,
                updatedBy: entry.updatedBy,
                updatedByUsername: entry.updatedByUsername,
                updatedAt: entry.updatedAt,
                previousRole: entry.previousRole,
                changeType: entry.changeType,
                isOwner: entry.isOwner
              }))
            });
          } catch (err) {
            console.error('[Room] Role list error:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to load room moderators' });
          }
          break;
        }

        case T.GLOBAL_ROLE_SET: {
          // Only DEITY (role 9) can set global roles
          if (!ws.userId || (ws.globalRole || 0) < Role.DEITY) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Only DEITY can set global roles' });
            break;
          }

          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const targetUsername = String(data.targetUsername || '').trim();
          const newGlobalRole = data.newGlobalRole;

          if (!targetUsername) {
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Target username required' });
            break;
          }

          try {
            // Find the target user by username
            const targetUser = await db.collection('users').findOne({ username: targetUsername });
            if (!targetUser) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'User not found' });
              break;
            }

            const previousGlobalRole = targetUser.role || Role.GUEST;
            const allowedGlobalRoles = new Set([Role.USER, Role.NOBLE, Role.HOLY]);
            if (!allowedGlobalRoles.has(newGlobalRole)) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Can only set global role to User, Noble, or Holy' });
              break;
            }

            // Prevent setting role on other Deities
            if (previousGlobalRole >= Role.DEITY) {
              sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Cannot modify DEITY rank' });
              break;
            }

            if (previousGlobalRole === newGlobalRole) {
              sendTo(ws, {
                t: T.MOD_RESULT,
                a: true,
                message: `${targetUsername} is already ${RoleNames[newGlobalRole] || 'role ' + newGlobalRole}`
              });
              break;
            }

            const actionLabel = newGlobalRole > previousGlobalRole
              ? 'promoted'
              : newGlobalRole < previousGlobalRole
                ? 'demoted'
                : 'updated';

            // Update the user's global role
            await db.collection('users').updateOne(
              { _id: targetUser._id },
              { $set: { role: newGlobalRole } }
            );

            // Update all active connections for this user
            const roomsNeedingRefresh = new Set();
            for (const client of wss.clients) {
              if (client.userId === String(targetUser._id)) {
                const clientRoom = roomManager.getRoomByClient(client);
                const roomRole = client.roomRole || 0;
                let effectiveRole = computeEffectiveRole(newGlobalRole, roomRole);
                if (clientRoom?.ownerId && client.userId === clientRoom.ownerId) {
                  effectiveRole = Math.max(effectiveRole, Role.OWNER);
                }

                client.globalRole = newGlobalRole;
                client.userRole = effectiveRole;

                if (clientRoom) {
                  const roomUser = clientRoom.sessionManager.getUser(client.sessionIndex);
                  if (roomUser) {
                    roomUser.role = effectiveRole;
                    roomUser.registeredName = targetUser.username || roomUser.registeredName;
                    roomUser.isMuted = !!client.isMuted;
                  }

                  const { shouldMute } = await applyMuteStateToClient(client, clientRoom, {
                    userId: client.userId || null,
                    effectiveRole
                  });

                  sendTo(client, { t: T.AUTH_RESULT, a: true, authRole: effectiveRole });
                  createRoomBroadcaster(clientRoom)({
                    t: shouldMute ? T.HIDE_CURSOR : T.SHOW_CURSOR,
                    u: client.sessionIndex
                  });
                  roomsNeedingRefresh.add(clientRoom);
                }
              }
            }

            // Send success to requester
            sendTo(ws, {
              t: T.MOD_RESULT,
              a: true,
              message: `${targetUsername} ${actionLabel} to ${RoleNames[newGlobalRole] || 'role ' + newGlobalRole}`
            });

            // Broadcast updated user lists so role badges refresh anywhere they're active
            for (const activeRoom of roomsNeedingRefresh) {
              broadcastUsersForRoom(activeRoom);
            }
          } catch (err) {
            console.error('[Global Role] Error setting global role:', err);
            sendTo(ws, { t: T.MOD_RESULT, a: false, authError: 'Failed to set global role' });
          }
          break;
        }

        case T.AUTH_REGISTER: {
          const db = getDB();
          if (!db) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Database not available' });
            break;
          }

          const registerLimit = wsRateLimiter.consume(rateLimitKey('wsauth:register', ws.clientIp), WS_AUTH_LIMIT);
          if (!registerLimit.allowed) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Too many registration attempts. Please try again later.' });
            break;
          }

          const regUsername = normalizeUsername(data.authUsername || '');
          const regPassword = data.authPassword || '';
          const regEmail = (data.authEmail || '').trim();
          const regSecretQuestion = (data.authSecretQuestion || '').trim();
          const regSecretAnswer = (data.authSecretAnswer || '').trim();

          if (!isValidUsername(regUsername)) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: getUsernameValidationMessage() });
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

            room.updateSnapshotTimer();

            createRoomBroadcaster(room)({
              t: T.USERS
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

          const loginLimit = wsRateLimiter.consume(rateLimitKey('wsauth:login', ws.clientIp), WS_AUTH_LIMIT);
          if (!loginLimit.allowed) {
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Too many login attempts. Please try again later.' });
            break;
          }

          try {
            let userDoc = null;

            if (data.authToken) {
              const decoded = verifyToken(data.authToken);
              if (!decoded?.userId || !ObjectId.isValid(decoded.userId)) {
                console.log('[Auth] Token invalid/expired');
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Invalid or expired token' });
                break;
              }

              userDoc = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
              if (!userDoc) {
                sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Account not found' });
                break;
              }
            } else if (data.authUsername && data.authPassword) {
              const normalizedLoginUsername = normalizeUsername(data.authUsername);
              userDoc = await db.collection('users').findOne(
                { username: normalizedLoginUsername },
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
            const minJoinRole = getJoinPolicyMinRole(room.settings.joinPolicy);
            if (userDoc.role < minJoinRole) {
              sendTo(ws, {
                t: T.AUTH_RESULT,
                a: false,
                authError: room.settings.joinPolicy === 'trusted'
                  ? 'This room is restricted to trusted users and above'
                  : 'This room is restricted to registered users'
              });
              break;
            }

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
            logVpnAutoMuteContext(ws, room, `Auth login for ${userDoc.username}`);
            const { shouldMute, muteReason } = await applyMuteStateToClient(ws, room, {
              userId: userDoc._id.toString(),
              effectiveRole
            });
            console.log(`[Auth] Login success: ${userDoc.username} (global=${userDoc.role}, room=${roomRoleVal}, effective=${effectiveRole}) in room ${room.id}`);
            if (room.settings.autoMuteVpnUsers && ws.isVpnNetwork && !isVpnAutoMuteExempt(effectiveRole) && shouldMute) {
              console.warn(`[Security] Auto-muted user ${userDoc.username} on VPN ASN ${ws.clientAsn || 'unknown'} in room ${room.id}`);
            }

            const user = room.sessionManager.getUser(ws.sessionIndex);
            if (user) {
              const uniqueName = room.sessionManager.getUniqueName(userDoc.username, ws.sessionIndex);
              user.role = effectiveRole;
              user.name = uniqueName;
              user.registeredName = userDoc.username;
              user.isMuted = !!ws.isMuted;
              user.isVPN = !!ws.isVPN;
            }

            sendTo(ws, {
              t: T.AUTH_RESULT,
              a: true,
              authToken: token,
              authRole: effectiveRole,
              authUsername: userDoc.username
            });

            room.updateSnapshotTimer();

            createRoomBroadcaster(room)({
              t: T.USERS
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
                modReason: muteReason || ''
              });
            }
          } catch (err) {
            console.error('[Auth] Login error:', err);
            sendTo(ws, { t: T.AUTH_RESULT, a: false, authError: 'Login failed' });
          }
          break;
        }

        case T.BOARD_SNAPSHOT_SAVE:
          await handleSnapshotSave(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_LIST_REQUEST:
          await handleSnapshotList(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_RESTORE:
          await handleSnapshotRestore(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_DELETE:
          await handleSnapshotDelete(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_GET:
          await handleSnapshotGet(ws, data, room);
          break;

        case T.BOARD_SNAPSHOT_REGION_RESTORE:
          await handleSnapshotRegionRestore(ws, data, room);
          break;

        case T.CHECKPOINT_UPLOAD: {
          const cpId = await handleCheckpointUpload(ws, data, room);
          if (cpId && (room.settings.dedicatedReplayUser || room._electedUploader)) {
            getRecorder(room.id).onCheckpoint(cpId);
          }
          break;
        }

        case T.CHECKPOINT_LIST:
          await handleCheckpointList(ws, room);
          break;

        case T.CHECKPOINT_GET:
          await handleCheckpointGet(ws, data, room);
          break;

        case T.REPLAY_REQUEST: {
          const { checkpointId: replayCpId, deltas } = await getReplayData(
            room.id, data.replayStartTs, data.replayEndTs
          );
          // Fetch checkpoint image if available
          let cpImg = null;
          if (replayCpId) {
            const cpDb = getDB();
            if (cpDb) {
              const cpDoc = await cpDb.collection('checkpoints').findOne(
                { roomId: room.id, checkpointId: replayCpId },
                { projection: { img: 1 } }
              );
              if (cpDoc) cpImg = cpDoc.img;
            }
          }
          ws.send(room.Msg.encode(room.Msg.create({
            t: T.REPLAY_RESPONSE,
            checkpointId: replayCpId || '',
            checkpointImg: cpImg || new Uint8Array(0),
            replayDeltasJson: JSON.stringify(deltas)
          })).finish());
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
      room.updateSnapshotTimer();

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
            // Stop uploader election and flush delta recorder
            stopElection(room);
            removeRecorder(room.id);
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
