<script>
  // Floating "image selection" window that lives in the board-menu column,
  // below the History button. It hosts the image/pattern pickers that used to
  // live inline in the tool options. The actual gallery DOM (rendered by the
  // vanilla BrushGallery / PatternBrushGallery classes) is relocated into this
  // window on mount — IDs are preserved so all existing wiring keeps working.
  //
  // It appears whenever the active tool needs an image picker:
  //   • image brush / confetti → the Brush Gallery (#brushGallery)
  //   • pattern tool           → #patternGallery
  //   • fill (pattern mode)    → #fillPatternGallery
  //   • select (pattern mode)  → #selectionPatternGallery
  import { onMount } from 'svelte';
  import { appState } from '../../state.svelte.js';

  let hostEl = $state(null);
  let moved = false;

  // Relocated gallery nodes, keyed by the context that should show them.
  const GALLERIES = [
    { kind: 'brush', id: 'brushGallery' },
    { kind: 'pattern', id: 'patternGallery' },
    { kind: 'fill', id: 'fillPatternGallery' },
    { kind: 'selection', id: 'selectionPatternGallery' },
  ];

  // Which gallery (if any) the current tool / mode wants to show.
  let activeKind = $derived.by(() => {
    const t = appState.currentTool;
    if (t === 'imageBrush' || t === 'confetti') return 'brush';
    if (t === 'pattern') return 'pattern';
    if (t === 'fill') return appState.fillPatternEnabled ? 'fill' : null;
    if (t === 'select') return appState.selectionPatternEnabled ? 'selection' : null;
    return null;
  });

  let visible = $derived(activeKind !== null);

  const TITLES = {
    brush: 'Brush Gallery',
    pattern: 'Pattern Image',
    fill: 'Fill Pattern',
    selection: 'Selection Pattern',
  };
  let title = $derived(TITLES[activeKind] ?? 'Image');

  onMount(() => {
    if (hostEl && !moved) {
      for (const g of GALLERIES) {
        const node = document.getElementById(g.id);
        if (node) hostEl.appendChild(node);
      }
      moved = true;
    }
  });

  // Show only the gallery for the active context; hide the rest.
  $effect(() => {
    const kind = activeKind;
    for (const g of GALLERIES) {
      const node = document.getElementById(g.id);
      if (node) node.style.display = kind === g.kind ? 'block' : 'none';
    }
  });

  function toggleCollapse() {
    appState.imageSelectorCollapsed = !appState.imageSelectorCollapsed;
  }
</script>

<div class="isw" class:hidden={!visible}>
  <button
    type="button"
    class="isw-header"
    class:collapsed={appState.imageSelectorCollapsed}
    onclick={toggleCollapse}
    aria-expanded={!appState.imageSelectorCollapsed}
    title={appState.imageSelectorCollapsed ? 'Expand image picker' : 'Collapse image picker'}
  >
    <span class="isw-title">{title}</span>
    <svg
      class="chevron"
      class:collapsed={appState.imageSelectorCollapsed}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <polyline points="2,4 5,7 8,4" />
    </svg>
  </button>

  <!-- Relocated gallery DOM is appended here on mount. Kept mounted (display
       toggled) so the moved nodes are never destroyed. -->
  <div class="isw-body" class:collapsed={appState.imageSelectorCollapsed} bind:this={hostEl}></div>
</div>

<style>
  .isw {
    margin-top: 4px;
    max-width: calc(100vw - 24px);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    pointer-events: auto;
    animation: fadeDown 0.12s ease;
  }

  :global(html[data-sidebar-side='left']) .isw {
    align-items: flex-start;
  }

  .isw.hidden {
    display: none;
  }

  @keyframes fadeDown {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .isw-header {
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
    width: 133px;
    max-width: calc(100vw - 24px);
  }

  /* Collapsed: shrink to content so it doesn't stick out past the other
     content-sized board-menu buttons. */
  .isw-header.collapsed {
    width: fit-content;
  }

  .isw-header:hover {
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
    color: var(--text-primary);
  }

  .isw-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    flex-shrink: 0;
    transition: transform 0.12s ease;
  }
  .chevron.collapsed {
    transform: rotate(-90deg);
  }

  .isw-body {
    margin-top: 1px;
    padding: 8px;
    width: 133px;
    max-width: calc(100vw - 24px);
    background: color-mix(in srgb, var(--surface-glass) 78%, transparent);
    border-radius: 5px;
    box-sizing: border-box;
    max-height: min(360px, calc(100vh - 240px));
    overflow-y: auto;
    /* Always reserve a thin gutter so the grid doesn't shrink (and clip
       tile labels) when the folder opens and the body starts scrolling. */
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: rgba(128, 128, 128, 0.55) transparent;
  }

  .isw-body.collapsed {
    display: none;
  }

  /* The relocated galleries were styled for the sidebar (top divider/padding).
     Inside the floating window that spacing is unwanted. */
  .isw-body :global(#brushGallery),
  .isw-body :global(#patternGallery),
  .isw-body :global(#fillPatternGallery),
  .isw-body :global(#selectionPatternGallery) {
    padding-top: 0;
    border-top: none;
  }
</style>
