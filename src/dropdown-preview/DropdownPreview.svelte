<script>
  /**
   * @fileoverview Dev-only gallery for comparing Dropdown trigger variants
   * side by side against the app's real theme tokens.
   * Served at /dropdown-preview/ by the dev server; not a production entry.
   */

  import Dropdown from '../ui/svelte/Dropdown.svelte';

  const VARIANTS = [
    { id: 'flat', name: 'Flat', note: 'ADOPTED — the app default. Translucent white, no fill until hover. Cursor, Font, Right Click and Palettes all use this.' },
    { id: 'panel', name: 'Panel', note: 'Solid field. Held in reserve for dialogs where flat reads as too faint.' },
    { id: 'accent', name: 'Accent', note: 'Loudest. Gradient + teal edge. Was the old Font/Cursor look. One per panel, at most.' },
    { id: 'inset', name: 'Inset', note: 'Recessed well. Sits naturally in a row of sliders, reads as "editable value".' },
    { id: 'ghost', name: 'Ghost', note: 'No chrome until hover. For dense toolbars where a border per control is too much.' }
  ];

  const RIGHT_CLICK_OPTIONS = [
    { value: 'cancel', label: 'Cancel Stroke' },
    { value: 'layerMode', label: 'Toggle Layer Mode' },
    { value: 'eyedropper', label: 'Pick Colour' },
    { value: 'zoom', label: 'Zoom Drag' },
    { value: 'none', label: 'Nothing' }
  ];

  const CURSOR_OPTIONS = [
    { value: 'circle', label: 'Circle' },
    { value: 'crosshair', label: 'Crosshair' },
    { value: 'dot', label: 'Dot' },
    { value: 'square', label: 'Square' }
  ];

  const LONG_OPTIONS = [
    { value: 'normal', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'color-dodge', label: 'Colour Dodge' },
    { value: 'color-burn', label: 'Colour Burn' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'hue', label: 'Hue', disabled: true },
    { value: 'saturation', label: 'Saturation', disabled: true }
  ];

  // One value per variant so each card is independently clickable.
  let values = $state(Object.fromEntries(VARIANTS.map(v => [v.id, 'cancel'])));
  let sidebarValues = $state({ rightClick: 'cancel', cursor: 'circle', blend: 'normal', palette: 'default' });
  let size = $state('sm');
  let width = $state(200);
</script>

