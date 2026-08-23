/**
 * @fileoverview LayerManager - Manages multiple off-screen canvas layers with stroke history
 */

import { PixelsWorkerClient } from '../workers/PixelsWorkerClient.js';
import { blurImageData, getStackblurSync } from '../utils/blurUtils.js';

/**
 * Manages multiple layer groups, each containing baked sequences, a stroke stack,
 * and active strokes for users. Handles compositing and baking of strokes.
 */
export class LayerManager {
  static MAX_STROKES_PER_USER = 20;

  /**
   * Live strokes per layer group past which the overflow bake fires even with
   * inbound commits still queued (see _shouldDeferBakeForInbound).
   *
   * Sized against the observed lag, not guessed: clients trail by a median ~1156
   * seqs, and seq counts every broadcast while only commits become strokes, at
   * roughly 68:1 — so the typical backlog is ~17 commits, right at
   * MAX_STROKES_PER_USER. 200 absorbs an order of magnitude more than that while
   * still bounding the stack: each live stroke holds a cropped canvas, so this is
   * the difference between a bounded working set and the ~1.5 GB measured with
   * baking disabled outright.
   */
  static BAKE_DEFER_STACK_CAP = 200;

  /**
   * Inbound-queue bake deferral — DEFAULT OFF. It provably WORKS, and is still
   * net-harmful. Both halves matter, so read both before touching this.
   *
   * Re-measured 2026-08-10 with `test:bakedefer` (3 interleaved rounds, 8 bots,
   * 4 observers under asymmetric CPU lag 1-4x) against an exact oracle —
   * testing/lib/bakeLedger.mjs, which records every flattened stroke by identity
   * in bake order instead of inferring bake behaviour from a pixel percentage.
   * The earlier verdict here ("indistinguishable, buys nothing") was a limit of
   * that pixel oracle, not a fact about this flag.
   *
   *   ON the path it gates:  bake-order inversions  0 / 0 / 0   (OFF: 106/126/304)
   *                          bake violations  median 238        (OFF: 397)
   *   overall:               TOTAL inversions  58-67k           (OFF: 32-41k)
   *                          worst pixel  70-80%                (OFF: 76-87%)
   *                          peak live stack  199-215           (OFF: 131-173)
   *
   * WHY IT LOSES WHILE WORKING. Deferring cannot stop a stroke being flattened;
   * it only keeps it in the live stack for longer. `deepCleanupUserState` — the
   * user-departure bake — then flattens it in DEPARTURE order, and that path has
   * no seq gate at all. Measured directly: with the deferral on, ~800 fewer
   * strokes per run bake through the (gated, order-safe) overflow path and ~500
   * more through the ungated departure path, pushing the cleanup share from ~43%
   * to ~56%. The deferral does not prevent the damage, it relocates it somewhere
   * worse — and cap-engaged runs (peak 215 > BAKE_DEFER_STACK_CAP) show the
   * safety valve firing on top of that.
   *
   * WHAT WOULD JUSTIFY FLIPPING IT TRUE: gate the departure bake as well, or make
   * `deepCleanupUserState` flatten in seq order rather than arrival order. Until
   * then this mechanism perfects one path and feeds a worse one. Do NOT judge a
   * change here on pixel percentages — see [[bake_defer_inbound_queue]].
   */
  static BAKE_DEFER_ENABLED = false;

  /**
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layerGroups = [];
    this.needsComposite = true;
    this.backgroundColor = [255, 255, 255, 1];
    this.strokeHistoryPanel = null;
    this.onHistoryChange = null;
    this.redoStackByUser = new Map();
    this._groupBuffer = null;
    this._canvasPool = [];
    // Deliberately a fixed count, not a byte budget. The pool starts empty and
    // only grows on release, so it self-tunes to peak concurrent strokes — with
    // 2-3 users it never holds more than a few, and lowering the cap reclaims
    // nothing. It is a ceiling for pathological rooms; shrinking it just
    // converts retained canvases into per-stroke allocation churn exactly where
    // concurrency is highest. The real cost is that each in-flight stroke needs
    // a full-board scratch at all — see docs/board_size_lag_plan_2026-08-23.md.
    this.CANVAS_POOL_MAX = 12;
    this.onNeedsUpdate = null; // Callback for Board to requestUpdate
    this.onGlitchBlurReady = null; // Callback fired when local user's glitch blur completes: ({userId, x, y, width, height, canvas})
    this.localUserId = null; // Set by Board/App so we can distinguish local vs remote strokes
    this._pixelsWorker = new PixelsWorkerClient();
    this._lastCommittedStrokeTimestamp = 0;
    // Commits that produced no StrokeRecord because the stroke painted nothing.
    // A legitimately empty gesture and a stroke whose brush image never decoded
    // are indistinguishable at this point, and the second is a sync bug (the
    // drawer has ink nobody else does), so the discard is counted rather than
    // swallowed. `_emptyCommitSamples` keeps the last few for a harness to read;
    // set `window.__TD_WARN_EMPTY_COMMITS = true` to also log each one.
    this._emptyCommitDiscards = 0;
    this._emptyCommitSamples = [];
    // Highest authoritative seq that has been baked into flatCanvas/bakedSequences
    // on THIS client. Baking flattens a global seq-ordered prefix (see
    // _bakeOverflowStrokes), so every stroke with seq <= this is permanent here and
    // every still-undoable (live strokeStack) stroke has a higher seq. The join /
    // checkpoint snapshot is stamped at this seq and captured as baked + strokes
    // <= seq, so the server can replay the undoable tail (> seq) as commands to a
    // joiner instead of baking it away. See getBakedWatermarkSeq.
    this._bakedWatermarkSeq = 0;
    // Users whose strokes are known to never be undone (replay-only optimisation).
    // When set, _bakeOverflowStrokes skips the MAX_STROKES_PER_USER threshold for
    // these users and bakes every bakeable stroke immediately, keeping the
    // strokeStack short and the per-frame composite cheap.
    this.eagerBakeUsers = null;
    // Users who have left or gone AFK. Their retained strokes are drained off
    // the BOTTOM of the stack by _drainDepartedPrefix so the board still gets
    // consolidated, without the out-of-order flatten that made the departure
    // bake the dominant source of divergence. Cleared when the user draws again
    // (AFK is reversible; departure is not, but the id simply never returns).
    this._drainableUsers = new Set();

    this.initLayerGroups(3);
  }

  recycleWorkerClient() {
    this._pixelsWorker?.destroy?.();
    this._pixelsWorker = new PixelsWorkerClient();
  }

  destroy() {
    this.clearAll();
    this._pixelsWorker?.destroy?.();
    this._pixelsWorker = null;
    for (const group of this.layerGroups) {
      this._disposeCanvasElement(group.flatCanvas);
      group.flatCanvas = null;
      group.flatCtx = null;
    }
  }

  /**
   * Notify the stroke history panel to update
   * @param {boolean} [immediate=false] - If true, update immediately
   * @private
   */
  _notifyStrokeHistoryPanel(immediate = false) {
    if (this.strokeHistoryPanel) {
      if (immediate) {
        this.strokeHistoryPanel.update();
      } else {
        this.strokeHistoryPanel.queueUpdate();
      }
    }
    if (this.onHistoryChange) {
      this.onHistoryChange();
    }
  }

  _notifyHistoryPanel(immediate = false) {
    this._notifyStrokeHistoryPanel(immediate);
  }

