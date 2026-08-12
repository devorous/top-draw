/**
 * @fileoverview Re-crop and re-trim an already-published gallery time-lapse.
 *
 * The stills a clip was built from live only in the drawing session that
 * produced it, so post-upload edits work on the published WebM itself: sample
 * it back out frame by frame, blit the crop rect, and re-encode. That means an
 * edit can only ever tighten the frame — board area the original crop threw
 * away is not recoverable here.
 *
 * Frames are pulled by seeking rather than by playing: playback capture drops
 * frames when the tab is throttled, while a seek loop is deterministic and
 * survives a backgrounded tab. Nothing is buffered — `encodeFrameSequenceToWebm`
 * pulls one frame at a time, so a long clip costs one canvas, not hundreds.
 */

import { encodeFrameSequenceToWebm, timelapseOutputDims } from '../timebar/timelapseEncoder.js';

/** Frames sampled per second of source. Enough for the ~10fps stills clips. */
export const REENCODE_FPS = 15;
/** Ceiling on output length; long clips lose fps rather than get truncated. */
const MAX_OUTPUT_FRAMES = 600;
/** Smallest crop we'll accept, in source-video pixels. */
export const MIN_CROP_PX = 16;

/**
 * Fetch a published clip and decode it into a detached <video>, ready to be
 * both previewed and sampled. Fetched as a blob so drawing it to a canvas can
 * never taint one, whatever host the clip is served from.
 * @param {string} url
 * @returns {Promise<{video: HTMLVideoElement, objectUrl: string, duration: number, release: () => void}>}
 */
export async function loadClip(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load the clip (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = objectUrl;

  try {
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Could not decode the clip')); };
      const cleanup = () => {
        video.removeEventListener('loadeddata', done);
        video.removeEventListener('error', fail);
      };
      video.addEventListener('loadeddata', done);
      video.addEventListener('error', fail);
    });
    const duration = await resolveDuration(video);
    if (!(duration > 0)) throw new Error('Clip has no playable duration');
    return { video, objectUrl, duration, release: () => URL.revokeObjectURL(objectUrl) };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/**
 * A WebM whose header omits the duration reports Infinity until something
 * forces the browser to scan to the end — seeking past it does that.
 * @param {HTMLVideoElement} video
 * @returns {Promise<number>} seconds
 */
async function resolveDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await seekTo(video, 1e6).catch(() => {});
  return Number.isFinite(video.duration) ? video.duration : 0;
}

/**
 * Seek and resolve once the frame at that position is actually decoded.
 * @param {HTMLVideoElement} video
 * @param {number} t - seconds
 * @returns {Promise<void>}
 */
export function seekTo(video, t) {
  // An already-satisfied seek never fires `seeked`, which would hang the pull.
  if (Math.abs(video.currentTime - t) < 1e-4) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    try {
      video.currentTime = t;
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Clamp a crop rect into the source frame, keeping it at least MIN_CROP_PX.
 * @param {{x:number,y:number,width:number,height:number}|null} crop
 * @param {number} vw
 * @param {number} vh
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function clampCrop(crop, vw, vh) {
  if (!crop) return { x: 0, y: 0, width: vw, height: vh };
  const width = Math.max(MIN_CROP_PX, Math.min(Math.round(crop.width), vw));
  const height = Math.max(MIN_CROP_PX, Math.min(Math.round(crop.height), vh));
  const x = Math.max(0, Math.min(Math.round(crop.x), vw - width));
  const y = Math.max(0, Math.min(Math.round(crop.y), vh - height));
  return { x, y, width, height };
}

/**
 * Render a cropped, trimmed copy of a loaded clip.
 *
 * Pixels are taken at their existing scale — the source is already a
 * half-resolution gallery clip, and halving it again on every edit would
 * compound. Cropping tighter is what shrinks the file here.
 *
 * @param {Object} opts
 * @param {HTMLVideoElement} opts.video - from loadClip()
 * @param {{x:number,y:number,width:number,height:number}|null} opts.crop - source-video px
 * @param {number} opts.startSec
 * @param {number} opts.endSec
 * @param {number} opts.duration
 * @param {(p: number) => void} [opts.onProgress] - 0..1
 * @returns {Promise<Blob|null>} null when WebCodecs is unavailable
 */
export async function reencodeClip({ video, crop, startSec, endSec, duration, onProgress }) {
  const c = clampCrop(crop, video.videoWidth, video.videoHeight);
  const { width, height } = timelapseOutputDims(c.width, c.height, 1);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const lastFrameTime = Math.max(0, duration - 1e-3);
  const start = Math.max(0, Math.min(startSec, lastFrameTime));
  const end = Math.max(start + 1 / REENCODE_FPS, Math.min(endSec, duration));
  const span = end - start;

  // Over the ceiling, thin the sampling instead of cutting the clip short.
  let fps = REENCODE_FPS;
  if (span * fps > MAX_OUTPUT_FRAMES) fps = Math.max(1, Math.floor(MAX_OUTPUT_FRAMES / span));
  const totalFrames = Math.max(1, Math.round(span * fps));

  return encodeFrameSequenceToWebm(async (i) => {
    if (i >= totalFrames) return null;
    await seekTo(video, Math.min(start + i / fps, lastFrameTime));
    ctx.drawImage(video, c.x, c.y, c.width, c.height, 0, 0, width, height);
    return canvas;
  }, { width, height, fps, totalFrames, onProgress });
}
