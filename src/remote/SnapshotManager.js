/** @fileoverview Manages board snapshots and server communication. */

import { T } from '../../shared/MessageTypes.js';

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
  }

  /**
   * Called when the server requests this client to capture a snapshot.
   * Captures board + generates lossy 1/3 scale JPEG thumbnail.
   */
  handleServerRequest() {
    if (!this.app.wsClient || !this.app.connected) return;

    const layers = this.app.board.getSnapshot();
    if (!layers || layers.length === 0) return;

    // Skip if board hasn't changed
    const hash = this._computeHashLayers(layers);
    if (hash === this.lastSnapshotHash) return;
    this.lastSnapshotHash = hash;

    const thumbBytes = this._generateThumbnail();

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
  saveSnapshot(name) {
    const layers = this.app.board.getSnapshot();
    if (!layers || layers.length === 0) return;

    const thumbBytes = this._generateThumbnail();

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
   * Generates a 1/3 scale JPEG thumbnail of the current board.
   * @returns {Uint8Array|null}
   * @private
   */
  _generateThumbnail() {
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
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.drawImage(srcCanvas, 0, 0, w, h);

    // Convert to JPEG blob synchronously via toDataURL
    const dataUrl = thumbCanvas.toDataURL('image/jpeg', 0.5);
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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
