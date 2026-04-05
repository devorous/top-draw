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
  }

  /**
   * Called when the server requests this client to capture a snapshot.
   * Captures board + generates lossy 1/3 scale JPEG thumbnail.
   */
  handleServerRequest() {
    if (!this.app.wsClient || !this.app.connected) return;

    const snapshotData = this.app.board.getSnapshot();
    if (!snapshotData) return;

    // Skip if board hasn't changed
    const hash = this._computeHash(snapshotData);
    if (hash === this.lastSnapshotHash) return;
    this.lastSnapshotHash = hash;

    const thumbBytes = this._generateThumbnail();

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotData: snapshotData,
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
    const snapshotData = this.app.board.getSnapshot();
    if (!snapshotData) return;

    const thumbBytes = this._generateThumbnail();

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotData: snapshotData,
      n: name,
      a: false
    };
    if (thumbBytes) msg.snapshotThumb = thumbBytes;

    this.app.wsClient.send(msg);
  }

  /**
   * Request the list of snapshots from the server.
   */
  requestList() {
    this.app.wsClient.send({ t: T.BOARD_SNAPSHOT_LIST_REQUEST });
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
   * Simple hash for comparing snapshots.
   * @param {Uint8Array} data
   * @returns {number}
   * @private
   */
  _computeHash(data) {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data[i];
      hash |= 0;
    }
    return hash;
  }
}
