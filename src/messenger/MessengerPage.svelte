<script>
  import { onMount } from 'svelte';
  import { ProfileDialog } from '../ui/ProfileDialog.js';
  import Messenger from './Messenger.svelte';

  function resolveMessengerApiBase() {
    const configured = (
      import.meta.env.VITE_MESSENGER_API_BASE_URL ||
      import.meta.env.VITE_API_BASE_URL ||
      ''
    ).trim().replace(/\/$/, '');

    const isLocalPage =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '0.0.0.0';

    if (isLocalPage) {
      const configuredIsLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(configured);
      if (!configured || configuredIsLocal) {
        return 'https://top-draw.koyeb.app';
      }
    }

    return configured;
  }

  const API_BASE = resolveMessengerApiBase();
  const TOKEN_KEY = 'topDrawAuthToken';
  const USERNAME_KEY = 'topDrawUsername';

  const profileDialog = new ProfileDialog({ apiBaseUrl: API_BASE });

  let user = $state(null);
  let authLoading = $state(false);
  let authError = $state(null);
  let showAuthModal = $state(false);
  let authMode = $state('login');
  let authForm = $state({ username: '', password: '', email: '' });

  onMount(() => {
    checkAuth();
  });

  async function checkAuth() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      user = null;
      return null;
    }

    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          user = { username: data.username, role: data.role, userId: data.userId };
          return user;
        }
      }
    } catch {
      // Silent fail
    }
    user = null;
    return null;
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    user = null;
  }

  function openAuthModal(mode = 'login') {
    authMode = mode;
    authForm = { username: '', password: '', email: '' };
    authError = null;
    showAuthModal = true;
  }

  function closeAuthModal() {
    showAuthModal = false;
    authForm = { username: '', password: '', email: '' };
    authError = null;
  }

  async function handleLogin() {
    if (authLoading) return;
    authError = null;

    if (!authForm.username || !authForm.password) {
      authError = 'Username and password required';
      return;
    }

    authLoading = true;
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authForm.username, password: authForm.password })
      });
      const data = await res.json();

      if (data.success) {
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(USERNAME_KEY, data.username);
        user = { username: data.username, role: data.role, userId: data.userId };
        closeAuthModal();
      } else {
        authError = data.error || 'Login failed';
      }
    } catch {
      authError = 'Connection error';
    } finally {
      authLoading = false;
    }
  }

  async function handleRegister() {
    if (authLoading) return;
    authError = null;

    if (!authForm.username || !authForm.password) {
      authError = 'Username and password required';
      return;
    }

    authLoading = true;
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: authForm.username,
          password: authForm.password,
          email: authForm.email || undefined
        })
      });
      const data = await res.json();

      if (data.success) {
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(USERNAME_KEY, data.username);
        user = { username: data.username, role: data.role, userId: data.userId };
        closeAuthModal();
      } else {
        authError = data.error || 'Registration failed';
      }
    } catch {
      authError = 'Connection error';
    } finally {
      authLoading = false;
    }
  }
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">

