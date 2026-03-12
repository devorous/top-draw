/** @fileoverview Manages drawing rooms, including their metadata, connected clients, and lifecycle. */

import { SessionManager } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { T } from '../shared/MessageTypes.js';
import { WebSocket } from 'ws';
import { getDB } from './db.js';

/**
 * Represents a single drawing room.
 */
export class Room {
  /**
   * @param {string} id - The unique identifier for the room.
   * @param {Object} msgProto - The protobuf message type for encoding/decoding.
   * @param {function} sendToCallback - Callback function to send messages to a specific client.
   */
  constructor(id, msgProto, sendToCallback) {
    this.id = id;
    this.Msg = msgProto;
    this.sendTo = sendToCallback;

    this.clients = new Set();
    this.settings = {
      mirror: false,
      locked: false,
      maxUsers: 0
    };

    this.description = '';
    this.ownerId = null;
    this.ownerUsername = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.dbLoaded = false;

    this.sessionManager = new SessionManager(this.broadcastToAll.bind(this));
    this.syncCoordinator = new SyncCoordinator(this.sessionManager, { clients: this.clients }, this.sendTo);

    this.POOLED_MSG = this.Msg.create();
  }

  /**
   * Lazy loads or creates the room document from the database.
   * @returns {Promise<void>}
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
        this.description = doc.description || '';
        this.ownerId = doc.ownerId || null;
        this.ownerUsername = doc.ownerUsername || null;
        this.createdAt = doc.createdAt ? doc.createdAt.getTime() : this.createdAt;
        this.settings.locked = doc.settings?.locked || false;
        this.settings.maxUsers = doc.settings?.maxUsers || 0;
        console.log(`[Room] Loaded "${this.id}" from DB`);
      } else {
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
      this.dbLoaded = true;
    }
  }

  /**
   * Saves the current room metadata and settings to the database.
   * @returns {Promise<void>}
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

  /**
   * Returns the number of clients currently in the room.
   * @returns {number} - The client count.
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Adds a WebSocket client to the room.
   * @param {WebSocket} ws - The WebSocket client to add.
   */
  addClient(ws) {
    this.clients.add(ws);
    ws.roomId = this.id;
  }

  /**
   * Removes a WebSocket client from the room.
   * @param {WebSocket} ws - The WebSocket client to remove.
   */
  removeClient(ws) {
    this.clients.delete(ws);
  }

  /**
   * Broadcasts a payload to all clients in the room.
   * @param {Object} payload - The message payload to broadcast.
   */
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

/**
 * Manages the collection of active rooms.
 */
export class RoomManager {
  /**
   * @param {WebSocketServer} wss - The WebSocket server instance.
   * @param {function} sendTo - Callback function to send messages to a specific client.
   */
  constructor(wss, sendTo) {
    this.wss = wss;
    this.sendTo = sendTo;
    this.rooms = new Map();
    this.Msg = null;
    this.createRoomBroadcaster = null;
  }

  /**
   * Configures the protobuf encoder and room broadcaster factory.
   * @param {Object} Msg - The protobuf message type.
   * @param {function} createRoomBroadcaster - Factory function for room broadcasters.
   */
  setMsgEncoder(Msg, createRoomBroadcaster) {
    this.Msg = Msg;
    this.createRoomBroadcaster = createRoomBroadcaster;
  }

  /**
   * Retrieves an existing room or creates a new one if it doesn't exist.
   * @param {string} roomId - The ID of the room.
   * @returns {Room} - The room instance.
   */
  getOrCreateRoom(roomId) {
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }

    const room = new Room(roomId, this.Msg, this.sendTo);
    this.rooms.set(roomId, room);
    console.log(`[RoomManager] Created room: ${roomId}`);
    return room;
  }

  /**
   * Finds the room associated with a specific WebSocket client.
   * @param {WebSocket} ws - The WebSocket client.
   * @returns {Room|null} - The room instance or null if not found.
   */
  getRoomByClient(ws) {
    const roomId = ws.roomId;
    if (!roomId) return null;
    return this.rooms.get(roomId);
  }

  /**
   * Removes a client from their current room.
   * @param {WebSocket} ws - The WebSocket client to remove.
   */
  removeClient(ws) {
    const room = this.getRoomByClient(ws);
    if (room) {
      room.removeClient(ws);
    }
  }

  /**
   * Returns a list of all active public rooms.
   * @returns {Array<Object>} - A list of room summary objects.
   */
  getRoomList() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.id === '_discovery') continue;
      list.push({
        id: room.id,
        description: room.description || '',
        userCount: room.getClientCount(),
        locked: room.settings.locked,
        hasPassword: false,
        ownerId: room.ownerId || '',
        ownerUsername: room.ownerUsername || ''
      });
    }
    return list;
  }

  /**
   * Cleans up empty rooms from the manager, excluding lobby and discovery rooms.
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
