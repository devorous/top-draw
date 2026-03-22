<script>
  import { onMount } from 'svelte';
  import { ProfileDialog } from '../ui/ProfileDialog.js';

  // API base URL - defaults to relative (dev proxy) or can be set via env var for production
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

  const TOKEN_KEY = 'topDrawAuthToken';
  const USERNAME_KEY = 'topDrawUsername';

  // Track if lightbox was opened from a profile (to return to it)
  let openedFromProfile = null;
  let lightboxInstant = false; // Skip fade animation when opening from profile

  // Profile dialog instance
  const profileDialog = new ProfileDialog({
    apiBaseUrl: API_BASE,
    onViewGallery: (username) => {
      filterByAuthor(username);
    },
    onImageClick: (item) => {
      openedFromProfile = item.author;
      lightboxInstant = true;
      openLightbox(item);
    }
  });

  // Gallery state
  let items = [];
  let loading = true;
  let error = null;
  let page = 1;
  let totalPages = 1;
  let lightbox = null;
  let likedIds = new Set(JSON.parse(localStorage.getItem('ddraw_liked') || '[]'));
  let sort = 'newest'; // 'newest' | 'top' | 'views'
  let authorFilter = null; // username string or null
  let showFavorites = false; // viewing favorites mode
  let favoritedIds = new Set(); // ids user has favorited

  // Comments state
  let comments = [];
  let commentsLoading = false;
  let newComment = '';
  let commentSubmitting = false;

  // Auth state
  let user = null; // { username, role, userId }
  let authLoading = false;
  let authError = null;
  let showAuthModal = false;
  let authMode = 'login'; // 'login' | 'register'
  let authForm = { username: '', password: '', email: '' };

  async function fetchGallery() {
    loading = true;
    error = null;
    try {
      let url = `${API_BASE}/api/gallery?page=${page}&limit=24&sort=${sort}`;
      if (authorFilter) url += `&author=${encodeURIComponent(authorFilter)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      items = data.items;
      totalPages = data.pages;
    } catch (e) {
      error = 'Could not load gallery. Try again later.';
    } finally {
      loading = false;
    }
  }

  function setSort(newSort) {
    if (sort === newSort) return;
    sort = newSort;
    page = 1;
    fetchGallery();
  }

  function filterByAuthor(username) {
    authorFilter = username;
    page = 1;
    fetchGallery();
  }

  function clearAuthorFilter() {
    authorFilter = null;
    page = 1;
    fetchGallery();
  }

  async function downloadImage(url, filename) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename || url.split('/').pop() || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('Download failed:', err);
      // Fallback: open in new tab
      window.open(url, '_blank');
    }
  }

  async function fetchFavorites() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    loading = true;
    error = null;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/favorites?page=${page}&limit=24`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      items = data.items;
      totalPages = data.pages;
      // All items in favorites view are favorited
      favoritedIds = new Set(items.map(i => i.id));
    } catch (e) {
      error = 'Could not load favorites.';
    } finally {
      loading = false;
    }
  }

  function toggleFavoritesView() {
    showFavorites = !showFavorites;
    authorFilter = null;
    page = 1;
    if (showFavorites) {
      fetchFavorites();
    } else {
      fetchGallery();
    }
  }

  async function toggleFavorite(item) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || !user) return;

    const wasFavorited = favoritedIds.has(item.id);

    // Optimistic update
    if (wasFavorited) {
      favoritedIds.delete(item.id);
      // Remove from list if viewing favorites
      if (showFavorites) {
        items = items.filter(i => i.id !== item.id);
        // Close lightbox if this item was open
        if (lightbox?.id === item.id) {
          closeLightbox();
        }
      }
    } else {
      favoritedIds.add(item.id);
    }
    favoritedIds = favoritedIds;

    try {
      await fetch(`${API_BASE}/api/gallery/${item.id}/favorite`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch {
      // Revert on error
      if (wasFavorited) {
        favoritedIds.add(item.id);
        // Re-add to list if viewing favorites
        if (showFavorites) {
          items = [...items, item];
        }
      } else {
        favoritedIds.delete(item.id);
      }
      favoritedIds = favoritedIds;
    }
  }

  async function checkFavorite(id) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${id}/favorite`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.favorited) {
          favoritedIds.add(id);
          favoritedIds = favoritedIds;
        }
      }
    } catch {}
  }

  async function fetchComments(galleryId) {
    commentsLoading = true;
    comments = [];
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${galleryId}/comments`);
      if (res.ok) {
        const data = await res.json();
        comments = data.comments || [];
      }
    } catch {}
    commentsLoading = false;
  }

  async function submitComment() {
    if (!lightbox || !newComment.trim() || commentSubmitting) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    commentSubmitting = true;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/${lightbox.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text: newComment.trim() })
      });
      if (res.ok) {
        const comment = await res.json();
        comments = [...comments, comment];
        newComment = '';
      }
    } catch {}
    commentSubmitting = false;
  }

  async function deleteComment(commentId) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/comments/${commentId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        comments = comments.filter(c => c.id !== commentId);
      }
    } catch {}
  }

  async function deleteImage(item) {
    if (!confirm('Are you sure you want to delete this image? This cannot be undone.')) return;

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        // Remove from items list
        items = items.filter(i => i.id !== item.id);
        // Close lightbox
        closeLightbox();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete image');
      }
    } catch {
      alert('Failed to delete image');
    }
  }

  async function checkAuth() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          user = { username: data.username, role: data.role, userId: data.userId };
        }
      } else {
        // Token invalid, clear it
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
      }
    } catch {}
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

  async function like(item) {
    if (likedIds.has(item.id)) return;
    likedIds.add(item.id);
    likedIds = likedIds;
    localStorage.setItem('ddraw_liked', JSON.stringify([...likedIds]));
    item.likes = (item.likes || 0) + 1;
    items = items;

    try {
      await fetch(`${API_BASE}/api/gallery/${item.id}/like`, { method: 'POST' });
    } catch {}
  }

  function openLightbox(item) {
    lightbox = item;
    document.body.style.overflow = 'hidden';
    // Check if favorited when opening lightbox
    if (user && !favoritedIds.has(item.id)) {
      checkFavorite(item.id);
    }
    // Fetch comments
    fetchComments(item.id);
  }

  function closeLightbox() {
    const returnToProfile = openedFromProfile;
    openedFromProfile = null;
    lightboxInstant = false;

    // Open profile FIRST (instant, no fade) so backdrop stays visible
    if (returnToProfile) {
      profileDialog.show(returnToProfile, { instant: true });
    }

    // Then close lightbox
    lightbox = null;
    comments = [];
    newComment = '';

    if (!returnToProfile) {
      document.body.style.overflow = '';
    }
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      if (showAuthModal) closeAuthModal();
      else closeLightbox();
    }
    if (e.key === 'ArrowRight' && lightbox) {
      const idx = items.indexOf(lightbox);
      if (idx < items.length - 1) lightbox = items[idx + 1];
    }
    if (e.key === 'ArrowLeft' && lightbox) {
      const idx = items.indexOf(lightbox);
      if (idx > 0) lightbox = items[idx - 1];
    }
  }

  function formatDate(d) {
    return new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);

    // Handle ?id= to open specific image
    const itemId = params.get('id');
    if (itemId) {
      try {
        const res = await fetch(`${API_BASE}/api/gallery/${itemId}`);
        if (res.ok) {
          const item = await res.json();
          openLightbox(item);
        }
      } catch {}
      // Clear the param from URL without reload
      window.history.replaceState({}, '', '/gallery');
    }

    // Handle ?author= to filter by author
    const authorParam = params.get('author');
    if (authorParam) {
      authorFilter = authorParam;
    }
  }

  onMount(() => {
    checkAuth();
    checkUrlParams();
    fetchGallery();
  });
