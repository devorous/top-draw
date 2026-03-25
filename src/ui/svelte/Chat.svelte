<script>
  import { appState } from '../../state.svelte.js';

  let { onSend = null, onDM = null, onSendImage = null } = $props();

  let currentTab = $state('all');
  let messageInput = $state('');
  let messages = $state({
    all: [],
    dms: new Map()
  });

  let dragX = 0;
  let dragY = 0;
  let isDragging = $state(false);

  let visible = $derived(appState.chatVisible);
  let recipient = $derived(appState.dmRecipient);

  function show() {
    appState.chatVisible = true;
    appState.chatUnreadCount = 0;
  }

  function hide() {
    appState.chatVisible = false;
  }

  function switchTab(tab) {
    if (isDragging) return;
    currentTab = tab;
  }

  function selectDMRecipient(user) {
    appState.dmRecipient = user;
    currentTab = 'dm';
  }

  function backToDMList() {
    appState.dmRecipient = null;
  }

  function handleSend() {
    const msg = messageInput.trim();
    if (!msg) return;

    if (currentTab === 'all' && onSend) {
      onSend(msg);
    } else if (currentTab === 'dm' && recipient && onDM) {
      onDM(msg, recipient.id);
      addDMMessage(msg, recipient.id, true);
    }

    messageInput = '';
  }

  function addMessage(username, message, color, timestamp = Date.now()) {
    messages.all = [...messages.all, { username, message, color, timestamp }];
    if (!visible) {
      appState.chatUnreadCount++;
    }
  }

  function addDMMessage(message, userId, fromSelf = false) {
    const userMessages = messages.dms.get(userId) || [];
    userMessages.push({
      message,
      fromSelf,
      read: fromSelf,
      timestamp: Date.now()
    });
    messages.dms.set(userId, userMessages);
    messages.dms = new Map(messages.dms);
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Expose methods for App.js to call
  export function addChatMessage(username, message, color) {
    addMessage(username, message, color);
  }

  export function addChatDM(message, senderId, fromSelf) {
    addDMMessage(message, senderId, fromSelf);
  }

  // Make draggable
  let chatEl = $state(null);

  function startDrag(e) {
    if (e.target.closest('.chat-tabs') || e.target.closest('.chat-content')) {
      return;
    }
    isDragging = true;
    const rect = chatEl.getBoundingClientRect();
    dragX = e.clientX - rect.left;
    dragY = e.clientY - rect.top;
  }

  function onDrag(e) {
    if (!isDragging) return;
    const x = e.clientX - dragX;
    const y = e.clientY - dragY;
    chatEl.style.left = `${x}px`;
    chatEl.style.top = `${y}px`;
  }

  function endDrag() {
    isDragging = false;
  }

  $effect(() => {
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    return () => {
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', endDrag);
    };
  });
</script>

{#if visible}
  <div
    class="chat"
    class:dragging={isDragging}
    bind:this={chatEl}
    onmousedown={startDrag}
    role="presentation"
  >
    <div class="chat-header">
      <div class="chat-tabs">
        <button
          class="chat-tab"
          class:active={currentTab === 'all'}
          onclick={() => switchTab('all')}
        >All</button>
        <button
          class="chat-tab"
          class:active={currentTab === 'dm'}
          onclick={() => switchTab('dm')}
        >DM</button>
      </div>
      <button class="chat-close" onclick={hide}>&times;</button>
    </div>

    <div class="chat-content">
      {#if currentTab === 'all'}
        <div class="chat-messages">
          {#each messages.all as msg}
            <div class="chat-message">
              <span class="chat-username" style="color: {msg.color}">
                {msg.username}:
              </span>
              <span class="chat-text">{msg.message}</span>
              <span class="chat-time">{formatTime(msg.timestamp)}</span>
            </div>
          {/each}
        </div>
      {:else if recipient}
        <div class="dm-header">
          <button class="dm-back" onclick={backToDMList}>←</button>
          <div class="dm-user-color" style="background-color: {recipient.color}"></div>
          <span class="dm-username">{recipient.username}</span>
        </div>
        <div class="dm-messages">
          {#each (messages.dms.get(recipient.id) || []) as msg}
            <div class="dm-message" class:self={msg.fromSelf}>
              <div class="dm-content">{msg.message}</div>
              <div class="dm-time">{formatTime(msg.timestamp)}</div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="dm-user-list">
          {#if appState.users.size === 0}
            <div class="dm-no-users">No other users online</div>
          {:else}
            {#each [...appState.users.values()] as user}
              <button 
                class="dm-user-item" 
                onclick={() => selectDMRecipient(user)}
                onkeydown={(e) => e.key === 'Enter' && selectDMRecipient(user)}
              >
                <div class="dm-user-color" style="background-color: {user.color}"></div>
                <span class="dm-user-name">{user.username}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <div class="chat-input-container">
      <textarea
        class="chat-input"
        bind:value={messageInput}
        onkeydown={handleKeydown}
        placeholder={currentTab === 'all' ? 'Type a message...' : `Message ${recipient?.username || '...'}...`}
        rows="1"
      ></textarea>
      <button class="chat-send" onclick={handleSend}>Send</button>
    </div>
  </div>
{/if}

<style>
  .chat {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 360px;
    height: 480px;
    background: rgba(26, 26, 26, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    backdrop-filter: blur(12px);
    display: flex;
    flex-direction: column;
    z-index: 1000;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .chat.dragging {
    cursor: move;
    user-select: none;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    cursor: move;
  }

  .chat-tabs {
    display: flex;
    gap: 0.5rem;
  }

  .chat-tab {
    padding: 0.375rem 0.875rem;
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .chat-tab:hover {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.9);
  }

  .chat-tab.active {
    background: rgba(0, 212, 170, 0.15);
    border-color: rgba(0, 212, 170, 0.3);
    color: #00d4aa;
  }

  .chat-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.4);
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    width: 24px;
    height: 24px;
  }

  .chat-close:hover {
    color: #fff;
  }

  .chat-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
  }

  .chat-messages,
  .dm-messages {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .chat-message {
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .chat-username {
    font-weight: 500;
    margin-right: 0.375rem;
  }

  .chat-text {
    color: rgba(255, 255, 255, 0.9);
  }

  .chat-time {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.3);
    margin-left: 0.5rem;
  }

  .dm-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
    margin-bottom: 0.75rem;
  }

  .dm-back {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0.25rem;
  }

  .dm-user-color {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }

  .dm-username {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
  }

  .dm-message {
    padding: 0.5rem 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    max-width: 80%;
  }

  .dm-message.self {
    background: rgba(0, 212, 170, 0.15);
    align-self: flex-end;
  }

  .dm-content {
    font-size: 0.875rem;
    color: rgba(255, 255, 255, 0.9);
  }

  .dm-time {
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 0.25rem;
  }

  .dm-user-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .dm-user-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .dm-user-item:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .dm-user-name {
    font-size: 0.875rem;
    color: rgba(255, 255, 255, 0.9);
  }

  .dm-no-users {
    text-align: center;
    padding: 2rem;
    color: rgba(255, 255, 255, 0.3);
    font-size: 0.875rem;
  }

  .chat-input-container {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .chat-input {
    flex: 1;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    color: #e8e2d5;
    font-family: inherit;
    font-size: 0.875rem;
    resize: none;
    max-height: 100px;
  }

  .chat-input:focus {
    outline: none;
    border-color: rgba(0, 212, 170, 0.4);
  }

  .chat-send {
    padding: 0.5rem 1rem;
    background: #00d4aa;
    border: none;
    border-radius: 4px;
    color: #121212;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .chat-send:hover {
    background: #00f0c3;
  }
</style>
