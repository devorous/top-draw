<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { appState, clearSnapshotHistoryState, toggleSnapshotMenu } from '../../state.svelte.js';
  import { T } from '../../../shared/MessageTypes.js';
  import * as wasm from '../../wasm/ddraw_wasm.js';

  let snapshots = $derived(appState.snapshots || []);
  let snapshotHasMore = $derived(appState.snapshotHasMore);
  let snapshotListVersion = $derived(appState.snapshotListVersion);
  let hasLoadedOlderSnapshots = $derived(snapshots.length > 20);
  let canViewHistory = $derived(appState.selfRole >= 1);
  let canRestoreHistory = $derived(appState.selfRole >= 2);

  let selectedId = $state(null);
  let selectedLayers = $state(null);
  let isLoadingPreview = $state(false);
  let isLoadingSnapshots = $state(false);
  let isLoadingMore = $state(false);
  let previewError = $state('');
  let lastHandledSnapshotListVersion = $state(0);
  let showBackToPresent = $state(false);
  let previewRequestTimeout = null;

  // Selection tool
  let mode = $state('rectangle'); // 'rectangle' | 'lasso'
  let activeTool = $state('select'); // 'select' | 'pan'
  let selection = $state(null);
  let lassoPoints = $state([]);
  let isSelecting = false;
  let startPos = null;

  // Pan/zoom
  let viewZoom = $state(0.5);
  let viewPanX = $state(0);
  let viewPanY = $state(0);
  let isPanning = $state(false);
  let lastPanPos = { x: 0, y: 0 };

  // Marching ants
  let marchingAntsOffset = $state(0);
  let animId = null;

  // Snap strip dragging
  let stripRef = $state(null);
  let isDraggingStrip = $state(false);
  let stripStartX = 0;
  let stripScrollLeft = 0;
  let stripMoved = $state(false);

  function onStripPointerDown(e) {
    if (e.button !== 0) return;
    isDraggingStrip = true;
    stripStartX = e.pageX - stripRef.offsetLeft;
    stripScrollLeft = stripRef.scrollLeft;
    stripMoved = false;
  }

  function onStripPointerMove(e) {
    if (!isDraggingStrip) return;
    const x = e.pageX - stripRef.offsetLeft;
    const walk = (x - stripStartX);
    if (!stripMoved && Math.abs(walk) > 5) {
      stripMoved = true;
      stripRef.setPointerCapture(e.pointerId);
    }
    if (stripMoved) {
      stripRef.scrollLeft = stripScrollLeft - walk;
    }
  }

  function onStripPointerUp() {
    isDraggingStrip = false;
  }

  function handleSnapshotKeydown(event, snapshotId) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!stripMoved) selectSnapshot(snapshotId);
    }
  }

  function onStripScroll() {
    showBackToPresent = !!stripRef && hasLoadedOlderSnapshots && stripRef.scrollLeft > 40;
    if (!stripRef || isLoadingSnapshots || isLoadingMore || !snapshotHasMore) return;
    const threshold = 160;
    const remaining = stripRef.scrollWidth - (stripRef.scrollLeft + stripRef.clientWidth);
    if (remaining <= threshold) {
      loadMoreSnapshots();
    }
  }

  function scrollToPresent() {
    if (!stripRef) return;
    stripRef.scrollTo({ left: 0, behavior: 'smooth' });
    showBackToPresent = false;
  }

  // Canvas refs
  let previewCanvas = $state(null);
  let selectionCanvas = $state(null);
  let previewWrap = $state(null);
  let snapshotExportCanvas = null;

  // Thumb URL cache
  let thumbUrls = {};

  let canvasTransform = $derived(`translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`);
  let zoomLabel = $derived(`${Math.round(viewZoom * 100)}%`);

  function close() { toggleSnapshotMenu(); }
  function refresh() {
    isLoadingSnapshots = true;
    isLoadingMore = false;
    showBackToPresent = false;
    window.app?.snapshotManager?.requestList();
  }
  function formatDate(ts) { return new Date(Number(ts)).toLocaleTimeString(); }

  function loadMoreSnapshots() {
    if (isLoadingSnapshots || isLoadingMore || !snapshotHasMore || snapshots.length === 0) return;
    const oldest = snapshots[snapshots.length - 1];
    if (!oldest?.ts) return;
    isLoadingMore = true;
    window.app?.snapshotManager?.requestList({ beforeTs: Number(oldest.ts), append: true });
  }

  function getThumbUrl(snap) {
    if (thumbUrls[snap.id]) return thumbUrls[snap.id];
    if (!snap.thumb || snap.thumb.length === 0) return null;
    const blob = new Blob([snap.thumb], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    thumbUrls[snap.id] = url;
    return url;
  }

  function resetView() {
    if (!previewWrap || !previewCanvas) { viewZoom = 0.5; viewPanX = 0; viewPanY = 0; return; }
    const ww = previewWrap.clientWidth;
    const wh = previewWrap.clientHeight;
    const bw = previewCanvas.width;
    const bh = previewCanvas.height;
    if (!bw || !bh) { viewZoom = 0.5; viewPanX = 0; viewPanY = 0; return; }
    viewZoom = Math.min(ww / bw, wh / bh, 1);
    viewPanX = (ww - bw * viewZoom) / 2;
    viewPanY = (wh - bh * viewZoom) / 2;
  }

  function selectSnapshot(id) {
    if (id === selectedId) return;
    window.app.snapshotPreviewCanvas = null;
    snapshotExportCanvas = null;
    selectedId = id;
    selectedLayers = null;
    selection = null;
    lassoPoints = [];
    previewError = '';
    isLoadingPreview = true;

    if (previewRequestTimeout) {
      clearTimeout(previewRequestTimeout);
      previewRequestTimeout = null;
    }

    window.app.wsClient.on('board_snapshot_get_response', async (data) => {
      if (data.snapshotId !== selectedId) return;
      window.app.wsClient.messageHandlers.delete('board_snapshot_get_response');
      if (previewRequestTimeout) {
        clearTimeout(previewRequestTimeout);
        previewRequestTimeout = null;
      }
      selectedLayers = data.snapshotLayers;
      isLoadingPreview = false;
      await tick();
      renderPreview(data.snapshotLayers);
      resetView();
    });
    window.app.wsClient.requestSnapshotGet(id);
    previewRequestTimeout = window.setTimeout(() => {
      previewRequestTimeout = null;
      if (selectedId !== id || !isLoadingPreview) return;
      window.app?.wsClient?.messageHandlers?.delete('board_snapshot_get_response');
      isLoadingPreview = false;
      previewError = 'Preview could not load. Check snapshot storage settings on the server.';
    }, 8000);
  }

  function renderPreview(layerDatas) {
    if (!previewCanvas) return;

    const [h, w] = window.app.board.dimensions;
    previewCanvas.width = w;
    previewCanvas.height = h;
    selectionCanvas.width = w;
    selectionCanvas.height = h;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = w;
    exportCanvas.height = h;
    const exportCtx = exportCanvas.getContext('2d');
    exportCtx.clearRect(0, 0, w, h);

    if (!layerDatas || layerDatas.length === 0) {
      snapshotExportCanvas = exportCanvas;
      const ctx = previewCanvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      return;
    }

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tmpCtx = tmp.getContext('2d');

    for (const qoi of layerDatas) {
      if (!qoi || qoi.length === 0) continue;
      try {
        const pixels = wasm.qoi_decode(qoi);
        if (!pixels || pixels.length === 0) continue;
        tmpCtx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0);
        exportCtx.drawImage(tmp, 0, 0);
      } catch (e) {
        console.warn('[SnapshotMenu] QOI decode error', e);
      }
    }

    snapshotExportCanvas = exportCanvas;

    const ctx = previewCanvas.getContext('2d');
    const bg = window.app.board.backgroundColor || '#ffffff';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = typeof bg === 'string' ? bg : `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(exportCanvas, 0, 0);

    window.app.snapshotPreviewCanvas = exportCanvas;
  }

  function openSnapshotSaveDialog() {
    if (!selectedId || !snapshotExportCanvas) return;
    window.app?.openSaveDialogForCanvas?.(snapshotExportCanvas);
  }

  function doRestore() {
    if (!selectedId) return;
    const hasSel = hasSelection;

    if (!hasSel) {
      if (!confirm('Restore the full board to this snapshot?')) return;
      window.app.snapshotManager.restoreSnapshot(selectedId);
      close();
      return;
    }

    applyRegionRestore();
    close();
  }

  function applyRegionRestore() {
    const isLasso = mode === 'lasso';
    const msg = {
      t: T.BOARD_SNAPSHOT_REGION_RESTORE,
      snapshotId: selectedId,
      a: isLasso
    };
    if (isLasso) {
      // Flatten lasso points to [x0,y0,x1,y1,...]
      msg.cr = lassoPoints.flatMap(p => [p.x, p.y]);
    } else {
      msg.sx = Math.round(selection.x);
      msg.sy = Math.round(selection.y);
      msg.sw = Math.round(selection.width);
      msg.sh = Math.round(selection.height);
    }
    window.app.wsClient.send(msg);
  }

  function clearSelection() { selection = null; lassoPoints = []; }

  // Map screen coords → board-space canvas coords, accounting for pan/zoom
  function canvasPos(e) {
    const rect = selectionCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / viewZoom,
      y: (e.clientY - rect.top) / viewZoom
    };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    selectionCanvas.setPointerCapture(e.pointerId);

    if (activeTool === 'pan') {
      isPanning = true;
      lastPanPos = { x: e.clientX, y: e.clientY };
      return;
    }

    isSelecting = true;
    startPos = canvasPos(e);
    if (mode === 'rectangle') {
      selection = { x: startPos.x, y: startPos.y, width: 0, height: 0 };
    } else {
      lassoPoints = [startPos];
    }
  }

  function onPointerMove(e) {
    if (isPanning) {
      viewPanX += e.clientX - lastPanPos.x;
      viewPanY += e.clientY - lastPanPos.y;
      lastPanPos = { x: e.clientX, y: e.clientY };
      return;
    }

    if (!isSelecting) return;
    const pos = canvasPos(e);
    if (mode === 'rectangle' && startPos) {
      selection = {
        x: Math.min(pos.x, startPos.x),
        y: Math.min(pos.y, startPos.y),
        width: Math.abs(pos.x - startPos.x),
        height: Math.abs(pos.y - startPos.y)
      };
    } else if (mode === 'lasso') {
      lassoPoints = [...lassoPoints, pos];
    }
  }

  function onPointerUp() {
    if (isPanning) { isPanning = false; return; }
    isSelecting = false;
    if (mode === 'rectangle' && selection && (selection.width < 4 || selection.height < 4)) selection = null;
    if (mode === 'lasso' && lassoPoints.length < 4) lassoPoints = [];
  }

  function onWheel(e) {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    const next = Math.max(0.1, Math.min(4, Math.round((viewZoom + step) * 10) / 10));
    if (next === viewZoom) return;

    const wrapRect = previewWrap.getBoundingClientRect();
    const px = e.clientX - wrapRect.left;
    const py = e.clientY - wrapRect.top;
    const canvasX = (px - viewPanX) / viewZoom;
    const canvasY = (py - viewPanY) / viewZoom;
    viewPanX = px - canvasX * next;
    viewPanY = py - canvasY * next;
    viewZoom = next;
  }

  function drawSelection() {
    if (!selectionCanvas || !selectionCanvas.width) return;
    const ctx = selectionCanvas.getContext('2d');
    const w = selectionCanvas.width;
    const h = selectionCanvas.height;
    ctx.clearRect(0, 0, w, h);

    const hasRect = mode === 'rectangle' && selection && selection.width > 0 && selection.height > 0;
    const hasLasso = mode === 'lasso' && lassoPoints.length > 2;

    if (hasRect || hasLasso) {
      // Dark overlay on unselected area
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, w, h);

      // Cut out the selected region so preview shows through normally
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      if (hasRect) {
        ctx.fillRect(selection.x, selection.y, selection.width, selection.height);
      } else {
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      // Marching ants on the selection border
      if (hasRect) {
        const { x, y, width, height } = selection;
        ctx.save();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
        ctx.lineDashOffset = -marchingAntsOffset;
        ctx.strokeRect(x + 0.5, y + 0.5, width, height);
        ctx.strokeStyle = '#000';
        ctx.lineDashOffset = -(marchingAntsOffset + 6);
        ctx.strokeRect(x + 0.5, y + 0.5, width, height);
        ctx.restore();
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
        for (let i = 1; i < lassoPoints.length; i++) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
        ctx.closePath();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
        ctx.lineDashOffset = -marchingAntsOffset; ctx.stroke();
        ctx.strokeStyle = '#000';
        ctx.lineDashOffset = -(marchingAntsOffset + 6); ctx.stroke();
        ctx.restore();
      }
    }
  }

  $effect(() => { selection; lassoPoints; drawSelection(); });
  $effect(() => {
    if (snapshotListVersion === lastHandledSnapshotListVersion) return;
    lastHandledSnapshotListVersion = snapshotListVersion;
    isLoadingSnapshots = false;
    isLoadingMore = false;
  });

  onMount(() => {
    if (!canViewHistory) {
      window.app.snapshotPreviewCanvas = null;
      previewError = 'Only registered users can view board history.';
      return;
    }

    lastHandledSnapshotListVersion = snapshotListVersion;
    refresh();
    const tick = () => {
      marchingAntsOffset = (marchingAntsOffset + 0.4) % 13;
      drawSelection();
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
  });

  onDestroy(() => {
    if (animId) cancelAnimationFrame(animId);
    if (previewRequestTimeout) clearTimeout(previewRequestTimeout);
    window.app?.wsClient?.messageHandlers?.delete('board_snapshot_get_response');
    window.app?.snapshotManager?.clearListCache?.();
    clearSnapshotHistoryState();
    if (window.app?.snapshotPreviewCanvas === previewCanvas || window.app?.snapshotPreviewCanvas === snapshotExportCanvas) {
      window.app.snapshotPreviewCanvas = null;
    }
    snapshotExportCanvas = null;
    for (const url of Object.values(thumbUrls)) URL.revokeObjectURL(url);
  });

  const hasSelection = $derived(
    (mode === 'rectangle' && selection && selection.width > 4 && selection.height > 4) ||
    (mode === 'lasso' && lassoPoints.length > 3)
  );
</script>

<div class="snapshot-overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="snapshot-panel">

    <!-- Header -->
    <div class="snap-header">
      <span class="snap-title">Board History</span>
      <div class="snap-header-right">
        <button class="snap-reload-btn" onclick={refresh} title="Refresh">&#8635;</button>
        <button class="snap-close-btn" onclick={close} title="Close">&times;</button>
      </div>
    </div>

    <!-- Preview area -->
    <div class="snap-preview-wrap" bind:this={previewWrap} onwheel={onWheel}>
      {#if !selectedId}
        <div class="snap-preview-empty">Select a snapshot below to preview</div>
      {:else if isLoadingPreview}
        <div class="snap-preview-empty">Loading…</div>
      {:else if previewError}
        <div class="snap-preview-empty">{previewError}</div>
      {:else}
        <!-- Tool controls -->
        <div class="snap-tool-controls">
          <button
            class="snap-tool-btn"
            class:active={activeTool === 'select' && mode === 'rectangle'}
            onclick={() => { mode = 'rectangle'; activeTool = 'select'; clearSelection(); }}
            title="Rectangle Selection"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="2" width="12" height="12" rx="1"/>
            </svg>
          </button>
          <button
            class="snap-tool-btn"
            class:active={activeTool === 'select' && mode === 'lasso'}
            onclick={() => { mode = 'lasso'; activeTool = 'select'; clearSelection(); }}
            title="Lasso Selection"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M8 2C4.7 2 2 4.7 2 8C2 11.3 4.7 14 8 14C10 14 11.8 13.2 13 11.8"/>
              <circle cx="13" cy="11.8" r="1.8"/>
            </svg>
          </button>
          <button
            class="snap-tool-btn"
            class:active={activeTool === 'pan'}
            onclick={() => { activeTool = activeTool === 'pan' ? 'select' : 'pan'; }}
            title="Pan View"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M8 2V14M2 8H14M8 2L6.5 3.5M8 2L9.5 3.5M8 14L6.5 12.5M8 14L9.5 12.5M2 8L3.5 6.5M2 8L3.5 9.5M14 8L12.5 6.5M14 8L12.5 9.5"/>
            </svg>
          </button>
          <button class="snap-tool-btn snap-zoom-reset" onclick={resetView} title="Reset zoom">{zoomLabel}</button>
        </div>

        <!-- Canvas stack: preview behind, selection on top -->
        <canvas
          bind:this={previewCanvas}
          class="snap-preview-canvas"
          style="transform: {canvasTransform}"
        ></canvas>
        <canvas
          bind:this={selectionCanvas}
          class="snap-selection-canvas"
          style="transform: {canvasTransform}; cursor: {activeTool === 'pan' ? (isPanning ? 'grabbing' : 'grab') : 'crosshair'}"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointerleave={onPointerUp}
        ></canvas>
      {/if}
    </div>

    <!-- Thumbnail strip -->
    <div
      class="snap-strip-wrap"
      bind:this={stripRef}
      role="presentation"
      onscroll={onStripScroll}
      onpointerdown={onStripPointerDown}
      onpointermove={onStripPointerMove}
      onpointerup={onStripPointerUp}
      onpointerleave={onStripPointerUp}
      style="cursor: {isDraggingStrip ? 'grabbing' : 'auto'}"
    >
      {#if snapshots.length === 0}
        <span class="snap-strip-empty">
          {#if canViewHistory}
            No snapshots available yet.
          {:else}
            Only registered users can view board history.
          {/if}
        </span>
      {:else}
        {#each snapshots as snap}
          {@const thumbUrl = getThumbUrl(snap)}
          <div
            class="snap-thumb-item"
            class:selected={snap.id === selectedId}
            onclick={() => { if (!stripMoved) selectSnapshot(snap.id); }}
            onkeydown={(event) => handleSnapshotKeydown(event, snap.id)}
            role="button"
            tabindex="0"
            title={snap.name}
          >
            {#if thumbUrl}
              <img src={thumbUrl} alt="snapshot" draggable="false" />
            {:else}
              <div class="snap-thumb-placeholder">{snap.auto ? 'Auto' : 'Manual'}</div>
            {/if}
            <span class="snap-thumb-time">{formatDate(snap.ts)}</span>
            <spam class="snap-thumb-issuer">{snap.issuer}</spam>
          </div>
        {/each}
        {#if isLoadingMore}
          <div class="snap-thumb-loading">Loading older snapshots...</div>
        {/if}
      {/if}
    </div>
    {#if showBackToPresent}
      <button class="snap-back-to-present" onclick={scrollToPresent} title="Jump back to the newest snapshots">
        <span aria-hidden="true">←</span>
        <span>Back to present</span>
      </button>
    {/if}

    <!-- Footer -->
    <div class="snap-footer">
      <span class="snap-hint">
        {#if !canRestoreHistory}
          View-only mode for registered users. Trusted users and above can restore snapshots.
        {:else if !selectedId}
          Select a snapshot below
        {:else if hasSelection}
          Selection active — only the selected region will be restored
        {:else}
          No selection — restore replaces the full board
        {/if}
      </span>
      <div class="snap-footer-btns">
        {#if hasSelection}
          <button class="btn secondary" onclick={clearSelection}>Clear Selection</button>
        {/if}
        <button class="btn secondary" disabled={!selectedId} onclick={openSnapshotSaveDialog}>
          Save Snapshot
        </button>
        <button class="btn primary" disabled={!selectedId || !canRestoreHistory} onclick={doRestore}>
          {hasSelection ? 'Restore Region' : 'Restore Board'}
        </button>
      </div>
    </div>

  </div>
</div>

<style>
  .snapshot-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .snapshot-panel {
    background: var(--bg-secondary, #1a1a1a);
    border: 1px solid var(--border-subtle, #333);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
    position: relative;
    width: 92vw;
    max-width: 960px;
    height: 90vh;
    max-height: 720px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .snap-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--bg-tertiary, #111);
    border-bottom: 1px solid var(--border-subtle, #333);
    flex-shrink: 0;
  }

  .snap-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary, #eee);
  }

  .snap-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .snap-reload-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary, #aaa);
    font-size: 18px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }
  .snap-reload-btn:hover {
    background: var(--bg-elevated, #2a2a2a);
    color: var(--text-primary, #fff);
  }

  .snap-close-btn {
    background: transparent;
    border: none;
    color: #f0f2f5;
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }

  .snap-close-btn:hover {
    color: #fff;
  }

  .snap-preview-wrap {
    flex: 1;
    position: relative;
    background: #111;
    overflow: hidden;
    min-height: 0;
  }

  .snap-preview-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted, #555);
    font-size: 13px;
    pointer-events: none;
    user-select: none;
  }

  .snap-tool-controls {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 3px;
    background: var(--bg-secondary, #1a1a1a);
    border: 1px solid var(--border-subtle, #333);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    z-index: 10;
  }

  .snap-tool-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--text-secondary, #aaa);
    cursor: pointer;
  }
  .snap-tool-btn:hover { background: var(--bg-elevated, #2a2a2a); color: #fff; }
  .snap-tool-btn.active { background: var(--accent-primary, #7c5cbf); color: #fff; }
  .snap-tool-btn svg { pointer-events: none; }
  .snap-zoom-reset {
    width: auto;
    min-width: 44px;
    padding: 0 6px;
    font-size: 11px;
    font-weight: 600;
  }

  .snap-preview-canvas {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    image-rendering: auto;
  }

  .snap-selection-canvas {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    pointer-events: auto;
    touch-action: none;
  }

  .snap-strip-wrap {
    height: 110px;
    flex-shrink: 0;
    background: var(--bg-tertiary, #111);
    border-top: 1px solid var(--border-subtle, #333);
    border-bottom: 1px solid var(--border-subtle, #333);
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 8px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    scrollbar-color: #555 transparent;
  }
  .snap-strip-wrap::-webkit-scrollbar { height: 4px; }
  .snap-strip-wrap::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
  .snap-strip-wrap::-webkit-scrollbar-thumb:hover { background: #666; }

  .snap-strip-empty {
    font-size: 12px;
    color: var(--text-muted, #555);
    white-space: nowrap;
  }

  .snap-thumb-item {
    flex-shrink: 0;
    width: 90px;
    height: 90px;
    border: 2px solid #333;
    border-radius: 5px;
    overflow: hidden;
    cursor: pointer;
    position: relative;
    background: #0a0a0a;
  }
  
  .snap-thumb-item:hover { border-color: #555; }
  .snap-thumb-item.selected { border-color: var(--accent-primary, #7c5cbf); }
  .snap-thumb-item img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .snap-thumb-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: #555;
  }

  .snap-thumb-time {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    font-size: 9px;
    text-align: center;
    background: rgba(0,0,0,0.65);
    color: #ccc;
    padding: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .snap-thumb-issuer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    font-size: 8px;
    font-weight: 600;
    text-align: center;
    background: rgba(0, 0, 0, 0.5);
    color: var(--accent-primary);
    padding: 2px;
    text-transform: uppercase;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
  }
  
  .snap-thumb-item:hover .snap-thumb-issuer,
  .snap-thumb-item.selected .snap-thumb-issuer {
    opacity: 1;
  }
  .snap-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: var(--bg-tertiary, #111);
    flex-shrink: 0;
    gap: 12px;
  }

  .snap-hint {
    font-size: 12px;
    color: var(--text-muted, #666);
    flex: 1;
  }

  .snap-footer-btns {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .snap-thumb-loading {
    min-width: 140px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--text-secondary, #aaa);
    white-space: nowrap;
  }

  .snap-back-to-present {
    position: absolute;
    right: 18px;
    bottom: 128px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border: 1px solid var(--border-subtle, #333);
    border-radius: 999px;
    background: rgba(17, 17, 17, 0.92);
    color: var(--text-primary, #eee);
    font-size: 12px;
    cursor: pointer;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    z-index: 5;
  }
  .snap-back-to-present:hover {
    background: rgba(28, 28, 28, 0.96);
  }

  .btn {
    padding: 7px 14px;
    font-size: 13px;
    border-radius: 5px;
    cursor: pointer;
    border: none;
  }
  .btn.secondary {
    background: transparent;
    border: 1px solid #444;
    color: #aaa;
  }
  .btn.secondary:hover { background: #2a2a2a; color: #fff; }
  .btn.primary {
    background: var(--accent-primary, #7c5cbf);
    color: #fff;
  }
  .btn.primary:hover { filter: brightness(1.1); }
  .btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
