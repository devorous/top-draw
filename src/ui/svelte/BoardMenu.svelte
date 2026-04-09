<script>
  import { appState, toggleSnapshotMenu } from '../../state.svelte.js';
  import { LayerPreview } from '../LayerPreview.js';
  import PatternPreview from './PatternPreview.svelte';

  let { onBlendModeChange = null, onLayerSelect = null, onLayerVisibilityToggle = null } = $props();

  let layerPreviewInstance = null;
  let hoveredLayer = null;
  let hoveredLayerBtn = null;

  let blendModeAllowed = $derived(appState.activeLayer === 0);
  let isHelper = $derived(appState.selfRole >= 3);

  const blendModes = [
    { value: 'source-over', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'lighter', label: 'Add' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'difference', label: 'Difference' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'color-burn', label: 'Color Burn' }
  ];

  const layers = [
    { index: 2, label: 'Layer 3' },
    { index: 1, label: 'Layer 2' },
    { index: 0, label: 'Layer 1' }
  ];

  $effect(() => {
    const preview = new LayerPreview();
    preview.init();
    layerPreviewInstance = preview;
    return () => { layerPreviewInstance = null; };
  });

  $effect(() => {
    function handleClickOutside(event) {
      const target = event.target;
      if (!target.closest('.board-menu') && appState.boardMenuOpen) {
        appState.boardMenuOpen = null;
      }
    }
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  });

  function toggleMenu(menuType) {
    appState.boardMenuOpen = appState.boardMenuOpen === menuType ? null : menuType;
  }

  function selectBlendMode(mode) {
    appState.blendMode = mode;
    appState.boardMenuOpen = null;
    if (onBlendModeChange) onBlendModeChange(mode);
  }

  function selectLayer(layerIdx) {
    appState.activeLayer = layerIdx;
    if (layerIdx !== 0 && appState.boardMenuOpen === 'blend') {
      appState.boardMenuOpen = null;
    }
    if (onLayerSelect) onLayerSelect(layerIdx);
  }

  function toggleLayerVis(layerIdx, event) {
    event.stopPropagation();
    if (onLayerVisibilityToggle) {
      const newVisible = onLayerVisibilityToggle(layerIdx);
      appState.layerVisibility = { ...appState.layerVisibility, [layerIdx]: newVisible };
    } else {
      appState.layerVisibility = {
        ...appState.layerVisibility,
        [layerIdx]: !appState.layerVisibility[layerIdx]
      };
    }
  }

  function handleLayerHover(layerIdx, event) {
    const liveLayerManager = appState.board?.layerManager || appState.layerManager;
    if (!liveLayerManager || !layerPreviewInstance) return;

    hoveredLayer = layerIdx;
    hoveredLayerBtn = event.currentTarget;

    const rect = event.currentTarget.getBoundingClientRect();
    layerPreviewInstance.show(layerIdx, liveLayerManager, rect.left, rect.top + rect.height / 2);
  }

  function handleLayerLeave() {
    hoveredLayer = null;
    hoveredLayerBtn = null;
    if (layerPreviewInstance) {
      layerPreviewInstance.hide();
    }
  }
</script>

