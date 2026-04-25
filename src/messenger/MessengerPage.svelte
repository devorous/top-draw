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
    <a href="/" class="wordmark">DDraw</a>
    <div class="nav-links">
      <a href="/gallery/" class="nav-link">gallery</a>
      <span class="nav-active">messenger</span>
      <a href="/go/" class="nav-cta" target="_blank">draw →</a>
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
        <div class="prompt-content">
          <div class="icon">🔒</div>
          <h3>Sign in to use Messenger</h3>
          <p>You need a registered account to send and receive messages.</p>
          <button class="btn-primary" onclick={() => openAuthModal('login')}>Sign In</button>
          <p class="signup-text">Don't have an account? <button class="link-btn" onclick={() => openAuthModal('register')}>Create one</button></p>
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

        .nav-cta {
          color: var(--accent, #00d4aa);
          text-decoration: none;
          font-weight: 600;
          transition: opacity 0.2s;

          &:hover {
            opacity: 0.8;
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

    .prompt-content {
      text-align: center;
      max-width: 400px;

      .icon {
        font-size: 3rem;
        margin-bottom: 1rem;
      }

      h3 {
        margin: 0 0 0.5rem 0;
        font-size: 1.5rem;
      }

      p {
        margin: 0 0 1.5rem 0;
        color: var(--text-secondary, #8b949e);
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
        margin-bottom: 1rem;

        &:hover {
          opacity: 0.9;
        }
      }

      .signup-text {
        font-size: 0.875rem;
        color: var(--text-secondary, #8b949e);

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
  }
</style>
