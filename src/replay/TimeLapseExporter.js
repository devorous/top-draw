/**
 * @fileoverview Render a recorded replay tape into a video or image sequence.
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
import { drawReplayCursor } from './cursorOverlay.js';

/**
 * @typedef {Object} TimeLapseOptions
 * @property {import('./Recorder.js').ReplayRecording} recording
 * @property {Object} wsClient                  - WebSocketClient (used by ReplayEngine for message decoding)
 * @property {number} speed                     - Playback rate multiplier (e.g. 30 = 30× faster than real time)
 * @property {number} fps                       - Output video frame rate
 * @property {'video'|'sequence'} [output='video'] - Render target format
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
  async _exportVideoLegacy() {
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

  /**
   * Run the export. Resolves to an output Blob or null if cancelled.
   * @returns {Promise<{blob: Blob, mimeType: string, durationMs: number, kind: 'video'|'sequence', frameCount?: number}|null>}
   */
  async export() {
    if (this._opts.output !== 'sequence') {
      const result = await this._exportVideoLegacy();
      return result ? { ...result, kind: 'video' } : null;
    }

    try {
      const prepared = await this._prepareReplay();
      if (this._cancelled) {
        this._cleanup();
        return null;
      }
      return await this._exportImageSequence(prepared);
    } catch (err) {
      this._cleanup();
      throw err;
    }
  }

  async _prepareReplay() {
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

    await this._engine.loadSnapshot(recording.openingSnapshot);
    if (this._cancelled) return null;
    const startTs = recording.startedAt;
    await this._engine.processActions([], startTs);
    if (this._cancelled) return null;

    this._drawFrame(r, bg);

    const endTs = recording.endedAt ?? (recording.deltas.length > 0
      ? recording.deltas[recording.deltas.length - 1].ts
      : startTs);
    const tapeDuration = Math.max(1, endTs - startTs);

    const frameIntervalMs = 1000 / fps;
    const tapePerFrameMs = frameIntervalMs * speed;

    return {
      r,
      bg,
      startTs,
      endTs,
      tapeDuration,
      tapePerFrameMs,
      deltas: recording.deltas,
      renderCursors,
      onProgress,
    };
  }

  async _exportImageSequence(prepared) {
    const { r, bg, startTs, endTs, tapeDuration, tapePerFrameMs, deltas, renderCursors, onProgress } = prepared;
    const startedAt = performance.now();
    const entries = [];
    const totalFrames = Math.max(1, Math.ceil(tapeDuration / tapePerFrameMs) + 1);
    let frameIndex = 0;

    const addFrame = async () => {
      if (renderCursors) this._drawCursorOverlay(r);
      const blob = await canvasToBlob(this._exportCanvas, 'image/png');
      entries.push({
        name: `frame_${String(frameIndex + 1).padStart(6, '0')}.png`,
        blob,
      });
      frameIndex++;
      if (onProgress) onProgress(Math.min(1, frameIndex / totalFrames));
      await yieldToBrowser();
    };

    await addFrame();

    let deltaIdx = 0;
    let currentTs = startTs;
    while (currentTs < endTs && !this._cancelled) {
      const targetTs = Math.min(currentTs + tapePerFrameMs, endTs);

      deltaIdx = await this._appendReplayActions(deltas, deltaIdx, currentTs, targetTs);
      if (this._cancelled) break;

      this._drawFrame(r, bg);
      await addFrame();
      currentTs = targetTs;
    }

    if (this._cancelled) {
      this._cleanup();
      return null;
    }

    if (onProgress) onProgress(1);
    const blob = await buildStoredZip(entries);
    const elapsedMs = performance.now() - startedAt;
    this._cleanup();
    return {
      blob,
      mimeType: 'application/zip',
      durationMs: elapsedMs,
      kind: 'sequence',
      frameCount: frameIndex,
    };
  }

  async _appendReplayActions(deltas, deltaIdx, currentTs, targetTs) {
    const chunk = [];
    while (deltaIdx < deltas.length && deltas[deltaIdx].ts <= targetTs) {
      if (deltas[deltaIdx].ts >= currentTs) {
        chunk.push({ timestamp: deltas[deltaIdx].ts, msg: deltas[deltaIdx].msg });
      }
      deltaIdx++;
    }

    if (chunk.length > 0) {
      await this._engine.appendActions(chunk, targetTs);
    }
    return deltaIdx;
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
    // Ephemeral vector text is content (not a cursor), so it's always drawn,
    // faded by playhead age. Offset by the region origin to match the crop.
    this._engine.drawVectorText(ctx, r.x, r.y);
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

    for (const user of engine.botUsers.values()) {
      const x = Number(user?.x);
      const y = Number(user?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const size = Math.max(1, Number(user.size) || 10);
      const margin = size + 30;
      const cx = x - r.x;
      const cy = y - r.y;
      if (cx < -margin || cy < -margin || cx > r.width + margin || cy > r.height + margin) continue;

      // Shared with the live mini/full replay (ReplayEngine.drawCursors).
      // Offset by the export region origin so cursors land at native size.
      drawReplayCursor(ctx, user, r.x, r.y);
    }
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

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode frame'));
    }, type);
  });
}

async function buildStoredZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const { dosTime, dosDate } = getDosDateTime(new Date());
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(bytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, bytes);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + bytes.length;
    centralSize += central.length;
  }

  const centralOffset = offset;
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  eocdView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
}

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Return a CSS rgba() string that preserves the user's color identity but
 * floors its perceived luminance so dim/dark brush colors still produce a
 * readable label. Mixes toward white until lum ≥ 0.55.
 */
/**
 * Build a sensible default filename for the export.
 * @param {import('./Recorder.js').ReplayRecording} rec
 * @param {string} ext - e.g. 'webm'
 */
export function suggestVideoFilename(rec, ext = 'webm') {
  return `${suggestBaseFilename(rec)}.${ext}`;
}

export function suggestImageSequenceFilename(rec) {
  return `${suggestBaseFilename(rec)}_frames.zip`;
}

function suggestBaseFilename(rec) {
  const d = new Date(rec.startedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const room = (rec.roomId || 'replay').replace(/[^a-z0-9_-]/gi, '_');
  return `ddraw_${room}_${stamp}`;
}