<div class="page">
  <nav>
    <a href="/" class="wordmark">DDraw!</a>
    <div class="nav-links">
      <a href="/gallery/" class="nav-link">gallery</a>
      <span class="nav-active">messenger</span>
      <a href="/go/" class="nav-cta" target="_blank">Draw Now! →</a>
      <span class="nav-divider">|</span>
      {#if user}
        <button class="btn-text" onclick={() => profileDialog.show(user.username)}>{user.username}</button>
        <button class="btn-text" onclick={logout}>logout</button>
      {:else}
        <button class="btn-text" onclick={() => openAuthModal('login')}>login</button>
        <button class="btn-text" onclick={() => openAuthModal('register')}>sign up</button>
      {/if}
    </div>
  </nav>

  <main class="messenger-container">
    {#if user}
      <Messenger initialTargetUser={null} username={user.username} />
    {:else}
      <div class="login-prompt">
        <div class="pitch-grid">
          <div class="pitch-copy">
            <h2>Private messages for the friends you draw with</h2>
            <ul class="pitch-features">
              <li>
                <span class="pitch-emoji">🔐</span>
                <div>
                  <strong>End-to-end encrypted</strong>
                  <p>Messages are sealed on your device. Our server relays them without ever being able to read them.</p>
                </div>
              </li>
              <li>
                <span class="pitch-emoji">🎨</span>
                <div>
                  <strong>Built into DDraw</strong>
                  <p>Message anyone you've drawn with and pick the conversation back up outside the room.</p>
                </div>
              </li>
              <li>
                <span class="pitch-emoji">🚫</span>
                <div>
                  <strong>No ads, no tracking</strong>
                  <p>It's just mail between artists. Nothing is read, mined, or sold.</p>
                </div>
              </li>
            </ul>
            <div class="pitch-actions">
              <button class="btn-primary" onclick={() => openAuthModal('login')}>Sign In</button>
              <button class="btn-secondary" onclick={() => openAuthModal('register')}>Create Account</button>
            </div>
            <p class="pitch-note">Accounts are free — a username and password is all it takes.</p>
          </div>

          <div class="pitch-preview" aria-hidden="true">
            <div class="fake-chat">
              <div class="fake-chat-header">
                <span class="fake-avatar">M</span>
                <span class="fake-name">moss</span>
                <span class="fake-lock" title="End-to-end encrypted">🔒</span>
              </div>
              <div class="fake-chat-body">
                <div class="bubble them">did you see ravi's dragon??</div>
                <div class="bubble me">SAW it. instant gallery heart</div>
                <div class="bubble them">lobby at 8 to finish the mural?</div>
                <div class="bubble me">bringing the confetti brush 🎉</div>
                <div class="bubble them typing"><span></span><span></span><span></span></div>
              </div>
              <div class="fake-chat-input">
                <span>Message moss…</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </main>
</div>

{#if showAuthModal}
  <div class="modal-overlay" onclick={closeAuthModal}>
    <div class="modal" onclick={(e) => e.stopPropagation()}>
      <div class="modal-header">
        <h2>{authMode === 'login' ? 'Sign In' : 'Create Account'}</h2>
        <button class="close-btn" onclick={closeAuthModal}>&times;</button>
      </div>
      <form onsubmit={(e) => { e.preventDefault(); authMode === 'login' ? handleLogin() : handleRegister(); }}>
        <div class="form-group">
          <label for="username">Username</label>
          <input
            id="username"
            type="text"
            bind:value={authForm.username}
            placeholder="Choose a username"
            autocomplete="username"
            disabled={authLoading}
          />
        </div>
        {#if authMode === 'register'}
          <div class="form-group">
            <label for="email">Email (optional)</label>
            <input
              id="email"
              type="email"
              bind:value={authForm.email}
              placeholder="your@email.com"
              autocomplete="email"
              disabled={authLoading}
            />
          </div>
        {/if}
        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            bind:value={authForm.password}
            placeholder="Choose a password"
            autocomplete={authMode === 'login' ? 'current-password' : 'new-password'}
            disabled={authLoading}
          />
        </div>
        {#if authError}
          <div class="error-msg">{authError}</div>
        {/if}
        <button type="submit" disabled={authLoading} class="btn-primary">
          {authLoading ? '...' : (authMode === 'login' ? 'Sign In' : 'Create Account')}
        </button>
      </form>
      <div class="auth-toggle">
        {#if authMode === 'login'}
          <p>Don't have an account? <button type="button" class="link-btn" onclick={() => openAuthModal('register')}>Sign up</button></p>
        {:else}
          <p>Already have an account? <button type="button" class="link-btn" onclick={() => openAuthModal('login')}>Sign in</button></p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style lang="scss">
  .page {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100%;
    background: var(--bg-primary, #0f1117);
    color: var(--text-primary, #f0f2f5);
    font-family: 'Inter', sans-serif;

    nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 2rem;
      border-bottom: 1px solid var(--border-subtle, #30363d);
      background: var(--bg-secondary, #0d1117);

      .wordmark {
        font-family: 'Fredoka', sans-serif;
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--accent, #00d4aa);
        text-decoration: none;
        letter-spacing: 0.01em;

        &:hover {
          text-decoration: underline;
        }
      }

      .nav-links {
        display: flex;
        align-items: center;
        gap: 1rem;

        .nav-link {
          color: var(--text-secondary, #8b949e);
          text-decoration: none;
          transition: color 0.2s;

          &:hover {
            color: var(--text-primary, #f0f2f5);
          }
        }

        .nav-active {
          color: var(--text-primary, #f0f2f5);
          font-weight: 500;
        }

        /* Pill CTA, matches gallery/landing "Draw Now!" */
        .nav-cta {
          background: var(--accent, #00d4aa);
          color: #000;
          text-decoration: none;
          font-weight: 700;
          padding: 0.5rem 1rem;
          border-radius: 50px;
          transition: transform 0.2s;

          &:hover {
            transform: translateY(-1px) scale(1.03);
          }
        }

        .nav-divider {
          color: var(--border-subtle, #30363d);
        }

        .btn-text {
          background: transparent;
          border: none;
          color: var(--text-secondary, #8b949e);
          cursor: pointer;
          transition: color 0.2s;
          padding: 0.25rem 0.5rem;

          &:hover {
            color: var(--text-primary, #f0f2f5);
          }
        }
      }
    }

    .messenger-container {
      flex: 1;
      overflow: hidden;
    }
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-secondary, #0d1117);
    border: 1px solid var(--border-subtle, #30363d);
    border-radius: 8px;
    padding: 2rem;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;

      h2 {
        margin: 0;
        font-size: 1.5rem;
      }

      .close-btn {
        background: transparent;
        border: none;
        color: var(--text-primary, #f0f2f5);
        font-size: 1.5rem;
        cursor: pointer;
        padding: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover {
          color: var(--accent, #00d4aa);
        }
      }
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;

      label {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-secondary, #8b949e);
      }

      input {
        padding: 0.75rem;
        background: var(--bg-primary, #0f1117);
        border: 1px solid var(--border-subtle, #30363d);
        border-radius: 6px;
        color: var(--text-primary, #f0f2f5);
        font-family: inherit;
        font-size: 0.95rem;
        transition: border-color 0.2s;

        &:focus {
          outline: none;
          border-color: var(--accent, #00d4aa);
        }

        &:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      }
    }

    .error-msg {
      color: #ff6b6b;
      font-size: 0.875rem;
      padding: 0.75rem;
      background: rgba(255, 107, 107, 0.1);
      border-radius: 4px;
    }

    .btn-primary {
      padding: 0.75rem;
      background: var(--accent, #00d4aa);
      color: #0f1117;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;

      &:hover:not(:disabled) {
        opacity: 0.9;
      }

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }

    .auth-toggle {
      text-align: center;
      margin-top: 1rem;
      font-size: 0.875rem;

      p {
        margin: 0;
        color: var(--text-secondary, #8b949e);
      }

      .link-btn {
        background: transparent;
        border: none;
        color: var(--accent, #00d4aa);
        cursor: pointer;
        text-decoration: underline;
        padding: 0;

        &:hover {
          opacity: 0.8;
        }
      }
    }
  }

  :global(html, body, #app) {
    height: 100%;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    overflow: hidden;
    background: var(--bg-primary, #0f1117);
  }

  :global(:root) {
    --bg-primary: #0f1117;
    --bg-secondary: #0d1117;
    --text-primary: #f0f2f5;
    --text-secondary: #8b949e;
    --border-subtle: #30363d;
    --accent: #00d4aa;
  }

  .login-prompt {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 2rem;

    .pitch-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
      gap: 3.5rem;
      align-items: center;
      max-width: 960px;
    }

    .pitch-copy {
      h2 {
        font-family: 'Fredoka', sans-serif;
        font-size: clamp(1.6rem, 3.5vw, 2.4rem);
        line-height: 1.15;
        margin: 0 0 1.75rem 0;
      }
    }

    .pitch-features {
      list-style: none;
      margin: 0 0 2rem 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 1.1rem;

      li {
        display: flex;
        gap: 0.85rem;
        align-items: flex-start;
      }

      .pitch-emoji {
        font-size: 1.3rem;
        line-height: 1.4;
      }

      strong {
        display: block;
        margin-bottom: 0.15rem;
      }

      p {
        margin: 0;
        font-size: 0.88rem;
        line-height: 1.45;
        color: var(--text-secondary, #8b949e);
        max-width: 42ch;
      }
    }

    .pitch-actions {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 0.85rem;
    }

    .btn-primary {
      padding: 0.75rem 1.5rem;
      background: var(--accent, #00d4aa);
      color: #0f1117;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;

      &:hover {
        opacity: 0.9;
      }
    }

    .btn-secondary {
      padding: 0.75rem 1.5rem;
      background: transparent;
      color: var(--accent, #00d4aa);
      border: 1.5px solid var(--accent, #00d4aa);
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;

      &:hover {
        background: rgba(0, 212, 170, 0.1);
      }
    }

    .pitch-note {
      margin: 0;
      font-size: 0.8rem;
      color: var(--text-secondary, #8b949e);
    }

    /* ── Decorative chat mockup ── */
    .pitch-preview {
      display: flex;
      justify-content: center;
    }

    .fake-chat {
      width: 100%;
      max-width: 340px;
      background: var(--bg-secondary, #161b22);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      border-radius: 14px;
      overflow: hidden;
      transform: rotate(2deg);
      box-shadow:
        14px 14px 0 rgba(0, 212, 170, 0.18),
        0 24px 48px rgba(0, 0, 0, 0.45);
    }

    .fake-chat-header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.7rem 0.9rem;
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));

      .fake-avatar {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--accent, #00d4aa);
        color: #0f1117;
        font-weight: 700;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.85rem;
      }

      .fake-name {
        font-weight: 600;
        flex: 1;
      }

      .fake-lock {
        font-size: 0.85rem;
        opacity: 0.75;
      }
    }

    .fake-chat-body {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 1rem 0.9rem;
    }

    .bubble {
      max-width: 78%;
      padding: 0.5rem 0.8rem;
      border-radius: 14px;
      font-size: 0.85rem;
      line-height: 1.35;

      &.them {
        align-self: flex-start;
        background: rgba(255, 255, 255, 0.07);
        border-bottom-left-radius: 4px;
      }

      &.me {
        align-self: flex-end;
        background: rgba(0, 212, 170, 0.22);
        border-bottom-right-radius: 4px;
      }

      &.typing {
        display: inline-flex;
        gap: 4px;
        padding: 0.65rem 0.8rem;

        span {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--text-secondary, #8b949e);
          animation: typing-bounce 1.2s infinite;

          &:nth-child(2) { animation-delay: 0.15s; }
          &:nth-child(3) { animation-delay: 0.3s; }
        }
      }
    }

    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
      30% { transform: translateY(-4px); opacity: 1; }
    }

    .fake-chat-input {
      margin: 0 0.9rem 0.9rem;
      padding: 0.55rem 0.85rem;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      border-radius: 999px;
      font-size: 0.82rem;
      color: var(--text-secondary, #8b949e);
    }

    @media (max-width: 820px) {
      .pitch-grid {
        grid-template-columns: 1fr;
        gap: 2.5rem;
      }

      .pitch-preview {
        order: -1;
      }

      .fake-chat {
        max-width: 300px;
      }
    }
  }
</style>
