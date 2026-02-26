/**
 * LayerManager - Manages multiple off-screen canvas layers with stroke history
 *
 * Each layer group maintains:
 *  - baseCanvas: full-size baked history canvas (oldest strokes composited in)
 *  - strokeStack: ordered list of completed stroke records [{canvas, x, y, w, h, blendMode, userId}]
 *  - userStrokeCounts: Map of userId → count of their strokes in the stack
 *  - activeStrokeByUser: Map of userId → in-progress stroke {canvas, ctx, blendMode}
 *
 * Composite order per group:
 *   background → baseCanvas (source-over) → activeStrokes (each with blendMode)
 *   → strokeStack entries (each at x,y with blendMode)
 *
 * Baking: when any user exceeds MAX_STROKES_PER_USER, the oldest strokes are
 * shifted from the bottom of strokeStack and composited into baseCanvas.
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

    this.initLayerGroups(3);
  }

  /**
   * Notify the stroke history panel to update (if enabled)
   */
  _notifyHistoryPanel() {
    if (this.strokeHistoryPanel) {
      this.strokeHistoryPanel.queueUpdate();
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

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  initLayerGroups(count) {
    for (let i = 0; i < count; i++) {
      const { canvas: baseCanvas, ctx: baseCtx } = this._createCanvas();
      this.layerGroups.push({
        id: i,
        name: `Layer ${i + 1}`,
        visible: true,
        baseCanvas,
        baseCtx,
        strokeStack: [],          // completed stroke records
        userStrokeCounts: new Map(), // userId → count in strokeStack
        activeStrokeByUser: new Map() // userId → { canvas, ctx, blendMode }
      });
    }
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

    const { canvas, ctx } = this._createCanvas();
    group.activeStrokeByUser.set(userId, { canvas, ctx, blendMode });
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
      const { canvas, ctx } = this._createCanvas();
      active = { canvas, ctx, blendMode: createBlendMode };
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

    // Find non-transparent bounding box
    const bounds = this._findContentBounds(active.canvas);
    if (!bounds) return; // Empty stroke — discard

    const { x, y, width, height } = bounds;

    // Crop the full-size canvas to just the content area
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(active.canvas, x, y, width, height, 0, 0, width, height);

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

    if (group.activeStrokeByUser.has(userId)) {
      group.activeStrokeByUser.delete(userId);
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
    this._notifyHistoryPanel();
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
    this._notifyHistoryPanel();
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
    while (this._anyUserOverMax(group, MAX) && group.strokeStack.length > 0) {
      const stroke = group.strokeStack.shift();
      this._bakeStrokeToBase(group, stroke);
      const count = group.userStrokeCounts.get(stroke.userId) || 0;
      if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);
    }
  }

  _anyUserOverMax(group, max) {
    for (const count of group.userStrokeCounts.values()) {
      if (count > max) return true;
    }
    return false;
  }

  _bakeStrokeToBase(group, stroke) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Do NOT fill with backgroundColor here. Individual layers should remain 
    // transparent. Background is only for the final composite in compositeLayers().
    
    // Existing baked content
    tempCtx.globalCompositeOperation = 'source-over';
    tempCtx.drawImage(group.baseCanvas, 0, 0);

    // New stroke at its recorded position with its blend mode
    tempCtx.globalCompositeOperation = stroke.blendMode;
    tempCtx.drawImage(stroke.canvas, stroke.x, stroke.y);
    tempCtx.globalCompositeOperation = 'source-over';

    // Replace base with result
    group.baseCtx.clearRect(0, 0, this.width, this.height);
    group.baseCtx.drawImage(tempCanvas, 0, 0);
  }

  /**
   * Scan canvas pixels and return the bounding box of all non-transparent content.
   * @param {HTMLCanvasElement} canvas
   * @returns {{x,y,width,height}|null}
   */
  _findContentBounds(canvas) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const w = canvas.width;
    const h = canvas.height;

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
    if (group.strokeStack.some(s => s.blendMode === 'destination-out')) return true;
    for (const [, active] of group.activeStrokeByUser) {
      if (active.blendMode === 'destination-out') return true;
    }
    return false;
  }

  /**
   * Returns true if any layer in the range [startIdx, endIdx) has a non-source-over
   * stroke (committed or active). Used to decide whether split-mode compositing is safe.
   * @param {number} startIdx - Inclusive start index
   * @param {number} endIdx - Exclusive end index
   * @returns {boolean}
   */
  rangeHasBlendModeStrokes(startIdx, endIdx) {
    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible) continue;
      for (const stroke of group.strokeStack) {
        if (stroke.blendMode !== 'source-over') return true;
      }
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
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(group.baseCanvas, 0, 0);

    for (const stroke of group.strokeStack) {
      ctx.globalCompositeOperation = stroke.blendMode;
      ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
    }

    for (const [, active] of group.activeStrokeByUser) {
      ctx.globalCompositeOperation = active.blendMode;
      ctx.drawImage(active.canvas, 0, 0);
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Helper to render a single stroke (stored or active) onto the target context.
   * Handles eraser logic (erase + restore background) vs normal blending.
   */
  _compositeStroke(ctx, stroke, lowerSnap) {
    // For active strokes, x/y might be missing (implicit 0,0), but stored strokes have them.
    const x = stroke.x ?? 0;
    const y = stroke.y ?? 0;

    if (stroke.blendMode === 'destination-out') {
      // 1. Erase current content (cut hole)
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(stroke.canvas, x, y);
      
      // 2. Restore lower layers into the hole
      // destination-over draws *behind* existing pixels.
      // - Existing opaque pixels (from current layer) block lowerSnap.
      // - Existing transparent pixels (holes) show lowerSnap.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(lowerSnap, 0, 0);
    } else {
      // Normal blend mode (source-over, multiply, etc)
      ctx.globalCompositeOperation = stroke.blendMode;
      ctx.drawImage(stroke.canvas, x, y);
    }
  }

  /**
   * Composite a range of layer groups onto a target context.
   *
   * For groups WITHOUT destination-out (eraser) strokes, all strokes are drawn
   * directly onto targetCtx so blend modes like multiply correctly blend against
   * the accumulated lower-layer content.
   *
   * For groups WITH destination-out strokes:
   *   1. Snapshot targetCtx (lower layers accumulated so far) → lowerSnap
   *   2. Draw baseCanvas + all strokes IN ORDER.
   *      - Eraser strokes cut holes and immediately restore lowerSnap behind.
   *      - This ensures erasers only affect content drawn *before* them in the stack.
   *
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} startIdx - Inclusive start index
   * @param {number} endIdx - Exclusive end index
   * @param {Array|null} backgroundColor - [r,g,b,a] or null for transparent background
   */
  compositeLayerRange(targetCtx, startIdx, endIdx, backgroundColor = null) {
    targetCtx.clearRect(0, 0, this.width, this.height);

    if (backgroundColor) {
      const [r, g, b, a] = backgroundColor;
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      targetCtx.fillRect(0, 0, this.width, this.height);
    }

    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible) continue;

      if (this._groupHasDestOut(group)) {
        // --- Eraser-aware compositing (Sequential) ---
        // Step 1: snapshot lower layers already in targetCtx.
        const lowerSnap = document.createElement('canvas');
        lowerSnap.width = this.width;
        lowerSnap.height = this.height;
        lowerSnap.getContext('2d').drawImage(targetCtx.canvas, 0, 0);

        // Step 2: Draw base canvas
        targetCtx.globalCompositeOperation = 'source-over';
        targetCtx.drawImage(group.baseCanvas, 0, 0);

        // Step 3: Draw all strokes in strict chronological order
        for (const stroke of group.strokeStack) {
          this._compositeStroke(targetCtx, stroke, lowerSnap);
        }

        for (const [, active] of group.activeStrokeByUser) {
          this._compositeStroke(targetCtx, active, lowerSnap);
        }
        
        targetCtx.globalCompositeOperation = 'source-over';
        // --------------------------------
      } else {
        // No destination-out: draw directly so blend modes (multiply, difference…)
        // blend against the accumulated lower-layer content in targetCtx.
        this._compositeGroupInto(targetCtx, group);
      }
    }

    targetCtx.globalCompositeOperation = 'source-over';
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
      group.baseCtx.clearRect(0, 0, this.width, this.height);
      group.strokeStack = [];
      group.userStrokeCounts.clear();
      group.activeStrokeByUser.clear();
      this.needsComposite = true;
      this._notifyHistoryPanel();
    }
  }

  clearAll() {
    for (let i = 0; i < this.layerGroups.length; i++) {
      this.clear(i);
    }
    this._notifyHistoryPanel();
  }

  resize(width, height) {
    this.width = width;
    this.height = height;

    for (const group of this.layerGroups) {
      // Resize base canvas, preserving content
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = group.baseCanvas.width;
      tempCanvas.height = group.baseCanvas.height;
      tempCanvas.getContext('2d').drawImage(group.baseCanvas, 0, 0);
      group.baseCanvas.width = width;
      group.baseCanvas.height = height;
      group.baseCtx.lineCap = 'round';
      group.baseCtx.lineJoin = 'round';
      group.baseCtx.imageSmoothingQuality = 'high';
      group.baseCtx.drawImage(tempCanvas, 0, 0);

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

  /** @deprecated No-op */
  mergeAdjacentSourceOverSubLayers(groupIndex, userId) {}

  /** @deprecated No-op */
  flattenLayerGroup(groupIndex, backgroundColor) {}

  /** @deprecated No-op */
  cleanupEmptySubLayers(groupIndex, userId) {}
}
