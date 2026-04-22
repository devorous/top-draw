<script>
  import { appState, addCustomColor, getCustomPresetKey, removeCustomColor } from '../../state.svelte.js';

  let { onColorSelect = null } = $props();

  const maxRecentColors = 6;
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

  // Fill empty slots for recent colors
  let recentSlots = $derived(
    Array.from({ length: maxRecentColors }, (_, i) =>
      i < appState.recentColors.length ? appState.recentColors[i] : null
    )
  );
</script>

<div class="color-palette">
  <!-- Recent Colors -->
  <div class="palette-section">
    <span class="palette-section-title">Recent</span>
    <div class="swatch-grid">
      {#each recentSlots as color}
        {#if color}
          <button
            class="swatch"
            style="background-color: {colorToRgba(color)}"
            title={colorToHex(color)}
            onclick={() => selectColor(color)}
          ></button>
        {:else}
          <div class="swatch empty"></div>
        {/if}
      {/each}
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
            onclick={() => selectPreset(preset)}
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
          onclick={handleAddCustom}
        >+</button>
      {/if}
    </div>
  </div>
</div>

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
