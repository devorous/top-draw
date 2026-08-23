/**
 * @fileoverview Captures periodic full-board stills while a session is live, so a
 * sparse "time-lapse" webm can be built when the user uploads to the gallery.
 *
 * Design: every ~6s we snapshot the whole composited board (stored as a webp blob
 * so the frames page out of the JS heap). Frames are full-board, so at save time we crop
 * the SAME board-space rect out of every frame — they self-align with no padding,
 * whether the crop comes from a saved selection or the uploader's drawing bounds.
 *
 * Dead air is collapsed by comparing a tiny per-frame signature: an unchanged board
 * doesn't add a frame. This catches both local and remote drawing (a remote user
 * working inside your crop region should appear), without hooking input paths.
 */

// Dense enough that a short session reads as motion rather than a slideshow.
const DEFAULT_INTERVAL_MS = 6_000;
// Hard cap; older frames are decimated past this. Held at 120 deliberately —
// the denser interval buys temporal detail for typical sessions without moving
// the memory ceiling, and a long session decimates back to ~20s spacing.
const MAX_FRAMES = 120;
// Stored frames are the encoder's source pixels — clips are encoded natively, so
// this ceiling is what "full res" means. 2048 keeps the default 1920-wide board 1:1.
const STORAGE_MAX_DIM = 2048;  // longest edge of a stored frame (px)
const STORAGE_QUALITY = 0.82;  // webp quality for stored frames
const SIG_DIM = 32;            // signature thumbnail edge (px) for dead-air dedup

export class TimelapseCapturer {
  /**
   * @param {import('../canvas/Board.js').Board} board
   * @param {{ intervalMs?: number, shouldCapture?: () => boolean }} [options]
   */
  constructor(board, { intervalMs = DEFAULT_INTERVAL_MS, shouldCapture = null } = {}) {
    this.board = board;
    this.intervalMs = intervalMs;
    // Predicate gating capture — only entitled users accumulate frames, so the
    // 99% who can't use the feature don't pay the per-minute encode/memory cost.
    this._shouldCapture = typeof shouldCapture === 'function' ? shouldCapture : () => true;
    /** @type {{ blob: Blob, ts: number, w: number, h: number, sig: number }[]} */
    this._frames = [];
    this._timer = null;
    this._capturing = false;
    this._enabled = false;
    this._scale = 1;       // stored px / board px (constant for a fixed board)
    this._sigCanvas = null;
  }

  start() {
    if (this._enabled) return;
    this._enabled = true;
    // Grab a baseline frame right away so even a short session has a start point.
    this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    this._enabled = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** Clear captured frames (call after a successful upload). */
  reset() {
    this._frames = [];
  }

  destroy() {
    this.stop();
    this._frames = [];
    this._sigCanvas = null;
  }

  get frameCount() { return this._frames.length; }
  hasFrames() { return this._frames.length > 0; }

  /**
   * Crop the captured stills to a board-space rect and encode them into a WebM.
   * Returns null when there aren't enough distinct frames to make a meaningful
   * clip (a 1-frame "time-lapse" isn't worth uploading).
   * @param {{x:number,y:number,width:number,height:number}|null} boardRect
   * @param {{ onProgress?: (p:number)=>void }} [opts]
   * @returns {Promise<Blob|null>}
   */
  async renderWebm(boardRect, opts = {}) {
    const cropped = await this.getCroppedFrames(boardRect);
    if (!cropped || cropped.frames.length < 2) return null;
    const { encodeFramesToWebm, normalizedPerFrameMs } = await import('./timelapseEncoder.js');
    return encodeFramesToWebm(cropped.frames, {
      perFrameMs: normalizedPerFrameMs(cropped.frames.length),
      onProgress: opts.onProgress,
    });
  }

  async _tick(force = false) {
    if (this._capturing) return;
    if (!force && !this._shouldCapture()) return;
    this._capturing = true;
    try {
      const frame = await this._captureFrame();
      if (frame) this._pushFrame(frame);
    } catch (err) {
      console.warn('[Timelapse] capture failed:', err);
    } finally {
      this._capturing = false;
    }
  }

  _pushFrame(frame) {
    const last = this._frames[this._frames.length - 1];
    if (last && last.sig === frame.sig) {
      // Board unchanged since the last frame — collapse the dead air, but keep
      // the timestamp fresh so the gap is attributed to the latest moment.
      last.ts = frame.ts;
      return;
    }
    this._frames.push(frame);
    if (this._frames.length > MAX_FRAMES) this._decimate();
  }

  /**
   * Halve the density of the older half of the buffer when over the cap, keeping
   * the newest frames intact. Preserves the full time span at coarser spacing
   * rather than dropping the (interesting) beginning of the drawing.
   */
  _decimate() {
    const n = this._frames.length;
    const kept = [];
    for (let i = 0; i < n; i++) {
      if (i >= n - 8 || i % 2 === 0) kept.push(this._frames[i]);
    }
    this._frames = kept;
  }

  async _captureFrame() {
    const layerManager = this.board?.layerManager;
    const src = this.board?.mainCanvas;
    if (!src || !src.width || !src.height) return null;

    const scale = Math.min(1, STORAGE_MAX_DIM / Math.max(src.width, src.height));
    this._scale = scale;
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    // Composite over the room background so transparent regions aren't black in
    // the (alpha-less) webp/webm output.
    const [r, g, b] = this.board.backgroundColor || [255, 255, 255, 1];
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, w, h);
    // Render with every layer forced visible, ignoring the local show/hide
    // toggle: mainCanvas reflects whatever the user has hidden at this
    // instant, and sampling it directly made a mid-session layer toggle
    // flicker the layer in/out of the finished clip.
    if (layerManager) {
      // Borrowed from the canvas pool and returned immediately: this runs on a
      // 6 s timer for the whole session, and allocating a full-board canvas
      // each time is a stall that no JS timer can see. The canvas is consumed
      // by drawImage and never referenced again, which is the precondition
      // getCompositedCanvas documents for `pooled`.
      const composited = layerManager.getCompositedCanvas({ ignoreVisibility: true, pooled: true });
      try {
        ctx.drawImage(composited, 0, 0, w, h);
      } finally {
        layerManager.releaseCompositedCanvas(composited);
      }
    } else {
      ctx.drawImage(src, 0, 0, w, h);
    }

    const sig = this._signature(c);
    const blob = await new Promise(res => c.toBlob(res, 'image/webp', STORAGE_QUALITY));
    if (!blob) return null;
    return { blob, ts: Date.now(), w, h, sig };
  }

