/**
 * @fileoverview Glitch Blur tool - identical to BlurTool but forces the
 * stackblur_rgba_glitch algorithm, producing a directional smear artifact.
 */

import * as wasm from '../wasm/ddraw_wasm.js';
import { Tool } from './BaseTool.js';

export class GlitchBlurTool extends Tool {
  constructor(board) {
    super('glitchBlur', board);
    this.lastStampPos = new Map();
    this.strokePoints = new Map(); // userId -> [{x, y}, ...]
    this.snapshotCanvases = new Map(); // userId -> canvas
    this.deferredJobs = new Map();    // userId -> [job, ...] (fast-preview worker queue)
    this._prevGlitchSetting = false;
  }

  activate() {}

  _getTargetLayers() {
    const count = this.board.layerManager?.getLayerCount?.() ?? 0;
    return Array.from({ length: Math.min(3, count) }, (_, layerIdx) => layerIdx);
  }

  _getSnapshotKey(userId, layerIdx) {
    return `${userId}:${layerIdx}`;
  }

  _beginTargetLayerStrokes(user, userId) {
    for (const layerIdx of this._getTargetLayers()) {
      this.captureSnapshot(userId, layerIdx);
      // The snapshot the glitch samples is the DISPLAYED appearance (blend
      // already resolved against the background — see captureSnapshot). So the
      // glitch result must be deposited source-over: re-applying the live blend
      // here would composite the already-blended colour a second time (e.g.
      // white 'difference' over white → black) and undo the whole point.
      this.board.layerManager?.beginUserStroke(layerIdx, userId, 'source-over', 'background');
      this.board.applySelectionMaskClipForStroke?.(layerIdx, userId);
    }
  }

  _endTargetLayerStrokes(user, userId, contentLayers = null) {
    const timestamp = Date.now();
    // When we're the local connected drawer, each committed glitch stroke is
    // optimistic (seq=0) and will be reconciled by its layer's GLITCH_RESULT
    // self-echo — NOT by the MU echo (which would grab the wrong/earlier seq and
    // diverge from observers, who commit each glitch layer at its GLITCH_RESULT
    // seq). Tag so the MU reconciler skips it; the glitch_result self branch
    // assigns the authoritative per-layer seq. See DrawingHandlers 'glitch_result'.
    const tagGlitch = user === this.board.app?.self && !!this.board.app?.connected;
    for (const layerIdx of this._getTargetLayers()) {
      this.board.releaseSelectionMaskClipForStroke?.(layerIdx, userId);

      // A glitch stroke begins on every target layer, but layers with nothing
      // under the brush produce an empty (fully transparent) stroke. Committing
      // those would push phantom undo records — so one glitch stroke would take
      // several undo presses to remove. Discard the empty layers instead; only
      // layers that actually received glitch pixels (and were broadcast) become
      // undoable. contentLayers is null only when we couldn't scan (non-self),
      // in which case we keep the original commit-all behaviour.
      if (contentLayers && !contentLayers.has(layerIdx)) {
        this.board.layerManager?.cancelUserStroke(layerIdx, userId);
        continue;
      }

      const extra = tagGlitch ? { timestamp, pendingCommitEcho: 'glitch' } : { timestamp };
      this.board.layerManager?.commitUserStroke(layerIdx, userId, extra);
    }
    this.board._compositeCommittedStrokeNow?.();
  }

  _markDirtyPathOnTargetLayers(user, points) {
    if (!points?.length || !this.board.layerManager || !this.board.tileTracker) return;

    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const radius = user.size;
    const collect = (layerIdx, pathPoints) => {
      const active = this.board.layerManager.getLayerGroup(layerIdx)?.activeStrokeByUser?.get(userId);
      if (active?.affectedTiles) {
        this.board.tileTracker.collectTilesFromPath(pathPoints, radius, active.affectedTiles);
      }
    };

    for (const layerIdx of this._getTargetLayers()) {
      collect(layerIdx, points);
      this.board.forEachMirrorRegion({ points }, (region) => {
        collect(layerIdx, this.board.mirrorPointsToRegion(points, region));
      });
    }
  }

