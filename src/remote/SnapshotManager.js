/** @fileoverview Manages board snapshots and server communication. */

import { T } from '../../shared/MessageTypes.js';
import { LocalSnapshotStore } from './LocalSnapshotStore.js';

const LOCAL_CAPTURE_INTERVAL_MS = 30000;

export class SnapshotManager {
  /**
   * @param {DrawingApp} app - The main application instance
   */
  constructor(app) {
    this.app = app;
    this.snapshots = []; // Locally cached list (metadata only)
    this.lastSnapshotHash = null; // To avoid uploading identical snapshots
    this.snapshotPageSize = 20;
    this.lastListAppend = false;
    this.hasMoreSnapshots = true;

    this._localStore = null;
    this._localCaptureTimer = null;
    this._lastLocalHash = null;
  }

  _getLocalStore() {
    if (!this._localStore) {
      try {
        this._localStore = new LocalSnapshotStore();
      } catch (err) {
        console.warn('[SnapshotManager] IndexedDB unavailable:', err);
      }
    }
    return this._localStore;
  }

  /**
   * Called when the server requests this client to capture a snapshot.
   * Captures board + generates lossy 1/3 scale JPEG thumbnail.
   */
  async handleServerRequest() {
    if (!this.app.wsClient || !this.app.connected) return;

    const layers = this.app.board.getSnapshot();
    if (!layers || layers.length === 0) return;

    // Skip if board hasn't changed
    const hash = this._computeHashLayers(layers);
    if (hash === this.lastSnapshotHash) return;
    this.lastSnapshotHash = hash;

    const thumbBytes = await this._generateThumbnail();

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotLayers: layers,
      a: true
    };
    if (thumbBytes) msg.snapshotThumb = thumbBytes;

