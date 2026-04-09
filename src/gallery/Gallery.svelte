<script>
  import { onMount } from 'svelte';
  import { ProfileDialog } from '../ui/ProfileDialog.js';

  // API base URL - defaults to relative (dev proxy) or can be set via env var for production
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

  const TOKEN_KEY = 'topDrawAuthToken';
  const USERNAME_KEY = 'topDrawUsername';
  const HOLY_ROLE = 8;

  // Track if lightbox was opened from a profile (to return to it)
  let openedFromProfile = $state(null);
  let lightboxInstant = $state(false); // Skip fade animation when opening from profile

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
  let items = $state([]);
  let loading = $state(true);
  let error = $state(null);
  let page = $state(1);
  let totalPages = $state(1);
  let lightbox = $state(null);
  let likedIds = $state(new Set(JSON.parse(localStorage.getItem('ddraw_liked') || '[]')));
  let sort = $state('newest'); // 'newest' | 'top' | 'views'
  let authorFilter = $state(null); // username string or null
  let tagFilter = $state(null); // tag string or null
  let showFavorites = $state(false); // viewing favorites mode
  let favoritedIds = $state(new Set()); // ids user has favorited
  let revealedNsfwIds = $state(new Set());

  // Sidebar state
  let recentCommentsFeed = $state([]);
  let sidebarTags = $state([]);
  let sidebarLoading = $state(false);

  // Comments state
  let comments = $state([]);
  let commentsLoading = $state(false);
  let newComment = $state('');
  let commentSubmitting = $state(false);
  let editingCommentId = $state(null);
  let editingCommentText = $state('');
  let commentActionBusy = $state(false);
  let tagDraft = $state('');
  let tagSaving = $state(false);
  let lightboxImageWrap = null;

  // Auth state
  let user = $state(null); // { username, role, userId }
  let authLoading = $state(false);
  let authError = $state(null);
  let showAuthModal = $state(false);
  let authMode = $state('login'); // 'login' | 'register'
  let authForm = $state({ username: '', password: '', email: '' });

  async function fetchGallery() {
    loading = true;
    error = null;
    try {
      let url = `${API_BASE}/api/gallery?page=${page}&limit=24&sort=${sort}`;
      if (authorFilter) url += `&author=${encodeURIComponent(authorFilter)}`;
      if (tagFilter) url += `&tag=${encodeURIComponent(tagFilter)}`;
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

  async function fetchSidebar() {
    sidebarLoading = true;
    try {
      let url = `${API_BASE}/api/gallery/sidebar`;
      const params = new URLSearchParams();
      if (authorFilter) params.set('author', authorFilter);
      if (tagFilter) params.set('tag', tagFilter);
      const query = params.toString();
      if (query) url += `?${query}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch sidebar');
      const data = await res.json();
      recentCommentsFeed = data.recentComments || [];
      sidebarTags = data.tags || [];
    } catch {
      recentCommentsFeed = [];
      sidebarTags = [];
    } finally {
      sidebarLoading = false;
    }
  }

  function setSort(newSort) {
    if (sort === newSort) return;
    sort = newSort;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function filterByAuthor(username) {
    authorFilter = username;
    tagFilter = null;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function clearAuthorFilter() {
    authorFilter = null;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function filterByTag(tag) {
    tagFilter = tag;
    showFavorites = false;
    page = 1;
    fetchGallery();
    fetchSidebar();
  }

  function clearTagFilter() {
    tagFilter = null;
    page = 1;
    fetchGallery();
    fetchSidebar();
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
    tagFilter = null;
    page = 1;
    if (showFavorites) {
      fetchFavorites();
      recentCommentsFeed = [];
      sidebarTags = [];
    } else {
      fetchGallery();
      fetchSidebar();
    }
  }

  async function toggleFavorite(item) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || !user) return;

    const wasFavorited = favoritedIds.has(item.id);
    const nextFavoritedIds = new Set(favoritedIds);

    // Optimistic update
    if (wasFavorited) {
      nextFavoritedIds.delete(item.id);
      // Remove from list if viewing favorites
      if (showFavorites) {
        items = items.filter(i => i.id !== item.id);
        // Close lightbox if this item was open
        if (lightbox?.id === item.id) {
          closeLightbox();
        }
      }
    } else {
      nextFavoritedIds.add(item.id);
    }
    favoritedIds = nextFavoritedIds;

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/favorite`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to update favorite');

      const data = await res.json().catch(() => ({}));
      if (typeof data.favorited === 'boolean') {
        const syncedFavoritedIds = new Set(favoritedIds);
        if (data.favorited) syncedFavoritedIds.add(item.id);
        else syncedFavoritedIds.delete(item.id);
        favoritedIds = syncedFavoritedIds;
      }
    } catch {
      // Revert on error
      const revertedFavoritedIds = new Set(favoritedIds);
      if (wasFavorited) {
        revertedFavoritedIds.add(item.id);
        // Re-add to list if viewing favorites
        if (showFavorites) {
          items = [...items, item];
        }
      } else {
        revertedFavoritedIds.delete(item.id);
      }
      favoritedIds = revertedFavoritedIds;
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
        const nextFavoritedIds = new Set(favoritedIds);
        if (data.favorited) nextFavoritedIds.add(id);
        else nextFavoritedIds.delete(id);
        favoritedIds = nextFavoritedIds;
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
        comments = [...comments, { ...comment, edited: !!comment.updatedAt }];
        newComment = '';
        fetchSidebar();
      }
    } catch {}
    commentSubmitting = false;
  }

  function beginCommentEdit(comment) {
    editingCommentId = comment.id;
    editingCommentText = comment.text;
  }

  function cancelCommentEdit() {
    editingCommentId = null;
    editingCommentText = '';
  }

  async function saveCommentEdit(commentId) {
    await checkAuth();
    const token = localStorage.getItem(TOKEN_KEY);
    const nextText = editingCommentText.trim();
    const comment = comments.find((entry) => entry.id === commentId);
    if (!token || !comment || !canEditComment(comment) || !nextText || commentActionBusy) return;

    commentActionBusy = true;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/comments/${commentId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text: nextText })
      });
      if (!res.ok) throw new Error('Failed to update comment');

      const data = await res.json().catch(() => ({}));
      comments = comments.map((entry) => entry.id === commentId ? {
        ...entry,
        text: data.text || nextText,
        edited: true,
        updatedAt: data.updatedAt || new Date().toISOString()
      } : entry);
      cancelCommentEdit();
      fetchSidebar();
    } catch {}
    commentActionBusy = false;
  }

  async function deleteComment(commentId) {
    await checkAuth();
    const comment = comments.find((entry) => entry.id === commentId);
    if (!comment || !canDeleteComment(comment) || commentActionBusy) return;

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    commentActionBusy = true;
    try {
      const res = await fetch(`${API_BASE}/api/gallery/comments/${commentId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        comments = comments.filter(c => c.id !== commentId);
        if (editingCommentId === commentId) cancelCommentEdit();
        fetchSidebar();
      }
    } catch {}
    commentActionBusy = false;
  }

  function canEditTags(item) {
    return !!user && (user.username === item.author || (user.role || 0) >= HOLY_ROLE);
  }

  function canDeleteImage(item) {
    return !!user && (user.username === item.author || (user.role || 0) >= HOLY_ROLE);
  }

  function canDeleteComment(comment) {
    return !!user && (user.userId === comment.authorId || (user.role || 0) >= HOLY_ROLE);
  }

  function canEditComment(comment) {
    return !!user && user.userId === comment.authorId;
  }

  function isNsfw(item) {
    return !!item?.tags?.includes('nsfw');
  }

  function isNsfwRevealed(item) {
    return !!item && revealedNsfwIds.has(item.id);
  }

  function revealNsfw(item) {
    if (!item?.id) return;
    revealedNsfwIds = new Set([...revealedNsfwIds, item.id]);
  }

  function getLightboxIndex() {
    if (!lightbox) return -1;
    return items.findIndex((item) => item.id === lightbox.id);
  }

  function canGoPrev() {
    return getLightboxIndex() > 0;
  }

  function canGoNext() {
    const idx = getLightboxIndex();
    return idx !== -1 && idx < items.length - 1;
  }

  async function setActiveLightboxItem(item) {
    lightbox = item;
    syncTagDraft(item);
    comments = [];
    commentsLoading = false;
    cancelCommentEdit();
    document.body.style.overflow = 'hidden';
    await checkAuth();
    if (user) {
      checkFavorite(item.id);
    }
    fetchComments(item.id);
  }

  async function navigateLightbox(direction) {
    const idx = getLightboxIndex();
    if (idx === -1) return;
    const nextIndex = idx + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    await setActiveLightboxItem(items[nextIndex]);
  }

  async function toggleFullscreen() {
    if (!lightboxImageWrap) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await lightboxImageWrap.requestFullscreen();
      }
    } catch {}
  }

  function syncTagDraft(item) {
    tagDraft = (item?.tags || []).join(', ');
  }

  async function saveTags() {
    await checkAuth();
    if (!lightbox || !canEditTags(lightbox) || tagSaving) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    tagSaving = true;
    try {
      const nextTags = tagDraft.split(',').map((tag) => tag.trim()).filter(Boolean);
      const res = await fetch(`${API_BASE}/api/gallery/${lightbox.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ tags: nextTags })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update tags');
      }

      const data = await res.json();
      lightbox = { ...lightbox, tags: data.tags || [] };
      items = items.map((item) => item.id === lightbox.id ? { ...item, tags: data.tags || [] } : item);
      syncTagDraft(lightbox);
      fetchSidebar();
    } catch (err) {
      alert(err.message || 'Failed to update tags');
    } finally {
      tagSaving = false;
    }
  }

  async function deleteImage(item) {
    await checkAuth();
    if (!canDeleteImage(item)) {
      alert('You are not authorized to delete this image.');
      return;
    }
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
      } else {
        // Token invalid, clear it
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
        user = null;
      }
    } catch {}

    return user;
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

  function persistLikedIds(nextLikedIds) {
    likedIds = nextLikedIds;
    localStorage.setItem('ddraw_liked', JSON.stringify([...nextLikedIds]));
  }

  function updateLikeCount(itemId, likes) {
    items = items.map((entry) => entry.id === itemId ? { ...entry, likes } : entry);
    if (lightbox?.id === itemId) {
      lightbox = { ...lightbox, likes };
    }
  }

  async function like(item) {
    const wasLiked = likedIds.has(item.id);
    const previousLikes = item.likes || 0;
    const nextLikedIds = new Set(likedIds);
    if (wasLiked) nextLikedIds.delete(item.id);
    else nextLikedIds.add(item.id);

    persistLikedIds(nextLikedIds);
    updateLikeCount(item.id, Math.max(0, previousLikes + (wasLiked ? -1 : 1)));

    try {
      const res = await fetch(`${API_BASE}/api/gallery/${item.id}/like`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to update like');

      const data = await res.json().catch(() => ({}));
      const syncedLikedIds = new Set(likedIds);
      if (data.liked) syncedLikedIds.add(item.id);
      else syncedLikedIds.delete(item.id);
      persistLikedIds(syncedLikedIds);
      if (typeof data.likes === 'number') {
        updateLikeCount(item.id, data.likes);
      }
    } catch {
      const revertedLikedIds = new Set(nextLikedIds);
      if (wasLiked) revertedLikedIds.add(item.id);
      else revertedLikedIds.delete(item.id);
      persistLikedIds(revertedLikedIds);
      updateLikeCount(item.id, previousLikes);
    }
  }

  async function openLightbox(item) {
    await setActiveLightboxItem(item);
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
    cancelCommentEdit();
    tagDraft = '';

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
      navigateLightbox(1);
    }
    if (e.key === 'ArrowLeft' && lightbox) {
      navigateLightbox(-1);
    }
  }

  function formatDate(d) {
    return new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function openImageById(itemId) {
    try {
      const existing = items.find((item) => item.id === itemId);
      if (existing) {
        openLightbox(existing);
        return;
      }

      const res = await fetch(`${API_BASE}/api/gallery/${itemId}`);
      if (!res.ok) return;
      const item = await res.json();
      openLightbox(item);
    } catch {}
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

    const tagParam = params.get('tag');
    if (tagParam) {
      tagFilter = tagParam.trim().toLowerCase();
    }
  }

  onMount(() => {
    checkAuth();
    checkUrlParams();
    fetchGallery();
    fetchSidebar();
  });
</script>

<svelte:window onkeydown={handleKeydown}/>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">

<div class="page">
  <nav>
    <a href="/" class="wordmark">DDraw</a>
    <div class="nav-links">
      <span class="nav-active">gallery</span>
      <a href="/go/" class="nav-cta" target="_blank">draw →</a>
      <span class="nav-divider">|</span>
      {#if user}
        <button class="btn-text" class:active={showFavorites} onclick={toggleFavoritesView}>favorites</button>
        <button class="nav-user" onclick={() => profileDialog.show(user.username)}>{user.username}</button>
        <button class="btn-text" onclick={logout}>logout</button>
      {:else}
        <button class="btn-text" onclick={() => openAuthModal('login')}>login</button>
      {/if}
    </div>
  </nav>

  <header>
    <div class="header-top">
      <div>
        <h1>{showFavorites ? 'My Favorites' : (authorFilter ? `${authorFilter}'s Art` : (tagFilter ? `#${tagFilter}` : 'Gallery'))}</h1>
        <p>
          {#if showFavorites}
            <button class="btn-link" onclick={toggleFavoritesView}>← back to all</button>
          {:else if tagFilter}
            <button class="btn-link" onclick={clearTagFilter}>â† clear tag</button>
          {:else if authorFilter}
            <button class="btn-link" onclick={clearAuthorFilter}>← back to all</button>
          {:else}
            Artwork made by the community
          {/if}
        </p>
      </div>
      {#if !showFavorites}
        <div class="sort-controls">
          <button class="sort-btn" class:active={sort === 'newest'} onclick={() => setSort('newest')}>Newest</button>
          <button class="sort-btn" class:active={sort === 'top'} onclick={() => setSort('top')}>Top</button>
          <button class="sort-btn" class:active={sort === 'views'} onclick={() => setSort('views')}>Views</button>
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
        <button class="btn-ghost" onclick={fetchGallery}>Retry</button>
      </div>
    {:else if items.length === 0}
      <div class="state-center empty">
        <div class="empty-icon">◻</div>
        <h2>Nothing here yet</h2>
        <p>Be the first to save something to the gallery.</p>
        <a href="/go/" class="btn-primary" target="_blank">Start Drawing</a>
      </div>
    {:else}
      <div class="gallery-layout">
        <section class="gallery-main">
          <div class="grid">
        {#each items as item (item.id)}
          <div class="card" role="button" tabindex="0" onclick={() => openLightbox(item)} onkeydown={(e) => e.key === 'Enter' && openLightbox(item)}>
            <div class="card-img">
              <img src={item.thumbUrl || item.url} alt={item.title || 'artwork'} loading="lazy" class:censored={isNsfw(item) && !isNsfwRevealed(item)}>
              {#if isNsfw(item)}
                <span class="card-badge">NSFW</span>
                {#if !isNsfwRevealed(item)}
                  <button class="censor-overlay" onclick={(e) => { e.stopPropagation(); revealNsfw(item); }} aria-label="Reveal censored image">
                    <span>Censored</span>
                    <strong>Reveal</strong>
                  </button>
                {/if}
              {/if}
            </div>
            <div class="card-meta">
              <button class="card-author" onclick={(e) => { e.stopPropagation(); profileDialog.show(item.author); }}>{item.author}</button>
              <button
                class="like-btn"
                class:liked={likedIds.has(item.id)}
                onclick={(e) => { e.stopPropagation(); like(item); }}
                aria-label="Like"
              >
                ♥ {item.likes || 0}
              </button>
            </div>
            {#if item.tags?.length}
              <div class="card-tags">
                {#each item.tags as tag}
                  <button class="tag-chip" onclick={(e) => { e.stopPropagation(); filterByTag(tag); }}>#{tag}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      {#if totalPages > 1}
        <div class="pagination">
          <button class="btn-ghost small" disabled={page <= 1} onclick={() => { page--; fetchGallery(); }}>← Prev</button>
          <span>{page} / {totalPages}</span>
          <button class="btn-ghost small" disabled={page >= totalPages} onclick={() => { page++; fetchGallery(); }}>Next →</button>
        </div>
      {/if}
        </section>

        <aside class="gallery-sidebar">
          <div class="sidebar-card">
            <div class="sidebar-head">
              <h2>Image Tags</h2>
              {#if tagFilter}
                <button class="btn-link small-link" onclick={clearTagFilter}>clear</button>
              {/if}
            </div>
            {#if sidebarTags.length === 0}
              <p class="sidebar-empty">{sidebarLoading ? 'Loading tags...' : 'No tags yet'}</p>
            {:else}
              <div class="sidebar-tags">
                {#each sidebarTags as entry}
                  <button class="tag-chip sidebar-tag" class:active={tagFilter === entry.tag} onclick={() => filterByTag(entry.tag)}>
                    #{entry.tag} <span>{entry.count}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div class="sidebar-card">
            <div class="sidebar-head">
              <h2>Recent Comments</h2>
            </div>
            {#if recentCommentsFeed.length === 0}
              <p class="sidebar-empty">{sidebarLoading ? 'Loading comments...' : 'No recent comments'}</p>
            {:else}
              <div class="recent-comments">
                {#each recentCommentsFeed as entry (entry.id)}
                  <button class="recent-comment" onclick={() => openImageById(entry.image.id)}>
                    <img src={entry.image.thumbUrl} alt={entry.image.title || 'artwork'} class:censored={isNsfw(entry.image) && !isNsfwRevealed(entry.image)}>
                    <div class="recent-comment-body">
                      <div class="recent-comment-meta">
                        <span>{entry.author}</span>
                        <span>{formatDate(entry.createdAt)}</span>
                      </div>
                      <p>{entry.text}</p>
                      <strong>{entry.image.title || `by ${entry.image.author}`}</strong>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </aside>
      </div>
    {/if}
  </main>

  <footer>
    <span>DDraw</span>
    <a href="/">← back to home</a>
  </footer>
</div>

{#if lightbox}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox-backdrop" class:instant={lightboxInstant} role="presentation" onclick={closeLightbox} onkeydown={(e) => e.key === 'Escape' && closeLightbox()}>
    <div class="lightbox" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      {#if canGoPrev()}
        <button class="lb-nav prev" onclick={() => navigateLightbox(-1)} aria-label="Previous image">‹</button>
      {/if}
      {#if canGoNext()}
        <button class="lb-nav next" onclick={() => navigateLightbox(1)} aria-label="Next image">›</button>
      {/if}
      <button class="lb-control lb-fullscreen" onclick={toggleFullscreen} aria-label="Toggle fullscreen" title="Fullscreen">⛶</button>
      <button class="lb-close" onclick={closeLightbox}>×</button>
      <div class="lb-img-wrap" bind:this={lightboxImageWrap}>
        <img src={lightbox.url} alt={lightbox.title || 'artwork'} class:censored={isNsfw(lightbox) && !isNsfwRevealed(lightbox)}>
        {#if isNsfw(lightbox) && !isNsfwRevealed(lightbox)}
          <button class="censor-overlay lightbox-censor" onclick={() => revealNsfw(lightbox)} aria-label="Reveal censored image">
            <span>NSFW content hidden</span>
            <strong>Reveal image</strong>
          </button>
        {/if}
      </div>
      <div class="lb-info">
        {#if lightbox.title}
          <h3>{lightbox.title}</h3>
        {/if}
        <div class="lb-meta">
          <button class="lb-author" onclick={() => profileDialog.show(lightbox.author)}>by {lightbox.author}</button>
          <span class="lb-date">{formatDate(lightbox.createdAt)}</span>
        </div>
        <div class="lb-tags">
          {#if lightbox.tags?.length}
            {#each lightbox.tags as tag}
              <button class="tag-chip" onclick={() => { closeLightbox(); filterByTag(tag); }}>#{tag}</button>
            {/each}
          {:else}
            <span class="lb-tags-empty">No tags yet</span>
          {/if}
        </div>
        <div class="lb-actions">
          <button
            class="like-btn large"
            class:liked={likedIds.has(lightbox.id)}
            onclick={() => like(lightbox)}
          >
            ♥ {lightbox.likes || 0}
          </button>
          {#if user}
            <button
              class="fav-btn"
              class:favorited={favoritedIds.has(lightbox.id)}
              onclick={() => toggleFavorite(lightbox)}
              title={favoritedIds.has(lightbox.id) ? 'Remove from favorites' : 'Add to favorites'}
            >
              ★
            </button>
          {/if}
          <button class="btn-ghost small" onclick={() => downloadImage(lightbox.url, `${lightbox.title || lightbox.id}.png`)}>Download</button>
          {#if canDeleteImage(lightbox)}
            <button class="btn-danger small" onclick={() => deleteImage(lightbox)}>Delete</button>
          {/if}
        </div>

        {#if canEditTags(lightbox)}
          <div class="tag-editor">
            <label for="tagEditorInput">Tags</label>
            <div class="tag-editor-row">
              <input id="tagEditorInput" type="text" bind:value={tagDraft} placeholder="nsfw, portrait, pixel-art" />
              <button class="btn-ghost small" onclick={saveTags} disabled={tagSaving}>
                {tagSaving ? 'Saving...' : 'Save Tags'}
              </button>
            </div>
            <p class="tag-editor-hint">Comma-separated tags. Use <code>nsfw</code> for adult or sensitive images.</p>
          </div>
        {/if}

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
                    <button class="comment-author" onclick={() => profileDialog.show(comment.author)}>{comment.author}</button>
                    <span class="comment-date">{formatDate(comment.createdAt)}</span>
                    {#if comment.edited}
                      <span class="comment-edited">Edited</span>
                    {/if}
                    {#if canEditComment(comment)}
                      <button class="comment-action" onclick={() => beginCommentEdit(comment)} disabled={commentActionBusy && editingCommentId !== comment.id}>
                        Edit
                      </button>
                    {/if}
                    {#if canDeleteComment(comment)}
                      <button class="comment-delete" onclick={() => deleteComment(comment.id)} title="Delete" disabled={commentActionBusy}>×</button>
                    {/if}
                  </div>
                  {#if editingCommentId === comment.id}
                    <form class="comment-edit-form" onsubmit={(e) => { e.preventDefault(); saveCommentEdit(comment.id); }}>
                      <input type="text" bind:value={editingCommentText} maxlength="500" disabled={commentActionBusy} />
                      <div class="comment-edit-actions">
                        <button type="submit" class="btn-primary small" disabled={!editingCommentText.trim() || commentActionBusy}>Save</button>
                        <button type="button" class="btn-ghost small" onclick={cancelCommentEdit} disabled={commentActionBusy}>Cancel</button>
                      </div>
                    </form>
                  {:else}
                    <p class="comment-text">{comment.text}</p>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if user}
            <form class="comment-form" onsubmit={(e) => { e.preventDefault(); submitComment(); }}>
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
              <button class="btn-link" onclick={() => openAuthModal('login')}>Log in</button> to comment
            </p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if showAuthModal}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" role="presentation" onclick={closeAuthModal} onkeydown={(e) => e.key === 'Escape' && closeAuthModal()}>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <button class="modal-close" onclick={closeAuthModal}>×</button>
      <h2>{authMode === 'login' ? 'Login' : 'Register'}</h2>

      <form onsubmit={(e) => { e.preventDefault(); authMode === 'login' ? handleLogin() : handleRegister(); }}>
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
          Don't have an account? <button class="btn-link" onclick={() => authMode = 'register'}>Register</button>
        {:else}
          Already have an account? <button class="btn-link" onclick={() => authMode = 'login'}>Login</button>
        {/if}
      </p>
    </div>
  </div>
{/if}

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    background: #0f0f13;
    color: #e8e2d5;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 400;
    overflow-x: hidden;
  }
  :global(a) { color: inherit; text-decoration: none; }

  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      radial-gradient(circle, rgba(200,0,200,0.03) 1px, transparent 1px),
      radial-gradient(circle, rgba(0,212,170,0.03) 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: 0 0, 20px 20px;
    pointer-events: none;
    z-index: 0;
  }

  :global(:root) {
    --bg: #0f0f13;
    --bg2: #1a1a1e;
    --text: #ffffff;
    --text-dim: rgba(255,255,255,0.45);
    --accent: #00d4aa;
    --magenta: #c800c8;
    --yellow: #ffdd00;
    --teal: #5b9e8f;
    --border: rgba(255,255,255,0.1);
  }

  .page { min-height: 100vh; display: flex; flex-direction: column; position: relative; z-index: 1; }

  /* ── Nav ── */
  nav {
    position: sticky;
    top: 0; z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2rem;
    height: 64px;
    backdrop-filter: blur(12px);
    background: rgba(15,15,19,0.85);
    border-bottom: 2px solid var(--accent);
  }

  .wordmark {
    font-family: 'Fredoka', sans-serif;
    font-weight: 700;
    font-size: 22px;
    color: var(--accent);
    transform: rotate(-2deg);
  }

  .nav-links {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    font-weight: 500;
  }
  .nav-links a {
    transition: all 0.2s;
  }
  .nav-links a:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }
  .nav-active { color: var(--text-dim); }
  .nav-cta {
    color: var(--accent);
    font-weight: 600;
  }
  .nav-divider { color: var(--border); }
  .nav-user {
    color: var(--text);
    background: none;
    border: none;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    transition: all 0.2s;
  }
  .nav-user:hover {
    color: var(--accent);
    transform: translateY(-1px);
  }

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
    border-bottom: 2px solid var(--border);
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
    font-weight: 500;
    font-size: clamp(1.5rem, 3vw, 2rem);
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
    background: linear-gradient(135deg, var(--text) 0%, var(--accent) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  header p { color: var(--text-dim); font-size: 0.9rem; }

  .sort-controls {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .sort-btn {
    background: none;
    border: 2px solid var(--border);
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .sort-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
  }
  .sort-btn.active {
    border-color: var(--accent);
    color: var(--accent);
    background: rgba(0, 212, 170, 0.1);
  }

  /* ── Main ── */
  main {
    flex: 1;
    padding: 3rem;
  }

  .gallery-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 1.5rem;
    align-items: start;
  }

  .gallery-main {
    min-width: 0;
  }

  .gallery-sidebar {
    position: sticky;
    top: 5.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .sidebar-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1.5px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    transition: border-color 0.2s;
  }

  .sidebar-card:hover {
    border-color: rgba(255, 255, 255, 0.15);
  }

  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.8rem;
  }

  .sidebar-head h2 {
    font-size: 0.95rem;
    font-weight: 400;
  }

  .sidebar-empty {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .sidebar-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .recent-comments {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .recent-comment {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 0.75rem;
    background: none;
    border: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: all 0.2s;
    padding: 0.5rem;
    margin: -0.5rem;
    border-radius: 6px;
  }

  .recent-comment:hover {
    background: rgba(0, 212, 170, 0.05);
  }

  .recent-comment img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 6px;
    border: 2px solid var(--border);
    transition: border-color 0.2s, filter 0.2s;
  }

  .recent-comment:hover img {
    border-color: var(--accent);
  }

  .recent-comment-meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-dim);
    margin-bottom: 0.25rem;
  }

  .recent-comment-body p {
    font-size: 0.8rem;
    line-height: 1.35;
    margin-bottom: 0.3rem;
    word-break: break-word;
  }

  .recent-comment-body strong {
    font-size: 0.76rem;
    color: var(--text-dim);
    font-weight: 400;
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
    border: 2px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.25s, transform 0.25s, box-shadow 0.25s;
    text-align: left;
    padding: 0;
    color: var(--text);
  }
  .card:hover {
    border-color: var(--accent);
    transform: translateY(-4px);
    box-shadow: 0 8px 16px rgba(0, 212, 170, 0.15);
  }

  .card-img {
    position: relative;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    background: var(--bg2);
  }
  .card-img img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.4s ease, filter 0.2s ease;
  }
  .card:hover .card-img img { transform: scale(1.05); }

  .censored {
    filter: blur(20px) saturate(0.7);
  }

  .censor-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    background: rgba(8, 8, 12, 0.58);
    border: none;
    color: var(--text);
    cursor: pointer;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    z-index: 1;
  }
  .censor-overlay span {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .censor-overlay strong {
    font-size: 0.85rem;
    font-weight: 600;
  }

  .card-badge {
    position: absolute;
    top: 0.65rem;
    right: 0.65rem;
    background: rgba(0, 0, 0, 0.85);
    border: 1.5px solid var(--accent);
    border-radius: 999px;
    padding: 0.28rem 0.55rem;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    color: var(--accent);
    font-weight: 600;
    backdrop-filter: blur(8px);
  }

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

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    padding: 0 0.75rem 0.75rem;
    background: var(--bg2);
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1.5px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.32rem 0.65rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .tag-chip:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(0, 212, 170, 0.1);
    transform: translateY(-1px);
  }

  .sidebar-tag.active {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(0, 212, 170, 0.15);
  }

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
    color: #0f0f13;
    font-family: 'Inter', -apple-system, sans-serif;
    font-weight: 600;
    font-size: 0.88rem;
    letter-spacing: 0.04em;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
  }
  .btn-primary:hover {
    background: #00f0c3;
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 212, 170, 0.3);
  }
  .btn-primary:disabled { opacity: 0.5; cursor: default; }

  .btn-ghost {
    display: inline-block;
    padding: 0.6rem 1.25rem;
    border: 2px solid var(--border);
    color: var(--text-dim);
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 0.85rem;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;
  }
  .btn-ghost:hover {
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
  }
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
    border-top: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  footer a {
    transition: color 0.2s;
  }
  footer a:hover { color: var(--accent); }

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
    border: 2px solid var(--accent);
    border-radius: 12px;
    overflow: hidden;
    max-width: 900px;
    width: 100%;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    position: relative;
    animation: slideUp 0.2s ease;
    box-shadow: 0 20px 60px rgba(0, 212, 170, 0.2);
  }
  .lightbox-backdrop.instant .lightbox {
    animation: none;
  }
  @keyframes slideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .lb-control,
  .lb-close {
    position: absolute;
    top: 0.75rem;
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
  .lb-close { right: 0.75rem; }
  .lb-fullscreen {
    right: 3rem;
    font-size: 0.95rem;
  }

  .lb-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 56px;
    height: 56px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(0,0,0,0.7);
    color: var(--text);
    font-size: 2.35rem;
    line-height: 1;
    cursor: pointer;
    z-index: 2;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(8px);
    transition: transform 0.2s ease, border-color 0.2s ease, background 0.2s ease;
  }
  .lb-nav:hover {
    transform: translateY(-50%) scale(1.04);
    border-color: var(--accent);
    background: rgba(0,0,0,0.82);
  }
  .lb-nav.prev { left: -1.75rem; }
  .lb-nav.next { right: -1.75rem; }

  .lb-img-wrap {
    flex: 1;
    position: relative;
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

  .lightbox-censor {
    font-size: 0.9rem;
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

  .lb-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .lb-tags-empty {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  .tag-editor {
    padding-top: 0.25rem;
  }

  .tag-editor label {
    display: block;
    font-size: 0.82rem;
    color: var(--text-dim);
    margin-bottom: 0.45rem;
  }

  .tag-editor-row {
    display: flex;
    gap: 0.5rem;
  }

  .tag-editor-row input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
  }

  .tag-editor-row input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .tag-editor-hint {
    margin-top: 0.45rem;
    font-size: 0.75rem;
    color: var(--text-dim);
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
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .comment-action {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
  }
  .comment-delete:hover { color: #e07070; }
  .comment-action:disabled, .comment-delete:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .comment-edited {
    font-size: 0.68rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
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
  .comment-edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .comment-edit-form input,
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
  .comment-edit-form input:focus,
  .comment-form input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .comment-edit-actions {
    display: flex;
    gap: 0.5rem;
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
    border: 2px solid var(--accent);
    border-radius: 12px;
    padding: 2rem;
    max-width: 360px;
    width: 100%;
    position: relative;
    animation: slideUp 0.2s ease;
    box-shadow: 0 20px 60px rgba(0, 212, 170, 0.2);
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
    .gallery-layout { grid-template-columns: 1fr; }
    .gallery-sidebar { position: static; }
    .tag-editor-row, .lb-actions { flex-wrap: wrap; }
  }
</style>
