/**
 * @fileoverview Encode a list of still frames into a WebM video.
 *
 * Mirrors the software-VP8 WebCodecs path in TimeLapseExporter (which is bound
 * to the replay tape) but operates on a plain array of same-sized canvases — the
 * sparse stills captured by TimelapseCapturer. Each still is held on screen for
 * `perFrameMs`; the final still lingers for `finalHoldMs` so the loop ends on the
 * finished artwork. Forces `prefer-software` to avoid the GPU WebM encoder that
 * traps (STATUS_BREAKPOINT) on large boards.
 *
 * Output is encoded at the source frames' native resolution: the lightbox plays
 * these clips at full size, so a downscaled encode read as mush there.
 */

import { Muxer, ArrayBufferTarget } from 'webm-muxer';

/** Loose bitrate target: 0.12 bits per pixel per frame, clamped. */
function estimateBitrate(width, height, fps) {
  const bps = Math.round(width * height * fps * 0.12);
  return Math.min(16_000_000, Math.max(800_000, bps));
}

/** A downscaled clip may not take its longest edge below this. */
const MIN_OUTPUT_EDGE = 320;

/**
 * Encoded dimensions for a source frame size: native by default, floored to
 * even (VP8/VP9 require it). A caller asking for `scale` < 1 gets that linear
 * downscale, but never below MIN_OUTPUT_EDGE and never upscaled past source.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale]
 * @returns {{width: number, height: number}}
 */
export function timelapseOutputDims(width, height, scale = 1) {
  const longest = Math.max(width, height);
  let s = Math.max(0, Math.min(1, scale));
  if (longest > 0 && longest * s < MIN_OUTPUT_EDGE) s = Math.min(1, MIN_OUTPUT_EDGE / longest);
  const even = (v) => {
    const n = Math.max(2, Math.round(v * s));
    return n - (n % 2);
  };
  return { width: even(width), height: even(height) };
}

/** Target total clip length used to normalize per-still hold time. */
const TARGET_CLIP_MS = 9_000;

/**
 * Per-still hold time that lands the clip near TARGET_CLIP_MS regardless of
 * how many stills the session produced, clamped so sparse clips don't crawl
 * (≤400ms/still) and frame-dense ones don't strobe (≥100ms/still). The dense
 * end reads as motion rather than a slideshow.
 * @param {number} frameCount
 * @param {number} [targetMs]
 * @returns {number}
 */
export function normalizedPerFrameMs(frameCount, targetMs = TARGET_CLIP_MS) {
  if (!Number.isFinite(frameCount) || frameCount < 1) return 300;
  return Math.round(Math.min(400, Math.max(100, targetMs / frameCount)));
}

/**
 * @param {HTMLCanvasElement[]} frames - same-sized, even-dimensioned canvases
 * @param {Object} [opts]
 * @param {number} [opts.fps=30]
 * @param {number} [opts.perFrameMs=300]   - on-screen time per still
 * @param {number} [opts.finalHoldMs=1400] - extra hold on the last still
 * @param {number} [opts.scale=1] - linear downscale of the source frames; 1 = native
 * @param {(p: number) => void} [opts.onProgress] - 0..1
 * @returns {Promise<Blob|null>} WebM blob, or null if WebCodecs is unavailable.
 */
export async function encodeFramesToWebm(frames, opts = {}) {
  if (!Array.isArray(frames) || frames.length === 0) return null;

  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const perFrameMs = Math.max(1, opts.perFrameMs ?? 300);
  const finalHoldMs = Math.max(perFrameMs, opts.finalHoldMs ?? 1400);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const { width, height } = timelapseOutputDims(
    frames[0].width, frames[0].height, opts.scale ?? 1
  );

  // Stills are resampled through one scratch canvas; VideoFrame copies the
  // canvas contents at construction, so it's safe to reuse it across repeats.
  const needsResample = width !== frames[0].width || height !== frames[0].height;
  let scratch = null;
  let scratchCtx = null;
  if (needsResample) {
    scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    scratchCtx = scratch.getContext('2d');
    scratchCtx.imageSmoothingEnabled = true;
    scratchCtx.imageSmoothingQuality = 'high';
  }

  // Expand the stills into an output-frame schedule: each still holds for
  // `repeats` frames, the last one longer so the loop ends on the artwork.
  const repeats = Math.max(1, Math.round((perFrameMs / 1000) * fps));
  const finalRepeats = Math.max(repeats, Math.round((finalHoldMs / 1000) * fps));
  const stillForFrame = [];
  for (let f = 0; f < frames.length; f++) {
    const count = f === frames.length - 1 ? finalRepeats : repeats;
    for (let i = 0; i < count; i++) stillForFrame.push(f);
  }

  let lastStill = -1;
  return encodeFrameSequenceToWebm(
    (index) => {
      const f = stillForFrame[index];
      if (f === undefined) return null;
      if (!needsResample) return frames[f];
      if (f !== lastStill) {
        scratchCtx.clearRect(0, 0, width, height);
        const src = frames[f];
        scratchCtx.drawImage(src, 0, 0, src.width, src.height, 0, 0, width, height);
        lastStill = f;
      }
      return scratch;
    },
    { width, height, fps, totalFrames: stillForFrame.length, onProgress }
  );
}