  deactivate() {
    if (this._activeUser) {
      const lastPos = this.lastStampPos.get(this._activeUser.id);
      if (lastPos) {
        this.onPointerUp(this._activeUser, lastPos);
      }
    }
    this.lastStampPos.clear();
    this.snapshotCanvases.clear();
    this._cancelAllDeferredJobs();
    // Clear any lingering preview
    if (this.board.topCtx) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    this._activeUser = null;
  }

  /** Marks every queued worker job cancelled so late results are ignored. */
  _cancelAllDeferredJobs() {
    for (const jobs of this.deferredJobs.values()) {
      for (const job of jobs) job.cancelled = true;
    }
    this.deferredJobs.clear();
  }

  _getTargetLayer(user) {
    return user?.activeLayer ?? this.board.app?.self?.activeLayer ?? 0;
  }

  captureSnapshot(userId, layerIdx) {
    const key = this._getSnapshotKey(userId, layerIdx);
    let canvas = this.snapshotCanvases.get(key);
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.snapshotCanvases.set(key, canvas);
    }
    canvas.width = this.board.getWidth();
    canvas.height = this.board.getHeight();
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // The glitch algorithm smears whatever is in this snapshot, so it must see
    // the layer as it's DISPLAYED — not the raw stroke pixels. Complex blend
    // modes are layer-0-only and resolve against the background (e.g. a black
    // 'difference' stroke displays white over a white board). Compositing layer
    // 0 WITH the background backdrop makes the glitch operate on that displayed
    // colour; without it the glitch would smear raw black and come out far too
    // harsh. Overlay layers (1+) have no complex blends, so their raw pixels are
    // already their displayed colour — keep them transparent so the glitch
    // doesn't flood empty regions with an opaque background.
    const bgColor = layerIdx === 0
      ? (this.board.getCompositeBackgroundColor?.() ?? this.board.backgroundColor ?? null)
      : null;
    this.board.layerManager.compositeLayerRange(ctx, layerIdx, layerIdx + 1, bgColor);
  }

  clearSnapshot(userId) {
    for (const layerIdx of this._getTargetLayers()) {
      this.snapshotCanvases.delete(this._getSnapshotKey(userId, layerIdx));
    }
  }

  onPointerDown(user, pos) {
    this._activeUser = user;
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const rawBlurRadius = Number(user.blurRadius);
    user.blurRadius = Math.max(1, Math.min(25, Number.isFinite(rawBlurRadius) ? rawBlurRadius : 10));

    this._beginTargetLayerStrokes(user, userId);

    user.blurBounds = {
      minX: Infinity, minY: Infinity,
      maxX: -Infinity, maxY: -Infinity
    };

    // Get preview context and clear it once at the start
    let previewCtx = null;
    if (user === this.board.app?.self) {
      previewCtx = this.board.topCtx;
      previewCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    } else if (user.context) {
      previewCtx = user.context;
      previewCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    this.strokePoints.set(userId, [{ x: pos.x, y: pos.y }]);

    // In fast-preview mode the expensive WASM glitch is offloaded to the pixels
    // worker (see _enqueueDeferredStamp) so it never blocks the main thread.
    // The glitch samples a snapshot frozen at pointerDown, so computing stamps
    // off-thread (and finishing any stragglers on release) is equivalent to
    // stamping them synchronously here.
    if (this._isDeferRender(user)) {
      this._enqueueDeferredStamp(user, pos.x, pos.y);
    } else {
      this._stampGlitchAtPoint(user, pos.x, pos.y);
    }

    this._expandBounds(user, pos.x, pos.y, user.size, user.blurRadius);
    this.board.forEachMirrorRegion({ point: pos }, (region) => {
      const mirrored = this.board.mirrorPointToRegion(pos, region);
      this._expandBounds(user, mirrored.x, mirrored.y, user.size, user.blurRadius);
    });

    // Draw preview
    if (previewCtx) {
      this._drawStampPreview(previewCtx, pos.x, pos.y, user.size, this._getStampAlpha(user));
    }

    this.board.requestUpdate();
  }

  onPointerMove(user, pos, lastPos) {
    this._moveStroke(user, pos, true);
  }

  onPointerMoveNoRender(user, pos, lastPos) {
    this._moveStroke(user, pos, false);
  }

  _moveStroke(user, pos, shouldRender) {
    if (!user.mousedown || user.panning) return;

    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    const prevStamp = this.lastStampPos.get(userId);
    if (prevStamp) {
      const dx = pos.x - prevStamp.x;
      const dy = pos.y - prevStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
      const minSpacing = Math.max(user.size * spacingPercent, 5);

      if (distance >= minSpacing) {
        const isSelf = user === this.board.app?.self;
        // In fast-preview (defer) mode the local stroke arrives via the batch
        // renderer with shouldRender=false, and that renderer skips its own
        // preview pass for glitch (see getPreviewDirtyRect). So paint the grey
        // placeholder here regardless of shouldRender — it accumulates on topCtx
        // and is cleared on pointerUp.
        const previewCtx = (shouldRender || this._isDeferRender(user))
          ? (isSelf ? this.board.topCtx : user.context)
          : null;
        this._stampAlongPath(user, prevStamp, pos, minSpacing, previewCtx);
        if (shouldRender) this.board.requestUpdate();
      }
    } else {
      this.lastStampPos.set(userId, { x: pos.x, y: pos.y });
    }
  }

  onPointerUp(user, pos) {
    const userId = user.id ?? this.board.app?.self?.id ?? 0;

    // Track tile ownership
    const points = this.strokePoints.get(userId);

    // Fast-preview mode offloaded each stamp to the worker during the stroke.
    // Finish any jobs still in flight (synchronously — there are usually only a
    // few) so the stroke layer is complete before we capture/commit it.
    if (this._isDeferRender(user)) {
      this._finalizeDeferredJobs(user, userId);
    }

    if (points && points.length > 0) {
      this._markDirtyPathOnTargetLayers(user, points);
    }
    this.strokePoints.delete(userId);

    const strokeImages = this._captureLocalStrokeImages(user, userId);
    // Commit only the layers that actually got glitch content (the same set we
    // broadcast); empty layers are discarded so the stroke is a single undo.
    // null for non-self (no scan available) keeps the original commit-all path.
    const contentLayers = user === this.board.app?.self
      ? new Set(strokeImages.map((img) => img.layerIdx))
      : null;
    this._endTargetLayerStrokes(user, userId, contentLayers);
    this._broadcastLocalStrokeImages(strokeImages);

    this.lastStampPos.delete(userId);
    this.clearSnapshot(userId);
    delete user.blurBounds;

    // Clear preview
    if (user === this.board.app?.self) {
      this.board.topCtx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.board.requestUpdate();
  }

  _captureLocalStrokeImages(user, userId) {
    if (user !== this.board.app?.self) return [];

    const strokeImages = [];
    for (const layerIdx of this._getTargetLayers()) {
      const active = this.board.layerManager?.getActiveStroke(layerIdx, userId);
      const sourceCanvas = active?.canvas;
      if (!sourceCanvas) continue;

      // Content scan is authoritative: a glitch stamp only deposits pixels where
      // its layer's snapshot had something to smear, so layers that come back
      // empty here truly produced nothing. (Previously a user.blurBounds fallback
      // captured these empty overlay layers too, which broadcast blank images and
      // — paired with the commit of every layer — created phantom undo steps.)
      const bounds = this._findStrokeContentBounds(sourceCanvas, active.dirtyRect);
      if (!bounds) continue;

      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = bounds.width;
      cropCanvas.height = bounds.height;
      cropCanvas
        .getContext('2d')
        .drawImage(sourceCanvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);

      // The captured pixels are the already-displayed (blend-resolved) glitch
      // result, so they travel and commit as source-over on every peer and in
      // replay. No blend re-application — the colour in the image IS the final
      // colour. (This supersedes the earlier blend-travel path: the glitch no
      // longer carries a live blend mode because it bakes the appearance in.)
      strokeImages.push({
        layerIdx,
        bounds,
        cropCanvas,
        blendMode: 'source-over',
        blendBakeMode: 'background'
      });
    }

    return strokeImages;
  }

  _findStrokeContentBounds(canvas, dirtyRect = null) {
    if (!canvas) return null;
    let x = 0;
    let y = 0;
    let width = canvas.width;
    let height = canvas.height;

    if (dirtyRect && dirtyRect.maxX !== -1) {
      x = Math.floor(Math.max(0, dirtyRect.minX));
      y = Math.floor(Math.max(0, dirtyRect.minY));
      width = Math.ceil(Math.min(canvas.width, dirtyRect.maxX + 1)) - x;
      height = Math.ceil(Math.min(canvas.height, dirtyRect.maxY + 1)) - y;
    }
    if (width <= 0 || height <= 0) return null;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(x, y, width, height);
    const data = imageData.data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let py = 0; py < height; py++) {
      const row = py * width * 4;
      for (let px = 0; px < width; px++) {
        if (data[row + px * 4 + 3] === 0) continue;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }

    if (maxX < 0) return null;
    return {
      x: x + minX,
      y: y + minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
  }

  _broadcastLocalStrokeImages(strokeImages) {
    const app = this.board.app;
    if (!strokeImages?.length || !app?.wsClient) return;
    // Offline (Draw Alone) must still emit GLITCH_RESULT: send() records it to
    // the rolling tape, and replay treats every glitch stroke as remote — it
    // only renders when the result arrives. Skip only mid-session disconnects.
    if (!app.connected && !app.isOfflineMode) return;
    const maxDataUrlLength = 3 * 1024 * 1024;

    for (const { layerIdx, bounds, cropCanvas, blendMode, blendBakeMode } of strokeImages) {
      // Validate bounds before broadcasting
      if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
          !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
          bounds.width <= 0 || bounds.height <= 0) {
        continue;
      }

      let dataUrl = cropCanvas.toDataURL('image/png');
      if (dataUrl.length > maxDataUrlLength) {
        const webpDataUrl = cropCanvas.toDataURL('image/webp', 0.9);
        if (webpDataUrl?.startsWith('data:image/webp') && webpDataUrl.length < dataUrl.length) {
          dataUrl = webpDataUrl;
        }
      }
      if (dataUrl.length > maxDataUrlLength) {
        console.warn('[GlitchBlurTool] Skipping oversized glitch result broadcast:', {
          layerIdx,
          width: bounds.width,
          height: bounds.height,
          bytes: dataUrl.length
        });
        continue;
      }

      const sendGlitchResult = () => {
        this.board.app.wsClient.broadcastGlitchResult(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          dataUrl,
          layerIdx,
          blendMode,
          blendBakeMode
        );
      };

      const inputBufferManager = this.board.app.inputBufferManager;
      if (inputBufferManager?.queueBroadcast) {
        inputBufferManager.queueBroadcast(sendGlitchResult, { snapshot: false });
      } else {
        sendGlitchResult();
      }
    }
  }

  /**
   * Crops the frozen pointerDown snapshot to the region the glitch stamp at
   * (x, y) needs, returning the cropped canvas + its ImageData and placement.
   * Shared by the synchronous WASM path and the fast-preview worker pipeline.
   */
  _cropSnapshotRegion(x, y, size, user, layerIdx) {
    const radius = size;
    const blurRadius = user.blurRadius || 10;
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const sourceCanvas = this.snapshotCanvases.get(this._getSnapshotKey(userId, layerIdx)) || this.board.mainCanvas || this.board.mainCtx?.canvas;

    if (!sourceCanvas) return null;

    const margin = Math.ceil(blurRadius * 2);
    const cropX = Math.max(0, Math.floor(x - radius - margin));
    const cropY = Math.max(0, Math.floor(y - radius - margin));
    const cropW = Math.min(sourceCanvas.width - cropX, Math.ceil((radius + margin) * 2));
    const cropH = Math.min(sourceCanvas.height - cropY, Math.ceil((radius + margin) * 2));

    if (cropW <= 0 || cropH <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    return {
      canvas,
      ctx,
      imageData: ctx.getImageData(0, 0, cropW, cropH),
      cropX, cropY, cropW, cropH,
      blurRadius: Math.max(1, Math.round(blurRadius))
    };
  }

  _computeGlitchStamp(x, y, size, user, layerIdx = this._getTargetLayer(user)) {
    const crop = this._cropSnapshotRegion(x, y, size, user, layerIdx);
    if (!crop) return null;

    try {
      const blurred = wasm.stackblur_rgba_glitch(
        new Uint8Array(crop.imageData.data.buffer.slice(0)),
        crop.cropW,
        crop.cropH,
        crop.blurRadius
      );
      crop.ctx.putImageData(new ImageData(new Uint8ClampedArray(blurred), crop.cropW, crop.cropH), 0, 0);
    } catch (err) {
      console.warn('Glitch blur WASM failed:', err);
    }

    return { stampCanvas: crop.canvas, cropX: crop.cropX, cropY: crop.cropY };
  }

  _applyStampToCtx(ctx, stamp, x, y, radius, intensity) {
    if (!stamp) return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = intensity;
    ctx.beginPath();
    ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.clip();
    ctx.drawImage(stamp.stampCanvas, stamp.cropX, stamp.cropY);
    ctx.restore();
  }

  /**
   * True when this user's glitch render should be deferred to pointerUp and
   * only a lightweight placeholder shown during the stroke. Local-only,
   * controlled by the "Fast preview" toggle (App.glitchFastPreview).
   */
  _isDeferRender(user) {
    return user === this.board.app?.self && !!this.board.app?.glitchFastPreview;
  }

  /**
   * Hook for the batch renderer (InputBufferManager._renderBatchTool). Returning
   * false tells it there is "no preview work", so it skips its per-frame
   * clearTop()+drawPreview() pass. In fast-preview mode we paint the grey
   * placeholder onto topCtx ourselves (incrementally, in _moveStroke) and must
   * NOT let the batch renderer wipe it each frame. In normal mode we return null
   * so the default clear runs (the real glitch lives on the stroke layer, so
   * topCtx carries nothing we need to keep).
   */
  getPreviewDirtyRect(user) {
    return this._isDeferRender(user) ? false : null;
  }

  /**
   * Applies the real (WASM) glitch stamp at a single point across all target
   * layers, including any mirror regions. Shared by the live progressive path
   * and the deferred fast-preview batch (onPointerUp). Returns true if at least
   * one layer received a stamp.
   */
  _stampGlitchAtPoint(user, x, y) {
    let stamped = false;
    for (const layerIdx of this._getTargetLayers()) {
      if (this._stampGlitchAtPointLayer(user, x, y, layerIdx)) stamped = true;
    }
    return stamped;
  }

  /**
   * Synchronously computes + composites the glitch stamp for a single layer at
   * (x, y), including mirror regions. Returns true if a stamp was applied.
   */
  _stampGlitchAtPointLayer(user, x, y, layerIdx) {
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const alpha = this._getStampAlpha(user);
    const maskCtx = this.board.layerManager?.getUserStrokeContext(layerIdx, userId);
    const stamp = this._computeGlitchStamp(x, y, user.size, user, layerIdx);
    if (!maskCtx || !stamp) return false;
    this._compositeStampWithMirrors(user, maskCtx, stamp, x, y, alpha);
    return true;
  }

  /** Draws a prepared glitch stamp into maskCtx at (x, y) plus all mirrors. */
  _compositeStampWithMirrors(user, maskCtx, stamp, x, y, alpha) {
    this._applyStampToCtx(maskCtx, stamp, x, y, user.size, alpha);
    this.board.forEachMirrorRegion({ point: { x, y } }, (region) => {
      this.board.withMirroredRegionTransform(maskCtx, region, () => {
        this._applyStampToCtx(maskCtx, stamp, x, y, user.size, alpha);
      });
    });
  }

  /**
   * Fast-preview pipeline: offload one stamp's glitch blur to the pixels worker
   * (off the main thread) for every target layer. When a result returns it is
   * composited into the live stroke layer — hidden under the opaque placeholder
   * until pointerUp clears it. Any job still in flight at pointerUp is finished
   * synchronously by _finalizeDeferredJobs, so the heavy WASM never lands as one
   * blocking batch on release.
   */
  _enqueueDeferredStamp(user, x, y) {
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const worker = this.board.layerManager?._pixelsWorker;

    // No worker available → fall back to the synchronous stamp.
    if (!worker?.blur) {
      this._stampGlitchAtPoint(user, x, y);
      return;
    }

    let jobs = this.deferredJobs.get(userId);
    if (!jobs) { jobs = []; this.deferredJobs.set(userId, jobs); }

    const alpha = this._getStampAlpha(user);

    for (const layerIdx of this._getTargetLayers()) {
      const crop = this._cropSnapshotRegion(x, y, user.size, user, layerIdx);
      if (!crop) continue;

      const job = { layerIdx, x, y, alpha, radius: user.size, cropX: crop.cropX, cropY: crop.cropY, cropW: crop.cropW, cropH: crop.cropH, composited: false, cancelled: false };
      jobs.push(job);

      worker.blur(crop.imageData.data, crop.cropW, crop.cropH, crop.blurRadius, true)
        .then((blurred) => {
          if (job.cancelled || job.composited) return;
          job.composited = true;
          this._compositeDeferredJob(user, userId, job, blurred);
          this.board.requestUpdate();
        })
        .catch(() => { /* leave uncomposited → synchronous fallback at pointerUp */ });
    }
  }

  _compositeDeferredJob(user, userId, job, blurred) {
    const maskCtx = this.board.layerManager?.getUserStrokeContext(job.layerIdx, userId);
    if (!maskCtx || !blurred) return;

    const stampCanvas = document.createElement('canvas');
    stampCanvas.width = job.cropW;
    stampCanvas.height = job.cropH;
    stampCanvas.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(blurred.buffer), job.cropW, job.cropH),
      0, 0
    );

    this._compositeStampWithMirrors(user, maskCtx, { stampCanvas, cropX: job.cropX, cropY: job.cropY }, job.x, job.y, job.alpha);
  }

  /**
   * Completes the fast-preview stroke: any worker jobs that haven't returned yet
   * are computed synchronously (there are usually only a handful), then the
   * queue is cleared. Late worker results are ignored via the cancelled flag.
   */
  _finalizeDeferredJobs(user, userId) {
    const jobs = this.deferredJobs.get(userId);
    if (!jobs) return;
    for (const job of jobs) {
      if (job.composited || job.cancelled) continue;
      job.cancelled = true;
      this._stampGlitchAtPointLayer(user, job.x, job.y, job.layerIdx);
    }
    this.deferredJobs.delete(userId);
  }

  /**
   * Paints the cheap grey-square placeholder along a segment onto the given
   * context. Used for remote users and replay, where the full per-stamp glitch
   * is never recomputed — the authoritative pixels arrive later via
   * GLITCH_RESULT. Mirrors the stamp spacing of the live stroke so the trail
   * roughly tracks where the finished smear will land.
   */
  drawPlaceholderAlong(user, ctx, from, to) {
    if (!ctx || !from || !to) return;

    const alpha = this._getStampAlpha(user);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const spacingPercent = user.spacing === 0 ? 0.1 : (user.spacing * 0.05);
    const spacing = Math.max(user.size * spacingPercent, 5);

    if (!Number.isFinite(distance) || distance < spacing) {
      this._drawStampPreview(ctx, to.x, to.y, user.size, alpha);
      return;
    }

    const steps = Math.floor(distance / spacing);
    for (let i = 1; i <= steps; i++) {
      const t = (i * spacing) / distance;
      this._drawStampPreview(ctx, from.x + dx * t, from.y + dy * t, user.size, alpha);
    }
  }

  _expandBounds(user, x, y, radius, blurRadius) {
    const margin = Math.ceil(blurRadius * 2);
    const left = Math.floor(x - radius - margin);
    const top = Math.floor(y - radius - margin);
    const width = Math.ceil((radius + margin) * 2);
    const height = Math.ceil((radius + margin) * 2);

    this.board.expandDirtyRectAllLayers(user, left, top, width, height);

    if (user.blurBounds) {
      user.blurBounds.minX = Math.min(user.blurBounds.minX, left);
      user.blurBounds.minY = Math.min(user.blurBounds.minY, top);
      user.blurBounds.maxX = Math.max(user.blurBounds.maxX, left + width);
      user.blurBounds.maxY = Math.max(user.blurBounds.maxY, top + height);
    }
  }

  _stampAlongPath(user, from, to, spacing, previewCtx) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(distance) || distance <= 0) return;

    const steps = Math.floor(distance / spacing);
    const userId = user.id ?? this.board.app?.self?.id ?? 0;
    const points = this.strokePoints.get(userId);
    const defer = this._isDeferRender(user);
    let lastStamp = from;

    for (let i = 1; i <= steps; i++) {
      const t = (i * spacing) / distance;
      const x = from.x + dx * t;
      const y = from.y + dy * t;

      // In fast-preview mode offload to the worker; still record/preview each
      // stamp so bounds, the point trail, and the placeholder stay accurate.
      let stamped = true;
      if (defer) {
        this._enqueueDeferredStamp(user, x, y);
      } else {
        stamped = this._stampGlitchAtPoint(user, x, y);
      }

      if (stamped) {
        this._expandBounds(user, x, y, user.size, user.blurRadius);
        this.board.forEachMirrorRegion({ point: { x, y } }, (region) => {
          const mirrored = this.board.mirrorPointToRegion({ x, y }, region);
          this._expandBounds(user, mirrored.x, mirrored.y, user.size, user.blurRadius);
        });

        if (previewCtx) {
          this._drawStampPreview(previewCtx, x, y, user.size, this._getStampAlpha(user));
        }
      }

      points?.push({ x, y });
      lastStamp = { x, y };
    }

    this.lastStampPos.set(userId, lastStamp);
  }

  _drawStampPreview(ctx, x, y, size /*, pressure */) {
    // Solid grey placeholder square. Intentionally near-opaque and independent
    // of the user's opacity setting: it reads as a clear "stamp" and masks the
    // real glitch filling in underneath during the stroke (revealed on release).
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(136, 136, 136, 0.95)';
    ctx.fillRect(x - size, y - size, size * 2, size * 2);

    ctx.strokeStyle = 'rgba(92, 92, 92, 1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - size, y - size, size * 2, size * 2);

    ctx.restore();
  }

  _getStampAlpha(user) {
    const opacity = Number.isFinite(Number(user?.opacity)) ? Number(user.opacity) : 1.0;
    return Math.max(0, Math.min(1, opacity));
  }
}
