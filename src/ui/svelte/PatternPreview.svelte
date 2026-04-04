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
</script>

{#if appState.patternPreviewVisible}
  <div class="pattern-preview-window" class:collapsed={appState.patternPreviewCollapsed}>
    <button class="pattern-preview-header" onclick={toggleCollapse}>
      <span class="pattern-preview-title">Pattern</span>
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
        <canvas
          bind:this={canvasEl}
          id="patternPreviewCanvas"
          width="90"
          height="90"
        ></canvas>
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
    background: rgba(20, 23, 28, 0.6);
    border: none;
    border-radius: 5px;
    color: rgba(255, 255, 255, 0.75);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease, background 0.12s ease;
    white-space: nowrap;
    box-sizing: border-box;
    width: 100%;
  }

  .pattern-preview-header:hover {
    background: rgba(30, 34, 42, 0.75);
    color: rgba(255, 255, 255, 0.95);
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
    background: rgba(20, 23, 28, 0.6);
    border-radius: 5px;
    display: flex;
    justify-content: center;
  }

  canvas {
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(15, 17, 21, 0.8);
    border-radius: 3px;
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
</style>
