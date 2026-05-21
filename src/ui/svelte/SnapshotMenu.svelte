<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { appState, clearSnapshotHistoryState, toggleSnapshotMenu, setSnapshotSource } from '../../state.svelte.js';
  import { T } from '../../../shared/MessageTypes.js';
  import * as wasm from '../../wasm/ddraw_wasm.js';
  import { getLocalSnapshotSettings, saveLocalSnapshotSettings } from '../../remote/SnapshotManager.js';

  let showLocalSettings = $state(false);
  let localSettings = $state(getLocalSnapshotSettings());

  function toggleLocalSettings() {
    if (!showLocalSettings) localSettings = getLocalSnapshotSettings();
    showLocalSettings = !showLocalSettings;
  }

  function updateLocalSetting(patch) {
    localSettings = saveLocalSnapshotSettings({ ...localSettings, ...patch });
    window.app?.snapshotManager?.refreshLocalCapture?.();
  }

  let snapshots = $derived(appState.snapshots || []);
  let snapshotHasMore = $derived(appState.snapshotHasMore);
  let snapshotListVersion = $derived(appState.snapshotListVersion);
  let snapshotSource = $derived(appState.snapshotSource);
  
  let hasLoadedOlderSnapshots = $derived(snapshots.length > 20);
  let isSoloOccupant = $derived(appState.userCount <= 1);
  let canViewHistory = $derived(appState.selfRole >= 1 || isSoloOccupant);
  let canRestoreHistory = $derived(appState.selfRole >= 2 || (snapshotSource === 'local' && appState.connected));
  let canRestoreBoard = $derived(appState.selfRole >= 2);

  let selectedId = $state(null);
  let selectedLayers = $state(null);
  let isLoadingPreview = $state(false);
  let isLoadingSnapshots = $state(false);
  let isLoadingMore = $state(false);
  let previewError = $state('');
  let lastHandledSnapshotListVersion = $state(0);
  let showBackToPresent = $state(false);
  let previewRequestTimeout = null;
  let listRequestTimeout = null;
  let listError = $state('');

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

  // Canvas refs
  let previewCanvas = $state(null);
  let selectionCanvas = $state(null);
  let previewWrap = $state(null);
  let snapshotExportCanvas = null;

  // Thumb URL cache (non-reactive Map — we mutate it freely)
  const thumbUrls = new Map();

  // Derived map: snapshot id -> blob URL. Re-computed when snapshots change.
  // Builds URLs eagerly outside of template expressions.
  let thumbUrlMap = $derived.by(() => {
    const map = new Map();
    for (const snap of snapshots) {
      let url = thumbUrls.get(snap.id);
      if (!url && snap.thumb && snap.thumb.length > 0) {
        const blob = new Blob([snap.thumb], { type: 'image/jpeg' });
        url = URL.createObjectURL(blob);
        thumbUrls.set(snap.id, url);
      }
      if (url) map.set(snap.id, url);
    }
    return map;
  });

  let canvasTransform = $derived(`translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`);
  let zoomLabel = $derived(`${Math.round(viewZoom * 100)}%`);

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

  function close() { toggleSnapshotMenu(); }

  async function refresh() {
    isLoadingSnapshots = true;
    isLoadingMore = false;
    showBackToPresent = false;
    listError = '';

    if (listRequestTimeout) {
      clearTimeout(listRequestTimeout);
      listRequestTimeout = null;
    }

    if (snapshotSource === 'remote') {
      window.app?.snapshotManager?.requestList();
      listRequestTimeout = window.setTimeout(() => {
        listRequestTimeout = null;
        if (isLoadingSnapshots) {
          isLoadingSnapshots = false;
          listError = 'Failed to load snapshots. Check your connection and try again.';
        }
      }, 15000);
    } else {
      try {
        const pageSize = 20;
        const localList = await window.app.snapshotManager.listLocal(pageSize);
        appState.snapshots = localList;
        // Assume there are more if we got exactly pageSize results
        appState.snapshotHasMore = localList.length === pageSize;
        appState.snapshotListVersion += 1;
      } catch (err) {
        console.warn('[SnapshotMenu] Local list failed:', err);
      } finally {
        isLoadingSnapshots = false;
      }
    }
  }

  function formatDate(ts) {
    const d = new Date(Number(ts));
    return d.toLocaleDateString() === new Date().toLocaleDateString()
      ? d.toLocaleTimeString()
      : d.toLocaleString();
  }

  async function loadMoreSnapshots() {
    if (isLoadingSnapshots || isLoadingMore || !snapshotHasMore || snapshots.length === 0) return;
    const oldest = snapshots[snapshots.length - 1];
    if (!oldest?.ts) return;

    isLoadingMore = true;
    if (snapshotSource === 'remote') {
      window.app?.snapshotManager?.requestList({ beforeTs: Number(oldest.ts), append: true });
    } else {
      try {
        const pageSize = 20;
        const moreSnapshots = await window.app.snapshotManager.listLocal(pageSize, Number(oldest.ts));
        appState.snapshots = [...appState.snapshots, ...moreSnapshots.filter((snap) => !appState.snapshots.some((existing) => existing.id === snap.id))];
        appState.snapshotHasMore = moreSnapshots.length === pageSize;
        appState.snapshotListVersion += 1;
      } catch (err) {
        console.warn('[SnapshotMenu] Local load more failed:', err);
      } finally {
        isLoadingMore = false;
      }
    }
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

  async function selectSnapshot(id) {
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

    if (snapshotSource === 'remote') {
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
    } else {
      // Local
      try {
        const record = await window.app.snapshotManager.getLocal(id);
        if (record?.layers && record.layers.length > 0) {
          selectedLayers = record.layers;
          isLoadingPreview = false;
          await tick();
          renderPreview(record.layers);
          resetView();
        } else {
          const snapshotMeta = snapshots.find((snap) => snap.id === id);
          const thumb = record?.thumb || snapshotMeta?.thumb || null;
          if (!thumb || thumb.length === 0) {
            throw new Error('Local record not found or incomplete');
          }

          selectedLayers = null;
          isLoadingPreview = false;
          await tick();
          await renderThumbnailPreview(thumb);
          resetView();
        }
      } catch (err) {
        console.warn('[SnapshotMenu] Local preview error', err);
        isLoadingPreview = false;
        previewError = 'Failed to load local snapshot from browser storage.';
      }
    }
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

  async function renderThumbnailPreview(thumbBytes) {
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

    const bg = window.app.board.backgroundColor || '#ffffff';
    exportCtx.fillStyle = typeof bg === 'string' ? bg : `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    exportCtx.fillRect(0, 0, w, h);

    if (thumbBytes && thumbBytes.length > 0) {
      const url = URL.createObjectURL(new Blob([thumbBytes], { type: 'image/jpeg' }));
      try {
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
            const drawW = img.naturalWidth * scale;
            const drawH = img.naturalHeight * scale;
            const drawX = (w - drawW) / 2;
            const drawY = (h - drawH) / 2;
            exportCtx.drawImage(img, drawX, drawY, drawW, drawH);
            resolve();
          };
          img.onerror = () => reject(new Error('Failed to decode thumbnail preview'));
          img.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    snapshotExportCanvas = exportCanvas;
    const ctx = previewCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(exportCanvas, 0, 0);

    window.app.snapshotPreviewCanvas = exportCanvas;
  }

  function openSnapshotSaveDialog() {
    if (!selectedId || !snapshotExportCanvas) return;
    window.app?.openSaveDialogForCanvas?.(snapshotExportCanvas);
  }

  async function doRestore() {
    if (!selectedId) return;
    const hasSel = hasSelection;

    // No selection → Restore Board (full replace) with confirmation
    if (!hasSel) {
      if (!canRestoreBoard) {
        window.app?.ui?.showToast?.('Restore Board requires Trusted rank or higher', 3500, 'error');
        return;
      }
      if (!await window.showAppConfirm('Replace entire board?', {
        title: 'Restore board?',
        confirmLabel: 'Replace',
        danger: true
      })) return;
      if (snapshotSource === 'local') {
        // Upload to server then broadcast restore so all users sync
        const ok = await window.app.snapshotManager.uploadAndRestoreLocal(selectedId);
        if (ok) {
          window.app?.ui?.showToast?.('Local snapshot uploaded and restored', 3000);
          close();
        } else {
          alert('Failed to upload local snapshot.');
        }
      } else {
        window.app.snapshotManager.restoreSnapshot(selectedId);
        close();
      }
      return;
    }

    // Lasso region: not supported for cropped upload
    // Local: fall back to remote-style behavior is unavailable, so warn
    // Remote: use existing server-side region restore (lasso path)
    if (mode === 'lasso') {
      if (snapshotSource === 'remote') {
        applyRegionRestore();
        close();
      } else {
        window.app?.ui?.showToast?.('Lasso upload not supported. Use rectangle selection to upload a cropped region.', 4000);
      }
      return;
    }

    // Rectangle region → Upload as floating multi-layer selection (works for both local and remote)
    let layersToUpload;
    if (snapshotSource === 'local') {
      const record = await window.app.snapshotManager.getLocal(selectedId);
      if (!record?.layers) {
        alert('Failed to load snapshot.');
        return;
      }
      layersToUpload = record.layers;
      // Also push the local snapshot to the server so it's available to other users
      // (mirrors the server-snapshot flow). Fire-and-forget; ignore failures.
      window.app.snapshotManager.uploadLocalToServer(selectedId).catch(() => {});
    } else {
      if (!selectedLayers || selectedLayers.length === 0) {
        alert('Snapshot data is still loading. Please wait and try again.');
        return;
      }
      layersToUpload = selectedLayers;
    }

    await window.app.uploadSnapshotLayersAsSelection(layersToUpload, selection);
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
      msg.cr = lassoPoints.flatMap(p => [p.x, p.y]);
    } else {
      msg.sx = Math.round(selection.x);
      msg.sy = Math.round(selection.y);
      msg.sw = Math.round(selection.width);
      msg.sh = Math.round(selection.height);
    }
    window.app.wsClient.send(msg);
  }

  async function doDelete() {
    if (!selectedId) return;
    if (!await window.showAppConfirm('Are you sure you want to delete this snapshot?', {
      title: 'Delete snapshot?',
      confirmLabel: 'Delete',
      danger: true
    })) return;
    
    if (snapshotSource === 'remote') {
      window.app.snapshotManager.deleteSnapshot(selectedId);
      // Update local cache
      appState.snapshots = snapshots.filter(s => s.id !== selectedId);
      appState.snapshotListVersion += 1;
    } else {
      await window.app.snapshotManager.deleteLocal(selectedId);
      if (thumbUrls.has(selectedId)) {
        URL.revokeObjectURL(thumbUrls.get(selectedId));
        thumbUrls.delete(selectedId);
      }
      appState.snapshots = snapshots.filter(s => s.id !== selectedId);
      appState.snapshotListVersion += 1;
    }
    
    selectedId = null;
    selectedLayers = null;
    if (window.app.snapshotPreviewCanvas === snapshotExportCanvas) {
      window.app.snapshotPreviewCanvas = null;
    }
    snapshotExportCanvas = null;
  }

  function clearSelection() { selection = null; lassoPoints = []; }

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
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, w, h);
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
    if (listRequestTimeout) {
      clearTimeout(listRequestTimeout);
      listRequestTimeout = null;
    }
    isLoadingSnapshots = false;
    isLoadingMore = false;
    listError = '';
  });

  onMount(() => {
    if (!canViewHistory && snapshotSource === 'remote') {
      window.app.snapshotPreviewCanvas = null;
      previewError = 'Only registered users can view board history.';
      return;
    }

    lastHandledSnapshotListVersion = snapshotListVersion;
    refresh();
    const tickFrame = () => {
      marchingAntsOffset = (marchingAntsOffset + 0.4) % 13;
      drawSelection();
      animId = requestAnimationFrame(tickFrame);
    };
    animId = requestAnimationFrame(tickFrame);
  });

  onDestroy(() => {
    if (animId) cancelAnimationFrame(animId);
    if (previewRequestTimeout) clearTimeout(previewRequestTimeout);
    if (listRequestTimeout) clearTimeout(listRequestTimeout);
    window.app?.wsClient?.messageHandlers?.delete('board_snapshot_get_response');
    window.app?.snapshotManager?.clearListCache?.();
    clearSnapshotHistoryState();
    if (window.app?.snapshotPreviewCanvas === previewCanvas || window.app?.snapshotPreviewCanvas === snapshotExportCanvas) {
      window.app.snapshotPreviewCanvas = null;
    }
    snapshotExportCanvas = null;
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    thumbUrls.clear();
  });

  const hasSelection = $derived(
    (mode === 'rectangle' && selection && selection.width > 4 && selection.height > 4) ||
    (mode === 'lasso' && lassoPoints.length > 3)
  );

  function handleSourceChange(source) {
    selectedId = null;
    selectedLayers = null;
    selection = null;
    lassoPoints = [];
    previewError = '';
    listError = '';
    setSnapshotSource(source);
    refresh();
  }
</script>

<div class="snapshot-overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()} onpointerup={(e) => e.pointerType !== 'mouse' && e.target === e.currentTarget && close()}>
  <div class="snapshot-panel" data-tut="history-dialog">

    <!-- Header -->
    <div class="snap-header">
      <div class="snap-header-left">
        <span class="snap-title">Board History</span>
        <div class="snap-source-toggle">
          <button 
            class="snap-source-btn" 
            class:active={snapshotSource === 'remote'} 
            onclick={() => handleSourceChange('remote')}
          >
            Server
          </button>
          <button
            class="snap-source-btn"
            class:active={snapshotSource === 'local'}
            onclick={() => handleSourceChange('local')}
          >
            Local
          </button>
        </div>
        {#if snapshotSource === 'local'}
          <button class="snap-settings-btn" class:active={showLocalSettings} onclick={toggleLocalSettings} title="Local snapshot settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        {/if}
      </div>
      <div class="snap-header-right">
        <button class="snap-reload-btn" onclick={refresh} onpointerup={(e) => e.pointerType !== 'mouse' && refresh()} title="Refresh">&#8635;</button>
        <button class="snap-close-btn" onclick={close} onpointerup={(e) => e.pointerType !== 'mouse' && close()} title="Close">&times;</button>
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
            onpointerup={(e) => e.pointerType !== 'mouse' && (mode = 'rectangle', activeTool = 'select', clearSelection())}
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
            onpointerup={(e) => e.pointerType !== 'mouse' && (mode = 'lasso', activeTool = 'select', clearSelection())}
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
            onpointerup={(e) => e.pointerType !== 'mouse' && (activeTool = activeTool === 'pan' ? 'select' : 'pan')}
            title="Pan View"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M8 2V14M2 8H14M8 2L6.5 3.5M8 2L9.5 3.5M8 14L6.5 12.5M8 14L9.5 12.5M2 8L3.5 6.5M2 8L3.5 9.5M14 8L12.5 6.5M14 8L12.5 9.5"/>
            </svg>
          </button>
          <button class="snap-tool-btn snap-zoom-reset" onclick={resetView} onpointerup={(e) => e.pointerType !== 'mouse' && resetView()} title="Reset zoom">{zoomLabel}</button>
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

    {#if snapshotSource === 'local' && showLocalSettings}
      <div class="snap-local-settings">
        <div class="snap-local-settings-row">
          <label class="snap-local-toggle">
            <input
              type="checkbox"
              checked={localSettings.enabled}
              onchange={(e) => updateLocalSetting({ enabled: e.currentTarget.checked })}
            />
            <span>Enable local snapshots</span>
          </label>
          <span class="snap-local-hint">Stored in your browser (IndexedDB) for recovery.</span>
        </div>
        <div class="snap-local-settings-row">
          <label class="snap-local-field">
            <span>Interval</span>
            <input
              type="number"
              min="5"
              max="600"
              step="5"
              disabled={!localSettings.enabled}
              value={localSettings.intervalSec}
              onchange={(e) => updateLocalSetting({ intervalSec: parseInt(e.currentTarget.value, 10) })}
            />
            <span class="snap-local-suffix">sec</span>
          </label>
          <label class="snap-local-field">
            <span>Keep last</span>
            <input
              type="number"
              min="1"
              max="500"
              step="1"
              disabled={!localSettings.enabled}
              value={localSettings.maxCount}
              onchange={(e) => updateLocalSetting({ maxCount: parseInt(e.currentTarget.value, 10) })}
            />
            <span class="snap-local-suffix">snapshots</span>
          </label>
        </div>
      </div>
    {/if}

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
      {#if isLoadingSnapshots && snapshots.length === 0}
        <span class="snap-strip-empty">Loading…</span>
      {:else if listError}
        <span class="snap-strip-empty snap-strip-error">{listError}</span>
      {:else if snapshots.length === 0}
        <span class="snap-strip-empty">
          {#if snapshotSource === 'remote'}
            {#if canViewHistory}
              No snapshots available yet.
            {:else}
              Only registered users can view board history unless they are alone in the room.
            {/if}
          {:else if !localSettings.enabled}
            Local snapshots are disabled. Click the gear icon above to enable automatic captures.
          {:else}
            No local snapshots yet. They are captured every {localSettings.intervalSec}s for recovery.
          {/if}
        </span>
      {:else}
        {#each snapshots as snap (snap.id)}
          <div
            class="snap-thumb-item"
            class:selected={snap.id === selectedId}
            onclick={() => { if (!stripMoved) selectSnapshot(snap.id); }}
            onpointerup={(e) => e.pointerType !== 'mouse' && !stripMoved && selectSnapshot(snap.id)}
            onkeydown={(event) => handleSnapshotKeydown(event, snap.id)}
            role="button"
            tabindex="0"
            title={snap.name}
          >
            {#if thumbUrlMap.get(snap.id)}
              <img src={thumbUrlMap.get(snap.id)} alt="snapshot" draggable="false" />
            {:else}
              <div class="snap-thumb-placeholder">{snap.auto ? 'Auto' : 'Manual'}</div>
            {/if}
            <span class="snap-thumb-time">{formatDate(snap.ts)}</span>
            <span class="snap-thumb-issuer">{snap.issuer}</span>
          </div>
        {/each}
        {#if isLoadingMore}
          <div class="snap-thumb-loading">Loading older snapshots...</div>
        {/if}
      {/if}
    </div>
    {#if showBackToPresent}
      <button class="snap-back-to-present" onclick={scrollToPresent} onpointerup={(e) => e.pointerType !== 'mouse' && scrollToPresent()} title="Jump back to the newest snapshots">
        <span aria-hidden="true">←</span>
        <span>Back to present</span>
      </button>
    {/if}

    <!-- Footer -->
    <div class="snap-footer">
      <span class="snap-hint">
        {#if !canRestoreHistory && snapshotSource === 'remote'}
          View-only mode for registered users. Trusted users and above can restore snapshots.
        {:else if !selectedId}
          Select a snapshot below
        {:else if hasSelection && mode === 'rectangle'}
          Selection active — region uploads as a movable floating selection
        {:else if hasSelection && mode === 'lasso' && snapshotSource === 'remote'}
          Lasso selection — restores the region (broadcast to all users)
        {:else if hasSelection && mode === 'lasso'}
          Lasso selection — not supported for upload (use rectangle)
        {:else}
          No selection — replaces the entire board
        {/if}
      </span>
      <div class="snap-footer-btns">
        {#if selectedId}
          <button class="btn danger" onclick={doDelete} onpointerup={(e) => e.pointerType !== 'mouse' && doDelete()}>Delete</button>
        {/if}
        {#if hasSelection && snapshotSource === 'remote'}
          <button class="btn secondary" onclick={clearSelection} onpointerup={(e) => e.pointerType !== 'mouse' && clearSelection()}>Clear Selection</button>
        {/if}
        <button class="btn secondary" disabled={!selectedId} onclick={openSnapshotSaveDialog} onpointerup={(e) => e.pointerType !== 'mouse' && openSnapshotSaveDialog()}>
          Save Snapshot
        </button>
        <button class="btn primary" disabled={!selectedId || !canRestoreHistory} onclick={doRestore} onpointerup={(e) => e.pointerType !== 'mouse' && doRestore()}>
          {#if !hasSelection}
            Restore Board
          {:else if mode === 'lasso' && snapshotSource === 'remote'}
            Restore Region
          {:else}
            Upload
          {/if}
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
    display: flex; flex-direction: column; overflow: hidden;
  }

  .snap-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; background: var(--bg-tertiary, #111);
    border-bottom: 1px solid var(--border-subtle, #333); flex-shrink: 0;
  }
  .snap-header-left { display: flex; align-items: center; gap: 20px; }

  .snap-source-toggle {
    display: flex; background: #000; padding: 2px; border-radius: 6px;
  }
  .snap-source-btn {
    padding: 3px 10px; border: none; background: transparent; color: #777;
    font-size: 11px; font-weight: 600; cursor: pointer; border-radius: 4px;
  }
  .snap-source-btn.active { background: #222; color: var(--accent-primary); }

  .snap-title { font-size: 14px; font-weight: 600; color: var(--text-primary, #eee); }
  .snap-header-right { display: flex; align-items: center; gap: 8px; }

  .snap-reload-btn {
    background: none; border: none; cursor: pointer; color: var(--text-secondary, #aaa);
    font-size: 18px; width: 28px; height: 28px; display: flex;
    align-items: center; justify-content: center; border-radius: 4px;
  }
  .snap-reload-btn:hover { background: var(--bg-elevated, #2a2a2a); color: var(--text-primary, #fff); }

  .snap-close-btn {
    background: transparent; border: none; color: #f0f2f5; font-size: 1.75rem;
    line-height: 1; cursor: pointer; padding: 0;
  }
  .snap-close-btn:hover { color: #fff; }

  .snap-preview-wrap { flex: 1; position: relative; background: #111; overflow: hidden; min-height: 0; }
  .snap-preview-empty {
    position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: var(--text-muted, #555); font-size: 13px;
    pointer-events: none; user-select: none;
  }

  .snap-tool-controls {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 3px; background: var(--bg-secondary, #1a1a1a);
    border: 1px solid var(--border-subtle, #333); border-radius: 8px; padding: 4px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5); z-index: 10;
  }

  .snap-tool-btn {
    display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    background: transparent; border: none; border-radius: 5px;
    color: var(--text-secondary, #aaa); cursor: pointer;
  }
  .snap-tool-btn:hover { background: var(--bg-elevated, #2a2a2a); color: #fff; }
  .snap-tool-btn.active { background: var(--accent-primary, #7c5cbf); color: #fff; }
  .snap-zoom-reset { width: auto; min-width: 44px; padding: 0 6px; font-size: 11px; font-weight: 600; }

  .snap-preview-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .snap-selection-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; pointer-events: auto; touch-action: none; }

  .snap-strip-wrap {
    height: 110px; flex-shrink: 0; background: var(--bg-tertiary, #111);
    border-top: 1px solid var(--border-subtle, #333); border-bottom: 1px solid var(--border-subtle, #333);
    display: flex; align-items: center; padding: 0 12px; gap: 8px;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
  }
  .snap-strip-wrap::-webkit-scrollbar { height: 4px; }
  .snap-strip-wrap::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }

  .snap-strip-empty { font-size: 12px; color: var(--text-muted, #555); white-space: nowrap; }
  .snap-strip-empty.snap-strip-error { color: #ff6b6b; font-weight: 500; }

  .snap-thumb-item {
    flex-shrink: 0; width: 90px; height: 90px; border: 2px solid #333;
    border-radius: 5px; overflow: hidden; cursor: pointer; position: relative; background: #0a0a0a;
  }
  .snap-thumb-item:hover { border-color: #555; }
  .snap-thumb-item.selected { border-color: var(--accent-primary, #7c5cbf); }
  .snap-thumb-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .snap-thumb-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #555; }

  .snap-thumb-time {
    position: absolute; bottom: 0; left: 0; right: 0; font-size: 9px;
    text-align: center; background: rgba(0,0,0,0.65); color: #ccc; padding: 2px;
  }
  .snap-thumb-issuer {
    position: absolute; top: 0; left: 0; right: 0; font-size: 8px; font-weight: 600;
    text-align: center; background: rgba(0, 0, 0, 0.5); color: var(--accent-primary);
    padding: 2px; opacity: 0; transition: opacity 0.2s;
  }
  .snap-thumb-item:hover .snap-thumb-issuer, .snap-thumb-item.selected .snap-thumb-issuer { opacity: 1; }

  .snap-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; background: var(--bg-tertiary, #111); flex-shrink: 0; gap: 12px;
  }
  .snap-hint { font-size: 12px; color: var(--text-muted, #666); flex: 1; }
  .snap-footer-btns { display: flex; gap: 8px; align-items: center; }

  .btn { padding: 7px 14px; font-size: 13px; border-radius: 5px; cursor: pointer; border: none; }
  .btn.secondary { background: transparent; border: 1px solid #444; color: #aaa; }
  .btn.secondary:hover { background: #2a2a2a; color: #fff; }
  .btn.primary { background: var(--accent-primary, #7c5cbf); color: #fff; }
  .btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.danger { background: rgba(220, 53, 69, 0.2); color: #ff6b6b; border: 1px solid rgba(220, 53, 69, 0.4); }
  .btn.danger:hover { background: rgba(220, 53, 69, 0.4); }

  .snap-settings-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; background: transparent; border: 1px solid #333;
    border-radius: 5px; color: var(--text-secondary, #aaa); cursor: pointer; margin-left: 4px;
  }
  .snap-settings-btn:hover { background: var(--bg-elevated, #2a2a2a); color: #fff; }
  .snap-settings-btn.active { background: var(--accent-primary, #7c5cbf); color: #fff; border-color: var(--accent-primary, #7c5cbf); }

  .snap-local-settings {
    background: var(--bg-tertiary, #111); border-top: 1px solid var(--border-subtle, #333);
    padding: 10px 16px; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;
  }
  .snap-local-settings-row {
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  }
  .snap-local-toggle {
    display: inline-flex; align-items: center; gap: 6px; color: #ddd; font-size: 12px; cursor: pointer;
  }
  .snap-local-toggle input { cursor: pointer; }
  .snap-local-hint { font-size: 11px; color: #777; }
  .snap-local-field {
    display: inline-flex; align-items: center; gap: 6px; color: #bbb; font-size: 12px;
  }
  .snap-local-field input {
    width: 64px; padding: 3px 6px; background: #0a0a0a; border: 1px solid #333;
    border-radius: 4px; color: #eee; font-size: 12px;
  }
  .snap-local-field input:disabled { opacity: 0.4; cursor: not-allowed; }
  .snap-local-suffix { color: #777; font-size: 11px; }

  .snap-back-to-present {
    position: absolute; right: 18px; bottom: 128px; display: inline-flex;
    align-items: center; gap: 6px; padding: 8px 12px; border: 1px solid #333;
    border-radius: 999px; background: rgba(17, 17, 17, 0.92); color: #eee;
    font-size: 12px; cursor: pointer;
  }
</style>
