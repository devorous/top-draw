/**
 * LayerManager - Manages multiple off-screen canvas layers with stroke history
 *
 * Each layer group maintains:
 *  - bakedSequences: Array of sequential bins [{blendMode, canvas, ctx}] in chronological order
 *  - strokeStack: ordered list of completed stroke records [{canvas, x, y, w, h, blendMode, userId}]
 *  - userStrokeCounts: Map of userId → count of their strokes in the stack
 *  - activeStrokeByUser: Map of userId → in-progress stroke {canvas, ctx, blendMode}
 *
 * Composite order per group:
 *   background → bakedSequences (chronological) → strokeStack → activeStrokes
 *
 * Baking: when any user exceeds MAX_STROKES_PER_USER, the oldest strokes are
 * shifted from the bottom of strokeStack. Consecutive strokes with the same blend mode
 * are compressed into a single sequence bin to preserve chronological order.
 *
 * Undo: undoLastStroke() splices the user's most recent entry from strokeStack.
 */
export class LayerManager {
  static MAX_STROKES_PER_USER = 10;

  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layerGroups = [];
    this.needsComposite = true;
    // Cached background color for baking — updated each time compositeLayers is called
    this.backgroundColor = [255, 255, 255, 1];
    // Reference to stroke history panel (set by App.js for dev mode visualization)
    this.strokeHistoryPanel = null;
    // Optional callback fired whenever stroke history changes (undo/redo availability may change)
    this.onHistoryChange = null;
    this.redoStackByUser = new Map(); // userId → [{groupIdx, record}][] (batches, newest last)
    // Reusable buffer for isolated group compositing (eraser optimization)
    this._groupBuffer = null;
    // Pool of reusable full-size canvases for active strokes (reduces GC pressure)
    this._canvasPool = [];
    this.CANVAS_POOL_MAX = 12;

