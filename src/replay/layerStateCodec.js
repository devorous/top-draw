/**
 * @fileoverview Lossless serialization of a LayerManager's undoable state for
 * replay checkpoints.
 *
 * The flat-composite snapshot (a single PNG of the board) is cheap but lossy in
 * the way that matters for replay: it freezes the live, still-undoable
 * strokeStack into baked pixels. A rebuild from such a checkpoint has an empty
 * strokeStack, so any UNDO/REDO replayed afterwards has nothing to pop, and any
 * unbaked complex-blend stroke is frozen as its raw (transparent-backdrop)
 * colour instead of its displayed one.
 *
 * This codec instead captures, per layer group:
 *   - the permanently-baked base (flatCanvas for layer 0, the composited
 *     bakedSequences for layers 1+), and
 *   - every live strokeStack record (geometry + blend mode + owner + seq), plus
 *     the per-user redo stacks,
 * each canvas QOI-encoded (lossless, fast). Restored via ReplayEngine, this
 * gives a rebuild genuine undoable records — fixing undo-after-snapshot and
 * complex-blend fidelity while letting seeks rebuild from the nearest
 * checkpoint instead of replaying the whole tape from the opening anchor.
 */

import * as wasm from '../wasm/ddraw_wasm.js';
import { readQoiDimensions } from '../../shared/qoi.js';

/**
 * Encode a canvas's pixels to lossless QOI bytes. Fully-transparent canvases
 * (e.g. an unused layer's empty baked base) encode to null so the caller can
 * store nothing for them.
 * @param {HTMLCanvasElement|OffscreenCanvas|null} canvas
 * @returns {Uint8Array|null} null when empty or on failure
 */
function canvasToQoi(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const bytes = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    if (!wasm.has_content(bytes)) return null;
    return wasm.qoi_encode(bytes, canvas.width, canvas.height);
  } catch (err) {
    console.warn('[layerStateCodec] QOI encode failed:', err);
    return null;
  }
}

/**
 * Decode QOI bytes back into a freshly-allocated canvas.
 * @param {Uint8Array|null} qoi
 * @returns {HTMLCanvasElement|null}
 */
export function qoiToCanvas(qoi) {
  if (!qoi || qoi.length === 0) return null;
  try {
    const pixels = wasm.qoi_decode(qoi);
    const dims = readQoiDimensions(qoi);
    if (!pixels || !dims || pixels.length !== dims.width * dims.height * 4) return null;
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    canvas.getContext('2d').putImageData(
      new ImageData(
        new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        dims.width,
        dims.height
      ),
      0,
      0
    );
    return canvas;
  } catch (err) {
    console.warn('[layerStateCodec] QOI decode failed:', err);
    return null;
  }
}

/**
 * Serialize a single stroke record. Returns null when its canvas can't be
 * encoded (zero-area / failure), so the caller can skip it.
 * @param {Object} record
 * @returns {Object|null}
 */
function serializeStroke(record) {
  if (!record) return null;
  const qoi = canvasToQoi(record.canvas);
  if (!qoi) return null;
  const out = {
    qoi,
    x: record.x,
    y: record.y,
    width: record.width,
    height: record.height,
    blendMode: record.blendMode,
    blendBakeMode: record.blendBakeMode,
    userId: record.userId,
    timestamp: record.timestamp,
    seq: record.seq,
    eraseAll: !!record.eraseAll,
    filterType: record.filterType,
    blurRadius: record.blurRadius,
    affectedTiles: record.affectedTiles,
  };
  // Blur/glitch strokes keep a separate mask canvas; preserve it when distinct.
  if (record.filterType && record.maskCanvas && record.maskCanvas !== record.canvas) {
    out.maskQoi = canvasToQoi(record.maskCanvas);
  }
  // Selection-erase strokes carry restore data that drives undo of the erase.
  if (record.selectionRestoreData) out.selectionRestoreData = record.selectionRestoreData;
  return out;
}

/**
 * Serialize a user's in-progress (active) stroke, cropped to its dirty rect so
 * an idle mid-drag capture doesn't read back the whole board. Returns null when
 * nothing has been drawn into it yet.
 * @param {number} userId
 * @param {Object} active
 * @param {number} width
 * @param {number} height
 * @returns {Object|null}
 * @private
 */
