<script>
  import { appState } from '../../state.svelte.js';

  let selectedTargetId = $state('');

  let users = $derived.by(() => {
    return [...appState.users.values()]
      .filter((user) => user && user.id !== appState.sessionIndex)
      .sort((a, b) => {
        if (!!a.afk !== !!b.afk) return Number(!!a.afk) - Number(!!b.afk);
        return ((a.username || a.name || '')).localeCompare(b.username || b.name || '');
      });
  });

  function handleSync() {
    if (window.app?.syncClient) {
      window.app.syncClient.requestSync(selectedTargetId ? Number(selectedTargetId) : null);
    }
  }
</script>

{#if appState.syncing}
  <div class="sync-overlay active">
    <div class="sync-content">
      {#if appState.syncInactive}
        <div class="sync-inactive-controls">
          <p class="sync-text">{appState.syncMessage}</p>
          <select bind:value={selectedTargetId} aria-label="Sync source user">
            <option value="">Auto-select best user</option>
            {#each users as user}
              <option value={user.id}>
                {user.username || user.name || `User ${user.id}`}{user.afk ? ' (inactive)' : ''}
              </option>
            {/each}
          </select>
          <button type="button" onclick={handleSync}>Sync</button>
        </div>
      {:else}
        <span class="sync-text">{appState.syncMessage}</span>
        <div class="sync-progress-bar">
          <div class="sync-progress-fill" style="width: {appState.syncProgress}%"></div>
        </div>
        <div class="sync-hint">
          Sync stuck? Try manually syncing to another user. Click the little arrow on the right side of their username in the list.
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sync-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(4px);
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
  }

  .sync-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    width: min(400px, 90%);
  }

  .sync-text {
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    text-shadow: 0 2px 4px rgba(0,0,0,0.5);
  }

  .sync-progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
  }

  .sync-progress-fill {
    height: 100%;
    background: #00d4aa;
    transition: width 0.3s ease;
  }

  .sync-hint {
    color: rgba(255, 255, 255, 0.6);
    font-size: 12px;
    text-align: center;
    line-height: 1.4;
  }

  .sync-inactive-controls {
    width: 100%;
    padding: 20px;
    border-radius: 16px;
    background: rgba(16, 19, 24, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  select {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.05);
    color: #fff;
    outline: none;
  }

  select option {
    background: #1a1a1e;
    color: #fff;
  }

  button {
    width: 100%;
    height: 40px;
    border: none;
    border-radius: 20px;
    background: linear-gradient(135deg, #00d4aa, #4ae3bf);
    color: #081711;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.1s;
  }

  button:active {
    transform: scale(0.98);
  }
</style>
