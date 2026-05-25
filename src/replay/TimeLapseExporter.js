/**
 * @fileoverview Render a recorded replay tape into a video file.
 *
 * Walks the tape in fixed-size chunks of tape time per output frame, drawing
 * each step's replay output into a sized export canvas. The export canvas is
 * piped to a MediaRecorder via captureStream(fps) so the encoder samples one
 * frame per real-time interval. Wall-clock export time ≈ output video length.
 *
 * Optional region: when provided (board-pixel coords), the export canvas is
 * sized to the region and only that sub-rect of replay output is copied.
 */

import { ReplayEngine } from '../timebar/ReplayEngine.js';

/**
 * @typedef {Object} TimeLapseOptions
 * @property {import('./Recorder.js').ReplayRecording} recording
 * @property {Object} wsClient                  - WebSocketClient (used by ReplayEngine for message decoding)
 * @property {number} speed                     - Playback rate multiplier (e.g. 30 = 30× faster than real time)
 * @property {number} fps                       - Output video frame rate
 * @property {{x: number, y: number, width: number, height: number}|null} region - null = full board
 * @property {[number, number, number, number]} [backgroundColor] - rgba 0-255, alpha 0-1 (defaults to white)
 * @property {boolean} [renderCursors=true]     - paint bot cursor markers on each frame
 * @property {(progress: number) => void} [onProgress] - 0..1
 */

export class TimeLapseExporter {
  /** @param {TimeLapseOptions} opts */
  constructor(opts) {
    this._opts = opts;
    this._cancelled = false;
    this._engine = null;
    this._exportCanvas = null;
    this._exportCtx = null;
    this._recorder = null;
    this._stream = null;
  }

  cancel() {
    this._cancelled = true;
    if (this._recorder && this._recorder.state !== 'inactive') {
      try { this._recorder.stop(); } catch {}
    }
  }

  /**
   * Run the export. Resolves to a video Blob (WebM) or null if cancelled.
   * @returns {Promise<{blob: Blob, mimeType: string, durationMs: number}|null>}
   */
  async export() {
    const { recording, wsClient, speed, fps, region, backgroundColor, onProgress } = this._opts;
    const renderCursors = this._opts.renderCursors !== false;
    if (!recording?.openingSnapshot) throw new Error('Recording missing opening snapshot');
    if (!(speed > 0)) throw new Error('Speed must be > 0');
    if (!(fps > 0)) throw new Error('FPS must be > 0');

    const [boardH, boardW] = Array.isArray(recording.openingSnapshot.boardDimensions)
      ? recording.openingSnapshot.boardDimensions
      : [1080, 1920];

    const r = region
      ? this._clampRegion(region, boardW, boardH)
      : { x: 0, y: 0, width: boardW, height: boardH };

    // Engine renders at full board size; export canvas crops to region.
    this._engine = new ReplayEngine();
    this._engine.init(boardW, boardH, wsClient);
    if (recording.assets) {
      this._engine.setAssetResolver((source) => {
        if (!source) return null;
        if (typeof source === 'string') return source;
        if (typeof source === 'object' && source.assetRef) {
          return recording.assets[source.assetRef] ?? null;
        }
        return null;
      });
    }

    this._exportCanvas = document.createElement('canvas');
    this._exportCanvas.width = r.width;
    this._exportCanvas.height = r.height;
    this._exportCtx = this._exportCanvas.getContext('2d');
    this._exportCtx.imageSmoothingEnabled = true;

    const bg = backgroundColor || recording.openingSnapshot.backgroundColor || [255, 255, 255, 1];

    // Load opening snapshot, then rebase so the snapshot pixels actually land
    // on the engine's base canvas (loadSnapshot alone doesn't paint — the
    // rebase happens inside _runActionBatch when rebaseSnapshot=true).
    await this._engine.loadSnapshot(recording.openingSnapshot);
    if (this._cancelled) return null;
    const startTs = recording.startedAt;
    await this._engine.processActions([], startTs);
    if (this._cancelled) return null;

    // Paint one frame before MediaRecorder starts so first sample isn't blank.
    this._drawFrame(r, bg);

    this._stream = this._exportCanvas.captureStream(fps);
    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      this._cleanup();
      throw new Error('No supported video MIME type for MediaRecorder');
    }

