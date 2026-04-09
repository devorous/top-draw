import { WebSocketServer, WebSocket } from 'ws';
import { MongoClient, ObjectId } from 'mongodb';
import { createServer } from 'http';
import { verifyToken } from './auth.js';
import { getClientIp, httpRateLimiter, messengerRateLimiter } from './security.js';
import {
  getDirectMessageRoomParticipants,
  isValidDirectMessageRoomId,
  isValidUsername,
  normalizeUsername
} from '../shared/identity.js';

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_MESSENGER_DB_NAME || 'ddraw_messenger';
const USERS_DB_NAME = process.env.MONGODB_DB_NAME || 'Draw';
const MAX_WS_PAYLOAD_BYTES = 128 * 1024;
const HTTP_LOOKUP_LIMIT = { max: 30, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };
const WS_CONNECT_LIMIT = { max: 20, windowMs: 60 * 1000, blockMs: 10 * 60 * 1000 };
const WS_MESSAGE_LIMIT = { max: 120, windowMs: 60 * 1000, blockMs: 5 * 60 * 1000 };

let db;
let usersDb;
const clients = new Map(); // username -> WebSocket connection

function rateLimitKey(prefix, ip, suffix = '') {
  return suffix ? `${prefix}:${ip}:${suffix}` : `${prefix}:${ip}`;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(body));
}

function isValidMessengerRoomId(roomId, currentUserId, otherUserId) {
  return isValidDirectMessageRoomId(roomId, currentUserId, otherUserId);
}

function matchesRequestedMessengerIdentity(requestedIdentity, user) {
  const normalizedIdentity = normalizeUsername(requestedIdentity);
  return requestedIdentity === user._id.toString() || normalizedIdentity === user.username;
}

async function getAuthenticatedMessengerUser(token) {
  const decoded = verifyToken(token);
  if (!decoded) return null;

  if (decoded.userId && ObjectId.isValid(decoded.userId)) {
    const user = await usersDb.collection('users').findOne(
      { _id: new ObjectId(decoded.userId) },
      { projection: { username: 1 } }
    );
    if (user) return user;
  }

  if (!decoded.username) return null;
  return usersDb.collection('users').findOne(
    { username: normalizeUsername(decoded.username) },
    { projection: { username: 1 }, collation: { locale: 'en', strength: 2 } }
  );
}

async function initDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  usersDb = client.db(USERS_DB_NAME);
  console.log(`Connected to MongoDB: ${MONGODB_URI} (${DB_NAME}, users=${USERS_DB_NAME})`);
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('OK');
    return;
  }

  if (url.pathname === '/check-user' && req.method === 'GET') {
    const clientIp = getClientIp(req);
    const lookupLimit = httpRateLimiter.consume(rateLimitKey('messenger:lookup', clientIp), HTTP_LOOKUP_LIMIT);
    if (!lookupLimit.allowed) {
      json(res, 429, { exists: false, error: 'Too many lookup requests' });
      return;
    }

    const username = normalizeUsername(url.searchParams.get('username'));
    if (!isValidUsername(username)) {
      json(res, 400, { exists: false });
      return;
    }

    try {
      const user = await usersDb.collection('users').findOne(
        { username },
        { projection: { username: 1 }, collation: { locale: 'en', strength: 2 } }
      );
      json(res, 200, { exists: !!user, username: user?.username || null });
    } catch (err) {
      console.error('[Messenger] Check-user error:', err);
      json(res, 500, { exists: false });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_WS_PAYLOAD_BYTES });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientIp = getClientIp(req);
  const connectLimit = messengerRateLimiter.consume(rateLimitKey('messenger:connect', clientIp), WS_CONNECT_LIMIT);
  if (!connectLimit.allowed) {
    ws.close(4408, 'Rate limit exceeded');
    return;
  }

  const userId = String(url.searchParams.get('userId') || '').trim();
  const token = String(url.searchParams.get('token') || '').trim();
  const authUser = await getAuthenticatedMessengerUser(token);

  if (!userId || !authUser || !matchesRequestedMessengerIdentity(userId, authUser)) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  ws.username = authUser.username;
  ws.clientIp = clientIp;
  clients.set(ws.username, ws);
  console.log(`[Messenger] User ${ws.username} connected`);

  ws.on('message', async (data) => {
    try {
      const messageLimit = messengerRateLimiter.consume(
        rateLimitKey('messenger:message', clientIp),
        WS_MESSAGE_LIMIT
      );
      if (!messageLimit.allowed) {
        ws.close(4408, 'Rate limit exceeded');
        return;
      }

      const message = JSON.parse(data.toString());
      const type = String(message?.type || '');
      const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};
      if (!type || !db) return;

      if (type === 'init_chat') {
        const roomId = String(payload.roomId || '').trim();
        const participants = getDirectMessageRoomParticipants(roomId);
        if (!participants || participants.length !== 2 || !participants.includes(ws.username)) return;

        const history = await db.collection('messages')
          .find({ room_id: roomId })
          .sort({ timestamp: -1 })
          .limit(50)
          .toArray();

        ws.send(JSON.stringify({ type: 'history', payload: history.reverse() }));
        return;
      }

      if (type === 'get_inbox') {
        const inbox = await db.collection('messages').aggregate([
          { $match: { $or: [{ sender_id: ws.username }, { receiver_id: ws.username }] } },
          { $sort: { timestamp: -1 } },
          {
            $group: {
              _id: '$room_id',
              latestMessage: { $first: '$$ROOT' }
            }
          },
          { $sort: { 'latestMessage.timestamp': -1 } }
        ]).toArray();

        ws.send(JSON.stringify({ type: 'inbox', payload: inbox.map((item) => item.latestMessage) }));
        return;
      }

      if (type === 'send_message') {
        const receiverId = normalizeUsername(payload.receiver_id);
        const roomId = String(payload.room_id || '').trim();
        const encryptedContent = String(payload.encrypted_content || '').trim();
        const iv = String(payload.iv || '').trim();

        if (!isValidUsername(receiverId) || !roomId || !encryptedContent || !iv) return;
        if (encryptedContent.length > 16384 || iv.length > 256) return;
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

        const receiver = clients.get(receiverId);
        if (receiver?.readyState === WebSocket.OPEN) {
          receiver.send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'new_message', payload: msgDoc }));
        }
      }
    } catch (err) {
      console.error('[Messenger] Message error:', err);
    }
  });

  ws.on('close', () => {
    if (clients.get(ws.username) === ws) {
      clients.delete(ws.username);
    }
    console.log(`[Messenger] User ${ws.username} disconnected`);
  });

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ready' }));
  }
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Messenger server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
