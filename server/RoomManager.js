/** @fileoverview Manages drawing rooms, including their metadata, connected clients, and lifecycle. */

import { SessionManager } from './SessionManager.js';
import { SyncCoordinator } from './SyncCoordinator.js';
import { T } from '../shared/MessageTypes.js';
import { WebSocket } from 'ws';
import { getDB } from './db.js';
import { scoreProvider } from './providerScoring.js';
import { getSnapshotBundle } from './r2.js';
import { generateFloatingGalleryVoronoi } from './floatingVoronoi.js';
import { snapshotLayerDimensions } from '../shared/qoi.js';
import { getBoardDimensionsForSize } from '../shared/boardSizes.js';

function createFloatingGallerySeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function snapshotCoversRoomBoard(snapshotLayers, room) {
  const snapshotDimensions = snapshotLayerDimensions(snapshotLayers);
  const [boardHeight, boardWidth] = getBoardDimensionsForSize(room?.settings?.boardSize);

  return !!snapshotDimensions &&
    snapshotDimensions.width >= boardWidth &&
    snapshotDimensions.height >= boardHeight;
}

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
      mirrorRegions: [],
      locked: false,
      maxUsers: 40,
      backgroundColor: '#ffffff',
      modInactiveImmune: false,
      joinPolicy: 'open',
      autoMuteGuests: false,
      autoMuteVpnUsers: false,
      hideChatNotifications: false,
      dedicatedReplayUser: null,
      private: false,
      floatingGallerySeed: createFloatingGallerySeed(),
      floatingGalleryIncludeIds: [],
      floatingGalleryExcludeIds: [],
      floatingGalleryVoronoi: null,
      boardSize: '1080p'
    };

    this.description = '';
    this.ownerId = null;
    this.ownerUsername = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.dbLoaded = false;

    /** @type {Buffer|null} PNG preview image at 1/4 scale */
    this.preview = null;
    /** @type {number} Timestamp of last preview update */
    this.previewUpdatedAt = 0;

    const isDiscovery = id === '_discovery';
    this.sessionManager = new SessionManager(this.broadcastToAll.bind(this), isDiscovery, {
      isImmuneToInactivity: (_sessionIndex, user) => {
        const role = user.role || 0;
        return role >= 5 || (!!this.settings.modInactiveImmune && role >= 4);
      },
      onAllUsersAfk: () => this._onAllUsersAfk()
    });
    this.syncCoordinator = new SyncCoordinator(this.sessionManager, { clients: this.clients }, this.sendTo, this);

    this.POOLED_MSG = this.Msg.create();

    /** @type {Set<number>} Set of occupied tile indices */
    this.tileDirtySet = new Set();
    this.settings.floatingGalleryVoronoi = generateFloatingGalleryVoronoi(this.settings.floatingGallerySeed);

    /** @type {Array<Object>} Rolling buffer of board snapshots (max 24, every 10s for 4 min) */
    this.snapshots = [];

    /** @type {NodeJS.Timeout|null} Server-driven snapshot request interval */
    this._snapshotTimer = null;
    this._snapshotIntervalMs = 15000;

    /** @type {Set<number>} Session indices that were asked for a server-initiated snapshot */
    this._pendingSnapshotRequests = new Set();
  }

  /**
   * Adds a snapshot to the rolling buffer.
   * @param {Object} snapshot - {id, ts, issuer, data, auto}
   */
  addSnapshot(snapshot) {
    this.snapshots.push(snapshot);
    if (this.snapshots.length > 24) {
      this.snapshots.shift();
    }
  }

  /**
   * Returns whether the room is registered and eligible for persisted snapshots.
   * @returns {boolean}
   */
  isRegistered() {
    return !!this.ownerId;
  }

  /**
   * Returns whether this room should persist and serve board snapshots.
   * The public lobby is intentionally snapshot-backed even though it has no owner.
   * @returns {boolean}
   */
  canPersistSnapshots() {
    return this.isRegistered() || this.id === 'lobby';
  }

  /**
   * Starts the periodic snapshot request timer.
   * Called when any user joins the room.
   */
  startSnapshotTimer() {
    if (this._snapshotTimer) return;
    this._snapshotTimer = setInterval(() => this._requestSnapshot(), this._snapshotIntervalMs);
  }

  /**
   * Stops the snapshot request timer.
   * Called when no users remain in the room.
   */
  stopSnapshotTimer() {
    if (!this._snapshotTimer) return;
    clearInterval(this._snapshotTimer);
    this._snapshotTimer = null;
  }

  /**
   * Checks if the snapshot timer should be running based on current clients.
   */
  updateSnapshotTimer() {
    const hasClients = this._getSnapshotCandidates().length > 0;
    const shouldRun = this.canPersistSnapshots() && hasClients;
    if (shouldRun && !this._snapshotTimer) {
      this.startSnapshotTimer();
    } else if (!shouldRun && this._snapshotTimer) {
      this.stopSnapshotTimer();
    }
  }

  /**
   * Returns all open clients as snapshot candidates, scored and sorted best-first.
   * Any connected user can be asked for a snapshot — not just Helper+.
   * @returns {WebSocket[]}
   * @private
   */
  _getSnapshotCandidates() {
    const candidates = [];
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        candidates.push(ws);
      }
    }
    return candidates;
  }

  /**
   * Picks the best-scoring connected client and sends a snapshot request.
   * @private
   */
  _requestSnapshot() {
    if (!this.canPersistSnapshots()) return;

    const candidates = this._getSnapshotCandidates();
    if (candidates.length === 0) return;

    const ranked = candidates
      .map((ws) => ({
        ws,
        score: scoreProvider(ws, this.sessionManager.getUser(ws.sessionIndex))
      }))
      .sort((a, b) => b.score - a.score);

    const chosen = ranked[0]?.ws;
    if (!chosen) return;

    this._pendingSnapshotRequests.add(chosen.sessionIndex);
    this.sendTo(chosen, { t: T.BOARD_SNAPSHOT_REQUEST });
  }

  /**
   * Marks tiles as occupied.
   * @param {number} userId - Unused; kept for signature compatibility
   * @param {Array<number>} tileIndices - Array of tile indices.
   */
  markTilesDirty(userId, tileIndices) {
    if (!tileIndices || !Array.isArray(tileIndices)) return;
    for (const idx of tileIndices) {
      this.tileDirtySet.add(idx);
    }
  }

  /**
   * Clears tiles from the dirty set.
   * @param {Array<number>} tileIndices - Array of tile indices to clear.
   */
  clearTiles(tileIndices) {
    if (!tileIndices || !Array.isArray(tileIndices)) return;
    for (const idx of tileIndices) {
      this.tileDirtySet.delete(idx);
    }
  }

  /**
   * Gets the full list of occupied tiles for sync.
   * @returns {Array<number>}
   */
  getDirtyTilesForSync() {
    return Array.from(this.tileDirtySet);
  }

  /**
   * Reset all tile data.
   */
  clearAllTiles() {
    this.tileDirtySet.clear();
  }

  /**
   * Fetches the most recent snapshot data, checking in-memory buffer then DB/R2.
   * @returns {Promise<{id: string, ts: number, issuer: string, layers: Array}|null>}
   */
  async getLatestSnapshotData() {
    // Check in-memory rolling buffer first (most recent auto-saves)
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i];
      if (s.layers && s.layers.length > 0) {
        return { id: s.id, ts: s.ts, issuer: s.issuer, layers: s.layers };
      }
    }

    // Fall back to DB/R2
    const db = getDB();
    if (!db) return null;

    try {
      const doc = await db.collection('room_snapshots').findOne(
        { roomId: this.id, r2Key: { $ne: null } },
        { sort: { timestamp: -1 } }
      );
      if (!doc || !doc.r2Key) return null;

      const bundle = await getSnapshotBundle(doc.r2Key);
      if (!bundle) return null;
      return { id: doc.snapshotId, ts: doc.timestamp, issuer: doc.issuer, layers: bundle.layers };
    } catch (err) {
      console.error(`[Room] Failed to fetch latest snapshot for "${this.id}":`, err);
      return null;
    }
  }

  /**
   * Called when all users in the room have been AFK for the configured delay.
   * Restores the last snapshot to reset the canvas to a known good state.
   * @private
   */
  async _onAllUsersAfk() {
    if (!this.canPersistSnapshots()) return;
    console.log(`[Room] All users AFK in "${this.id}", restoring last snapshot`);

    const snapshot = await this.getLatestSnapshotData();
    if (!snapshot) {
      console.log(`[Room] No snapshot available for "${this.id}", skipping restore`);
      return;
    }

    this.broadcastToAll({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotLayers: snapshot.layers,
      snapshotId: snapshot.id,
      snapshotTs: snapshot.ts,
      snapshotIssuer: 'server'
    });
    if (snapshotCoversRoomBoard(snapshot.layers, this)) {
      this.clearAllTiles();
    }
    console.log(`[Room] Restored snapshot ${snapshot.id} to all users in "${this.id}"`);
  }

  /**
   * Lazy loads the room document from the database if it exists.
   * Does not create unregistered rooms; they are only persisted when explicitly registered.
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
      const doc = await db.collection('rooms').findOne(
        { _id: this.id },
        {
          projection: {
            description: 1,
            ownerId: 1,
            ownerUsername: 1,
            createdAt: 1,
            settings: 1
          }
        }
      );

      if (doc) {
        this.description = doc.description || '';
        this.ownerId = doc.ownerId || null;
        this.ownerUsername = doc.ownerUsername || null;
        this.createdAt = doc.createdAt ? doc.createdAt.getTime() : this.createdAt;
        this.settings.locked = doc.settings?.locked || false;
        this.settings.maxUsers = doc.settings?.maxUsers !== undefined ? doc.settings.maxUsers : 40;
        this.settings.backgroundColor = doc.settings?.backgroundColor || '#ffffff';
        this.settings.modInactiveImmune = !!doc.settings?.modInactiveImmune;
        this.settings.joinPolicy = doc.settings?.joinPolicy || 'open';
        this.settings.autoMuteGuests = !!doc.settings?.autoMuteGuests;
        this.settings.autoMuteVpnUsers = !!doc.settings?.autoMuteVpnUsers;
        this.settings.hideChatNotifications = !!doc.settings?.hideChatNotifications;
        this.settings.mirrorRegions = Array.isArray(doc.settings?.mirrorRegions) ? doc.settings.mirrorRegions : [];
        this.settings.dedicatedReplayUser = doc.settings?.dedicatedReplayUser || null;
        this.settings.private = !!doc.settings?.private;
        this.settings.floatingGallerySeed = Number.isFinite(doc.settings?.floatingGallerySeed)
          ? doc.settings.floatingGallerySeed
          : this.settings.floatingGallerySeed;
        this.settings.floatingGalleryIncludeIds = Array.isArray(doc.settings?.floatingGalleryIncludeIds)
          ? doc.settings.floatingGalleryIncludeIds.filter(id => typeof id === 'string')
          : [];
        this.settings.floatingGalleryExcludeIds = Array.isArray(doc.settings?.floatingGalleryExcludeIds)
          ? doc.settings.floatingGalleryExcludeIds.filter(id => typeof id === 'string')
          : [];
        const loadedFloatingGalleryVoronoi = doc.settings?.floatingGalleryVoronoi &&
          doc.settings.floatingGalleryVoronoi.seed === this.settings.floatingGallerySeed
          ? doc.settings.floatingGalleryVoronoi
          : null;
        this.settings.floatingGalleryVoronoi = loadedFloatingGalleryVoronoi ||
          generateFloatingGalleryVoronoi(this.settings.floatingGallerySeed);
        if (!loadedFloatingGalleryVoronoi) {
          await db.collection('rooms').updateOne(
            { _id: this.id },
            { $set: { 'settings.floatingGalleryVoronoi': this.settings.floatingGalleryVoronoi } }
          );
        }
        const validBoardSizes = new Set(['720p', '1080p', '1440p', 'big']);
        this.settings.boardSize = validBoardSizes.has(doc.settings?.boardSize)
          ? doc.settings.boardSize
          : '1080p';
        console.log(`[Room] Loaded "${this.id}" from DB`);
      }

      this.dbLoaded = true;
    } catch (err) {
      console.error(`[Room] DB load error for "${this.id}":`, err);
      this.dbLoaded = true;
    }
  }

  /**
   * Saves the current room metadata and settings to the database.
   * Creates the room document if it doesn't exist (upsert mode).
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
              maxUsers: this.settings.maxUsers,
              backgroundColor: this.settings.backgroundColor,
              modInactiveImmune: this.settings.modInactiveImmune,
              joinPolicy: this.settings.joinPolicy,
              autoMuteGuests: this.settings.autoMuteGuests,
              autoMuteVpnUsers: this.settings.autoMuteVpnUsers,
              hideChatNotifications: this.settings.hideChatNotifications,
              mirrorRegions: this.settings.mirrorRegions,
              dedicatedReplayUser: this.settings.dedicatedReplayUser,
              private: this.settings.private,
              floatingGallerySeed: this.settings.floatingGallerySeed,
              floatingGalleryIncludeIds: this.settings.floatingGalleryIncludeIds,
              floatingGalleryExcludeIds: this.settings.floatingGalleryExcludeIds,
              floatingGalleryVoronoi: this.settings.floatingGalleryVoronoi || generateFloatingGalleryVoronoi(this.settings.floatingGallerySeed),
              boardSize: this.settings.boardSize
            }
          },
          $setOnInsert: {
            createdAt: new Date(),
            roles: []
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.error(`[Room] Save error for "${this.id}":`, err);
    }
  }

  /**
   * Updates the room preview image.
   * @param {Buffer|null} previewData - PNG image data at 1/4 scale, or null to clear
   */
  setPreview(previewData) {
    this.preview = previewData;
    this.previewUpdatedAt = Date.now();
    this.lastActivity = Date.now();
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
   * @param {boolean} [includePreview=true] - Whether to include preview images
   * @returns {Array<Object>} - A list of room summary objects.
   */
  getRoomList(includePreview = true) {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.id === '_discovery') continue;
      if (room.settings.private) continue;
      const roomInfo = {
        id: room.id,
        description: room.description || '',
        userCount: room.getClientCount(),
        locked: room.settings.locked,
        hasPassword: false,
        backgroundColor: room.settings.backgroundColor || '#ffffff',
        ownerId: room.ownerId || '',
        ownerUsername: room.ownerUsername || ''
      };
      if (includePreview && room.preview) {
        roomInfo.preview = room.preview;
      }
      list.push(roomInfo);
    }
    return list;
  }

  /**
   * Broadcasts an updated room list to discovery clients.
   */
  broadcastRoomListUpdate() {
    if (!this.Msg) return;

    const payload = {
      t: T.ROOM_LIST_RESPONSE,
      rooms: this.getRoomList().map(r => ({
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
    };

    const discoveryRooms = ['lobby', '_discovery'];
    for (const roomId of discoveryRooms) {
      const room = this.rooms.get(roomId);
      if (room) {
        room.broadcastToAll(payload);
      }
    }
  }

  /**
   * Cleans up empty rooms from the manager, excluding lobby and discovery rooms.
   */
  cleanupEmptyRooms() {
    for (const [id, room] of this.rooms) {
      if (id !== 'lobby' && id !== '_discovery' && room.getClientCount() === 0) {
        room.stopSnapshotTimer();
        this.rooms.delete(id);
        console.log(`[RoomManager] Cleaned up empty room: ${id}`);
      }
    }
  }
}
