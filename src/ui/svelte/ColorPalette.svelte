<script>
  import { appState, addCustomColor, getCustomPresetKey, removeCustomColor } from '../../state.svelte.js';

  let { onColorSelect = null } = $props();
  let palettesOpen = $state(false);
  let palettesTrigger = $state(null);
  let paletteMenuHost = $state(null);
  let paletteMenuElement = $state(null);

  const maxCustomColors = 12;

  const TOOL_ICON_URLS = {
    brush: '/images/brush-icon.svg',
    flowPen: '/images/brush-icon.svg',
    ink: '/images/brush-icon.svg',
    pixel: '/images/brush-icon.svg',
    line: '/images/line-icon.svg',
    rectangle: '/images/rectangle-icon.svg',
    circle: '/images/circle-icon.svg',
    text: '/images/text-icon.svg',
    erase: '/images/eraser-icon.svg',
    blur: '/images/blend-icon.svg',
    circleBlur: '/images/circle-blur-icon.svg',
    glitchBlur: '/images/glitch-icon.svg',
    fill: '/images/fillbucket-icon.svg',
    select: '/images/select-icon.svg',
    imageBrush: '/images/pepper.png',
    pattern: '/images/pattern-icon.svg',
    inkdropper: '/images/inkdropper-icon.svg',
    pan: '/images/move-icon.svg',
    zoom: '/images/magnifying-glass.svg',
    rotate: '/images/rotate-icon.svg'
  };
  const COLORLESS_TOOLS = new Set(['erase', 'blur', 'circleBlur', 'glitchBlur', 'select', 'pan', 'zoom', 'rotate', 'inkdropper']);

  function colorToRgba(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`;
  }

  function colorToHex(color) {
    const r = color[0].toString(16).padStart(2, '0');
    const g = color[1].toString(16).padStart(2, '0');
    const b = color[2].toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }

  function getToolIconUrl(tool) {
    return TOOL_ICON_URLS[tool] || null;
  }

  function colorsEqual(a, b) {
    return Array.isArray(a) &&
      Array.isArray(b) &&
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2] &&
      a[3] === b[3];
  }

  function settingsEqual(a, b) {
    const left = a || {};
    const right = b || {};
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => left[key] === right[key]);
  }

  function isPresetSelected(preset) {
    if (!preset?.color) {
      return false;
    }

    if (!COLORLESS_TOOLS.has(preset.tool) && !colorsEqual(preset.color, appState.currentColor)) {
      return false;
    }

    if (preset.tool && preset.tool !== appState.currentTool) {
      return false;
    }

    if (preset.size != null && preset.size !== appState.currentSize) {
      return false;
    }

    const selectedByClick = getCustomPresetKey(preset) === appState.activeCustomPresetKey;
    if (!preset.settings) {
      return selectedByClick;
    }

    return selectedByClick && settingsEqual(preset.settings, appState.currentToolSettings);
  }

  function selectColor(color) {
    appState.currentColor = [...color];
    appState.activeCustomPresetKey = null;
    if (onColorSelect) {
      onColorSelect(color);
    }
  }

  function selectPreset(preset) {
    appState.currentColor = [...preset.color];
    appState.activeCustomPresetKey = getCustomPresetKey(preset);
    if (onColorSelect) {
      onColorSelect(preset);
    }
  }

  function handleAddCustom() {
    const current = appState.currentColor;
    if (onColorSelect) {
      onColorSelect((currentColor, settings) => {
        addCustomColor(currentColor, settings);
      });
    } else {
      addCustomColor(current);
    }
  }

  function handleRemoveCustom(preset, event) {
    event.preventDefault();
    event.stopPropagation();
    removeCustomColor(preset);
  }

  function toggleRecentPalette() {
    appState.recentPaletteVisible = !appState.recentPaletteVisible;
  }

  function togglePalettesMenu() {
    palettesOpen = !palettesOpen;
  }

  function handleAddFloatingPalette() {
    const nextIndex = appState.floatingPalettes.length + 1;
    appState.floatingPalettes = [
      ...appState.floatingPalettes,
      {
        id: `floating-palette-${Date.now()}`,
        name: `Palette ${nextIndex}`,
        colors: []
      }
    ];
  }

  function paletteMenuStyle() {
    const rect = palettesTrigger?.getBoundingClientRect?.();
    if (!rect) {
      return '';
    }

    return [
      `left: ${rect.left}px`,
      `top: ${rect.bottom + 3}px`,
      `width: ${rect.width}px`
    ].join('; ');
  }

  $effect(() => {
    if (typeof document === 'undefined' || !palettesOpen) {
      return;
    }

    const handlePointerDown = (event) => {
      if (
        !event.target?.closest?.('.palette-menu-wrap') &&
        !event.target?.closest?.('.palette-menu')
      ) {
        palettesOpen = false;
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  });

  $effect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const host = document.createElement('div');
    host.className = 'palette-menu-portal-host';
    document.body.appendChild(host);
    paletteMenuHost = host;

    return () => {
      host.remove();
      paletteMenuHost = null;
    };
  });

  $effect(() => {
    if (!paletteMenuHost || !paletteMenuElement) {
      return;
    }

    paletteMenuHost.appendChild(paletteMenuElement);

    return () => {
      paletteMenuElement?.remove();
    };
  });
</script>

<div class="color-palette">
  <!-- Palette Controls -->
  <div class="palette-controls">
    <div class="palette-menu-wrap">
      <button
        bind:this={palettesTrigger}
        class="palette-select"
        class:open={palettesOpen}
        onclick={togglePalettesMenu}
        aria-haspopup="menu"
        aria-expanded={palettesOpen}
        title="Manage floating palettes"
      >
        <span>Palettes</span>
        <span class="palette-toggle-icon">▾</span>
      </button>

    </div>
  </div>

  <!-- Custom Colors -->
  <div class="palette-section">
    <span class="palette-section-title">
      Custom <span class="palette-hint">(click + to save)</span>
    </span>
    <div class="swatch-grid">
      {#each appState.customColors as preset}
        <div class="custom-swatch-wrap">
          <button
            class="swatch"
            class:selected={isPresetSelected(preset)}
            style="background-color: {colorToRgba(preset.color)}"
            title="{colorToHex(preset.color)} (right-click to remove)"
            onpointerup={() => selectPreset(preset)}
            oncontextmenu={(e) => handleRemoveCustom(preset, e)}
          >
            {#if preset.tool && getToolIconUrl(preset.tool)}
              <img src={getToolIconUrl(preset.tool)} alt={preset.tool} class="tool-icon-overlay" />
            {/if}
          </button>
        </div>
      {/each}
      {#if appState.customColors.length < maxCustomColors}
        <button
          class="swatch add-swatch"
          title="Save current color"
          onpointerup={handleAddCustom}
        >+</button>
      {/if}
    </div>
  </div>
</div>

{#if palettesOpen}
  <div bind:this={paletteMenuElement} class="palette-menu" role="menu" style={paletteMenuStyle()}>
    <button
      class="palette-menu-item"
      class:active={appState.recentPaletteVisible}
      onclick={toggleRecentPalette}
      role="menuitemcheckbox"
      aria-checked={appState.recentPaletteVisible}
    >
      <span>Recents</span>
      <span class="palette-menu-state">{appState.recentPaletteVisible ? 'On' : 'Off'}</span>
    </button>

    {#each appState.floatingPalettes as palette}
      <button class="palette-menu-item" role="menuitem" title={palette.name}>
        <span>{palette.name}</span>
        <span class="palette-menu-state">{palette.colors.length}</span>
      </button>
    {/each}

    <button class="palette-menu-add" onclick={handleAddFloatingPalette} role="menuitem" title="Add floating palette">
      <span class="palette-add-icon">+</span>
      <span>Add palette</span>
    </button>
  </div>
{/if}

<style>
  .color-palette {
    display: flex;
    flex-direction: column;
    border-top: 2px solid var(--bg-secondary);
    gap: 0.2rem;
    padding: 0.25rem 0.675rem;
  }

  .palette-section {
    display: flex;
    flex-direction: column;
  }

  .palette-section-title {
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 0.15rem;
  }

  .palette-hint {
    font-size: 0.7rem;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.6;
  }

  .palette-controls {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    padding-top: 0.25rem;
  }

  .palette-menu-wrap {
    position: relative;
    flex: 1;
    z-index: 1;
  }

  .palette-select {
    appearance: none;
    width: 100%;
    height: 30px;
    padding: 0 0.45rem 0 0.55rem;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.18);
  }

  .palette-select:hover,
  .palette-select.open {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.9);
  }

  .palette-select:active {
    background: rgba(255, 255, 255, 0.15);
  }

  .palette-toggle-icon {
    display: inline-block;
    margin-left: 0.25rem;
    font-size: 0.85rem;
    line-height: 1;
  }

  .palette-menu {
    position: fixed;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.38);
    pointer-events: auto;
  }

  .palette-menu-item,
  .palette-menu-add {
    min-height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 0.75rem;
  }

  .palette-menu-item:hover,
  .palette-menu-add:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.92);
  }

  .palette-menu-item.active {
    color: var(--accent-primary);
  }

  .palette-menu-state {
    font-size: 0.68rem;
    color: rgba(255, 255, 255, 0.46);
  }

  .palette-menu-add {
    justify-content: flex-start;
    color: var(--accent-primary);
  }

  .palette-add-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 212, 170, 0.12);
    font-size: 1rem;
    line-height: 1;
  }

  .swatch-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 2px;
  }

  .swatch {
    aspect-ratio: 1;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    padding: 0;
    background: none;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .swatch:not(.empty):not(.add-swatch):hover {
    transform: scale(1.1);
    border-color: rgba(255, 255, 255, 0.3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .swatch.selected {
    border-color: var(--accent-primary);
    box-shadow:
      0 0 0 1px var(--bg-secondary),
      0 0 0 3px color-mix(in srgb, var(--accent-primary) 75%, transparent),
      0 2px 8px rgba(0, 0, 0, 0.35);
  }

  .swatch.selected:hover {
    border-color: var(--accent-primary);
  }

  .swatch:not(.empty):not(.add-swatch):active {
    transform: scale(0.95);
  }

  .swatch.empty {
    background: rgba(255, 255, 255, 0.25);
    border-color: rgba(255, 255, 255, 0.05);
    cursor: default;
  }

  .swatch.add-swatch {
    background: rgba(0, 212, 170, 0.1);
    border-color: rgba(0, 212, 170, 0.2);
    color: #00d4aa;
    font-size: 1.25rem;
    font-weight: 300;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .swatch.add-swatch:hover {
    background: rgba(0, 212, 170, 0.2);
    border-color: rgba(0, 212, 170, 0.4);
    transform: scale(1.05);
  }

  .custom-swatch-wrap {
    position: relative;
  }

  .tool-icon-overlay {
    width: 10px;
    height: 10px;
    filter: brightness(0) invert(1);
    opacity: 0.8;
    pointer-events: none;
  }
</style>
