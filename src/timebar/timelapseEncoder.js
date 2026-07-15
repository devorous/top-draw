/**
 * @fileoverview Encode a list of still frames into a WebM video.
 *
 * Mirrors the software-VP8 WebCodecs path in TimeLapseExporter (which is bound
 * to the replay tape) but operates on a plain array of same-sized canvases — the
 * sparse stills captured by TimelapseCapturer. Each still is held on screen for
 * `perFrameMs`; the final still lingers for `finalHoldMs` so the loop ends on the
 * finished artwork. Forces `prefer-software` to avoid the GPU WebM encoder that
 * traps (STATUS_BREAKPOINT) on large boards.
 */

import { Muxer, ArrayBufferTarget } from 'webm-muxer';

/** Loose bitrate target: 0.12 bits per pixel per frame, clamped. */
function estimateBitrate(width, height, fps) {
  const bps = Math.round(width * height * fps * 0.12);
  return Math.min(16_000_000, Math.max(800_000, bps));
}

/** Target total clip length used to normalize per-still hold time. */
const TARGET_CLIP_MS = 6_000;

/**
 * Per-still hold time that lands the clip near TARGET_CLIP_MS regardless of
 * how many stills the session produced, clamped so sparse clips don't crawl
 * (≤700ms/still) and frame-dense ones don't strobe (≥150ms/still).
 * @param {number} frameCount
 * @param {number} [targetMs]
 * @returns {number}
 */
export function normalizedPerFrameMs(frameCount, targetMs = TARGET_CLIP_MS) {
  if (!Number.isFinite(frameCount) || frameCount < 1) return 450;
  return Math.round(Math.min(700, Math.max(150, targetMs / frameCount)));
}

/**
 * @param {HTMLCanvasElement[]} frames - same-sized, even-dimensioned canvases
 * @param {Object} [opts]
 * @param {number} [opts.fps=30]
 * @param {number} [opts.perFrameMs=450]   - on-screen time per still
 * @param {number} [opts.finalHoldMs=1400] - extra hold on the last still
 * @param {(p: number) => void} [opts.onProgress] - 0..1
 * @returns {Promise<Blob|null>} WebM blob, or null if WebCodecs is unavailable.
 */
export async function encodeFramesToWebm(frames, opts = {}) {
  if (typeof VideoEncoder === 'undefined') return null;
  if (!Array.isArray(frames) || frames.length === 0) return null;

  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const perFrameMs = Math.max(1, opts.perFrameMs ?? 450);
  const finalHoldMs = Math.max(perFrameMs, opts.finalHoldMs ?? 1400);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const width = frames[0].width;
  const height = frames[0].height;
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
  const repeats = Math.max(1, Math.round((perFrameMs / 1000) * fps));
  const finalRepeats = Math.max(repeats, Math.round((finalHoldMs / 1000) * fps));
  let frameIndex = 0;

  for (let f = 0; f < frames.length && !encoderError; f++) {
    const count = f === frames.length - 1 ? finalRepeats : repeats;
    for (let i = 0; i < count && !encoderError; i++) {
      const vf = new VideoFrame(frames[f], {
        timestamp: frameIndex * frameDurUs,
        duration: frameDurUs,
      });
      encoder.encode(vf, { keyFrame: frameIndex % keyFrameInterval === 0 });
      vf.close();
      frameIndex++;

      // Drain the encoder queue so it can't balloon in memory.
      if (encoder.encodeQueueSize > 8) {
        while (encoder.encodeQueueSize > 2 && !encoderError) {
          await new Promise((res) => setTimeout(res, 0));
        }
      }
    }
    if (onProgress) onProgress((f + 1) / frames.length);
  }

  if (encoderError) {
    try { encoder.close(); } catch {}
    throw encoderError instanceof Error ? encoderError : new Error(String(encoderError));
  }

  await encoder.flush();
  muxer.finalize();
  encoder.close();
  if (onProgress) onProgress(1);

  return new Blob([target.buffer], { type: 'video/webm' });
}