    this.initLayerGroups(3);
  }

  /**
   * Notify the stroke history panel to update (if enabled)
   * @param {boolean} immediate - If true, update immediately instead of queuing
   */
  _notifyHistoryPanel(immediate = false) {
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

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

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
   * Acquire a full-size canvas from the pool, or create one if the pool is empty.
   * Always returns a cleared canvas ready for drawing.
   */
  _acquireCanvas() {
    if (this._canvasPool.length > 0) {
      const c = this._canvasPool.pop();
      c.ctx.clearRect(0, 0, this.width, this.height);
      c.ctx.globalCompositeOperation = 'source-over';
      return c;
    }
    return this._createCanvas();
  }

  /**
   * Return a full-size canvas to the pool for later reuse.
   * Silently discards if the pool is already at capacity.
   * @param {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}} canvasObj
   */
  _releaseCanvas(canvasObj) {
    if (!canvasObj) return;
    if (this._canvasPool.length < this.CANVAS_POOL_MAX) {
      canvasObj.ctx.clearRect(0, 0, this.width, this.height);
      canvasObj.ctx.globalCompositeOperation = 'source-over';
      this._canvasPool.push(canvasObj);
    }
  }

  /**
   * Get or create the reusable group buffer canvas for isolated compositing.
   * This single buffer is reused for all groups to minimize memory allocation.
   * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
   */
  _getGroupBuffer() {
    if (!this._groupBuffer || this._groupBuffer.canvas.width !== this.width || this._groupBuffer.canvas.height !== this.height) {
      this._groupBuffer = this._createCanvas();
    }
    return this._groupBuffer;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  initLayerGroups(count) {
    for (let i = 0; i < count; i++) {
      const group = {
        id: i,
        name: `Layer ${i + 1}`,
        visible: true,
        // Layer 0 (bottom) allows all blend modes. Upper layers default to Normal-only
        // for O(N) isolated compositing performance. Can be toggled via room settings.
        allowComplexBlendModes: i === 0,
        bakedSequences: [],       // [{type:'sequence'|'group', blendMode, canvas?, ctx?, strokes?[], timestamp}]
        strokeStack: [],          // completed stroke records
        userStrokeCounts: new Map(), // userId → count in strokeStack
        activeStrokeByUser: new Map(), // userId → { canvas, ctx, blendMode }
        flatCanvas: null,
        flatCtx: null
      };

      // Layer 0 uses a single pre-composited "flat canvas" instead of separate sequence
      // bins. It is initialized with the background color so that blend mode math is
      // correct against the actual background (not transparent). Strokes bake directly
      // onto it, and it is drawn with source-over during compositing.
      if (i === 0) {
        const { canvas, ctx } = this._createCanvas();
        const [r, g, b, a] = this.backgroundColor;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        group.flatCanvas = canvas;
        group.flatCtx = ctx;
      }

      this.layerGroups.push(group);
    }
  }

  /**
   * Set whether a layer allows complex blend modes (multiply, difference, etc.)
   * When false, only Normal (source-over) is available — enables the O(N) isolated
   * compositing path and hides the blend mode UI for this layer.
   * @param {number} groupIdx
   * @param {boolean} allow
   */
  setLayerAllowComplexBlendModes(groupIdx, allow) {
    if (this.layerGroups[groupIdx]) {
      this.layerGroups[groupIdx].allowComplexBlendModes = allow;
    }
  }

  /** @returns {boolean} */
  getLayerAllowComplexBlendModes(groupIdx) {
    return this.layerGroups[groupIdx]?.allowComplexBlendModes ?? true;
  }

  // ---------------------------------------------------------------------------
  // Core Stroke Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Begin a new in-progress stroke for a user on a layer group.
   * Creates a full-size temp canvas stored in activeStrokeByUser.
   * @param {number} groupIdx
   * @param {number} userId
   * @param {string} [blendMode='source-over']
   */
  beginUserStroke(groupIdx, userId, blendMode = 'source-over') {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const { canvas, ctx } = this._acquireCanvas();
    group.activeStrokeByUser.set(userId, {
      canvas,
      ctx,
      blendMode,
      dirtyRect: { minX: this.width, minY: this.height, maxX: -1, maxY: -1 } // Initialize dirtyRect
    });
    this.needsComposite = true;
    this._notifyHistoryPanel();
  }

  /**
   * Get the drawing context for a user's current in-progress stroke.
   * Lazily creates a stroke if none exists (e.g. for mid-stroke tool calls).
   * @param {number} groupIdx
   * @param {number} userId
   * @param {string} [createBlendMode='source-over'] - Blend mode to use if a new stroke must be created
   * @returns {CanvasRenderingContext2D|undefined}
   */
  getUserStrokeContext(groupIdx, userId, createBlendMode = 'source-over') {
    const group = this.layerGroups[groupIdx];
    if (!group) return undefined;

    let active = group.activeStrokeByUser.get(userId);
    if (!active) {
      const { canvas, ctx } = this._acquireCanvas();
      active = {
        canvas,
        ctx,
        blendMode: createBlendMode,
        dirtyRect: { minX: this.width, minY: this.height, maxX: -1, maxY: -1 } // Initialize dirtyRect
      };
      group.activeStrokeByUser.set(userId, active);
    } else if (createBlendMode !== 'source-over' && active.blendMode !== createBlendMode) {
      // Force update blend mode if requesting something specific (like eraser)
      // and we have a default/stale stroke (e.g. from deferred pointer down or zombie stroke).
      active.blendMode = createBlendMode;
    }
    return active.ctx;
  }

  /**
   * Commit a completed stroke: pixel-scan to find content bounds, crop to that
   * region, push a StrokeRecord onto strokeStack, and bake overflow.
   * @param {number} groupIdx
   * @param {number} userId
   * @param {Object} [extraProps] - Extra properties merged into the stroke record (e.g. { eraseAll: true })
   */
  commitUserStroke(groupIdx, userId, extraProps = {}) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    if (!active) return;

    group.activeStrokeByUser.delete(userId);

    // Find non-transparent bounding box (using dirty rect optimization if available)
    const bounds = this._findContentBounds(active.canvas, active.dirtyRect);
    if (!bounds) {
      this._releaseCanvas(active); // Return empty canvas to pool
      return;
    }

    const { x, y, width, height } = bounds;

    // Crop the full-size canvas to just the content area
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(active.canvas, x, y, width, height, 0, 0, width, height);

    // Release the full-size active canvas back to the pool
    this._releaseCanvas(active);

    const record = { canvas: croppedCanvas, ctx: croppedCtx, x, y, width, height, blendMode: active.blendMode, userId, timestamp: Date.now(), ...extraProps };
    group.strokeStack.push(record);

    const prev = group.userStrokeCounts.get(userId) || 0;
    group.userStrokeCounts.set(userId, prev + 1);

    this._bakeOverflowStrokes(group);
    this._clearRedoStack(userId);
    this.needsComposite = true;
    this._notifyHistoryPanel();
  }

  /**
   * Cancel an in-progress stroke: discard the active stroke canvas without committing it.
   * @param {number} groupIdx
   * @param {number} userId
   */
  cancelUserStroke(groupIdx, userId) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const active = group.activeStrokeByUser.get(userId);
    if (active) {
      group.activeStrokeByUser.delete(userId);
      this._releaseCanvas(active);
      this.needsComposite = true;
      this._notifyHistoryPanel();
    }
  }

  // ---------------------------------------------------------------------------
  // Redo Stack Helpers
  // ---------------------------------------------------------------------------

  _pushToRedoStack(userId, batch) {
    if (!this.redoStackByUser.has(userId)) this.redoStackByUser.set(userId, []);
    this.redoStackByUser.get(userId).push(batch);
  }

  _clearRedoStack(userId) {
    this.redoStackByUser.set(userId, []);
  }

  // ---------------------------------------------------------------------------
  // Sync Import Helpers (used when a new user joins and receives state)
  // These bypass baking and redo-stack management to restore exact provider state.
  // ---------------------------------------------------------------------------

  /**
   * Import a baked sequence from network sync.
   * Called during join-sync to restore baked history in chronological order.
   * @param {number} groupIdx
   * @param {string} blendMode
   * @param {ImageBitmap} imageBitmap
   */
  importSequence(groupIdx, blendMode, imageBitmap) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    if (group.flatCanvas) {
      // Layer 0: composite the incoming image onto the flat canvas.
      // Sync providers send baked sequences in chronological order, so sequential
      // drawImage calls here reconstruct the correct composited state.
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
   * Insert a stroke record directly into a layer group's stroke stack.
   * Inserts in timestamp-sorted order to maintain correct undo sequence.
   * Does NOT trigger overflow baking or redo-stack clearing.
   * @param {number} groupIdx
   * @param {Object} record - StrokeRecord: { canvas, ctx, x, y, width, height, blendMode, userId, timestamp, ...extras }
   */
  importStroke(groupIdx, record) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    // Insert in timestamp order (same logic as redo)
    let insertIdx = group.strokeStack.findIndex(s => s.timestamp > record.timestamp);
    if (insertIdx === -1) insertIdx = group.strokeStack.length;

    group.strokeStack.splice(insertIdx, 0, record);

    const prev = group.userStrokeCounts.get(record.userId) || 0;
    group.userStrokeCounts.set(record.userId, prev + 1);
    this.needsComposite = true;
  }

  /**
   * Insert a stroke record into a specific redo batch for a user.
   * Redo batches are ordered oldest-first (batchIdx 0 = oldest undo).
   * @param {number} userId
   * @param {number} batchIdx - Index within the user's redo stack
   * @param {number} groupIdx - Layer group the stroke belongs to
   * @param {Object} record - StrokeRecord
   */
  importRedoStroke(userId, batchIdx, groupIdx, record) {
    if (!this.redoStackByUser.has(userId)) this.redoStackByUser.set(userId, []);
    const batches = this.redoStackByUser.get(userId);
    while (batches.length <= batchIdx) batches.push([]);
    batches[batchIdx].push({ groupIdx, record });
  }

  // ---------------------------------------------------------------------------
  // Global Undo / Redo
  // ---------------------------------------------------------------------------

  /**
   * Undo the most recently committed stroke across ALL layers for a user,
   * regardless of which layer is currently active.
   * Erase-all batches (strokes sharing the same timestamp + eraseAll flag) are
   * removed atomically from every layer at once.
   * @param {number} userId
   * @returns {Array<{groupIdx:number, record:Object}>|null} The removed batch for the redo stack, or null if nothing to undo
   */
  undoLastStrokeGlobal(userId) {
    // Find the latest timestamp across all layers for this user.
    let latestTimestamp = -1;
    for (const group of this.layerGroups) {
      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        if (group.strokeStack[i].userId === userId) {
          if (group.strokeStack[i].timestamp > latestTimestamp) {
            latestTimestamp = group.strokeStack[i].timestamp;
          }
          break;
        }
      }
    }
    if (latestTimestamp === -1) return null;

    // Peek at the stroke to check the eraseAll flag.
    let isEraseAll = false;
    outer: for (const group of this.layerGroups) {
      for (let i = group.strokeStack.length - 1; i >= 0; i--) {
        const s = group.strokeStack[i];
        if (s.userId === userId && s.timestamp === latestTimestamp) {
          isEraseAll = s.eraseAll === true;
          break outer;
        }
      }
    }

    const undoneStrokes = [];

    if (isEraseAll) {
      // Remove all strokes across every layer that share this batch timestamp.
      for (let gi = 0; gi < this.layerGroups.length; gi++) {
        const group = this.layerGroups[gi];
        for (let si = group.strokeStack.length - 1; si >= 0; si--) {
          const s = group.strokeStack[si];
          if (s.userId === userId && s.eraseAll && s.timestamp === latestTimestamp) {
            const [removed] = group.strokeStack.splice(si, 1);
            const cnt = group.userStrokeCounts.get(userId) || 0;
            if (cnt > 0) group.userStrokeCounts.set(userId, cnt - 1);
            undoneStrokes.push({ groupIdx: gi, record: removed });
            break;
          }
        }
      }
    } else {
      // Single-layer stroke: remove from whichever layer owns it.
      for (let gi = 0; gi < this.layerGroups.length; gi++) {
        const group = this.layerGroups[gi];
        for (let si = group.strokeStack.length - 1; si >= 0; si--) {
          const s = group.strokeStack[si];
          if (s.userId === userId && s.timestamp === latestTimestamp) {
            const [removed] = group.strokeStack.splice(si, 1);
            const cnt = group.userStrokeCounts.get(userId) || 0;
            if (cnt > 0) group.userStrokeCounts.set(userId, cnt - 1);
            undoneStrokes.push({ groupIdx: gi, record: removed });
            break;
          }
        }
      }
    }

    if (undoneStrokes.length === 0) return null;

    this.needsComposite = true;

    // Cleanup empty sequences now that strokes have been removed from history
    // (might make cleanup safe if the undone strokes were erasers)
    this.cleanupEmptySequencesAll();

    this._notifyHistoryPanel(true); // Immediate update for undo
    return undoneStrokes;
  }

  /**
   * Redo the most recently undone stroke batch for a user.
   * Records are re-appended to their respective layer stacks.
   * @param {number} userId
   * @returns {boolean}
   */
  redoLastStroke(userId) {
    const stack = this.redoStackByUser.get(userId);
    if (!stack || stack.length === 0) return false;

    const batch = stack.pop();
    for (const { groupIdx, record } of batch) {
      const group = this.layerGroups[groupIdx];
      if (!group) continue;
      // Re-insert at the original chronological position so the stroke appears
      // below any strokes drawn by other users after the original commit.
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
      this._bakeOverflowStrokes(group);
    }

    this.needsComposite = true;
    this._notifyHistoryPanel(true); // Immediate update for redo
    return true;
  }

  /** @deprecated Use undoLastStrokeGlobal(userId) */
  undoLastStroke(groupIdx, userId) {
    return this.undoLastStrokeGlobal(userId) !== null;
  }

  // ---------------------------------------------------------------------------
  // Baking
  // ---------------------------------------------------------------------------

  _bakeOverflowStrokes(group) {
    const MAX = LayerManager.MAX_STROKES_PER_USER;

    // Layer 0 is the bottom layer — it composites against a static background only,
    // so ALL blend modes are safe to bake directly into sequence bins.
    // Upper layers may sit above other layers' content, so non-associative modes
    // (difference, overlay, dodge, burn) cannot be safely pre-collapsed there.
    const isBaseLayer = group.id === 0;
    const safeModes = [
      'source-over',
      'destination-out',
      'multiply',
      'darken',
      'lighten',
      'screen'
    ];

    // Process oldest strokes first, compressing them either into bins or groups
    let i = 0;
    while (i < group.strokeStack.length && this._anyUserOverMax(group, MAX)) {
      const stroke = group.strokeStack[i];

      if (isBaseLayer || safeModes.includes(stroke.blendMode)) {
        // Bakeable: compress into a sequence bin (permanently committed)
        this._bakeStrokeToBin(group, stroke);
        group.strokeStack.splice(i, 1);

        const count = group.userStrokeCounts.get(stroke.userId) || 0;
        if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);

        // Do NOT increment i, as we just removed the element at i
      } else {
        // Non-bakeable stroke on an upper layer: check if we should compress into a group
        // Compress if there's a blend mode change after this run
        const runEnd = this._findBlendModeRunEnd(group.strokeStack, i);
        const runLength = runEnd - i + 1;
        const hasBlendModeChange = runEnd + 1 < group.strokeStack.length &&
                                    group.strokeStack[runEnd + 1].blendMode !== stroke.blendMode;

        if (hasBlendModeChange || runLength >= 5) {
          // Compress this run into a group
          this._compressStrokesToGroup(group, i, runEnd);
          // Do NOT increment i, we removed elements
        } else {
          // Keep in stack for now, try next stroke
          i++;
        }
      }
    }
  }

  /**
   * Find the end index of a consecutive run of strokes with the same blend mode
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
   * Compress a run of strokes into a visual group (for non-bakeable strokes)
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

    // Update user stroke counts
    for (const stroke of strokes) {
      const count = group.userStrokeCounts.get(stroke.userId) || 0;
      if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);
    }
  }

  _anyUserOverMax(group, max) {
    // On Layer 0 (base layer) every stroke is bakeable, so count them all.
    // On upper layers, only count associative/safe modes — non-associative modes
    // (difference, overlay, etc.) are compressed into groups instead of baked.
    const isBaseLayer = group.id === 0;
    const safeModes = ['source-over', 'destination-out', 'multiply', 'darken', 'lighten', 'screen'];
    const countsByUser = new Map();

    for (const stroke of group.strokeStack) {
      if (isBaseLayer || safeModes.includes(stroke.blendMode)) {
        const count = countsByUser.get(stroke.userId) || 0;
        countsByUser.set(stroke.userId, count + 1);
      }
    }

    for (const count of countsByUser.values()) {
      if (count > max) return true;
    }

    return false;
  }

  /** @deprecated Use _bakeStrokeToBin */
  _bakeStrokeToBase(group, stroke) {
    this._bakeStrokeToBin(group, stroke);
  }

  _bakeStrokeToBin(group, stroke) {
    // Layer 0: bake directly onto the flat canvas so blend modes composite against
    // the real background (correct sequential math, not transparent-bin math).
    if (group.flatCanvas) {
      // For blend modes other than source-over/destination-out, fill any transparent
      // holes (from previous erasers) with backgroundColor first. This ensures blend
      // modes compute against the background color, not transparent pixels.
      if (stroke.blendMode !== 'source-over' && stroke.blendMode !== 'destination-out') {
        const [r, g, b, a] = this.backgroundColor;
        group.flatCtx.globalCompositeOperation = 'destination-over';
        group.flatCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        group.flatCtx.fillRect(0, 0, this.width, this.height);
      }
      group.flatCtx.globalCompositeOperation = stroke.blendMode;
      group.flatCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
      group.flatCtx.globalCompositeOperation = 'source-over';
      return;
    }

    // Check if we can append to the last baked sequence (same blend mode)
    const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];

    let targetBin;
    if (lastSeq && lastSeq.blendMode === stroke.blendMode) {
      // Append to existing sequence
      targetBin = lastSeq;
    } else {
      // Create new sequence for this blend mode
      targetBin = this._createCanvas();
      targetBin.blendMode = stroke.blendMode;
      group.bakedSequences.push(targetBin);
    }

    // Use the stroke's actual blend mode for self-interaction within the bin.
    // This makes the math associative: (BG mode S1) mode S2 == BG mode (S1 mode S2).
    // Exception: Eraser bin accumulates the "mask", so we use source-over.
    targetBin.ctx.globalCompositeOperation = (stroke.blendMode === 'destination-out')
      ? 'source-over'
      : stroke.blendMode;

    targetBin.ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
  }

  /**
   * Add image content directly to baked sequences (used by Selection Restore)
   * @param {number} groupIdx
   * @param {HTMLCanvasElement} canvas
   * @param {number} x
   * @param {number} y
   * @param {string} [blendMode='source-over']
   */
  addToBaseBin(groupIdx, canvas, x, y, blendMode = 'source-over') {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    if (group.flatCanvas) {
      // Layer 0: composite directly onto the flat canvas
      group.flatCtx.globalCompositeOperation = blendMode;
      group.flatCtx.drawImage(canvas, x, y);
      group.flatCtx.globalCompositeOperation = 'source-over';
      this.needsComposite = true;
      return;
    }

    // Append to last sequence if same blend mode, otherwise create new sequence
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
   * Apply an eraser (destination-out) operation to all baked sequences in a layer group.
   * Used when redo-ing a selection cut or restored eraser strokes.
   */
  eraseFromAllBaseBins(groupIdx, eraserCanvas, x, y, lassoPath = null) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    if (group.flatCanvas) {
      // Layer 0: apply eraser directly to the flat canvas.
      // Punched-through areas become transparent; the backgroundColor fill in
      // compositeLayerRange will show through correctly when rendering.
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
   * Only removes empty sequences if there are no eraser operations in undo/redo history
   * (to prevent deleting sequences that could be restored by undoing an eraser).
   * @param {number} groupIdx
   */
  cleanupEmptyBins(groupIdx) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    // Check if any eraser operations exist in the undo/redo history
    const hasEraserInHistory = this._hasEraserInHistory(group);

    if (hasEraserInHistory) {
      // Don't cleanup - erasers in history might restore content when undone
      return;
    }

    // Safe to cleanup - no erasers that could be undone/redone
    group.bakedSequences = group.bakedSequences.filter(seq => this._hasContent(seq.canvas));
  }

  /**
   * Remove empty sequences from all layer groups.
   * Called after undo/redo operations to clean up sequences that became empty.
   */
  cleanupEmptySequencesAll() {
    for (let i = 0; i < this.layerGroups.length; i++) {
      this.cleanupEmptyBins(i);
    }
  }

  /**
   * Check if there are any eraser operations in the undo/redo stacks.
   * If yes, we should NOT delete empty sequences as undoing might restore content.
   * @param {Object} group
   * @returns {boolean}
   */
  _hasEraserInHistory(group) {
    // Check stroke stack (recent strokes that can be undone)
    if (group.strokeStack.some(s => s.blendMode === 'destination-out')) {
      return true;
    }

    // Check redo stacks for all users (undone strokes that can be redone)
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
   * Quick check if canvas has any non-transparent pixels
   */
  _hasContent(canvas) {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  /**
   * Expand a dirty rectangle to include new drawing bounds.
   * @param {Object} dirtyRect - {minX, minY, maxX, maxY}
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  _expandDirtyRect(dirtyRect, x, y, width, height) {
    if (dirtyRect.maxX === -1) {
      // First update
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
   * Scans an ImageData object for content within its bounds.
   * Returns the content bounds (relative to ImageData) or null if empty.
   * @param {ImageData} imageData
   * @returns {{x,y,width,height}|null}
   */
  _scanImageDataForContent(imageData) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 0) { // Check alpha channel
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0) return null; // Empty content
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /**
   * Legacy full-canvas scan (used as fallback).
   * Scan canvas pixels and return the bounding box of all non-transparent content.
   * @param {HTMLCanvasElement} canvas
   * @returns {{x,y,width,height}|null}
   */
  _findContentBoundsLegacy(canvas) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return this._scanImageDataForContent(imageData);
  }

  /**
   * Optimized content bounds finder using dirty rect tracking.
   * Falls back to legacy full-scan if dirty rect is invalid.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [dirtyRect] - Optional {minX, minY, maxX, maxY}
   * @returns {{x,y,width,height}|null}
   */
  _findContentBounds(canvas, dirtyRect = null) {
    if (dirtyRect && dirtyRect.maxX !== -1) {
      // Optimized path: Use dirtyRect to get focused imageData and scan only that.
      const dr = dirtyRect;
      const ctx = canvas.getContext('2d');
      
      // Safety check: Ensure bounds are positive and within canvas
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

      if (!contentInDirtyRect) return null; // Empty stroke within dirty rect

      // Adjust bounds to be relative to the original canvas
      return {
        x: scanX + contentInDirtyRect.x,
        y: scanY + contentInDirtyRect.y,
        width: contentInDirtyRect.width,
        height: contentInDirtyRect.height
      };
    } else {
      // Fallback to legacy full scan if dirtyRect is not valid
      return this._findContentBoundsLegacy(canvas);
    }
  }

  // ---------------------------------------------------------------------------
  // Compositing
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the group has any live destination-out strokes (eraser).
   * Used to decide whether isolated compositing is needed.
   * @param {Object} group
   * @returns {boolean}
   */
  _groupHasDestOut(group) {
    if (group.bakedSequences.some(seq => seq.blendMode === 'destination-out')) return true;
    if (group.strokeStack.some(s => s.blendMode === 'destination-out')) return true;
    for (const [, active] of group.activeStrokeByUser) {
      if (active.blendMode === 'destination-out') return true;
    }
    return false;
  }

  /**
   * Returns true if the group has blend modes other than source-over/destination-out.
   * Groups with complex blend modes (multiply, screen, etc.) need sequential compositing
   * because those blend modes must interact with the accumulated background.
   * @param {Object} group
   * @returns {boolean}
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

    return false;
  }

  /**
   * Returns true if any layer in the range [startIdx, endIdx) has a non-source-over
   * stroke (committed, active, or baked bin). Used to decide whether split-mode compositing is safe.
   * @param {number} startIdx - Inclusive start index
   * @param {number} endIdx - Exclusive end index
   * @returns {boolean}
   */
  rangeHasBlendModeStrokes(startIdx, endIdx) {
    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible) continue;

      // Check baked sequences
      for (const seq of group.bakedSequences) {
        if (seq.blendMode !== 'source-over') return true;
      }

      // Check stack
      for (const stroke of group.strokeStack) {
        if (stroke.blendMode !== 'source-over') return true;
      }

      // Check active
      for (const [, active] of group.activeStrokeByUser) {
        if (active.blendMode !== 'source-over') return true;
      }
    }
    return false;
  }

  /**
   * Composite all strokes for a single group into a context.
   * Used by both the direct and isolated compositing paths.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} group
   */
  _compositeGroupInto(ctx, group) {
    // 1. Draw all baked sequences and compressed groups in chronological order
    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        // Compressed group: draw each stroke in order
        for (const stroke of item.strokes) {
          ctx.globalCompositeOperation = stroke.blendMode;
          ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
        }
      } else {
        // Baked sequence: draw as single canvas
        ctx.globalCompositeOperation = item.blendMode;
        ctx.drawImage(item.canvas, 0, 0);
      }
    }

    // 2. Draw individual strokes (recent undo buffer)
    for (const stroke of group.strokeStack) {
      ctx.globalCompositeOperation = stroke.blendMode;
      ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    // 3. Draw active strokes (currently being drawn)
    for (const [, active] of group.activeStrokeByUser) {
      ctx.globalCompositeOperation = active.blendMode;
      ctx.drawImage(active.canvas, 0, 0);
    }

    ctx.globalCompositeOperation = 'source-over';
  }
  /**
   * Composite a range of layer groups onto a target context.
   *
   * For groups WITHOUT destination-out (eraser) strokes, all strokes are drawn
   * directly onto targetCtx so blend modes like multiply correctly blend against
   * the accumulated lower-layer content.
   *
   * For groups WITH destination-out strokes:
   *   - If group has ONLY source-over + destination-out: use "Isolated Group Buffering" (O(N))
   *   - If group has complex blend modes (multiply, etc.): use sequential snapshot/restore (O(N*E))
   *     because those blend modes need to interact with the accumulated background.
   *
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} startIdx - Inclusive start index
   * @param {number} endIdx - Exclusive end index
   * @param {Array|null} backgroundColor - [r,g,b,a] or null for transparent background
   * @param {Array|null} dirtyRects - Optional array of {x, y, width, height} to limit redraw area
   */
  compositeLayerRange(targetCtx, startIdx, endIdx, backgroundColor = null, dirtyRects = null) {
    // Sync backgroundColor so _compositeGroupWithFlatCanvas uses the same value
    if (backgroundColor) this.backgroundColor = backgroundColor;

    // Multi-rect dirty-region optimization
    let useDirtyRects = false;
    let totalDirtyArea = 0;

    if (dirtyRects && Array.isArray(dirtyRects) && dirtyRects.length > 0) {
      // Calculate total area covered by all dirty rects
      totalDirtyArea = dirtyRects.reduce((sum, r) => sum + (r.width * r.height), 0);
      const canvasArea = this.width * this.height;

      // Use multi-rect optimization if total dirty area < 50% of canvas
      useDirtyRects = totalDirtyArea < (canvasArea * 0.5);
    }

    if (useDirtyRects) {
      // Clear each dirty region independently
      for (const rect of dirtyRects) {
        targetCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      // Full canvas clear (dirty rects too large or null/empty)
      targetCtx.clearRect(0, 0, this.width, this.height);
      dirtyRects = null; // Signal full redraw below
    }

    if (backgroundColor) {
      const [r, g, b, a] = backgroundColor;
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      if (useDirtyRects) {
        // Fill each dirty region with background
        for (const rect of dirtyRects) {
          targetCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
      } else {
        targetCtx.fillRect(0, 0, this.width, this.height);
      }
    }

    // Skip clipping for multi-rect (benefit comes from reduced clear/fill operations)
    // Drawing operations will naturally be bounded by the cleared regions

    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible) continue;

      if (group.flatCanvas) {
        // Layer 0: always use the flat-canvas path — background is pre-embedded so
        // all blend modes (including non-associative ones) are mathematically correct.
        this._compositeGroupWithFlatCanvas(targetCtx, group);
      } else if (this._groupHasDestOut(group)) {
        if (this._groupHasComplexBlendModes(group)) {
          // Fall back to sequential approach for correctness with complex blend modes
          this._compositeGroupSequential(targetCtx, group);
        } else {
          // Fast path: isolated buffering for simple source-over + eraser groups
          this._compositeGroupIsolated(targetCtx, group);
        }
      } else {
        // No destination-out: draw directly so blend modes (multiply, difference…)
        // blend against the accumulated lower-layer content in targetCtx.
        this._compositeGroupInto(targetCtx, group);
      }
    }

    targetCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Composite Layer 0 using its pre-composited flat canvas.
   * The flat canvas already contains backgroundColor + all baked strokes composited
   * in correct sequential order. Unbaked strokes (strokeStack + active) are applied
   * on top using an isolated buffer so erasers don't bleed into the flat canvas.
   *
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {Object} group - Must have group.flatCanvas set
   */
  _compositeGroupWithFlatCanvas(targetCtx, group) {
    const hasUnbaked = group.strokeStack.length > 0 || group.activeStrokeByUser.size > 0;

    if (!hasUnbaked) {
      // Fast path: nothing unbaked — just stamp the flat canvas
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.drawImage(group.flatCanvas, 0, 0);
      return;
    }

    // Use the shared group buffer as a scratch canvas.
    // Pre-fill with backgroundColor so that transparent holes in flatCanvas (from baked
    // erasers) are treated as the background colour during blend mode computation.
    // Without this, a `difference` stroke over an erased area would compute against
    // transparent (0,0,0,0) instead of white, giving the wrong result.
    const { canvas: buffer, ctx: bufferCtx } = this._getGroupBuffer();
    bufferCtx.clearRect(0, 0, this.width, this.height);
    const [r, g, b, a] = this.backgroundColor;
    bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    bufferCtx.fillRect(0, 0, this.width, this.height);
    bufferCtx.globalCompositeOperation = 'source-over';
    bufferCtx.drawImage(group.flatCanvas, 0, 0);

    // Process strokes, filling holes after each eraser so subsequent blend modes
    // compute against backgroundColor instead of transparent
    for (const stroke of group.strokeStack) {
      bufferCtx.globalCompositeOperation = stroke.blendMode;
      bufferCtx.globalAlpha = 1.0;
      bufferCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
      if (stroke.blendMode === 'destination-out') {
        // Fill eraser holes with background color so blend modes compute correctly
        bufferCtx.globalCompositeOperation = 'destination-over';
        bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        bufferCtx.fillRect(0, 0, this.width, this.height);
        bufferCtx.globalCompositeOperation = 'source-over';
      }
    }

    for (const [, active] of group.activeStrokeByUser) {
      bufferCtx.globalCompositeOperation = active.blendMode;
      bufferCtx.drawImage(active.canvas, 0, 0);
      if (active.blendMode === 'destination-out') {
        bufferCtx.globalCompositeOperation = 'destination-over';
        bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        bufferCtx.fillRect(0, 0, this.width, this.height);
      }
    }

    // Final fill to ensure no transparent holes remain (belt and suspenders)
    bufferCtx.globalCompositeOperation = 'destination-over';
    bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    bufferCtx.fillRect(0, 0, this.width, this.height);

    bufferCtx.globalCompositeOperation = 'source-over';

    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(buffer, 0, 0);
  }

  /**
   * Composite a layer group with erasers using the sequential snapshot/restore approach.
   * This is O(N*E) but handles complex blend modes correctly by allowing them to
   * interact with the accumulated background.
   *
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {Object} group
   */
  _compositeGroupSequential(targetCtx, group) {
    // Snapshot lower layers already in targetCtx
    const lowerSnap = document.createElement('canvas');
    lowerSnap.width = this.width;
    lowerSnap.height = this.height;
    lowerSnap.getContext('2d').drawImage(targetCtx.canvas, 0, 0);

    // Draw baked sequences and compressed groups in chronological order
    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStrokeSequential(targetCtx, stroke, lowerSnap);
        }
      } else {
        this._compositeStrokeSequential(targetCtx, { canvas: item.canvas, blendMode: item.blendMode }, lowerSnap);
      }
    }

    // Draw all strokes in strict chronological order
    for (const stroke of group.strokeStack) {
      this._compositeStrokeSequential(targetCtx, stroke, lowerSnap);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStrokeSequential(targetCtx, active, lowerSnap);
    }

    targetCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Helper to render a single stroke with eraser-aware logic (sequential approach).
   * For erasers: punch hole then restore background. For others: normal blend.
   */
  _compositeStrokeSequential(ctx, stroke, lowerSnap) {
    const x = stroke.x ?? 0;
    const y = stroke.y ?? 0;

    if (stroke.blendMode === 'destination-out') {
      // Erase current content (cut hole)
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(stroke.canvas, x, y);
      // Restore lower layers into the hole
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(lowerSnap, 0, 0);
    } else {
      ctx.globalCompositeOperation = stroke.blendMode;
      ctx.drawImage(stroke.canvas, x, y);
    }
  }

  /**
   * Composite a layer group with eraser strokes using isolated buffering.
   * All strokes are rendered into a transparent buffer first, then the buffer
   * is drawn onto the target canvas. This makes eraser performance O(N) instead
   * of O(N*E) because erasers only punch holes in the buffer, not the accumulated
   * background.
   *
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {Object} group
   */
  _compositeGroupIsolated(targetCtx, group) {
    const { canvas: buffer, ctx: bufferCtx } = this._getGroupBuffer();
    bufferCtx.clearRect(0, 0, this.width, this.height);

    // 1. Draw all baked sequences and compressed groups into the transparent buffer
    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        // Compressed group: draw each stroke in order
        for (const stroke of item.strokes) {
          bufferCtx.globalCompositeOperation = stroke.blendMode;
          bufferCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
        }
      } else {
        // Baked sequence: draw as single canvas
        bufferCtx.globalCompositeOperation = item.blendMode;
        bufferCtx.drawImage(item.canvas, 0, 0);
      }
    }

    // 2. Draw stroke stack into the buffer
    for (const stroke of group.strokeStack) {
      bufferCtx.globalCompositeOperation = stroke.blendMode;
      bufferCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    // 3. Draw active strokes into the buffer
    for (const [, active] of group.activeStrokeByUser) {
      bufferCtx.globalCompositeOperation = active.blendMode;
      bufferCtx.drawImage(active.canvas, 0, 0);
    }

    bufferCtx.globalCompositeOperation = 'source-over';

    // 4. Composite the finished buffer onto the target canvas
    // The buffer already has holes punched by erasers, so we just draw it.
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(buffer, 0, 0);
  }

  /**
   * Composite all visible layer groups onto a target context.
   * Order per group: background → baseCanvas → stroke stack → active strokes.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {Array} [backgroundColor] - [r,g,b,a]
   */
  compositeLayers(targetCtx, backgroundColor) {
    // Cache bg for baking
    if (backgroundColor) this.backgroundColor = backgroundColor;

    this.compositeLayerRange(targetCtx, 0, this.layerGroups.length, backgroundColor || null);

    this.needsComposite = false;
    this._notifyHistoryPanel();
  }

  // ---------------------------------------------------------------------------
  // Layer Group Management
  // ---------------------------------------------------------------------------

  getLayerGroup(groupIndex) {
    return this.layerGroups[groupIndex];
  }

  getLayerCount() {
    return this.layerGroups.length;
  }

  isLayerVisible(index) {
    return this.layerGroups[index]?.visible ?? false;
  }

  toggleLayerVisibility(index) {
    if (this.layerGroups[index]) {
      this.layerGroups[index].visible = !this.layerGroups[index].visible;
      this.needsComposite = true;
      return this.layerGroups[index].visible;
    }
    return false;
  }

  setLayerVisibility(index, visible) {
    if (this.layerGroups[index]) {
      this.layerGroups[index].visible = visible;
      this.needsComposite = true;
    }
  }

  clear(index) {
    const group = this.layerGroups[index];
    if (group) {
      group.bakedSequences = [];
      group.strokeStack = [];
      group.userStrokeCounts.clear();
      group.activeStrokeByUser.clear();
      // Reset Layer 0's flat canvas back to the background color
      if (group.flatCanvas) {
        group.flatCtx.clearRect(0, 0, this.width, this.height);
        const [r, g, b, a] = this.backgroundColor;
        group.flatCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        group.flatCtx.fillRect(0, 0, this.width, this.height);
      }
      this.needsComposite = true;
      this._notifyHistoryPanel();
    }
  }

  clearAll() {
    for (let i = 0; i < this.layerGroups.length; i++) {
      this.clear(i);
    }
    // Clear all redo stacks
    this.redoStackByUser.clear();
    this._notifyHistoryPanel();
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    // Clear the group buffer so it gets recreated with new dimensions
    this._groupBuffer = null;
    // Discard pooled canvases — they're the wrong size now
    this._canvasPool = [];

    for (const group of this.layerGroups) {
      // Resize baked sequences
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

      // Resize active stroke canvases
      for (const [, active] of group.activeStrokeByUser) {
        const temp2 = document.createElement('canvas');
        temp2.width = active.canvas.width;
        temp2.height = active.canvas.height;
        temp2.getContext('2d').drawImage(active.canvas, 0, 0);
        active.canvas.width = width;
        active.canvas.height = height;
        active.ctx.drawImage(temp2, 0, 0);
      }
      // Stroke stack records store cropped canvases at x,y — no resize needed

      // Resize Layer 0's flat canvas (preserves content, fills new space with bg color)
      if (group.flatCanvas) {
        const tempFlat = document.createElement('canvas');
        tempFlat.width = group.flatCanvas.width;
        tempFlat.height = group.flatCanvas.height;
        tempFlat.getContext('2d').drawImage(group.flatCanvas, 0, 0);
        group.flatCanvas.width = width;
        group.flatCanvas.height = height;
        const [r, g, b, a] = this.backgroundColor;
        group.flatCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        group.flatCtx.fillRect(0, 0, width, height);
        group.flatCtx.drawImage(tempFlat, 0, 0);
      }
    }

    this.needsComposite = true;
  }

  getCompositedImageData() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tempCtx = tempCanvas.getContext('2d');
    this.compositeLayers(tempCtx);
    return tempCtx.getImageData(0, 0, this.width, this.height);
  }

  getLayerData() {
    return this.layerGroups.map(group => ({
      id: group.id,
      name: group.name,
      visible: group.visible,
      strokeCount: group.strokeStack.length
    }));
  }

  // ---------------------------------------------------------------------------
  // Backward-Compat Stubs
  // ---------------------------------------------------------------------------

  /** @deprecated Use getUserStrokeContext(groupIndex, userId) */
  getLayerContext(groupIndex, userId, createBlendMode = 'source-over') {
    return this.getUserStrokeContext(groupIndex, userId, createBlendMode);
  }

  /** @deprecated Use beginUserStroke(groupIndex, userId, blendMode) */
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
   * Clean up all active strokes for a user across all layers.
   * Call this when a user disconnects to prevent orphaned active stroke canvases.
   * @param {number} userId - User's session index
   */
  cleanupUserStrokes(userId) {
    for (const group of this.layerGroups) {
      const active = group.activeStrokeByUser.get(userId);
      if (active) {
        group.activeStrokeByUser.delete(userId);
        this._releaseCanvas(active);
      }
    }
    // Trigger recomposite to remove the orphaned stroke from display
    this.needsComposite = true;
  }

  /** @deprecated No-op */
  mergeAdjacentSourceOverSubLayers(groupIndex, userId) {}

  /** @deprecated No-op */
  flattenLayerGroup(groupIndex, backgroundColor) {}

  /** @deprecated No-op */
  cleanupEmptySubLayers(groupIndex, userId) {}
}
