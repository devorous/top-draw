<script>
  /**
   * Post-upload time-lapse editor: re-crop, re-trim, or remove the clip
   * attached to a gallery item. Open to the uploader and to HOLY+ moderators —
   * the same bar the server enforces on the animation route.
   *
   * It edits the published WebM, not the session stills that produced it, so
   * the crop can only ever tighten. That's the point: the automatic crop
   * sometimes takes in more board than the artwork.
   */
  import { onDestroy } from 'svelte';
  import { loadClip, reencodeClip, clampCrop, MIN_CROP_PX } from './timelapseReencode.js';

  let { item, apiBase = '', token, onSaved, onRemoved, onClose } = $props();

  let stage = $state('loading');      // loading | ready | working | failed
  let statusText = $state('Loading clip…');
  let progress = $state(0);
  let errorMessage = $state('');
  let confirmRemove = $state(false);

  let videoWidth = $state(0);
  let videoHeight = $state(0);
  let duration = $state(0);
  let crop = $state(null);            // source-video px; null = full frame
  let trimStart = $state(0);
  let trimEnd = $state(0);

  let clip = null;                    // { video, duration, release }
  let videoHost = $state(null);
  let cropSurface = $state(null);
  let drag = null;

  const HANDLES = ['tl', 'tr', 'bl', 'br'];
  const HANDLE_GRAB_PX = 16;          // hit radius in CSS px

  const activeCrop = $derived(crop ?? { x: 0, y: 0, width: videoWidth, height: videoHeight });
  const isEdited = $derived(
    !!crop || trimStart > 0.001 || trimEnd < duration - 0.001
  );
  const outputLabel = $derived(
    videoWidth > 0
      ? `${Math.round(activeCrop.width)}×${Math.round(activeCrop.height)} · ${(trimEnd - trimStart).toFixed(1)}s`
      : ''
  );

  $effect(() => {
    if (videoHost && clip?.video && clip.video.parentNode !== videoHost) {
      videoHost.appendChild(clip.video);
    }
  });

  load();

  async function load() {
    if (!item?.animatedUrl) {
      stage = 'failed';
      errorMessage = 'This upload has no time-lapse.';
      return;
    }
    try {
      clip = await loadClip(item.animatedUrl);
      videoWidth = clip.video.videoWidth;
      videoHeight = clip.video.videoHeight;
      duration = clip.duration;
      trimStart = 0;
      trimEnd = duration;
      clip.video.loop = false;
      // `timeupdate` alone can miss the last beat of a clip, so `ended` backs
      // the loop up — otherwise a preview stops dead on its final frame.
      clip.video.addEventListener('timeupdate', enforceTrimLoop);
      clip.video.addEventListener('ended', playPreview);
      stage = 'ready';
      playPreview();
    } catch (err) {
      stage = 'failed';
      errorMessage = err?.message || 'Could not load the clip.';
    }
  }

  /** Loop the preview inside the trim brackets instead of over the whole clip. */
  function enforceTrimLoop() {
    const v = clip?.video;
    if (!v || stage === 'working') return;
    if (v.currentTime >= trimEnd - 0.02 || v.currentTime < trimStart - 0.05) {
      v.currentTime = trimStart;
      if (v.paused) v.play().catch(() => {});
    }
  }

  function playPreview() {
    const v = clip?.video;
    if (!v || stage === 'working') return; // the render loop owns the playhead
    try { v.currentTime = trimStart; } catch { /* not seekable yet */ }
    v.play().catch(() => {});
  }

  onDestroy(() => {
    const v = clip?.video;
    if (v) {
      v.removeEventListener('timeupdate', enforceTrimLoop);
      v.removeEventListener('ended', playPreview);
      v.pause();
      v.remove();
    }
    clip?.release?.();
    clip = null;
  });

  // ---- crop interaction -----------------------------------------------

  /** Pointer position in source-video pixels, plus the CSS→video px scale. */
  function surfacePoint(e) {
    const r = cropSurface.getBoundingClientRect();
    const scale = videoWidth / Math.max(1, r.width);
    return {
      x: (e.clientX - r.left) * scale,
      y: (e.clientY - r.top) * scale,
      scale,
    };
  }

  function cornerPoint(c, handle) {
    return {
      x: handle === 'tl' || handle === 'bl' ? c.x : c.x + c.width,
      y: handle === 'tl' || handle === 'tr' ? c.y : c.y + c.height,
    };
  }

  function onCropPointerDown(e) {
    if (stage !== 'ready' || e.button !== 0) return;
    const p = surfacePoint(e);
    const c = activeCrop;
    const grab = HANDLE_GRAB_PX * p.scale;

    let mode = 'new';
    let handle = null;
    // Only hit-test against an existing crop; activeCrop falls back to the
    // full frame when none is drawn yet, which would otherwise make every
    // click register as "inside the crop" and start a move-drag.
    if (crop) {
      for (const h of HANDLES) {
        const pt = cornerPoint(c, h);
        if (Math.abs(p.x - pt.x) <= grab && Math.abs(p.y - pt.y) <= grab) {
          mode = 'resize';
          handle = h;
          break;
        }
      }
      if (mode === 'new' && p.x >= c.x && p.x <= c.x + c.width && p.y >= c.y && p.y <= c.y + c.height) {
        mode = 'move';
      }
    }

    drag = { mode, handle, origin: p, startCrop: { ...c } };
    if (mode === 'new') crop = { x: p.x, y: p.y, width: 0, height: 0 };
    cropSurface.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onCropPointerMove(e) {
    if (!drag) return;
    const p = surfacePoint(e);

    if (drag.mode === 'new') {
      crop = normalize(drag.origin.x, drag.origin.y, p.x, p.y);
    } else if (drag.mode === 'move') {
      const s = drag.startCrop;
      crop = {
        x: clamp(s.x + (p.x - drag.origin.x), 0, videoWidth - s.width),
        y: clamp(s.y + (p.y - drag.origin.y), 0, videoHeight - s.height),
        width: s.width,
        height: s.height,
      };
    } else {
      // Resize from the grabbed corner; the opposite corner stays put.
      const s = drag.startCrop;
      const fixed = cornerPoint(s, oppositeHandle(drag.handle));
      crop = normalize(fixed.x, fixed.y, p.x, p.y);
    }
  }

  function onCropPointerUp(e) {
    if (!drag) return;
    cropSurface.releasePointerCapture?.(e.pointerId);
    const wasNew = drag.mode === 'new';
    drag = null;

    // A click (rather than a drag) on empty space shouldn't collapse the crop.
    if (wasNew && crop && (crop.width < MIN_CROP_PX || crop.height < MIN_CROP_PX)) {
      crop = null;
      return;
    }
    crop = clampCrop(crop, videoWidth, videoHeight);
    if (crop.x === 0 && crop.y === 0 && crop.width === videoWidth && crop.height === videoHeight) {
      crop = null;
    }
  }

  function oppositeHandle(h) {
    return { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' }[h];
  }

  function normalize(x1, y1, x2, y2) {
    const x = clamp(Math.min(x1, x2), 0, videoWidth);
    const y = clamp(Math.min(y1, y2), 0, videoHeight);
    return {
      x,
      y,
      width: clamp(Math.max(x1, x2), 0, videoWidth) - x,
      height: clamp(Math.max(y1, y2), 0, videoHeight) - y,
    };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
  }

  function pct(value, total) {
    return `${(value / Math.max(1, total)) * 100}%`;
  }

  function resetCrop() {
    crop = null;
  }

  // ---- trim -------------------------------------------------------------

  function onTrimStart(e) {
    const v = Number(e.currentTarget.value);
    trimStart = Math.min(v, trimEnd - 0.5);
    playPreview();
  }

  function onTrimEnd(e) {
    const v = Number(e.currentTarget.value);
    trimEnd = Math.max(v, trimStart + 0.5);
    playPreview();
  }

  // ---- save / remove ----------------------------------------------------

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function save() {
    if (stage !== 'ready' || !clip) return;
    errorMessage = '';
    stage = 'working';
    statusText = 'Rendering clip…';
    progress = 0;
    clip.video.pause();

    try {
      const blob = await reencodeClip({
        video: clip.video,
        crop,
        startSec: trimStart,
        endSec: trimEnd,
        duration,
        onProgress: (p) => { progress = p; },
      });
      if (!blob) throw new Error('This browser can’t encode video (WebCodecs unavailable).');

      statusText = 'Uploading…';
      const res = await fetch(`${apiBase}/api/gallery/${item.id}/animation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ animationData: await blobToDataUrl(blob) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

      onSaved?.(data.animatedUrl);
    } catch (err) {
      errorMessage = err?.message || 'Something went wrong.';
      stage = 'ready';
      playPreview();
    }
  }

  async function removeClip() {
    if (stage === 'working') return;
    errorMessage = '';
    stage = 'working';
    statusText = 'Removing time-lapse…';
    try {
      const res = await fetch(`${apiBase}/api/gallery/${item.id}/animation`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Remove failed (${res.status})`);
      onRemoved?.();
    } catch (err) {
      errorMessage = err?.message || 'Could not remove the time-lapse.';
      stage = 'ready';
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tle-backdrop" onclick={() => stage !== 'working' && onClose?.()}>
  <div class="tle-panel" role="dialog" aria-modal="true" tabindex="-1" aria-label="Edit time-lapse" onclick={(e) => e.stopPropagation()}>
    <header class="tle-head">
      <h3>Edit time-lapse</h3>
      <button class="tle-close" onclick={() => onClose?.()} disabled={stage === 'working'} aria-label="Close">&times;</button>
    </header>

    {#if stage === 'failed'}
      <p class="tle-error">{errorMessage}</p>
      <footer class="tle-foot">
        <button class="tle-btn" onclick={() => onClose?.()}>Close</button>
      </footer>
    {:else if stage === 'loading'}
      <p class="tle-status">{statusText}</p>
    {:else}
      <div class="tle-stage">
        <div
          class="tle-frame"
          style="--ar: {videoWidth} / {videoHeight}"
          bind:this={cropSurface}
          onpointerdown={onCropPointerDown}
          onpointermove={onCropPointerMove}
          onpointerup={onCropPointerUp}
          onpointercancel={onCropPointerUp}
        >
          <div class="tle-video" bind:this={videoHost}></div>
          {#if crop}
            <div
              class="tle-crop"
              style="left: {pct(activeCrop.x, videoWidth)}; top: {pct(activeCrop.y, videoHeight)}; width: {pct(activeCrop.width, videoWidth)}; height: {pct(activeCrop.height, videoHeight)};"
            >
              {#each HANDLES as h}
                <span class="tle-handle {h}"></span>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <p class="tle-hint">
        Drag on the clip to crop it, or drag inside the box to move it. Edits work on the
        published clip, so a crop can only tighten the frame.
      </p>

      <div class="tle-trim">
        <label>
          <span>Start</span>
          <input type="range" min="0" max={duration} step="0.1" value={trimStart} oninput={onTrimStart} disabled={stage === 'working'}>
        </label>
        <label>
          <span>End</span>
          <input type="range" min="0" max={duration} step="0.1" value={trimEnd} oninput={onTrimEnd} disabled={stage === 'working'}>
        </label>
        <span class="tle-readout">{outputLabel}</span>
      </div>

      {#if errorMessage}
        <p class="tle-error">{errorMessage}</p>
      {/if}

      {#if stage === 'working'}
        <div class="tle-progress">
          <span>{statusText}</span>
          <div class="tle-bar"><div class="tle-bar-fill" style="width: {Math.round(progress * 100)}%"></div></div>
        </div>
      {/if}

      <footer class="tle-foot">
        <button class="tle-btn" onclick={resetCrop} disabled={!crop || stage === 'working'}>Reset crop</button>
        {#if confirmRemove}
          <button class="tle-btn danger" onclick={removeClip} disabled={stage === 'working'}>Confirm remove</button>
          <button class="tle-btn" onclick={() => confirmRemove = false} disabled={stage === 'working'}>Keep it</button>
        {:else}
          <button class="tle-btn danger" onclick={() => confirmRemove = true} disabled={stage === 'working'}>Remove</button>
        {/if}
        <span class="tle-spacer"></span>
        <button class="tle-btn" onclick={() => onClose?.()} disabled={stage === 'working'}>Cancel</button>
        <button class="tle-btn primary" onclick={save} disabled={stage === 'working' || !isEdited}>Save clip</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .tle-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.78);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    z-index: 1200;
  }

  .tle-panel {
    background: var(--bg2, #1a1a1e);
    border: 2px solid var(--accent, #00d4aa);
    border-radius: 12px;
    width: min(680px, 100%);
    max-height: 90vh;
    overflow-y: auto;
    padding: 1rem 1.25rem 1.25rem;
    color: var(--text, #fff);
    font-family: 'Inter', -apple-system, sans-serif;
    box-shadow: 0 20px 60px rgba(0, 212, 170, 0.2);
  }

  .tle-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .tle-head h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .tle-close {
    background: none;
    border: none;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
  }
  .tle-close:hover { color: var(--text, #fff); }

  .tle-stage { display: flex; justify-content: center; }

  .tle-frame {
    position: relative;
    width: min(100%, calc(42vh * (var(--ar))));
    aspect-ratio: var(--ar);
    background: #000;
    border-radius: 6px;
    overflow: hidden;
    touch-action: none;
    cursor: crosshair;
  }
  .tle-video { position: absolute; inset: 0; }
  /* The <video> is created in JS, so scoped selectors can't reach it. */
  .tle-video :global(video) { width: 100%; height: 100%; display: block; }

  .tle-crop {
    position: absolute;
    border: 1px solid var(--accent, #00d4aa);
    /* Dim everything outside the crop without stacking four mask elements. */
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
    cursor: move;
  }
  .tle-handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: var(--accent, #00d4aa);
    border-radius: 2px;
  }
  .tle-handle.tl { left: -5px; top: -5px; cursor: nwse-resize; }
  .tle-handle.tr { right: -5px; top: -5px; cursor: nesw-resize; }
  .tle-handle.bl { left: -5px; bottom: -5px; cursor: nesw-resize; }
  .tle-handle.br { right: -5px; bottom: -5px; cursor: nwse-resize; }

  .tle-hint {
    margin: 0.75rem 0 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
  }

  .tle-trim {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 0.4rem 0.75rem;
    margin-top: 0.9rem;
  }
  .tle-trim label {
    display: contents;
    font-size: 0.78rem;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
  }
  .tle-trim input { width: 100%; accent-color: var(--accent, #00d4aa); }
  .tle-readout {
    grid-column: 1 / -1;
    font-size: 0.75rem;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
  }

  .tle-status, .tle-error {
    margin: 0.75rem 0 0;
    font-size: 0.82rem;
  }
  .tle-error { color: #fc8181; }

  .tle-progress { margin-top: 0.9rem; font-size: 0.78rem; color: var(--text-dim, rgba(255, 255, 255, 0.45)); }
  .tle-bar {
    margin-top: 0.35rem;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.12);
    overflow: hidden;
  }
  .tle-bar-fill { height: 100%; background: var(--accent, #00d4aa); transition: width 0.15s linear; }

  .tle-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1.1rem;
  }
  .tle-spacer { flex: 1; }

  .tle-btn {
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: 4px;
    background: none;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s, background 0.2s;
  }
  .tle-btn:hover:not(:disabled) { color: var(--text, #fff); border-color: var(--text-dim, rgba(255, 255, 255, 0.45)); }
  .tle-btn:disabled { opacity: 0.4; cursor: default; }
  .tle-btn.primary { border-color: var(--accent, #00d4aa); color: var(--accent, #00d4aa); }
  .tle-btn.primary:hover:not(:disabled) { background: var(--accent, #00d4aa); color: #0f0f13; }
  .tle-btn.danger { border-color: #c53030; color: #fc8181; }
  .tle-btn.danger:hover:not(:disabled) { background: #c53030; color: #fff; }
</style>