  /** Cheap 32×32 checksum of the frame, used only to skip unchanged frames. */
  _signature(frameCanvas) {
    if (!this._sigCanvas) {
      this._sigCanvas = document.createElement('canvas');
      this._sigCanvas.width = SIG_DIM;
      this._sigCanvas.height = SIG_DIM;
    }
    const ctx = this._sigCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(frameCanvas, 0, 0, SIG_DIM, SIG_DIM);
    const data = ctx.getImageData(0, 0, SIG_DIM, SIG_DIM).data;
    let hash = 0x811c9dc5; // FNV-1a 32-bit
    for (let i = 0; i < data.length; i += 4) {
      // Mix RGB (skip alpha — it's opaque after the bg fill).
      hash = (hash ^ data[i]) >>> 0; hash = Math.imul(hash, 0x01000193) >>> 0;
      hash = (hash ^ data[i + 1]) >>> 0; hash = Math.imul(hash, 0x01000193) >>> 0;
      hash = (hash ^ data[i + 2]) >>> 0; hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  /**
   * Decode the stored frames and crop each to a board-space rect, producing
   * uniformly-sized canvases ready to feed a video encoder. Captures one final
   * fresh frame first so the clip ends on the current board state.
   *
   * @param {{x:number,y:number,width:number,height:number}|null} boardRect
   *   Region in board pixels. Null = whole board.
   * @returns {Promise<{ frames: HTMLCanvasElement[], width: number, height: number }|null>}
   */
  async getCroppedFrames(boardRect) {
    await this._tick(true); // end the clip on the latest board state (deduped if idle)
    if (this._frames.length === 0) return null;

    const scale = this._scale || 1;
    const fw = this._frames[0].w;
    const fh = this._frames[0].h;

    // Map the board-space rect into stored-frame pixels, clamp to the frame, and
    // force even dimensions (VP8 requires even width/height).
    let sx = 0, sy = 0, sw = fw, sh = fh;
    if (boardRect) {
      sx = Math.round(boardRect.x * scale);
      sy = Math.round(boardRect.y * scale);
      sw = Math.round(boardRect.width * scale);
      sh = Math.round(boardRect.height * scale);
    }
    sx = Math.max(0, Math.min(sx, fw - 2));
    sy = Math.max(0, Math.min(sy, fh - 2));
    sw = Math.max(2, Math.min(sw, fw - sx));
    sh = Math.max(2, Math.min(sh, fh - sy));
    sw -= sw % 2;
    sh -= sh % 2;

    const frames = [];
    for (const f of this._frames) {
      let bmp = null;
      try {
        bmp = await createImageBitmap(f.blob);
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
        frames.push(c);
      } catch (err) {
        console.warn('[Timelapse] frame decode failed:', err);
      } finally {
        bmp?.close?.();
      }
    }
    if (frames.length === 0) return null;
    return { frames, width: sw, height: sh };
  }
}
