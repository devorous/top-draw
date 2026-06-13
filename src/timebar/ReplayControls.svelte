<script>
  // Shared replay control surface — the single transport + action bar used by
  // every replay player: the full-board takeover (Timebar), the standalone
  // mini viewer modal (ReplayMiniViewer) and the History → Recent embedded
  // player (SnapshotMenu). Styled after the full-board player.
  //
  // Layout: play / elapsed / timeline (playhead + trim brackets) / total on
  // the first row, then [speed] [trim chip] | [Save .ddraw] [Render]
  // [Select region] … [Undo to here] [Exit].
  // Region selection, the time-lapse Render dialog and the undo-to-here flow
  // all live here so hosts only provide the canvas + exit/close behavior.
  import { TimeMachine } from './TimeMachine.svelte.js';
  import { appState } from '../state.svelte.js';
  import TimeLapseDialog from './TimeLapseDialog.svelte';
  import ReplayTimeline from './ReplayTimeline.svelte';

  /**
   * @type {{
   *   getCanvas: () => HTMLCanvasElement|null, // canvas the replay paints into (board-pixel coord mapping)
   *   onExit?: (() => void)|null,              // Exit button handler; omit to hide the button
   *   exitLabel?: string,
   *   onAfterUndo?: (() => void)|null,         // called after a successful local restore (modal hosts close)
   * }}
   */
  let { getCanvas, onExit = null, exitLabel = 'Exit', onAfterUndo = null } = $props();

  // Hosts mount this bar inside transformed/filtered containers (the fullscreen
  // .timebar-container has translateX + backdrop-filter), which would make any
  // position:fixed descendant resolve against that container instead of the
  // viewport. Portal the viewport overlays (picker, outline, render dialog) to
  // <body> so fixed coordinates mean what they say.
  function portal(node) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  // Reactive mirrors of TimeMachine playback state.
  let tmPlaying = $derived(TimeMachine.isPlaying);
  let tmStart = $derived(TimeMachine.sessionStart);
  let tmEnd = $derived(TimeMachine.sessionEnd);
  let tmCurrent = $derived(TimeMachine.currentTime);
  let tmExporting = $derived(TimeMachine.isExportingVideo);
  let tmExportProgress = $derived(TimeMachine.videoExportProgress);

  let tmTrimStart = $derived(TimeMachine.effectiveTrimStart);
  let tmTrimEnd = $derived(TimeMachine.effectiveTrimEnd);
  let tmTrimmed = $derived(TimeMachine.hasTrimRange);
  let tmRate = $derived(TimeMachine.playbackRate);

  let elapsedLabel = $derived(formatClock(Math.max(0, tmCurrent - tmStart)));
  let totalLabel = $derived(formatClock(Math.max(0, tmEnd - tmStart)));

  function formatClock(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function togglePlay() {
    if (TimeMachine.isPlaying) TimeMachine.pause();
    else TimeMachine.play();
  }

  // ── Playback speed ──────────────────────────────────────────────────────────
  // Segmented control over fixed stops; TimeMachine.stop() resets the rate to
  // 1× so every new replay session starts at real time.
  const RATE_STOPS = [0.5, 1, 2, 4, 8];

  // ── Actions ─────────────────────────────────────────────────────────────────
  let timeLapseDialogOpen = $state(false);

  async function saveReplay() {
    await TimeMachine.exportCurrentRecording();
  }

  function openRenderDialog() {
    if (TimeMachine.isExportingVideo) return;
    // Pause playback the moment Render is pressed so the replay isn't still
    // advancing underneath the time-lapse dialog.
    if (TimeMachine.isPlaying) TimeMachine.pause();
    timeLapseDialogOpen = true;
  }

  function cancelVideo() {
    TimeMachine.cancelVideoExport();
  }

  async function undoToHere() {
    if (!TimeMachine.isLocalReplay) {
      const ok = await window.showAppConfirm('Are you sure you want to revert the board to this state for everyone?', {
        title: 'Revert board?',
        confirmLabel: 'Revert',
        danger: true,
      });
      if (ok) TimeMachine.requestUndoTo(TimeMachine.currentTime);
      return;
    }
    const hasRegion = !!regionRect;
    const msg = hasRegion
      ? 'Revert just the selected region of your board to this point in the replay?'
      : 'Replace your current board with this state?';
    const ok = await window.showAppConfirm(msg, {
      title: hasRegion ? 'Undo region to here' : 'Undo to here',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!ok) return;
    if (hasRegion) await TimeMachine.restoreLocalRegionToCurrentState(regionRect);
    else await TimeMachine.restoreLocalToCurrentState();
    // restoreLocal* calls catchUp() which stops the replay; modal hosts close.
    onAfterUndo?.();
  }

  // ── Region selection ────────────────────────────────────────────────────────
  // A viewport-wide picker overlay converts a drag into board-pixel coords via
  // the host canvas's on-screen rect (getBoundingClientRect accounts for any
  // CSS transforms, so this works for the full-board canvas and zoomed embeds).
  let regionSelecting = $state(false);
  let regionRect = $state(null);     // committed region, board px
  let regionDrag = null;             // { startX, startY } in client px
  let regionDragRect = $state(null); // live drag feedback, viewport-fixed px
  let regionOutline = $state(null);  // committed outline, viewport-fixed px

  function toggleRegionSelect() {
    if (regionSelecting) { regionSelecting = false; return; }
    regionSelecting = true;
    regionRect = null;
    regionOutline = null;
  }

  function clearRegion() {
    regionRect = null;
    regionOutline = null;
    regionDragRect = null;
  }

  function clientToBoard(clientX, clientY) {
    const c = getCanvas?.();
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.max(0, Math.min(c.width, ((clientX - r.left) / r.width) * c.width)),
      y: Math.max(0, Math.min(c.height, ((clientY - r.top) / r.height) * c.height)),
    };
  }

  function onRegionPointerDown(e) {
    if (!regionSelecting) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    regionDrag = { startX: e.clientX, startY: e.clientY };
    regionDragRect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  }

  function onRegionPointerMove(e) {
    if (!regionDrag) return;
    regionDragRect = {
      x: Math.min(regionDrag.startX, e.clientX),
      y: Math.min(regionDrag.startY, e.clientY),
      w: Math.abs(e.clientX - regionDrag.startX),
      h: Math.abs(e.clientY - regionDrag.startY),
    };
  }

  function onRegionPointerUp(e) {
    if (!regionDrag) return;
    const start = clientToBoard(regionDrag.startX, regionDrag.startY);
    const end = clientToBoard(e.clientX, e.clientY);
    regionDrag = null;
    regionDragRect = null;
    if (!start || !end) { regionSelecting = false; return; }
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width < 8 || height < 8) { regionSelecting = false; return; }
    regionRect = { x, y, width, height };
    regionSelecting = false;
  }

  // Drop the fullscreen replay-preview blur (Timebar) while the picker is up
  // so the user drags over a crisp canvas.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('region-picking', !!regionSelecting);
    return () => document.body.classList.remove('region-picking');
  });

  // Keep the committed-region outline anchored to the canvas (re-measured each
  // frame so it survives pan/zoom, window resize and modal reflow).
  $effect(() => {
    if (typeof window === 'undefined') return;
    if (!regionRect) { regionOutline = null; return; }
    let rafId = 0;
    const sync = () => {
      const c = getCanvas?.();
      if (c && regionRect) {
        const r = c.getBoundingClientRect();
        const sx = r.width / c.width;
        const sy = r.height / c.height;
        regionOutline = {
          left: r.left + regionRect.x * sx,
          top: r.top + regionRect.y * sy,
          width: regionRect.width * sx,
          height: regionRect.height * sy,
        };
      } else {
        regionOutline = null;
      }
      rafId = requestAnimationFrame(sync);
    };
    sync();
    return () => cancelAnimationFrame(rafId);
  });
