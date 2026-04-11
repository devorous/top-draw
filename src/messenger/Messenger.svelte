<script>
  import { messenger } from './messenger.svelte.js';
  import { onMount, onDestroy, tick } from 'svelte';
  import { appState, toggleMessenger } from '../state.svelte.js';
  import { ProfileDialog } from '../ui/ProfileDialog.js';

  // Initialize profile dialog
  const profileDialog = new ProfileDialog();

  let { initialTargetUser = null, isFloating = false } = $props();
  let newMessageText = $state("");
  let searchQuery = $state("");
  let isStartingNewChat = $state(false);
  let newChatUsername = $state("");
  let newChatError = $state("");
  let initialized = $state(false);
  let usernameInput = $state();
  let messageFeed = $state();

  $effect(() => {
    if (isStartingNewChat && usernameInput) {
      usernameInput.focus();
    }
  });

  async function scrollChatToBottom() {
    if (!messageFeed) return;
    await tick();
    messageFeed.scrollTop = messageFeed.scrollHeight;
  }

  // Messenger should use the stable registered account name, not the room display name.
  const accountUsername = $derived(appState.self?.registeredName || appState.username);
  const activeMessengerIdentity = $derived(messenger.currentUserId || accountUsername);
  const isLoggedIn = $derived(!!accountUsername);

  $effect(() => {
    if (accountUsername && !initialized) {
      initialized = true;
      messenger.init(accountUsername, initialTargetUser);
    }
  });

  $effect(() => {
    const activeChatId = messenger.activeChat?.id;
    const messageCount = messenger.messages.length;
    if (!activeChatId && messageCount === 0) return;
    scrollChatToBottom();
  });

  onMount(() => {
    messenger.refreshOnOpen();
  });

  onDestroy(() => {
    messenger.cleanup();
    initialized = false;
  });

  const filteredInbox = $derived(() => {
    return messenger.inbox.filter(item => {
      const otherId = item.sender_id === activeMessengerIdentity ? item.receiver_id : item.sender_id;
      return otherId.toLowerCase().includes(searchQuery.toLowerCase());
    });
  });

  async function handleSend(event) {
    if (event) event.preventDefault();
    if (newMessageText.trim()) {
      await messenger.sendMessage(newMessageText);
      newMessageText = "";
    }
  }

  function startNewChat() {
    isStartingNewChat = true;
    messenger.activeChat = null;
  }

  async function handleCreateChat(event) {
    if (event) event.preventDefault();
    const username = newChatUsername.trim();
    if (!username) return;

    newChatError = "";
    // Open chat directly without checking if user exists (prevents username enumeration)
    messenger.openChat({ id: username, name: username });
    isStartingNewChat = false;
    newChatUsername = "";
  }

  function selectConversation(msg) {
    const otherId = msg.sender_id === activeMessengerIdentity ? msg.receiver_id : msg.sender_id;
    messenger.openChat({ id: otherId, name: otherId });
    isStartingNewChat = false;
  }

  function getOtherUserId(msg) {
    return msg.sender_id === activeMessengerIdentity ? msg.receiver_id : msg.sender_id;
  }
</script>

