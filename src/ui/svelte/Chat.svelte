<script>
  import { appState } from '../../state.svelte.js';

  const CHAT_MODE_STORAGE_KEY = 'topdraw-chat-mode';

  let { onSend = null, onDM = null, onSendImage = null } = $props();

  let activeView = $state('all');
  let messageInput = $state('');
  let chatMode = $state(loadChatMode());
  let messages = $state({
    all: [],
    dms: new Map()
  });
  let dmMeta = $state(new Map());
  let isDragging = $state(false);
  let chatEl = $state(null);
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  let visible = $derived(appState.chatVisible);
  let recipient = $derived.by(() => {
    const selected = appState.dmRecipient;
    if (!selected) return null;
    return getChatUser(selected.id) || selected;
  });

  let activeThreads = $derived.by(() => {
    const ids = new Set(messages.dms.keys());
    if (recipient?.id !== undefined && recipient?.id !== null) {
      ids.add(recipient.id);
    }

    return [...ids]
      .map((userId) => {
        const threadMessages = messages.dms.get(userId) || [];
        const lastMessage = threadMessages[threadMessages.length - 1];
        const user = getChatUser(userId);

        return {
          id: userId,
          user,
          lastMessage
        };
      })
      .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
  });

  let directoryUsers = $derived.by(() => {
    return [...appState.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  });

  let activeDMMessages = $derived.by(() => {
    if (!recipient?.id && recipient?.id !== 0) return [];
    return messages.dms.get(recipient.id) || [];
  });

  let groupedPublicMessages = $derived.by(() => {
    return messages.all.map((msg, index) => {
      const previous = messages.all[index - 1];
      const next = messages.all[index + 1];
      const groupedWithPrevious = Boolean(
        previous &&
        msg.type === 'message' &&
        previous.type === 'message' &&
        Number(previous.userId) === Number(msg.userId) &&
        msg.timestamp - previous.timestamp < 60_000
      );
      const groupedWithNext = Boolean(
        next &&
        msg.type === 'message' &&
        next.type === 'message' &&
        Number(next.userId) === Number(msg.userId) &&
        next.timestamp - msg.timestamp < 60_000
      );

      return {
        ...msg,
        groupedWithPrevious,
        groupedWithNext
      };
    });
  });

  let publicMessagesEl = $state(null);
  let dmMessagesEl = $state(null);

  // Toasts
  let toasts = $state([]);
  let toastIdCounter = 0;

  function loadChatMode() {
    try {
      return localStorage.getItem(CHAT_MODE_STORAGE_KEY) === 'full' ? 'full' : 'compact';
    } catch {
      return 'compact';
    }
  }

  function persistChatMode(mode) {
    try {
      localStorage.setItem(CHAT_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures.
    }
  }

  function show() {
    appState.chatVisible = true;
    appState.chatUnreadCount = 0;
  }

  function hide() {
    appState.chatVisible = false;
  }

  function toggleMode() {
    chatMode = chatMode === 'compact' ? 'full' : 'compact';
    persistChatMode(chatMode);
  }

  function showPublic() {
    activeView = 'all';
    appState.dmRecipient = null;
  }

  function showDirectory() {
    activeView = 'directory';
    appState.dmRecipient = null;
  }

  function selectDMRecipient(user) {
    rememberDMUser(user);
    appState.dmRecipient = user;
    activeView = 'dm';
    markThreadRead(user.id);
  }

  function openThreadById(userId) {
    const user = getChatUser(userId);
    if (user) {
      selectDMRecipient(user);
      return;
    }

    const cachedUser = dmMeta.get(userId);
    if (cachedUser) {
      selectDMRecipient(cachedUser);
    }
  }

  function handleSend() {
    const msg = messageInput.trim();
    if (!msg) return;

    if (activeView === 'all' && onSend) {
      onSend(msg);
    } else if (activeView === 'dm' && recipient && onDM) {
      onDM(msg, recipient.id);
      addDMMessage(msg, recipient.id, true);
    }

    messageInput = '';
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
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

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function getChatUser(userId) {
    if (userId === null || userId === undefined) return null;
    if (Number(userId) === Number(appState.sessionIndex) && window.app?.self) {
      return {
        id: userId,
        username: window.app.self.username || window.app.self.name || 'You',
        color: `rgba(${window.app.self.color[0]}, ${window.app.self.color[1]}, ${window.app.self.color[2]}, ${window.app.self.color[3] / 255})`,
        role: window.app.self.role || appState.selfRole || 0
      };
    }

    return appState.users.get(userId) || window.app?.users?.get(Number(userId)) || dmMeta.get(userId) || null;
  }

  function rememberDMUser(userOrId) {
    const user = typeof userOrId === 'object' ? userOrId : getChatUser(userOrId);
    if (!user?.id && user?.id !== 0) return;

    dmMeta.set(user.id, {
      id: user.id,
      username: user.username || user.name || `User ${user.id}`,
      color: user.color || '#6f86a3',
      role: user.role || 0,
      visibleIp: user.visibleIp || ''
    });
    dmMeta = new Map(dmMeta);
  }

  function getUnreadCount(userId) {
    const threadMessages = messages.dms.get(userId) || [];
    return threadMessages.filter((msg) => !msg.fromSelf && !msg.read).length;
  }

  function markThreadRead(userId) {
    const threadMessages = messages.dms.get(userId);
    if (!threadMessages?.length) return;

    let changed = false;
    threadMessages.forEach((msg) => {
      if (!msg.fromSelf && !msg.read) {
        msg.read = true;
        changed = true;
      }
    });

    if (changed) {
      messages.dms = new Map(messages.dms);
    }
  }

  function showToast(username, message, color) {
    const id = ++toastIdCounter;
    const truncated = message.length > 90 ? `${message.slice(0, 90)}...` : message;
    toasts = [...toasts, { id, username, message: truncated, color }];
    setTimeout(() => dismissToast(id), 4000);
    if (toasts.length > 3) {
      toasts = toasts.slice(toasts.length - 3);
    }
  }

  function dismissToast(id) {
    toasts = toasts.filter((toast) => toast.id !== id);
  }

  function openFromToast(id) {
    dismissToast(id);
    show();
  }

  function addMessage(username, message, color, timestamp = Date.now(), userId = null, type = 'message') {
    messages.all = [...messages.all, { username, message, color, timestamp, userId, type }];
    if (!visible) {
      appState.chatUnreadCount++;
      showToast(username, message, color);
    }
  }

  function addDMMessage(message, userId, fromSelf = false) {
    rememberDMUser(userId);
    const threadMessages = messages.dms.get(userId) || [];
    const shouldRead = fromSelf || (visible && activeView === 'dm' && Number(recipient?.id) === Number(userId));

    threadMessages.push({
      message,
      fromSelf,
      read: shouldRead,
      timestamp: Date.now()
    });

    messages.dms.set(userId, threadMessages);
    messages.dms = new Map(messages.dms);

    if (!fromSelf && !visible) {
      appState.chatUnreadCount++;
      const user = getChatUser(userId);
      showToast(user?.username || 'DM', `[DM] ${message}`, user?.color || '#8ba3c7');
    }
  }

  function activeHeaderTitle() {
    if (activeView === 'all') return 'Public';
    if (activeView === 'directory') return 'Private messages';
    return recipient?.username || 'Direct message';
  }

  function activeHeaderSubtitle() {
    if (activeView === 'all') return '';
    if (activeView === 'directory') {
      return `${directoryUsers.length} online contact${directoryUsers.length === 1 ? '' : 's'}`;
    }
    return recipient ? 'Private conversation' : 'Select someone to message';
  }

  function formatModeratorMeta(user) {
    if (!user || appState.selfRole < 4) return '';
    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    const roleName = roleNames[user.role || 0] || 'Guest';
    return user.visibleIp ? `${roleName} | ${user.visibleIp}` : roleName;
  }

  function getRoleColor(userId) {
    const role = getChatUser(userId)?.role ?? 0;
    if (role >= 9) return 'var(--role-deity)';
    if (role === 8) return 'var(--role-holy)';
    if (role === 7) return 'var(--role-noble)';
    if (role >= 5) return 'var(--role-admin)';
    if (role === 4) return 'var(--role-mod)';
    if (role === 3) return 'var(--role-helper)';
    if (role >= 1) return 'var(--role-user)';
    return 'var(--role-guest)';
  }

  function openUserContextMenu(event, userId) {
    if (!window.app || userId === null || userId === undefined) return;

    if (Number(userId) === Number(appState.sessionIndex)) {
      window.app._showSelfContextMenu?.(event);
      return;
    }

    const user = window.app.users?.get(Number(userId)) || appState.users.get(userId);
    if (user) {
      window.app.moderation?.showContextMenu(event, Number(userId), user);
    }
  }

  function scrollToBottom(element) {
    if (!element) return;
    Promise.resolve().then(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  function startDrag(event) {
    if (event.target.closest('button, textarea, input, a')) return;
    if (!chatEl) return;

    const rect = chatEl.getBoundingClientRect();
    chatEl.style.left = `${rect.left}px`;
    chatEl.style.top = `${rect.top}px`;
    chatEl.style.right = 'auto';
    chatEl.style.bottom = 'auto';

    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    isDragging = true;
    event.preventDefault();
  }

  function onDrag(event) {
    if (!isDragging || !chatEl) return;

    const nextLeft = Math.max(8, Math.min(window.innerWidth - chatEl.offsetWidth - 8, event.clientX - dragOffsetX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - chatEl.offsetHeight - 8, event.clientY - dragOffsetY));

    chatEl.style.left = `${nextLeft}px`;
    chatEl.style.top = `${nextTop}px`;
  }

  function endDrag() {
    isDragging = false;
  }

  // Expose methods for App.js to call
  export function addChatMessage(username, message, color, userId = null) {
    addMessage(username, message, color, Date.now(), userId);
  }

  export function addSystemMessage(message) {
    addMessage('System', message, '#8fd8ff', Date.now(), null, 'system');
  }

  export function addChatDM(message, senderId, fromSelf) {
    rememberDMUser(senderId);
    addDMMessage(message, senderId, fromSelf);
  }

  $effect(() => {
    messages.all.length;
    if (visible && activeView === 'all') {
      scrollToBottom(publicMessagesEl);
    }
  });

  $effect(() => {
    activeView;
    recipient?.id;
    activeDMMessages.length;
    if (visible && activeView === 'dm' && recipient) {
      markThreadRead(recipient.id);
      scrollToBottom(dmMessagesEl);
    }
  });

  $effect(() => {
    if (visible) {
      appState.chatUnreadCount = 0;
    }
  });

  $effect(() => {
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);

    return () => {
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', endDrag);
    };
  });
</script>

{#if toasts.length > 0}
  <div class="chat-toasts">
    {#each toasts as toast (toast.id)}
      <button class="chat-toast" onclick={() => openFromToast(toast.id)}>
        <span class="chat-toast-swatch" style="background: {toast.color}"></span>
        <span class="chat-toast-copy">
          <span class="chat-toast-username">{toast.username}</span>
          <span class="chat-toast-message">{toast.message}</span>
        </span>
      </button>
    {/each}
  </div>
{/if}

{#if visible}
  <section class="chat-shell" class:full={chatMode === 'full'} class:compact={chatMode === 'compact'} class:dragging={isDragging} bind:this={chatEl}>
    <aside class="chat-rail">
      <button
        class="rail-tab public-tab"
        class:active={activeView === 'all'}
        onclick={showPublic}
        title="Public"
        type="button"
      >
        <span class="rail-tab-name">Public</span>
      </button>

      {#if activeThreads.length > 0}
        <div class="rail-section-label">DMs</div>
      {/if}

      <div class="rail-thread-list">
        {#each activeThreads as thread (thread.id)}
          <button
            class="rail-tab"
            class:active={activeView === 'dm' && Number(recipient?.id) === Number(thread.id)}
            onclick={() => openThreadById(thread.id)}
            title={thread.user?.username || 'Direct message'}
            type="button"
          >
            <span class="rail-avatar" style="--avatar-color: {thread.user?.color || '#6f86a3'}">
              {(thread.user?.username || '?').slice(0, 1).toUpperCase()}
            </span>
            <span class="rail-tab-name">{thread.user?.username || 'Unknown'}</span>
            {#if getUnreadCount(thread.id) > 0}
              <span class="rail-badge">{getUnreadCount(thread.id)}</span>
            {/if}
          </button>
        {/each}
      </div>

      <button
        class="rail-action"
        class:active={activeView === 'directory'}
        onclick={showDirectory}
        title="Start direct message"
        type="button"
      >
        <span>+</span>
        <span>new</span>
      </button>
    </aside>

    <div class="chat-main">
      <header class="chat-topbar" onmousedown={startDrag}>
        <div class="chat-topbar-copy">
          <p class="chat-kicker">{activeHeaderTitle()}</p>
          {#if activeHeaderSubtitle()}
            <span>{activeHeaderSubtitle()}</span>
          {/if}
        </div>

        <div class="chat-topbar-actions">
          <button class="topbar-btn" onclick={toggleMode} title={chatMode === 'full' ? 'Use compact mode' : 'Use full mode'} type="button">
            {chatMode === 'full' ? 'Small' : 'Full'}
          </button>
          <button class="topbar-btn close" onclick={hide} title="Close chat" type="button">X</button>
        </div>
      </header>

      <div class="chat-stage">
        {#if activeView === 'directory'}
          <section class="directory-view">
            <div class="directory-header">
              <h3>Start a private message</h3>
              <p>Pick someone from the room to open a direct thread.</p>
            </div>

            <div class="directory-list">
              {#if directoryUsers.length === 0}
                <div class="directory-empty">Nobody else is online right now.</div>
              {:else}
                {#each directoryUsers as user (user.id)}
                  <button
                    class="directory-user"
                    onclick={() => selectDMRecipient(user)}
                    oncontextmenu={(event) => openUserContextMenu(event, user.id)}
                    title={formatModeratorMeta(user)}
                    type="button"
                  >
                    <span class="directory-avatar" style="--avatar-color: {user.color}">
                      {user.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span class="directory-copy">
                      <strong>{user.username}</strong>
                      <small>{formatModeratorMeta(user) || 'Tap to open thread'}</small>
                    </span>
                    {#if getUnreadCount(user.id) > 0}
                      <span class="directory-badge">{getUnreadCount(user.id)}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          </section>
        {:else if activeView === 'dm' && recipient}
          <section class="conversation-view">
            <div class="message-stream dm-stream" bind:this={dmMessagesEl}>
              {#if activeDMMessages.length === 0}
                <div class="message-empty">This thread is empty. Say hi.</div>
              {:else}
                {#each activeDMMessages as msg}
                  <article class="dm-bubble-row" class:self={msg.fromSelf}>
                    <div class="dm-bubble">
                      <p>{msg.message}</p>
                      <span>{formatShortTime(msg.timestamp)}</span>
                    </div>
                  </article>
                {/each}
              {/if}
            </div>
          </section>
        {:else}
          <section class="conversation-view">
            <div class="message-stream" bind:this={publicMessagesEl}>
              {#if messages.all.length === 0}
                <div class="message-empty"></div>
              {:else}
                {#each groupedPublicMessages as msg}
                  <article
                    class="message-row"
                    class:system={msg.type === 'system'}
                    class:grouped={msg.groupedWithPrevious}
                    class:group-tail={!msg.groupedWithNext}
                  >
                    <span class="message-time">{msg.groupedWithPrevious ? '' : formatTime(msg.timestamp)}</span>
                    <div class="message-body">
                      {#if msg.type === 'system'}
                        <div class="system-pill">System</div>
                        <p class="message-text">{msg.message}</p>
                      {:else}
                        {#if !msg.groupedWithPrevious}
                          <button
                            class="message-user"
                            oncontextmenu={(event) => openUserContextMenu(event, msg.userId)}
                            title={msg.userId !== null ? formatModeratorMeta(getChatUser(msg.userId)) : ''}
                            type="button"
                            style="color: {getRoleColor(msg.userId)}"
                          >
                            {msg.username}
                          </button>
                        {/if}
                        <p class="message-text">{@html linkify(msg.message)}</p>
                      {/if}
                    </div>
                  </article>
                {/each}
              {/if}
            </div>
          </section>
        {/if}
      </div>

      <footer class="chat-composer">
        <textarea
          class="chat-input"
          bind:value={messageInput}
          onkeydown={handleKeydown}
          placeholder={activeView === 'all' ? 'Message the room...' : activeView === 'dm' && recipient ? `Message ${recipient.username}...` : 'Select someone to start a DM...'}
          rows="1"
          disabled={activeView === 'directory'}
        ></textarea>
        <button class="chat-send" onclick={handleSend} disabled={activeView === 'directory'} type="button">
          Send
        </button>
      </footer>
    </div>
  </section>
{/if}

<style>
  .chat-shell {
    --chat-bg:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 94%, black), color-mix(in srgb, var(--bg-primary) 96%, black));
    --chat-border: var(--border-subtle);
    --chat-text: var(--text-primary);
    --chat-muted: var(--text-secondary);
    --chat-accent: var(--accent-primary);
    --chat-shadow: var(--shadow-lg);
    position: fixed;
    right: 18px;
    bottom: 22px;
    z-index: 1200;
    display: grid;
    grid-template-columns: 116px minmax(0, 1fr);
    width: min(420px, calc(100vw - 24px));
    height: min(560px, calc(100vh - 110px));
    color: var(--chat-text);
    background: var(--chat-bg);
    border: 1px solid var(--chat-border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--chat-shadow);
    backdrop-filter: blur(18px);
  }

  .chat-shell.full {
    width: min(880px, calc(100vw - 44px));
    height: min(612px, calc(100vh - 56px));
  }

  .chat-shell.compact {
    width: min(420px, calc(100vw - 24px));
    grid-template-columns: 92px minmax(0, 1fr);
  }

  .chat-rail {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 12px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 92%, black), color-mix(in srgb, var(--bg-primary) 96%, black)),
      radial-gradient(circle at top, color-mix(in srgb, var(--accent-primary) 15%, transparent), transparent 52%);
    border-right: 1px solid var(--border-subtle);
  }

  .rail-tab,
  .rail-action,
  .topbar-btn,
  .inline-link,
  .directory-user,
  .chat-send,
  .chat-toast {
    border: 0;
    cursor: pointer;
  }

  .rail-section-label {
    padding: 0 0.35rem;
    color: color-mix(in srgb, var(--text-secondary) 70%, transparent);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .rail-thread-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow-y: auto;
  }

  .rail-tab,
  .rail-action {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0.7rem 0.5rem;
    background: transparent;
    color: var(--chat-muted);
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .rail-tab:hover,
  .rail-action:hover,
  .topbar-btn:hover,
  .directory-user:hover,
  .chat-send:hover,
  .chat-toast:hover {
    transform: translateY(-1px);
  }

  .rail-tab:hover,
  .rail-action:hover,
  .rail-tab.active,
  .rail-action.active {
    background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
    color: var(--chat-text);
  }

  .public-tab {
    justify-content: center;
    text-align: left;
    min-height: 46px;
    width: calc(100% + 24px);
    margin-left: -12px;
    padding-left: 12px;
    padding-right: 12px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .rail-avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 88%, white 12%);
    font-size: 1rem;
    font-weight: 800;
  }

  .rail-avatar,
  .directory-avatar {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--avatar-color) 78%, white), color-mix(in srgb, var(--avatar-color) 55%, black));
    color: white;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
  }

  .rail-tab-name {
    max-width: 100%;
    overflow: hidden;
    color: inherit;
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1.1;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rail-badge,
  .directory-badge {
    display: inline-flex;
    min-width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font-size: 0.68rem;
    font-weight: 800;
  }

  .rail-badge {
    position: absolute;
    top: 7px;
    right: 6px;
  }

  .chat-main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-width: 0;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent-primary) 8%, transparent), transparent 18%),
      linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 95%, black), color-mix(in srgb, var(--bg-primary) 98%, black));
  }

  .chat-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.7rem 1.15rem;
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-elevated) 50%, transparent);
    cursor: move;
  }

  .chat-topbar-copy {
    min-width: 0;
  }

  .chat-kicker {
    margin: 0.5rem 0 0.25rem;
    color: color-mix(in srgb, var(--accent-primary) 58%, var(--text-primary));
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-topbar-copy span {
    display: inline-block;
    margin-top: 0.1rem;
    color: var(--chat-muted);
    font-size: 0.8rem;
  }

  .chat-topbar-actions {
    display: flex;
    gap: 8px;
    align-self: center;
    margin-top: 0;
  }

  .chat-shell.dragging {
    user-select: none;
  }

  .topbar-btn {
    min-height: 36px;
    padding: 0 0.85rem;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--chat-text);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .topbar-btn.close {
    width: 36px;
    padding: 0;
  }

  .chat-stage {
    min-height: 0;
  }

  .conversation-view,
  .directory-view {
    display: grid;
    height: 100%;
    min-height: 0;
  }

  .directory-view {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .directory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.95rem 1.15rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    background: color-mix(in srgb, var(--bg-elevated) 32%, transparent);
  }

  .directory-header h3 {
    display: block;
    margin: 0;
    font-size: 0.95rem;
    font-weight: 800;
  }

  .directory-header p {
    display: block;
    margin: 0.18rem 0 0;
    color: var(--chat-muted);
    font-size: 0.76rem;
  }

  .inline-link {
    padding: 0;
    background: transparent;
    color: var(--chat-accent);
    font-size: 0.78rem;
    font-weight: 700;
  }

  .message-stream,
  .directory-list {
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.15rem 1.1rem;
  }

  .message-empty,
  .directory-empty {
    display: grid;
    place-items: center;
    min-height: 100%;
    color: var(--chat-muted);
    font-size: 0.86rem;
    text-align: center;
  }

  .message-row {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    gap: 0.9rem;
    padding: 0.38rem 0;
    border-bottom: 0;
  }

  .message-row.system {
    grid-template-columns: 58px minmax(0, 1fr);
  }

  .message-row.grouped {
    padding-top: 0.02rem;
    padding-bottom: 0.02rem;
  }

  .message-row.group-tail {
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 45%, transparent);
    padding-bottom: 0.38rem;
  }

  .message-row.group-tail:not(.grouped) {
    margin-bottom: 0.12rem;
  }

  .message-time {
    color: color-mix(in srgb, var(--text-secondary) 72%, transparent);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .message-row.grouped .message-time {
    opacity: 0;
    pointer-events: none;
  }

  .message-body {
    min-width: 0;
  }

  .message-user {
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: transparent;
    font-size: 0.88rem;
    font-weight: 800;
    border: 0;
    box-shadow: none;
    cursor: context-menu;
    line-height: 1.15;
  }

  .message-text {
    margin: 0.08rem 0 0;
    color: var(--text-primary);
    font-size: 0.9rem;
    line-height: 1.45;
    word-break: break-word;
  }

  .message-row.grouped .message-text {
    margin-top: 0;
  }

  .system-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.22rem 0.5rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
    color: color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary));
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .dm-stream {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .dm-bubble-row {
    display: flex;
  }

  .dm-bubble-row.self {
    justify-content: flex-end;
  }

  .dm-bubble {
    max-width: min(78%, 540px);
    padding: 0.8rem 0.9rem 0.7rem;
    border-radius: 18px 18px 18px 6px;
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
  }

  .dm-bubble-row.self .dm-bubble {
    border-radius: 18px 18px 6px 18px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 88%, white), color-mix(in srgb, var(--accent-secondary) 92%, black));
    color: var(--bg-primary);
  }

  .dm-bubble p {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.42;
    word-break: break-word;
  }

  .dm-bubble span {
    display: block;
    margin-top: 0.35rem;
    font-size: 0.7rem;
    color: color-mix(in srgb, var(--text-secondary) 68%, transparent);
  }

  .dm-bubble-row.self .dm-bubble span {
    color: color-mix(in srgb, var(--bg-primary) 58%, transparent);
  }

  .directory-list {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .directory-user {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    width: 100%;
    padding: 0.8rem 0.9rem;
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);
    color: var(--chat-text);
    text-align: left;
  }

  .directory-avatar {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 1rem;
    font-weight: 800;
    flex-shrink: 0;
  }

  .directory-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .directory-copy strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.92rem;
  }

  .directory-copy small {
    margin-top: 0.18rem;
    color: var(--chat-muted);
    font-size: 0.74rem;
  }

  .chat-composer {
    display: flex;
    gap: 0.8rem;
    padding: 1rem 1.15rem 1.1rem;
    border-top: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-secondary) 65%, transparent);
  }

  .chat-input {
    flex: 1;
    min-height: 46px;
    max-height: 120px;
    padding: 0.8rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-primary) 70%, transparent);
    color: var(--chat-text);
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.35;
    resize: none;
    outline: none;
  }

  .chat-input::placeholder {
    color: color-mix(in srgb, var(--text-secondary) 60%, transparent);
  }

  .chat-input:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .chat-input:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .chat-send {
    min-width: 82px;
    padding: 0 1.05rem;
    border-radius: 14px;
    background: linear-gradient(135deg, var(--accent-hover), var(--accent-primary));
    color: var(--bg-primary);
    font-size: 0.84rem;
    font-weight: 800;
  }

  .chat-send:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
  }

  .chat-toasts {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 1300;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    pointer-events: none;
  }

  .chat-toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 220px;
    max-width: 320px;
    padding: 0.8rem 0.9rem;
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    color: var(--chat-text);
    box-shadow: var(--shadow-lg);
  }

  .chat-toast-swatch {
    width: 10px;
    height: 40px;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .chat-toast-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.12rem;
  }

  .chat-toast-username {
    font-size: 0.82rem;
    font-weight: 800;
  }

  .chat-toast-message {
    overflow: hidden;
    color: var(--chat-muted);
    font-size: 0.76rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.chat-link) {
    color: var(--accent-primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
  }

  :global(.chat-link:hover) {
    color: var(--accent-hover);
  }

  @media (max-width: 900px) {
    .chat-shell.full,
    .chat-shell.compact {
      right: 12px;
      bottom: 12px;
      width: calc(100vw - 24px);
      height: min(76vh, 620px);
    }
  }

  @media (max-width: 640px) {
    .chat-shell,
    .chat-shell.full,
    .chat-shell.compact {
      right: 8px;
      bottom: 8px;
      width: calc(100vw - 16px);
      height: calc(100vh - 90px);
      border-radius: 18px;
      grid-template-columns: 84px minmax(0, 1fr);
    }

    .chat-topbar,
    .directory-header,
    .message-stream,
    .directory-list,
    .chat-composer {
      padding-left: 0.9rem;
      padding-right: 0.9rem;
    }

    .message-row {
      grid-template-columns: 50px minmax(0, 1fr);
      gap: 0.7rem;
    }

    .topbar-btn {
      min-width: 36px;
      padding: 0 0.72rem;
    }
  }
</style>
