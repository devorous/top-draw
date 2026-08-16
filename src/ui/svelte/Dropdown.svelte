<script>
  /**
   * @fileoverview Shared dropdown control.
   *
   * The app grew several unrelated dropdown looks: the native <select> used by
   * Font/Cursor (gradient + accent border), and the Palettes button with its
   * own portaled menu. This is the one control behind all of them — a button
   * trigger plus a portaled menu — so the menu looks identical everywhere and
   * only the trigger carries a variant.
   *
   * Two modes:
   *  - value select (default): pass `options`, `value`, `onchange`.
   *  - action menu: pass a `menu` snippet, which receives a `close` callback.
   *    Items should use the shared `.dd-option` classes from _dropdown.scss.
   *
   * Styles live in src/css/components/_dropdown.scss rather than here, because
   * snippet content is styled by its defining component — scoped styles would
   * not reach caller-supplied menu rows.
   */

  let {
    /** @type {Array<{value: string, label: string, hint?: string, disabled?: boolean, style?: string}>} */
    options = [],
    value = null,
    onchange = null,
    /** Trigger look: 'flat' (default) | 'panel' | 'accent' | 'inset' | 'ghost' */
    variant = 'flat',
    /** 'sm' (tool options) | 'md' (dialogs) */
    size = 'sm',
    disabled = false,
    placeholder = 'Select…',
    ariaLabel = '',
    /** Fixed trigger text. Set for action menus, where there is no "value". */
    label = null,
    /** Uppercase, letter-spaced trigger label. */
    uppercase = false,
    fullWidth = true,
    /** Optional action-menu content; replaces the option list when provided. */
    menu = null
  } = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  let menuStyle = $state('');
  let triggerEl = $state(null);
  let menuEl = $state(null);

  let typeahead = '';
  let typeaheadTimer = null;

  const isActionMenu = $derived(!!menu);
  const selectedIndex = $derived(options.findIndex(o => o.value === value));
  const triggerLabel = $derived(
    label ?? (selectedIndex >= 0 ? options[selectedIndex].label : placeholder)
  );

  /** Moves a node to <body> so the menu escapes sidebar overflow/stacking. */
  function portal(node) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  function positionMenu() {
    if (!triggerEl || !menuEl) return;

    const rect = triggerEl.getBoundingClientRect();
    const menuHeight = menuEl.offsetHeight || 0;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flip = spaceBelow < menuHeight + gap && rect.top > spaceBelow;

    const top = flip ? Math.max(gap, rect.top - menuHeight - gap) : rect.bottom + gap;
    const left = Math.max(gap, Math.min(rect.left, window.innerWidth - rect.width - gap));

    menuStyle = `top:${Math.round(top)}px;left:${Math.round(left)}px;min-width:${Math.round(rect.width)}px;`;
  }

  function openMenu() {
    if (disabled || open) return;
    open = true;
    activeIndex = isActionMenu ? -1 : (selectedIndex >= 0 ? selectedIndex : 0);
    // Position after the menu exists so its height is measurable.
    queueMicrotask(() => {
      positionMenu();
      menuEl?.focus();
    });
  }

  function closeMenu({ refocus = false } = {}) {
    if (!open) return;
    open = false;
    activeIndex = -1;
    if (refocus) triggerEl?.focus();
  }

  function toggleMenu() {
    open ? closeMenu({ refocus: true }) : openMenu();
  }

  function commit(index) {
    const option = options[index];
    if (!option || option.disabled) return;
    closeMenu({ refocus: true });
    if (option.value !== value) onchange?.(option.value);
  }

  /** Steps to the next selectable option, skipping disabled ones. */
  function move(delta) {
    if (!options.length) return;
    let next = activeIndex;
    for (let i = 0; i < options.length; i++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    activeIndex = next;
    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    queueMicrotask(() => {
      menuEl?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  }

  function jump(index) {
    activeIndex = index;
    scrollActiveIntoView();
  }

  function handleTypeahead(key) {
    clearTimeout(typeaheadTimer);
    typeahead += key.toLowerCase();
    typeaheadTimer = setTimeout(() => { typeahead = ''; }, 600);

    const match = options.findIndex(o => !o.disabled && o.label.toLowerCase().startsWith(typeahead));
    if (match >= 0) jump(match);
  }

  function handleKeydown(e) {
    // Action menus own their items, so only open/close is handled here; the
    // items themselves are focusable buttons and get native Tab/Enter.
    if (isActionMenu) {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        closeMenu({ refocus: true });
      } else if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openMenu();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); open ? move(1) : openMenu(); return;
      case 'ArrowUp': e.preventDefault(); open ? move(-1) : openMenu(); return;
      case 'Home': if (open) { e.preventDefault(); jump(0); } return;
      case 'End': if (open) { e.preventDefault(); jump(options.length - 1); } return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        open ? commit(activeIndex) : openMenu();
        return;
      case 'Escape':
        if (open) { e.preventDefault(); closeMenu({ refocus: true }); }
        return;
      case 'Tab':
        closeMenu();
        return;
      default:
        if (open && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          handleTypeahead(e.key);
        }
    }
  }

  function handleOutsidePointerDown(e) {
    if (triggerEl?.contains(e.target) || menuEl?.contains(e.target)) return;
    closeMenu();
  }

  $effect(() => {
    if (!open) return;

    const reposition = () => positionMenu();
    // `true` so scrolls inside the sidebar (not just the window) reposition too.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);

    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  });

  $effect(() => () => clearTimeout(typeaheadTimer));
</script>

<button
  bind:this={triggerEl}
  type="button"
  class="dd-trigger v-{variant} s-{size}"
  class:open
  class:uppercase
  class:full={fullWidth}
  class:placeholder={!label && selectedIndex < 0}
  {disabled}
  aria-label={ariaLabel || undefined}
  aria-haspopup={isActionMenu ? 'menu' : 'listbox'}
  aria-expanded={open}
  onclick={toggleMenu}
  onkeydown={handleKeydown}
>
  <span class="dd-label">{triggerLabel}</span>
  <svg class="dd-chevron" viewBox="0 0 10 6" aria-hidden="true">
    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</button>

{#if open}
  <div
    bind:this={menuEl}
    use:portal
    class="dd-menu s-{size}"
    style={menuStyle}
    role={isActionMenu ? 'menu' : 'listbox'}
    tabindex="-1"
    aria-label={ariaLabel || undefined}
    onkeydown={handleKeydown}
  >
    {#if isActionMenu}
      {@render menu(() => closeMenu({ refocus: true }))}
    {:else}
      {#each options as option, i}
        <button
          type="button"
          tabindex="-1"
          class="dd-option"
          class:selected={option.value === value}
          data-active={i === activeIndex}
          role="option"
          aria-selected={option.value === value}
          disabled={option.disabled}
          onpointerenter={() => { if (!option.disabled) activeIndex = i; }}
          onclick={() => commit(i)}
        >
          <span class="dd-option-label" style={option.style || undefined}>{option.label}</span>
          {#if option.hint}<span class="dd-option-hint">{option.hint}</span>{/if}
          {#if option.value === value}
            <svg class="dd-check" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6.5l2.6 2.6L10 3.7" fill="none" stroke="currentColor" stroke-width="1.8"
                    stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
{/if}
