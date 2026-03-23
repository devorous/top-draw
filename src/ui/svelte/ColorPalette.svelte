<script>
  import { recentColors, customColors, currentColor } from '../../stores.js';
  import { addCustomColor as addCustomColorToStore, removeCustomColor as removeCustomColorFromStore } from '../../stores.js';

  export let onColorSelect = null;

  const maxRecentColors = 6;
  const maxCustomColors = 12;

  function colorToRgba(color) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})`;
  }

  function colorToHex(color) {
    const r = color[0].toString(16).padStart(2, '0');
    const g = color[1].toString(16).padStart(2, '0');
    const b = color[2].toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }

  function selectColor(color) {
    currentColor.set([...color]);
    if (onColorSelect) {
      onColorSelect(color);
    }
  }

  function handleAddCustom() {
    const current = $currentColor;
    if (onColorSelect) {
      onColorSelect((currentColor) => {
        addCustomColorToStore(currentColor);
      });
    } else {
      addCustomColorToStore(current);
    }
  }

  function handleRemoveCustom(color, event) {
    event.preventDefault();
    event.stopPropagation();
    removeCustomColorFromStore(color);
  }

  // Fill empty slots for recent colors
  $: recentSlots = Array.from({ length: maxRecentColors }, (_, i) =>
    i < $recentColors.length ? $recentColors[i] : null
  );
</script>

<div class="color-palette">
  <!-- Recent Colors -->
  <div class="palette-section">
    <label>Recent</label>
    <div class="swatch-grid">
      {#each recentSlots as color}
        {#if color}
          <button
            class="swatch"
            style="background-color: {colorToRgba(color)}"
            title={colorToHex(color)}
            on:click={() => selectColor(color)}
          ></button>
        {:else}
          <div class="swatch empty"></div>
        {/if}
      {/each}
    </div>
  </div>

  <!-- Custom Colors -->
  <div class="palette-section">
    <label>
      Custom <span class="palette-hint">(click + to save)</span>
    </label>
    <div class="swatch-grid">
      {#each $customColors as color}
        <button
          class="swatch"
          style="background-color: {colorToRgba(color)}"
          title="{colorToHex(color)} (right-click to remove)"
          on:click={() => selectColor(color)}
          on:contextmenu={(e) => handleRemoveCustom(color, e)}
        ></button>
      {/each}
      {#if $customColors.length < maxCustomColors}
        <button
          class="swatch add-swatch"
          title="Save current color"
          on:click={handleAddCustom}
        >+</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .color-palette {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .palette-section {
    display: flex;
    flex-direction: column;
  }

  .palette-section label {
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 0.5rem;
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
    gap: 0.375rem;
  }

  .swatch {
    aspect-ratio: 1;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    padding: 0;
    background: none;
  }

  .swatch:not(.empty):not(.add-swatch):hover {
    transform: scale(1.1);
    border-color: rgba(255, 255, 255, 0.3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .swatch:not(.empty):not(.add-swatch):active {
    transform: scale(0.95);
  }

  .swatch.empty {
    background: rgba(255, 255, 255, 0.03);
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
</style>
