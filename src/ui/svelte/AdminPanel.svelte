<script>
  import { appState } from '../../state.svelte.js';

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
  const TOKEN_KEY = 'topDrawAuthToken';
  const COLLECTION_OPTIONS = [
    'users',
    'rooms',
    'moderation',
    'connection_events',
    'gallery',
    'favorites',
    'comments',
    'messages'
  ];
  const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
  const SORT_OPTIONS = [
    { value: '_id', label: 'Inserted' },
    { value: 'createdAt', label: 'Created' },
    { value: 'updatedAt', label: 'Updated' },
    { value: 'lastActiveAt', label: 'Last active' },
    { value: 'lastLoginAt', label: 'Last login' },
    { value: 'timestamp', label: 'Timestamp' },
    { value: 'submittedAt', label: 'Submitted' },
    { value: 'username', label: 'Username' },
    { value: 'role', label: 'Role' },
    { value: 'likesCount', label: 'Likes' },
    { value: 'views', label: 'Views' }
  ];

  let visible = $derived(appState.adminPanelVisible);
  let selfRole = $derived(appState.selfRole);

  const TAB_STATS = 'stats';
  const TAB_MESSAGE = 'message';
  const TAB_LIVE = 'live';
  const TAB_DB = 'db';

  let backdropPointerDown = false;
  let activeTab = $state(TAB_MESSAGE);
  let statsLoading = $state(false);
  let collectionLoading = $state(false);
  let liveLoading = $state(false);
  let liveAutoRefresh = $state(null);
  let error = $state('');
  let stats = $state(null);
  let liveData = $state(null);
  let selectedCollection = $state('users');
  let collectionPage = $state(0);
  let collectionLimit = $state(25);
  let collectionSortBy = $state('_id');
  let collectionSortDir = $state('desc');
  let collectionData = $state({ documents: [], total: 0, collection: 'users', limit: 25, skip: 0 });
  let expandedDocId = $state('');
  let globalMessage = $state('');
  let globalPersistent = $state(false);
  let globalMessageStatus = $state('');
  let collectionPageCount = $derived(Math.max(1, Math.ceil((collectionData.total || 0) / collectionLimit)));
  let collectionStart = $derived((collectionData.total || 0) === 0 ? 0 : (collectionPage * collectionLimit) + 1);
  let collectionEnd = $derived(Math.min(collectionData.total || 0, (collectionPage + 1) * collectionLimit));
  let achievementMetrics = $derived([
    { key: 'distanceDrawn', label: 'Distance', format: formatDistance },
    { key: 'timeSpentMs', label: 'Time', format: formatDuration },
    { key: 'totalStrokes', label: 'Strokes', format: formatNumber },
    { key: 'chatMessagesSent', label: 'Messages', format: formatNumber }
  ]);

  $effect(() => {
    if (visible && selfRole >= 9) {
      void loadStats();
      void loadCollection(selectedCollection);
    }
    if (!visible) {
      clearInterval(liveAutoRefresh);
      liveAutoRefresh = null;
    }
  });

  $effect(() => {
    if (activeTab === TAB_LIVE && visible) {
      void loadLive();
      if (!liveAutoRefresh) {
        liveAutoRefresh = setInterval(() => void loadLive(), 15000);
      }
    } else {
      clearInterval(liveAutoRefresh);
      liveAutoRefresh = null;
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

  async function loadLive() {
    liveLoading = true;
    error = '';
    try {
      liveData = await fetchAdmin('/api/admin/live');
    } catch (err) {
      error = err?.message || 'Failed to load live state';
    } finally {
      liveLoading = false;
    }
  }

  async function loadCollection(collectionName) {
    collectionLoading = true;
    error = '';
    try {
      const params = new URLSearchParams({
        limit: String(collectionLimit),
        skip: String(collectionPage * collectionLimit),
        sortBy: collectionSortBy,
        sortDir: collectionSortDir
      });
      collectionData = await fetchAdmin(`/api/admin/collections/${encodeURIComponent(collectionName)}?${params}`);
    } catch (err) {
      error = err?.message || 'Failed to load collection';
    } finally {
      collectionLoading = false;
    }
  }

  function chooseCollection(name) {
    selectedCollection = name;
    collectionPage = 0;
    expandedDocId = '';
    void loadCollection(name);
  }

  function setCollectionPage(page) {
    collectionPage = Math.max(0, Math.min(page, collectionPageCount - 1));
    expandedDocId = '';
    void loadCollection(selectedCollection);
  }

  function setCollectionLimit(value) {
    collectionLimit = Number(value) || 25;
    collectionPage = 0;
    expandedDocId = '';
    void loadCollection(selectedCollection);
  }

  function setCollectionSort(field) {
    if (collectionSortBy === field) {
      collectionSortDir = collectionSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      collectionSortBy = field;
      collectionSortDir = field === 'username' ? 'asc' : 'desc';
    }
    collectionPage = 0;
    expandedDocId = '';
    void loadCollection(selectedCollection);
  }

  function sendGlobalMessage() {
    const message = globalMessage.trim();
    if (!message) {
      globalMessageStatus = 'Enter a message first.';
      return;
    }

    window.app?.wsClient?.sendGlobalMessage?.(message, {
      kind: 'staff',
      persistent: globalPersistent
    });
    globalMessage = '';
    globalMessageStatus = 'Global message sent.';
    setTimeout(() => {
      if (globalMessageStatus === 'Global message sent.') globalMessageStatus = '';
    }, 2500);
  }

  function formatValue(value) {
    if (value == null) return 'null';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function formatNumber(value) {
    return Math.round(Number(value) || 0).toLocaleString();
  }

  function formatDistance(value) {
    const px = Number(value) || 0;
    if (px >= 1_000_000) return `${(px / 1_000_000).toFixed(2)}M px`;
    if (px >= 1_000) return `${(px / 1_000).toFixed(1)}K px`;
    return `${Math.round(px).toLocaleString()} px`;
  }

  function formatDuration(value) {
    const minutes = Math.round((Number(value) || 0) / 60000);
    if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
    return `${minutes.toLocaleString()}m`;
  }

  function getBarWidth(value, rows) {
    const max = Math.max(1, ...(rows || []).map((row) => Number(row.value) || 0));
    return `${Math.max(3, Math.round(((Number(value) || 0) / max) * 100))}%`;
  }

  function formatBps(bps) {
    if (bps == null) return '—';
    if (bps >= 1_000_000) return `${(bps / 1_048_576).toFixed(2)} MB/s`;
    if (bps >= 1_000) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${bps} B/s`;
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

  function getDocId(doc) {
    return String(doc?._id || getDocLabel(doc));
  }

  function getDocTimestamp(doc) {
    return doc?.createdAt || doc?.updatedAt || doc?.lastActiveAt || doc?.lastLoginAt || doc?.submittedAt || doc?.timestamp || null;
  }

  function getDocSummary(doc) {
    if (!doc || typeof doc !== 'object') return '';
    const fields = ['type', 'roomId', 'room_id', 'ownerUsername', 'author', 'targetName', 'issuerName', 'email', 'role', 'likesCount', 'views'];
    return fields
      .filter((field) => doc[field] != null && doc[field] !== '')
      .slice(0, 4)
      .map((field) => `${field}: ${formatValue(doc[field]).replace(/\s+/g, ' ').slice(0, 80)}`)
      .join(' - ');
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

{#if visible && selfRole >= 8}
  <div
    class="admin-overlay"
    onpointerdown={(e) => { backdropPointerDown = e.target === e.currentTarget; }}
    onclick={(e) => {
      const downOnBackdrop = backdropPointerDown;
      backdropPointerDown = false;
      if (downOnBackdrop && e.target === e.currentTarget) hide();
    }}
    onkeydown={(e) => e.key === 'Escape' && hide()}
    role="button"
    tabindex="-1"
  >
    <div class="admin-dialog">
      <div class="admin-header">
        <div>
          <h3>Admin Panel</h3>
          <p>{selfRole >= 9 ? 'Server overview, database browser, and global messages.' : 'Holy global message controls.'}</p>
        </div>
        <button class="admin-close" onclick={hide} title="Close">&times;</button>
      </div>

      {#if error}
        <div class="admin-error">{error}</div>
      {/if}

      <div class="admin-tabs">
        <button class:active={activeTab === TAB_MESSAGE} onclick={() => activeTab = TAB_MESSAGE} type="button">Message</button>
        {#if selfRole >= 9}
          <button class:active={activeTab === TAB_STATS} onclick={() => activeTab = TAB_STATS} type="button">Stats</button>
          <button class:active={activeTab === TAB_LIVE}  onclick={() => activeTab = TAB_LIVE}  type="button">Live</button>
          <button class:active={activeTab === TAB_DB}    onclick={() => activeTab = TAB_DB}    type="button">Database</button>
        {/if}
      </div>

      <div class="admin-body">
        {#if activeTab === TAB_MESSAGE}
        <section class="admin-section">
          <div class="section-head">
            <h4>Global Message</h4>
            <button class="btn primary small" type="button" onclick={sendGlobalMessage}>Send</button>
          </div>
          <textarea
            class="global-message-input"
            bind:value={globalMessage}
            maxlength="500"
            placeholder="Message shown as a toast to everyone currently connected"
          ></textarea>
          <label class="global-message-option">
            <input type="checkbox" bind:checked={globalPersistent}>
            Longer display
          </label>
          <div class="collection-meta">
            <span>{globalMessage.length} / 500</span>
            <span>{globalMessageStatus}</span>
          </div>
        </section>
        {/if}

        {#if activeTab === TAB_STATS}
        <section class="admin-section stats-section">
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

          {#if stats?.achievements}
            <div class="achievement-grid">
              {#each achievementMetrics as metric}
                <div class="achievement-card">
                  <div class="achievement-head">
                    <span>{metric.label}</span>
                    <strong>{metric.format(stats.achievements.totals?.[metric.key])}</strong>
                  </div>
                  <div class="achievement-sub">Last 7 days: {metric.format(stats.achievements.weekTotals?.[metric.key])}</div>
                  <div class="mini-bars" aria-label={`${metric.label} last 7 days`}>
                    {#each stats.achievements.daily || [] as day}
                      <span
                        title={`${day.date}: ${metric.format(day[metric.key])}`}
                        style={`height:${getBarWidth(day[metric.key], (stats.achievements.daily || []).map((row) => ({ value: row[metric.key] })))};`}
                      ></span>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>

            <div class="achievement-leaders">
              {#each achievementMetrics as metric}
                <div class="leader-card">
                  <div class="leader-title">{metric.label} Leaders</div>
                  <div class="leader-columns">
                    <div>
                      <span class="leader-period">Lifetime</span>
                      {#each stats.achievements.top?.lifetime?.[metric.key] || [] as row}
                        <div class="leader-row">
                          <span>{row.username}</span>
                          <strong>{metric.format(row.value)}</strong>
                          <i style={`width:${getBarWidth(row.value, stats.achievements.top?.lifetime?.[metric.key])}`}></i>
                        </div>
                      {:else}
                        <div class="leader-empty">No data</div>
                      {/each}
                    </div>
                    <div>
                      <span class="leader-period">Last 7 Days</span>
                      {#each stats.achievements.top?.week?.[metric.key] || [] as row}
                        <div class="leader-row">
                          <span>{row.username}</span>
                          <strong>{metric.format(row.value)}</strong>
                          <i style={`width:${getBarWidth(row.value, stats.achievements.top?.week?.[metric.key])}`}></i>
                        </div>
                      {:else}
                        <div class="leader-empty">No data</div>
                      {/each}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {:else if !statsLoading}
            <div class="empty-state">Achievement metrics are not available from this server response yet.</div>
          {/if}

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
        {/if}

        {#if activeTab === TAB_LIVE}
        <section class="admin-section grow">
          <div class="section-head">
            <h4>Live Uploader Election</h4>
            <div style="display:flex;gap:0.5rem;align-items:center">
              <span style="font-size:0.76rem;color:var(--text-muted)">Auto-refreshes every 15s</span>
              <button class="btn secondary small" type="button" onclick={() => void loadLive()}>
                {liveLoading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
          </div>

          {#if !liveData?.rooms?.length}
            <div class="empty-state">{liveLoading ? 'Loading...' : 'No active rooms.'}</div>
          {:else}
            <div class="doc-list">
              {#each liveData.rooms as room}
                <div class="live-room-card">
                  <div class="live-room-head">
                    <span class="live-room-id">{room.id}</span>
                    <span class="live-room-meta">{room.userCount} user{room.userCount !== 1 ? 's' : ''}</span>
                    <span class="live-uploader-badge {room.dedicatedUploader ? 'pinned' : 'auto'}">
                      {#if room.dedicatedUploader}
                        📌 {room.dedicatedUploader}
                      {:else if room.electedUploader}
                        ⚡ {room.electedUploader}
                      {:else}
                        No uploader
                      {/if}
                    </span>
                  </div>
                  <div class="live-room-body">
                    {#if room.candidates?.length}
                      <div class="live-subsection">
                        <div class="live-subsection-label">Uploader Candidates</div>
                        <table class="admin-table">
                          <thead>
                            <tr>
                              <th>User</th>
                              <th>Upload</th>
                              <th>Ping</th>
                              <th>Score</th>
                              <th>Active</th>
                              <th>Low Power</th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each room.candidates as c}
                              <tr class:elected={c.username === (room.dedicatedUploader || room.electedUploader)}>
                                <td>{c.username}</td>
                                <td>{formatBps(c.uploadBps)}</td>
                                <td>{c.ping != null ? `${c.ping}ms` : '—'}</td>
                                <td>{c.score === -Infinity ? 'DQ' : c.score}</td>
                                <td>{c.active ? '✓' : '—'}</td>
                                <td>{c.lowPower ? '⚠️' : '—'}</td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                    {/if}

                    <div class="live-subsection">
                      <div class="live-subsection-label">Snapshots &amp; Checkpoints</div>
                      <div class="snap-grid">
                        <div class="snap-stat">
                          <span class="stat-label">In-memory snapshots</span>
                          <strong>{room.snapshots?.buffered ?? 0} / 60</strong>
                        </div>
                        <div class="snap-stat">
                          <span class="stat-label">DB checkpoints</span>
                          <strong>{room.dbCheckpoints ?? 0}</strong>
                        </div>
                        <div class="snap-stat">
                          <span class="stat-label">Oldest snapshot</span>
                          <strong>{room.snapshots?.oldest ? new Date(room.snapshots.oldest).toLocaleTimeString() : '—'}</strong>
                        </div>
                        <div class="snap-stat">
                          <span class="stat-label">Last checkpoint</span>
                          <strong>{room.snapshots?.lastCheckpointTs ? new Date(room.snapshots.lastCheckpointTs).toLocaleTimeString() : '—'}</strong>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
        {/if}

        {#if activeTab === TAB_DB}
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

          <div class="db-toolbar">
            <div class="db-controls">
              <label>
                <span>Rows</span>
                <select bind:value={collectionLimit} onchange={(e) => setCollectionLimit(e.currentTarget.value)}>
                  {#each PAGE_SIZE_OPTIONS as option}
                    <option value={option}>{option}</option>
                  {/each}
                </select>
              </label>
              <label>
                <span>Sort</span>
                <select value={collectionSortBy} onchange={(e) => setCollectionSort(e.currentTarget.value)}>
                  {#each SORT_OPTIONS as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </label>
              <button class="btn secondary small" type="button" onclick={() => setCollectionSort(collectionSortBy)}>
                {collectionSortDir === 'asc' ? 'Oldest first' : 'Newest first'}
              </button>
            </div>
            <button class="btn secondary small" type="button" onclick={() => void loadCollection(selectedCollection)}>
              {collectionLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <div class="collection-meta">
            <span>{collectionLoading ? 'Loading...' : `${collectionStart}-${collectionEnd} of ${collectionData.total ?? 0}`}</span>
            <span>Page {collectionPage + 1} / {collectionPageCount}</span>
          </div>

          <div class="table-wrap db-table-wrap">
            {#if collectionData.documents?.length}
              <table class="admin-table db-table" class:users-table={selectedCollection === 'users'}>
                <thead>
                  <tr>
                    <th>
                      <button type="button" onclick={() => setCollectionSort('_id')}>
                        Document {collectionSortBy === '_id' ? (collectionSortDir === 'asc' ? 'asc' : 'desc') : ''}
                      </button>
                    </th>
                    <th>
                      <button type="button" onclick={() => setCollectionSort('createdAt')}>
                        Date {collectionSortBy === 'createdAt' ? (collectionSortDir === 'asc' ? 'asc' : 'desc') : ''}
                      </button>
                    </th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {#each collectionData.documents as doc (getDocId(doc))}
                    <tr class:expanded={expandedDocId === getDocId(doc)}>
                      <td>
                        <button class="doc-row-button" type="button" onclick={() => expandedDocId = expandedDocId === getDocId(doc) ? '' : getDocId(doc)}>
                          <strong>{getDocLabel(doc)}</strong>
                          {#if selectedCollection !== 'users'}
                            <span>{doc?._id || ''}</span>
                          {/if}
                        </button>
                      </td>
                      <td>{formatDate(getDocTimestamp(doc))}</td>
                      <td>{getDocSummary(doc) || '-'}</td>
                    </tr>
                    {#if expandedDocId === getDocId(doc)}
                      <tr class="doc-json-row">
                        <td colspan="3"><pre>{formatValue(doc)}</pre></td>
                      </tr>
                    {/if}
                  {/each}
                </tbody>
              </table>
            {:else}
              <div class="empty-state">{collectionLoading ? 'Loading collection...' : 'No documents found.'}</div>
            {/if}
          </div>

          <div class="db-pager">
            <button class="btn secondary small" type="button" disabled={collectionPage === 0 || collectionLoading} onclick={() => setCollectionPage(0)}>First</button>
            <button class="btn secondary small" type="button" disabled={collectionPage === 0 || collectionLoading} onclick={() => setCollectionPage(collectionPage - 1)}>Previous</button>
            <button class="btn secondary small" type="button" disabled={collectionPage >= collectionPageCount - 1 || collectionLoading} onclick={() => setCollectionPage(collectionPage + 1)}>Next</button>
            <button class="btn secondary small" type="button" disabled={collectionPage >= collectionPageCount - 1 || collectionLoading} onclick={() => setCollectionPage(collectionPageCount - 1)}>Last</button>
          </div>
        </section>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .admin-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-tertiary);
    flex-shrink: 0;
  }

  .admin-tabs button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    padding: 0.65rem 1.1rem;
    font-size: 0.84rem;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .admin-tabs button.active {
    color: var(--accent-hover);
    border-bottom-color: var(--accent-primary);
  }

  .live-room-card {
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .live-room-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .live-room-id {
    font-weight: 600;
    font-size: 0.84rem;
  }

  .live-room-meta {
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  .live-uploader-badge {
    margin-left: auto;
    font-size: 0.78rem;
    padding: 0.2rem 0.55rem;
    border-radius: 4px;
  }

  .live-uploader-badge.auto {
    background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
    color: var(--accent-hover);
    border: 1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent);
  }

  .live-uploader-badge.pinned {
    background: rgba(255, 200, 80, 0.1);
    color: #ffd966;
    border: 1px solid rgba(255, 200, 80, 0.2);
  }

  .admin-table tr.elected td {
    background: color-mix(in srgb, var(--accent-primary) 6%, transparent);
  }

  .live-subsection {
    padding: 0.6rem 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--text-primary) 4%, transparent);
  }

  .live-subsection-label {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .snap-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.4rem;
  }

  .snap-stat {
    background: color-mix(in srgb, var(--text-primary) 4%, transparent);
    border-radius: 5px;
    padding: 0.4rem 0.5rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .snap-stat strong {
    display: block;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.2;
  }

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
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    overflow: hidden;
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .admin-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.2rem;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-subtle);
  }

  .admin-header h3,
  .section-head h4 {
    margin: 0;
  }

  .admin-header p {
    margin: 0.2rem 0 0;
    color: var(--text-secondary);
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
    background: color-mix(in srgb, var(--text-primary) 3%, transparent);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 0.85rem;
    min-height: 0;
  }

  .global-message-input {
    min-height: 120px;
    resize: vertical;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    padding: 0.75rem;
    font: inherit;
    line-height: 1.4;
  }

  .global-message-input:focus {
    outline: none;
    border-color: var(--border-active);
  }

  .global-message-option {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-secondary);
    font-size: 0.84rem;
  }

  .admin-section.grow {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .stats-section {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
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

  .achievement-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.6rem;
  }

  .achievement-card,
  .leader-card {
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    padding: 0.65rem 0.75rem;
  }

  .achievement-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.65rem;
  }

  .achievement-head span,
  .leader-period {
    color: var(--text-secondary);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .achievement-head strong {
    font-size: 1rem;
    font-weight: 650;
    color: var(--text-primary);
  }

  .achievement-sub {
    margin-top: 0.18rem;
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  .mini-bars {
    height: 44px;
    display: flex;
    align-items: flex-end;
    gap: 0.22rem;
    margin-top: 0.55rem;
  }

  .mini-bars span {
    flex: 1;
    min-height: 3px;
    border-radius: 3px 3px 0 0;
    background: linear-gradient(180deg, var(--accent-hover), var(--accent-secondary));
  }

  .achievement-leaders {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.6rem;
  }

  .leader-title {
    margin-bottom: 0.55rem;
    font-size: 0.86rem;
    font-weight: 650;
    color: var(--text-primary);
  }

  .leader-columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem;
  }

  .leader-row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.45rem;
    align-items: center;
    min-height: 24px;
    margin-top: 0.25rem;
    padding: 0.2rem 0.25rem;
    overflow: hidden;
    border-radius: 4px;
    background: color-mix(in srgb, var(--text-primary) 3%, transparent);
    font-size: 0.76rem;
  }

  .leader-row span,
  .leader-row strong {
    position: relative;
    z-index: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .leader-row strong {
    color: var(--text-secondary);
    font-weight: 600;
  }

  .leader-row i {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  }

  .leader-empty {
    margin-top: 0.35rem;
    color: var(--text-muted);
    font-size: 0.76rem;
  }

  .stat-card {
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .stat-label {
    color: var(--text-secondary);
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
    background: var(--bg-primary);
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
    border-bottom: 1px solid var(--border-subtle);
  }

  .admin-table th {
    font-size: 0.72rem;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .collection-tabs {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .collection-tab {
    background: color-mix(in srgb, var(--text-primary) 4%, transparent);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .collection-tab.active {
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
    color: var(--accent-hover);
    border-color: var(--accent-glow);
  }

  .collection-meta {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    color: var(--text-secondary);
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .db-toolbar,
  .db-controls,
  .db-pager {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
  }

  .db-toolbar {
    justify-content: space-between;
    flex-shrink: 0;
  }

  .db-controls label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .db-controls select {
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.36rem 0.5rem;
    font: inherit;
  }

  .db-table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .db-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-primary);
  }

  .db-table th button {
    appearance: none;
    background: transparent;
    border: 0;
    color: inherit;
    padding: 0;
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }

  .db-table td {
    vertical-align: top;
  }

  .db-table.users-table th,
  .db-table.users-table td {
    padding: 0.42rem 0.6rem;
  }

  .db-table tr.expanded td {
    background: color-mix(in srgb, var(--accent-primary) 6%, transparent);
  }

  .doc-row-button {
    display: block;
    width: 100%;
    max-width: 280px;
    padding: 0;
    text-align: left;
    background: transparent;
    border: 0;
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }

  .doc-row-button strong,
  .doc-row-button span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .doc-row-button span {
    color: var(--text-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem;
  }

  .doc-json-row pre {
    margin: 0;
    max-height: 360px;
    overflow: auto;
    font-size: 0.75rem;
    line-height: 1.4;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .db-pager {
    justify-content: flex-end;
    flex-shrink: 0;
  }

  .db-pager button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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

  .empty-state {
    padding: 1rem;
    text-align: center;
    color: var(--text-secondary);
    background: var(--bg-primary);
    border-radius: 7px;
  }

  @media (max-width: 820px) {
    .stats-grid,
    .achievement-grid,
    .achievement-leaders,
    .leader-columns {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 560px) {
    .stats-grid,
    .achievement-grid,
    .achievement-leaders,
    .leader-columns {
      grid-template-columns: 1fr;
    }
  }
</style>
