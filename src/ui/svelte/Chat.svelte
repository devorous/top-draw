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

  // Toasts
  let toasts = $state([]);
  let toastIdCounter = 0;

  function showToast(username, message, color) {
    const id = ++toastIdCounter;
    const truncated = message.length > 80 ? message.slice(0, 80) + '...' : message;
    toasts = [...toasts, { id, username, message: truncated, color }];
    setTimeout(() => dismissToast(id), 4000);
    if (toasts.length > 3) {
      toasts = toasts.slice(toasts.length - 3);
    }
  }

  function dismissToast(id) {
    toasts = toasts.filter(t => t.id !== id);
  }

  function openFromToast(id) {
    dismissToast(id);
    show();
  }

  function addMessage(username, message, color, timestamp = Date.now()) {
    messages.all = [...messages.all, { username, message, color, timestamp }];
    if (!visible) {
      appState.chatUnreadCount++;
      showToast(username, message, color);
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

  function linkify(text) {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(
      /https?:\/\/[^\s<>"]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`
    );
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

  export function addSystemMessage(message) {
    addMessage('System', message, '#00d4aa'); // Using a teal system color
  }

  export function addChatDM(message, senderId, fromSelf) {
    addDMMessage(message, senderId, fromSelf);
  }

  // Auto-scroll
  let messagesEl = $state(null);
  let isAtBottom = true;

  function onMessagesScroll() {
    if (!messagesEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
  }

  $effect(() => {
    // Re-run when messages change
    messages.all.length;
    if (isAtBottom && messagesEl) {
      // Use microtask to let DOM update first
      Promise.resolve().then(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  });

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

{#if toasts.length > 0}
  <div class="chat-toasts">
    {#each toasts as toast (toast.id)}
      <button class="chat-toast" onclick={() => openFromToast(toast.id)}>
        <span class="chat-toast-username">{toast.username}:</span>
        <span class="chat-toast-message">{toast.message}</span>
      </button>
    {/each}
  </div>
{/if}

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

    <div class="chat-content" bind:this={messagesEl} onscroll={onMessagesScroll}>
      {#if currentTab === 'all'}
        <div class="chat-messages">
          {#each messages.all as msg}
            <div class="chat-message">
              <span class="chat-username">
                <span class="chat-user-dot" style="background: {msg.color}"></span>{msg.username}:
              </span>
              <span class="chat-text">{@html linkify(msg.message)}</span>
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
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    z-index: 1000;
    box-shadow: var(--shadow-lg);
    overflow: hidden;
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
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-subtle);
    cursor: move;
  }

  .chat-tabs {
    display: flex;
    gap: 0.5rem;
  }

  .chat-tab {
    padding: 0.375rem 0.875rem;
    background: none;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.8125rem;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .chat-tab:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .chat-tab.active {
    background: var(--bg-tertiary);
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .chat-close {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 1.5rem;
    line-height: 1;
    padding-bottom: 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
  }

  .chat-close:hover {
    background: #ff4d4d;
    color: white;
    border-color: #ff4d4d;
    transform: scale(1.1);
  }

  .chat-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    background: var(--bg-primary);
  }

  .chat-messages,
  .dm-messages {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .chat-message {
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }

  .chat-username {
    font-weight: 500;
    margin-right: 0.375rem;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .chat-user-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .chat-text {
    color: var(--text-primary);
  }

  .chat-time {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-left: 0.5rem;
  }

  :global(.chat-link) {
    color: var(--accent-primary);
    text-decoration: underline;
    word-break: break-all;
  }

  :global(.chat-link:hover) {
    color: var(--accent-hover);
  }

  .dm-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border-radius: var(--radius-md);
    margin-bottom: 0.75rem;
  }

  .dm-back {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0.25rem;
    transition: color var(--transition-fast);
  }

  .dm-back:hover {
    color: var(--accent-primary);
  }

  .dm-user-color {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }

  .dm-username {
    font-weight: 500;
    color: var(--text-primary);
  }

  .dm-message {
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border-radius: var(--radius-md) var(--radius-md) var(--radius-md) 2px;
    max-width: 80%;
    box-shadow: var(--shadow-sm);
  }

  .dm-message.self {
    background: var(--accent-primary);
    align-self: flex-end;
    border-radius: var(--radius-md) var(--radius-md) 2px var(--radius-md);
  }

  .dm-content {
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .dm-message.self .dm-content {
    color: var(--bg-primary);
  }

  .dm-time {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .dm-message.self .dm-time {
    color: rgba(0, 0, 0, 0.5);
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
    padding: 0.625rem 0.75rem;
    background: none;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    cursor: pointer;
    transition: background var(--transition-fast);
    width: 100%;
    text-align: left;
  }

  .dm-user-item:hover {
    background: var(--bg-tertiary);
  }

  .dm-user-name {
    font-size: 0.875rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  .dm-no-users {
    text-align: center;
    padding: 2rem;
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
  }

  .chat-input-container {
    display: flex;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
  }

  .chat-input {
    flex: 1;
    padding: 0.5rem 1rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-subtle);
    border-radius: 30px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.875rem;
    resize: none;
    max-height: 100px;
    outline: none;
  }

  .chat-input:focus {
    border-color: var(--accent-primary);
  }

  .chat-send {
    padding: 0.5rem 1.25rem;
    background: var(--accent-primary);
    border: none;
    border-radius: 30px;
    color: var(--bg-primary);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition-fast);
    white-space: nowrap;
  }

  .chat-send:hover {
    background: var(--accent-hover);
  }

  .chat-toasts {
    position: absolute;
    bottom: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    z-index: 1100;
    pointer-events: none;
  }

  .chat-toast {
    pointer-events: all;
    display: flex;
    gap: 0.375rem;
    align-items: baseline;
    padding: 0.6rem 0.9rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    font-size: 0.8125rem;
    cursor: pointer;
    max-width: 280px;
    text-align: left;
    color: var(--text-primary);
    transition: background var(--transition-fast), transform var(--transition-fast);
    animation: toast-in 0.2s ease;
  }

  .chat-toast:hover {
    background: var(--bg-tertiary);
    transform: translateY(-1px);
  }

  .chat-toast-username {
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
    color: var(--text-primary) !important;
  }

  .chat-toast-message {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
