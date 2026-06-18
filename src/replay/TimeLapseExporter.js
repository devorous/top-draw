/**
 * @fileoverview Render a recorded replay tape into a video or image sequence.
 *
 * Walks the tape in fixed-size chunks of tape time per output frame, drawing
 * each step's replay output into a sized export canvas. The export canvas is
 * piped to a MediaRecorder via captureStream(fps) so the encoder samples one
 * frame per real-time interval. Wall-clock export time ≈ output video length.
 *
 * Dead air is collapsed the same way RollingTapeRecorder stamps its tape:
 * frames are stepped on a compressed "activity clock" where real time flows
 * for the first IDLE_LEADOUT_MS of any gap between deltas, then the rest of
 * the gap is dropped. Rolling-tape recordings are already compressed, so this
 * is a no-op for them; manual recordings lose their idle stretches on render.
 *
 * Optional region: when provided (board-pixel coords), the export canvas is
 * sized to the region and only that sub-rect of replay output is copied.
 */

import { ReplayEngine } from '../timebar/ReplayEngine.js';
import { drawReplayCursor } from './cursorOverlay.js';
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

/** Matches RollingTapeRecorder.IDLE_LEADOUT_MS — lead-out beat kept before a gap collapses. */
const IDLE_LEADOUT_MS = 500;

/**
 * Hold the fully-applied final state for this long at the end of a video
 * render, so the finished artwork is visible instead of a single-frame blink.
 */
const FINAL_HOLD_MS = 1000;

/** Remaining timeline entries from `fromIdx` on, shaped for engine.appendActions. */
function remainingChunk(entries, fromIdx) {
  const chunk = [];
  for (let i = fromIdx; i < entries.length; i++) {
    chunk.push({ timestamp: entries[i].ts, msg: entries[i].msg });
  }
  return chunk;
}

/**
 * Stamp every delta with a virtual timestamp on the compressed activity clock:
 * the virtual gap between consecutive deltas is the real gap capped at
 * IDLE_LEADOUT_MS. Within any (possibly capped) gap, virtual time maps 1:1 to
 * the start of the real gap, so a virtual playhead converts back to a real
 * timestamp as `lastReal + (vt - lastVirtual)`.
 *
 * @param {import('./Recorder.js').ReplayRecording} recording
 * @returns {{startTs: number, entries: Array<{vts: number, ts: number, msg: Object}>, vEnd: number}}
 */
function buildCompressedTimeline(recording) {
  const startTs = recording.startedAt;
  const deltas = recording.deltas || [];
  const realEnd = recording.endedAt ?? (deltas.length > 0 ? deltas[deltas.length - 1].ts : startTs);

  const entries = new Array(deltas.length);
  let prevReal = startTs;
  let prevVirtual = startTs;
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    const vts = prevVirtual + Math.min(Math.max(d.ts - prevReal, 0), IDLE_LEADOUT_MS);
    entries[i] = { vts, ts: d.ts, msg: d.msg };
    prevReal = d.ts;
    prevVirtual = vts;
  }
  const vEnd = prevVirtual + Math.min(Math.max(realEnd - prevReal, 0), IDLE_LEADOUT_MS);
  return { startTs, entries, vEnd };
}

/**
 * Tape duration (ms) after dead-air removal — what a render will actually
 * cover. Used by the dialog's output-length estimate.
 * @param {import('./Recorder.js').ReplayRecording} recording
 */
export function compressedTapeDurationMs(recording) {
  if (!recording) return 0;
  const deltas = recording.deltas || [];
  const startTs = recording.startedAt;
  const realEnd = recording.endedAt ?? (deltas.length > 0 ? deltas[deltas.length - 1].ts : startTs);
  let total = 0;
  let prev = startTs;
  for (let i = 0; i < deltas.length; i++) {
    total += Math.min(Math.max(deltas[i].ts - prev, 0), IDLE_LEADOUT_MS);
    prev = deltas[i].ts;
  }
  total += Math.min(Math.max(realEnd - prev, 0), IDLE_LEADOUT_MS);
  return total;
}