<div class="board-menu">
  <!-- Pattern Preview (collapsible, above layers) -->
  <PatternPreview />

  <!-- Layers (always visible, no frame) -->
  <div class="layer-list">
    {#each layers as layer}
      <div class="layer-row">
        <button
          class="eye-btn"
          class:faded={!appState.layerVisibility[layer.index]}
          onclick={(e) => toggleLayerVis(layer.index, e)}
          title="Toggle visibility"
        >
          {#if appState.layerVisibility[layer.index]}
            <img src="/images/eye-open.svg" alt="Visible" width="14" height="14" style="filter: invert(1) brightness(1.5);" />
          {:else}
            <img src="/images/eye-closed.svg" alt="Hidden" width="14" height="14" />
          {/if}
        </button>
        <button
          class="layer-btn"
          class:active={appState.activeLayer === layer.index}
          onclick={() => selectLayer(layer.index)}
          onmouseenter={(e) => handleLayerHover(layer.index, e)}
          onmouseleave={handleLayerLeave}
        >
          {layer.label}
        </button>
      </div>
    {/each}
  </div>

  <!-- Blend Mode Button + Dropdown (only on Layer 1) -->
  {#if blendModeAllowed}
  <div class="blend-wrap">
    <button
      class="blend-btn"
      class:open={appState.boardMenuOpen === 'blend'}
      onclick={() => toggleMenu('blend')}
      title="Blend Mode"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="9" cy="9" r="7" opacity="0.6" />
        <circle cx="15" cy="15" r="7" opacity="0.6" />
      </svg>
      <span>{blendModes.find(m => m.value === appState.blendMode)?.label ?? 'Normal'}</span>
    </button>

    {#if appState.boardMenuOpen === 'blend'}
      <div class="blend-dropdown">
        {#each blendModes as mode}
          <button
            class="blend-option"
            class:active={appState.blendMode === mode.value}
            onclick={() => selectBlendMode(mode.value)}
          >
            {mode.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {/if}

  <!-- Snapshot/History Button (Helper+) -->
  {#if isHelper}
  <div class="history-wrap">
    <button
      class="history-btn"
      onclick={toggleSnapshotMenu}
      title="Board History / Snapshots"
    >
      <img src="/images/undo-icon.svg" alt="History" width="14" height="14" style="filter: invert(1) brightness(1.5);" />
      <span>History</span>
    </button>
  </div>
  {/if}
</div>

<style>
  .board-menu {
    position: absolute;
    top: 60px;
    right: 12px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    z-index: 50;
    pointer-events: all;
  }

  :global(html[data-sidebar-side='left']) .board-menu {
    left: 12px;
    right: auto;
    align-items: flex-start;
  }

  /* ── Blend mode ── */
  .blend-wrap {
    position: relative;
  }

  .blend-btn {
    display: flex;
    align-items: center;
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
  }
  .blend-btn:hover {
    background: rgba(30, 34, 42, 0.75);
    color: rgba(255, 255, 255, 0.95);
  }

  .blend-btn.open {
    background: rgba(0, 212, 170, 0.15);
    color: #00d4aa;
  }

  .blend-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 130px;
    background: rgba(26, 29, 35, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 7px;
    backdrop-filter: blur(12px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: fadeDown 0.12s ease;
  }

  :global(html[data-sidebar-side='left']) .blend-dropdown {
    left: 0;
    right: auto;
  }

  @keyframes fadeDown {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .blend-option {
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s ease, color 0.1s ease;
  }

  .blend-option:hover {
    background: rgba(255, 255, 255, 0.07);
    color: rgba(255, 255, 255, 0.9);
  }

  .blend-option.active {
    color: #00d4aa;
    background: rgba(0, 212, 170, 0.1);
  }

  /* ── Layers ── */
  .layer-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .layer-row {
    display: flex;
    align-items: center;
    gap: 0;
    background: rgba(20, 23, 28, 0.6);
    border-radius: 5px;
    overflow: hidden;
  }

  .eye-btn {
    width: 24px;
    height: 24px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.6);
    transition: color 0.1s ease;
    padding: 0;
    flex-shrink: 0;
  }

  .eye-btn:hover {
    color: rgba(255, 255, 255, 0.95);
  }

  .eye-btn.faded {
    opacity: 0.3;
  }

  .layer-btn {
    padding: 3px 8px 3px 2px;
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.75);
    font-size: 0.75rem;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: color 0.1s ease;
    white-space: nowrap;
  }

  .layer-btn:hover {
    color: rgba(255, 255, 255, 0.95);
  }

  .layer-btn.active {
    color: #00d4aa;
  }

  /* ── History ── */
  .history-wrap {
    margin-top: 4px;
  }

  .history-btn {
    display: flex;
    align-items: center;
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
  }

  .history-btn:hover {
    background: rgba(30, 34, 42, 0.75);
    color: rgba(255, 255, 255, 0.95);
  }
</style>
