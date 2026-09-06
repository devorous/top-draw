import { resetPreviewContext } from '../ui/StrokePreviewRenderer.js';
import { Tool } from './BaseTool.js';
import { getPatternTile, getPatternDrawScale } from '../utils/patternTile.js';
import { ensureSizedCanvas } from '../utils/drawing.js';

/**
 * How often a remote pattern preview is redrawn, in ms.
 *
 * Pattern is by a wide margin the most expensive tool in the app. Measured at
 * 1440p with 7 bots all using it: 90.8 % renderer main busy, 121 fps and a
 * 1267 MB GPU peak, against ~60 %, ~165 fps and ~700 MB for brush, pixel,
 * imageBrush and confetti.
 *
 * The reason is that `_drawRemotePreview` ran on EVERY arriving batch and each
 * call did a full-board clearRect, a full-board pattern fill, a full-board
 * destination-in composite AND allocated a brand new full-board canvas via
 * document.createElement. Allocating a full-board canvas is the single most
 * expensive canvas operation there is and it is invisible to JS timers. At up
 * to the sender's tick rate per user that is ~360 of these per second in a
 * 6-user room.
 *
 * 33 ms matches RemoteInkHandler / RemotePenHandler and the catchup loop.
 *
 * The rest of that shape is gone too: the composite surface is now pooled per
 * stroke (`_getCompositeSurface`) instead of allocated per tick, and every
 * pass — clear, pattern fill, destination-in, the blit onto the target, and
 * the preview surface's own clear — is clipped to the stroke's accumulated
 * bounding box (`_boundsToRect`) instead of the whole board.
 */
const PATTERN_PREVIEW_INTERVAL_MS = 33;

/**
 * @fileoverview Pattern tool - Reveals a grid of images through a brush stroke.
 */

export class PatternTool extends Tool {
  constructor(board) {
    super('pattern', board);
    this.lastStampPos = new Map();
    this.stampBuffer = [];
    this.strokePoints = [];
    this._tileCache = new Map();
    this.previewCanvas = null;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.dirtyBounds = null;
    this.remoteOffscreens = new Map(); // userId -> { canvas, ctx, strokePoints, bounds, previewSeeded }
    // Per-stroke pattern composite surfaces, keyed by user, plus a small
    // free-list they are recycled through. See _getCompositeSurface.
    this._compositeSurfaces = new Map(); // userId -> { canvas, ctx }
    this._compositePool = [];
    // Layer each in-flight stroke opened on, captured at MD. Not read back off
    // `user._strokeLayer`: the remote path nulls that at MU but the local path
    // never does (EraserTool sets it and nothing clears it), so a local pattern
    // stroke drawn after an erase-then-switch-layer would commit to the erased
    // layer. `user.activeLayer` at MD is what beginUserStroke actually used on
    // both paths.
    this.strokeLayerByUser = new Map(); // userId -> layer index
  }

  activate() {
    this.ensureOffscreenCanvas();
    this.updatePreview();
  }

  deactivate() {
    if (this._activeUser && this.lastStampPos.has(this._activeUser.id)) {
      this.onPointerUp(this._activeUser);
    }
    this.lastStampPos.clear();
    this._tileCache.clear();
    for (const userId of [...this._compositeSurfaces.keys()]) this._releaseCompositeSurface(userId);
    this._activeUser = null;
  }

  ensureOffscreenCanvas() {
    const { canvas, ctx } = ensureSizedCanvas(
      this.offscreenCanvas, this.board.getWidth(), this.board.getHeight());
    this.offscreenCanvas = canvas;
    this.offscreenCtx = ctx;
  }