</script>

<div class="rp-controls">
  <button class="rp-play" onclick={togglePlay} title={tmPlaying ? 'Pause' : 'Play'} aria-label={tmPlaying ? 'Pause' : 'Play'}>
    {#if tmPlaying}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
    {:else}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    {/if}
  </button>
  <span class="rp-time">{elapsedLabel}</span>
  <ReplayTimeline
    min={tmStart}
    max={tmEnd}
    value={tmCurrent}
    trimStart={tmTrimStart}
    trimEnd={tmTrimEnd}
    trimmed={tmTrimmed}
    onScrubStart={() => TimeMachine.beginScrub()}
    onScrub={(t) => TimeMachine.scrubTo(t)}
    onScrubEnd={(t) => TimeMachine.endScrub(t)}
    onTrimChange={(s, e) => TimeMachine.setTrimRange(s, e)}
  />
  <span class="rp-time rp-time-total">{totalLabel}</span>
</div>

{#if tmExporting}
  <div class="rp-export-progress">
    <div class="rp-export-bar" style="width: {Math.round(tmExportProgress * 100)}%"></div>
    <span class="rp-export-label">Rendering... {Math.round(tmExportProgress * 100)}%</span>
    <button class="rp-action" onclick={cancelVideo}>Cancel</button>
  </div>
{:else if TimeMachine.isReviewing}
  <!-- Local replays are always "reviewing"; server replays hide the actions
       while caught up to the live edge (transport-only, as before). -->
  <div class="rp-actions">
    <div class="rp-speed" role="group" aria-label="Playback speed" title="Playback speed">
      {#each RATE_STOPS as rate}
        <button
          class="rp-speed-stop"
          class:active={tmRate === rate}
          onclick={() => TimeMachine.setPlaybackRate(rate)}
          aria-pressed={tmRate === rate}
        >{rate}×</button>
      {/each}
    </div>
    {#if tmTrimmed}
      <button class="rp-action rp-trim-chip" onclick={() => TimeMachine.clearTrimRange()} title="Playback trimmed to this window — click to clear">
        {formatClock(tmTrimStart - tmStart)}–{formatClock(tmTrimEnd - tmStart)}
        <span class="rp-trim-x">✕</span>
      </button>
    {/if}
    {#if TimeMachine.isLocalReplay}
      <span class="rp-divider"></span>
      <button class="rp-action" onclick={saveReplay} title="Save this replay as a .ddraw file">Save .ddraw</button>
      <button class="rp-action accent" onclick={openRenderDialog} title={regionRect ? 'Render this region as a time-lapse' : 'Render time-lapse'}>Render</button>
      <button
        class="rp-action"
        class:active={regionSelecting || !!regionRect}
        onclick={toggleRegionSelect}
        title="Select a region of the canvas"
      >
        {#if regionRect}
          Region: {Math.round(regionRect.width)}×{Math.round(regionRect.height)}
        {:else if regionSelecting}
          Picking…
        {:else}
          Select region
        {/if}
      </button>
      {#if regionRect}
        <button class="rp-action" onclick={clearRegion} title="Clear region">Clear</button>
      {/if}
    {/if}
    <span class="rp-actions-spacer"></span>
    {#if appState.canUndoReplayHistory}
      <button class="rp-action danger" onclick={undoToHere} title={TimeMachine.isLocalReplay ? (regionRect ? 'Undo just this region to here' : 'Undo board to here') : 'Restore board to here'}>
        {#if !TimeMachine.isLocalReplay}Restore to here{:else if regionRect}Undo region{:else}Undo to here{/if}
      </button>
    {/if}
    {#if onExit}
      <button class="rp-action" onclick={onExit} title="Exit replay">{exitLabel}</button>
    {/if}
  </div>
{/if}

{#if regionSelecting}
  <div
    use:portal
    class="rp-region-picker"
    role="presentation"
    onpointerdown={onRegionPointerDown}
    onpointermove={onRegionPointerMove}
    onpointerup={onRegionPointerUp}
    onpointercancel={onRegionPointerUp}
  >
    <span class="rp-region-hint">Drag a rectangle on the canvas — Esc to cancel</span>
    {#if regionDragRect}
      <div class="rp-region-rect" style="left:{regionDragRect.x}px;top:{regionDragRect.y}px;width:{regionDragRect.w}px;height:{regionDragRect.h}px"></div>
    {/if}
  </div>
{/if}

{#if regionOutline && !regionSelecting}
  <div use:portal class="rp-region-outline" style="left:{regionOutline.left}px;top:{regionOutline.top}px;width:{regionOutline.width}px;height:{regionOutline.height}px">
    <span class="rp-region-tag">Region</span>
  </div>
{/if}

<div use:portal class="rp-dialog-portal">
  <TimeLapseDialog
    bind:open={timeLapseDialogOpen}
    onClose={() => (timeLapseDialogOpen = false)}
    initialRegion={regionRect}
    allowRegionPick={false}
  />
</div>

<svelte:window onkeydown={(e) => {
  if (regionSelecting && e.key === 'Escape') {
    regionSelecting = false;
    regionDrag = null;
    regionDragRect = null;
  }
}} />

<style lang="scss">
  /* ── Transport (full-board player template) ─────────────────────────────── */
  .rp-controls { display: flex; align-items: center; gap: 12px; }
  .rp-play {
    flex-shrink: 0; width: 38px; height: 38px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.08); color: #fff; cursor: pointer;
    transition: background 0.2s, transform 0.2s;
  }
  .rp-play:hover { background: var(--accent-primary, #00d4aa); transform: scale(1.05); }
  .rp-time {
    font-size: 12px; color: #aaa; font-variant-numeric: tabular-nums; min-width: 40px;
  }
  .rp-time-total { text-align: right; }

  /* ── Actions ────────────────────────────────────────────────────────────── */
  .rp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rp-actions-spacer { flex: 1; }
  .rp-action {
    background: transparent; border: 1px solid rgba(255, 255, 255, 0.15); color: #bbb;
    border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
    cursor: pointer; white-space: nowrap; transition: all 0.15s;
  }
  .rp-action:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
  .rp-action.active { border-color: var(--accent-primary, #00d4aa); color: var(--accent-primary, #00d4aa); }
  .rp-action.accent { background: var(--accent-primary, #00d4aa); border-color: var(--accent-primary, #00d4aa); color: #fff; }
  .rp-action.accent:hover { filter: brightness(1.1); }
  .rp-action.danger { border-color: rgba(220, 53, 69, 0.4); color: #ff6b6b; }
  .rp-action.danger:hover { background: rgba(220, 53, 69, 0.25); color: #fff; }

  /* Segmented playback-speed control. */
  .rp-speed {
    display: flex; align-items: center; gap: 2px; padding: 2px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 7px;
  }
  .rp-speed-stop {
    background: transparent; border: none; color: #999; cursor: pointer;
    font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
    padding: 4px 7px; border-radius: 5px; transition: all 0.15s; white-space: nowrap;
  }
  .rp-speed-stop:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
  .rp-speed-stop.active {
    background: var(--accent-primary, #00d4aa); color: #fff;
  }

  .rp-divider {
    width: 1px; height: 20px; background: rgba(255, 255, 255, 0.12); flex-shrink: 0;
  }

  .rp-trim-chip {
    border-color: var(--accent-primary, #00d4aa);
    color: var(--accent-primary, #00d4aa);
    font-variant-numeric: tabular-nums;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .rp-trim-chip:hover { color: #fff; border-color: rgba(220, 53, 69, 0.6); }
  .rp-trim-x { font-size: 10px; opacity: 0.8; }

  /* ── Export progress ────────────────────────────────────────────────────── */
  .rp-export-progress {
    position: relative; display: flex; align-items: center; gap: 10px; height: 32px;
  }
  .rp-export-bar {
    position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--accent-primary, #00d4aa), var(--accent-hover, #00e6b8));
    opacity: 0.35; transition: width 120ms ease-out; pointer-events: none;
  }
  .rp-export-label { font-size: 12px; color: #eee; z-index: 1; flex: 1; }

  /* ── Region picker (viewport overlay, above any host modal/timebar) ─────── */
  .rp-region-picker {
    position: fixed; inset: 0; z-index: 10005; cursor: crosshair;
    background: rgba(0, 0, 0, 0.2); touch-action: none; user-select: none;
  }
  .rp-region-hint {
    position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8); color: #fff; font-size: 12px; font-weight: 600;
    padding: 6px 12px; border-radius: 6px; pointer-events: none;
  }
  :global(body.desktop-window-chrome) .rp-region-hint {
    top: calc(var(--desktop-titlebar-height) + 24px);
  }
  .rp-region-rect {
    position: fixed; z-index: 10006; pointer-events: none;
    border: 2px dashed #fff; background: rgba(0, 212, 170, 0.18);
  }
  /* Above the host modals (z 2000) but below the time-lapse dialog (z 9999). */
  .rp-region-outline {
    position: fixed; z-index: 3000; pointer-events: none;
    border: 2px dashed var(--accent-primary, #00d4aa);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(0, 0, 0, 0.55);
  }
  .rp-region-tag {
    position: absolute; top: -20px; left: -2px; background: var(--accent-primary, #00d4aa);
    color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px 4px 0 0; white-space: nowrap;
  }

  /* Counteract the fullscreen replay-preview blur + loading overlay while the
     picker is up, so the drag happens over a crisp canvas. */
  :global(body.region-picking #replayCanvas) {
    filter: none !important;
  }
  :global(body.region-picking .replay-preview-overlay) {
    display: none !important;
  }
</style>