function serializeActiveStroke(userId, active, width, height) {
  const dr = active?.dirtyRect;
  if (!dr || dr.maxX < dr.minX || dr.maxY < dr.minY) return null;
  const x = Math.max(0, Math.floor(dr.minX));
  const y = Math.max(0, Math.floor(dr.minY));
  const w = Math.min(width, Math.ceil(dr.maxX)) - x;
  const h = Math.min(height, Math.ceil(dr.maxY)) - y;
  if (w <= 0 || h <= 0) return null;

  const crop = document.createElement('canvas');
  crop.width = w;
  crop.height = h;
  crop.getContext('2d').drawImage(active.canvas, x, y, w, h, 0, 0, w, h);
  const qoi = canvasToQoi(crop);
  if (!qoi) return null;

  const out = {
    userId,
    qoi,
    x,
    y,
    blendMode: active.blendMode,
    blendBakeMode: active.blendBakeMode,
    dirtyRect: { minX: dr.minX, minY: dr.minY, maxX: dr.maxX, maxY: dr.maxY },
    affectedTiles: active.affectedTiles ? Array.from(active.affectedTiles) : [],
    filterType: active.filterType,
    blurRadius: active.blurRadius,
  };
  if (active.filterType && active.maskCanvas && active.maskCanvas !== active.canvas) {
    out.maskQoi = canvasToQoi(active.maskCanvas);
  }
  return out;
}

/**
 * Export a LayerManager's full undoable state for a replay checkpoint.
 *
 * Returns null when there is nothing live or undoable to preserve (an empty
 * strokeStack, no active strokes, and no redo on any layer): in that case the
 * board is fully baked and the cheap flat-composite snapshot reproduces it
 * exactly, so the caller should keep using that path.
 *
 * @param {import('../canvas/LayerManager.js').LayerManager} layerManager
 * @returns {{ layerBaked: Array<Uint8Array|null>, history: Array<Array<Object>>, activeStrokes: Array<Array<Object>>, redoHistory: Object }|null}
 */
export function exportLayerState(layerManager) {
  if (!layerManager?.layerGroups?.length) return null;
  const width = layerManager.width;
  const height = layerManager.height;

  const layerBaked = [];
  const history = [];
  const activeStrokes = [];
  let hasLiveStrokes = false;

  // Reused scratch canvas for compositing each layer's permanently-baked base.
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = width;
  baseCanvas.height = height;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });

  for (let gi = 0; gi < layerManager.layerGroups.length; gi++) {
    const group = layerManager.layerGroups[gi];

    // Baked base = permanent content only. compositeBakedThroughSeq(…, 0)
    // temporarily empties the strokeStack and composites just the baked
    // content (flatCanvas + bakedSequences, eraser/blur-aware) through the
    // real composite path, then restores the stack synchronously.
    baseCtx.clearRect(0, 0, width, height);
    try {
      layerManager.compositeBakedThroughSeq(baseCtx, gi, 0);
    } catch (err) {
      console.warn('[layerStateCodec] baked-base composite failed:', err);
    }
    layerBaked.push(canvasToQoi(baseCanvas));

    const strokes = [];
    for (const record of group.strokeStack) {
      const s = serializeStroke(record);
      if (s) strokes.push(s);
    }
    if (strokes.length) hasLiveStrokes = true;
    history.push(strokes);

    // In-progress strokes (mid-drag at capture time). Without these, a rebuild
    // from this checkpoint drops any stroke whose MD predates the checkpoint —
    // common in a busy multi-user session — because the replay tail starts after
    // the checkpoint and never sees the stroke begin.
    const actives = [];
    for (const [userId, active] of group.activeStrokeByUser ?? []) {
      const a = serializeActiveStroke(userId, active, width, height);
      if (a) actives.push(a);
    }
    if (actives.length) hasLiveStrokes = true;
    activeStrokes.push(actives);
  }

  const redoHistory = {};
  for (const [userId, batches] of layerManager.redoStackByUser ?? []) {
    const serializedBatches = [];
    for (const batch of batches) {
      const serializedBatch = [];
      for (const entry of batch) {
        const s = serializeStroke(entry?.record);
        if (s) serializedBatch.push({ groupIdx: entry.groupIdx, record: s });
      }
      serializedBatches.push(serializedBatch);
    }
    if (serializedBatches.some((b) => b.length)) redoHistory[userId] = serializedBatches;
  }

  if (!hasLiveStrokes && Object.keys(redoHistory).length === 0) return null;

  return { layerBaked, history, activeStrokes, redoHistory };
}