</script>

<svelte:window on:keydown={handleKeydown}/>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,400;0,600;1,300;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">

<div class="page">
  <nav>
    <a href="/" class="wordmark">ddraw</a>
    <div class="nav-links">
      <span class="nav-active">gallery</span>
      <a href="/go/" class="nav-cta">draw →</a>
      <span class="nav-divider">|</span>
      {#if user}
        <button class="btn-text" class:active={showFavorites} on:click={toggleFavoritesView}>favorites</button>
        <button class="nav-user" on:click={() => profileDialog.show(user.username)}>{user.username}</button>
        <button class="btn-text" on:click={logout}>logout</button>
      {:else}
        <button class="btn-text" on:click={() => openAuthModal('login')}>login</button>
      {/if}
    </div>
  </nav>

  <header>
    <div class="header-top">
      <div>
        <h1>{showFavorites ? 'My Favorites' : (authorFilter ? `${authorFilter}'s Art` : 'Gallery')}</h1>
        <p>
          {#if showFavorites}
            <button class="btn-link" on:click={toggleFavoritesView}>← back to all</button>
          {:else if authorFilter}
            <button class="btn-link" on:click={clearAuthorFilter}>← back to all</button>
          {:else}
            Artwork made by the ddraw community
          {/if}
        </p>
      </div>
      {#if !showFavorites}
        <div class="sort-controls">
          <button class="sort-btn" class:active={sort === 'newest'} on:click={() => setSort('newest')}>Newest</button>
          <button class="sort-btn" class:active={sort === 'top'} on:click={() => setSort('top')}>Top</button>
          <button class="sort-btn" class:active={sort === 'views'} on:click={() => setSort('views')}>Views</button>
        </div>
      {/if}
    </div>
  </header>

  <main>
    {#if loading}
      <div class="state-center">
        <div class="spinner"></div>
      </div>
    {:else if error}
      <div class="state-center">
        <p class="error-msg">{error}</p>
        <button class="btn-ghost" on:click={fetchGallery}>Retry</button>
      </div>
    {:else if items.length === 0}
      <div class="state-center empty">
        <div class="empty-icon">◻</div>
        <h2>Nothing here yet</h2>
        <p>Be the first to save something to the gallery.</p>
        <a href="/go/" class="btn-primary">Start Drawing</a>
      </div>
    {:else}
      <div class="grid">
        {#each items as item (item.id)}
          <button class="card" on:click={() => openLightbox(item)}>
            <div class="card-img">
              <img src={item.thumbUrl || item.url} alt={item.title || 'artwork'} loading="lazy">
            </div>
            <div class="card-meta">
              <button class="card-author" on:click|stopPropagation={() => profileDialog.show(item.author)}>{item.author}</button>
              <button
                class="like-btn"
                class:liked={likedIds.has(item.id)}
                on:click|stopPropagation={() => like(item)}
                aria-label="Like"
              >
                ♥ {item.likes || 0}
              </button>
            </div>
          </button>
        {/each}
      </div>

      {#if totalPages > 1}
        <div class="pagination">
          <button class="btn-ghost small" disabled={page <= 1} on:click={() => { page--; fetchGallery(); }}>← Prev</button>
          <span>{page} / {totalPages}</span>
          <button class="btn-ghost small" disabled={page >= totalPages} on:click={() => { page++; fetchGallery(); }}>Next →</button>
        </div>
      {/if}
    {/if}
  </main>

  <footer>
    <span>ddraw</span>
    <a href="/">← back to home</a>
  </footer>
</div>

{#if lightbox}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="lightbox-backdrop" class:instant={lightboxInstant} on:click={closeLightbox}>
    <div class="lightbox" on:click|stopPropagation>
      <button class="lb-close" on:click={closeLightbox}>×</button>
      <div class="lb-img-wrap">
        <img src={lightbox.url} alt={lightbox.title || 'artwork'}>
      </div>
      <div class="lb-info">
        {#if lightbox.title}
          <h3>{lightbox.title}</h3>
        {/if}
        <div class="lb-meta">
          <button class="lb-author" on:click={() => profileDialog.show(lightbox.author)}>by {lightbox.author}</button>
          <span class="lb-date">{formatDate(lightbox.createdAt)}</span>
        </div>
        <div class="lb-actions">
          <button
            class="like-btn large"
            class:liked={likedIds.has(lightbox.id)}
            on:click={() => like(lightbox)}
          >
            ♥ {lightbox.likes || 0}
          </button>
          {#if user}
            <button
              class="fav-btn"
              class:favorited={favoritedIds.has(lightbox.id)}
              on:click={() => toggleFavorite(lightbox)}
              title={favoritedIds.has(lightbox.id) ? 'Remove from favorites' : 'Add to favorites'}
            >
              ★
            </button>
          {/if}
          <button class="btn-ghost small" on:click={() => downloadImage(lightbox.url, `${lightbox.title || lightbox.id}.png`)}>Download</button>
          {#if user && (user.username === lightbox.author || user.role >= 5)}
            <button class="btn-danger small" on:click={() => deleteImage(lightbox)}>Delete</button>
          {/if}
        </div>

        <!-- Comments Section -->
        <div class="comments-section">
          <h4>Comments</h4>
          {#if commentsLoading}
            <p class="comments-loading">Loading...</p>
          {:else if comments.length === 0}
            <p class="comments-empty">No comments yet</p>
          {:else}
            <div class="comments-list">
              {#each comments as comment (comment.id)}
                <div class="comment">
                  <div class="comment-header">
                    <button class="comment-author" on:click={() => profileDialog.show(comment.author)}>{comment.author}</button>
                    <span class="comment-date">{formatDate(comment.createdAt)}</span>
                    {#if user && (user.userId === comment.authorId || user.role >= 5)}
                      <button class="comment-delete" on:click={() => deleteComment(comment.id)} title="Delete">×</button>
                    {/if}
                  </div>
                  <p class="comment-text">{comment.text}</p>
                </div>
              {/each}
            </div>
          {/if}

          {#if user}
            <form class="comment-form" on:submit|preventDefault={submitComment}>
              <input
                type="text"
                bind:value={newComment}
                placeholder="Add a comment..."
                maxlength="500"
                disabled={commentSubmitting}
              />
              <button type="submit" class="btn-primary small" disabled={!newComment.trim() || commentSubmitting}>
                {commentSubmitting ? '...' : 'Post'}
              </button>
            </form>
          {:else}
            <p class="comments-login-hint">
              <button class="btn-link" on:click={() => openAuthModal('login')}>Log in</button> to comment
            </p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if showAuthModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal-backdrop" on:click={closeAuthModal}>
    <div class="modal" on:click|stopPropagation>
      <button class="modal-close" on:click={closeAuthModal}>×</button>
      <h2>{authMode === 'login' ? 'Login' : 'Register'}</h2>

      <form on:submit|preventDefault={authMode === 'login' ? handleLogin : handleRegister}>
        <label>
          <span>Username</span>
          <input type="text" bind:value={authForm.username} autocomplete="username" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" bind:value={authForm.password} autocomplete={authMode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {#if authMode === 'register'}
          <label>
            <span>Email (optional)</span>
            <input type="email" bind:value={authForm.email} autocomplete="email" />
          </label>
        {/if}

        {#if authError}
          <p class="auth-error">{authError}</p>
        {/if}

        <button type="submit" class="btn-primary" disabled={authLoading}>
          {authLoading ? '...' : (authMode === 'login' ? 'Login' : 'Register')}
        </button>
      </form>

      <p class="auth-switch">
        {#if authMode === 'login'}
          Don't have an account? <button class="btn-link" on:click={() => authMode = 'register'}>Register</button>
        {:else}
          Already have an account? <button class="btn-link" on:click={() => authMode = 'login'}>Login</button>
        {/if}
      </p>
    </div>
  </div>
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    background: #121212;
    color: #e8e2d5;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 400;
  }
  :global(a) { color: inherit; text-decoration: none; }

  :global(:root) {
    --bg: #121212;
    --bg2: #1a1a1a;
    --text: #ffffff;
    --text-dim: rgba(255,255,255,0.4);
    --accent: #00d4aa;
    --teal: #5b9e8f;
    --border: rgba(255,255,255,0.08);
  }

  .page { min-height: 100vh; display: flex; flex-direction: column; }

  /* ── Nav ── */
  nav {
    position: sticky;
    top: 0; z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 3rem;
    backdrop-filter: blur(12px);
    background: rgba(12,11,9,0.8);
    border-bottom: 1px solid var(--border);
  }

  .wordmark {
    font-family: 'Inter', sans-serif;

    font-weight: 400;
    font-size: 1.6rem;
    letter-spacing: -0.02em;
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    font-weight: 400;
  }
  .nav-active { color: var(--text-dim); }
  .nav-cta { color: var(--accent); }
  .nav-divider { color: var(--border); }
  .nav-user {
    color: var(--text);
    background: none;
    border: none;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .nav-user:hover { color: var(--accent); }

  .btn-text {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
  }
  .btn-text:hover { color: var(--text); }
  .btn-text.active { color: var(--accent); }

  /* ── Header ── */
  header {
    padding: 2rem 3rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }
  .header-top {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 2rem;
    flex-wrap: wrap;
  }
  header h1 {
    font-family: 'Inter', sans-serif;
    font-weight: 400;
    font-size: clamp(1.5rem, 3vw, 2rem);
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
  }
  header p { color: var(--text-dim); font-size: 0.9rem; }

  .sort-controls {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .sort-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.4rem 0.9rem;
    border-radius: 2px;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
  }
  .sort-btn:hover { border-color: var(--text-dim); color: var(--text); }
  .sort-btn.active { border-color: var(--accent); color: var(--accent); }

  /* ── Main ── */
  main {
    flex: 1;
    padding: 3rem;
  }

  /* ── States ── */
  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    min-height: 40vh;
    text-align: center;
  }

  .spinner {
    width: 36px; height: 36px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-msg { color: var(--text-dim); }

  .empty-icon {
    font-size: 3rem;
    color: var(--border);
    line-height: 1;
  }
  .empty h2 {
    font-family: 'Inter', sans-serif;
    font-size: 1.5rem;
    font-weight: 400;
  }
  .empty p { color: var(--text-dim); font-size: 0.9rem; }

  /* ── Grid ── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1.25rem;
  }

  .card {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.2s, transform 0.2s;
    text-align: left;
    padding: 0;
    color: var(--text);
  }
  .card:hover {
    border-color: rgba(255,255,255,0.15);
  }

  .card-img {
    aspect-ratio: 4 / 3;
    overflow: hidden;
    background: var(--bg2);
  }
  .card-img img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.3s;
  }
  .card:hover .card-img img { transform: scale(1.015); }

  .card-meta {
    padding: 0.65rem 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg2);
    border-top: 1px solid var(--border);
  }
  .card-author {
    font-size: 0.8rem;
    color: var(--text-dim);
    background: none;
    border: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .card-author:hover { color: var(--accent); }

  /* ── Like Button ── */
  .like-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.78rem;
    cursor: pointer;
    font-family: 'Inter', -apple-system, sans-serif;
    padding: 2px 6px;
    border-radius: 2px;
    transition: color 0.15s, background 0.15s;
  }
  .like-btn:hover { color: #e07070; }
  .like-btn.liked { color: #e07070; }
  .like-btn.large { font-size: 0.9rem; padding: 6px 12px; border: 1px solid var(--border); }
  .like-btn.large:hover, .like-btn.large.liked { border-color: #e07070; }

  /* ── Favorite Button ── */
  .fav-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 1rem;
    cursor: pointer;
    padding: 5px 12px;
    border-radius: 2px;
    transition: color 0.15s, border-color 0.15s;
  }
  .fav-btn:hover { color: #f0c040; border-color: #f0c040; }
  .fav-btn.favorited { color: #f0c040; border-color: #f0c040; }

  /* ── Pagination ── */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    margin-top: 3rem;
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  /* ── Buttons ── */
  .btn-primary {
    display: inline-block;
    padding: 0.7rem 1.75rem;
    background: var(--accent);
    color: #121212;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 500;
    font-size: 0.88rem;
    letter-spacing: 0.04em;
    border-radius: 2px;
    border: none;
    cursor: pointer;
    transition: background 0.2s;
    text-decoration: none;
  }
  .btn-primary:hover { background: #00f0c3; }
  .btn-primary:disabled { opacity: 0.5; cursor: default; }

  .btn-ghost {
    display: inline-block;
    padding: 0.6rem 1.25rem;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 0.85rem;
    border-radius: 2px;
    background: none;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
    text-decoration: none;
  }
  .btn-ghost:hover { border-color: var(--text-dim); color: var(--text); }
  .btn-ghost:disabled { opacity: 0.3; cursor: default; }
  .btn-ghost.small { padding: 0.45rem 0.9rem; font-size: 0.8rem; }

  .btn-danger {
    background: transparent;
    border: 1px solid #c53030;
    color: #fc8181;
    padding: 0.6rem 1.2rem;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
  }
  .btn-danger:hover { background: #c53030; color: #fff; }
  .btn-danger.small { padding: 0.45rem 0.9rem; font-size: 0.8rem; }

  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  /* ── Footer ── */
  footer {
    padding: 1.5rem 3rem;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  footer a:hover { color: var(--text); }

  /* ── Lightbox ── */
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    backdrop-filter: blur(4px);
    animation: fadeIn 0.15s ease;
  }
  .lightbox-backdrop.instant {
    animation: none;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .lightbox {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    max-width: 900px;
    width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    position: relative;
    animation: slideUp 0.2s ease;
  }
  .lightbox-backdrop.instant .lightbox {
    animation: none;
  }
  @keyframes slideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .lb-close {
    position: absolute;
    top: 0.75rem; right: 0.75rem;
    background: rgba(0,0,0,0.5);
    border: none;
    color: var(--text);
    font-size: 1.2rem;
    line-height: 1;
    width: 28px; height: 28px;
    border-radius: 50%;
    cursor: pointer;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lb-img-wrap {
    flex: 1;
    overflow: hidden;
    background: #2a2a2a;
    display: flex;
    align-items: center;
    justify-content: center;
    max-height: 65vh;
  }
  .lb-img-wrap img {
    max-width: 100%;
    max-height: 65vh;
    object-fit: contain;
    display: block;
  }

  .lb-info {
    padding: 1rem 1.25rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .lb-info h3 {
    font-family: 'Inter', sans-serif;
    font-size: 1.1rem;
    font-weight: 400;
  }

  .lb-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .lb-author {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .lb-author:hover { color: var(--accent); }

  .lb-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* ── Comments ── */
  .comments-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .comments-section h4 {
    font-size: 0.9rem;
    font-weight: 400;
    margin-bottom: 0.75rem;
    color: var(--text-dim);
  }
  .comments-loading, .comments-empty {
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .comments-list {
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 0.75rem;
  }
  .comment {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .comment:last-child { border-bottom: none; }
  .comment-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  .comment-author {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text);
    background: none;
    border: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .comment-author:hover { color: var(--accent); }
  .comment-date {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .comment-delete {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .comment-delete:hover { color: #e07070; }
  .comment-text {
    font-size: 0.82rem;
    color: var(--text);
    line-height: 1.4;
    word-break: break-word;
  }
  .comment-form {
    display: flex;
    gap: 0.5rem;
  }
  .comment-form input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
  }
  .comment-form input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .btn-primary.small {
    padding: 0.5rem 0.9rem;
    font-size: 0.78rem;
  }
  .comments-login-hint {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  /* ── Auth Modal ── */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 1100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    backdrop-filter: blur(4px);
    animation: fadeIn 0.15s ease;
  }

  .modal {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2rem;
    max-width: 360px;
    width: 100%;
    position: relative;
    animation: slideUp 0.2s ease;
  }

  .modal-close {
    position: absolute;
    top: 0.75rem; right: 0.75rem;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 1.2rem;
    cursor: pointer;
  }
  .modal-close:hover { color: var(--text); }

  .modal h2 {
    font-family: 'Inter', sans-serif;
    font-size: 1.25rem;
    font-weight: 400;
    margin-bottom: 1.5rem;
  }

  .modal form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .modal input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.6rem 0.75rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
  }
  .modal input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .auth-error {
    color: #e07070;
    font-size: 0.82rem;
  }

  .auth-switch {
    margin-top: 1.25rem;
    font-size: 0.82rem;
    color: var(--text-dim);
    text-align: center;
  }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    nav, header, main, footer { padding-left: 1.25rem; padding-right: 1.25rem; }
    header { padding-top: 1.5rem; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
    .nav-links { gap: 1rem; }
  }
</style>
