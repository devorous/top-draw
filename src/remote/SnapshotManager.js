/** @fileoverview Manages board snapshots and server communication. */

import { T } from '../../shared/MessageTypes.js';
import * as wasm from '../wasm/ddraw_wasm.js';
import { readQoiDimensions, snapshotLayerDimensions } from '../../shared/qoi.js';

const PIXEL_PARITY_TILE_SIZE = 32;
const PIXEL_PARITY_SAMPLES_PER_TILE = 4;
const PIXEL_PARITY_MAD_THRESHOLD = 18;
const PIXEL_PARITY_MAX_TILES = 5000;

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
    this._snapshotEncodeWorker = null;
    this._snapshotEncodePromises = new Map();
    this._snapshotEncodeMsgId = 1;
    this._autoSnapshotInFlight = false;
    this._autoSnapshotQueued = false;
    this._pixelParityCheckpoint = null;
    this._pixelParityFetchInFlight = null;
  }

  /**
   * Called when the server requests this client to capture a snapshot.
   * Captures board + generates lossy 1/3 scale JPEG thumbnail.
   */
  async handleServerRequest() {
    if (!this.app.wsClient || !this.app.connected) return;
    if (this._autoSnapshotInFlight) {
      this._autoSnapshotQueued = true;
      return;
    }

    this._autoSnapshotInFlight = true;
    try {
      // Auto-snapshots are the room's join checkpoint: capture only the baked
      // (permanent) state and stamp the baked watermark seq. The undoable live
      // tail is left for the server to replay as commands, so joiners rebuild
      // those strokes as real records (preserving blend mode + undo/redo)
      // instead of receiving them baked-flat. Null = nothing baked yet → skip.
      const capture = this._captureCheckpointPixels();
      if (!capture) return;

      const [encoded, thumbBytes] = await Promise.all([
        this._runWhenIdle(() => this._encodeSnapshotPixels(capture)),
        this._generateThumbnail(),
      ]);
      if (!encoded?.layers?.length) return;

      // Skip if board hasn't changed. Hashing happens in the encode worker so
      // the main thread only compares the final scalar.
      if (encoded.hash === this.lastSnapshotHash) return;
      this.lastSnapshotHash = encoded.hash;

      this._sendSnapshotSave({
        layers: encoded.layers,
        snapshotSeq: capture.snapshotSeq,
        thumbBytes,
        auto: true,
      });
    } catch (err) {
      console.warn('[SnapshotManager] Snapshot encode failed:', err);
    } finally {
      this._autoSnapshotInFlight = false;
      if (this._autoSnapshotQueued) {
        this._autoSnapshotQueued = false;
        setTimeout(() => this.handleServerRequest(), 0);
      }
    }
  }

  /**
   * Manually save a snapshot with a name.
   * @param {string} name
   */
  async saveSnapshot(name) {
    const capture = this._captureSnapshotPixels();
    if (!capture) return;

    try {
      const [encoded, thumbBytes] = await Promise.all([
        this._runWhenIdle(() => this._encodeSnapshotPixels(capture)),
        this._generateThumbnail(),
      ]);
      if (!encoded?.layers?.length) return;
      this.lastSnapshotHash = encoded.hash;

      this._sendSnapshotSave({
        layers: encoded.layers,
        snapshotSeq: capture.snapshotSeq,
        thumbBytes,
        name,
        auto: false,
      });
    } catch (err) {
      console.warn('[SnapshotManager] Manual snapshot encode failed:', err);
    }
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
   * Synchronously captures raw layer pixels and the seq watermark they represent.
   * The QOI encode is intentionally deferred to a worker.
   * @returns {{ width: number, height: number, layers: Uint8Array[], backgroundColor: *, snapshotSeq: number }|null}
   * @private
   */
  _captureSnapshotPixels() {
    const capture = this.app.board?.getSnapshotPixels?.();
    if (!capture?.layers?.length) return null;

    // getSnapshotPixels() is synchronous, so no websocket message can advance
    // lastProcessedSeq between the readback and this stamp.
    capture.snapshotSeq = this.app.wsClient?.lastProcessedSeq || 0;
    return capture;
  }

  /**
   * Captures the PERMANENT (baked) board state for the room checkpoint that
   * drives join-sync. Unlike a manual save, this excludes the still-undoable
   * live stroke tail and stamps the baked watermark seq, so the server replays
   * that tail as commands to joiners (keeping per-stroke blend mode + undo/redo).
   * Returns null when nothing is baked yet — the caller then skips the snapshot
   * and joiners replay the full command tail instead.
   * @returns {{ width: number, height: number, layers: Uint8Array[], backgroundColor: *, snapshotSeq: number }|null}
   * @private
   */
  _captureCheckpointPixels() {
    const capture = this.app.board?.getCheckpointSnapshotPixels?.();
    if (!capture?.layers?.length) return null;
    return capture; // snapshotSeq is the baked watermark, set by the board
  }

  _sendSnapshotSave({ layers, snapshotSeq, thumbBytes = null, name = null, auto = false }) {
    if (!this.app.wsClient || !this.app.connected) return;

    if (auto) {
      this.cachePixelParityCheckpoint({ snapshotSeq, layers });
    }

    const msg = {
      t: T.BOARD_SNAPSHOT_SAVE,
      snapshotLayers: layers,
      snapshotSeq,
      a: auto,
    };
    if (name) msg.n = name;
    if (thumbBytes) msg.snapshotThumb = thumbBytes;

    this.app.wsClient.send(msg);
  }

  _runWhenIdle(callback) {
    return new Promise((resolve, reject) => {
      const run = () => {
        Promise.resolve()
          .then(callback)
          .then(resolve, reject);
      };

      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    });
  }

  _getSnapshotEncodeWorker() {
    if (this._snapshotEncodeWorker) return this._snapshotEncodeWorker;

    const worker = new Worker(new URL('./snapshotEncodeWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, type, layers, hash, error } = event.data || {};
      const pending = this._snapshotEncodePromises.get(id);
      if (!pending) return;
      this._snapshotEncodePromises.delete(id);

      if (type === 'ENCODE_SNAPSHOT_ERROR') {
        pending.reject(new Error(error || 'Snapshot encode failed'));
      } else {
        pending.resolve({ layers, hash });
      }
    };
    worker.onerror = (event) => {
      const err = new Error(event?.message || 'Snapshot encode worker failed');
      for (const pending of this._snapshotEncodePromises.values()) pending.reject(err);
      this._snapshotEncodePromises.clear();
      this._snapshotEncodeWorker?.terminate?.();
      this._snapshotEncodeWorker = null;
    };

    this._snapshotEncodeWorker = worker;
    return worker;
  }

  _encodeSnapshotPixels(capture) {
    return new Promise((resolve, reject) => {
      const id = this._snapshotEncodeMsgId++;
      const worker = this._getSnapshotEncodeWorker();
      this._snapshotEncodePromises.set(id, { resolve, reject });

      try {
        worker.postMessage({
          id,
          type: 'ENCODE_SNAPSHOT',
          width: capture.width,
          height: capture.height,
          layers: capture.layers,
          backgroundColor: capture.backgroundColor,
        }, capture.layers.map((layer) => layer.buffer));
      } catch (err) {
        this._snapshotEncodePromises.delete(id);
        reject(err);
      }
    });
  }

  handleCheckpointMinted({ snapshotId, snapshotSeq }) {
    const seq = Number(snapshotSeq) || 0;
    if (!snapshotId || seq <= 0) return;

    if (this._pixelParityCheckpoint?.seq === seq) {
      this._pixelParityCheckpoint.snapshotId = snapshotId;
      return;
    }

    if (this._pixelParityFetchInFlight === snapshotId) return;
    this._pixelParityFetchInFlight = snapshotId;
    this.app.wsClient?.requestSnapshotGet?.(snapshotId, { snapshotProbe: true });
  }

  handleSnapshotProbeResponse(data) {
    this._pixelParityFetchInFlight = null;
    const layers = data?.snapshotLayers;
    const snapshotSeq = Number(data?.snapshotSeq) || 0;
    if (!data?.snapshotId || snapshotSeq <= 0 || !Array.isArray(layers) || layers.length === 0) return;

    this.cachePixelParityCheckpoint({
      snapshotId: data.snapshotId,
      snapshotSeq,
      layers,
    });
  }

  cachePixelParityCheckpoint({ snapshotId = '', snapshotSeq = 0, layers }) {
    const seq = Number(snapshotSeq) || 0;
    if (seq <= 0 || !Array.isArray(layers) || layers.length === 0) return;

    try {
      const reference = this._buildPixelParityReference(layers);
      if (!reference) return;
      this._pixelParityCheckpoint = {
        snapshotId,
        seq,
        ...reference,
      };
    } catch (err) {
      console.warn('[SnapshotManager] Pixel parity checkpoint cache failed:', err);
    }
  }

  /**
   * Render this client's PERMANENT canvas as of a baked watermark seq (baked
   * content + confirmed strokes <= seq, no live tail), composited across all
   * layers over the room background. Mirrors how the checkpoint reference is
   * built, so the two are directly comparable regardless of the live tail.
   * @param {number} seq
   * @returns {HTMLCanvasElement|null}
   * @private
   */
  _renderBakedThroughSeqCanvas(seq) {
    const lm = this.app.board?.layerManager;
    const dims = this.app.board?.dimensions;
    if (!lm || !dims) return null;
    const [height, width] = dims;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    this._fillSnapshotBackground(ctx, width, height);
    for (let i = 0; i < lm.layerGroups.length; i++) {
      lm.compositeBakedThroughSeq(ctx, i, seq);
    }
    return canvas;
  }

  buildPixelParityProbe() {
    const checkpoint = this._pixelParityCheckpoint;
    if (!checkpoint) return null;

    // Compare the client's permanent state AT the checkpoint watermark seq
    // against the reference (also captured at that seq). This is independent of
    // the live tail, so the probe stays meaningful even while users keep drawing
    // — and it directly checks that the agreed baked state matches across peers.
    const bakedCanvas = this._renderBakedThroughSeqCanvas(checkpoint.seq);
    if (!bakedCanvas) return null;

    const current = this._downsampleCanvasForPixelParity(
      bakedCanvas,
      checkpoint.width,
      checkpoint.height
    );
    if (!current || current.width !== checkpoint.thumbWidth || current.height !== checkpoint.thumbHeight) return null;

    const divergentTiles = [];
    let maxMad = 0;
    let totalMad = 0;
    let tileCount = 0;

    for (let row = 0; row < checkpoint.rows; row++) {
      for (let col = 0; col < checkpoint.cols; col++) {
        const mad = this._tileMad(current.data, checkpoint.data, checkpoint.thumbWidth, col, row);
        maxMad = Math.max(maxMad, mad);
        totalMad += mad;
        tileCount++;
        if (mad > PIXEL_PARITY_MAD_THRESHOLD && divergentTiles.length < PIXEL_PARITY_MAX_TILES) {
          divergentTiles.push(row * checkpoint.cols + col);
        }
      }
    }

    return {
      parityPixelSnapshotSeq: checkpoint.seq,
      parityPixelSnapshotId: checkpoint.snapshotId || '',
      parityPixelTiles: divergentTiles,
      parityPixelTileSize: PIXEL_PARITY_TILE_SIZE,
      parityPixelMadThresholdX100: Math.round(PIXEL_PARITY_MAD_THRESHOLD * 100),
      parityPixelMaxMadX100: Math.round(maxMad * 100),
      parityPixelMeanMadX100: Math.round((tileCount > 0 ? totalMad / tileCount : 0) * 100),
      parityPixelTileCols: checkpoint.cols,
    };
  }

  _buildPixelParityReference(layerDatas) {
    const dimensions = snapshotLayerDimensions(layerDatas);
    if (!dimensions) return null;

    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const ctx = canvas.getContext('2d');
    this._fillSnapshotBackground(ctx, dimensions.width, dimensions.height);

    for (const qoi of layerDatas) {
      if (!qoi || qoi.length === 0) continue;

      const layerDimensions = readQoiDimensions(qoi);
      if (!layerDimensions) continue;

      const pixels = wasm.qoi_decode(qoi);
      if (!pixels || pixels.length !== layerDimensions.width * layerDimensions.height * 4) continue;

      const layerCanvas = document.createElement('canvas');
      layerCanvas.width = layerDimensions.width;
      layerCanvas.height = layerDimensions.height;
      layerCanvas.getContext('2d').putImageData(
        new ImageData(
          new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
          layerDimensions.width,
          layerDimensions.height
        ),
        0,
        0
      );
      ctx.drawImage(layerCanvas, 0, 0);
    }

    const thumb = this._downsampleCanvasForPixelParity(canvas, dimensions.width, dimensions.height);
    if (!thumb) return null;

    return {
      width: dimensions.width,
      height: dimensions.height,
      cols: Math.ceil(dimensions.width / PIXEL_PARITY_TILE_SIZE),
      rows: Math.ceil(dimensions.height / PIXEL_PARITY_TILE_SIZE),
      thumbWidth: thumb.width,
      thumbHeight: thumb.height,
      data: thumb.data,
    };
  }

  _downsampleCanvasForPixelParity(sourceCanvas, width, height) {
    const cols = Math.ceil(width / PIXEL_PARITY_TILE_SIZE);
    const rows = Math.ceil(height / PIXEL_PARITY_TILE_SIZE);
    const thumbWidth = cols * PIXEL_PARITY_SAMPLES_PER_TILE;
    const thumbHeight = rows * PIXEL_PARITY_SAMPLES_PER_TILE;
    if (thumbWidth <= 0 || thumbHeight <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, thumbWidth, thumbHeight);
    ctx.drawImage(sourceCanvas, 0, 0, width, height, 0, 0, thumbWidth, thumbHeight);

    return {
      width: thumbWidth,
      height: thumbHeight,
      data: ctx.getImageData(0, 0, thumbWidth, thumbHeight).data,
    };
  }

  _tileMad(current, reference, thumbWidth, tileCol, tileRow) {
    const samples = PIXEL_PARITY_SAMPLES_PER_TILE;
    let total = 0;
    let count = 0;
    const startX = tileCol * samples;
    const startY = tileRow * samples;

    for (let y = 0; y < samples; y++) {
      for (let x = 0; x < samples; x++) {
        const offset = ((startY + y) * thumbWidth + startX + x) * 4;
        total += Math.abs(current[offset] - reference[offset]);
        total += Math.abs(current[offset + 1] - reference[offset + 1]);
        total += Math.abs(current[offset + 2] - reference[offset + 2]);
        count += 3;
      }
    }

    return count > 0 ? total / count : 0;
  }

  _fillSnapshotBackground(ctx, width, height) {
    const bg = this.app.board?.backgroundColor || [255, 255, 255, 1];
    if (typeof bg === 'string') {
      ctx.fillStyle = bg;
    } else {
      const [r = 255, g = 255, b = 255, a = 1] = bg;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    ctx.fillRect(0, 0, width, height);
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
