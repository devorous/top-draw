<script>
  import { appState } from '../../state.svelte.js';

  /** @type {{ item: any, x: number, y: number, liked?: boolean, likesCount?: number, onLike?: (item: any) => Promise<void>, onComment?: (id: string) => void }} */
  let { item, x, y, liked = false, likesCount = 0, onLike = null, onComment = null } = $props();
  let liking = $state(false);

  async function handleLike() {
    if (!onLike || liking) return;

    liking = true;
    try {
      await onLike(item);
    } finally {
      liking = false;
    }
  }

  function handleComment() {
    if (onComment) {
      onComment(item.id);
    }
  }

  function handleImageClick() {
    // Open gallery item modal
    appState.galleryItemDialog = {
      visible: true,
      itemId: item.id
    };
  }
</script>

<div class="floating-art" style="left: {x}px; top: {y}px;">
  <div class="art-card">
    <button class="art-image" onclick={handleImageClick} title={item.title || 'Untitled'}>
      <img src={item.thumbUrl || item.url} alt={item.title || 'Art'} loading="lazy" />
    </button>

    <div class="art-footer">
      <button
        class="art-action-btn like-btn"
        class:liked={liked}
        disabled={liking}
        onclick={handleLike}
        title="Like"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 14L7.2 13.3C3.4 9.9 1 7.7 1 5C1 2.8 2.8 1 5 1C6.4 1 7.7 1.7 8 2.8C8.3 1.7 9.6 1 11 1C13.2 1 15 2.8 15 5C15 7.7 12.6 9.9 8.8 13.3L8 14Z"
            fill={liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
        <span class="like-count">{likesCount}</span>
      </button>
      <span class="art-author">{item.author}</span>
    </div>
  </div>
</div>

<style>
  .floating-art {
    position: absolute;
    pointer-events: auto;
    animation: fadeIn 0.3s ease-out;
    z-index: 4;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.9);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .art-card {
    background: var(--color-bg-secondary, #222);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    width: 180px;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .art-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
  }

  .art-image {
    width: 100%;
    height: 140px;
    padding: 0;
    margin: 0;
    border: none;
    background: var(--color-bg-tertiary, #1a1a1a);
    cursor: pointer;
    display: block;
  }

  .art-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .art-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 10px;
    background: var(--color-bg-secondary, #222);
  }

  .art-action-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: none;
    background: var(--color-bg-tertiary, #1a1a1a);
    color: var(--color-text-secondary, #aaa);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.2s, color 0.2s;
  }

  .art-action-btn:hover {
    background: var(--color-bg-hover, #333);
    color: var(--color-text-primary, #fff);
  }

  .art-action-btn:disabled {
    opacity: 0.7;
    cursor: wait;
  }

  .like-btn.liked {
    color: #ff6b6b;
  }

  .like-count {
    font-weight: 500;
  }

  .art-author {
    font-size: 11px;
    color: var(--color-text-secondary, #aaa);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
