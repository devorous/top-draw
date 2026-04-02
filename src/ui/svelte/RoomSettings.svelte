<script>
  import { appState } from '../../state.svelte.js';
  import { T } from '../../../shared/MessageTypes.js';

  let { wsClient = null, board = null, ui = null, onUpdate = null, onUnregister = null } = $props();

  let roomId = $state('');
  let description = $state('');
  let ownerUsername = $state('');
  let backgroundColor = $state('#ffffff');
  let locked = $state(false);
  let maxUsers = $state(40);
  let modInactiveImmune = $state(false);
  let message = $state('');
  let messageType = $state('success');
  let showMessage = $state(false);
  let saving = $state(false);

  let visible = $derived(appState.roomSettingsVisible);
  let roomData = $derived(appState.currentRoomData);
  let userRole = $derived(appState.selfRole);
  let currentUsername = $derived(appState.username);

  // Update form when room data changes
  $effect(() => {
    if (visible && roomData) {
      loadRoomData(roomData);
    }
  });

  function loadRoomData(data) {
    roomId = data.id || '';
    description = data.description || '';
    ownerUsername = data.ownerUsername || 'Unregistered';
    locked = !!data.locked;
    maxUsers = data.maxUsers !== undefined ? data.maxUsers : 40;
    modInactiveImmune = !!data.modInactiveImmune;

    if (board) {
      const [r, g, b] = board.backgroundColor;
      backgroundColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }
  }

  function hide() {
    appState.roomSettingsVisible = false;
  }

  function displayMessage(text, type = 'success') {
    message = text;
    messageType = type;
    showMessage = true;
    setTimeout(() => { showMessage = false; }, 3000);
  }

  function save() {
    if (!roomData || !wsClient || saving) return;

    const trimmedDesc = description.trim();
    let clampedMaxUsers = Math.max(2, Math.min(60, maxUsers));
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
            modInactiveImmune
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
      roomModInactiveImmune: modInactiveImmune
    });
  }

  function confirmUnregister() {
    if (!roomData) return;

    const confirmed = confirm(
      `Are you sure you want to unregister "${roomData.id}"?\n\n` +
      `This will remove ownership and allow anyone to register the room.`
    );

    if (confirmed) {
      unregisterRoom();
    }
  }

  function unregisterRoom() {
    if (!roomData || !wsClient) return;

    wsClient.send({ t: T.ROOM_UNREGISTER });
    hide();

    if (onUnregister) {
      onUnregister();
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      hide();
    }
  }

  function canShowUnregister() {
    if (!roomData || !roomData.ownerId) return false;
    const isOwner = roomData.ownerUsername && currentUsername && roomData.ownerUsername === currentUsername;
    const isDeity = userRole >= 9;
    return isOwner || isDeity;
  }

  $effect(() => {
    function handleKeydown(e) {
      if (e.key === 'Escape' && appState.roomSettingsVisible) {
        hide();
      } else if (e.key === 'Enter' && e.ctrlKey && appState.roomSettingsVisible) {
        save();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if visible}
  <div
    class="room-settings-overlay"
    onclick={handleBackdropClick}
    role="presentation"
  >
    <div class="room-settings-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="room-settings-header">
        <h3>Room Settings</h3>
        <button
          class="room-settings-close"
          onclick={hide}
          title="Close"
        >&times;</button>
      </div>

      <div class="room-settings-body">
        {#if showMessage}
          <div class="room-settings-message {messageType}">
            {message}
          </div>
        {/if}

        <div class="form-group">
          <label for="roomId">Room ID</label>
          <input
            type="text"
            id="roomId"
            value={roomId}
            disabled
            class="room-input disabled"
          />
        </div>

        <div class="form-group">
          <label for="roomOwner">Owner</label>
          <input
            type="text"
            id="roomOwner"
            value={ownerUsername}
            disabled
            class="room-input disabled"
          />
        </div>

        <div class="form-group">
          <label for="roomDescription">Description</label>
          <textarea
            id="roomDescription"
            bind:value={description}
            class="room-textarea"
            placeholder="Room description..."
            rows="3"
          ></textarea>
        </div>

        <div class="form-group">
          <label for="roomBgColor">Background Color</label>
          <div class="color-input-group">
            <input
              type="color"
              id="roomBgColor"
              bind:value={backgroundColor}
              class="room-color-input"
            />
            <input
              type="text"
              value={backgroundColor}
              oninput={(e) => backgroundColor = e.target.value}
              class="room-input color-text"
            />
          </div>
        </div>

        <div class="form-group">
          <label for="roomMaxUsers">Max Users (2-60)</label>
          <input
            type="number"
            id="roomMaxUsers"
            bind:value={maxUsers}
            min="2"
            max="60"
            class="room-input"
          />
        </div>

        <div class="form-group checkbox-group">
          <label>
            <input
              type="checkbox"
              bind:checked={locked}
            />
            <span>Lock Room (prevent new users from joining)</span>
          </label>
        </div>

        <div class="form-group checkbox-group">
          <label>
            <input
              type="checkbox"
              bind:checked={modInactiveImmune}
            />
            <span>Moderators are immune to the inactivity timeout</span>
          </label>
        </div>
      </div>

      <div class="room-settings-footer">
        <button class="btn secondary" onclick={hide}>Cancel</button>
        {#if canShowUnregister()}
          <button class="btn danger" onclick={confirmUnregister}>
            Unregister
          </button>
        {/if}
        <button class="btn primary" onclick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
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
    animation: fadeIn 0.15s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .room-settings-dialog {
    background: #242830;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    max-width: 680px;
    width: 100%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease;
    font-family: 'Inter', -apple-system, sans-serif;
    color: #f0f2f5;
  }

  @keyframes slideUp {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .room-settings-header {
    padding: 1.25rem 1.5rem;
    background: #2d323c;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .room-settings-header h3 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 500;
  }

  .room-settings-close {
    background: none;
    border: none;
    color: #6b7280;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }
  .room-settings-close:hover {
    color: #f0f2f5;
    background: #363c4a;
  }

  .room-settings-body {
    padding: 1.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .room-settings-message {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }

  .room-settings-message.success {
    background: rgba(0, 212, 170, 0.15);
    border: 1px solid rgba(0, 212, 170, 0.3);
    color: #00f0c3;
  }

  .room-settings-message.error {
    background: rgba(224, 112, 112, 0.15);
    border: 1px solid rgba(224, 112, 112, 0.3);
    color: #e07070;
  }

  .form-group {
    margin-bottom: 1.25rem;
  }

  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    color: #a0a8b8;
  }

  .room-input,
  .room-textarea {
    width: 100%;
    padding: 0.625rem 0.875rem;
    background: #1a1d23;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    color: #f0f2f5;
    font-family: inherit;
    font-size: 0.875rem;
    transition: border-color 0.15s;
  }

  .room-input:focus,
  .room-textarea:focus {
    outline: none;
    border-color: rgba(0, 212, 170, 0.4);
  }

  .room-input.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .room-textarea {
    resize: vertical;
    min-height: 60px;
  }

  .color-input-group {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .room-color-input {
    width: 48px;
    height: 40px;
    padding: 4px;
    background: #1a1d23;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    cursor: pointer;
  }

  .color-text {
    flex: 1;
  }

  .checkbox-group label {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    cursor: pointer;
  }

  .checkbox-group input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
  }

  .checkbox-group span {
    font-size: 0.875rem;
    color: #a0a8b8;
  }

  .room-settings-footer {
    padding: 1rem 1.5rem;
    background: #2d323c;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .btn {
    padding: 0.625rem 1.25rem;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    border: none;
  }

  .btn.primary {
    background: #00d4aa;
    color: #121212;
  }
  .btn.primary:hover {
    background: #00f0c3;
  }

  .btn.secondary {
    background: rgba(255, 255, 255, 0.05);
    color: #a0a8b8;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .btn.secondary:hover {
    background: #363c4a;
    color: #f0f2f5;
    border-color: rgba(255, 255, 255, 0.12);
  }

  .btn.danger {
    background: rgba(224, 112, 112, 0.15);
    color: #e07070;
    border: 1px solid rgba(224, 112, 112, 0.3);
  }
  .btn.danger:hover {
    background: rgba(224, 112, 112, 0.25);
    border-color: rgba(224, 112, 112, 0.5);
  }
</style>
