<script>
  import { appState } from '../../state.svelte.js';

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
  const TOKEN_KEY = 'topDrawAuthToken';
  const COLLECTION_OPTIONS = [
    'users',
    'rooms',
    'moderation',
    'room_roles',
    'gallery',
    'favorites',
    'comments',
    'messages'
  ];

  let visible = $derived(appState.adminPanelVisible);
  let selfRole = $derived(appState.selfRole);

  let statsLoading = $state(false);
  let collectionLoading = $state(false);
  let error = $state('');
  let stats = $state(null);
  let selectedCollection = $state('users');
  let collectionData = $state({ documents: [], total: 0, collection: 'users' });

  $effect(() => {
    if (visible && selfRole >= 9) {
      void loadStats();
      void loadCollection(selectedCollection);
    }
  });

  function hide() {
    appState.adminPanelVisible = false;
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  async function fetchAdmin(path) {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Request failed');
    }
    return data;
  }

  async function loadStats() {
    statsLoading = true;
    error = '';
    try {
      stats = await fetchAdmin('/api/admin/stats');
    } catch (err) {
      error = err?.message || 'Failed to load stats';
    } finally {
      statsLoading = false;
    }
  }

  async function loadCollection(collectionName) {
    collectionLoading = true;
    error = '';
    try {
      collectionData = await fetchAdmin(`/api/admin/collections/${encodeURIComponent(collectionName)}?limit=25`);
    } catch (err) {
      error = err?.message || 'Failed to load collection';
    } finally {
      collectionLoading = false;
    }
  }

  function chooseCollection(name) {
    selectedCollection = name;
    void loadCollection(name);
  }

  function formatValue(value) {
    if (value == null) return 'null';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  }

  function getDocLabel(doc) {
    if (!doc || typeof doc !== 'object') return 'Document';
    return (
      doc.username ||
      doc.ownerUsername ||
      doc.targetName ||
      doc.registeredName ||
      doc.name ||
      doc.roomId ||
      doc._id ||
      'Document'
    );
  }

  $effect(() => {
    function onKeydown(event) {
      if (event.key === 'Escape' && appState.adminPanelVisible) {
        hide();
      }
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });
</script>

{#if visible && selfRole >= 9}
  <div class="admin-overlay" onclick={(e) => e.target === e.currentTarget && hide()}>
    <div class="admin-dialog">
      <div class="admin-header">
        <div>
          <h3>Admin Panel</h3>
          <p>Deity-only server overview and database browser.</p>
        </div>
        <button class="admin-close" onclick={hide} title="Close">&times;</button>
      </div>

      {#if error}
        <div class="admin-error">{error}</div>
      {/if}

      <div class="admin-body">
        <section class="admin-section">
          <div class="section-head">
            <h4>Server Stats</h4>
            <button class="btn secondary small" type="button" onclick={() => void loadStats()}>
              {statsLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <div class="stats-grid">
            <div class="stat-card">
              <span class="stat-label">Active Users</span>
              <strong>{stats?.activeUsers ?? '—'}</strong>
            </div>
            <div class="stat-card">
              <span class="stat-label">Active Rooms</span>
              <strong>{stats?.activeRooms ?? '—'}</strong>
            </div>
            <div class="stat-card">
              <span class="stat-label">Registered Users</span>
              <strong>{stats?.registeredUsers ?? '—'}</strong>
            </div>
            <div class="stat-card">
              <span class="stat-label">DB Status</span>
              <strong>{stats?.dbAvailable ? 'Connected' : 'Unavailable'}</strong>
            </div>
          </div>

          {#if stats?.rooms?.length}
            <div class="table-wrap compact">
              <table class="admin-table">
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Users</th>
                    <th>Owner</th>
                    <th>Locked</th>
                  </tr>
                </thead>
                <tbody>
                  {#each stats.rooms as room}
                    <tr>
                      <td>{room.id}</td>
                      <td>{room.userCount}</td>
                      <td>{room.ownerUsername || '—'}</td>
                      <td>{room.locked ? 'Yes' : 'No'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

        <section class="admin-section grow">
          <div class="section-head">
            <h4>Collections</h4>
            <div class="collection-tabs">
              {#each COLLECTION_OPTIONS as collection}
                <button
                  class:active={selectedCollection === collection}
                  class="collection-tab"
                  type="button"
                  onclick={() => chooseCollection(collection)}
                >
                  {collection}
                </button>
              {/each}
            </div>
          </div>

          <div class="collection-meta">
            <span>{collectionLoading ? 'Loading…' : `${collectionData.total ?? 0} entries`}</span>
            <span>Showing latest 25</span>
          </div>

          <div class="doc-list">
            {#if collectionData.documents?.length}
              {#each collectionData.documents as doc}
                <details class="doc-card">
                  <summary>{getDocLabel(doc)}</summary>
                  <pre>{formatValue(doc)}</pre>
                </details>
              {/each}
            {:else}
              <div class="empty-state">{collectionLoading ? 'Loading collection...' : 'No documents found.'}</div>
            {/if}
          </div>
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .admin-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.82);
    z-index: 12000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    backdrop-filter: blur(4px);
  }

  .admin-dialog {
    width: min(1080px, 100%);
    height: 80vh;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: #242830;
    color: #f0f2f5;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    overflow: hidden;
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .admin-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.2rem;
    background: #2d323c;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .admin-header h3,
  .section-head h4 {
    margin: 0;
  }

  .admin-header p {
    margin: 0.2rem 0 0;
    color: #a8b0bf;
    font-size: 0.88rem;
  }

  .admin-close {
    background: transparent;
    border: none;
    color: inherit;
    font-size: 1.7rem;
    cursor: pointer;
    line-height: 1;
  }

  .admin-error {
    margin: 0.8rem 1.2rem 0;
    padding: 0.65rem 0.8rem;
    background: rgba(220, 80, 90, 0.14);
    border: 1px solid rgba(220, 80, 90, 0.28);
    border-radius: 6px;
    color: #ffb7bd;
    font-size: 0.88rem;
  }

  .admin-body {
    padding: 1rem 1.2rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .admin-section {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 0.85rem;
    min-height: 0;
  }

  .admin-section.grow {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.6rem;
  }

  .stat-card {
    background: #1b1f27;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 7px;
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .stat-label {
    color: #95a1b4;
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 7px;
    background: #1b1f27;
  }

  .admin-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }

  .admin-table th,
  .admin-table td {
    text-align: left;
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .admin-table th {
    font-size: 0.72rem;
    color: #95a1b4;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .collection-tabs {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .collection-tab {
    background: rgba(255, 255, 255, 0.04);
    color: #cfd6e3;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .collection-tab.active {
    background: rgba(0, 212, 170, 0.12);
    color: #90f0da;
    border-color: rgba(0, 212, 170, 0.3);
  }

  .collection-meta {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    color: #95a1b4;
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .doc-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding-right: 0.2rem;
  }

  .doc-card {
    background: #1b1f27;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 7px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .doc-card summary {
    cursor: pointer;
    padding: 0.6rem 0.75rem;
    font-size: 0.84rem;
    color: #f0f2f5;
  }

  .doc-card pre {
    margin: 0;
    padding: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    overflow: auto;
    font-size: 0.75rem;
    line-height: 1.4;
    color: #cfd6e3;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty-state {
    padding: 1rem;
    text-align: center;
    color: #a8b0bf;
    background: #1b1f27;
    border-radius: 7px;
  }

  @media (max-width: 820px) {
    .stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