    const chunks = [];
    this._recorder = new MediaRecorder(this._stream, {
      mimeType,
      videoBitsPerSecond: estimateBitrate(r.width, r.height, fps),
    });
    this._recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    const recorderStopped = new Promise((resolve) => {
      this._recorder.onstop = () => resolve();
    });
    this._recorder.start();

    const endTs = recording.endedAt ?? (recording.deltas.length > 0
      ? recording.deltas[recording.deltas.length - 1].ts
      : startTs);
    const tapeDuration = Math.max(1, endTs - startTs);

    const frameIntervalMs = 1000 / fps;
    const tapePerFrameMs = frameIntervalMs * speed;

    const deltas = recording.deltas;
    let deltaIdx = 0;
    let currentTs = startTs;
    const startedAt = performance.now();

    while (currentTs < endTs && !this._cancelled) {
      const targetTs = Math.min(currentTs + tapePerFrameMs, endTs);

      const chunk = [];
      while (deltaIdx < deltas.length && deltas[deltaIdx].ts <= targetTs) {
        if (deltas[deltaIdx].ts >= currentTs) {
          chunk.push({ timestamp: deltas[deltaIdx].ts, msg: deltas[deltaIdx].msg });
        }
        deltaIdx++;
      }

      if (chunk.length > 0) {
        await this._engine.appendActions(chunk, targetTs);
        if (this._cancelled) break;
      }

      this._drawFrame(r, bg);
      if (renderCursors) this._drawCursorOverlay(r);

      if (onProgress) {
        onProgress(Math.min(1, (targetTs - startTs) / tapeDuration));
      }

      // Pace to real-time so MediaRecorder samples one frame per interval.
      await sleep(frameIntervalMs);
      currentTs = targetTs;
    }

    // Hold the final frame for ~250 ms so the video doesn't end mid-stroke
    // visually. Also lets MediaRecorder flush a clean last frame.
    if (!this._cancelled) {
      this._drawFrame(r, bg);
      if (renderCursors) this._drawCursorOverlay(r);
      await sleep(250);
    }

    try { this._recorder.stop(); } catch {}
    try { for (const t of this._stream.getTracks()) t.stop(); } catch {}
    await recorderStopped;

    const elapsedMs = performance.now() - startedAt;
    this._cleanup();
    if (this._cancelled) return null;

