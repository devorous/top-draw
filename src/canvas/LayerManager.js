/**
 * @fileoverview LayerManager - Manages multiple off-screen canvas layers with stroke history
 */

import { blurImageData, getStackblurSync } from '../utils/blurUtils.js';

/**
 * Manages multiple layer groups, each containing baked sequences, a stroke stack,
 * and active strokes for users. Handles compositing and baking of strokes.
 */
export class LayerManager {
  static MAX_STROKES_PER_USER = 10;

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
    this.CANVAS_POOL_MAX = 12;
    this.onNeedsUpdate = null; // Callback for Board to requestUpdate

    this.initLayerGroups(3);
  }

  /**
   * Notify the stroke history panel to update
   * @param {boolean} [immediate=false] - If true, update immediately
   * @private
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
   * Acquire a full-size canvas from the pool
   * @returns {Object} {canvas, ctx}
   * @private
   */
  _acquireCanvas() {
    if (this._canvasPool.length > 0) {
      const c = this._canvasPool.pop();
      c.ctx.globalAlpha = 1;
      c.ctx.clearRect(0, 0, this.width, this.height);
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
      canvasObj.ctx.clearRect(0, 0, this.width, this.height);
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
        userStrokeCounts: new Map(),
        activeStrokeByUser: new Map(),
        flatCanvas: null,
        flatCtx: null
      };

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
  beginUserStroke(groupIdx, userId, blendMode = 'source-over') {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const { canvas, ctx } = this._acquireCanvas();
    group.activeStrokeByUser.set(userId, {
      canvas,
      ctx,
      blendMode,
      dirtyRect: { minX: this.width, minY: this.height, maxX: -1, maxY: -1 }
    });
    this.needsComposite = true;
    this._notifyHistoryPanel();
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
        dirtyRect: { minX: this.width, minY: this.height, maxX: -1, maxY: -1 },
        ...metadata
      };
      if (metadata.filterType === 'blur') {
        active.maskCanvas = canvas;
      }
      group.activeStrokeByUser.set(userId, active);
    } else if (createBlendMode !== 'source-over' && active.blendMode !== createBlendMode) {
      active.blendMode = createBlendMode;
    }
    return active.ctx;
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

    // Handle filter strokes (blur) differently - they need metadata and potentially special rendering
    if (extraProps.filterType === 'blur') {
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
        timestamp: Date.now(),
        filterType: 'blur',
        blurRadius: extraProps.blurRadius,
        maskCanvas: active.canvas
      };

      group.strokeStack.push(record);
      const prev = group.userStrokeCounts.get(userId) || 0;
      group.userStrokeCounts.set(userId, prev + 1);

      this._bakeOverflowStrokes(group);
      this._clearRedoStack(userId);
      this.needsComposite = true;
      this._notifyHistoryPanel();
      return;
    }

    // Regular stroke handling
    const dr = active.dirtyRect;
    let bounds;
    if (dr && dr.maxX !== -1) {
      const bx = Math.max(0, dr.minX);
      const by = Math.max(0, dr.minY);
      const bw = Math.min(active.canvas.width, dr.maxX + 1) - bx;
      const bh = Math.min(active.canvas.height, dr.maxY + 1) - by;
      if (bw > 0 && bh > 0) {
        bounds = { x: bx, y: by, width: bw, height: bh };
      } else {
        bounds = this._findContentBoundsLegacy(active.canvas);
      }
    } else {
      this._releaseCanvas(active);
      return;
    }

    if (!bounds) {
      this._releaseCanvas(active);
      return;
    }

    const { x, y, width, height } = bounds;
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = width;
    croppedCanvas.height = height;
    const croppedCtx = croppedCanvas.getContext('2d');
    croppedCtx.drawImage(active.canvas, x, y, width, height, 0, 0, width, height);

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
      this._notifyHistoryPanel();
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

    let insertIdx = group.strokeStack.findIndex(s => s.timestamp > record.timestamp);
    if (insertIdx === -1) insertIdx = group.strokeStack.length;

    group.strokeStack.splice(insertIdx, 0, record);

    const prev = group.userStrokeCounts.get(record.userId) || 0;
    group.userStrokeCounts.set(record.userId, prev + 1);
    this.needsComposite = true;
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
   * @returns {Array|null} The undone stroke batch
   */
  undoLastStrokeGlobal(userId) {
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
    this.cleanupEmptySequencesAll();
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
    const isBaseLayer = group.id === 0;
    const safeModes = ['source-over', 'destination-out', 'multiply', 'darken', 'lighten', 'screen'];

    let i = 0;
    while (i < group.strokeStack.length && this._anyUserOverMax(group, MAX)) {
      const stroke = group.strokeStack[i];

      if (isBaseLayer || safeModes.includes(stroke.blendMode)) {
        this._bakeStrokeToBin(group, stroke);
        group.strokeStack.splice(i, 1);

        const count = group.userStrokeCounts.get(stroke.userId) || 0;
        if (count > 0) group.userStrokeCounts.set(stroke.userId, count - 1);
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
    }
  }

  /**
   * Check if any user has exceeded the max strokes limit
   * @param {Object} group - Layer group
   * @param {number} max - Max strokes
   * @returns {boolean}
   * @private
   */
  _anyUserOverMax(group, max) {
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

  /**
   * Bake a single stroke into a sequence bin
   * @param {Object} group - Layer group
   * @param {Object} stroke - Stroke record
   * @private
   */
  _bakeStrokeToBin(group, stroke) {
    // Handle blur filter strokes specially - resolve to actual pixels
    if (stroke.filterType === 'blur') {
      this._bakeBlurStroke(group, stroke);
      return;
    }

    if (group.flatCanvas) {
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

    const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];

    let targetBin;
    if (lastSeq && lastSeq.blendMode === stroke.blendMode) {
      targetBin = lastSeq;
    } else {
      targetBin = this._createCanvas();
      targetBin.blendMode = stroke.blendMode;
      group.bakedSequences.push(targetBin);
    }

    targetBin.ctx.globalCompositeOperation = (stroke.blendMode === 'destination-out')
      ? 'source-over'
      : stroke.blendMode;

    targetBin.ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
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
        return;
      }
      const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];
      let targetBin;
      if (lastSeq && lastSeq.blendMode === 'source-over') {
        targetBin = lastSeq;
      } else {
        targetBin = this._createCanvas();
        targetBin.blendMode = 'source-over';
        group.bakedSequences.push(targetBin);
      }
      targetBin.ctx.drawImage(stroke._cachedBlurResult, x, y);
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
    } else {
      const lastSeq = group.bakedSequences[group.bakedSequences.length - 1];
      let targetBin;
      if (lastSeq && lastSeq.blendMode === 'source-over') {
        targetBin = lastSeq;
      } else {
        targetBin = this._createCanvas();
        targetBin.blendMode = 'source-over';
        group.bakedSequences.push(targetBin);
      }
      targetBin.ctx.drawImage(blurred, cropX, cropY);
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
   * Remove empty sequences from a specific layer group
   * @param {number} groupIdx - Layer index
   */
  cleanupEmptyBins(groupIdx) {
    const group = this.layerGroups[groupIdx];
    if (!group) return;

    const hasEraserInHistory = this._hasEraserInHistory(group);
    if (hasEraserInHistory) return;

    group.bakedSequences = group.bakedSequences.filter(seq => this._hasContent(seq.canvas));
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
   * Full-canvas scan for content bounds
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
    }
    return false;
  }

  /**
   * Composite all strokes for a single group into a context
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupInto(ctx, group) {
    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStroke(ctx, stroke, false);
        }
      } else {
        this._compositeStroke(ctx, item, false);
      }
    }

    for (const stroke of group.strokeStack) {
      this._compositeStroke(ctx, stroke, false);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStroke(ctx, active, true);
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
  _compositeStroke(ctx, stroke, isActive = false) {
    if (stroke.filterType === 'blur') {
      this._applyBlurFilter(ctx, stroke, isActive);
    } else {
      ctx.globalCompositeOperation = stroke.blendMode;
      if (stroke.x !== undefined && stroke.y !== undefined) {
        ctx.drawImage(stroke.canvas, stroke.x, stroke.y);
      } else {
        ctx.drawImage(stroke.canvas, 0, 0);
      }
    }
  }

  /**
   * Apply a blur filter stroke to the context
   * For active strokes, use a cheap CSS filter preview.
   * For committed strokes, use the high-quality cached result.
   * @param {CanvasRenderingContext2D} ctx - Target context
   * @param {Object} filterStroke - Filter stroke with mask and blur radius
   * @param {boolean} isActive - Whether the stroke is in progress
   * @private
   */
  _applyBlurFilter(ctx, filterStroke, isActive) {
    const { maskCanvas, blurRadius, x, y, width, height } = filterStroke;
    if (!maskCanvas || !blurRadius) return;

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
      ctx.drawImage(filterStroke._cachedBlurResult, x, y);
      return;
    }

    // If the high-quality calc hasn't started, kick it off now.
    if (!filterStroke._isBlurring) {
      filterStroke._isBlurring = true;
      
      const cropX = x;
      const cropY = y;
      const cropW = width;
      const cropH = height;

      const tempForAsync = document.createElement('canvas');
      tempForAsync.width = cropW;
      tempForAsync.height = cropH;
      const tCtxForAsync = tempForAsync.getContext('2d');
      tCtxForAsync.drawImage(ctx.canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      const imageData = tCtxForAsync.getImageData(0, 0, cropW, cropH);
      
      blurImageData(imageData, cropW, cropH, blurRadius).then(blurred => {
        tCtxForAsync.putImageData(blurred, 0, 0);

        const composite = document.createElement('canvas');
        composite.width = cropW;
        composite.height = cropH;
        const cCtx = composite.getContext('2d');

        cCtx.drawImage(maskCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        cCtx.globalCompositeOperation = 'source-in';
        cCtx.drawImage(tempForAsync, 0, 0);

        filterStroke._cachedBlurResult = composite;
        this.needsComposite = true;
        if (this.onNeedsUpdate) this.onNeedsUpdate();
      });
    }

    // For this frame, draw the fast preview to avoid a flash while the HQ version is processing.
    renderFastPreview();
  }

  /**
   * Composite a range of layer groups onto a target context
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {number} startIdx - Start index
   * @param {number} endIdx - End index
   * @param {Array|null} [backgroundColor=null] - [r, g, b, a]
   * @param {Array|null} [dirtyRects=null] - Array of dirty rectangles
   */
  compositeLayerRange(targetCtx, startIdx, endIdx, backgroundColor = null, dirtyRects = null) {
    if (backgroundColor) this.backgroundColor = backgroundColor;

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

    const count = Math.min(endIdx, this.layerGroups.length);
    for (let i = startIdx; i < count; i++) {
      const group = this.layerGroups[i];
      if (!group.visible) continue;

      if (group.flatCanvas) {
        this._compositeGroupWithFlatCanvas(targetCtx, group);
      } else if (this._groupHasDestOut(group)) {
        if (this._groupHasComplexBlendModes(group)) {
          this._compositeGroupSequential(targetCtx, group);
        } else {
          this._compositeGroupIsolated(targetCtx, group);
        }
      } else {
        this._compositeGroupInto(targetCtx, group);
      }
    }

    targetCtx.globalCompositeOperation = 'source-over';
  }

  /**
   * Composite Layer 0 using its flat canvas
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupWithFlatCanvas(targetCtx, group) {
    const hasUnbaked = group.strokeStack.length > 0 || group.activeStrokeByUser.size > 0;

    if (!hasUnbaked) {
      targetCtx.globalCompositeOperation = 'source-over';
      targetCtx.drawImage(group.flatCanvas, 0, 0);
      return;
    }

    const { canvas: buffer, ctx: bufferCtx } = this._getGroupBuffer();
    bufferCtx.clearRect(0, 0, this.width, this.height);
    const [r, g, b, a] = this.backgroundColor;
    bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    bufferCtx.fillRect(0, 0, this.width, this.height);
    bufferCtx.globalCompositeOperation = 'source-over';
    bufferCtx.drawImage(group.flatCanvas, 0, 0);

    for (const stroke of group.strokeStack) {
      this._compositeStroke(bufferCtx, stroke, false);
      if (stroke.blendMode === 'destination-out') {
        bufferCtx.globalCompositeOperation = 'destination-over';
        bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        bufferCtx.fillRect(0, 0, this.width, this.height);
        bufferCtx.globalCompositeOperation = 'source-over';
      }
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStroke(bufferCtx, active, true);
      if (active.blendMode === 'destination-out') {
        bufferCtx.globalCompositeOperation = 'destination-over';
        bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        bufferCtx.fillRect(0, 0, this.width, this.height);
      }
    }

    bufferCtx.globalCompositeOperation = 'destination-over';
    bufferCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    bufferCtx.fillRect(0, 0, this.width, this.height);

    bufferCtx.globalCompositeOperation = 'source-over';

    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(buffer, 0, 0);
  }

  /**
   * Composite a layer group with erasers using sequential approach
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupSequential(targetCtx, group) {
    const lowerSnap = document.createElement('canvas');
    lowerSnap.width = this.width;
    lowerSnap.height = this.height;
    lowerSnap.getContext('2d').drawImage(targetCtx.canvas, 0, 0);

    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStrokeSequential(targetCtx, stroke, lowerSnap, false);
        }
      } else {
        this._compositeStrokeSequential(targetCtx, { canvas: item.canvas, blendMode: item.blendMode }, lowerSnap, false);
      }
    }

    for (const stroke of group.strokeStack) {
      this._compositeStrokeSequential(targetCtx, stroke, lowerSnap, false);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStrokeSequential(targetCtx, active, lowerSnap, true);
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
  _compositeStrokeSequential(ctx, stroke, lowerSnap, isActive = false) {
    if (stroke.filterType === 'blur') {
      this._applyBlurFilter(ctx, stroke, isActive);
      return;
    }

    const x = stroke.x ?? 0;
    const y = stroke.y ?? 0;

    if (stroke.blendMode === 'destination-out') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(stroke.canvas, x, y);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(lowerSnap, 0, 0);
    } else {
      ctx.globalCompositeOperation = stroke.blendMode;
      ctx.drawImage(stroke.canvas, x, y);
    }
  }

  /**
   * Composite a layer group with erasers using isolated buffering
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Object} group - Layer group
   * @private
   */
  _compositeGroupIsolated(targetCtx, group) {
    const { canvas: buffer, ctx: bufferCtx } = this._getGroupBuffer();
    bufferCtx.clearRect(0, 0, this.width, this.height);

    for (const item of group.bakedSequences) {
      if (item.type === 'group') {
        for (const stroke of item.strokes) {
          this._compositeStroke(bufferCtx, stroke, false);
        }
      } else {
        this._compositeStroke(bufferCtx, item, false);
      }
    }

    for (const stroke of group.strokeStack) {
      this._compositeStroke(bufferCtx, stroke, false);
    }

    for (const [, active] of group.activeStrokeByUser) {
      this._compositeStroke(bufferCtx, active, true);
    }

    bufferCtx.globalCompositeOperation = 'source-over';

    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(buffer, 0, 0);
  }

  /**
   * Composite all visible layer groups onto a target context
   * @param {CanvasRenderingContext2D} targetCtx - Target context
   * @param {Array} [backgroundColor] - [r, g, b, a]
   */
  compositeLayers(targetCtx, backgroundColor) {
    if (backgroundColor) this.backgroundColor = backgroundColor;

    this.compositeLayerRange(targetCtx, 0, this.layerGroups.length, backgroundColor || null);

    this.needsComposite = false;
    this._notifyHistoryPanel();
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
      group.bakedSequences = [];
      group.strokeStack = [];
      group.userStrokeCounts.clear();
      group.activeStrokeByUser.clear();
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

  /**
   * Clear all content from all layer groups
   */
  clearAll() {
    for (let i = 0; i < this.layerGroups.length; i++) {
      this.clear(i);
    }
    this.redoStackByUser.clear();

    // Clear canvas pool to prevent old content from reappearing
    this._canvasPool = [];
    // Clear group buffer
    this._groupBuffer = null;

    this._notifyHistoryPanel();
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
        const [r, g, b, a] = this.backgroundColor;
        group.flatCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        group.flatCtx.fillRect(0, 0, width, height);
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
    }
    this.needsComposite = true;
  }

  /** @deprecated No-op */
  mergeAdjacentSourceOverSubLayers(groupIndex, userId) {}

  /** @deprecated No-op */
  flattenLayerGroup(groupIndex, backgroundColor) {}

  /** @deprecated No-op */
  cleanupEmptySubLayers(groupIndex, userId) {}
}
