<script>
  import { appState } from '../../state.svelte.js';
  import { T } from '../../../shared/MessageTypes.js';

  const TAB_GENERAL = 'general';
  const TAB_MODERATION = 'moderation';
  const ROLE_OPTIONS = [
    { value: 0, label: 'None' },
    { value: 3, label: 'Helper' },
    { value: 4, label: 'Moderator' },
    { value: 5, label: 'Admin' }
  ];
  const JOIN_POLICY_OPTIONS = [
    { value: 'open', label: 'Open' },
    { value: 'registered', label: 'Registered Only' },
    { value: 'trusted', label: 'Trusted Only' }
  ];
  const ROLE_LABELS = {
    0: 'None',
    1: 'User',
    2: 'Trusted',
    3: 'Helper',
    4: 'Moderator',
    5: 'Admin',
    6: 'Owner',
    7: 'Noble',
    8: 'Holy',
    9: 'Deity'
  };

  let { wsClient = null, board = null, ui = null, onUpdate = null, onUnregister = null } = $props();

  let activeTab = $state(TAB_GENERAL);
  let roomId = $state('');
  let description = $state('');
  let ownerUsername = $state('');
  let backgroundColor = $state('#ffffff');
  let locked = $state(false);
  let maxUsers = $state(40);
  let modInactiveImmune = $state(false);
  let joinPolicy = $state('open');
  let autoMuteGuests = $state(false);
  let autoMuteVpnUsers = $state(false);
  let dedicatedReplayUser = $state('');
  let message = $state('');
  let messageType = $state('success');
  let showMessage = $state(false);
  let saving = $state(false);
  let unregistering = $state(false);
  let rosterLoading = $state(false);
  let roleSavingTarget = $state('');
  let rosterFilter = $state('');
  let pendingRoles = $state({});
  let offlinePromotionName = $state('');
  let offlinePromotionRole = $state(4);
  let showUnregisterConfirm = $state(false);

  let visible = $derived(appState.roomSettingsVisible);
  let roomData = $derived(appState.currentRoomData);
  let userRole = $derived(appState.selfRole);
  let currentUsername = $derived(appState.username);
  let users = $derived(appState.users);
  let roomRoster = $derived(roomData?.moderationRoster || []);

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  $effect(() => {
    if (visible && roomData) {
      loadRoomData(roomData);
    }
    if (!visible) {
      activeTab = TAB_GENERAL;
      roleSavingTarget = '';
      rosterFilter = '';
      pendingRoles = {};
      offlinePromotionName = '';
      offlinePromotionRole = 4;
      showUnregisterConfirm = false;
      unregistering = false;
    }
  });

  $effect(() => {
    if (visible && activeTab === TAB_MODERATION) {
      requestModerationRoster();
    }
  });

  function loadRoomData(data) {
    roomId = data.id || '';
    description = data.description || '';
    ownerUsername = data.ownerUsername || 'Unregistered';
    locked = !!data.locked;
    maxUsers = data.maxUsers !== undefined ? data.maxUsers : 40;
    modInactiveImmune = !!data.modInactiveImmune;
    joinPolicy = data.joinPolicy || 'open';
    autoMuteGuests = !!data.autoMuteGuests;
    autoMuteVpnUsers = !!data.autoMuteVpnUsers;
    dedicatedReplayUser = data.dedicatedReplayUser || '';

    if (board) {
      const [r, g, b] = board.backgroundColor;
      backgroundColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    syncPendingRoles(data.moderationRoster || []);
  }

  function syncPendingRoles(roster) {
    const next = {};
    for (const entry of roster) {
      next[entry.userId] = entry.role;
    }
    pendingRoles = next;
  }

  function requestModerationRoster(force = false) {
    if (!visible || !wsClient || rosterLoading) return;
    const loadedAt = roomData?.moderationRosterLoadedAt || 0;
    const isFresh = loadedAt > 0 && (Date.now() - loadedAt) < 15000;
    if (!force && isFresh) return;
    rosterLoading = true;
    wsClient.requestRoomRoleList?.();
    setTimeout(() => {
      rosterLoading = false;
    }, 600);
  }

  function hide() {
    appState.roomSettingsVisible = false;
  }

  function displayMessage(text, type = 'success') {
    message = text;
    messageType = type;
    showMessage = true;
    setTimeout(() => {
      showMessage = false;
    }, 3000);
  }

  function save() {
    if (!roomData || !wsClient || saving) return;

    const trimmedDesc = description.trim();
    const clampedMaxUsers = Math.max(2, Math.min(60, maxUsers));
    maxUsers = clampedMaxUsers;

    saving = true;
    showMessage = false;

    wsClient._roomSettingsResultHandler = (result) => {
      saving = false;
      if (result.success) {
        displayMessage('Settings saved!', 'success');
        ui?.showToast('Room settings saved', 2000);
        if (onUpdate) {
          onUpdate({
            ...roomData,
            description: trimmedDesc,
            backgroundColor,
            locked,
            maxUsers: clampedMaxUsers,
            modInactiveImmune,
            joinPolicy,
            autoMuteGuests,
            autoMuteVpnUsers
          });
        }
      } else {
        displayMessage(result.error || 'Failed to save settings', 'error');
      }
    };

    wsClient.send({
      t: T.ROOM_UPDATE,
      roomDescription: trimmedDesc,
      roomBackgroundColor: backgroundColor,
      roomLocked: locked,
      roomMaxUsers: clampedMaxUsers,
      roomModInactiveImmune: modInactiveImmune,
      roomJoinPolicy: joinPolicy,
      roomAutoMuteGuests: autoMuteGuests,
      roomAutoMuteVpnUsers: autoMuteVpnUsers,
      roomDedicatedReplayUser: dedicatedReplayUser.trim() || null
    });
  }

  function openUnregisterConfirm() {
    if (!roomData || unregistering) return;
    showUnregisterConfirm = true;
  }

  function closeUnregisterConfirm() {
    if (unregistering) return;
    showUnregisterConfirm = false;
  }

  function unregisterRoom() {
    if (!roomData || !wsClient || unregistering) return;
    unregistering = true;
    wsClient.send({ t: T.ROOM_UNREGISTER });
    showUnregisterConfirm = false;
    hide();
    if (onUnregister) onUnregister();
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) hide();
  }

  function canShowUnregister() {
    if (!roomData || !roomData.ownerId) return false;
    const isOwner = roomData.ownerUsername && currentUsername && roomData.ownerUsername === currentUsername;
    const isDeity = userRole >= 9;
    return isOwner || isDeity;
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || `Role ${role}`;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    return dateFormatter.format(new Date(timestamp));
  }

  function lastUpdatedBy(entry) {
    if (entry.isOwner) return 'Ownership';
    return entry.updatedByUsername || 'Unknown';
  }

  function rosterUserIds() {
    return new Set(roomRoster.map(entry => entry.userId).filter(Boolean));
  }

  function buildOnlineCandidates() {
    const candidates = [];
    const existingIds = rosterUserIds();
    const existingNames = new Set(roomRoster.map(entry => entry.username?.toLowerCase()).filter(Boolean));

    users?.forEach((user, id) => {
      const username = user.registeredName || user.username || '';
      if (!username) return;
      if (existingIds.has(String(id)) || existingNames.has(username.toLowerCase())) return;
      candidates.push({
        id: String(id),
        username,
        role: user.role || 0
      });
    });

    if (appState.sessionIndex !== null && userRole >= 1) {
      const selfId = String(appState.sessionIndex);
      const username = currentUsername || '';
      if (
        username &&
        !candidates.some(candidate => candidate.id === selfId) &&
        !existingNames.has(username.toLowerCase())
      ) {
        candidates.push({
          id: selfId,
          username,
          role: userRole
        });
      }
    }

    return candidates.sort((a, b) => a.username.localeCompare(b.username));
  }

  function filterText() {
    return rosterFilter.trim().toLowerCase();
  }

  function filteredRoster() {
    const query = filterText();
    if (!query) return roomRoster;
    return roomRoster.filter(entry =>
      (entry.username || '').toLowerCase().includes(query) ||
      roleLabel(entry.role).toLowerCase().includes(query) ||
      (entry.updatedByUsername || '').toLowerCase().includes(query)
    );
  }

  function filteredOnlineCandidates() {
    const query = filterText();
    const candidates = buildOnlineCandidates();
    if (!query) return candidates;
    return candidates.filter(candidate =>
      candidate.username.toLowerCase().includes(query) ||
      roleLabel(candidate.role).toLowerCase().includes(query)
    );
  }

  function pendingRoleValue(targetId, fallbackRole) {
    return pendingRoles[targetId] ?? fallbackRole;
  }

  function setPendingRole(targetId, role) {
    pendingRoles = {
      ...pendingRoles,
      [targetId]: role
    };
  }

  function applyRoleChange(targetId, nextRole, options = {}) {
    if (!wsClient || roleSavingTarget) return;
    if (options.isOwner) {
      displayMessage('Room ownership controls the owner rank', 'error');
      return;
    }
    if (!targetId && !options.targetUsername) return;
    if ((options.currentRole ?? 0) === nextRole) return;

    const requestKey = String(targetId || `username:${options.targetUsername}`);
    roleSavingTarget = requestKey;
    wsClient._roomRoleSetResultHandler = (result) => {
      roleSavingTarget = '';
      if (result.success) {
        displayMessage('Moderation roster updated', 'success');
        ui?.showToast('Moderator role updated', 2000);
        if (roomData) {
          appState.currentRoomData = {
            ...roomData,
            moderationRosterLoadedAt: 0
          };
        }
        requestModerationRoster(true);
      } else {
        displayMessage(result.error || 'Failed to update room role', 'error');
      }
    };
    wsClient.sendRoomRoleSet(targetId, nextRole, options.targetUsername || '');
  }

  function applyOfflinePromotion() {
    const username = offlinePromotionName.trim();
    if (!username) {
      displayMessage('Enter a username to promote', 'error');
      return;
    }
    applyRoleChange('', Number(offlinePromotionRole), {
      currentRole: 0,
      targetUsername: username
    });
    offlinePromotionName = '';
  }

  $effect(() => {
    function handleKeydown(e) {
      if (e.key === 'Escape' && appState.roomSettingsVisible) {
        hide();
      } else if (e.key === 'Enter' && e.ctrlKey && appState.roomSettingsVisible && activeTab === TAB_GENERAL) {
        save();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if visible}
  <div class="room-settings-overlay" onclick={handleBackdropClick} role="presentation">
    <div
      class="room-settings-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div class="room-settings-header">
        <div class="room-settings-header-main">
          <h3>Room Settings</h3>
          <div class="room-settings-tabs" role="tablist" aria-label="Room settings sections">
            <button class:active={activeTab === TAB_GENERAL} class="room-settings-tab" onclick={() => activeTab = TAB_GENERAL} type="button">General</button>
            <button class:active={activeTab === TAB_MODERATION} class="room-settings-tab" onclick={() => activeTab = TAB_MODERATION} type="button">Moderation</button>
          </div>
        </div>
        <button class="room-settings-close" onclick={hide} title="Close">&times;</button>
      </div>

      <div class="room-settings-body">
        {#if showMessage}
          <div class="room-settings-message {messageType}">{message}</div>
        {/if}

        {#if activeTab === TAB_GENERAL}
          <div class="form-grid">
            <div class="form-group">
              <label for="roomId">Room ID</label>
              <input type="text" id="roomId" value={roomId} disabled class="room-input disabled" />
            </div>

            <div class="form-group">
              <label for="roomOwner">Owner</label>
              <input type="text" id="roomOwner" value={ownerUsername} disabled class="room-input disabled" />
            </div>
          </div>

          <div class="form-group">
            <label for="roomDescription">Description</label>
            <textarea id="roomDescription" bind:value={description} class="room-textarea" placeholder="Room description..." rows="3"></textarea>
          </div>

          <div class="form-grid">
            <div class="form-group">
              <label for="roomBgColor">Background Color</label>
              <div class="color-input-group">
                <input type="color" id="roomBgColor" bind:value={backgroundColor} class="room-color-input" />
                <input type="text" value={backgroundColor} oninput={(e) => backgroundColor = e.target.value} class="room-input color-text" />
              </div>
            </div>

            <div class="form-group">
              <label for="roomMaxUsers">Max Users (2-60)</label>
              <input type="number" id="roomMaxUsers" bind:value={maxUsers} min="2" max="60" class="room-input" />
            </div>
          </div>

          <div class="form-grid">
            <div class="form-group">
              <label for="roomJoinPolicy">Join Policy</label>
              <select id="roomJoinPolicy" bind:value={joinPolicy} class="room-input">
                {#each JOIN_POLICY_OPTIONS as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={locked} />
              <span>Lock Room (prevent new users from joining)</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={modInactiveImmune} />
              <span>Moderators are immune to the inactivity timeout</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={autoMuteGuests} />
              <span>Auto-mute unregistered guests until they log in</span>
            </label>
          </div>

          <div class="form-group checkbox-group">
            <label>
              <input type="checkbox" bind:checked={autoMuteVpnUsers} />
              <span>Auto-mute VPN or datacenter users by ASN (mods and above exempt)</span>
            </label>
          </div>

          <div class="form-group">
            <label for="roomReplayUploader">Replay uploader and Sync Master</label>
            <input
              type="text"
              id="roomReplayUploader"
              bind:value={dedicatedReplayUser}
              class="room-input"
              placeholder={roomData?.electedUploader ? `Auto: ${roomData.electedUploader}` : 'Auto-selected by server'}
              maxlength="20"
            />
            <span class="form-hint">
              Leave blank to let the server auto-elect the best candidate.
              {#if roomData?.electedUploader && !dedicatedReplayUser}
                Currently elected: <strong>{roomData.electedUploader}</strong>
              {/if}
            </span>
          </div>

          {#if canShowUnregister()}
            <section class="danger-zone">
              <div class="danger-zone-copy">
                <h4>Danger Zone</h4>
                <p>Unregistering removes ownership of this room and allows someone else to claim it.</p>
              </div>
              <button class="btn danger" type="button" onclick={openUnregisterConfirm} disabled={unregistering}>
                {unregistering ? 'Unregistering...' : 'Unregister Room'}
              </button>
            </section>
          {/if}
        {:else}
          <section class="moderation-panel">
            <div class="moderation-toolbar">
              <div>
                <h4>Room Staff</h4>
                <p>Search current moderators and apply rank changes inline.</p>
              </div>
              <div class="moderation-toolbar-actions">
                <input
                  type="text"
                  bind:value={rosterFilter}
                  class="room-input moderation-search"
                  placeholder="Search users, rank, or promoted by..."
                />
                <button class="btn secondary small" onclick={() => requestModerationRoster(true)} type="button">
                  {rosterLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            <div class="moderation-table-wrap">
              <table class="moderation-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Date</th>
                    <th>Promoted By</th>
                    <th>Rank</th>
                  </tr>
                </thead>
                <tbody>
                  {#if filteredRoster().length > 0}
                    {#each filteredRoster() as entry (entry.userId)}
                      <tr>
                        <td>
                          <div class="table-user-cell">
                            <strong>{entry.username}</strong>
                            {#if entry.isOwner}
                              <span class="table-subtle">Room owner</span>
                            {/if}
                          </div>
                        </td>
                        <td>{formatTimestamp(entry.updatedAt)}</td>
                        <td>{lastUpdatedBy(entry)}</td>
                        <td>
                          <div class="rank-action-cell">
                            <select
                              class="table-rank-select"
                              value={String(pendingRoleValue(entry.userId, entry.role))}
                              disabled={entry.isOwner || roleSavingTarget === entry.userId}
                              onchange={(e) => setPendingRole(entry.userId, Number(e.currentTarget.value))}
                            >
                              {#each ROLE_OPTIONS as option}
                                <option value={option.value}>{option.label}</option>
                              {/each}
                            </select>
                            <button
                              class="btn primary small"
                              type="button"
                              disabled={entry.isOwner || roleSavingTarget === entry.userId || pendingRoleValue(entry.userId, entry.role) === entry.role}
                              onclick={() => applyRoleChange(entry.userId, pendingRoleValue(entry.userId, entry.role), {
                                isOwner: entry.isOwner,
                                currentRole: entry.role
                              })}
                            >
                              {roleSavingTarget === entry.userId ? 'Applying...' : 'Apply'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    {/each}
                  {:else}
                    <tr>
                      <td colspan="4" class="table-empty">
                        {rosterLoading ? 'Loading moderator roster...' : 'No moderation matches found.'}
                      </td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </section>

          <section class="moderation-panel">
            <div class="moderation-split">
              <div class="subpanel">
                <h4>Online Members</h4>
                <p>Promote connected registered users directly from the room.</p>

                <div class="moderation-table-wrap">
                  <table class="moderation-table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Date</th>
                        <th>Promoted By</th>
                        <th>Rank</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#if filteredOnlineCandidates().length > 0}
                        {#each filteredOnlineCandidates() as candidate (candidate.id)}
                          <tr>
                            <td>
                              <div class="table-user-cell">
                                <strong>{candidate.username}</strong>
                                <span class="table-subtle">Current role: {roleLabel(candidate.role)}</span>
                              </div>
                            </td>
                            <td class="table-muted">Online now</td>
                            <td class="table-muted">Pending</td>
                            <td>
                              <div class="rank-action-cell">
                                <select
                                  class="table-rank-select"
                                  value={String(pendingRoleValue(candidate.id, 0))}
                                  disabled={roleSavingTarget === candidate.id}
                                  onchange={(e) => setPendingRole(candidate.id, Number(e.currentTarget.value))}
                                >
                                  {#each ROLE_OPTIONS as option}
                                    <option value={option.value}>{option.label}</option>
                                  {/each}
                                </select>
                                <button
                                  class="btn primary small"
                                  type="button"
                                  disabled={roleSavingTarget === candidate.id || pendingRoleValue(candidate.id, 0) === 0}
                                  onclick={() => applyRoleChange(candidate.id, pendingRoleValue(candidate.id, 0), {
                                    currentRole: 0
                                  })}
                                >
                                  {roleSavingTarget === candidate.id ? 'Applying...' : 'Apply'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        {/each}
                      {:else}
                        <tr>
                          <td colspan="4" class="table-empty">No additional registered members match this filter.</td>
                        </tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section class="moderation-panel compact-panel">
            <div class="offline-promo-row">
              <div class="offline-promo-copy">
                <h4>Offline Promotion</h4>
                <p>Assign a room role by username even if the user is not online.</p>
              </div>

              <input
                id="offlinePromotionName"
                type="text"
                bind:value={offlinePromotionName}
                class="room-input compact-input offline-name-input"
                placeholder="Exact username"
              />

              <select id="offlinePromotionRole" bind:value={offlinePromotionRole} class="room-input compact-input offline-role-select">
                {#each ROLE_OPTIONS as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>

              <button class="btn primary small" type="button" onclick={applyOfflinePromotion} disabled={roleSavingTarget.startsWith('username:')}>
                Apply
              </button>
            </div>
          </section>
        {/if}
      </div>

      <div class="room-settings-footer">
        <button class="btn secondary" onclick={hide}>Cancel</button>
        {#if activeTab === TAB_GENERAL}
          <button class="btn primary" onclick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        {/if}
      </div>

      {#if showUnregisterConfirm}
        <div class="dialog-confirm-backdrop" role="presentation">
          <div class="dialog-confirm" role="alertdialog" aria-modal="true" aria-labelledby="unregisterTitle">
            <h4 id="unregisterTitle">Unregister This Room?</h4>
            <p><strong>{roomId}</strong> will lose its owner and become claimable by anyone.</p>
            <p>This does not delete the room, but it does remove your ownership protection.</p>
            <div class="dialog-confirm-actions">
              <button class="btn secondary" type="button" onclick={closeUnregisterConfirm} disabled={unregistering}>Keep Registered</button>
              <button class="btn danger" type="button" onclick={unregisterRoom} disabled={unregistering}>
                {unregistering ? 'Unregistering...' : 'Yes, Unregister'}
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .room-settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    backdrop-filter: blur(4px);
  }

  .room-settings-dialog {
    background: #242830;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    max-width: 920px;
    width: 100%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    color: #f0f2f5;
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .room-settings-header {
    padding: 1.25rem 1.5rem 0;
    background: #2d323c;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .room-settings-header-main {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    min-width: 0;
    flex: 1;
  }

  .room-settings-header h3,
  .moderation-panel h4 {
    margin: 0;
  }

  .moderation-panel p {
    margin: 0.35rem 0 0;
    color: #a8b0bf;
    font-size: 0.92rem;
  }

  .room-settings-close {
    background: transparent;
    border: none;
    color: #f0f2f5;
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
  }

  .room-settings-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: -1px;
  }

  .room-settings-tab {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom: none;
    background: rgba(12, 15, 20, 0.4);
    color: #b4bece;
    padding: 0.7rem 1rem;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    font-weight: 600;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .room-settings-tab:hover {
    background: rgba(39, 45, 56, 0.85);
    color: #f0f2f5;
  }

  .room-settings-tab.active {
    background: #394252;
    border-color: rgba(140, 225, 205, 0.22);
    color: #fff;
  }

  .room-settings-body {
    padding: 1rem 1.1rem 1.1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .room-settings-message {
    padding: 0.8rem 1rem;
    border-radius: 6px;
  }

  .room-settings-message.success {
    background: rgba(80, 200, 120, 0.14);
    border: 1px solid rgba(80, 200, 120, 0.28);
    color: #aef0c2;
  }

  .room-settings-message.error {
    background: rgba(220, 80, 90, 0.14);
    border: 1px solid rgba(220, 80, 90, 0.28);
    color: #ffb7bd;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .form-group label {
    font-size: 0.84rem;
    color: #cfd6e3;
  }

  .form-hint {
    font-size: 0.76rem;
    color: #7a8494;
    line-height: 1.4;
  }

  .form-hint strong {
    color: #90f0da;
  }

  .room-input,
  .room-textarea,
  .table-rank-select {
    width: 100%;
    background: #1d2128;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    color: #f0f2f5;
    padding: 0.62rem 0.72rem;
    font: inherit;
  }

  .compact-input {
    padding: 0.5rem 0.65rem;
    font-size: 0.92rem;
  }

  .room-input.disabled {
    opacity: 0.75;
    cursor: not-allowed;
  }

  .room-textarea {
    resize: vertical;
    min-height: 72px;
  }

  .color-input-group {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 0.75rem;
  }

  .room-color-input {
    width: 100%;
    height: 46px;
    border: none;
    background: transparent;
    padding: 0;
  }

  .checkbox-group label {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.92rem;
  }

  .moderation-panel {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 0.8rem 0.9rem;
  }

  .compact-panel {
    padding: 0.7rem 0.9rem;
  }

  .danger-zone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1rem;
    border: 1px solid rgba(220, 80, 90, 0.28);
    border-radius: 10px;
    background: rgba(220, 80, 90, 0.08);
  }

  .danger-zone-copy h4 {
    margin: 0;
    color: #ffd7db;
  }

  .danger-zone-copy p {
    margin: 0.25rem 0 0;
    color: #f0b9c0;
    font-size: 0.86rem;
  }

  .moderation-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.65rem;
  }

  .moderation-toolbar-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .moderation-search {
    min-width: 220px;
    font-size: 0.84rem;
    padding: 0.45rem 0.6rem;
  }

  .moderation-table-wrap {
    overflow-x: auto;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    background: #1b1f27;
  }

  .moderation-table {
    width: 100%;
    border-collapse: collapse;
    min-width: 680px;
    font-size: 0.92rem;
  }

  .moderation-table th,
  .moderation-table td {
    text-align: left;
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    vertical-align: middle;
  }

  .moderation-table th {
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #95a1b4;
    background: rgba(255, 255, 255, 0.02);
  }

  .moderation-table tbody tr:last-child td {
    border-bottom: none;
  }

  .table-user-cell {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    line-height: 1.2;
  }

  .table-subtle,
  .table-muted {
    color: #9ea7b6;
    font-size: 0.77rem;
  }

  .table-empty {
    text-align: center;
    color: #a8b0bf;
  }

  .rank-action-cell {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .table-rank-select {
    min-width: 96px;
    max-width: 108px;
    padding: 0.38rem 0.48rem;
    font-size: 0.88rem;
  }

  .moderation-split {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .subpanel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .offline-promo-row {
    display: grid;
    grid-template-columns: minmax(180px, 1.2fr) minmax(170px, 1fr) 120px auto;
    gap: 0.55rem;
    align-items: end;
  }

  .offline-promo-copy h4 {
    margin: 0;
  }

  .offline-promo-copy p {
    margin: 0.18rem 0 0;
    font-size: 0.8rem;
  }

  .offline-name-input {
    min-width: 0;
  }

  .offline-role-select {
    min-width: 0;
  }

  .room-settings-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 0.8rem 1.1rem 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: #242830;
  }

  .dialog-confirm-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(10, 12, 16, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .dialog-confirm {
    width: min(100%, 420px);
    background: #1f232b;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1rem 1rem 0.95rem;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  }

  .dialog-confirm h4 {
    margin: 0 0 0.5rem;
  }

  .dialog-confirm p {
    margin: 0 0 0.55rem;
    color: #b8c0cd;
    line-height: 1.4;
  }

  .dialog-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.65rem;
    margin-top: 0.9rem;
  }

  .btn.small {
    padding: 0.42rem 0.68rem;
    font-size: 0.8rem;
  }

  @media (max-width: 860px) {
    .moderation-split,
    .form-grid,
    .moderation-toolbar {
      grid-template-columns: 1fr;
      display: grid;
    }

    .moderation-toolbar-actions {
      flex-direction: column;
      align-items: stretch;
    }

    .moderation-search {
      min-width: 0;
    }

    .offline-promo-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .danger-zone {
      flex-direction: column;
      align-items: stretch;
    }
  }

  @media (max-width: 700px) {
    .room-settings-dialog {
      max-height: 95vh;
    }

    .moderation-table {
      min-width: 560px;
    }

    .rank-action-cell {
      flex-direction: column;
      align-items: stretch;
    }

    .room-settings-footer {
      flex-wrap: wrap;
    }
  }
</style>