<div class="page">
  <header>
    <h1>Dropdown variants</h1>
    <p>
      One component, one menu, five trigger looks. <strong>Flat is the adopted default</strong> and is now
      live on the Cursor select, the Font select, the Right Click select and the Palettes menu.
      The other variants stay available for cases where flat is too quiet.
    </p>

    <div class="controls">
      <label>
        Size
        <select bind:value={size}>
          <option value="sm">sm — 28px (tool options)</option>
          <option value="md">md — 34px (dialogs)</option>
        </select>
      </label>
      <label>
        Container width
        <input type="range" min="120" max="320" step="4" bind:value={width} />
        <span class="num">{width}px</span>
      </label>
    </div>
  </header>

  <section class="grid">
    {#each VARIANTS as variant}
      <article class="card">
        <div class="card-head">
          <h2>{variant.name}</h2>
          <code>variant="{variant.id}"</code>
        </div>
        <p class="note">{variant.note}</p>

        <div class="demo" style="width:{width}px">
          <div class="field">
            <span class="field-label">Right Click</span>
            <Dropdown
              variant={variant.id}
              {size}
              options={RIGHT_CLICK_OPTIONS}
              value={values[variant.id]}
              onchange={(v) => (values[variant.id] = v)}
              ariaLabel="Right click action"
            />
          </div>

          <div class="field">
            <span class="field-label">Long list + disabled rows</span>
            <Dropdown
              variant={variant.id}
              {size}
              options={LONG_OPTIONS}
              value="normal"
              onchange={() => {}}
              ariaLabel="Blend mode"
            />
          </div>

          <div class="field">
            <span class="field-label">Uppercase label</span>
            <Dropdown
              variant={variant.id}
              {size}
              uppercase
              options={[{ value: 'default', label: 'Palettes' }, { value: 'warm', label: 'Warm' }]}
              value="default"
              onchange={() => {}}
              ariaLabel="Palettes"
            />
          </div>

          <div class="field">
            <span class="field-label">Disabled</span>
            <Dropdown
              variant={variant.id}
              {size}
              disabled
              options={CURSOR_OPTIONS}
              value="circle"
              onchange={() => {}}
              ariaLabel="Cursor style"
            />
          </div>
        </div>
      </article>
    {/each}
  </section>

  <section class="insitu">
    <h2>In situ — mock tool options column</h2>
    <p class="note">
      The same four controls a real sidebar shows, so you can judge rhythm rather than isolated chips.
      Change the variant to compare.
    </p>

    <div class="insitu-row">
      {#each VARIANTS as variant}
        <div class="mock-sidebar">
          <div class="mock-title">{variant.name}</div>

          <div class="mock-slider">
            <div class="mock-slider-label">Size <span>24</span></div>
            <div class="mock-track"><div class="mock-fill"></div></div>
          </div>
          <div class="mock-slider">
            <div class="mock-slider-label">Opacity <span>100%</span></div>
            <div class="mock-track"><div class="mock-fill wide"></div></div>
          </div>

          <div class="field">
            <span class="field-label">Cursor</span>
            <Dropdown
              variant={variant.id}
              size="sm"
              options={CURSOR_OPTIONS}
              value={sidebarValues.cursor}
              onchange={(v) => (sidebarValues.cursor = v)}
              ariaLabel="Cursor style"
            />
          </div>

          <div class="field">
            <span class="field-label">Right Click</span>
            <Dropdown
              variant={variant.id}
              size="sm"
              options={RIGHT_CLICK_OPTIONS}
              value={sidebarValues.rightClick}
              onchange={(v) => (sidebarValues.rightClick = v)}
              ariaLabel="Right click action"
            />
          </div>

          <div class="field">
            <span class="field-label">Blend Mode</span>
            <Dropdown
              variant={variant.id}
              size="sm"
              options={LONG_OPTIONS}
              value={sidebarValues.blend}
              onchange={(v) => (sidebarValues.blend = v)}
              ariaLabel="Blend mode"
            />
          </div>
        </div>
      {/each}
    </div>
  </section>

  <footer>
    <p>
      Keyboard: <kbd>Space</kbd>/<kbd>Enter</kbd> open · <kbd>↑</kbd><kbd>↓</kbd> move ·
      <kbd>Home</kbd>/<kbd>End</kbd> jump · type to search · <kbd>Esc</kbd> close.
      The menu is portaled to <code>&lt;body&gt;</code>, so sidebar overflow can't clip it.
    </p>
  </footer>
</div>

<style>
  .page {
    max-width: 1500px;
    margin: 0 auto;
    padding: 32px 24px 64px;
    color: var(--text-primary);
    font-family: 'Inter', system-ui, sans-serif;
  }

  h1 {
    margin: 0 0 8px;
    font-size: 1.6rem;
    font-weight: 700;
  }

  h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }

  header > p {
    max-width: 70ch;
    margin: 0 0 20px;
    color: var(--text-secondary);
    font-size: 0.85rem;
    line-height: 1.6;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    padding: 12px 16px;
    margin-bottom: 28px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
  }

  .controls label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .controls select {
    padding: 4px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.78rem;
  }

  .num {
    min-width: 44px;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
  }

  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }

  code {
    color: var(--accent-primary);
    font-size: 0.72rem;
  }

  .note {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.76rem;
    line-height: 1.55;
  }

  .demo {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field-label {
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 500;
    letter-spacing: 0.03em;
  }

  .insitu {
    margin-top: 44px;
  }

  .insitu > .note {
    max-width: 70ch;
    margin: 8px 0 18px;
  }

  .insitu-row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }

  .mock-sidebar {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 200px;
    padding: 14px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
  }

  .mock-title {
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .mock-slider-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
    color: var(--text-secondary);
    font-size: 0.7rem;
  }

  .mock-slider-label span { color: var(--text-primary); }

  .mock-track {
    height: 4px;
    border-radius: 2px;
    background: var(--bg-primary);
  }

  .mock-fill {
    width: 35%;
    height: 100%;
    border-radius: 2px;
    background: var(--accent-primary);
  }

  .mock-fill.wide { width: 100%; }

  footer {
    margin-top: 44px;
    padding-top: 18px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 0.78rem;
    line-height: 1.7;
  }

  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: 0.72rem;
  }
</style>