<div class="messenger-app" class:floating={isFloating}>
  <button class="global-close-btn" onclick={toggleMessenger} title="Close Messenger">&times;</button>

  {#if !isLoggedIn}
    <div class="no-selection" style="flex: 1;">
      <div class="icon">🔒</div>
      <h3>Sign in to use Messenger</h3>
      <p>You need a registered account to send and receive messages.</p>
    </div>
  {:else}

  <!-- Sidebar: Inbox / Conversation List (Always Visible) -->
  <aside class="sidebar">
    <header class="sidebar-header">
      <div class="top-bar">
        <h2>Inbox</h2>
        <div class="actions">
          <button class="icon-btn new-chat-btn" class:active={isStartingNewChat} onclick={startNewChat} title="New Message">+</button>
        </div>
      </div>
      <div class="search-bar">
        <input bind:value={searchQuery} placeholder="Search inbox..." />
      </div>
    </header>

    <div class="conversation-list">
      {#if messenger.inbox.length === 0}
        <p class="empty-state">No conversations yet.</p>
      {:else}
        {#each filteredInbox() as msg}
          <button 
            class="conversation-item" 
            class:active={!isStartingNewChat && getOtherUserId(msg) === messenger.activeChat?.id}
            onclick={() => selectConversation(msg)}
          >
            <div class="avatar">{getOtherUserId(msg)[0].toUpperCase()}</div>
            <div class="details">
              <div class="top-row">
                <span class="conv-name">{getOtherUserId(msg)}</span>
                <span class="date">{new Date(msg.timestamp).toLocaleDateString()}</span>
              </div>
              <div class="bottom-row">
                <p class="last-msg">
                  {#if msg.sender_id === activeMessengerIdentity}<span class="you-prefix">You:&nbsp;</span>{/if}{msg.content ?? '…'}
                </p>
                {#if messenger.unreadCounts[msg.room_id]}
                  <span class="unread-badge">{messenger.unreadCounts[msg.room_id] > 99 ? '99+' : messenger.unreadCounts[msg.room_id]}</span>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  <!-- Main: Right Pane (Toggles Content) -->
  <main class="chat-area">
    {#if isStartingNewChat}
      <div class="new-chat-view">
        <header class="chat-header">
          <h3>New Conversation</h3>
        </header>
        <div class="new-chat-content">
          <form onsubmit={handleCreateChat} class="compose-form">
            <div class="to-row">
              <label for="username">To:</label>
              <input
                id="username"
                bind:this={usernameInput}
                bind:value={newChatUsername}
                oninput={() => newChatError = ""}
                placeholder="Type a username..."
                autocomplete="off"
              />
            </div>
            <p class="hint">Starting a secure, end-to-end encrypted chat.</p>
            {#if newChatError}
              <p class="error-msg">{newChatError}</p>
            {/if}
            <button type="submit" class="primary-btn wide" disabled={!newChatUsername.trim()}>
              Start Chatting
            </button>
          </form>
          
          <div class="recent-users">
            <h4>Suggested</h4>
            <div class="user-chips">
              {#each [...appState.users.values()] as user}
                {#if user.username !== activeMessengerIdentity && user.registeredName !== activeMessengerIdentity}
                  <button class="user-chip" onclick={() => { messenger.openChat({ id: user.username, name: user.username }); isStartingNewChat = false; newChatUsername = ""; newChatError = ""; }}>
                    <div class="chip-color" style="background: {user.color}"></div>
                    {user.username}
                  </button>
                {/if}
              {/each}
              {#if appState.users.size <= 1}
                <p class="no-users">No other users online right now.</p>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {:else if messenger.activeChat}
      <header class="chat-header">
        <div class="user-info">
          <button class="username-btn" onclick={() => profileDialog.show(messenger.activeChat.name)}>
            {messenger.activeChat.name}
          </button>
        </div>
      </header>

      <div class="message-feed" bind:this={messageFeed}>
        {#each Object.entries(messenger.groupedMessages()) as [date, msgs]}
          <div class="date-divider"><span>{date}</span></div>
          {#each msgs as msg}
            <div class="message-wrapper" class:own={msg.sender_id === activeMessengerIdentity}>
              <div class="message">
                <p>{msg.content}</p>
                <span class="time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          {/each}
        {/each}
      </div>

      <form class="input-area" onsubmit={handleSend}>
        <input 
          bind:value={newMessageText} 
          placeholder="Message {messenger.activeChat.name}..." 
          disabled={!messenger.isConnected}
          autocomplete="off"
        />
        <button type="submit" disabled={!messenger.isConnected || !newMessageText.trim()}>
          Send
        </button>
      </form>
    {:else}
      <div class="no-selection">
        <div class="icon">💬</div>
        <h3>Your Messages</h3>
        <p>Select a user from the left or start a new conversation.</p>
        <button class="primary-btn wide" onclick={startNewChat}>New Message</button>
      </div>
    {/if}
  </main>
  {/if}
</div>

<style lang="scss">
  .messenger-app {
    display: flex;
    height: 100%;
    width: 100%;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: inherit;
    position: relative;
    
    &.floating {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 900px;
      height: 650px;
      max-width: 95vw;
      max-height: 85vh;
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      overflow: hidden;
      z-index: 1000;
      border: 1px solid var(--border-subtle);
    }

    .global-close-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 1.75rem;
      line-height: 1;
      padding: 0;
      cursor: pointer;
      z-index: 1010;
      transition: color var(--transition-fast);

      &:hover {
        color: white;
      }
    }
  }

  .sidebar {
    width: 320px;
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    flex-shrink: 0;

    .sidebar-header {
      padding: var(--space-4);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-subtle);

      .top-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--space-3);
        
        h2 { margin: 0; font-size: var(--text-xl); color: var(--text-primary); }
        
        .actions {
          display: flex;
          gap: var(--space-2);
          margin-right: 40px; 
        }

        .icon-btn {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--bg-elevated);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          font-size: 1.2rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all var(--transition-fast);
          
          &:hover { 
            background: var(--bg-tertiary); 
            color: var(--text-primary);
            border-color: var(--text-muted);
          }

          &.active {
            background: var(--accent-primary);
            color: var(--bg-primary);
            border-color: var(--accent-primary);
          }

          &.new-chat-btn {
            color: var(--accent-primary);
            &.active { color: var(--bg-primary); }
            &:hover:not(.active) { 
              background: var(--accent-primary); 
              color: var(--bg-primary); 
              border-color: var(--accent-primary);
            }
          }
        }
      }
      
      .search-bar input {
        width: 100%;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        color: var(--text-primary);
        outline: none;
        font-size: var(--text-sm);
        &:focus { border-color: var(--accent-primary); }
        &::placeholder { color: var(--text-muted); }
      }
    }

    .conversation-list {
      flex: 1;
      overflow-y: auto;
      
      .empty-state {
        text-align: center;
        padding: var(--space-10) var(--space-5);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
    }

    .conversation-item {
      width: 100%;
      display: flex;
      align-items: center;
      padding: var(--space-4);
      gap: var(--space-3);
      border: none;
      background: none;
      cursor: pointer;
      text-align: left;
      transition: background var(--transition-fast);
      border-bottom: 1px solid rgba(255, 255, 255, 0.03);

      &:hover { background: var(--bg-tertiary); }
      &.active { background: var(--bg-elevated); border-left: 3px solid var(--accent-primary); }

      .avatar {
        width: 44px;
        height: 44px;
        background: var(--accent-primary);
        color: var(--bg-primary);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        font-size: var(--text-lg);
        flex-shrink: 0;
      }

      .details {
        flex: 1;
        min-width: 0;
        
        .top-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: var(--space-1);
          .conv-name { font-weight: 600; color: var(--text-primary); font-size: var(--text-xl); }
          .date { font-size: var(--text-base); color: var(--text-muted); }
        }

        .bottom-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-width: 0;
        }

        .last-msg {
          margin: 0;
          font-size: var(--text-base);
          color: var(--text-secondary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;

          .you-prefix { color: var(--text-muted); }
        }

        .unread-badge {
          min-width: 22px;
          height: 22px;
          padding: 0 6px;
          border-radius: 999px;
          background: var(--accent-primary);
          color: var(--bg-primary);
          font-size: var(--text-xs);
          font-weight: 800;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          line-height: 1;
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--bg-secondary) 92%, black);
          flex-shrink: 0;
        }
      }
    }
  }

  .chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    min-width: 0;

    .new-chat-view {
      display: flex;
      flex-direction: column;
      height: 100%;

      .new-chat-content {
        padding: var(--space-8);
        max-width: 500px;
        margin: 0 auto;
        width: 100%;
        
        .compose-form {
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding-bottom: var(--space-8);
          border-bottom: 1px solid var(--border-subtle);

          .to-row {
            display: flex;
            align-items: center;
            gap: var(--space-4);
            
            label { color: var(--text-muted); font-weight: 600; font-size: var(--text-base); }
            input {
              flex: 1;
              background: none;
              border: none;
              border-bottom: 1px solid var(--border-subtle);
              color: var(--text-primary);
              padding: var(--space-2) 0;
              font-size: var(--text-lg);
              outline: none;
              &:focus { border-color: var(--accent-primary); }
            }
          }
          
          .hint { font-size: var(--text-xs); color: var(--text-muted); margin: 0; text-align: center; }
          .error-msg { font-size: var(--text-xs); color: #ff4d4d; margin: 0; text-align: center; }
        }

        .recent-users {
          margin-top: var(--space-8);
          h4 { margin: 0 0 var(--space-4) 0; color: var(--text-muted); text-transform: uppercase; font-size: var(--text-xs); letter-spacing: 1px; }
          .user-chips {
            display: flex;
            flex-wrap: wrap;
            gap: var(--space-3);
          }
          .user-chip {
            display: flex;
            align-items: center;
            gap: var(--space-2);
            padding: var(--space-2) var(--space-4);
            background: var(--bg-elevated);
            border: 1px solid var(--border-subtle);
            border-radius: 20px;
            color: var(--text-primary);
            font-size: var(--text-sm);
            cursor: pointer;
            transition: all var(--transition-fast);
            &:hover { border-color: var(--accent-primary); background: var(--bg-tertiary); }
            .chip-color { width: 10px; height: 10px; border-radius: 50%; }
          }
          .no-users { color: var(--text-muted); font-size: var(--text-sm); font-style: italic; }
        }
      }
    }

    .chat-header {
      padding: var(--space-4) var(--space-6);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      gap: var(--space-4);
      background: var(--bg-secondary);
      height: 64px;

      .username-btn {
        background: none;
        border: none;
        margin: 0;
        padding: 0;
        font-size: var(--text-lg);
        color: var(--text-primary);
        cursor: pointer;
        font-weight: 600;
        transition: color 0.15s ease;

        &:hover {
          color: var(--accent-primary);
        }
      }
    }

    .message-feed {
      flex: 1;
      overflow-y: auto;
      padding: var(--space-6);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      background: var(--bg-primary);
    }

    .date-divider {
      text-align: center;
      margin: var(--space-4) 0;
      position: relative;
      &::before {
        content: "";
        position: absolute;
        left: 0; top: 50%; width: 100%; height: 1px;
        background: var(--border-subtle);
        z-index: 1;
      }
      span {
        position: relative;
        z-index: 2;
        background: var(--bg-primary);
        padding: 0 var(--space-4);
        font-size: var(--text-xs);
        color: var(--text-muted);
      }
    }

    .message-wrapper {
      display: flex;
      &.own { 
        justify-content: flex-end; 
        .message { 
          background: var(--accent-primary); 
          color: var(--bg-primary); 
          border-radius: var(--radius-md) var(--radius-md) 2px var(--radius-md); 
          .time { color: rgba(0, 0, 0, 0.5); }
        } 
      }
      &:not(.own) { 
        justify-content: flex-start; 
        .message { 
          background: var(--bg-elevated); 
          color: var(--text-primary); 
          border-radius: var(--radius-md) var(--radius-md) var(--radius-md) 2px; 
          .time { color: var(--text-muted); }
        } 
      }
    }

    .message {
      max-width: 75%;
      padding: var(--space-3) var(--space-4);
      box-shadow: var(--shadow-sm);
      p { margin: 0; font-size: var(--text-base); line-height: 1.5; word-break: break-word; }
      .time { display: block; font-size: var(--text-xs); margin-top: var(--space-2); text-align: right; }
    }

    .input-area {
      padding: var(--space-4) var(--space-6);
      border-top: 1px solid var(--border-subtle);
      display: flex;
      gap: var(--space-4);
      background: var(--bg-secondary);

      input {
        flex: 1;
        padding: var(--space-3) var(--space-5);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        border-radius: 30px;
        color: var(--text-primary);
        outline: none;
        font-size: var(--text-base);
        &:focus { border-color: var(--accent-primary); }
      }

      button {
        padding: 0 var(--space-6);
        background: var(--accent-primary);
        color: var(--bg-primary);
        border: none;
        border-radius: 30px;
        font-weight: 600;
        cursor: pointer;
        font-size: var(--text-base);
        transition: background var(--transition-fast);
        &:hover:not(:disabled) { background: var(--accent-hover); }
        &:disabled { opacity: 0.5; cursor: not-allowed; }
      }
    }

    .no-selection {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      text-align: center;
      padding: var(--space-10);

      .icon { font-size: 5rem; margin-bottom: var(--space-6); opacity: 0.15; }
      h3 { color: var(--text-secondary); margin-bottom: var(--space-2); font-size: var(--text-xl); }
      p { max-width: 300px; margin-bottom: var(--space-6); }
    }
  }

  .primary-btn {
    padding: var(--space-3) var(--space-6);
    background: var(--accent-primary);
    color: var(--bg-primary);
    border: none;
    border-radius: var(--radius-md);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast);
    &:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); }
    &:active { transform: translateY(0); }
    &:disabled { opacity: 0.5; cursor: not-allowed; }
    
    &.wide { width: 200px; border-radius: 30px; }
  }

  @media (max-width: 768px) {
    .messenger-app.floating {
      width: 100%;
      height: 100%;
      top: 0; left: 0;
      transform: none;
      border-radius: 0;
    }
    /* Mobile-specific: allow one pane at a time if really needed, but here we favor two panes */
  }
</style>