  /**
   * Create a new full-size canvas and context
   * @returns {Object} {canvas, ctx}
   * @private
   */
  _createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx };
  }

  /**
   * Get a composited canvas of all visible layers.
   * @param {{ ignoreVisibility?: boolean }} [opts] - ignoreVisibility renders
   *   every layer regardless of the local show/hide toggle (gallery
   *   time-lapse capture, so a layer someone hid mid-session doesn't flicker
   *   in/out of the rendered clip).
   * @returns {HTMLCanvasElement}
   */
  getCompositedCanvas({ ignoreVisibility = false, pooled = false } = {}) {
    // `pooled` opts into borrowing from the stroke canvas pool instead of
    // allocating. Allocating a full-board canvas is the most expensive canvas
    // operation there is and it is invisible to JS timers — measured, a fresh
    // 8k canvas per frame drops 180 fps to 92 while the allocating call reports
    // 0.14 ms of self time, because the cost lands in the GPU process. The
    // timelapse capturer runs this every 6 s and the snapshot path on every
    // capture, so each was allocating and freeing 15 MB at 1440p (23 MB at
    // "big") on a timer, forever.
    //
    // Opt-in rather than default because the caller now owns a borrowed
    // resource: it MUST call releaseCompositedCanvas once it is done, and it
    // must not retain the canvas past that point. Only callers that consume the
    // canvas and drop it in the same expression should pass this.
    if (!pooled) {
      const { canvas, ctx } = this._createCanvas();
      this.compositeLayers(ctx, null, { ignoreVisibility });
      return canvas;
    }

    const pair = this._acquireCanvas();
    this.compositeLayers(pair.ctx, null, { ignoreVisibility });
    // Keyed weakly so a caller that forgets to release leaks nothing worse than
    // it would have by allocating — the canvas is simply collected instead of
    // returning to the pool.
    this._borrowedComposites ??= new WeakMap();
    this._borrowedComposites.set(pair.canvas, pair);
    return pair.canvas;
  }

  /**
   * Return a canvas borrowed via `getCompositedCanvas({ pooled: true })`.
   *
   * Safe to call with anything: a canvas that was not borrowed is ignored, so a
   * caller that switches back to the unpooled form does not have to remember to
   * remove the release.
   *
   * @param {HTMLCanvasElement|null|undefined} canvas
   * @returns {void}
   */
  releaseCompositedCanvas(canvas) {
    const pair = this._borrowedComposites?.get(canvas);
    if (!pair) return;
    this._borrowedComposites.delete(canvas);
    this._releaseCanvas(pair);
  }

  _acquireCanvas() {
    if (this._canvasPool.length > 0) {
      const c = this._canvasPool.pop();
      // reset() before anything else: it is the only way to drop a clip region
      // and unwind a save stack that a previous user of this canvas left
      // behind (selection-mask clipping does save()+clip() at MD and
      // restore() at MU, and any path that misses the restore would otherwise
      // hand the next stroke a phantom clip — which clearRect below could not
      // even scrub, since clearRect obeys the clip). Feature-checked: reset()
      // is Chrome 101+/Safari 16.4+, and the explicit resets below remain the
      // fallback for anything older.
      const didReset = typeof c.ctx.reset === 'function';
      if (didReset) {
        c.ctx.reset();
        // reset() restores SPEC defaults, not ours — it undoes the lineCap /
        // lineJoin / imageSmoothingQuality that _createCanvas sets, which would
        // leave freehand strokes on a recycled canvas rendering with butt caps
        // and miter joins while the same stroke on a fresh canvas got round
        // ones. Re-apply them.
        c.ctx.lineCap = 'round';
        c.ctx.lineJoin = 'round';
        c.ctx.imageSmoothingQuality = 'high';
      }
      c.ctx.globalAlpha = 1;
      // reset() already clears the bitmap per spec, so the clearRect is only
      // needed on the pre-Chrome-101 fallback path. A full-board clear is
      // 3.7M pixel writes at 1440p and this runs on every stroke start.
      if (!didReset) c.ctx.clearRect(0, 0, this.width, this.height);
      c.ctx.globalCompositeOperation = 'source-over';
      return c;
    }
    return this._createCanvas();
  }

  /**
   * Return a full-size canvas to the pool
   * @param {Object} canvasObj - {canvas, ctx}
   * @private
   */
  _releaseCanvas(canvasObj) {
    if (!canvasObj) return;
    if (this._canvasPool.length < this.CANVAS_POOL_MAX) {
      // Not cleared here: _acquireCanvas guarantees a clean canvas before any
      // caller can draw on it, and nothing reads a pooled canvas in between
      // (both pool walks only dispose). Clearing on both ends meant two
      // full-board clears per stroke — 7.4M pixel writes at 1440p — to achieve
      // what one does. Correctness stays on the acquire side, which is the
      // fail-safe direction: a stale canvas there would render ghost pixels.
      canvasObj.ctx.globalCompositeOperation = 'source-over';
      this._canvasPool.push(canvasObj);
    }
  }

  /**
   * Get or create the reusable group buffer canvas
   * @returns {Object} {canvas, ctx}
   * @private
   */
  _getGroupBuffer() {
    if (!this._groupBuffer || this._groupBuffer.canvas.width !== this.width || this._groupBuffer.canvas.height !== this.height) {
      this._groupBuffer = this._createCanvas();
    }
    return this._groupBuffer;
  }

  /**
   * Initialize layer groups
   * @param {number} count - Number of layers to create
   */
  initLayerGroups(count) {
    for (let i = 0; i < count; i++) {
      const group = {
        id: i,
        name: `Layer ${i + 1}`,
        visible: true,
        allowComplexBlendModes: i === 0,
        bakedSequences: [],
        strokeStack: [],
        flatStrokeRecords: [],
        userStrokeCounts: new Map(),
        activeStrokeByUser: new Map(),
        activePreviewByUser: new Map(),
        flatCanvas: null,
        flatCtx: null
      };

      if (i === 0) {
        const { canvas, ctx } = this._createCanvas();
        group.flatCanvas = canvas;
        group.flatCtx = ctx;
      }

      this.layerGroups.push(group);
    }
  }

  /**
   * Set whether a layer allows complex blend modes
   * @param {number} groupIdx - Layer index
   * @param {boolean} allow - True to allow complex blend modes
   */
  setLayerAllowComplexBlendModes(groupIdx, allow) {
    if (this.layerGroups[groupIdx]) {
      this.layerGroups[groupIdx].allowComplexBlendModes = allow;
    }
  }

  /**
   * Get whether a layer allows complex blend modes
   * @param {number} groupIdx - Layer index
   * @returns {boolean}
   */
  getLayerAllowComplexBlendModes(groupIdx) {
    return this.layerGroups[groupIdx]?.allowComplexBlendModes ?? true;
  }

  /**
   * Begin a new in-progress stroke for a user
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   * @param {string} [blendMode='source-over'] - Blend mode
   */
  beginUserStroke(groupIdx, userId, blendMode = 'source-over', blendBakeMode = 'existing') {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    // Drawing again un-marks a returning AFK user, so their fresh strokes are
    // protected by the normal undo window instead of being drained.
    this._drainableUsers.delete(userId);

    const { canvas, ctx } = this._acquireCanvas();
    group.activeStrokeByUser.set(userId, {
      canvas,
      ctx,
      blendMode,
      blendBakeMode: blendBakeMode === 'background' ? 'background' : 'existing',
      dirtyRect: { minX: this.width, minY: this.height, maxX: -1, maxY: -1 },
      affectedTiles: new Set()
    });
    this.needsComposite = true;
    this._notifyStrokeHistoryPanel();
  }

  /**
   * Get the drawing context for a user's current in-progress stroke
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   * @param {string} [createBlendMode='source-over'] - Blend mode if creating new stroke
   * @param {Object} [metadata={}] - Optional metadata (e.g., filterType, blurRadius)
   * @returns {CanvasRenderingContext2D|undefined}
   */
  getUserStrokeContext(groupIdx, userId, createBlendMode = 'source-over', metadata = {}) {
    const group = this.layerGroups[groupIdx];
    if (!group) return undefined;

    let active = group.activeStrokeByUser.get(userId);
    if (!active) {
      const { canvas, ctx } = this._acquireCanvas();
      active = {
        canvas,
        ctx,
        blendMode: createBlendMode,
        blendBakeMode: metadata.blendBakeMode === 'background' ? 'background' : 'existing',
        dirtyRect: { minX: this.width, minY: this.height, maxX: -1, maxY: -1 },
        ...metadata
      };
      if (metadata.filterType === 'blur' || metadata.filterType === 'glitchBlur') {
        active.maskCanvas = canvas;
      }
      group.activeStrokeByUser.set(userId, active);
    } else if (createBlendMode !== 'source-over' && active.blendMode !== createBlendMode) {
      active.blendMode = createBlendMode;
    }
    if (metadata.blendBakeMode) {
      active.blendBakeMode = metadata.blendBakeMode === 'background' ? 'background' : 'existing';
    }
    return active.ctx;
  }

  /**
   * Get the active stroke object for a user (for tracking affected tiles, etc.)
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   * @returns {Object|undefined} The active stroke object or undefined
   */
  getActiveStroke(groupIdx, userId) {
    const group = this.layerGroups[groupIdx];
    if (!group) return undefined;
    return group.activeStrokeByUser.get(userId);
  }

  /**
   * Commit a completed stroke
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   * @param {Object} [extraProps={}] - Extra properties for the stroke record
   */
  commitUserStroke(groupIdx, userId, extraProps = {}) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    if (!active) return;

    group.activeStrokeByUser.delete(userId);

    // Capture affected tiles before releasing active stroke
    const affectedTiles = active.affectedTiles ? Array.from(active.affectedTiles) : [];
    const timestamp = this._getNextCommittedStrokeTimestamp(extraProps.timestamp);

    // Handle filter strokes (blur) differently - they need metadata and potentially special rendering
    if (extraProps.filterType === 'blur' || extraProps.filterType === 'glitchBlur') {
      const cropBounds = extraProps.cropBounds || { x: 0, y: 0, width: this.width, height: this.height };
      const record = {
        canvas: active.canvas,
        ctx: active.ctx,
        x: cropBounds.x,
        y: cropBounds.y,
        width: cropBounds.width,
        height: cropBounds.height,
        blendMode: active.blendMode,
        userId,
        timestamp,
        filterType: extraProps.filterType,
        blurRadius: extraProps.blurRadius,
        maskCanvas: active.canvas,
        mirrorRegions: Array.isArray(extraProps.mirrorRegions) ? extraProps.mirrorRegions : [],
        affectedTiles
      };

      group.strokeStack.push(record);
      const prev = group.userStrokeCounts.get(userId) || 0;
      group.userStrokeCounts.set(userId, prev + 1);

      // Check for a buffered GLITCH_RESULT that arrived before this stroke was committed
      this._consumePendingGlitchResult(record);

      this._bakeOverflowStrokes(group);
      this._clearRedoStack(userId);
      this.needsComposite = true;
      this._notifyStrokeHistoryPanel();
      return;
    }

    // Regular stroke handling
    const dr = active.dirtyRect;
    let bounds;
    if (dr && dr.maxX !== -1) {
      const bx = Math.floor(Math.max(0, dr.minX));
      const by = Math.floor(Math.max(0, dr.minY));
      const bw = Math.ceil(Math.min(active.canvas.width, dr.maxX + 1)) - bx;
      const bh = Math.ceil(Math.min(active.canvas.height, dr.maxY + 1)) - by;
      if (bw > 0 && bh > 0) {
        bounds = { x: bx, y: by, width: bw, height: bh };
      } else {
        bounds = this._findContentBoundsLegacy(active.canvas);
      }
    } else {
      this._noteEmptyCommit(userId, groupIdx, 'no-dirty-rect');
      this._releaseCanvas(active);
      return;
    }

    if (!bounds) {
      this._noteEmptyCommit(userId, groupIdx, 'no-content-bounds');
      this._releaseCanvas(active);
      return;
    }

    const { x, y, width, height } = bounds;
    let croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    let croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(active.canvas, x, y, width, height, 0, 0, width, height);

    this._releaseCanvas(active);

    let resolvedBlendMode = active.blendMode;
    if (
      group.flatCanvas &&
      resolvedBlendMode !== 'source-over' &&
      resolvedBlendMode !== 'destination-out'
    ) {
      if (active.blendBakeMode !== 'background') {
        const contentCanvas = this._buildFlatContentCanvas(group, x, y, width, height);
        croppedCtx.globalCompositeOperation = 'destination-in';
        croppedCtx.drawImage(contentCanvas, 0, 0);
        croppedCtx.globalCompositeOperation = 'source-over';
      }
    }

    const record = { canvas: croppedCanvas, ctx: croppedCtx, x, y, width, height, blendMode: resolvedBlendMode, blendBakeMode: active.blendBakeMode, userId, timestamp, affectedTiles, ...extraProps };
    group.strokeStack.push(record);

    const prev = group.userStrokeCounts.get(userId) || 0;
    group.userStrokeCounts.set(userId, prev + 1);

    this._sortStrokeStack(group);
    this._bakeOverflowStrokes(group);
    this._clearRedoStack(userId);
    this.needsComposite = true;
    this._notifyStrokeHistoryPanel();
  }

  _buildFlatContentCanvas(group, x, y, width, height) {
    const contentCanvas = document.createElement('canvas');
    contentCanvas.width = width;
    contentCanvas.height = height;
    const contentCtx = contentCanvas.getContext('2d');

    contentCtx.drawImage(group.flatCanvas, x, y, width, height, 0, 0, width, height);

    for (const s of group.strokeStack) {
      const sx = s.x || 0;
      const sy = s.y || 0;
      const overlaps = sx < x + width && sx + s.width > x && sy < y + height && sy + s.height > y;
      if (!overlaps) continue;

      contentCtx.globalCompositeOperation = s.blendMode === 'destination-out' ? 'destination-out' : 'source-over';
      contentCtx.drawImage(s.canvas, sx - x, sy - y);
    }

    contentCtx.globalCompositeOperation = 'source-over';
    return contentCanvas;
  }

  /**
   * Generate a monotonic stroke timestamp.
   * Preserves explicit timestamps so intentional multi-layer batches still undo together.
   * @param {number|undefined} explicitTimestamp
   * @returns {number}
   * @private
   */
  _getNextCommittedStrokeTimestamp(explicitTimestamp) {
    if (Number.isFinite(explicitTimestamp)) {
      this._lastCommittedStrokeTimestamp = Math.max(this._lastCommittedStrokeTimestamp, explicitTimestamp);
      return explicitTimestamp;
    }

    const now = Date.now();
    const nextTimestamp = now > this._lastCommittedStrokeTimestamp
      ? now
      : this._lastCommittedStrokeTimestamp + 1;
    this._lastCommittedStrokeTimestamp = nextTimestamp;
    return nextTimestamp;
  }

  /**
   * Reserve a unique timestamp for a multi-stroke history batch.
   * @returns {number}
   */
  allocateHistoryTimestamp() {
    return this._getNextCommittedStrokeTimestamp();
  }

  /**
   * Cancel an in-progress stroke
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   */
  cancelUserStroke(groupIdx, userId) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    if (active) {
      group.activeStrokeByUser.delete(userId);
      this._releaseCanvas(active);
      this.needsComposite = true;
      this._notifyStrokeHistoryPanel();
    }
    if (this._deleteUserPreviewFromGroup(group, userId)) {
      this.needsComposite = true;
    }
  }

  /**
   * Track a transient, non-committed preview canvas for a user on a layer.
   * The source canvas is copied into layer-manager-owned storage so scheduled
   * composites never sample a remote DOM preview while it is between clear and
   * redraw operations.
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   * @param {HTMLCanvasElement} sourceCanvas - Full-size preview canvas
   * @param {string} [blendMode='source-over'] - Blend mode for compositing
   * @param {{x:number,y:number,width:number,height:number}|null} [dirtyRect=null] - Optional changed region
   */
  setUserPreviewStroke(groupIdx, userId, sourceCanvas, blendMode = 'source-over', dirtyRect = null) {
    const group = this.layerGroups[groupIdx];
    if (!group || !sourceCanvas) return;

    for (const otherGroup of this.layerGroups) {
      if (otherGroup !== group) {
        this._deleteUserPreviewFromGroup(otherGroup, userId);
      }
    }

    let preview = group.activePreviewByUser.get(userId);
    if (!preview || !preview.canvas || preview.canvas.width !== this.width || preview.canvas.height !== this.height) {
      if (preview) this._releaseCanvas(preview);
      preview = {
        ...this._acquireCanvas(),
        userId,
        isPreview: true
      };
      group.activePreviewByUser.set(userId, preview);
    }

    preview.blendMode = blendMode || 'source-over';
    this._copyPreviewSource(preview.ctx, sourceCanvas, dirtyRect);
    this.needsComposite = true;
  }

  /**
   * Clear a transient preview for a user.
   * @param {number} userId - User ID
   * @param {number|null} [groupIdx=null] - Optional layer index
   */
  clearUserPreviewStroke(userId, groupIdx = null) {
    let removed = false;
    if (Number.isFinite(groupIdx)) {
      removed = this._deleteUserPreviewFromGroup(this.layerGroups[groupIdx], userId);
    } else {
      for (const group of this.layerGroups) {
        removed = this._deleteUserPreviewFromGroup(group, userId) || removed;
      }
    }
    if (removed) this.needsComposite = true;
  }

  _copyPreviewSource(targetCtx, sourceCanvas, dirtyRect = null) {
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.globalAlpha = 1;

    const rect = dirtyRect && Number.isFinite(dirtyRect.x) && Number.isFinite(dirtyRect.y) && dirtyRect.width > 0 && dirtyRect.height > 0
      ? {
          x: Math.max(0, Math.floor(dirtyRect.x)),
          y: Math.max(0, Math.floor(dirtyRect.y)),
          width: Math.ceil(dirtyRect.width),
          height: Math.ceil(dirtyRect.height)
        }
      : null;

    if (!rect) {
      targetCtx.clearRect(0, 0, this.width, this.height);
      targetCtx.drawImage(sourceCanvas, 0, 0);
      return;
    }

    const right = Math.min(this.width, rect.x + rect.width, sourceCanvas.width);
    const bottom = Math.min(this.height, rect.y + rect.height, sourceCanvas.height);
    if (right <= rect.x || bottom <= rect.y) return;

    const width = right - rect.x;
    const height = bottom - rect.y;
    targetCtx.clearRect(rect.x, rect.y, width, height);
    targetCtx.drawImage(sourceCanvas, rect.x, rect.y, width, height, rect.x, rect.y, width, height);
  }

  _deleteUserPreviewFromGroup(group, userId) {
    if (!group?.activePreviewByUser?.has(userId)) return false;
    const preview = group.activePreviewByUser.get(userId);
    group.activePreviewByUser.delete(userId);
    this._releaseCanvas(preview);
    return true;
  }

  _clearPreviewsFromGroup(group) {
    if (!group?.activePreviewByUser) return;
    for (const preview of group.activePreviewByUser.values()) {
      this._releaseCanvas(preview);
    }
    group.activePreviewByUser.clear();
  }

  /**
   * Commits all active strokes for a user across all layer groups (for AFK users).
   * Returns a generator function that yields one group at a time to allow
   * delays between commits for avoiding lag.
   * @param {number} userId - User ID
   * @returns {Generator<number, void, void>} Generator that yields groupIdx when committing
   */
  *commitAllUserStrokesGenerator(userId) {
    for (let gi = 0; gi < this.layerGroups.length; gi++) {
      if (this.layerGroups[gi].activeStrokeByUser.has(userId)) {
        this.commitUserStroke(gi, userId);
        yield gi;
      }
    }
  }

  /**
   * Push a batch of strokes to the redo stack
   * @param {number} userId - User ID
   * @param {Array} batch - Array of stroke records
   * @private
   */
  _pushToRedoStack(userId, batch) {
    if (!this.redoStackByUser.has(userId)) this.redoStackByUser.set(userId, []);
    this.redoStackByUser.get(userId).push(batch);
  }

  /**
   * Clear the redo stack for a user
   * @param {number} userId - User ID
   * @private
   */
  _clearRedoStack(userId) {
    this.redoStackByUser.set(userId, []);
  }

  /**
   * Check whether a user has any undoable stroke in live, flat, or baked history.
   * @param {number} userId - User ID
   * @returns {boolean}
   */
  hasUndoableStroke(userId) {
    // Only live strokeStack entries are undoable. Once a stroke overflows the
    // MAX_STROKES_PER_USER window it gets baked into flatCanvas / bakedSequences,
    // which flattens it irreversibly into shared, interleaved pixels — there's no
    // faithful way to peel it back out, so baked strokes are permanent.
    for (const group of this.layerGroups) {
      if (group.strokeStack.some(stroke => stroke.userId === userId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Import a baked sequence from network sync
   * @param {number} groupIdx - Layer index
   * @param {string} blendMode - Blend mode
   * @param {ImageBitmap} imageBitmap - Baked sequence image
   */
  importSequence(groupIdx, blendMode, imageBitmap) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    if (group.flatCanvas) {
      group.flatCtx.globalCompositeOperation = blendMode;
      group.flatCtx.drawImage(imageBitmap, 0, 0);
      group.flatCtx.globalCompositeOperation = 'source-over';
    } else {
      const seq = this._createCanvas();
      seq.blendMode = blendMode;
      seq.ctx.drawImage(imageBitmap, 0, 0);
      group.bakedSequences.push(seq);
    }
    this.needsComposite = true;
  }

  /** @deprecated Use importSequence */
  importLayerBin(groupIdx, blendMode, imageBitmap) {
    this.importSequence(groupIdx, blendMode, imageBitmap);
  }

  /** @deprecated Use importSequence */
  importBaseCanvas(groupIdx, imageBitmap) {
    this.importSequence(groupIdx, 'source-over', imageBitmap);
  }

  /**
   * Insert a stroke record directly into a layer group's stroke stack
   * @param {number} groupIdx - Layer index
   * @param {Object} record - Stroke record
   */
  importStroke(groupIdx, record) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    group.strokeStack.push(record);

    const prev = group.userStrokeCounts.get(record.userId) || 0;
    group.userStrokeCounts.set(record.userId, prev + 1);

    this._sortStrokeStack(group);
    this.needsComposite = true;
  }

  /**
   * Update an optimistic local stroke with its authoritative server-assigned sequence number.
   * @param {number} groupIdx - Layer index
   * @param {number} userId - User ID
   * @param {number} seq - Authoritative sequence number
   * @returns {boolean} True if a stroke was reconciled
   */
  reconcileLocalStroke(groupIdx, userId, seq) {
    const group = this.layerGroups[groupIdx];
    if (!group) return false;

    // Echoes arrive in the order we sent the strokes (the server assigns seqs in
    // receipt order and a single WebSocket preserves order), so the incoming seq
    // belongs to our oldest still-unconfirmed stroke. Targeting the newest one
    // instead would reverse the z-order of same-user strokes drawn faster than
    // one round-trip, diverging from how remotes (who got real seqs up front)
    // render them. Match FIFO: assign to the unconfirmed stroke with the
    // smallest local timestamp.
    let target = null;
    for (const s of group.strokeStack) {
      // Skip strokes awaiting a dedicated commit-class echo (e.g. fill): those
      // carry their own authoritative seq via that echo, NOT this MU's seq.
      if (s.userId !== userId || s.seq > 0 || s.pendingCommitEcho) continue;
      if (!target || (s.timestamp || 0) < (target.timestamp || 0)) target = s;
    }
    if (target) {
      target.seq = seq;
      this._sortStrokeStack(group);
      this._bakeOverflowStrokes(group);
      this.needsComposite = true;
    }
    return !!target;
  }

  /**
   * Reconcile the local user's oldest still-optimistic stroke or stroke batch
   * with its authoritative server seq, searching every layer group. Used by the
   * MU self-echo path, where the stroke may live on a layer other than the one
   * currently active, or may span multiple layers for erase-all.
   * @param {number} userId - Local user ID
   * @param {number} seq - Authoritative sequence number
   * @returns {boolean} True if a stroke was reconciled
   */
  reconcileOldestLocalStroke(userId, seq) {
    let bestTs = Infinity;
    for (const group of this.layerGroups) {
      for (const s of group.strokeStack) {
        // Skip strokes awaiting a dedicated commit-class echo (e.g. fill).
        if (s.userId !== userId || s.seq > 0 || s.pendingCommitEcho) continue;
        const ts = s.timestamp || 0;
        if (ts < bestTs) bestTs = ts;
      }
    }
    if (!Number.isFinite(bestTs)) return false;

    let reconciled = false;
    for (const group of this.layerGroups) {
      let touched = false;
      for (const s of group.strokeStack) {
        if (s.userId !== userId || s.seq > 0 || s.pendingCommitEcho || (s.timestamp || 0) !== bestTs) continue;
        s.seq = seq;
        touched = true;
        reconciled = true;
      }
      if (touched) {
        this._sortStrokeStack(group);
        this._bakeOverflowStrokes(group);
        this.needsComposite = true;
      }
    }
    return reconciled;
  }

  /**
   * Reconcile the local user's oldest stroke that is awaiting a specific
   * commit-class echo (e.g. fill) with its authoritative server seq. Searches
   * every layer group and matches FIFO by local timestamp so that, with several
   * commits of the same type in flight, each echo lands on the stroke it
   * actually produced — the same order observers commit them in.
   *
   * Unlike the MU path, the fill stroke's seq is NOT the MU's seq: the fill
   * broadcast races its own MU (see WebSocketClient self-echo notes), so only
   * the FILL echo carries the seq observers used. Clears the pendingCommitEcho
   * tag so the stroke can bake/undo normally afterward.
   * @param {number} userId - Local user ID
   * @param {number} seq - Authoritative sequence number from the commit echo
   * @param {string} commitType - Tag to match (e.g. 'fill', 'glitch')
   * @param {number|null} groupIdx - If given, only search that layer group. Used
   *   by glitch, which commits one stroke PER layer and sends one echo per layer
   *   (each with its own seq), so each layer's stroke must reconcile to its own
   *   layer's echo. Fill passes null (one stroke, search everywhere).
   * @returns {boolean} True if a stroke was reconciled
   */
  reconcileLocalCommitStroke(userId, seq, commitType, groupIdx = null) {
    const groups = groupIdx == null
      ? this.layerGroups
      : (this.layerGroups[groupIdx] ? [this.layerGroups[groupIdx]] : []);
    let bestTs = Infinity;
    let bestGroup = null;
    let bestStroke = null;
    for (const group of groups) {
      for (const s of group.strokeStack) {
        if (s.userId !== userId || s.pendingCommitEcho !== commitType) continue;
        const ts = s.timestamp || 0;
        if (ts < bestTs) { bestTs = ts; bestGroup = group; bestStroke = s; }
      }
    }
    if (!bestStroke) return false;

    bestStroke.seq = seq;
    delete bestStroke.pendingCommitEcho;
    this._sortStrokeStack(bestGroup);
    this._bakeOverflowStrokes(bestGroup);
    this.needsComposite = true;
    return true;
  }

  /**
   * Like reconcileLocalCommitStroke, but reconciles every stroke in the oldest
   * tagged batch rather than a single stroke.
   *
   * A selection erase can commit more than one stroke for one wire commit — the
   * selected area plus its mirrored counterpart. Reconciling only one would
   * leave the rest at seq 0, which _sortStrokeStack floats to the TOP of the
   * stack, so a destination-out stroke would erase every later stroke by anyone.
   * Strokes of one batch share the timestamp allocated by the caller, so the
   * oldest timestamp identifies the batch this echo belongs to (FIFO, matching
   * the single-stroke reconciler).
   *
   * @param {number} userId
   * @param {number} seq - Authoritative sequence from the server echo.
   * @param {string} commitType - Tag to match (e.g. 'sel_delete')
   * @returns {boolean} True if at least one stroke was reconciled
   */
  reconcileLocalCommitBatch(userId, seq, commitType) {
    let bestTs = Infinity;
    for (const group of this.layerGroups) {
      for (const s of group.strokeStack) {
        if (s.userId !== userId || s.pendingCommitEcho !== commitType) continue;
        bestTs = Math.min(bestTs, s.timestamp || 0);
      }
    }
    if (bestTs === Infinity) return false;

    let reconciled = 0;
    for (const group of this.layerGroups) {
      let touched = false;
      for (const s of group.strokeStack) {
        if (s.userId !== userId || s.pendingCommitEcho !== commitType) continue;
        if ((s.timestamp || 0) !== bestTs) continue;
        s.seq = seq;
        delete s.pendingCommitEcho;
        touched = true;
        reconciled++;
      }
      if (touched) {
        this._sortStrokeStack(group);
        this._bakeOverflowStrokes(group);
      }
    }
    if (reconciled) this.needsComposite = true;
    return reconciled > 0;
  }

  /**
   * Sort the unbaked stroke stack based on global sequence number,
   * falling back to local timestamp for optimistic strokes (seq=0).
   * @param {Object} group - Layer group
   * @private
   */
  _sortStrokeStack(group) {
    group.strokeStack.sort((a, b) => {
      // seq=0 or undefined means optimistic local stroke (not yet confirmed by server)
      const sa = a.seq || Number.MAX_SAFE_INTEGER;
      const sb = b.seq || Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Insert a stroke record into a specific redo batch for a user
   * @param {number} userId - User ID
   * @param {number} batchIdx - Batch index
   * @param {number} groupIdx - Layer index
   * @param {Object} record - Stroke record
   */
  importRedoStroke(userId, batchIdx, groupIdx, record) {
    if (!this.redoStackByUser.has(userId)) this.redoStackByUser.set(userId, []);
    const batches = this.redoStackByUser.get(userId);
    while (batches.length <= batchIdx) batches.push([]);
    batches[batchIdx].push({ groupIdx, record });
  }

  /**
   * Undo the most recently committed stroke across all layers for a user
   * @param {number} userId - User ID
   * @param {number} [targetSeq=0] - Undo the stroke carrying THIS authoritative
   *   seq instead of re-resolving "the latest one" locally. A remote UNDO names
   *   its target (App.handleUndo) precisely because "latest live stroke" is
   *   answered against each client's own bake state, and clients that have baked
   *   different prefixes resolve different strokes. 0 = not named (sender's
   *   target was unsequenced, or an old client) → legacy local resolution.
   * @returns {Array|null} The undone stroke batch
   */
  undoLastStrokeGlobal(userId, targetSeq = 0) {
    // When the sender named a target, the fallback below may only consider
    // UNSEQUENCED strokes. See the note above `unsequencedOnly`.
    let unsequencedOnly = false;
    if (targetSeq > 0) {
      const named = this._undoStrokeBySeq(userId, targetSeq);
      if (named) return named;
      // Target not in our live stack. Do NOT stop outright: a joiner rebuilds
      // strokes from the command tail and they can carry seq 0, so a seq lookup
      // finds nothing on exactly the client that most needs to stay in step
      // (measured: selparity move_commit_then_undo, joiner at 88.5% while the
      // live clients agreed). Fall through — but only over strokes that COULD
      // be the named one under a different label, i.e. the seq-0 rebuilt ones.
      //
      // Falling through to every stroke was actively destructive. A sender's
      // undo stack can name a seq we never bound to a stroke at all (its seq
      // came from an MU broadcast that carried no stroke here — see
      // App._strokeMdBroadcast), and the unrestricted fallback then undid "our
      // latest live stroke" instead: a sequenced stroke the sender still has.
      // Observed in docs/ddraw_replay_2026-08-12_22-00-46.ddraw at 22:47.750 —
      // a peer's 10th undo named seq 144598, which that client had no stroke
      // for, so it undid the SEL_DELETE at seq 144356 and the selection the
      // sender had cleared 33s earlier reappeared for the observer only.
      unsequencedOnly = true;
    }
    let latestTimestamp = -1;
    let latestSeq = -1;

    // Find the latest stroke for this user.
    // Authoritative strokes (seq > 0) are always earlier than optimistic ones (seq = 0).
    const isLater = (s, t, ls, lt) => {
      if (s === 0 && ls > 0) return true; // Optimistic is later than authoritative
      if (s > 0 && ls === 0) return false;
      if (s !== ls) return s > ls; // Both same type, compare seq
      return t > lt; // Same seq (likely both 0), compare timestamp
    };

    // Only consider live strokeStack entries. Baked strokes (flatCanvas /
    // bakedSequences) are flattened irreversibly and must not be undoable.
    for (const group of this.layerGroups) {
      for (const stroke of group.strokeStack) {
        if (stroke.userId === userId) {
          const s = stroke.seq || 0;
          if (unsequencedOnly && s > 0) continue;
          const t = stroke.timestamp || 0;
          if (latestSeq === -1 || isLater(s, t, latestSeq, latestTimestamp)) {
            latestSeq = s;
            latestTimestamp = t;
          }
        }
      }
    }
    if (latestSeq === -1) return null;

    let isEraseAll = false;
    outer: for (const group of this.layerGroups) {
      for (const s of group.strokeStack) {
        if (s.userId === userId && (s.seq || 0) === latestSeq && (s.timestamp || 0) === latestTimestamp) {
          isEraseAll = s.eraseAll === true;
          break outer;
        }
      }
    }

    const undoneStrokes = [];
    const matchesTarget = (stroke) => {
      if (!stroke || stroke.userId !== userId) return false;
      if (isEraseAll && stroke.eraseAll !== true) return false;
      
      // If we have an authoritative seq, it's a unique identifier.
      if (latestSeq > 0) {
        return stroke.seq === latestSeq;
      }
      
      // Fallback to timestamp for optimistic strokes.
      return (stroke.seq || 0) === 0 && stroke.timestamp === latestTimestamp;
    };

    const removeFromCollection = (collection, groupIdx, group) => {
      if (!Array.isArray(collection) || collection.length === 0) return false;

      let removed = false;
      for (let i = collection.length - 1; i >= 0; i--) {
        const stroke = collection[i];
        if (!matchesTarget(stroke)) continue;

        collection.splice(i, 1);
        const count = group.userStrokeCounts.get(userId) || 0;
        if (count > 0) group.userStrokeCounts.set(userId, count - 1);
        undoneStrokes.push({ groupIdx, record: stroke });
        removed = true;
      }

      return removed;
    };

    for (let gi = 0; gi < this.layerGroups.length; gi++) {
      const group = this.layerGroups[gi];

      // Only the live stack is undoable; baked strokes stay put.
      removeFromCollection(group.strokeStack, gi, group);
    }

    if (undoneStrokes.length === 0) return null;

    this.needsComposite = true;
    this._notifyHistoryPanel(true);
    return undoneStrokes;
  }

  /**
   * Undo the specific stroke(s) a remote UNDO named, by authoritative seq.
   *
   * One wire commit can produce several stroke records sharing a seq (per-layer
   * erases, a mirrored counterpart, a merge stamp), so this removes every live
   * stroke of that user carrying the seq — the same batch semantics the
   * resolve-locally path uses.
   *
   * Returns null when the target is not in the live stack. That is the correct
   * outcome, not a failure: the stroke has already been baked here (baking is
   * irreversible) or was never received. Undoing "something else instead" is
   * precisely the divergence this exists to stop.
   *
   * @param {number} userId
   * @param {number} targetSeq
   * @returns {Array|null}
   * @private
   */
  _undoStrokeBySeq(userId, targetSeq) {
    const undoneStrokes = [];
    for (let gi = 0; gi < this.layerGroups.length; gi++) {
      const group = this.layerGroups[gi];
      const stack = group.strokeStack;
      if (!Array.isArray(stack) || stack.length === 0) continue;
      for (let i = stack.length - 1; i >= 0; i--) {
        const stroke = stack[i];
        if (!stroke || stroke.userId !== userId || (stroke.seq || 0) !== targetSeq) continue;
        stack.splice(i, 1);
        const count = group.userStrokeCounts.get(userId) || 0;
        if (count > 0) group.userStrokeCounts.set(userId, count - 1);
        undoneStrokes.push({ groupIdx: gi, record: stroke });
      }
    }
    if (undoneStrokes.length === 0) return null;
    this.needsComposite = true;
    this._notifyHistoryPanel(true);
    return undoneStrokes;
  }

  /**
   * Redo the most recently undone stroke batch for a user
   * @param {number} userId - User ID
   * @returns {boolean} True if successful
   */
  redoLastStroke(userId) {
    const stack = this.redoStackByUser.get(userId);
    if (!stack || stack.length === 0) return false;

    const batch = stack.pop();
    for (const { groupIdx, record } of batch) {
      const group = this.layerGroups[groupIdx];
      if (!group) continue;
      
      let insertIdx = group.strokeStack.length;
      for (let i = 0; i < group.strokeStack.length; i++) {
        if (group.strokeStack[i].timestamp > record.timestamp) {
          insertIdx = i;
          break;
        }
      }
      group.strokeStack.splice(insertIdx, 0, record);
      const cnt = group.userStrokeCounts.get(userId) || 0;
      group.userStrokeCounts.set(userId, cnt + 1);
      this._sortStrokeStack(group);
      this._bakeOverflowStrokes(group);
    }

    this.needsComposite = true;
    this._notifyHistoryPanel(true);
    return true;
  }

  /**
   * Wipe all strokes from a specific user
   * @param {number} targetUserId - User ID to wipe
   * @returns {boolean} True if strokes were removed
   */
  wipeUserStrokes(targetUserId) {
    let removed = false;

    for (const group of this.layerGroups) {
      const initialLength = group.strokeStack.length;
      group.strokeStack = group.strokeStack.filter(stroke => stroke.userId !== targetUserId);

      if (group.strokeStack.length < initialLength) {
        removed = true;
        group.userStrokeCounts.delete(targetUserId);
      }

      if (group.activeStrokeByUser.has(targetUserId)) {
        const active = group.activeStrokeByUser.get(targetUserId);
        this._releaseCanvas(active);
        group.activeStrokeByUser.delete(targetUserId);
        removed = true;
      }

      if (this._deleteUserPreviewFromGroup(group, targetUserId)) {
        removed = true;
      }

      for (const seq of group.bakedSequences) {
        if (seq.type === 'group' && seq.strokes) {
          const origLen = seq.strokes.length;
          seq.strokes = seq.strokes.filter(s => s.userId !== targetUserId);
          if (seq.strokes.length < origLen) removed = true;
        }
      }
    }

    this.redoStackByUser.delete(targetUserId);

    if (removed) {
      this.needsComposite = true;
      this._notifyHistoryPanel(true);
    }

    return removed;
  }

  /** @deprecated Use undoLastStrokeGlobal */
  undoLastStroke(groupIdx, userId) {
    return this.undoLastStrokeGlobal(userId) !== null;
  }

  /**
   * Bake oldest strokes into sequences or groups when limit is exceeded
   * @param {Object} group - Layer group
   * @private
   */
  _bakeOverflowStrokes(group) {
    const MAX = LayerManager.MAX_STROKES_PER_USER;
    const safeModes = ['source-over', 'destination-out', 'multiply', 'darken', 'lighten', 'screen'];
    const eager = this.eagerBakeUsers;

    // Baking is irreversible: it flattens the bottom of the (seq-ordered) stack
    // into flatCanvas/bakedSequences, resolving each stroke's blend mode against
    // whatever is beneath it AT BAKE TIME. For that result to match across
    // clients, every client must flatten the SAME prefix in the SAME global
    // order. Our own freshly-committed strokes are optimistic (seq=0) until the
    // server echoes their authoritative seq, and _sortStrokeStack parks them at
    // the TOP of the stack until then. If we bake now, those pending strokes are
    // skipped from the baked prefix — so we'd flatten a different backdrop than
    // remote clients (who already received the same strokes carrying a real seq).
    // For source-over that's invisible (it's associative), but for non-commutative
    // blend modes like `overlay` it diverges permanently. Defer until every local
    // stroke is reconciled; reconcileLocalStroke re-invokes us once seq lands.
    if (this._hasUnconfirmedLocalStroke(group)) return;

    // Same argument, different cause: that check covers OUR unreconciled strokes,
    // this one covers everyone else's undelivered ones. The inbound drain runs on
    // a time budget, so under load clients trail the stream by DIFFERENT amounts.
    // Baking now flattens whatever prefix happens to have arrived here, while a
    // client that is caught up flattens a larger one — and baking is irreversible,
    // so the two boards never reconverge. Wait until the queue is empty so every
    // client bakes the same prefix. commitUserStroke re-enters this on the next
    // commit, which is exactly when the drained messages land.
    if (LayerManager.BAKE_DEFER_ENABLED && this._shouldDeferBakeForInbound(group)) return;

    this._drainDepartedPrefix(group, safeModes);

    let i = 0;
    while (
      i < group.strokeStack.length &&
      (this._anyUserOverMax(group, MAX) || this._anyEagerBakeable(group, eager))
    ) {
      const stroke = group.strokeStack[i];
      const isEager = eager && eager.has(stroke.userId);

      // Eager bake is a REPLAY-only optimisation (eagerBakeUsers is set solely by
      // TimeMachine, for users who never undo in the tape) that flattens every
      // stroke immediately instead of at the MAX_STROKES_PER_USER threshold.
      //
      // Restrict it to the modes `_bakeStrokeToBin` can flatten losslessly — a
      // plain composite of the stroke onto flatCanvas. Anything else routes to
      // `_bakeFlatComplexBlendStroke`, which has to RECONSTRUCT a backdrop
      // (background colour + flatCanvas) and then extract the stroke's
      // footprint. That is an approximation of the real render-time composite,
      // not an identity, so eagerly baking a complex blend makes the replay
      // disagree with the live board it is supposed to reproduce.
      //
      // Measured on test:parity: a SINGLE `screen` stroke on an empty layer
      // replayed at 59.97% when eager-baked and 100.00% when left in the stack.
      // Keeping these in the live strokeStack costs a little memory during
      // replay and buys exactness. Non-eager baking (the 20-stroke overflow
      // path) is unchanged — that trade-off is deliberate and long-standing.
      const eagerSafe = !isEager
        || stroke.blendMode === 'source-over'
        || stroke.blendMode === 'destination-out';

      if (eagerSafe && this._canBakeStroke(group, stroke, safeModes)) {
        this._bakeStrokeToBin(group, stroke);
        group.strokeStack.splice(i, 1);
        this._advanceBakedWatermark(stroke.seq);

        const count = group.userStrokeCounts.get(stroke.userId) || 0;
        if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);
      } else if (isEager) {
        // Eager-bake user but stroke is not directly bakeable — skip; will be
        // handled by the compress-run path below the next time we hit it.
        i++;
      } else {
        const runEnd = this._findBlendModeRunEnd(group.strokeStack, i);
        const runLength = runEnd - i + 1;
        const hasBlendModeChange = runEnd + 1 < group.strokeStack.length &&
                                    group.strokeStack[runEnd + 1].blendMode !== stroke.blendMode;

        if (hasBlendModeChange || runLength >= 5) {
          this._compressStrokesToGroup(group, i, runEnd);
        } else {
          i++;
        }
      }
    }
  }

  /**
   * Consolidate the strokes of departed / AFK users, WITHOUT reintroducing the
   * out-of-order flatten that `deepCleanupUserState` used to do.
   *
   * The rule is deliberately narrow: only ever look at index 0, and stop at the
   * first stroke that is not a bakeable departed-user stroke. That makes this a
   * strict global seq-ordered PREFIX drain — the one shape of bake that cannot
   * invert anything, because a prefix of a total order is the same prefix on
   * every client. Clients that hold different amounts drain different lengths
   * (prefixDelta > 0, which the oracle explicitly treats as benign) but never in
   * a different ORDER, which is the thing that is irreversible.
   *
   * Do NOT be tempted to skip past a blocked stroke to reach a departed one
   * behind it: that is exactly the out-of-order flatten this replaced, and it
   * would flatten a departed user's stroke underneath an active user's older
   * live stroke, permanently.
   *
   * An active user's strokes are never touched here, so their undo window is
   * untouched too — the normal `MAX_STROKES_PER_USER` path remains the only
   * thing that can make an active user's stroke permanent.
   *
   * @param {Object} group - Layer group
   * @param {string[]} safeModes - Blend modes that can be flattened losslessly
   * @private
   */
  _drainDepartedPrefix(group, safeModes) {
    if (this._drainableUsers.size === 0) return;

    while (group.strokeStack.length > 0) {
      const stroke = group.strokeStack[0];
      if (!this._drainableUsers.has(stroke.userId)) break;
      if (!this._canBakeStroke(group, stroke, safeModes)) break;

      this._bakeStrokeToBin(group, stroke);
      group.strokeStack.shift();
      this._advanceBakedWatermark(stroke.seq);

      const count = group.userStrokeCounts.get(stroke.userId) || 0;
      if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);
    }
  }

  /**
   * Whether the local user has a committed-but-not-yet-reconciled stroke in this
   * group. Such strokes carry no authoritative server seq, so the stack's global
   * order isn't final and baking must wait (see _bakeOverflowStrokes).
   *
   * Only relevant in a connected multiplayer session: offline/single-player and
   * replay never assign a seq, so there's nothing to wait for — bake normally.
   * @param {Object} group - Layer group
   * @returns {boolean}
   * @private
   */
  _hasUnconfirmedLocalStroke(group) {
    if (!this.board?.app?.connected) return false;
    if (this.eagerBakeUsers && this.eagerBakeUsers.size) return false;
    const localId = this.localUserId;
    if (localId == null) return false;
    for (const s of group.strokeStack) {
      if (s.userId === localId && !(s.seq > 0)) return true;
    }
    return false;
  }

  /**
   * Whether to hold the overflow bake because inbound commits are still queued.
   *
   * Guarded by a HARD CAP, which is the whole reason this is safe to do at all:
   * deferring unconditionally is what makes memory run away (measured at ~1.5 GB
   * per client with baking disabled outright), and a client that falls
   * permanently behind — a slow machine, a long background stall — would never
   * bake again. Past the cap we bake regardless and accept the divergence risk
   * for that client; an unbounded live stack is the worse failure.
   *
   * Offline and replay are unaffected: there is no socket, so the queue reads 0
   * and the eager-bake path behaves exactly as before.
   *
   * @param {Object} group
   * @returns {boolean}
   * @private
   */
  _shouldDeferBakeForInbound(group) {
    if (group.strokeStack.length >= LayerManager.BAKE_DEFER_STACK_CAP) return false;
    const wsClient = this.board?.app?.wsClient;
    if (!wsClient?.getInboundQueueLength) return false;
    return wsClient.getInboundQueueLength() > 0;
  }

  _anyEagerBakeable(group, eager) {
    if (!eager || eager.size === 0 || group.strokeStack.length === 0) return false;
    for (const s of group.strokeStack) {
      if (eager.has(s.userId)) return true;
    }
    return false;
  }

  /**
   * Find the end of a run of strokes with the same blend mode
   * @param {Array} strokeStack - Stroke stack
   * @param {number} startIdx - Start index
   * @returns {number} End index
   * @private
   */
  _findBlendModeRunEnd(strokeStack, startIdx) {
    const blendMode = strokeStack[startIdx].blendMode;
    let endIdx = startIdx;

    while (endIdx + 1 < strokeStack.length && strokeStack[endIdx + 1].blendMode === blendMode) {
      endIdx++;
    }

    return endIdx;
  }

  /**
   * Compress a run of strokes into a visual group
   * @param {Object} group - Layer group
   * @param {number} startIdx - Start index
   * @param {number} endIdx - End index
   * @private
   */
  _compressStrokesToGroup(group, startIdx, endIdx) {
    const strokes = group.strokeStack.splice(startIdx, endIdx - startIdx + 1);

    const compressedGroup = {
      type: 'group',
      blendMode: strokes[0].blendMode,
      strokes: strokes,
      timestamp: strokes[0].timestamp
    };

    group.bakedSequences.push(compressedGroup);

    for (const stroke of strokes) {
      const count = group.userStrokeCounts.get(stroke.userId) || 0;
      if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);
      this._advanceBakedWatermark(stroke.seq);
    }
  }

  /**
   * Advance the baked-seq watermark. Only confirmed (seq > 0) strokes move it;
   * baking already defers until local strokes are reconciled, so a baked stroke
   * normally carries an authoritative seq. Optimistic/replay strokes (seq 0/
   * undefined) leave the watermark untouched so it never claims to cover an
   * unconfirmed stroke.
   * @param {number} seq
   * @private
   */
  _advanceBakedWatermark(seq) {
    const s = Number(seq) || 0;
    if (s > this._bakedWatermarkSeq) this._bakedWatermarkSeq = s;
  }

  /**
   * Record a commit that produced no stroke record. See `_emptyCommitDiscards`.
   * @param {number} userId
   * @param {number} groupIdx
   * @param {string} reason
   * @private
   */
  _noteEmptyCommit(userId, groupIdx, reason) {
    this._emptyCommitDiscards++;
    if (this._emptyCommitSamples.length < 20) {
      this._emptyCommitSamples.push({ userId, groupIdx, reason, at: Date.now() });
    }
    if (typeof window !== 'undefined' && window.__TD_WARN_EMPTY_COMMITS) {
      console.warn(`[LayerManager] commit discarded (${reason}) user=${userId} layer=${groupIdx}`);
    }
  }

  /**
   * Highest baked seq on this client. Everything <= this is permanent here;
   * live (undoable) strokeStack entries are above it. Used to stamp the
   * checkpoint/join snapshot so the undoable tail is replayed as commands
   * rather than baked away. See getCheckpointSnapshotPixels (Board).
   * @returns {number}
   */
  getBakedWatermarkSeq() {
    return this._bakedWatermarkSeq;
  }

  /**
   * Cheap check (no pixel readback): would compositeBakedThroughSeq(groupIdx,
   * maxSeq) render nothing? True when the layer has no baked flat content and no
   * confirmed strokes at or below maxSeq — i.e. an unused layer. Lets a checkpoint
   * capture skip the expensive composite + full-frame getImageData for empty
   * layers, which is the common case since most boards only use layer 1.
   * @param {number} groupIdx
   * @param {number} maxSeq
   * @returns {boolean}
   */
  isLayerEmptyThroughSeq(groupIdx, maxSeq) {
    const group = this.layerGroups[groupIdx];
    if (!group) return true;
    // flatCanvas only exists once something has been baked into this layer.
    if (group.flatCanvas) return false;
    // _compressStrokesToGroup splices strokes OUT of strokeStack into
    // bakedSequences without creating a flatCanvas, so a fully-compressed layer
    // looks empty by the two checks above while holding real ink — and layers
    // 1-2 are exactly where compressed runs accumulate. compositeBakedThroughSeq
    // renders bakedSequences unconditionally (only strokeStack is seq-filtered),
    // so count them the same way: baking flattens a seq-ordered prefix, so
    // anything in here is already at or below the watermark maxSeq is taken from.
    if (group.bakedSequences.length > 0) return false;
    return !group.strokeStack.some((s) => (s.seq || 0) > 0 && s.seq <= maxSeq);
  }

  /**
   * Check if any user has exceeded the max strokes limit
   * @param {Object} group - Layer group
   * @param {number} max - Max strokes
   * @returns {boolean}
   * @private
   */
  _anyUserOverMax(group, max) {
    const safeModes = ['source-over', 'destination-out', 'multiply', 'darken', 'lighten', 'screen'];
    const countsByUser = new Map();

    for (const stroke of group.strokeStack) {
      if (this._canBakeStroke(group, stroke, safeModes)) {
        const count = countsByUser.get(stroke.userId) || 0;
        countsByUser.set(stroke.userId, count + 1);
      }
    }

    for (const count of countsByUser.values()) {
      if (count > max) return true;
    }

    return false;
  }

  /**
   * Returns whether a stroke can be baked into a group's persistent base.
   * Flat-canvas groups are the authoritative raster base for layer 0, so they
   * may resolve every blend mode into pixels. Other layers keep the conservative
   * safe-mode list because their bakedSequences retain blend operations rather
   * than a single flat pixel base.
   * @param {Object} group
   * @param {Object} stroke
   * @param {string[]} safeModes
   * @returns {boolean}
   * @private
   */
  _canBakeStroke(group, stroke, safeModes) {
    if (group?.flatCanvas) return true;
    return safeModes.includes(stroke.blendMode);
  }

  /** @deprecated Use _bakeStrokeToBin */
  _bakeStrokeToBase(group, stroke) {
    this._bakeStrokeToBin(group, stroke);
  }

  /**
   * Bake a single stroke into a sequence bin
   * @param {Object} group - Layer group
   * @param {Object} stroke - Stroke record
   * @private
   */
  _bakeStrokeToBin(group, stroke) {
    // Handle blur filter strokes specially - resolve to actual pixels
    if (stroke.filterType === 'blur' || stroke.filterType === 'glitchBlur') {
      this._bakeBlurStroke(group, stroke);
      return;
    }

    if (group.flatCanvas) {
      if (!Array.isArray(group.flatStrokeRecords)) {
        group.flatStrokeRecords = [];
      }
      group.flatStrokeRecords.push(stroke);
      if (stroke.blendMode !== 'source-over' && stroke.blendMode !== 'destination-out') {
        this._bakeFlatComplexBlendStroke(group, stroke);
        return;
      }
      group.flatCtx.globalCompositeOperation = stroke.blendMode;
      group.flatCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
      group.flatCtx.globalCompositeOperation = 'source-over';
      return;
    }

    const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];

    let targetBin;
    if (lastSeq && lastSeq.canvas && lastSeq.ctx && lastSeq.blendMode === stroke.blendMode) {
      targetBin = lastSeq;
    } else {
      targetBin = this._createCanvas();
      targetBin.blendMode = stroke.blendMode;
      targetBin.strokes = [];
      group.bakedSequences.push(targetBin);
    }

    if (!Array.isArray(targetBin.strokes)) {
      targetBin.strokes = [];
    }
    targetBin.strokes.push(stroke);

    targetBin.ctx.globalCompositeOperation = (stroke.blendMode === 'destination-out')
      ? 'source-over'
      : stroke.blendMode;

    targetBin.ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
  }

  _bakeFlatComplexBlendStroke(group, stroke) {
    const x = Math.max(0, Math.floor(stroke.x ?? 0));
    const y = Math.max(0, Math.floor(stroke.y ?? 0));
    const width = Math.max(0, Math.min(this.width - x, Math.ceil(stroke.width ?? stroke.canvas?.width ?? 0)));
    const height = Math.max(0, Math.min(this.height - y, Math.ceil(stroke.height ?? stroke.canvas?.height ?? 0)));
    if (width <= 0 || height <= 0) return;
    const strokeIsFullCanvas = stroke.canvas?.width === this.width && stroke.canvas?.height === this.height;
    const sourceX = strokeIsFullCanvas ? x : 0;
    const sourceY = strokeIsFullCanvas ? y : 0;

    const beforeCanvas = document.createElement('canvas');
    beforeCanvas.width = width;
    beforeCanvas.height = height;
    const beforeCtx = beforeCanvas.getContext('2d');

    const blendedCanvas = document.createElement('canvas');
    blendedCanvas.width = width;
    blendedCanvas.height = height;
    const blendedCtx = blendedCanvas.getContext('2d');

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext('2d');

    const useBackground = stroke.blendBakeMode === 'background';
    if (useBackground) {
      const [r, g, b, a] = this.backgroundColor;
      beforeCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      beforeCtx.fillRect(0, 0, width, height);
    }
    beforeCtx.drawImage(group.flatCanvas, x, y, width, height, 0, 0, width, height);

    blendedCtx.drawImage(beforeCanvas, 0, 0);
    blendedCtx.globalCompositeOperation = stroke.blendMode;
    blendedCtx.drawImage(stroke.canvas, sourceX, sourceY, width, height, 0, 0, width, height);
    blendedCtx.globalCompositeOperation = 'source-over';

    if (useBackground) {
      maskCtx.drawImage(stroke.canvas, sourceX, sourceY, width, height, 0, 0, width, height);
      const outCanvas = this._extractOpaqueStrokeFootprintFromComposite(blendedCanvas, maskCanvas);
      group.flatCtx.globalCompositeOperation = 'source-over';
      group.flatCtx.drawImage(outCanvas, x, y);
      return;
    } else {
      maskCtx.drawImage(group.flatCanvas, x, y, width, height, 0, 0, width, height);
      maskCtx.globalCompositeOperation = 'destination-in';
      maskCtx.drawImage(stroke.canvas, sourceX, sourceY, width, height, 0, 0, width, height);
      maskCtx.globalCompositeOperation = 'source-over';
    }

    const outCanvas = this._extractSourceOverPatchFromComposite(blendedCanvas, beforeCanvas, maskCanvas);
    group.flatCtx.globalCompositeOperation = 'source-over';
    group.flatCtx.drawImage(outCanvas, x, y);
  }

  _extractOpaqueStrokeFootprintFromComposite(blendedCanvas, maskCanvas) {
    const width = blendedCanvas.width;
    const height = blendedCanvas.height;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d');

    const blended = blendedCanvas.getContext('2d').getImageData(0, 0, width, height);
    const mask = maskCanvas.getContext('2d').getImageData(0, 0, width, height);
    const out = outCtx.createImageData(width, height);

    for (let i = 0; i < out.data.length; i += 4) {
      if (mask.data[i + 3] <= 0) continue;

      out.data[i] = blended.data[i];
      out.data[i + 1] = blended.data[i + 1];
      out.data[i + 2] = blended.data[i + 2];
      out.data[i + 3] = 255;
    }

    outCtx.putImageData(out, 0, 0);
    return outCanvas;
  }

  _extractSourceOverPatchFromComposite(blendedCanvas, beforeCanvas, maskCanvas) {
    const width = blendedCanvas.width;
    const height = blendedCanvas.height;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d');

    const blended = blendedCanvas.getContext('2d').getImageData(0, 0, width, height);
    const before = beforeCanvas.getContext('2d').getImageData(0, 0, width, height);
    const mask = maskCanvas.getContext('2d').getImageData(0, 0, width, height);
    const out = outCtx.createImageData(width, height);

    for (let i = 0; i < out.data.length; i += 4) {
      const alpha = mask.data[i + 3] / 255;
      if (alpha <= 0) continue;

      out.data[i] = Math.max(0, Math.min(255, Math.round((blended.data[i] - before.data[i] * (1 - alpha)) / alpha)));
      out.data[i + 1] = Math.max(0, Math.min(255, Math.round((blended.data[i + 1] - before.data[i + 1] * (1 - alpha)) / alpha)));
      out.data[i + 2] = Math.max(0, Math.min(255, Math.round((blended.data[i + 2] - before.data[i + 2] * (1 - alpha)) / alpha)));
      out.data[i + 3] = Math.round(alpha * 255);
    }

    outCtx.putImageData(out, 0, 0);
    return outCanvas;
  }

  /**
   * Bake a blur filter stroke by resolving it into actual blurred pixels.
   * Uses the cached HQ result if available, otherwise falls back to CSS filter.
   * @param {Object} group - Layer group
   * @param {Object} stroke - Blur filter stroke record
   * @private
   */
  _bakeBlurStroke(group, stroke) {
    const { maskCanvas, blurRadius, x, y, width, height } = stroke;
    if (!maskCanvas || !blurRadius || width <= 0 || height <= 0) return;

    // If we have a cached high-quality blur result, use it directly
    if (stroke._cachedBlurResult) {
      if (group.flatCanvas) {
        group.flatCtx.globalCompositeOperation = 'source-over';
        group.flatCtx.drawImage(stroke._cachedBlurResult, x, y);
        this._drawMirroredGlitchCopies(group.flatCtx, stroke, stroke._cachedBlurResult, x, y);
        return;
      }
      const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];
      let targetBin;
      if (lastSeq && lastSeq.canvas && lastSeq.ctx && lastSeq.blendMode === 'source-over') {
        targetBin = lastSeq;
      } else {
        targetBin = this._createCanvas();
        targetBin.blendMode = 'source-over';
        group.bakedSequences.push(targetBin);
      }
      targetBin.ctx.drawImage(stroke._cachedBlurResult, x, y);
      this._drawMirroredGlitchCopies(targetBin.ctx, stroke, stroke._cachedBlurResult, x, y);
      return;
    }

    // No cached result - resolve synchronously
    // Build the source image from current baked state
    let sourceCanvas;
    if (group.flatCanvas) {
      sourceCanvas = group.flatCanvas;
    } else {
      // Composite all baked sequences into a temp canvas to get current state
      const temp = document.createElement('canvas');
      temp.width = this.width;
      temp.height = this.height;
      const tCtx = temp.getContext('2d');
      for (const seq of group.bakedSequences) {
        if (seq.type === 'group') {
          for (const s of seq.strokes) {
            tCtx.globalCompositeOperation = s.blendMode || 'source-over';
            tCtx.drawImage(s.canvas, s.x || 0, s.y || 0);
          }
        } else {
          tCtx.globalCompositeOperation = seq.blendMode || 'source-over';
          tCtx.drawImage(seq.canvas, 0, 0);
        }
      }
      sourceCanvas = temp;
    }

    // Crop region with margin for blur bleed
    const margin = Math.ceil(blurRadius);
    const cropX = Math.max(0, x - margin);
    const cropY = Math.max(0, y - margin);
    const cropW = Math.min(this.width - cropX, width + margin * 2);
    const cropH = Math.min(this.height - cropY, height + margin * 2);
    if (cropW <= 0 || cropH <= 0) return;

    const blurred = document.createElement('canvas');
    blurred.width = cropW;
    blurred.height = cropH;
    const bCtx = blurred.getContext('2d');

    // Apply stackblur to the source region
    bCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    const stackblur = getStackblurSync();
    if (stackblur) {
      const imageData = bCtx.getImageData(0, 0, cropW, cropH);
      stackblur(imageData.data, cropW, cropH, blurRadius);
      bCtx.putImageData(imageData, 0, 0);
    }

    // Mask with the blur mask to only keep blurred areas where user painted
    bCtx.globalCompositeOperation = 'destination-in';
    bCtx.drawImage(maskCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    // Draw resolved blur pixels into the baked state
    if (group.flatCanvas) {
      group.flatCtx.globalCompositeOperation = 'source-over';
      group.flatCtx.drawImage(blurred, cropX, cropY);
      this._drawMirroredGlitchCopies(group.flatCtx, stroke, blurred, cropX, cropY);
    } else {
      const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];
      let targetBin;
      if (lastSeq && lastSeq.canvas && lastSeq.ctx && lastSeq.blendMode === 'source-over') {
        targetBin = lastSeq;
      } else {
        targetBin = this._createCanvas();
        targetBin.blendMode = 'source-over';
        group.bakedSequences.push(targetBin);
      }
      targetBin.ctx.drawImage(blurred, cropX, cropY);
      this._drawMirroredGlitchCopies(targetBin.ctx, stroke, blurred, cropX, cropY);
    }
  }

  /**
   * Add image content directly to baked sequences
   * @param {number} groupIdx - Layer index
   * @param {HTMLCanvasElement} canvas - Content canvas
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {string} [blendMode='source-over'] - Blend mode
   */
  addToBaseBin(groupIdx, canvas, x, y, blendMode = 'source-over') {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    if (group.flatCanvas) {
      group.flatCtx.globalCompositeOperation = blendMode;
      group.flatCtx.drawImage(canvas, x, y);
      group.flatCtx.globalCompositeOperation = 'source-over';
      this.needsComposite = true;
      return;
    }

    const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];
    let targetSeq;
    if (lastSeq && lastSeq.blendMode === blendMode) {
      targetSeq = lastSeq;
    } else {
      targetSeq = this._createCanvas();
      targetSeq.blendMode = blendMode;
      group.bakedSequences.push(targetSeq);
    }

    targetSeq.ctx.globalCompositeOperation = 'source-over';
    targetSeq.ctx.drawImage(canvas, x, y);
    this.needsComposite = true;
  }

  /**
   * Apply an eraser operation to all baked sequences in a layer group
   * @param {number} groupIdx - Layer index
   * @param {HTMLCanvasElement} eraserCanvas - Eraser mask canvas
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {Array} [lassoPath=null] - Optional lasso path
   */
  eraseFromAllBaseBins(groupIdx, eraserCanvas, x, y, lassoPath = null) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    if (group.flatCanvas) {
      group.flatCtx.globalCompositeOperation = 'destination-out';
      if (lassoPath && lassoPath.length >= 3) {
        group.flatCtx.beginPath();
        group.flatCtx.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) {
          group.flatCtx.lineTo(lassoPath[i].x, lassoPath[i].y);
        }
        group.flatCtx.closePath();
        group.flatCtx.fill();
      } else {
        group.flatCtx.drawImage(eraserCanvas, x, y);
      }
      group.flatCtx.globalCompositeOperation = 'source-over';
      this.needsComposite = true;
      return;
    }

    for (const seq of group.bakedSequences) {
      seq.ctx.globalCompositeOperation = 'destination-out';
      if (lassoPath && lassoPath.length >= 3) {
        seq.ctx.beginPath();
        seq.ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) {
          seq.ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
        }
        seq.ctx.closePath();
        seq.ctx.fill();
      } else {
        seq.ctx.drawImage(eraserCanvas, x, y);
      }
      seq.ctx.globalCompositeOperation = 'source-over';
    }
    this.cleanupEmptyBins(groupIdx);
    this.needsComposite = true;
  }

  /**
   * Remove empty sequences from a specific layer group.
   * Uses the worker for async pixel scanning when available.
   * @param {number} groupIdx - Layer index
   */
  cleanupEmptyBins(groupIdx) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const hasEraserInHistory = this._hasEraserInHistory(group);
    if (hasEraserInHistory) return;

    if (this._pixelsWorker && group.bakedSequences.length > 0) {
      this._cleanupEmptyBinsAsync(group);
    } else {
      group.bakedSequences = group.bakedSequences.filter(seq => this._hasContent(seq.canvas));
    }
  }

  /**
   * Async cleanup that offloads _hasContent checks to the worker.
   * @param {Object} group - Layer group
   * @private
   */
  async _cleanupEmptyBinsAsync(group) {
    const sequences = group.bakedSequences;
    const checks = sequences.map(seq => {
      const ctx = seq.canvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, seq.canvas.width, seq.canvas.height);
      return this._pixelsWorker.hasContent(imageData.data);
    });

    try {
      const results = await Promise.all(checks);
      // Filter out empty sequences — only if the group hasn't been modified while waiting
      group.bakedSequences = sequences.filter((_, i) => results[i]);
      this.needsComposite = true;
      if (this.onNeedsUpdate) this.onNeedsUpdate();
    } catch (err) {
      // Worker failed — fall back to sync
      group.bakedSequences = sequences.filter(seq => this._hasContent(seq.canvas));
    }
  }

  /**
   * Remove empty sequences from all layer groups
   */
  cleanupEmptySequencesAll() {
    for (let i = 0; i < this.layerGroups.length; i++) {
      this.cleanupEmptyBins(i);
    }
  }

  /**
   * Check if there are any eraser operations in undo/redo history
   * @param {Object} group - Layer group
   * @returns {boolean}
   * @private
   */
  _hasEraserInHistory(group) {
    if (group.strokeStack.some(s => s.blendMode === 'destination-out')) {
      return true;
    }

    for (const batches of this.redoStackByUser.values()) {
      for (const batch of batches) {
        for (const { record } of batch) {
          if (record.blendMode === 'destination-out') {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if canvas has any non-transparent pixels
   * @param {HTMLCanvasElement} canvas - Canvas to check
   * @returns {boolean}
   * @private
   */
  _hasContent(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  /**
   * Apply a clip region from dirty rects to a context.
   * @param {CanvasRenderingContext2D} ctx - Context to clip
   * @param {Array} dirtyRects - Array of {x, y, width, height}
   * @private
   */
  _applyDirtyClip(ctx, dirtyRects) {
    ctx.save();
    ctx.beginPath();
    for (const r of dirtyRects) {
      ctx.rect(r.x, r.y, r.width, r.height);
    }
    ctx.clip();
  }

  /**
   * Clear only the dirty regions of a context.
   * @param {CanvasRenderingContext2D} ctx - Context to clear
   * @param {Array|null} dirtyRects - Array of {x, y, width, height}, or null for full clear
   * @private
   */
  _clearDirtyRegion(ctx, dirtyRects) {
    if (dirtyRects) {
      for (const r of dirtyRects) {
        ctx.clearRect(r.x, r.y, r.width, r.height);
      }
    } else {
      ctx.clearRect(0, 0, this.width, this.height);
    }
  }

  _fillDirtyRegion(ctx, dirtyRects) {
    if (dirtyRects) {
      for (const r of dirtyRects) {
        ctx.fillRect(r.x, r.y, r.width, r.height);
      }
      return;
    }
    ctx.fillRect(0, 0, this.width, this.height);
  }

  _drawCanvasRegion(ctx, canvas, dirtyRects = null, dx = 0, dy = 0) {
    if (!ctx || !canvas) return;
    if (!dirtyRects || dirtyRects.length === 0) {
      ctx.drawImage(canvas, dx, dy);
      return;
    }

    for (const rect of dirtyRects) {
      const left = Math.max(rect.x, dx);
      const top = Math.max(rect.y, dy);
      const right = Math.min(rect.x + rect.width, dx + canvas.width);
      const bottom = Math.min(rect.y + rect.height, dy + canvas.height);
      if (right <= left || bottom <= top) continue;

      const sx = left - dx;
      const sy = top - dy;
      const width = right - left;
      const height = bottom - top;
      ctx.drawImage(canvas, sx, sy, width, height, left, top, width, height);
    }
  }

  /**
   * Expand a dirty rectangle to include new bounds
   * @param {Object} dirtyRect - {minX, minY, maxX, maxY}
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   * @private
   */
  _expandDirtyRect(dirtyRect, x, y, width, height) {
    if (dirtyRect.maxX === -1) {
      dirtyRect.minX = x;
      dirtyRect.minY = y;
      dirtyRect.maxX = x + width - 1;
      dirtyRect.maxY = y + height - 1;
    } else {
      dirtyRect.minX = Math.min(dirtyRect.minX, x);
      dirtyRect.minY = Math.min(dirtyRect.minY, y);
      dirtyRect.maxX = Math.max(dirtyRect.maxX, x + width - 1);
      dirtyRect.maxY = Math.max(dirtyRect.maxY, y + height - 1);
    }
  }

  /**
   * Scans ImageData for content within its bounds
   * @param {ImageData} imageData - ImageData to scan
   * @returns {Object|null} {x, y, width, height}
   * @private
   */
  _scanImageDataForContent(imageData) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Full-canvas scan for content bounds (sync fallback).
   * @param {HTMLCanvasElement} canvas - Canvas to scan
   * @returns {Object|null} {x, y, width, height}
   * @private
   */
  _findContentBoundsLegacy(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return this._scanImageDataForContent(imageData);
  }

  /**
   * Async content bounds scan via the pixels worker.
   * @param {HTMLCanvasElement} canvas - Canvas to scan
   * @returns {Promise<{x: number, y: number, width: number, height: number}|null>}
   * @private
   */
  _findContentBoundsAsync(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return this._pixelsWorker.findContentBounds(imageData.data, canvas.width, canvas.height);
  }

  /**
   * Optimized content bounds finder using dirty rect tracking
   * @param {HTMLCanvasElement} canvas - Canvas to scan
   * @param {Object} [dirtyRect] - Optional dirty rect
   * @returns {Object|null} {x, y, width, height}
   * @private
   */
  _findContentBounds(canvas, dirtyRect = null) {
    if (dirtyRect && dirtyRect.maxX !== -1) {
      const dr = dirtyRect;
      const ctx = canvas.getContext('2d');
      
      const scanX = Math.max(0, dr.minX);
      const scanY = Math.max(0, dr.minY);
      const scanW = Math.min(canvas.width - scanX, dr.maxX - scanX + 1);
      const scanH = Math.min(canvas.height - scanY, dr.maxY - scanY + 1);

      if (scanW <= 0 || scanH <= 0) {
        console.warn('[LayerManager] Invalid dirtyRect detected, falling back to legacy scan:', dr);
        return this._findContentBoundsLegacy(canvas);
      }

      const imageData = ctx.getImageData(scanX, scanY, scanW, scanH);
      const contentInDirtyRect = this._scanImageDataForContent(imageData);

      if (!contentInDirtyRect) return null;

      return {
        x: scanX + contentInDirtyRect.x,
        y: scanY + contentInDirtyRect.y,
        width: contentInDirtyRect.width,
        height: contentInDirtyRect.height
      };
    } else {
      return this._findContentBoundsLegacy(canvas);
    }
  }

  /**
   * Check if group has any destination-out strokes
   * @param {Object} group - Layer group
   * @returns {boolean}
   * @private
   */
  _groupHasDestOut(group) {
    if (group.bakedSequences.some(seq => seq.blendMode === 'destination-out')) return true;
    if (group.strokeStack.some(s => s.blendMode === 'destination-out')) return true;
    for (const [, active] of group.activeStrokeByUser) {
      if (active.blendMode === 'destination-out') return true;
    }
    for (const [, preview] of group.activePreviewByUser || []) {
      if (preview.blendMode === 'destination-out') return true;
    }
    return false;
  }

  /**
   * Check if group has complex blend modes
   * @param {Object} group - Layer group
   * @returns {boolean}
   * @private
   */
  _groupHasComplexBlendModes(group) {
    const simpleBlendModes = ['source-over', 'destination-out'];

    for (const seq of group.bakedSequences) {
      if (seq.type === 'group') {
        for (const stroke of seq.strokes) {
          if (!simpleBlendModes.includes(stroke.blendMode)) return true;
        }
      } else {
        if (!simpleBlendModes.includes(seq.blendMode)) return true;
      }
    }

    for (const stroke of group.strokeStack) {
      if (!simpleBlendModes.includes(stroke.blendMode)) return true;
    }

    for (const [, active] of group.activeStrokeByUser) {
      if (!simpleBlendModes.includes(active.blendMode)) return true;
    }

    for (const [, preview] of group.activePreviewByUser || []) {
      if (!simpleBlendModes.includes(preview.blendMode)) return true;
    }

    return false;
  }

  /**
   * Check if range of layers has blend mode strokes
   * @param {number} startIdx - Start index
   * @param {number} endIdx - End index
   * @returns {boolean}
   */
  rangeHasBlendModeStrokes(startIdx, endIdx) {
    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible) continue;

      for (const seq of group.bakedSequences) {
        if (seq.blendMode !== 'source-over') return true;
      }

      for (const stroke of group.strokeStack) {
        if (stroke.blendMode !== 'source-over') return true;
      }

      for (const [, active] of group.activeStrokeByUser) {
        if (active.blendMode !== 'source-over') return true;
      }

      for (const [, preview] of group.activePreviewByUser || []) {
        if (preview.blendMode !== 'source-over') return true;
      }
    }
    return false;
  }

  /**
   * Composite all strokes for a single group into a context
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupInto(ctx, group, dirtyRects = null) {
    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStroke(ctx, stroke, false, dirtyRects);
        }
      } else {
        this._compositeStroke(ctx, item, false, dirtyRects);
      }
    }

    for (const stroke of group.strokeStack) {
      this._compositeStroke(ctx, stroke, false, dirtyRects);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStroke(ctx, active, true, dirtyRects);
    }

    for (const [, preview] of group.activePreviewByUser || []) {
      this._compositeStroke(ctx, preview, true, dirtyRects);
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Composite a single stroke, handling both regular and filter strokes
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {Object} stroke - Stroke object
   * @param {boolean} [isActive=false] - Whether this is an active (in-progress) stroke
   * @private
   */
  _compositeStroke(ctx, stroke, isActive = false, dirtyRects = null) {
    if (stroke.filterType === 'blur' || stroke.filterType === 'glitchBlur') {
      this._applyBlurFilter(ctx, stroke, isActive);
    } else {
      ctx.globalCompositeOperation = stroke.blendMode;
      this._drawCanvasRegion(ctx, stroke.canvas, dirtyRects, stroke.x ?? 0, stroke.y ?? 0);
    }
  }

  _applyBlurFilter(ctx, filterStroke, isActive) {
    const { maskCanvas, blurRadius, x, y, width, height } = filterStroke;
    if (!maskCanvas || !blurRadius) return;
    const preferStableReplayBlur = this.useStableReplayBlur === true && filterStroke.filterType === 'blur';

    // Helper to render the fast preview
    const renderFastPreview = () => {
      // Use dirtyRect for active strokes and cropBounds for committed ones
      const bounds = isActive ? filterStroke.dirtyRect : { minX: x, minY: y, maxX: x + width, maxY: y + height };
      if (!bounds || bounds.maxX === -1) return;

      const previewBlurRadius = blurRadius * 0.5; // Correction factor
      const margin = Math.ceil(previewBlurRadius * 2);

      const cropX = Math.max(0, bounds.minX - margin);
      const cropY = Math.max(0, bounds.minY - margin);
      const cropW = Math.min(this.width - cropX, (bounds.maxX - bounds.minX) + margin * 2);
      const cropH = Math.min(this.height - cropY, (bounds.maxY - bounds.minY) + margin * 2);

      if (cropW <= 0 || cropH <= 0) return;

      const temp = document.createElement('canvas');
      temp.width = cropW;
      temp.height = cropH;
      const tCtx = temp.getContext('2d');

      tCtx.filter = `blur(${previewBlurRadius}px)`;
      tCtx.drawImage(ctx.canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      tCtx.filter = 'none';

      tCtx.globalCompositeOperation = 'destination-in';
      tCtx.drawImage(maskCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(temp, cropX, cropY);
      this._drawMirroredGlitchCopies(ctx, filterStroke, temp, cropX, cropY);
      ctx.restore();
    };

    // If it's an active stroke, just show the preview.
    if (isActive) {
      renderFastPreview();
      return;
    }

    // --- Logic for COMMITTED strokes ---

    // If the high-quality version is ready, draw it and we're done.
    if (filterStroke._cachedBlurResult) {
      ctx.save();
      ctx.globalCompositeOperation = filterStroke.blendMode || 'source-over';
      ctx.drawImage(filterStroke._cachedBlurResult, x, y);
      this._drawMirroredGlitchCopies(ctx, filterStroke, filterStroke._cachedBlurResult, x, y);
      ctx.restore();
      return;
    }

    // If we already have a cached preview, use it instead of re-rendering.
    if (filterStroke._cachedPreview) {
      ctx.save();
      ctx.globalCompositeOperation = filterStroke.blendMode || 'source-over';
      ctx.drawImage(filterStroke._cachedPreview, x, y);
      this._drawMirroredGlitchCopies(ctx, filterStroke, filterStroke._cachedPreview, x, y);
      ctx.restore();
      return;
    }

    if (preferStableReplayBlur) {
      const stableCanvas = document.createElement('canvas');
      stableCanvas.width = width;
      stableCanvas.height = height;
      const stableCtx = stableCanvas.getContext('2d');

      const stableBlurRadius = blurRadius * 0.5;
      const margin = Math.ceil(stableBlurRadius * 2);
      const cropX = Math.max(0, x - margin);
      const cropY = Math.max(0, y - margin);
      const cropW = Math.min(this.width - cropX, width + margin * 2);
      const cropH = Math.min(this.height - cropY, height + margin * 2);

      if (cropW > 0 && cropH > 0) {
        stableCtx.filter = `blur(${stableBlurRadius}px)`;
        stableCtx.drawImage(ctx.canvas, cropX, cropY, cropW, cropH, cropX - x, cropY - y, cropW, cropH);
        stableCtx.filter = 'none';
        stableCtx.globalCompositeOperation = 'destination-in';
        stableCtx.drawImage(maskCanvas, x, y, width, height, 0, 0, width, height);

        filterStroke._cachedBlurResult = stableCanvas;

        ctx.save();
        ctx.globalCompositeOperation = filterStroke.blendMode || 'source-over';
        ctx.drawImage(stableCanvas, x, y);
        this._drawMirroredGlitchCopies(ctx, filterStroke, stableCanvas, x, y);
        ctx.restore();
      }
      return;
    }

    // If the high-quality calc hasn't started, kick it off now.
    if (!filterStroke._isBlurring) {
      filterStroke._isBlurring = true;

      const cropX = x;
      const cropY = y;
      const cropW = width;
      const cropH = height;

      const useGlitch = filterStroke.filterType === 'glitchBlur';
      const isRemoteGlitch = useGlitch && this.localUserId != null && filterStroke.userId !== this.localUserId;

      // For remote users' glitch blur strokes, skip WASM — we'll receive the
      // pre-computed result via GLITCH_RESULT message from the drawing user.
      if (isRemoteGlitch) {
        filterStroke._awaitingRemoteResult = true;
        // Fall through to render a fast CSS preview below
      } else {
        const tempForAsync = document.createElement('canvas');
        tempForAsync.width = cropW;
        tempForAsync.height = cropH;
        const tCtxForAsync = tempForAsync.getContext('2d');
        tCtxForAsync.drawImage(ctx.canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        const imageData = tCtxForAsync.getImageData(0, 0, cropW, cropH);

        if (!this._pixelsWorker) {
          this._pixelsWorker = new PixelsWorkerClient();
        }

        // Offload blur to the pixels worker (runs stackblur off the main thread)
        this._pixelsWorker.blur(imageData.data, cropW, cropH, blurRadius, useGlitch).then(blurredData => {
          tCtxForAsync.putImageData(new ImageData(new Uint8ClampedArray(blurredData.buffer), cropW, cropH), 0, 0);

          const composite = document.createElement('canvas');
          composite.width = cropW;
          composite.height = cropH;
          const cCtx = composite.getContext('2d');

          cCtx.drawImage(maskCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
          cCtx.globalCompositeOperation = 'source-in';
          cCtx.drawImage(tempForAsync, 0, 0);

          filterStroke._cachedBlurResult = composite;
          delete filterStroke._cachedPreview; // Clear preview once HQ is ready
          this.needsComposite = true;
          if (this.onNeedsUpdate) this.onNeedsUpdate();

          // For local user's glitch blur, broadcast the result to other clients
          if (useGlitch && this.onGlitchBlurReady) {
            this.onGlitchBlurReady({
              userId: filterStroke.userId,
              x: cropX,
              y: cropY,
              width: cropW,
              height: cropH,
              canvas: composite
            });
          }
        }).catch((err) => {
          // Fallback to main-thread blur if worker fails
          console.warn('[LayerManager] Blur worker failed, using fallback:', err?.message || err, useGlitch ? '(glitch)' : '(normal)');
          // Re-read imageData since the original buffer was transferred to the worker
          const fallbackImageData = tCtxForAsync.getImageData(0, 0, cropW, cropH);
          blurImageData(fallbackImageData, cropW, cropH, blurRadius).then(blurred => {
            tCtxForAsync.putImageData(blurred, 0, 0);

            const composite = document.createElement('canvas');
            composite.width = cropW;
            composite.height = cropH;
            const cCtx = composite.getContext('2d');

            cCtx.drawImage(maskCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            cCtx.globalCompositeOperation = 'source-in';
            cCtx.drawImage(tempForAsync, 0, 0);

            filterStroke._cachedBlurResult = composite;
            delete filterStroke._cachedPreview; // Clear preview once HQ is ready
            this.needsComposite = true;
            if (this.onNeedsUpdate) this.onNeedsUpdate();

            // Fallback path also broadcasts for local glitch blur
            if (useGlitch && this.onGlitchBlurReady) {
              this.onGlitchBlurReady({
                userId: filterStroke.userId,
                x: cropX,
                y: cropY,
                width: cropW,
                height: cropH,
                canvas: composite
              });
            }
          });
        });
      }

      // Render the fast preview ONCE and cache it
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = width;
      previewCanvas.height = height;
      const pCtx = previewCanvas.getContext('2d');

      const previewBlurRadius = blurRadius * 0.5;
      const margin = Math.ceil(previewBlurRadius * 2);
      const pCropX = Math.max(0, x - margin);
      const pCropY = Math.max(0, y - margin);
      const pCropW = Math.min(this.width - pCropX, width + margin * 2);
      const pCropH = Math.min(this.height - pCropY, height + margin * 2);

      if (pCropW > 0 && pCropH > 0) {
        pCtx.filter = `blur(${previewBlurRadius}px)`;
        pCtx.drawImage(ctx.canvas, pCropX, pCropY, pCropW, pCropH, pCropX - x, pCropY - y, pCropW, pCropH);
        pCtx.filter = 'none';

        pCtx.globalCompositeOperation = 'destination-in';
        pCtx.drawImage(maskCanvas, x, y, width, height, 0, 0, width, height);

        filterStroke._cachedPreview = previewCanvas;
        ctx.drawImage(previewCanvas, x, y);
      }
    }
  }

  /**
   * Apply a remotely-computed glitch blur result image to the most recent
   * glitchBlur stroke for the given user. Called when a GLITCH_RESULT message
   * is received from the network.
   *
   * Handles a race condition where GLITCH_RESULT (unbatched) can arrive before
   * MU (batched every 16ms), meaning the stroke may not exist yet. In that
   * case the result is buffered in _pendingGlitchResults and applied when the
   * stroke is committed via commitUserStroke.
   *
   * @param {number} userId - The remote user who drew the glitch blur
   * @param {HTMLCanvasElement|HTMLImageElement} resultImage - The pre-computed blur result
   * @param {{x: number, y: number, width: number, height: number}} bounds - Sender's crop bounds
   */
  applyRemoteGlitchResult(userId, resultImage, bounds) {
    const group = this.layerGroups[0];
    if (!group) {
      this._bufferGlitchResult(userId, resultImage, bounds);
      return;
    }

    // Find the most recent glitchBlur stroke for this user that hasn't
    // received its result yet (either awaiting or not yet composited).
    for (let i = group.strokeStack.length - 1; i >= 0; i--) {
      const stroke = group.strokeStack[i];
      if (stroke.userId == userId && stroke.filterType === 'glitchBlur' && !stroke._cachedBlurResult) {
        this._applyGlitchResultToStroke(stroke, resultImage, bounds);
        return;
      }
    }

    // Stroke not committed yet — buffer the result for when it arrives
    this._bufferGlitchResult(userId, resultImage, bounds);
  }

  /** @private */
  _bufferGlitchResult(userId, resultImage, bounds) {
    if (!this._pendingGlitchResults) this._pendingGlitchResults = new Map();
    const pending = this._pendingGlitchResults.get(userId) || [];
    pending.push({ resultImage, bounds });
    this._pendingGlitchResults.set(userId, pending);
  }

  /** @private */
  _applyGlitchResultToStroke(stroke, resultImage, bounds) {
    stroke._cachedBlurResult = resultImage;
    stroke._isBlurring = true; // Prevent WASM from kicking off
    stroke._awaitingRemoteResult = false;
    delete stroke._cachedPreview;
    // Override position/size with the sender's crop bounds so the image
    // is drawn at the correct location (remote mask stamps may differ).
    if (bounds) {
      stroke.x = bounds.x;
      stroke.y = bounds.y;
      stroke.width = bounds.width;
      stroke.height = bounds.height;
    }
    this.needsComposite = true;
    if (this.onNeedsUpdate) this.onNeedsUpdate();
  }

  /**
   * Check for and apply any buffered glitch blur results for a newly committed stroke.
   * @param {Object} stroke - The just-committed stroke record
   * @private
   */
  _consumePendingGlitchResult(stroke) {
    if (!this._pendingGlitchResults || stroke.filterType !== 'glitchBlur') return;
    const pending = this._pendingGlitchResults.get(stroke.userId);
    if (pending && pending.length > 0) {
      const { resultImage, bounds } = pending.shift();
      if (pending.length === 0) this._pendingGlitchResults.delete(stroke.userId);
      this._applyGlitchResultToStroke(stroke, resultImage, bounds);
    }
  }

  _drawMirroredGlitchCopies(ctx, stroke, sourceCanvas, x, y) {
    if (!ctx || !sourceCanvas || stroke?.filterType !== 'glitchBlur' || !this.board) return;
    const mirrorRegions = Array.isArray(stroke.mirrorRegions) ? stroke.mirrorRegions : [];
    for (const region of mirrorRegions) {
      this.board.drawMirroredCanvas(ctx, sourceCanvas, region, x, y);
    }
  }

  /**
   * Composite a range of layer groups onto a target context
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {number} startIdx - Start index
   * @param {number} endIdx - End index
   * @param {Array|null} [backgroundColor=null] - [r, g, b, a]
   * @param {Array|null} [dirtyRects=null] - Array of dirty rectangles
   */
  compositeLayerRange(targetCtx, startIdx, endIdx, backgroundColor = null, dirtyRects = null, { ignoreVisibility = false } = {}) {
    // ignoreVisibility renders every group regardless of the local
    // show/hide toggle, and skips the instance-state mutations below — this
    // path is used for side renders (e.g. gallery time-lapse capture) that
    // must not perturb the live composite state or consume a pending
    // recomposite flag meant for the real mainCanvas render.
    if (!ignoreVisibility) {
      this.needsComposite = false;
      if (backgroundColor) this.backgroundColor = backgroundColor;
    }

    let useDirtyRects = false;
    let totalDirtyArea = 0;

    if (dirtyRects && Array.isArray(dirtyRects) && dirtyRects.length > 0) {
      totalDirtyArea = dirtyRects.reduce((sum, r) => sum + (r.width * r.height), 0);
      const canvasArea = this.width * this.height;
      useDirtyRects = totalDirtyArea < (canvasArea * 0.5);
    }

    if (useDirtyRects) {
      for (const rect of dirtyRects) {
        targetCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      targetCtx.clearRect(0, 0, this.width, this.height);
      dirtyRects = null;
    }

    if (backgroundColor) {
      const [r, g, b, a] = backgroundColor;
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      if (useDirtyRects) {
        for (const rect of dirtyRects) {
          targetCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
      } else {
        targetCtx.fillRect(0, 0, this.width, this.height);
      }
    }

    // Clip all subsequent compositing to the dirty regions. The browser's
    // canvas compositor skips pixels outside the clip path, so a dirty region
    // covering 10% of the canvas reduces drawImage work by ~90%.
    const activeRects = useDirtyRects ? dirtyRects : null;
    if (activeRects) {
      this._applyDirtyClip(targetCtx, activeRects);
    }

    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible && !ignoreVisibility) continue;

      if (group.flatCanvas) {
        this._compositeGroupWithFlatCanvas(targetCtx, group, backgroundColor, activeRects);
      } else if (this._groupHasDestOut(group)) {
        if (this._groupHasComplexBlendModes(group)) {
          this._compositeGroupSequential(targetCtx, group, activeRects);
        } else {
          this._compositeGroupIsolated(targetCtx, group, activeRects);
        }
      } else {
        this._compositeGroupInto(targetCtx, group, activeRects);
      }
    }

    if (activeRects) {
      targetCtx.restore();
    }
    targetCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Composite Layer 0 using its flat canvas
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupWithFlatCanvas(targetCtx, group, bgColor = null, dirtyRects = null) {
    const hasUnbaked = group.strokeStack.length > 0 ||
      group.activeStrokeByUser.size > 0 ||
      (group.activePreviewByUser?.size ?? 0) > 0;

    if (!hasUnbaked) {
      targetCtx.globalCompositeOperation = 'source-over';
      this._drawCanvasRegion(targetCtx, group.flatCanvas, dirtyRects);
      return;
    }

    const { canvas: buffer, ctx: bufferCtx } = this._getGroupBuffer();
    this._clearDirtyRegion(bufferCtx, dirtyRects);

    if (dirtyRects) this._applyDirtyClip(bufferCtx, dirtyRects);

    if (bgColor) {
      const [r, g, b, a] = bgColor;
      bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      this._fillDirtyRegion(bufferCtx, dirtyRects);
    }

    bufferCtx.globalCompositeOperation = 'source-over';
    this._drawCanvasRegion(bufferCtx, group.flatCanvas, dirtyRects);

    for (const stroke of group.strokeStack) {
      bufferCtx.globalCompositeOperation = stroke.blendMode || 'source-over';
      this._drawCanvasRegion(bufferCtx, stroke.canvas, dirtyRects, stroke.x ?? 0, stroke.y ?? 0);
      if (stroke.blendMode === 'destination-out' && bgColor) {
        const [r, g, b, a] = bgColor;
        bufferCtx.globalCompositeOperation = 'destination-over';
        bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        this._fillDirtyRegion(bufferCtx, dirtyRects);
        bufferCtx.globalCompositeOperation = 'source-over';
      }
    }

    const activeStrokes = [
      ...Array.from(group.activeStrokeByUser.values()),
      ...Array.from(group.activePreviewByUser?.values?.() || [])
    ];
    const isBlendStroke = (active) =>
      active.blendMode !== 'source-over' && active.blendMode !== 'destination-out';

    for (const active of activeStrokes) {
      if (isBlendStroke(active)) continue;
      this._compositeStroke(bufferCtx, active, true, dirtyRects);

      if (active.blendMode === 'destination-out' && bgColor) {
        const [r, g, b, a] = bgColor;
        bufferCtx.globalCompositeOperation = 'destination-over';
        bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        this._fillDirtyRegion(bufferCtx, dirtyRects);
        bufferCtx.globalCompositeOperation = 'source-over';
      }
    }

    for (const active of activeStrokes) {
      if (!isBlendStroke(active)) continue;
      bufferCtx.globalCompositeOperation = active.blendMode;
      this._drawCanvasRegion(bufferCtx, active.canvas, dirtyRects);
      bufferCtx.globalCompositeOperation = 'source-over';
    }

    if (bgColor) {
      const [r, g, b, a] = bgColor;
      bufferCtx.globalCompositeOperation = 'destination-over';
      bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      this._fillDirtyRegion(bufferCtx, dirtyRects);
    }

    bufferCtx.globalCompositeOperation = 'source-over';
    if (dirtyRects) bufferCtx.restore();

    targetCtx.globalCompositeOperation = 'source-over';
    this._drawCanvasRegion(targetCtx, buffer, dirtyRects);
  }

  compositeLayerWithoutActiveStroke(targetCtx, groupIdx, excludedUserId, bgColor = null, dirtyRects = null) {
    const group = this.layerGroups[groupIdx];
    if (!group?.visible) return;

    const excludedActive = group.activeStrokeByUser.get(excludedUserId);
    if (!excludedActive) {
      this.compositeLayerRange(targetCtx, groupIdx, groupIdx + 1, bgColor, dirtyRects);
      return;
    }

    group.activeStrokeByUser.delete(excludedUserId);
    try {
      this.compositeLayerRange(targetCtx, groupIdx, groupIdx + 1, bgColor, dirtyRects);
    } finally {
      group.activeStrokeByUser.set(excludedUserId, excludedActive);
    }
  }

  /**
   * Composite a single layer's PERMANENT content for a checkpoint/join snapshot:
   * baked content (flatCanvas + bakedSequences) plus any confirmed live strokes
   * with seq <= maxSeq, but NOT active in-progress strokes and NOT optimistic
   * (seq 0) strokes. Everything with seq > maxSeq is left out so the server can
   * replay it as the undoable command tail to a joiner.
   *
   * Including confirmed live strokes <= maxSeq covers the rare non-prefix bake
   * (an unsafe-blend stroke skipped by _bakeOverflowStrokes can sit below the
   * watermark while higher-seq strokes baked) — those land in the base instead
   * of being dropped.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} groupIdx
   * @param {number} maxSeq - Baked watermark seq.
   */
  compositeBakedThroughSeq(targetCtx, groupIdx, maxSeq) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const savedStack = group.strokeStack;
    const savedActive = group.activeStrokeByUser;
    const savedPreview = group.activePreviewByUser;

    group.strokeStack = savedStack.filter(s => (s.seq || 0) > 0 && s.seq <= maxSeq);
    group.activeStrokeByUser = new Map();
    group.activePreviewByUser = new Map();
    try {
      this.compositeLayerRange(targetCtx, groupIdx, groupIdx + 1, null);
    } finally {
      group.strokeStack = savedStack;
      group.activeStrokeByUser = savedActive;
      group.activePreviewByUser = savedPreview;
    }
  }

  /**
   * Build a full-size canvas with the layer's existing content (flatCanvas + strokeStack,
   * no background, no active strokes). Mirrors `_buildFlatContentCanvas` so previews can
   * mask against the same content the commit-time mask uses.
   * @param {number} layerIdx - Layer index
   * @returns {HTMLCanvasElement|null} Full-size canvas, or null if the layer has no flatCanvas
   */
  getLayerExistingContent(layerIdx) {
    const group = this.layerGroups[layerIdx];
    if (!group?.flatCanvas) return null;
    return this._buildFlatContentCanvas(group, 0, 0, this.width, this.height);
  }

  /**
   * Composite a layer group with erasers using sequential approach
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupSequential(targetCtx, group, dirtyRects = null) {
    const lowerSnap = document.createElement('canvas');
    lowerSnap.width = this.width;
    lowerSnap.height = this.height;
    const lowerCtx = lowerSnap.getContext('2d');
    if (dirtyRects) {
      this._applyDirtyClip(lowerCtx, dirtyRects);
    }
    this._drawCanvasRegion(lowerCtx, targetCtx.canvas, dirtyRects);
    if (dirtyRects) lowerCtx.restore();

    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStrokeSequential(targetCtx, stroke, lowerSnap, false, dirtyRects);
        }
      } else {
        this._compositeStrokeSequential(targetCtx, { canvas: item.canvas, blendMode: item.blendMode }, lowerSnap, false, dirtyRects);
      }
    }

    for (const stroke of group.strokeStack) {
      this._compositeStrokeSequential(targetCtx, stroke, lowerSnap, false, dirtyRects);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStrokeSequential(targetCtx, active, lowerSnap, true, dirtyRects);
    }

    for (const [, preview] of group.activePreviewByUser || []) {
      this._compositeStrokeSequential(targetCtx, preview, lowerSnap, true, dirtyRects);
    }

    targetCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Render a single stroke with eraser-aware logic
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {Object} stroke - Stroke record
   * @param {HTMLCanvasElement} lowerSnap - Lower layers snapshot
   * @param {boolean} [isActive=false] - Whether this is an active stroke
   * @private
   */
  _compositeStrokeSequential(ctx, stroke, lowerSnap, isActive = false, dirtyRects = null) {
    if (stroke.filterType === 'blur' || stroke.filterType === 'glitchBlur') {
      this._applyBlurFilter(ctx, stroke, isActive);
      return;
    }

    const x = stroke.x ?? 0;
    const y = stroke.y ?? 0;

    if (stroke.blendMode === 'destination-out') {
      ctx.globalCompositeOperation = 'destination-out';
      this._drawCanvasRegion(ctx, stroke.canvas, dirtyRects, x, y);
      ctx.globalCompositeOperation = 'destination-over';
      this._drawCanvasRegion(ctx, lowerSnap, dirtyRects);
    } else {
      ctx.globalCompositeOperation = stroke.blendMode;
      this._drawCanvasRegion(ctx, stroke.canvas, dirtyRects, x, y);
    }
  }

  /**
   * Composite a layer group with erasers using isolated buffering
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupIsolated(targetCtx, group, dirtyRects = null) {
    const { canvas: buffer, ctx: bufferCtx } = this._getGroupBuffer();
    this._clearDirtyRegion(bufferCtx, dirtyRects);

    if (dirtyRects) this._applyDirtyClip(bufferCtx, dirtyRects);

    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStroke(bufferCtx, stroke, false, dirtyRects);
        }
      } else {
        this._compositeStroke(bufferCtx, item, false, dirtyRects);
      }
    }

    for (const stroke of group.strokeStack) {
      this._compositeStroke(bufferCtx, stroke, false, dirtyRects);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStroke(bufferCtx, active, true, dirtyRects);
    }

    for (const [, preview] of group.activePreviewByUser || []) {
      this._compositeStroke(bufferCtx, preview, true, dirtyRects);
    }

    bufferCtx.globalCompositeOperation = 'source-over';
    if (dirtyRects) bufferCtx.restore();

    targetCtx.globalCompositeOperation = 'source-over';
    this._drawCanvasRegion(targetCtx, buffer, dirtyRects);
  }

  /**
   * Composite all visible layer groups onto a target context
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Array} [backgroundColor] - [r, g, b, a]
   * @param {{ ignoreVisibility?: boolean }} [opts] - see compositeLayerRange
   */
  compositeLayers(targetCtx, backgroundColor, { ignoreVisibility = false } = {}) {
    if (backgroundColor && !ignoreVisibility) this.backgroundColor = backgroundColor;

    this.compositeLayerRange(targetCtx, 0, this.layerGroups.length, backgroundColor || null, null, { ignoreVisibility });

    if (!ignoreVisibility) {
      this.needsComposite = false;
      this._notifyStrokeHistoryPanel();
    }
  }

  /**
   * Get layer group by index
   * @param {number} groupIndex - Layer index
   * @returns {Object}
   */
  getLayerGroup(groupIndex) {
    return this.layerGroups[groupIndex];
  }

  /**
   * Get total number of layer groups
   * @returns {number}
   */
  getLayerCount() {
    return this.layerGroups.length;
  }

  /**
   * Check if layer is visible
   * @param {number} index - Layer index
   * @returns {boolean}
   */
  isLayerVisible(index) {
    return this.layerGroups[index]?.visible ?? false;
  }

  /**
   * Toggle layer visibility
   * @param {number} index - Layer index
   * @returns {boolean} New visibility state
   */
  toggleLayerVisibility(index) {
    if (this.layerGroups[index]) {
      this.layerGroups[index].visible = !this.layerGroups[index].visible;
      this.needsComposite = true;
      return this.layerGroups[index].visible;
    }
    return false;
  }

  /**
   * Set layer visibility
   * @param {number} index - Layer index
   * @param {boolean} visible - Visibility state
   */
  setLayerVisibility(index, visible) {
    if (this.layerGroups[index]) {
      this.layerGroups[index].visible = visible;
      this.needsComposite = true;
    }
  }

  /**
   * Clear all content from a layer group
   * @param {number} index - Layer index
   */
  clear(index) {
    const group = this.layerGroups[index];
    if (group) {
      for (const seq of group.bakedSequences) {
        this._disposeSequence(seq);
      }
      for (const stroke of group.strokeStack) {
        this._disposeStrokeRecord(stroke);
      }
      for (const active of group.activeStrokeByUser.values()) {
        this._disposeCanvasObject(active);
      }
      group.bakedSequences = [];
      group.strokeStack = [];
      group.userStrokeCounts.clear();
      group.activeStrokeByUser.clear();
      this._clearPreviewsFromGroup(group);
      if (group.flatCanvas) {
        group.flatCtx.clearRect(0, 0, this.width, this.height);
      }
      this.needsComposite = true;
      this._notifyStrokeHistoryPanel();
    }
  }

  /**
   * Clear all content from all layer groups
   */
  clearAll() {
    for (let i = 0; i < this.layerGroups.length; i++) {
      this.clear(i);
    }
    for (const batches of this.redoStackByUser.values()) {
      for (const batch of batches) {
        for (const { record } of batch) {
          this._disposeStrokeRecord(record);
        }
      }
    }
    this.redoStackByUser.clear();
    this._bakedWatermarkSeq = 0;
    this._drainableUsers.clear();

    if (this._pendingGlitchResults) {
      for (const pending of this._pendingGlitchResults.values()) {
        for (const item of pending) {
          this._disposeCanvasElement(item?.resultImage);
        }
      }
      this._pendingGlitchResults.clear();
    }

    // Clear canvas pool to prevent old content from reappearing
    for (const pooled of this._canvasPool) {
      this._disposeCanvasObject(pooled);
    }
    this._canvasPool = [];
    // Clear group buffer
    this._disposeCanvasObject(this._groupBuffer);
    this._groupBuffer = null;

    this._notifyStrokeHistoryPanel();
  }

  compactTransientState(options = {}) {
    const clearReplayCaches = options.clearReplayCaches !== false;
    if (clearReplayCaches) {
      for (const group of this.layerGroups) {
        for (const stroke of group.strokeStack) {
          this._disposeCanvasElement(stroke._cachedPreview);
          stroke._cachedPreview = null;
          this._disposeCanvasElement(stroke._cachedBlurResult);
          stroke._cachedBlurResult = null;
        }
        for (const seq of group.bakedSequences) {
          if (seq?.type === 'group' && Array.isArray(seq.strokes)) {
            for (const stroke of seq.strokes) {
              this._disposeCanvasElement(stroke._cachedPreview);
              stroke._cachedPreview = null;
              this._disposeCanvasElement(stroke._cachedBlurResult);
              stroke._cachedBlurResult = null;
            }
          }
        }
      }
    }

    if (this._pendingGlitchResults) {
      for (const pending of this._pendingGlitchResults.values()) {
        for (const item of pending) {
          this._disposeCanvasElement(item?.resultImage);
        }
      }
      this._pendingGlitchResults.clear();
    }

    for (const pooled of this._canvasPool) {
      this._disposeCanvasObject(pooled);
    }
    this._canvasPool = [];
    this._disposeCanvasObject(this._groupBuffer);
    this._groupBuffer = null;

    if (options.recycleWorker !== false) {
      this.recycleWorkerClient();
    }

    this.needsComposite = true;
  }

  /**
   * Resize all layer canvases
   * @param {number} width - New width
   * @param {number} height - New height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this._groupBuffer = null;
    this._canvasPool = [];

    for (const group of this.layerGroups) {
      for (const seq of group.bakedSequences) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = seq.canvas.width;
        tempCanvas.height = seq.canvas.height;
        tempCanvas.getContext('2d').drawImage(seq.canvas, 0, 0);
        seq.canvas.width = width;
        seq.canvas.height = height;
        seq.ctx.lineCap = 'round';
        seq.ctx.lineJoin = 'round';
        seq.ctx.imageSmoothingQuality = 'high';
        seq.ctx.drawImage(tempCanvas, 0, 0);
      }

      for (const [, active] of group.activeStrokeByUser) {
        const temp2 = document.createElement('canvas');
        temp2.width = active.canvas.width;
        temp2.height = active.canvas.height;
        temp2.getContext('2d').drawImage(active.canvas, 0, 0);
        active.canvas.width = width;
        active.canvas.height = height;
        active.ctx.drawImage(temp2, 0, 0);
      }

      if (group.flatCanvas) {
        const tempFlat = document.createElement('canvas');
        tempFlat.width = group.flatCanvas.width;
        tempFlat.height = group.flatCanvas.height;
        tempFlat.getContext('2d').drawImage(group.flatCanvas, 0, 0);
        group.flatCanvas.width = width;
        group.flatCanvas.height = height;
        group.flatCtx.drawImage(tempFlat, 0, 0);
      }
    }

    this.needsComposite = true;
  }

  /**
   * Get composited image data of all layers
   * @returns {ImageData}
   */
  getCompositedImageData() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tempCtx = tempCanvas.getContext('2d');
    this.compositeLayers(tempCtx);
    return tempCtx.getImageData(0, 0, this.width, this.height);
  }

  /**
   * Get basic metadata for all layer groups
   * @returns {Array}
   */
  getLayerData() {
    return this.layerGroups.map(group => ({
      id: group.id,
      name: group.name,
      visible: group.visible,
      strokeCount: group.strokeStack.length
    }));
  }

  /** @deprecated Use getUserStrokeContext */
  getLayerContext(groupIndex, userId, createBlendMode = 'source-over') {
    return this.getUserStrokeContext(groupIndex, userId, createBlendMode);
  }

  /** @deprecated Use beginUserStroke */
  createBlendSubLayer(groupIndex, userId, blendMode) {
    this.beginUserStroke(groupIndex, userId, blendMode);
    return this.getUserStrokeContext(groupIndex, userId);
  }

  /** @deprecated No-op */
  getActiveBlendMode(groupIndex) { return 'source-over'; }

  /** @deprecated No-op */
  setActiveBlendMode(groupIndex, blendMode) {}

  /** @deprecated No-op */
  getUserBlendMode(groupIndex, userId) { return 'source-over'; }

  /**
   * Clean up all active strokes for a user
   * @param {number} userId - User ID
   */
  cleanupUserStrokes(userId) {
    for (const group of this.layerGroups) {
      const active = group.activeStrokeByUser.get(userId);
      if (active) {
        group.activeStrokeByUser.delete(userId);
        this._releaseCanvas(active);
      }
      this._deleteUserPreviewFromGroup(group, userId);
    }
    this.needsComposite = true;
  }

  /**
   * Bake out all strokes for a user into baked sequences, preserving visuals while freeing memory.
   * Called when a user disconnects to consolidate their drawing and release memory.
   * @param {number} userId - User ID to bake out
   */
  bakeOutUserStrokes(userId) {
    this.deepCleanupUserState(userId, { preserveVisuals: true });
    this.needsComposite = true;
    this._notifyHistoryPanel(true);
  }

  /**
   * Deep-clean all layer-manager state related to a user.
   * @param {number} userId - User ID to clean
   * @param {{preserveVisuals?: boolean}} [options={}]
   */
  deepCleanupUserState(userId, options = {}) {
    const preserveVisuals = options.preserveVisuals !== false;
    const safeModes = ['source-over', 'destination-out', 'multiply', 'darken', 'lighten', 'screen'];

    // Reached on BOTH user departure and the AFK transition (UserHandlers' 'afk'
    // handler calls cleanupUserState with preserveVisuals), which is exactly the
    // set whose strokes should still be consolidated. Mark them; the actual
    // flattening happens in order via _drainDepartedPrefix.
    if (preserveVisuals) this._drainableUsers.add(userId);
    else this._drainableUsers.delete(userId);

    for (const group of this.layerGroups) {
      const active = group.activeStrokeByUser.get(userId);
      if (active) {
        if (preserveVisuals && this._canBakeStroke(group, active, safeModes)) {
          this._bakeStrokeToBin(group, active);
        }
        group.activeStrokeByUser.delete(userId);
        this._disposeCanvasObject(active);
      }
      this._deleteUserPreviewFromGroup(group, userId);

      // A departing user's COMMITTED strokes are retained, never baked here.
      //
      // Baking them was the single largest source of permanent divergence in
      // this system. Two independent defects, both fatal:
      //
      //   1. It flattens out of GLOBAL order. flatCanvas composites beneath the
      //      ENTIRE live stack, so baking this user's seq-300 stroke while
      //      another user's seq-200 stroke is still live drops the newer stroke
      //      underneath the older one — permanently, since baking is
      //      irreversible.
      //   2. It fires on a local DISCONNECT EVENT, which reaches each client at
      //      a different point in its own stream. Clients therefore flatten
      //      different sets at different positions and never reconverge.
      //
      // Measured (test:k6obs --cpu-lag=1,2,3,4, bakeLedger oracle): of 32,189
      // bake-order inversions, the gated overflow path accounted for 207. This
      // path accounted for the other ~99.4%, and for the z-order inversions
      // (36,904) exceeding the bake-order count.
      //
      // Retaining costs nothing in the long run: `_bakeOverflowStrokes` walks
      // the stack from index 0 and flattens a GLOBAL seq-ordered prefix, so
      // these strokes are baked in correct order as that prefix advances. The
      // user's entry in `userStrokeCounts` is deliberately kept below (rather
      // than deleted) so they keep counting toward the overflow trigger — drop
      // it and a departed cohort's strokes can sit live with nothing left to
      // push the prefix past them.
      const retainedStrokes = [];
      for (const stroke of group.strokeStack) {
        if (stroke.userId === userId && !preserveVisuals) {
          this._disposeStrokeRecord(stroke);
          continue;
        }
        retainedStrokes.push(stroke);
      }
      group.strokeStack = retainedStrokes;

      const retainedSequences = [];
      for (const seq of group.bakedSequences) {
        if (seq?.type === 'group' && Array.isArray(seq.strokes) && seq.strokes.some((stroke) => stroke.userId === userId)) {
          if (preserveVisuals) {
            const rasterized = this._rasterizeGroupedSequence(seq);
            if (rasterized) {
              retainedSequences.push(rasterized);
            }
          }
          this._disposeSequence(seq);
          continue;
        }
        retainedSequences.push(seq);
      }
      group.bakedSequences = retainedSequences;
      // Only drop the count when the strokes themselves were dropped. When they
      // are retained (above), the count must survive or they stop counting
      // toward `_anyUserOverMax` and nothing advances the prefix past them.
      if (!preserveVisuals) group.userStrokeCounts.delete(userId);

      // Departures and AFK transitions usually arrive when that user is (by
      // definition) not drawing, and the drain otherwise only rides on
      // _bakeOverflowStrokes, which is commit-driven. Run it here so a quiet
      // board still consolidates rather than holding the strokes indefinitely.
      if (preserveVisuals) this._drainDepartedPrefix(group, safeModes);
    }

    const redoBatches = this.redoStackByUser.get(userId);
    if (redoBatches) {
      for (const batch of redoBatches) {
        for (const { record } of batch) {
          this._disposeStrokeRecord(record);
        }
      }
      this.redoStackByUser.delete(userId);
    }

    if (this._pendingGlitchResults?.has(userId)) {
      const pending = this._pendingGlitchResults.get(userId) || [];
      for (const item of pending) {
        this._disposeCanvasElement(item?.resultImage);
      }
      this._pendingGlitchResults.delete(userId);
    }

    this.needsComposite = true;
  }

  clearUserState(userId) {
    for (const group of this.layerGroups) {
      const active = group.activeStrokeByUser.get(userId);
      if (active) {
        group.activeStrokeByUser.delete(userId);
        this._disposeCanvasObject(active);
      }
      this._deleteUserPreviewFromGroup(group, userId);

      const retainedStrokes = [];
      for (const stroke of group.strokeStack) {
        if (stroke.userId !== userId) {
          retainedStrokes.push(stroke);
        } else {
          this._disposeStrokeRecord(stroke);
        }
      }
      group.strokeStack = retainedStrokes;

      const retainedSequences = [];
      for (const seq of group.bakedSequences) {
        if (seq?.type === 'group' && Array.isArray(seq.strokes) && seq.strokes.some((stroke) => stroke.userId === userId)) {
          this._disposeSequence(seq);
          continue;
        }
        retainedSequences.push(seq);
      }
      group.bakedSequences = retainedSequences;
      group.userStrokeCounts.delete(userId);
    }

    const redoBatches = this.redoStackByUser.get(userId);
    if (redoBatches) {
      for (const batch of redoBatches) {
        for (const { record } of batch) {
          this._disposeStrokeRecord(record);
        }
      }
      this.redoStackByUser.delete(userId);
    }

    if (this._pendingGlitchResults?.has(userId)) {
      const pending = this._pendingGlitchResults.get(userId) || [];
      for (const item of pending) {
        this._disposeCanvasElement(item?.resultImage);
      }
      this._pendingGlitchResults.delete(userId);
    }

    this.needsComposite = true;
  }

  /**
   * Return lightweight counters useful during memory investigations.
   * @returns {Object}
   */
  getDebugStats() {
    const stats = {
      activeStrokes: 0,
      strokeStack: 0,
      redoEntries: 0,
      bakedSequences: 0,
      groupedStrokeRefs: 0,
      pendingGlitchUsers: this._pendingGlitchResults?.size ?? 0,
      pendingGlitchResults: 0,
      canvasPool: this._canvasPool.length
    };

    for (const group of this.layerGroups) {
      stats.activeStrokes += group.activeStrokeByUser.size;
      stats.activeStrokes += group.activePreviewByUser?.size ?? 0;
      stats.strokeStack += group.strokeStack.length;
      stats.bakedSequences += group.bakedSequences.length;
      for (const seq of group.bakedSequences) {
        if (seq?.type === 'group' && Array.isArray(seq.strokes)) {
          stats.groupedStrokeRefs += seq.strokes.length;
        }
      }
    }

    for (const batches of this.redoStackByUser.values()) {
      for (const batch of batches) {
        stats.redoEntries += batch.length;
      }
    }

    if (this._pendingGlitchResults) {
      for (const pending of this._pendingGlitchResults.values()) {
        stats.pendingGlitchResults += pending.length;
      }
    }

    return stats;
  }

  /** @deprecated No-op */
  mergeAdjacentSourceOverSubLayers(groupIndex, userId) {}

  /** @deprecated No-op */
  flattenLayerGroup(groupIndex, backgroundColor) {}

  /** @deprecated No-op */
  cleanupEmptySubLayers(groupIndex, userId) {}

  _disposeCanvasElement(canvas) {
    if (!canvas) return;
    if (typeof canvas.close === 'function') {
      try { canvas.close(); } catch (_) {}
    }
    if (canvas instanceof HTMLCanvasElement) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  _disposeCanvasObject(canvasObj) {
    if (!canvasObj) return;
    if (canvasObj.maskCanvas && canvasObj.maskCanvas !== canvasObj.canvas) {
      this._disposeCanvasElement(canvasObj.maskCanvas);
      canvasObj.maskCanvas = null;
    }
    this._disposeCanvasElement(canvasObj.canvas);
    canvasObj.ctx = null;
    canvasObj.canvas = null;
  }

  _disposeStrokeRecord(stroke) {
    if (!stroke) return;
    if (stroke.selectionRestoreData?.snapshots) {
      for (const snap of stroke.selectionRestoreData.snapshots) {
        this._disposeCanvasElement(snap?.canvas);
      }
    }
    this._disposeCanvasElement(stroke._cachedBlurResult);
    this._disposeCanvasElement(stroke._cachedPreview);
    if (stroke.maskCanvas && stroke.maskCanvas !== stroke.canvas) {
      this._disposeCanvasElement(stroke.maskCanvas);
    }
    this._disposeCanvasElement(stroke.canvas);
    stroke.canvas = null;
    stroke.ctx = null;
    stroke.maskCanvas = null;
    stroke._cachedBlurResult = null;
    stroke._cachedPreview = null;
    stroke.selectionRestoreData = null;
  }

  _disposeSequence(seq) {
    if (!seq) return;
    if (seq.type === 'group' && Array.isArray(seq.strokes)) {
      for (const stroke of seq.strokes) {
        this._disposeStrokeRecord(stroke);
      }
      seq.strokes = [];
      return;
    }
    this._disposeCanvasObject(seq);
  }

  _removeUndoTargetFromCollection(collection, userId, timestamp, isEraseAll, group) {
    if (!Array.isArray(collection) || collection.length === 0) return false;

    let removed = false;
    for (let i = collection.length - 1; i >= 0; i--) {
      const stroke = collection[i];
      if (!stroke || stroke.userId !== userId || stroke.timestamp !== timestamp) continue;
      if (isEraseAll && stroke.eraseAll !== true) continue;

      collection.splice(i, 1);
      const cnt = group.userStrokeCounts.get(userId) || 0;
      if (cnt > 0) group.userStrokeCounts.set(userId, cnt - 1);
      removed = true;
    }

    return removed;
  }

  _rebuildFlatCanvas(group) {
    if (!group?.flatCanvas || !group.flatCtx) return;

    const { width, height } = group.flatCanvas;
    group.flatCtx.clearRect(0, 0, width, height);

    for (const stroke of group.flatStrokeRecords || []) {
      this._compositeStroke(group.flatCtx, stroke, false);
    }
  }

  _rebuildSequenceCanvas(seq) {
    if (!seq?.canvas || !seq.ctx || !Array.isArray(seq.strokes)) return;

    const { width, height } = seq.canvas;
    seq.ctx.clearRect(0, 0, width, height);

    for (const stroke of seq.strokes) {
      this._compositeStroke(seq.ctx, stroke, false);
    }
  }

  _rasterizeGroupedSequence(seq) {
    if (!seq?.strokes || seq.strokes.length === 0) return null;
    const rasterized = this._createCanvas();
    rasterized.blendMode = 'source-over';
    for (const stroke of seq.strokes) {
      this._compositeStroke(rasterized.ctx, stroke, false);
    }
    rasterized.ctx.globalCompositeOperation = 'source-over';
    return this._hasContent(rasterized.canvas) ? rasterized : null;
  }
}