    this.app.wsClient.send(msg);
  }

  /**
   * Manually save a snapshot with a name.
   * @param {string} name
   */
  async saveSnapshot(name) {
    const layers = this.app.board.getSnapshot();
    if (!layers || layers.length === 0) return;

    const thumbBytes = await this._generateThumbnail();

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotLayers: layers,
      n: name,
      a: false
    };
    if (thumbBytes) msg.snapshotThumb = thumbBytes;

    this.app.wsClient.send(msg);
  }

  /**
   * Request the list of snapshots from the server.
   */
  requestList({ beforeTs = 0, append = false } = {}) {
    this.lastListAppend = append;

    const msg = { t: T.BOARD_SNAPSHOT_LIST_REQUEST };
    if (beforeTs > 0) {
      msg.snapshotTs = beforeTs;
    }

    this.app.wsClient.send(msg);
  }

  clearListCache() {
    this.snapshots = [];
    this.lastListAppend = false;
    this.hasMoreSnapshots = true;
  }

  /**
   * Request restoration of a specific snapshot.
   * @param {string} id
   */
  restoreSnapshot(id) {
    this.app.wsClient.send({
      t: T.BOARD_SNAPSHOT_RESTORE,
      snapshotId: id
    });
  }

  /**
   * Request deletion of a specific snapshot.
   * @param {string} id
   */
  deleteSnapshot(id) {
    this.app.wsClient.send({
      t: T.BOARD_SNAPSHOT_DELETE,
      snapshotId: id
    });
  }

  /**
   * Generates a 1/3 scale JPEG thumbnail of the current board asynchronously.
   * @returns {Promise<Uint8Array|null>}
   * @private
   */
  async _generateThumbnail() {
    if (!this.app.board?.layerManager) return null;

    const srcCanvas = this.app.board.layerManager.getCompositedCanvas();
    const w = Math.round(srcCanvas.width / 3);
    const h = Math.round(srcCanvas.height / 3);

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = w;
    thumbCanvas.height = h;
    const ctx = thumbCanvas.getContext('2d');

    // Fill with room background color so transparency doesn't become black in JPEG
    const bg = this.app.board.backgroundColor;
    if (bg) {
      if (typeof bg === 'string') {
        ctx.fillStyle = bg;
      } else {
        ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      }
      ctx.fillRect(0, 0, w, h);
    }

    ctx.drawImage(srcCanvas, 0, 0, w, h);

    return new Promise((resolve) => {
      thumbCanvas.toBlob(async (blob) => {
        if (!blob) return resolve(null);
        const buffer = await blob.arrayBuffer();
        resolve(new Uint8Array(buffer));
      }, 'image/jpeg', 0.5);
    });
  }

  /**
   * Begins capturing snapshots to the local IndexedDB store at a fixed cadence.
   * Used by non-uploader clients as a black-box recovery buffer.
   */
  startLocalCapture(intervalMs = LOCAL_CAPTURE_INTERVAL_MS) {
    this.stopLocalCapture();
    this._localCaptureTimer = setInterval(() => this.captureLocalSnapshot(), intervalMs);
    // Initial capture after a short delay
    setTimeout(() => this.captureLocalSnapshot(), 3000);
  }

  stopLocalCapture() {
    if (this._localCaptureTimer) {
      clearInterval(this._localCaptureTimer);
      this._localCaptureTimer = null;
    }
  }

  _getLocalIssuerName() {
    const self = this.app.self;
    const name = self?.registeredName || self?.username;
    return (name && name !== 'Unknown') ? name : 'You';
  }

  /**
   * Captures the current board state and stores it in IndexedDB. No network traffic.
   */
  async captureLocalSnapshot() {
    const store = this._getLocalStore();
    if (!store || !this.app.board) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    const layers = this.app.board.getSnapshot();
    if (!layers || layers.length === 0) return;

    const hash = this._computeHashLayers(layers);
    if (hash === this._lastLocalHash) return;
    this._lastLocalHash = hash;

    const roomId = this.app.currentRoomData?.id || this.app.currentRoomId || 'default';
    const ts = Date.now();
    const id = `local_${ts}_${Math.random().toString(36).slice(2, 7)}`;
    const thumb = await this._generateThumbnail();

    try {
      await store.add({
        id,
        roomId,
        ts,
        issuer: this._getLocalIssuerName(),
        layers,
        thumb,
        name: `Local ${new Date(ts).toLocaleTimeString()}`
      });
    } catch (err) {
      console.warn('[SnapshotManager] Local capture failed:', err);
    }
  }

  /**
   * Returns paginated metadata for local snapshots in the current room (most recent first).
   * Layer/thumbnail bytes are NOT included; call getLocal(id) to load them.
   * @param {number} limit - Max number of snapshots to return (default 20)
   * @param {number} beforeTs - Load snapshots before this timestamp (for pagination)
   */
  async listLocal(limit = 20, beforeTs = 0) {
    const store = this._getLocalStore();
    if (!store) return [];
    const roomId = this.app.currentRoomData?.id || this.app.currentRoomId || 'default';
    try {
      const records = await store.list(roomId, limit, beforeTs);
      // Map records to a format similar to remote snapshots for the UI
      // thumb bytes are included directly (now efficient because they live in a separate meta store)
      return records.map(r => ({
        id: r.id,
        ts: r.ts,
        issuer: r.issuer,
        name: r.name,
        thumb: r.thumb,
        hasThumb: r.hasThumb,
        auto: true // local captures are always auto
      }));
    } catch (err) {
      console.warn('[SnapshotManager] Local list failed:', err);
      return [];
    }
  }

  async getLocal(id) {
    const store = this._getLocalStore();
    if (!store) return null;
    try {
      return await store.get(id);
    } catch (err) {
      console.warn('[SnapshotManager] Local get failed:', err);
      return null;
    }
  }

  async getLocalThumb(id) {
    const store = this._getLocalStore();
    if (!store) return null;
    try {
      return await store.getThumb(id);
    } catch (err) {
      console.warn('[SnapshotManager] Local thumb fetch failed:', err);
      return null;
    }
  }

  async deleteLocal(id) {
    const store = this._getLocalStore();
    if (!store) return;
    try {
      await store.delete(id);
    } catch (err) {
      console.warn('[SnapshotManager] Local delete failed:', err);
    }
  }

  /**
   * Applies a local snapshot to the board for THIS client only (no broadcast).
   * Useful for recovering after a disconnect or stale-state incident.
   */
  async applyLocal(id) {
    const record = await this.getLocal(id);
    if (!record?.layers) return false;
    this.app.board.restoreSnapshot(record.layers);
    this.app.board.requestUpdate();
    return true;
  }

  /**
   * Uploads a local snapshot to the server and immediately broadcasts a restore
   * so the snapshot is applied to all users in the room. Mirrors the existing
   * server-snapshot restore flow.
   *
   * Falls back to a local-only apply if the client is disconnected.
   * @param {string} id - Local snapshot ID
   * @returns {Promise<boolean>} success
   */
  async uploadAndRestoreLocal(id) {
    const record = await this.getLocal(id);
    if (!record?.layers || record.layers.length === 0) return false;

    // If not connected, just apply locally
    if (!this.app.wsClient || !this.app.connected) {
      this.app.board.restoreSnapshot(record.layers);
      this.app.board.requestUpdate();
      return true;
    }

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotLayers: record.layers,
      n: record.name || `Local ${new Date(record.ts || Date.now()).toLocaleTimeString()}`,
      a: false,
      snapshotRestoreAfterSave: true
    };
    if (record.thumb) msg.snapshotThumb = record.thumb;

    this.app.wsClient.send(msg);
    return true;
  }

  /**
   * Uploads a local snapshot to the server as a regular snapshot (no broadcast
   * restore). Used before a region "Upload" so the snapshot is available on the
   * server for other users.
   * @param {string} id - Local snapshot ID
   * @returns {Promise<boolean>} success
   */
  async uploadLocalToServer(id) {
    const record = await this.getLocal(id);
    if (!record?.layers || record.layers.length === 0) return false;
    if (!this.app.wsClient || !this.app.connected) return false;

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotLayers: record.layers,
      n: record.name || `Local ${new Date(record.ts || Date.now()).toLocaleTimeString()}`,
      a: false
    };
    if (record.thumb) msg.snapshotThumb = record.thumb;

    this.app.wsClient.send(msg);
    return true;
  }

  /**
   * Simple hash for comparing multi-layer snapshots.
   * @param {Uint8Array[]} layers
   * @returns {number}
   * @private
   */
  _computeHashLayers(layers) {
    let hash = 0;
    for (const data of layers) {
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash) + data[i];
        hash |= 0;
      }
    }
    return hash;
  }
}
