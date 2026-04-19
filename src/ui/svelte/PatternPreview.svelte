<script>
  import { appState } from '../../state.svelte.js';

  let canvasEl = $state(null);

  // When canvas mounts (or re-mounts after uncollapse), trigger a preview update
  $effect(() => {
    if (canvasEl) {
      const patternTool = window.app?.toolManager?.getTool('pattern');
      if (patternTool) {
        patternTool.updatePreview(window.app.self);
      }
    }
  });

  function toggleCollapse() {
    appState.patternPreviewCollapsed = !appState.patternPreviewCollapsed;
  }

  const previewTitle = $derived(appState.patternPreviewMode === 'imageBrush' ? 'Brush Preview' : 'Pattern');
</script>

{#if appState.patternPreviewVisible}
  <div class="pattern-preview-window" class:collapsed={appState.patternPreviewCollapsed}>
    <button class="pattern-preview-header" onclick={toggleCollapse}>
      <span class="pattern-preview-title">{previewTitle}</span>
      <svg class="chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
        {#if appState.patternPreviewCollapsed}
          <polyline points="2,4 5,7 8,4" />
        {:else}
          <polyline points="2,7 5,4 8,7" />
        {/if}
      </svg>
    </button>
    {#if !appState.patternPreviewCollapsed}
      <div class="pattern-preview-body">
        {#if appState.patternPreviewMode === 'imageBrush' && appState.imageBrushPreviewUrl}
          <img
            class="image-preview"
            src={appState.imageBrushPreviewUrl}
            alt="Selected brush preview"
          />
        {:else}
          <canvas
            bind:this={canvasEl}
            id="patternPreviewCanvas"
            width="90"
            height="90"
          ></canvas>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .pattern-preview-window {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    margin-bottom: 1px;
    animation: fadeDown 0.12s ease;
  }

  @keyframes fadeDown {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .pattern-preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 5px;
    height: 24px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border: none;
    border-radius: 5px;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
    white-space: nowrap;
    box-sizing: border-box;
    width: 100%;
  }

  .pattern-preview-header:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    color: var(--text-primary);
  }

  .collapsed .pattern-preview-header {
    border-radius: 5px;
  }

  .chevron {
    flex-shrink: 0;
  }

  .pattern-preview-body {
    margin-top: 1px;
    padding: 3px;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border-radius: 5px;
    display: flex;
    justify-content: center;
  }

  canvas {
    border: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-primary) 88%, black);
    border-radius: 3px;
    display: block;
    width: 90px;
    height: 90px;
    flex: 0 0 90px;
  }

  .image-preview {
    border: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-primary) 88%, black);
    border-radius: 3px;
    display: block;
    width: 90px;
    height: 90px;
    flex: 0 0 90px;
    object-fit: contain;
    padding: 6px;
    box-sizing: border-box;
  }
</style>