    const blob = new Blob(chunks, { type: mimeType });
    return { blob, mimeType, durationMs: elapsedMs };
  }

  _drawFrame(r, bg) {
    const ctx = this._exportCtx;
    ctx.fillStyle = `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${bg[3]})`;
    ctx.fillRect(0, 0, r.width, r.height);
    if (this._engine.outputCanvas) {
      ctx.drawImage(
        this._engine.outputCanvas,
        r.x, r.y, r.width, r.height,
        0, 0, r.width, r.height,
      );
    }
  }

  /**
   * Paint the engine's current bot-cursor markers (one per active replay user)
   * onto the export canvas, clipped to the export region. Matches the live
   * SVG cursor (RemoteUserUI.createRemoteUser): a 1px stroked ring at the
   * user's position, radius = user.size, stroke = user.color. For select tool
   * it also draws the crosshair; for imageBrush/blur it draws the size square.
   * The username label is rendered in the same color above the cursor.
   * @private
   */
  _drawCursorOverlay(r) {
    const ctx = this._exportCtx;
    const engine = this._engine;
    if (!ctx || !engine?.botUsers) return;

    ctx.save();
    for (const user of engine.botUsers.values()) {
      const x = Number(user?.x);
      const y = Number(user?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const cx = x - r.x;
      const cy = y - r.y;
      const size = Math.max(1, Number(user.size) || 10);
      const margin = size + 30;
      if (cx < -margin || cy < -margin || cx > r.width + margin || cy > r.height + margin) continue;

      const c = Array.isArray(user.color) ? user.color : [120, 120, 120, 1];
      const alpha = typeof c[3] === 'number' ? c[3] : 1;
      const strokeStr = `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${alpha})`;
      const tool = user.tool || 'brush';

      // Live ring uses 1px stroke at brush radius. Same here. White halo so
      // the ring stays visible over both light and dark canvas regions.
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = strokeStr;
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.stroke();

      // Tool-specific embellishments (mirror RemoteUserUI):
      //   select tool      → 10px crosshair through center
      //   imageBrush / blur → 2× size hollow square (brush footprint)
      if (tool === 'select') {
        const ch = 10;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy);
        ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch);
        ctx.strokeStyle = strokeStr;
        ctx.stroke();
      } else if (tool === 'imageBrush' || tool === 'blur') {
        ctx.lineWidth = 1;
        ctx.strokeStyle = strokeStr;
        ctx.strokeRect(cx - size, cy - size, size * 2, size * 2);
      }

      // Username label — keep the ring tinted by the bot's color, but lift
      // the label's color toward white so it stays readable when the brush
      // is dark or near-black. Pure brush color (e.g. #000) made the name
      // disappear into the canvas.
      const name = String(user.username || `User ${user.id}`);
      const fontPx = Math.min(16, Math.max(10, Math.round(size * 0.6 + 8)));
      ctx.font = `${fontPx}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'center';
      const labelColor = _brightenForReadability(c);
      // Thin dark outline gives separation from light backgrounds.
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.strokeText(name, cx, cy - size - 4);
      ctx.fillStyle = labelColor;
      ctx.fillText(name, cx, cy - size - 4);
    }
    ctx.restore();
  }

  _clampRegion(region, boardW, boardH) {
    const x = Math.max(0, Math.min(boardW - 1, Math.floor(region.x)));
    const y = Math.max(0, Math.min(boardH - 1, Math.floor(region.y)));
    const width = Math.max(1, Math.min(boardW - x, Math.floor(region.width)));
    const height = Math.max(1, Math.min(boardH - y, Math.floor(region.height)));
    return { x, y, width, height };
  }

  _cleanup() {
    this._engine = null;
    this._exportCanvas = null;
    this._exportCtx = null;
    this._recorder = null;
    this._stream = null;
  }
}

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  // VP9 produces smaller files; VP8 is the universal fallback.
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

function estimateBitrate(width, height, fps) {
  // Loose target: 0.12 bits per pixel per frame. Caps at 16 Mbps so a 4K
  // 60fps export doesn't try to allocate gigabytes of audio buffer.
  const pixels = width * height;
  const bps = Math.round(pixels * fps * 0.12);
  return Math.min(16_000_000, Math.max(800_000, bps));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return a CSS rgba() string that preserves the user's color identity but
 * floors its perceived luminance so dim/dark brush colors still produce a
 * readable label. Mixes toward white until lum ≥ 0.55.
 */
function _brightenForReadability(rgba) {
  const r0 = rgba[0] | 0, g0 = rgba[1] | 0, b0 = rgba[2] | 0;
  const lum = (0.299 * r0 + 0.587 * g0 + 0.114 * b0) / 255;
  const target = 0.55;
  if (lum >= target) return `rgba(${r0}, ${g0}, ${b0}, 1)`;
  const t = Math.min(1, (target - lum) / (1 - lum));
  const r = Math.round(r0 + (255 - r0) * t);
  const g = Math.round(g0 + (255 - g0) * t);
  const b = Math.round(b0 + (255 - b0) * t);
  return `rgba(${r}, ${g}, ${b}, 1)`;
}


/**
 * Build a sensible default filename for the export.
 * @param {import('./Recorder.js').ReplayRecording} rec
 * @param {string} ext - e.g. 'webm'
 */
export function suggestVideoFilename(rec, ext = 'webm') {
  const d = new Date(rec.startedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const room = (rec.roomId || 'replay').replace(/[^a-z0-9_-]/gi, '_');
  return `topdraw_${room}_${stamp}.${ext}`;
}