/**
 * Encode a pulled sequence of already-correctly-sized frames into a WebM.
 *
 * The shared bottom half of every time-lapse encode: codec probing (software
 * VP8, VP9 fallback), muxing, keyframe cadence and encoder-queue backpressure.
 * `nextFrame` is asked for one image per output frame and may be async, so a
 * caller can seek a video element between frames without buffering the whole
 * sequence in memory.
 *
 * @param {(index: number) => CanvasImageSource|null|Promise<CanvasImageSource|null>} nextFrame
 *   Image for output frame `index`, or null to end the stream. Must already be
 *   `width`×`height`; nothing here rescales.
 * @param {Object} opts
 * @param {number} opts.width  - even
 * @param {number} opts.height - even
 * @param {number} [opts.fps=30]
 * @param {number} [opts.totalFrames] - expected length, for progress only
 * @param {(p: number) => void} [opts.onProgress] - 0..1
 * @returns {Promise<Blob|null>} WebM blob, or null if WebCodecs is unavailable.
 */
export async function encodeFrameSequenceToWebm(nextFrame, opts) {
  if (typeof VideoEncoder === 'undefined') return null;

  const width = opts.width;
  const height = opts.height;
  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const totalFrames = opts.totalFrames || 0;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const bitrate = estimateBitrate(width, height, fps);

  // VP8 is the most reliable software path; VP9 is a smaller-file fallback.
  const codecCandidates = [
    { webcodec: 'vp8', matroska: 'V_VP8' },
    { webcodec: 'vp09.00.10.08', matroska: 'V_VP9' },
  ];
  let chosen = null;
  for (const c of codecCandidates) {
    try {
      const sup = await VideoEncoder.isConfigSupported({
        codec: c.webcodec, width, height, bitrate,
        framerate: fps, hardwareAcceleration: 'prefer-software',
      });
      if (sup.supported) { chosen = c; break; }
    } catch { /* try next */ }
  }
  if (!chosen) return null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: chosen.matroska, width, height, frameRate: fps },
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encoderError = e; } },
    error: (e) => { encoderError = e; },
  });
  encoder.configure({
    codec: chosen.webcodec, width, height, bitrate,
    framerate: fps, hardwareAcceleration: 'prefer-software', latencyMode: 'quality',
  });

  const frameDurUs = Math.round(1_000_000 / fps);
  const keyFrameInterval = Math.max(1, fps); // ~1 keyframe per output second
  let frameIndex = 0;

  while (!encoderError) {
    const source = await nextFrame(frameIndex);
    if (!source) break;
    if (encoderError) break;

    const vf = new VideoFrame(source, {
      timestamp: frameIndex * frameDurUs,
      duration: frameDurUs,
    });
    encoder.encode(vf, { keyFrame: frameIndex % keyFrameInterval === 0 });
    vf.close();
    frameIndex++;

    if (onProgress && totalFrames > 0) onProgress(Math.min(1, frameIndex / totalFrames));

    // Drain the encoder queue so it can't balloon in memory.
    if (encoder.encodeQueueSize > 8) {
      while (encoder.encodeQueueSize > 2 && !encoderError) {
        await new Promise((res) => setTimeout(res, 0));
      }
    }
  }

  if (encoderError) {
    try { encoder.close(); } catch {}
    throw encoderError instanceof Error ? encoderError : new Error(String(encoderError));
  }
  if (frameIndex === 0) {
    try { encoder.close(); } catch {}
    return null;
  }

  await encoder.flush();
  muxer.finalize();
  encoder.close();
  if (onProgress) onProgress(1);

  return new Blob([target.buffer], { type: 'video/webm' });
}
