<script>
  import { onMount, onDestroy } from 'svelte';
  import { appState, toggleSnapshotMenu } from '../../state.svelte.js';

  let snapshots = $derived(appState.snapshots || []);
  let refreshTimer = null;

  /** Map of snapshot id -> object URL for thumbnails (plain object, not reactive) */
  let thumbUrls = {};

  function close() {
    toggleSnapshotMenu();
  }

  function restore(id) {
    if (confirm('Are you sure you want to restore this board snapshot? This will wipe the current state.')) {
      window.app.snapshotManager.restoreSnapshot(id);
      close();
    }
  }

  function deleteSnapshot(id) {
    if (confirm('Delete this snapshot?')) {
      window.app.snapshotManager.deleteSnapshot(id);
    }
  }

  function refresh() {
    if (window.app?.snapshotManager) {
      window.app.snapshotManager.requestList();
    }
  }

  function formatDate(ts) {
    return new Date(Number(ts)).toLocaleString();
  }

  function getThumbUrl(snap) {
    if (thumbUrls[snap.id]) return thumbUrls[snap.id];
    if (!snap.thumb || snap.thumb.length === 0) return null;

    // Convert Uint8Array/Buffer to blob URL
    const blob = new Blob([snap.thumb], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    thumbUrls[snap.id] = url;
    return url;
  }

  onMount(() => {
    refresh();
    refreshTimer = setInterval(refresh, 5000);
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    // Revoke all blob URLs
    for (const url of Object.values(thumbUrls)) {
      URL.revokeObjectURL(url);
    }
  });
</script>

<div class="snapshot-menu modal-overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="modal-content">
    <div class="modal-header">
      <h2>Board Snapshots (Undo History)</h2>
      <div class="header-actions">
        <button class="reload-btn" onclick={refresh}>Reload</button>
        <button class="close-btn" onclick={close}>&times;</button>
      </div>
    </div>

    <div class="snapshot-list">
      {#if snapshots.length === 0}
        <p class="empty-msg">No snapshots available. (Requires Helper+ rank)</p>
      {:else}
        {#each snapshots as snap}
          {@const thumbUrl = getThumbUrl(snap)}
          <div class="snapshot-item" class:auto={snap.auto}>
            {#if thumbUrl}
              <img class="snap-thumb" src={thumbUrl} alt="Snapshot preview" />
            {:else}
              <div class="snap-thumb snap-thumb-empty"></div>
            {/if}
            <div class="snap-info">
              <span class="snap-name">{snap.name}</span>
              <span class="snap-meta">By {snap.issuer} &bull; {formatDate(snap.ts)}</span>
            </div>
            <div class="snap-actions">
              <button class="restore-btn" onclick={() => restore(snap.id)}>Restore</button>
              <button class="delete-btn" onclick={() => deleteSnapshot(snap.id)}>&times;</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="modal-footer">
      <p class="hint">Auto-snapshots are taken every 2 seconds by the server.</p>
      <button onclick={() => window.app.snapshotManager.saveSnapshot(`Manual ${new Date().toLocaleTimeString()}`)}>
        Save Current State
      </button>
    </div>
  </div>
</div>

<style lang="scss">
  .snapshot-menu {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .modal-content {
    background: #1a1a1a;
    color: #eee;
    width: 540px;
    max-width: 90vw;
    max-height: 80vh;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    border: 1px solid #333;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
  }

  .modal-header {
    padding: 15px;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-between;
    align-items: center;

    h2 { margin: 0; font-size: 1.2rem; }
  }

  .header-actions {
    display: flex;
    gap: 10px;
    align-items: center;

    .reload-btn {
      background: #333;
      border: 1px solid #444;
      color: #ccc;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
      &:hover { background: #444; color: #fff; }
    }

    .close-btn {
      background: none;
      border: none;
      color: #aaa;
      cursor: pointer;
      font-size: 1.5rem;
      line-height: 1;
      padding: 0;
      &:hover { color: #fff; }
    }
  }

  .snapshot-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
  }

  .snapshot-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-bottom: 1px solid #222;
    &:last-child { border-bottom: none; }
    &:hover { background: #222; }

    &.auto { border-left: 3px solid #444; }
  }

  .snap-thumb {
    width: 64px;
    height: 48px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid #333;
    flex-shrink: 0;
    background: #111;
  }

  .snap-thumb-empty {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .snap-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .snap-name { font-weight: bold; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .snap-meta { font-size: 0.8rem; color: #888; }

  .snap-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .restore-btn {
    background: #2a5a2a;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
    &:hover { background: #3a7a3a; }
  }

  .delete-btn {
    background: #5a2a2a;
    color: #aaa;
    border: none;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    &:hover { background: #7a3a3a; color: #fff; }
  }

  .modal-footer {
    padding: 15px;
    border-top: 1px solid #333;
    display: flex;
    flex-direction: column;
    gap: 10px;

    .hint { font-size: 0.75rem; color: #666; margin: 0; text-align: center; }

    button {
      background: #333;
      color: #eee;
      border: 1px solid #444;
      padding: 10px;
      border-radius: 4px;
      cursor: pointer;
      &:hover { background: #444; }
    }
  }

  .empty-msg { text-align: center; color: #666; padding: 40px 0; }
</style>
