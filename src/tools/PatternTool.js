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
 * call does a full-board clearRect, a full-board pattern fill, a full-board
 * destination-in composite AND allocates a brand new full-board canvas via
 * document.createElement. Allocating a full-board canvas is the single most
 * expensive canvas operation there is and it is invisible to JS timers. At up
 * to the sender's tick rate per user that is ~360 of these per second in a
 * 6-user room.
 *
 * 33 ms matches RemoteInkHandler / RemotePenHandler and the catchup loop.
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
    this.remoteOffscreens = new Map(); // userId -> { canvas, ctx, strokePoints }
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
    this._activeUser = null;
  }

  ensureOffscreenCanvas() {
    const { canvas, ctx } = ensureSizedCanvas(
      this.offscreenCanvas, this.board.mainCanvas.width, this.board.mainCanvas.height);
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
    this.board.clearTop();
  }

  _stampMask(pos, radius) {
    const ctx = this.offscreenCtx;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();

    if (this.dirtyBounds) {
      this.dirtyBounds.minX = Math.min(this.dirtyBounds.minX, pos.x - radius);
      this.dirtyBounds.minY = Math.min(this.dirtyBounds.minY, pos.y - radius);
      this.dirtyBounds.maxX = Math.max(this.dirtyBounds.maxX, pos.x + radius);
      this.dirtyBounds.maxY = Math.max(this.dirtyBounds.maxY, pos.y + radius);
    }
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

  _buildPatternComposite(user, maskCanvas = null) {
    const mask = maskCanvas ?? this.offscreenCanvas;
    if (!mask) return null;
    const tile = this._getPatternTile(user);
    if (!tile) return null;

    const w = mask.width;
    const h = mask.height;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');

    const scale = getPatternDrawScale(user, tile);
    const offsetX = user.patternOffsetX || 0;
    const offsetY = user.patternOffsetY || 0;
    const pattern = tempCtx.createPattern(tile, 'repeat');
    if (pattern.setTransform) {
      const matrix = new DOMMatrix()
        .translate(offsetX, offsetY)
        .rotate(user.patternRotation || 0)
        .scale(scale);
      pattern.setTransform(matrix);
    }
    tempCtx.fillStyle = pattern;
    tempCtx.fillRect(0, 0, w, h);

    // Clip pattern to the stroke mask
    tempCtx.globalCompositeOperation = 'destination-in';
    tempCtx.drawImage(mask, 0, 0);
    tempCtx.globalCompositeOperation = 'source-over';

    return tempCanvas;
  }

  _drawPreview(user) {
    const composite = this._buildPatternComposite(user);
    this._drawPatternCompositeToContext(this.board.topCtx, composite, user, this.strokePoints);
  }

  _drawRemotePreview(user, maskCanvas, strokePoints = []) {
    if (!user?.context) return;

    const ctx = user.context;
    ctx.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());

    const composite = this._buildPatternComposite(user, maskCanvas);
    this._drawPatternCompositeToContext(ctx, composite, user, strokePoints);
  }

  _drawPatternCompositeToContext(ctx, composite, user, strokePoints = this.strokePoints) {
    if (!ctx || !composite) return;
    ctx.globalAlpha = user.opacity !== undefined ? user.opacity : 1;
    this.board.withSelectionMaskClip(ctx, user.id, () => {
      ctx.drawImage(composite, 0, 0);
      this.board.forEachMirrorRegion({ points: strokePoints }, (region) => {
        this.board.drawMirroredCanvas(ctx, composite, region, 0, 0);
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
    const w = this.board.mainCanvas.width;
    const h = this.board.mainCanvas.height;
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
    const radius = user.size * (user.pressure || 1);
    offscreen.ctx.beginPath();
    offscreen.ctx.arc(pos.x, pos.y, Math.max(0.5, radius), 0, Math.PI * 2);
    offscreen.ctx.fill();
    this.lastStampPos.set(user.id, { x: pos.x, y: pos.y });
    this._drawRemotePreview(user, offscreen.canvas, offscreen.strokePoints);
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
   * unchanged. A deferred render simply draws more accumulated mask, and since
   * `_drawRemotePreview` clears and rebuilds the whole board every time there
   * is no partial-region bookkeeping to get wrong.
   *
   * @param {Object} user - The remote user.
   * @param {{canvas: HTMLCanvasElement, strokePoints: Array}} offscreen
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
      this._drawRemotePreview(user, offscreen.canvas, offscreen.strokePoints);
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
      this._drawRemotePreview(user, live.canvas, live.strokePoints);
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

    const composite = this._buildPatternComposite(user, offscreen.canvas);
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
  }
}
