<script>
  import { tick } from 'svelte';
  import { appState } from '../../state.svelte.js';

  let canvasEl = $state(null);
  let previewRequestId = 0;

  async function requestPreviewUpdate() {
    const requestId = ++previewRequestId;
    await tick();
    await new Promise(resolve => requestAnimationFrame(resolve));

    if (requestId !== previewRequestId || !canvasEl || appState.toolPreviewCollapsed) return;

    const toolName = appState.toolPreviewMode === 'pattern' ? 'pattern' : appState.toolPreviewMode;
    const previewTool = window.app?.toolManager?.getTool(toolName);
    previewTool?.updatePreview?.(window.app?.self);
  }

  // When canvas mounts, re-mounts, or switches mode, draw after the DOM has applied
  // the canvas dimensions that each preview renderer relies on.
  $effect(() => {
    if (canvasEl && appState.toolPreviewVisible && !appState.toolPreviewCollapsed) {
      appState.toolPreviewMode;
      requestPreviewUpdate();
    }
  });

  function toggleCollapse() {
    appState.toolPreviewCollapsed = !appState.toolPreviewCollapsed;
  }

  const previewTitle = $derived('Preview');
  const isPatternPreview = $derived(appState.toolPreviewMode === 'pattern');
</script>

{#if appState.toolPreviewVisible}
  <div class="tool-preview-window" class:collapsed={appState.toolPreviewCollapsed}>
    {#if appState.toolPreviewCollapsed}
      <button type="button" class="tool-preview-header" onclick={toggleCollapse}>
        <span class="tool-preview-title">{previewTitle}</span>
        <svg class="chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
          <polyline points="2,4 5,7 8,4" />
        </svg>
      </button>
    {:else}
      <button type="button" class="tool-preview-body" onclick={toggleCollapse} aria-label="Close preview">
        <canvas
          bind:this={canvasEl}
          id="toolPreviewCanvas"
          class:stroke-preview={!isPatternPreview}
          width={isPatternPreview ? 80 : 140}
          height={isPatternPreview ? 80 : 52}
        ></canvas>
      </button>
    {/if}
  </div>
{/if}

<style>
  .tool-preview-window {
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

  .tool-preview-header {
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

  .tool-preview-header:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    color: var(--text-primary);
  }

  .collapsed .tool-preview-header {
    border-radius: 5px;
  }

  .chevron {
    flex-shrink: 0;
  }

  .tool-preview-body {
    margin-top: 0;
    padding: 3px;
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border: none;
    border-radius: 5px;
    display: flex;
    justify-content: center;
    cursor: pointer;
    width: 100%;
    box-sizing: border-box;
    transition: background 0.12s ease;
  }

  .tool-preview-body * {
    cursor: pointer;
  }

  .tool-preview-body:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
  }

  canvas {
    border: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-primary) 88%, black);
    border-radius: 3px;
    display: block;
    width: 80px;
    height: 80px;
    flex: 0 0 80px;
    cursor: pointer;
  }

  canvas.stroke-preview {
    width: 140px;
    height: 52px;
    flex-basis: 140px;
  }

  @media (max-width: 768px) {
    canvas {
      width: 70px;
      height: 70px;
      flex: 0 0 70px;
    }

    canvas.stroke-preview {
      width: 120px;
      height: 44px;
      flex-basis: 120px;
    }
  }

  @media (max-width: 480px) {
    canvas {
      width: 60px;
      height: 60px;
      flex: 0 0 60px;
    }

    canvas.stroke-preview {
      width: 100px;
      height: 36px;
      flex-basis: 100px;
    }
  }
</style>
