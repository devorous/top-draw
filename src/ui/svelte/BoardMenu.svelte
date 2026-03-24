<script>
  import { appState } from '../../state.svelte.js';
  import { LayerPreview } from '../LayerPreview.js';

  let layerPreviewInstance = $state(null);
  let hoveredLayer = $state(null);
  let hoveredLayerBtn = $state(null);

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
    layerPreviewInstance = new LayerPreview();
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
  }

  function selectLayer(layerIdx) {
    appState.activeLayer = layerIdx;
  }

  function toggleLayerVis(layerIdx, event) {
    event.stopPropagation();
    appState.layerVisibility = {
      ...appState.layerVisibility,
      [layerIdx]: !appState.layerVisibility[layerIdx]
    };
  }

  function handleLayerHover(layerIdx, event) {
    if (!appState.layerManager || !layerPreviewInstance) return;

    hoveredLayer = layerIdx;
    hoveredLayerBtn = event.currentTarget;

    const rect = event.currentTarget.getBoundingClientRect();
    layerPreviewInstance.show(layerIdx, appState.layerManager, rect.left - 10, rect.top + rect.height / 2);
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
  <!-- Blend Mode Button -->
  <button
    class="menu-square"
    class:active={appState.boardMenuOpen === 'blend'}
    onclick={() => toggleMenu('blend')}
    title="Blend Mode"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="9" cy="9" r="7" opacity="0.5" />
      <circle cx="15" cy="15" r="7" opacity="0.5" />
    </svg>
  </button>

  <!-- Layers Button -->
  <button
    class="menu-square"
    class:active={appState.boardMenuOpen === 'layers'}
    onclick={() => toggleMenu('layers')}
    title="Layers"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  </button>

  <!-- Blend Mode Panel -->
  {#if appState.boardMenuOpen === 'blend'}
    <div class="menu-panel blend-panel">
      <div class="panel-header">Blend Mode</div>
      <div class="blend-mode-list">
        {#each blendModes as mode}
          <button
            class="blend-mode-option"
            class:active={appState.blendMode === mode.value}
            onclick={() => selectBlendMode(mode.value)}
          >
            {mode.label}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Layers Panel -->
  {#if appState.boardMenuOpen === 'layers'}
    <div class="menu-panel layers-panel">
      <div class="panel-header">Layers</div>
      <div class="layer-list">
        {#each layers as layer}
          <div class="layer-entry" data-layer={layer.index}>
            <button
              class="layer-visibility"
              class:hidden={!appState.layerVisibility[layer.index]}
              onclick={(e) => toggleLayerVis(layer.index, e)}
              title="Toggle visibility"
            >
              {appState.layerVisibility[layer.index] ? '👁' : '👁‍🗨'}
            </button>
            <button
              class="layer-button"
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
    </div>
  {/if}
</div>

<style>
  .board-menu {
    position: absolute;
    top: 12px;
    right: 12px;
    display: flex;
    gap: 8px;
    z-index: 100;
    pointer-events: all;
  }

  .menu-square {
    width: 44px;
    height: 44px;
    background: rgba(26, 26, 26, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.6);
    transition: all 0.15s ease;
    backdrop-filter: blur(8px);
  }

  .menu-square:hover {
    background: rgba(32, 32, 32, 0.95);
    border-color: rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.9);
  }

  .menu-square.active {
    background: rgba(0, 212, 170, 0.15);
    border-color: rgba(0, 212, 170, 0.4);
    color: #00d4aa;
  }

  .menu-panel {
    position: absolute;
    top: 0;
    right: 100px;
    min-width: 200px;
    background: rgba(26, 26, 26, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    backdrop-filter: blur(12px);
    overflow: hidden;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    animation: slideIn 0.15s ease;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(8px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .panel-header {
    padding: 12px 16px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.4);
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    background: rgba(0, 0, 0, 0.2);
  }

  /* Blend Mode Styles */
  .blend-mode-list {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .blend-mode-option {
    padding: 10px 12px;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.875rem;
    cursor: pointer;
    text-align: left;
    transition: all 0.1s ease;
    font-family: inherit;
  }

  .blend-mode-option:hover {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.9);
  }

  .blend-mode-option.active {
    background: rgba(0, 212, 170, 0.15);
    border-color: rgba(0, 212, 170, 0.3);
    color: #00d4aa;
  }

  /* Layer Styles */
  .layer-list {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .layer-entry {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .layer-visibility {
    width: 28px;
    height: 28px;
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.1s ease;
    flex-shrink: 0;
  }

  .layer-visibility:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .layer-visibility.hidden {
    opacity: 0.4;
  }

  .layer-button {
    flex: 1;
    padding: 8px 12px;
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.875rem;
    cursor: pointer;
    text-align: left;
    transition: all 0.1s ease;
    font-family: inherit;
  }

  .layer-button:hover {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.9);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .layer-button.active {
    background: rgba(0, 212, 170, 0.15);
    border-color: rgba(0, 212, 170, 0.3);
    color: #00d4aa;
  }
</style>