  onPointerDown(user, pos) {
    this._activeUser = user;
    this.strokeLayerByUser.set(user.id, user.activeLayer ?? 0);
    this.board.beginStroke(user);
    this.ensureOffscreenCanvas();
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    this.dirtyBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.strokePoints = [pos];
    this._stampMask(pos, user.size * (user.pressure || 1));
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this.board.clearTop();
    this._drawPreview(user);
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning) return;

    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp) {
      this._stampMask(pos, user.size * (user.pressure || 1));
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      this.board.clearTop();
      this._drawPreview(user);
      return;
    }

    const dx = pos.x - lastStamp.x;
    const dy = pos.y - lastStamp.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const minSpacing = Math.max(1, user.size * 0.1);

    if (distance >= minSpacing) {
      const steps = Math.max(1, Math.floor(distance / minSpacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const interpPos = { x: lastStamp.x + dx * t, y: lastStamp.y + dy * t };
        this._stampMask(interpPos, user.size * (user.pressure || 1));
        this.strokePoints.push(interpPos);
      }
      this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    }

    this.board.clearTop();
    this._drawPreview(user);
  }

  onPointerUp(user, pos) {
    if (user.panning || !user.mousedown) return;

    this._stampFinalSegment(user, pos);

    const ctx = this._getCommitContext(user);
    if (ctx) {
      const composite = this._buildPatternComposite(user);
      this._drawPatternCompositeToContext(ctx, composite, user);
    }

    if (this.strokePoints.length > 0) {
      this.board.markDirtyPath(user, this.strokePoints, user.size);
      this.board.forEachMirrorRegion({ points: this.strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(this.strokePoints, region), user.size);
      });
    }

    if (this.dirtyBounds && this.dirtyBounds.maxX !== -Infinity) {
      const x = Math.floor(this.dirtyBounds.minX) - 2;
      const y = Math.floor(this.dirtyBounds.minY) - 2;
      const w = Math.ceil(this.dirtyBounds.maxX) - x + 2;
      const h = Math.ceil(this.dirtyBounds.maxY) - y + 2;
      this.board.expandDirtyRect(user, x, y, w, h);

      this.board.forEachMirrorRegion({ rect: { x, y, width: w, height: h } }, (region) => {
        const p1 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.minX, y: this.dirtyBounds.minY }, region);
        const p2 = this.board.mirrorPointToRegion({ x: this.dirtyBounds.maxX, y: this.dirtyBounds.maxY }, region);
        const mx = Math.floor(Math.min(p1.x, p2.x)) - 2;
        const my = Math.floor(Math.min(p1.y, p2.y)) - 2;
        const mw = Math.ceil(Math.max(p1.x, p2.x)) - mx + 2;
        const mh = Math.ceil(Math.max(p1.y, p2.y)) - my + 2;
        this.board.expandDirtyRect(user, mx, my, mw, mh);
      });
    }

    this.strokePoints = [];
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    this.dirtyBounds = null;
    this.board.endStroke(user);
    this.strokeLayerByUser.delete(user.id);
    this.lastStampPos.delete(user.id);
    this._releaseCompositeSurface(user.id);
    this.board.clearTop();
  }

  _stampMask(pos, radius) {
    const ctx = this.offscreenCtx;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    this._expandBounds(this.dirtyBounds, pos.x, pos.y, radius);
  }

  _stampSegment(from, to, radius, stampFn) {
    if (!from || !to || !stampFn) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= 0.5) return;

    const minSpacing = Math.max(1, radius * 0.1);
    const steps = Math.max(1, Math.ceil(distance / minSpacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stampFn({
        x: from.x + dx * t,
        y: from.y + dy * t
      });
    }
  }

  _stampFinalSegment(user, pos) {
    const lastStamp = this.lastStampPos.get(user.id);
    if (!lastStamp || !pos) return;

    const radius = user.size * (user.pressure || 1);
    this._stampSegment(lastStamp, pos, radius, (stampPos) => {
      this._stampMask(stampPos, radius);
      this.strokePoints.push(stampPos);
    });
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
  }

  /** Grow an accumulating {minX,minY,maxX,maxY} bounds box by one stamp. */
  _expandBounds(bounds, x, y, radius) {
    if (!bounds) return;
    bounds.minX = Math.min(bounds.minX, x - radius);
    bounds.minY = Math.min(bounds.minY, y - radius);
    bounds.maxX = Math.max(bounds.maxX, x + radius);
    bounds.maxY = Math.max(bounds.maxY, y + radius);
  }

  /**
   * Integer, board-clamped rect covering an accumulated bounds box, or the whole
   * board when there is nothing to go on (a stroke that never stamped, or a
   * commit reached through `deactivate()`).
   *
   * Bounds only ever GROW across a stroke, which is what makes clipping every
   * composite operation to this rect safe: the region outside it was never
   * written this stroke, so it is still as transparent as the surface was when
   * it was handed out.
   *
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} bounds
   * @param {number} w - Surface width.
   * @param {number} h - Surface height.
   * @returns {{x:number,y:number,w:number,h:number}}
   * @private
   */
  _boundsToRect(bounds, w, h) {
    const whole = { x: 0, y: 0, w, h };
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) return whole;
    const pad = 2;
    const x = Math.max(0, Math.floor(bounds.minX) - pad);
    const y = Math.max(0, Math.floor(bounds.minY) - pad);
    const right = Math.min(w, Math.ceil(bounds.maxX) + pad);
    const bottom = Math.min(h, Math.ceil(bounds.maxY) + pad);
    if (right <= x || bottom <= y) return whole;
    return { x, y, w: right - x, h: bottom - y };
  }

  /**
   * The scratch surface a user's pattern composite is built on, held for the
   * life of one stroke.
   *
   * This used to be a `document.createElement('canvas')` at full board size on
   * EVERY preview tick - the single most expensive canvas operation there is,
   * run up to the sender's tick rate per drawing user, and the largest
   * remaining term in pattern's cost (90.8 % renderer busy / 1267 MB GPU peak
   * at 1440p with 7 bots). Now it is acquired once per stroke from a small
   * free-list and returned at stroke end, so a room drawing pattern strokes
   * back to back recycles the same few canvases instead of churning ~15 MB
   * each time.
   *
   * The surface is handed out fully cleared. Callers must keep that invariant
   * for the region outside the stroke bounds - see {@link _boundsToRect}.
   *
   * @param {Object} user
   * @param {number} w
   * @param {number} h
   * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}|null}
   * @private
   */
  _getCompositeSurface(user, w, h) {
    const existing = this._compositeSurfaces.get(user.id);
    if (existing && existing.canvas.width === w && existing.canvas.height === h) return existing;
    if (existing) this._releaseCompositeSurface(user.id);

    let surface = null;
    while (this._compositePool.length > 0) {
      const candidate = this._compositePool.pop();
      if (candidate.canvas.width === w && candidate.canvas.height === h) { surface = candidate; break; }
    }
    if (!surface) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      surface = { canvas, ctx: canvas.getContext('2d') };
    }

    // A recycled surface can carry a clip and a wound-up save stack as well as
    // pixels; reset() is the only thing that drops those. Same reasoning as
    // LayerManager._acquireCanvas, including the pre-Chrome-101 fallback.
    if (typeof surface.ctx.reset === 'function') {
      surface.ctx.reset();
    } else {
      surface.ctx.clearRect(0, 0, w, h);
      surface.ctx.globalAlpha = 1;
      surface.ctx.globalCompositeOperation = 'source-over';
    }

    this._compositeSurfaces.set(user.id, surface);
    return surface;
  }

  /** Return a user's composite surface to the free-list at stroke end. */
  _releaseCompositeSurface(userId) {
    const surface = this._compositeSurfaces.get(userId);
    if (!surface) return;
    this._compositeSurfaces.delete(userId);
    // Cap the list: holding board-sized backing stores for every user who has
    // ever drawn a pattern stroke is exactly the memory pressure we are trying
    // to avoid. Two covers the common local + one-remote case.
    if (this._compositePool.length < 2) this._compositePool.push(surface);
  }

  /**
   * Build the pattern-clipped-to-mask image for a stroke.
   *
   * Returns the surface together with the rect that is valid on it; everything
   * outside is transparent and must not be relied on. All three passes (clear,
   * pattern fill, destination-in) are clipped to that rect, so a small stroke
   * costs its own bounding box rather than the whole board.
   *
   * @param {Object} user
   * @param {HTMLCanvasElement|null} [maskCanvas] - defaults to the local mask.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} [bounds]
   *   Accumulated stroke bounds; omit entirely to use the local stroke's.
   * @returns {{canvas: HTMLCanvasElement, rect: {x:number,y:number,w:number,h:number}}|null}
   * @private
   */
  _buildPatternComposite(user, maskCanvas = null, bounds) {
    const mask = maskCanvas ?? this.offscreenCanvas;
    if (!mask) return null;
    const tile = this._getPatternTile(user);
    if (!tile) return null;

    const w = mask.width;
    const h = mask.height;
    const surface = this._getCompositeSurface(user, w, h);
    if (!surface) return null;
    const tempCtx = surface.ctx;
    const rect = this._boundsToRect(bounds === undefined ? this.dirtyBounds : bounds, w, h);

    const scale = getPatternDrawScale(user, tile);
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const pattern = tempCtx.createPattern(tile, 'repeat');
    if (!pattern) return null;
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }

    // The pattern is anchored in surface space by that transform, so filling a
    // sub-rect of it yields exactly the pixels a full-board fill would have.
    tempCtx.save();
    tempCtx.beginPath();
    tempCtx.rect(rect.x, rect.y, rect.w, rect.h);
    tempCtx.clip();
    tempCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
    tempCtx.fillStyle = pattern;
    tempCtx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // Clip pattern to the stroke mask. `destination-in` would otherwise scrub
    // the whole surface; the clip is what keeps it to the stroke's box.
    tempCtx.globalCompositeOperation = 'destination-in';
    tempCtx.drawImage(mask, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    tempCtx.restore();

    return { canvas: surface.canvas, rect };
  }

  /** The pattern preview persists between ticks while a stroke is in progress. */
  redrawPreview(user) {
    if (!user?.mousedown) return;
    this.board.clearTop();
    this._drawPreview(user);
  }

  _drawPreview(user) {
    const composite = this._buildPatternComposite(user);
    this._drawPatternCompositeToContext(this.board.topCtx, composite, user, this.strokePoints);
  }

  _drawRemotePreview(user, maskCanvas, strokePoints = [], offscreen = null) {
    if (!user?.context) return;

    const ctx = user.context;
    const composite = this._buildPatternComposite(user, maskCanvas, offscreen?.bounds ?? null);

    // The first paint of a stroke scrubs the whole surface; after that the
    // stroke's own (growing) rect is the only region that can hold stale
    // pixels, so clearing it is enough and a full-board clearRect per arriving
    // batch, per drawing user, goes away.
    //
    // Mirrors are the exception and must fall back to the full clear: their
    // copies are painted OUTSIDE the stroke rect, so a narrow clear would leave
    // the previous frame's reflections on the surface and the mirrored stroke
    // would smear instead of redraw.
    const mirrored = (this.board.getActiveMirrorRegions?.()?.length ?? 0) > 0;
    if (offscreen && offscreen.previewSeeded && composite && !mirrored) {
      const { x, y, w, h } = composite.rect;
      ctx.clearRect(x, y, w, h);
    } else {
      ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
      if (offscreen) offscreen.previewSeeded = true;
    }

    this._drawPatternCompositeToContext(ctx, composite, user, strokePoints);
  }

  _drawPatternCompositeToContext(ctx, composite, user, strokePoints = this.strokePoints) {
    if (!ctx || !composite) return;
    const { canvas, rect } = composite;
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
      // Mirrors take the whole surface: the transform is region-relative, and
      // everything outside `rect` is transparent by the invariant above.
      this.board.forEachMirrorRegion({ points: strokePoints }, (region) => {
        this.board.drawMirroredCanvas(ctx, canvas, region, 0, 0);
      });
    });
    ctx.globalAlpha = 1.0;
  }

  /**
   * Generates a single tile for the repeating pattern.
   * Standardizes size and adds user-defined padding (spacing).
   */
  _getPatternTile(user) {
    if (!this._tileCache) this._tileCache = new Map();
    return getPatternTile(user, this._tileCache);
  }

  /**
   * Resolve the layer + context this user's pattern stroke must commit into.
   *
   * Two things have to be explicit here. The LAYER is the one this stroke
   * opened on, not `user.activeLayer` — a CL arriving mid-stroke moves the
   * latter, and committing to the moved index manufactures a second,
   * never-opened active stroke instead of filling the one `beginUserStroke`
   * created. The BLEND and BAKE MODE have to travel too: on that manufactured
   * record `getUserStrokeContext` would fall back to its own defaults, and a
   * stroke that defaults into `blendBakeMode: 'existing'` is clipped at commit
   * with `destination-in` against the layer's existing alpha — which carries a
   * hole wherever anyone has ever erased. Same reasoning as RemoteInkHandler
   * and RemotePenHandler, which already pass both.
   *
   * @param {Object} user - Stroke owner (local or remote).
   * @returns {CanvasRenderingContext2D|undefined}
   * @private
   */
  _getCommitContext(user) {
    const strokeLayer = this.strokeLayerByUser.get(user.id) ?? user?.activeLayer ?? 0;
    return this.board.layerManager?.getUserStrokeContext(
      strokeLayer,
      user.id,
      user.blendMode || 'source-over',
      { blendBakeMode: user.blendBakeMode }
    );
  }

  drawStamp(user, pos) {
    // Legacy method: stamp directly to layer (used by applyStamps for remote rendering).
    const ctx = this._getCommitContext(user);
    if (!ctx) return;

    const tile = this._getPatternTile(user);
    if (!tile) return;

    const size = user.size * (user.pressure || 1);
    const scale = getPatternDrawScale(user, tile);
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;

    const fillStamp = (targetCtx) => {
      targetCtx.save();
      const pattern = targetCtx.createPattern(tile, 'repeat');
      if (pattern.setTransform) {
        const matrix = new DOMMatrix()
          .translate(offsetX, offsetY)
          .rotate(user.patternRotation || 0)
          .scale(scale);
        pattern.setTransform(matrix);
      }
      targetCtx.fillStyle = pattern;
      targetCtx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
      targetCtx.beginPath();
      targetCtx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.restore();
    };

    fillStamp(ctx);
    this.board.forEachMirrorRegion({ point: pos }, (region) => {
      this.board.withMirroredRegionTransform(ctx, region, () => fillStamp(ctx));
    });

    this.board.expandDirtyRect(user, pos.x - size - 2, pos.y - size - 2, size * 2 + 4, size * 2 + 4);
    this.board.requestUpdate();
  }

  updatePreview(user) {
    this.previewCanvas = document.getElementById('toolPreviewCanvas');
    if (!this.previewCanvas) {
      return;
    }

    const ctx = this.previewCanvas.getContext('2d');
    resetPreviewContext(ctx);

    // Get user from parameter, board, or app
    if (!user) {
      user = this.board.self || this.board.app?.self;
    }
    if (!user) {
      console.warn('No user available for pattern preview');
      return;
    }

    ctx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    const bgColor = this.board?.backgroundColor || [255, 255, 255, 1];
    ctx.fillStyle = `rgba(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]}, ${bgColor[3] ?? 1})`;
    ctx.fillRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);

    const tile = this._getPatternTile(user);
    if (!tile) {
      // No pattern selected yet - show blank preview
      return;
    }

    const pattern = ctx.createPattern(tile, 'repeat');
    const scale = getPatternDrawScale(user, tile) * (this.board?.zoom || 1);
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;

    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }
    
    ctx.save();
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    ctx.restore();
  }

  remoteBeginStroke(user, pos) {
    this.strokeLayerByUser.set(user.id, user._strokeLayer ?? user.activeLayer ?? 0);
    const w = this.board.getWidth();
    const h = this.board.getHeight();
    let offscreen = this.remoteOffscreens.get(user.id);
    if (!offscreen || offscreen.canvas.width !== w || offscreen.canvas.height !== h) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      offscreen = { canvas, ctx: canvas.getContext('2d'), strokePoints: [] };
      this.remoteOffscreens.set(user.id, offscreen);
    }
    offscreen.ctx.clearRect(0, 0, w, h);
    offscreen.strokePoints = [pos];
    // Per-stroke accumulated mask extent, so the remote composite is clipped
    // to the stroke's box the same way the local one is.
    offscreen.bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    offscreen.previewSeeded = false;
    const radius = user.size * (user.pressure || 1);
    offscreen.ctx.beginPath();
    offscreen.ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    offscreen.ctx.fill();
    this._expandBounds(offscreen.bounds, pos.x, pos.y, radius);
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this._drawRemotePreview(user, offscreen.canvas, offscreen.strokePoints, offscreen);
  }

  remoteStampMask(user, ps) {
    const offscreen = this.remoteOffscreens.get(user.id);
    if (!offscreen) return;
    const radius = user.size * (user.pressure || 1);
    const minSpacing = Math.max(1, user.size * 0.1);
    const stampCircle = (x, y) => {
      offscreen.ctx.beginPath();
      offscreen.ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
      offscreen.ctx.fill();
      this._expandBounds(offscreen.bounds, x, y, radius);
      offscreen.strokePoints.push({ x, y });
    };

    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      const lastStamp = this.lastStampPos.get(user.id);
      if (!lastStamp) {
        stampCircle(pos.x, pos.y);
        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
        continue;
      }
      const dx = pos.x - lastStamp.x;
      const dy = pos.y - lastStamp.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance >= minSpacing) {
        const steps = Math.max(1, Math.floor(distance / minSpacing));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          stampCircle(lastStamp.x + dx * t, lastStamp.y + dy * t);
        }
        this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
      }
    }
    this._requestRemotePreview(user, offscreen);
  }

  /**
   * Throttle the remote pattern preview to PATTERN_PREVIEW_INTERVAL_MS.
   *
   * Only the PREVIEW defers. Stamps are still written into `offscreen.canvas`
   * synchronously by the caller above, and `remoteEndStroke` composites from
   * that same mask — so the committed pixels, and therefore parity, are
   * unchanged. A deferred render simply draws more accumulated mask, and the
   * region it repaints is keyed off `offscreen.bounds`, which grew along with
   * that mask — so skipping intermediate renders can only ever widen the rect
   * the next one covers, never leave a gap behind.
   *
   * @param {Object} user - The remote user.
   * @param {{canvas: HTMLCanvasElement, strokePoints: Array, bounds: Object}} offscreen
   * @returns {void}
   * @private
   */
  _requestRemotePreview(user, offscreen) {
    if (!this._previewTimers) this._previewTimers = new Map();
    if (!this._previewRenderAt) this._previewRenderAt = new Map();

    const now = performance.now();
    const elapsed = now - (this._previewRenderAt.get(user.id) || 0);
    if (elapsed >= PATTERN_PREVIEW_INTERVAL_MS) {
      this._previewRenderAt.set(user.id, now);
      this._drawRemotePreview(user, offscreen.canvas, offscreen.strokePoints, offscreen);
      return;
    }
    if (this._previewTimers.has(user.id)) return;
    // Trailing edge, so the tail of a stroke is never left unrendered.
    this._previewTimers.set(user.id, setTimeout(() => {
      this._previewTimers.delete(user.id);
      this._previewRenderAt.set(user.id, performance.now());
      // The stroke may have ended and disposed the offscreen meanwhile.
      const live = this.remoteOffscreens.get(user.id);
      if (!live) return;
      this._drawRemotePreview(user, live.canvas, live.strokePoints, live);
    }, PATTERN_PREVIEW_INTERVAL_MS - elapsed));
  }

  /**
   * Drop a pending deferred preview for a user.
   *
   * @param {number|string} userId
   * @returns {void}
   */
  cancelRemotePreview(userId) {
    const timer = this._previewTimers?.get(userId);
    if (timer) {
      clearTimeout(timer);
      this._previewTimers.delete(userId);
    }
  }

  remoteEndStroke(user) {
    const offscreen = this.remoteOffscreens.get(user.id);
    if (!offscreen) return;

    // The commit below supersedes any pending preview; letting it fire
    // afterwards would repaint a preview for an already-committed stroke.
    this.cancelRemotePreview(user.id);

    const composite = this._buildPatternComposite(user, offscreen.canvas, offscreen.bounds);
    if (composite) {
      const ctx = this._getCommitContext(user);
      this._drawPatternCompositeToContext(ctx, composite, user, offscreen.strokePoints);
    }

    if (offscreen.strokePoints.length > 0) {
      this.board.markDirtyPath(user, offscreen.strokePoints, user.size);
      this.board.forEachMirrorRegion({ points: offscreen.strokePoints }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(offscreen.strokePoints, region), user.size);
      });
    }

    if (user?.context) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    this.remoteOffscreens.delete(user.id);
    this.strokeLayerByUser.delete(user.id);
    this.lastStampPos.delete(user.id);
    this._releaseCompositeSurface(user.id);
  }

  applyStamps(user, ps) {
    const points = [];
    for (let i = 0; i < ps.length; i += 2) {
      const pos = { x: ps[i], y: ps[i + 1] };
      this.drawStamp(user, pos);
      points.push(pos);
    }
    if (points.length > 0) {
      this.board.markDirtyPath(user, points, user.size);
      this.board.forEachMirrorRegion({ points }, (region) => {
        this.board.markDirtyPath(user, this.board.mirrorPointsToRegion(points, region), user.size);
      });
    }
    this.board.requestUpdate();
  }

  clearUserState(userId) {
    this.remoteOffscreens.delete(userId);
    this.strokeLayerByUser.delete(userId);
    this.lastStampPos.delete(userId);
    this._releaseCompositeSurface(userId);
  }
}
