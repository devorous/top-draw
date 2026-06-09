<script>
  // Mini "session recorder" viewer, opened by the toolbar record button
  // (#tapeRecBtn). Idle → "Start recording". Recording → "View" + "Stop
  // recording". Both View and Stop open the shared ReplayMiniViewer (the same
  // embedded player as the History page), which offers a fullscreen handoff.
  import { onMount, onDestroy } from 'svelte';
  import { appState, closeRecorderPanel } from '../state.svelte.js';
  import ReplayMiniViewer from './ReplayMiniViewer.svelte';

  let recording = $state(false);
  let elapsedMs = $state(0);
  let pollTimer = null;

  // Mini-viewer state. The bundle is kept as a plain (non-reactive) reference to
  // avoid Svelte deep-proxying a potentially large recording.
  let viewerOpen = $state(false);
  let viewerTitle = $state('Replay');
  // $state.raw: reactive on reassignment but never deep-proxied (the bundle can
  // be large and carries typed arrays / blobs).
  let viewerBundle = $state.raw(null);
  let viewerWasStop = false;

  let elapsedLabel = $derived(formatClock(elapsedMs));

  function formatClock(ms) {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function poll() {
    const rec = window.app?.recorder;
    recording = !!rec?.isRecording?.();
    elapsedMs = recording ? (rec?.elapsedMs?.() ?? 0) : 0;
  }

  onMount(() => {
    poll();
    pollTimer = window.setInterval(poll, 250);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function startRecording() {
    window.app?.startTapeRecording?.();
    poll();
  }

  function openViewer(bundle, title, wasStop) {
    viewerBundle = bundle;
    viewerTitle = title;
    viewerWasStop = wasStop;
    viewerOpen = true;
  }

  function viewRecording() {
    const bundle = window.app?.recorder?.snapshot?.();
    if (!bundle || !bundle.deltas?.length) {
      window.app?.ui?.showToast?.('Nothing recorded yet — draw something first', 2000);
      return;
    }
    openViewer(bundle, 'Recording preview', false);
  }

  function stopRecording() {
    const bundle = window.app?.stopTapeRecording?.();
    poll();
    if (bundle && bundle.deltas?.length) {
      openViewer(bundle, 'Recording', true);
    } else {
      window.app?.ui?.showToast?.('Recording stopped (no actions captured)', 2000);
      closeRecorderPanel();
    }
  }

  function onViewerClose() {
    viewerOpen = false;
    viewerBundle = null;
    // After viewing a finished recording, the recorder's job is done.
    if (viewerWasStop) closeRecorderPanel();
  }

  function close() {
    closeRecorderPanel();
  }
</script>

{#if appState.recorderPanelVisible && !viewerOpen}
  <div class="rec-panel" role="dialog" aria-label="Session recorder">
    <div class="rec-header">
      <span class="rec-title">
        <span class="rec-dot" class:live={recording}></span>
        Session Recorder
      </span>
      <button class="rec-close" onclick={close} title="Close" aria-label="Close">&times;</button>
    </div>

    <div class="rec-body">
      {#if recording}
        <div class="rec-elapsed">{elapsedLabel}</div>
        <div class="rec-sub">Recording everything on this device…</div>
        <div class="rec-actions">
          <button class="rec-btn" onclick={viewRecording} title="Preview what's been recorded so far">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
            View
          </button>
          <button class="rec-btn stop" onclick={stopRecording} title="Stop recording and open the replay">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop recording
          </button>
        </div>
      {:else}
        <div class="rec-sub rec-idle">
          Capture this session locally, then scrub and replay it.
        </div>
        <button class="rec-btn record" onclick={startRecording}>
          <span class="rec-toggle-dot"></span>
          Start recording
        </button>
      {/if}
    </div>
  </div>
{/if}

{#if viewerOpen}
  <ReplayMiniViewer bundle={viewerBundle} title={viewerTitle} onClose={onViewerClose} />
{/if}

<style>
  .rec-panel {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: 300px;
    max-width: 92vw;
    background: rgba(15, 15, 20, 0.96);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    z-index: 10001;
    overflow: hidden;
    animation: rec-pop-in 180ms ease;
  }

  @keyframes rec-pop-in {
    from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  .rec-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .rec-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    letter-spacing: 0.02em;
  }

  .rec-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #6b7280;
  }
  .rec-dot.live {
    background: #ef4444;
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
    animation: rec-pulse 1.2s infinite;
  }

  @keyframes rec-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }

  .rec-close {
    background: none;
    border: none;
    color: #aaa;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s;
  }
  .rec-close:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

  .rec-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 16px 14px 18px;
  }

  .rec-elapsed {
    font-size: 30px;
    font-weight: 700;
    color: #fff;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }

  .rec-sub {
    font-size: 12px;
    color: #9ca3af;
    text-align: center;
    line-height: 1.4;
  }
  .rec-sub.rec-idle { max-width: 240px; }

  .rec-actions {
    display: flex;
    gap: 10px;
    margin-top: 4px;
  }

  .rec-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: filter 0.15s, transform 0.15s, background 0.15s, color 0.15s;
  }
  .rec-btn:hover { background: rgba(255, 255, 255, 0.16); transform: translateY(-1px); }

  .rec-btn.record {
    background: var(--accent-primary, #00d4aa);
    border-color: var(--accent-primary, #00d4aa);
    color: #0a0a0a;
  }
  .rec-btn.record:hover { filter: brightness(1.1); }

  .rec-btn.stop {
    background: rgba(239, 68, 68, 0.18);
    border-color: rgba(239, 68, 68, 0.5);
    color: #ff6b6b;
  }
  .rec-btn.stop:hover { background: rgba(239, 68, 68, 0.3); color: #fff; }

  .rec-toggle-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #ef4444;
    box-shadow: 0 0 6px rgba(239, 68, 68, 0.7);
  }
</style>
