import { SessionManager } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { T } from '../shared/MessageTypes.js';
import { WebSocket } from 'ws';
import { getDB } from './db.js';

export class Room {
  constructor(id, msgProto, sendToCallback) {
    this.id = id;
    this.Msg = msgProto;
    this.sendTo = sendToCallback;

    this.clients = new Set();
    this.settings = {
      mirror: false,
      locked: false,
      maxUsers: 0  // 0 = unlimited
    };

    // Room metadata (loaded from DB)
    this.description = '';
    this.ownerId = null;
    this.ownerUsername = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.dbLoaded = false;

    // Each room has its own managers
    this.sessionManager = new SessionManager(this.broadcastToAll.bind(this));
    this.syncCoordinator = new SyncCoordinator(this.sessionManager, { clients: this.clients }, this.sendTo);

    // Pooled message for broadcasting
    this.POOLED_MSG = this.Msg.create();
  }

  /**
   * Lazy load or create room document from MongoDB
   * Called on first T.CONNECT to the room
   */
  async ensureLoaded() {
    if (this.dbLoaded) return;

    const db = getDB();
    if (!db) {
      this.dbLoaded = true;
      return;
    }

    try {
      const doc = await db.collection('rooms').findOne({ _id: this.id });

      if (doc) {
        // Load existing room
        this.description = doc.description || '';
        this.ownerId = doc.ownerId || null;
        this.ownerUsername = doc.ownerUsername || null;
        this.createdAt = doc.createdAt ? doc.createdAt.getTime() : this.createdAt;
        this.settings.locked = doc.settings?.locked || false;
        this.settings.maxUsers = doc.settings?.maxUsers || 0;
        console.log(`[Room] Loaded "${this.id}" from DB`);
      } else {
        // Create new room document
        const newDoc = {
          _id: this.id,
          description: '',
          ownerId: null,
          ownerUsername: null,
          createdAt: new Date(),
          lastActiveAt: new Date(),
          settings: {
            locked: false,
            maxUsers: 0
          }
        };
        await db.collection('rooms').insertOne(newDoc);
        console.log(`[Room] Created "${this.id}" in DB`);
      }

      this.dbLoaded = true;
    } catch (err) {
      console.error(`[Room] DB load error for "${this.id}":`, err);
      this.dbLoaded = true; // Don't retry
    }
  }

  /**
   * Save room metadata to DB (call after changes to description/settings/owner)
   */
  async saveToDB() {
    const db = getDB();
    if (!db) return;

    try {
      await db.collection('rooms').updateOne(
        { _id: this.id },
        {
          $set: {
            description: this.description,
            ownerId: this.ownerId,
            ownerUsername: this.ownerUsername,
            lastActiveAt: new Date(),
            settings: {
              locked: this.settings.locked,
              maxUsers: this.settings.maxUsers
            }
          }
        }
      );
    } catch (err) {
      console.error(`[Room] Save error for "${this.id}":`, err);
    }
  }

  getClientCount() {
    return this.clients.size;
  }

  addClient(ws) {
    this.clients.add(ws);
    ws.roomId = this.id;
  }

  removeClient(ws) {
    this.clients.delete(ws);
    // ws.roomId = null; // Don't clear yet as we might need it for cleanup
  }

  broadcastToAll(payload) {
    const message = this.Msg.create(payload);
    const buffer = this.Msg.encode(message).finish();

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(buffer);
      }
    });
  }
}

export class RoomManager {
  constructor(wss, sendTo) {
    this.wss = wss;
    this.sendTo = sendTo;
    this.rooms = new Map();
    this.Msg = null;
    this.createRoomBroadcaster = null;
  }

  setMsgEncoder(Msg, createRoomBroadcaster) {
    this.Msg = Msg;
    this.createRoomBroadcaster = createRoomBroadcaster;
  }

  getOrCreateRoom(roomId) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }

    const room = new Room(roomId, this.Msg, this.sendTo);
    this.rooms.set(roomId, room);
    console.log(`[RoomManager] Created room: ${roomId}`);
    return room;
  }

  getRoomByClient(ws) {
    const roomId = ws.roomId;
    if (!roomId) return null;
    return this.rooms.get(roomId);
  }

  removeClient(ws) {
    const room = this.getRoomByClient(ws);
    if (room) {
      room.removeClient(ws);
      if (room.getClientCount() === 0 && room.id !== 'default') {
        // Option to clean up empty rooms (except default)
        // this.rooms.delete(room.id);
      }
    }
  }

  getRoomList() {
    const list = [];
    for (const room of this.rooms.values()) {
      // Hide internal discovery room
      if (room.id === '_discovery') continue;
      list.push({
        id: room.id,
        description: room.description || '',
        userCount: room.getClientCount(),
        locked: room.settings.locked,
        hasPassword: false, // Future feature
        ownerId: room.ownerId || '',
        ownerUsername: room.ownerUsername || ''
      });
    }
    return list;
  }

  /**
   * Clean up empty rooms (except lobby and discovery)
   */
  cleanupEmptyRooms() {
    for (const [id, room] of this.rooms) {
      if (id !== 'lobby' && id !== '_discovery' && room.getClientCount() === 0) {
        this.rooms.delete(id);
        console.log(`[RoomManager] Cleaned up empty room: ${id}`);
      }
    }
  }
}
