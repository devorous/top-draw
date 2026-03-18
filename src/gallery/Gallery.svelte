<script>
  import { onMount } from 'svelte';

  let items = [];
  let loading = true;
  let error = null;
  let page = 1;
  let totalPages = 1;
  let lightbox = null;
  let likedIds = new Set(JSON.parse(localStorage.getItem('ddraw_liked') || '[]'));

  async function fetchGallery() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/gallery?page=${page}&limit=24`);
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

  async function like(item) {
    if (likedIds.has(item.id)) return;
    likedIds.add(item.id);
    likedIds = likedIds;
    localStorage.setItem('ddraw_liked', JSON.stringify([...likedIds]));
    item.likes = (item.likes || 0) + 1;
    items = items;

    try {
      await fetch(`/api/gallery/${item.id}/like`, { method: 'POST' });
    } catch {}
  }

  function openLightbox(item) {
    lightbox = item;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox = null;
    document.body.style.overflow = '';
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') closeLightbox();
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

  onMount(fetchGallery);
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
    </div>
  </nav>

  <header>
    <h1>Gallery</h1>
    <p>Artwork made by the ddraw community</p>
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
              <img src={item.url} alt={item.title || 'artwork'} loading="lazy">
            </div>
            <div class="card-meta">
              <div class="card-author">{item.author}</div>
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
  <div class="lightbox-backdrop" on:click={closeLightbox}>
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
          <span class="lb-author">by {lightbox.author}</span>
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
          <a href={lightbox.url} download target="_blank" rel="noopener" class="btn-ghost small">Download</a>
        </div>
      </div>
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
    gap: 2rem;
    font-size: 0.85rem;
    letter-spacing: 0.05em;
    font-weight: 400;
  }
  .nav-active { color: var(--text-dim); }
  .nav-cta { color: var(--accent); }

  /* ── Header ── */
  header {
    padding: 4rem 3rem 2rem;
    border-bottom: 1px solid var(--border);
  }
  header h1 {
    font-family: 'Inter', sans-serif;
    
    font-weight: 400;
    font-size: clamp(2.5rem, 5vw, 4rem);
    letter-spacing: -0.02em;
    margin-bottom: 0.5rem;
  }
  header p { color: var(--text-dim); font-size: 0.9rem; }

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
    border-color: #3a3632;
    transform: translateY(-2px);
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
  .card:hover .card-img img { transform: scale(1.03); }

  .card-meta {
    padding: 0.65rem 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--bg2);
    border-top: 1px solid var(--border);
  }
  .card-author { font-size: 0.8rem; color: var(--text-dim); }

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
    background: #0a0908;
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

  .lb-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    nav, header, main, footer { padding-left: 1.25rem; padding-right: 1.25rem; }
    header { padding-top: 2.5rem; }
    .grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
  }
</style>
