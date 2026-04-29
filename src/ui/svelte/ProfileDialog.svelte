<script>
  import { appState } from '../../state.svelte.js';

  let { galleryBaseUrl = '/gallery', apiBaseUrl = '', onViewGallery = null, onImageClick = null } = $props();

  let visible = $derived(appState.profileDialog.visible);
  let username = $derived(appState.profileDialog.username);
  let data = $derived(appState.profileDialog.data);
  let loading = $derived(appState.profileDialog.loading);
  let error = $derived(appState.profileDialog.error);
  let recentUploads = $derived(data?.recentUploads || []);

  function close() {
    appState.profileDialog = {
      visible: false,
      username: null,
      data: null,
      loading: false,
      error: null
    };
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function handleImageClick(item) {
    if (onImageClick) {
      close();
      onImageClick(item);
    } else {
      window.location.href = `${galleryBaseUrl}?id=${item.id}`;
    }
  }

  function handleViewAll(e) {
    if (onViewGallery && data) {
      e.preventDefault();
      const username = data.username;
      close();
      onViewGallery(username);
    }
  }

  function formatJoinDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  $effect(() => {
    function handleKeydown(e) {
      if (e.key === 'Escape' && appState.profileDialog.visible) {
        close();
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if visible}
  <div
    class="profile-dialog-backdrop"
    onclick={handleBackdropClick}
    role="presentation"
  >
    <div
      class="profile-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div class="profile-dialog-header">
        <span></span>
        <button
          class="profile-dialog-close"
          onclick={close}
          title="Close"
        >&times;</button>
      </div>

      <div class="profile-dialog-body">
        {#if loading}
          <div class="profile-dialog-loading">Loading...</div>
        {:else if error}
          <div class="profile-dialog-error">{error}</div>
        {:else if data}
          <h2 class="profile-username">{data.username}</h2>
          {#if data.createdAt}
            <div class="profile-meta">Joined {formatJoinDate(data.createdAt)}</div>
          {/if}

          <div class="profile-stats">
            <div class="profile-stat">
              <div class="profile-stat-value">{data.uploadCount}</div>
              <div class="profile-stat-label">Uploads</div>
            </div>
            <div class="profile-stat">
              <div class="profile-stat-value">{data.totalLikes}</div>
              <div class="profile-stat-label">Likes</div>
            </div>
          </div>

          <div class="profile-recent">
            <div class="profile-recent-title">Recent Uploads</div>
            <div class="profile-recent-grid">
              {#if recentUploads.length > 0}
                {#each recentUploads as item}
                  <button
                    class="profile-recent-item"
                    onclick={() => handleImageClick(item)}
                    title={item.title || 'View'}
                  >
                    <img src={item.thumbUrl} alt={item.title || 'artwork'} loading="lazy">
                  </button>
                {/each}
              {:else}
                <div class="profile-recent-empty">No uploads yet</div>
              {/if}
            </div>
          </div>

          <div class="profile-actions">
            <a
              href="{galleryBaseUrl}/{encodeURIComponent(data.username)}"
              class="profile-btn profile-btn-primary"
              target="_blank"
              onclick={handleViewAll}
            >
              View All Art
            </a>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .profile-dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    backdrop-filter: blur(4px);
    animation: profileFadeIn 0.15s ease;
  }

  @keyframes profileFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .profile-dialog {
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    max-width: 400px;
    width: 100%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: profileSlideUp 0.2s ease;
    font-family: 'Inter', -apple-system, sans-serif;
    color: #e8e2d5;
  }

  @keyframes profileSlideUp {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .profile-dialog-header {
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .profile-dialog-close {
    background: transparent;
    border: none;
    color: #f0f2f5;
    font-size: 1.75rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    display: block;
  }
  .profile-dialog-close:hover {
    color: #fff;
  }

  .profile-dialog-body {
    padding: 1.5rem;
    overflow-y: auto;
  }

  .profile-dialog-loading,
  .profile-dialog-error {
    text-align: center;
    padding: 2rem;
    color: rgba(255,255,255,0.5);
  }

  .profile-dialog-error {
    color: #e07070;
  }

  .profile-username {
    font-size: 1.5rem;
    font-weight: 400;
    margin: 0;
    letter-spacing: -0.02em;
  }

  .profile-meta {
    margin-top: 0.25rem;
    font-size: 0.82rem;
    color: rgba(255,255,255,0.4);
  }

  .profile-stats {
    display: flex;
    gap: 1.5rem;
    margin-top: 1.25rem;
    padding: 1rem;
    background: rgba(255,255,255,0.03);
    border-radius: 6px;
  }

  .profile-stat {
    text-align: center;
  }
  .profile-stat-value {
    font-size: 1.25rem;
    font-weight: 500;
    color: #fff;
  }
  .profile-stat-label {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.4);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.2rem;
  }

  .profile-recent {
    margin-top: 1.5rem;
  }
  .profile-recent-title {
    font-size: 0.82rem;
    color: rgba(255,255,255,0.4);
    margin-bottom: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .profile-recent-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }
  .profile-recent-item {
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 4px;
    background: #121212;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .profile-recent-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  .profile-recent-item:hover img {
    transform: scale(1.05);
  }
  .profile-recent-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 1rem;
    color: rgba(255,255,255,0.3);
    font-size: 0.82rem;
  }

  .profile-actions {
    margin-top: 1.25rem;
    display: flex;
    gap: 0.75rem;
  }
  .profile-btn {
    flex: 1;
    padding: 0.65rem 1rem;
    border: 1px solid rgba(255,255,255,0.08);
    background: none;
    color: rgba(255,255,255,0.6);
    font-family: inherit;
    font-size: 0.82rem;
    border-radius: 4px;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
    text-decoration: none;
    text-align: center;
    display: block;
  }
  .profile-btn:hover {
    border-color: rgba(255,255,255,0.2);
    color: #fff;
  }
  .profile-btn-primary {
    background: #00d4aa;
    border-color: #00d4aa;
    color: #121212;
    font-weight: 500;
  }
  .profile-btn-primary:hover {
    background: #00f0c3;
    border-color: #00f0c3;
  }
</style>