/**
 * @typedef {Object} TimeLapseOptions
 * @property {import('./Recorder.js').ReplayRecording} recording
 * @property {Object} wsClient                  - WebSocketClient (used by ReplayEngine for message decoding)
 * @property {number} speed                     - Playback rate multiplier (e.g. 30 = 30× faster than real time)
 * @property {number} fps                       - Output video frame rate
 * @property {'video'|'sequence'} [output='video'] - Render target format
 * @property {{x: number, y: number, width: number, height: number}|null} region - null = full board
 * @property {[number, number, number, number]} [backgroundColor] - rgba 0-255, alpha 0-1 (defaults to white)
 * @property {boolean} [transparentBackground=false] - skip the background fill so frames keep an alpha channel (image-sequence output only — WebM/VP8 video cannot store alpha)
 * @property {boolean} [renderCursors=false]    - paint bot cursor markers on each frame
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
   * Render the tape to a WebM via WebCodecs VideoEncoder + webm-muxer.
   *
   * Unlike the MediaRecorder path, this forces `hardwareAcceleration:
   * 'prefer-software'`, so it never engages the GPU WebM encoder that traps
   * (STATUS_BREAKPOINT) on large boards. It also encodes as fast as frames
   * render — no real-time pacing — so exports are quicker and deterministic.
   * @returns {Promise<{blob: Blob, mimeType: string, durationMs: number}|null>}
   */
  async _exportVideoWebCodecs() {
    const { recording, wsClient, speed, fps, region, backgroundColor, onProgress } = this._opts;
    const renderCursors = this._opts.renderCursors === true;
    if (!recording?.openingSnapshot) throw new Error('Recording missing opening snapshot');
    if (!(speed > 0)) throw new Error('Speed must be > 0');
    if (!(fps > 0)) throw new Error('FPS must be > 0');

    const [boardH, boardW] = Array.isArray(recording.openingSnapshot.boardDimensions)
      ? recording.openingSnapshot.boardDimensions
      : [1080, 1920];

    const baseRegion = region
      ? this._clampRegion(region, boardW, boardH)
      : { x: 0, y: 0, width: boardW, height: boardH };
    // Most codecs require even frame dimensions.
    const r = {
      x: baseRegion.x,
      y: baseRegion.y,
      width: Math.max(2, baseRegion.width - (baseRegion.width % 2)),
      height: Math.max(2, baseRegion.height - (baseRegion.height % 2)),
    };

    this._engine = new ReplayEngine();
    this._engine.init(boardW, boardH, wsClient);
    if (recording.assets) {
      this._engine.setAssetResolver((source) => {
        if (!source) return null;
        if (typeof source === 'string') return source;
        if (typeof source === 'object' && source.assetRef) return recording.assets[source.assetRef] ?? null;
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

    const bitrate = estimateBitrate(r.width, r.height, fps);

    // VP8 is the most reliable software path; VP9 is a smaller-file fallback.
    const codecCandidates = [
      { webcodec: 'vp8', matroska: 'V_VP8' },
      { webcodec: 'vp09.00.10.08', matroska: 'V_VP9' },
    ];
    let chosen = null;
    for (const c of codecCandidates) {
      try {
        const sup = await VideoEncoder.isConfigSupported({
          codec: c.webcodec, width: r.width, height: r.height,
          bitrate, framerate: fps, hardwareAcceleration: 'prefer-software',
        });
        if (sup.supported) { chosen = c; break; }
      } catch { /* try next */ }
    }
    if (!chosen) throw new Error('No software-encodable video codec available');

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: chosen.matroska, width: r.width, height: r.height, frameRate: fps },
    });

    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encoderError = e; } },
      error: (e) => { encoderError = e; },
    });
    encoder.configure({
      codec: chosen.webcodec, width: r.width, height: r.height,
      bitrate, framerate: fps, hardwareAcceleration: 'prefer-software', latencyMode: 'quality',
    });

    // Walk the tape on the compressed activity clock so dead air doesn't
    // produce stretches of identical frames. The engine still gets real
    // timestamps (cursor idle-hide and vector-text fades depend on them).
    const { entries, vEnd } = buildCompressedTimeline(recording);
    const tapeDuration = Math.max(1, vEnd - startTs);
    const tapePerFrameMs = (1000 / fps) * speed;
    const frameDurUs = Math.round(1_000_000 / fps);
    const keyFrameInterval = Math.max(1, Math.round(fps)); // ~1 keyframe per output second

    let deltaIdx = 0;
    let currentVts = startTs;
    let lastReal = startTs;
    let lastVirtual = startTs;
    let frameIndex = 0;
    const startedAt = performance.now();

    const encodeCurrentFrame = () => {
      this._drawFrame(r, bg);
      if (renderCursors) this._drawCursorOverlay(r);
      const frame = new VideoFrame(this._exportCanvas, {
        timestamp: frameIndex * frameDurUs,
        duration: frameDurUs,
      });
      encoder.encode(frame, { keyFrame: frameIndex % keyFrameInterval === 0 });
      frame.close();
      frameIndex++;
    };

    // First frame = state at startTs.
    encodeCurrentFrame();

    while (currentVts < vEnd && !this._cancelled && !encoderError) {
      const targetVts = Math.min(currentVts + tapePerFrameMs, vEnd);

      const chunk = [];
      while (deltaIdx < entries.length && entries[deltaIdx].vts <= targetVts) {
        const e = entries[deltaIdx];
        if (e.vts >= currentVts) chunk.push({ timestamp: e.ts, msg: e.msg });
        lastReal = e.ts;
        lastVirtual = e.vts;
        deltaIdx++;
      }
      if (chunk.length > 0) {
        // Map the virtual playhead back to a real timestamp for the engine.
        await this._engine.appendActions(chunk, lastReal + (targetVts - lastVirtual));
        if (this._cancelled || encoderError) break;
      }

      encodeCurrentFrame();
      if (onProgress) onProgress(Math.min(1, (targetVts - startTs) / tapeDuration));

      // Backpressure: drain the encoder queue so it can't balloon in memory;
      // otherwise yield occasionally so the progress bar paints.
      if (encoder.encodeQueueSize > 8) {
        while (encoder.encodeQueueSize > 2 && !this._cancelled) {
          await new Promise((res) => setTimeout(res, 0));
        }
      } else if (frameIndex % 4 === 0) {
        await new Promise((res) => setTimeout(res, 0));
      }

      currentVts = targetVts;
    }

    // Guarantee the closing state: apply any deltas the stepped walk left
    // behind (defensive — float drift in the virtual clock), then hold the
    // final frame for FINAL_HOLD_MS of output so the video ends on the
    // finished artwork.
    if (!this._cancelled && !encoderError) {
      if (deltaIdx < entries.length) {
        const rest = remainingChunk(entries, deltaIdx);
        deltaIdx = entries.length;
        await this._engine.appendActions(rest, rest[rest.length - 1].timestamp);
      }
      const holdFrames = Math.max(1, Math.round((FINAL_HOLD_MS / 1000) * fps));
      for (let i = 0; i < holdFrames && !this._cancelled && !encoderError; i++) {
        encodeCurrentFrame();
        if (encoder.encodeQueueSize > 8) {
          while (encoder.encodeQueueSize > 2 && !this._cancelled) {
            await new Promise((res) => setTimeout(res, 0));
          }
        }
      }
    }

    if (this._cancelled) {
      try { encoder.close(); } catch {}
      this._cleanup();
      return null;
    }
    if (encoderError) {
      try { encoder.close(); } catch {}
      this._cleanup();
      throw encoderError instanceof Error ? encoderError : new Error(String(encoderError));
    }

    await encoder.flush();
    muxer.finalize();
    encoder.close();
    if (onProgress) onProgress(1);

    const elapsedMs = performance.now() - startedAt;
    const blob = new Blob([target.buffer], { type: 'video/webm' });
    this._cleanup();
    return { blob, mimeType: 'video/webm', durationMs: elapsedMs };
  }

  /**
   * Legacy MediaRecorder path. Kept as a fallback for browsers without
   * WebCodecs. NOTE: this uses the hardware WebM encoder and can crash the
   * renderer on large boards (>720p) on some GPUs — prefer the WebCodecs path.
   * @returns {Promise<{blob: Blob, mimeType: string, durationMs: number}|null>}
   */
  async _exportVideoMediaRecorder() {
    const { recording, wsClient, speed, fps, region, backgroundColor, onProgress } = this._opts;
    const renderCursors = this._opts.renderCursors === true;
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

    // Same compressed activity clock as the WebCodecs path — see
    // buildCompressedTimeline for the dead-air removal rules.
    const { entries, vEnd } = buildCompressedTimeline(recording);
    const tapeDuration = Math.max(1, vEnd - startTs);

    const frameIntervalMs = 1000 / fps;
    const tapePerFrameMs = frameIntervalMs * speed;

    let deltaIdx = 0;
    let currentVts = startTs;
    let lastReal = startTs;
    let lastVirtual = startTs;
    const startedAt = performance.now();

    while (currentVts < vEnd && !this._cancelled) {
      const targetVts = Math.min(currentVts + tapePerFrameMs, vEnd);

      const chunk = [];
      while (deltaIdx < entries.length && entries[deltaIdx].vts <= targetVts) {
        const e = entries[deltaIdx];
        if (e.vts >= currentVts) {
          chunk.push({ timestamp: e.ts, msg: e.msg });
        }
        lastReal = e.ts;
        lastVirtual = e.vts;
        deltaIdx++;
      }

      if (chunk.length > 0) {
        await this._engine.appendActions(chunk, lastReal + (targetVts - lastVirtual));
        if (this._cancelled) break;
      }

      this._drawFrame(r, bg);
      if (renderCursors) this._drawCursorOverlay(r);

      if (onProgress) {
        onProgress(Math.min(1, (targetVts - startTs) / tapeDuration));
      }

      // Pace to real-time so MediaRecorder samples one frame per interval.
      await sleep(frameIntervalMs);
      currentVts = targetVts;
    }

    // Guarantee the closing state: apply any deltas the stepped walk left
    // behind, then hold the final frame so the video ends on the finished
    // artwork (also lets MediaRecorder flush a clean last frame).
    if (!this._cancelled) {
      if (deltaIdx < entries.length) {
        const rest = remainingChunk(entries, deltaIdx);
        deltaIdx = entries.length;
        await this._engine.appendActions(rest, rest[rest.length - 1].timestamp);
      }
      this._drawFrame(r, bg);
      if (renderCursors) this._drawCursorOverlay(r);
      await sleep(FINAL_HOLD_MS);
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
      // Prefer WebCodecs (software VideoEncoder) — it sidesteps MediaRecorder's
      // hardware WebM encoder, which crashes the renderer on large boards
      // (>720p) on some GPUs. Fall back to MediaRecorder only where WebCodecs
      // is unavailable (older browsers), accepting its size limits there.
      const result = typeof VideoEncoder !== 'undefined'
        ? await this._exportVideoWebCodecs()
        : await this._exportVideoMediaRecorder();
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
    const renderCursors = this._opts.renderCursors === true;
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

    const { entries, vEnd } = buildCompressedTimeline(recording);
    const tapeDuration = Math.max(1, vEnd - startTs);

    const frameIntervalMs = 1000 / fps;
    const tapePerFrameMs = frameIntervalMs * speed;

    return {
      r,
      bg,
      startTs,
      vEnd,
      tapeDuration,
      tapePerFrameMs,
      entries,
      renderCursors,
      onProgress,
    };
  }

  async _exportImageSequence(prepared) {
    const { r, bg, startTs, vEnd, tapeDuration, tapePerFrameMs, entries, renderCursors, onProgress } = prepared;
    const startedAt = performance.now();
    const frames = [];
    const totalFrames = Math.max(1, Math.ceil(tapeDuration / tapePerFrameMs) + 1);
    let frameIndex = 0;

    const addFrame = async () => {
      if (renderCursors) this._drawCursorOverlay(r);
      const blob = await canvasToBlob(this._exportCanvas, 'image/png');
      frames.push({
        name: `frame_${String(frameIndex + 1).padStart(6, '0')}.png`,
        blob,
      });
      frameIndex++;
      if (onProgress) onProgress(Math.min(1, frameIndex / totalFrames));
      await yieldToBrowser();
    };

    await addFrame();

    const cursor = { idx: 0, lastReal: startTs, lastVirtual: startTs };
    let currentVts = startTs;
    while (currentVts < vEnd && !this._cancelled) {
      const targetVts = Math.min(currentVts + tapePerFrameMs, vEnd);

      await this._appendReplayActions(entries, cursor, currentVts, targetVts);
      if (this._cancelled) break;

      this._drawFrame(r, bg);
      await addFrame();
      currentVts = targetVts;
    }

    // Guarantee the closing state: if the stepped walk left deltas behind
    // (defensive — float drift in the virtual clock), apply them and emit one
    // more frame so the sequence always ends on the finished artwork.
    if (!this._cancelled && cursor.idx < entries.length) {
      const rest = remainingChunk(entries, cursor.idx);
      cursor.idx = entries.length;
      await this._engine.appendActions(rest, rest[rest.length - 1].timestamp);
      this._drawFrame(r, bg);
      await addFrame();
    }

    if (this._cancelled) {
      this._cleanup();
      return null;
    }

    if (onProgress) onProgress(1);
    const blob = await buildStoredZip(frames);
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

  /**
   * Feed the engine every compressed-timeline entry inside (currentVts,
   * targetVts]. `cursor` ({idx, lastReal, lastVirtual}) is advanced in place
   * so successive calls walk the tape and can map virtual time back to real.
   */
  async _appendReplayActions(entries, cursor, currentVts, targetVts) {
    const chunk = [];
    while (cursor.idx < entries.length && entries[cursor.idx].vts <= targetVts) {
      const e = entries[cursor.idx];
      if (e.vts >= currentVts) {
        chunk.push({ timestamp: e.ts, msg: e.msg });
      }
      cursor.lastReal = e.ts;
      cursor.lastVirtual = e.vts;
      cursor.idx++;
    }

    if (chunk.length > 0) {
      await this._engine.appendActions(chunk, cursor.lastReal + (targetVts - cursor.lastVirtual));
    }
  }

  _drawFrame(r, bg) {
    const ctx = this._exportCtx;
    // Transparent background: clear to fully-transparent pixels instead of
    // painting the board color, so PNG frames keep their alpha channel. Only
    // honored for image-sequence output (the WebM/VP8 video path is forced to
    // an opaque background by the encoder anyway).
    if (this._opts.transparentBackground && this._opts.output === 'sequence') {
      ctx.clearRect(0, 0, r.width, r.height);
    } else {
      ctx.fillStyle = `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${bg[3]})`;
      ctx.fillRect(0, 0, r.width, r.height);
    }
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
      // Same idle gating as ReplayEngine.drawCursors: skip lurkers who never
      // drew (no _lastCursorTs — present in the opening snapshot but silent)
      // and cursors idle past the threshold, so a frozen marker doesn't linger
      // for the whole export.
      if (typeof engine.isCursorVisible === 'function' && !engine.isCursorVisible(user)) continue;
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
  // VP8 is preferred over VP9 here on purpose: VP9 routes through the GPU
  // hardware encoder on some driver/GPU combos and traps (renderer crash /
  // STATUS_BREAKPOINT on Windows) even for tiny clips. VP8 uses the stable
  // (software) path. Slightly larger files, but it doesn't take the tab down.
  // The export stream is video-only (canvas.captureStream), so no audio codec.
  const candidates = [
    'video/webm;codecs=vp8',
    'video/webm',
    'video/webm;codecs=vp9',
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
export function suggestVideoFilename(rec, ext = 'webm', settings = {}) {
  return `${suggestBaseFilename(rec, settings)}.${ext}`;
}

export function suggestImageSequenceFilename(rec, settings = {}) {
  return `${suggestBaseFilename(rec, settings)}_frames.zip`;
}

function suggestBaseFilename(rec, settings = {}) {
  const d = new Date(rec.startedAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const room = (rec.roomId || 'replay').replace(/[^a-z0-9_-]/gi, '_');
  // Embed the render settings so different speed/fps passes are distinguishable.
  const parts = [];
  if (settings.speed) parts.push(`${settings.speed}x`);
  if (settings.fps) parts.push(`${settings.fps}fps`);
  const settingsTag = parts.length ? `_${parts.join('_')}` : '';
  // Unique-per-render suffix keyed off the current time so re-rendering the
  // same recording doesn't collide (browser would otherwise append " (1)").
  const uniq = Date.now().toString(36).slice(-5);
  return `ddraw_${room}_${stamp}${settingsTag}_${uniq}`;
}
