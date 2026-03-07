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
    this.settings = { mirror: false };

    // Each room has its own managers
    this.sessionManager = new SessionManager(this.broadcastToAll.bind(this));
    this.syncCoordinator = new SyncCoordinator(this.sessionManager, { clients: this.clients }, this.sendTo);

    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    
    // Pooled message for broadcasting
    this.POOLED_MSG = this.Msg.create();
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
        userCount: room.getClientCount(),
        locked: false, // Future feature
        hasPassword: false // Future feature
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
