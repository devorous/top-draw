<script>
  import { appState } from '../../state.svelte.js';
  import {
    createDefaultAppPreferences,
    DEFAULT_SFX_PREFERENCES,
    THEME_BASE_COLORS
  } from '../../config/AppPreferences.js';
  import {
    KEYBIND_ACTIONS,
    KEYBIND_ACTIONS_BY_ID,
    KEYBIND_CATEGORY_ORDER
  } from '../../input/keybinds/KeybindRegistry.js';
  import {
    eventToBinding,
    formatBindingForDisplay,
    normalizeBinding
  } from '../../input/keybinds/KeybindMatcher.js';

  const TAB_GENERAL = 'general';
  const TAB_KEYBINDS = 'keybinds';

  let { app = null } = $props();

  let visible = $derived(appState.appSettingsVisible);
  let activeTab = $derived(appState.appSettingsTab);
  let appPreferences = $derived(appState.appPreferences ?? createDefaultAppPreferences());

  let search = $state('');
  let listeningTarget = $state(null);
  let listeningDraftBinding = $state(null);
  let message = $state('');
  let messageType = $state('success');
  let showMessage = $state(false);
  let themeColorDrafts = $state({});

  const THEME_COLOR_FIELDS = [
    { key: 'bg',     label: 'Background' },
    { key: 'accent', label: 'Accent' },
    { key: 'text',   label: 'Text' },
    { key: 'boardBg', label: 'Board BG' }
  ];

  function isSidebarOnLeft() {
    return appPreferences?.general?.sidebarSide === 'left';
  }

  function isHideOwnLabelAbove150() {
    return !!appPreferences?.general?.hideOwnLabelAbove150;
  }

  function updateHideOwnLabelAbove150(enabled) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        hideOwnLabelAbove150: enabled
      }
    };

    updatePreferences(nextPreferences, enabled ? 'Username label hidden above 150% zoom' : 'Username label always shown');
  }

  function isShowRawPixelsAtHighZoom() {
    return !!appPreferences?.general?.showRawPixelsAtHighZoom;
  }

  function updateShowRawPixelsAtHighZoom(enabled) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        showRawPixelsAtHighZoom: enabled
      }
    };

    updatePreferences(nextPreferences, enabled ? 'Raw pixels enabled above 500% zoom' : 'High-zoom smoothing restored');
  }

  function isUseDesynchronizedBoardContexts() {
    return !!appPreferences?.general?.useDesynchronizedBoardContexts;
  }

  function isLowPowerMode() {
    return !!appPreferences?.general?.lowPowerMode;
  }

  function updateUseDesynchronizedBoardContexts(enabled) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        useDesynchronizedBoardContexts: enabled
      }
    };

    updatePreferences(
      nextPreferences,
      enabled
        ? 'Low-latency canvas requested (refresh to apply)'
        : 'Low-latency canvas disabled (refresh to apply)'
    );
  }

  function updateLowPowerMode(enabled) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        lowPowerMode: enabled
      }
    };

    updatePreferences(nextPreferences, enabled ? 'Low-power mode enabled (30 TPS / 30 FPS)' : 'Low-power mode disabled');
  }

  function isShowFloatingArt() {
    return appPreferences?.general?.showFloatingArt !== false;
  }

  function updateShowFloatingArt(enabled) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        showFloatingArt: enabled
      }
    };

    updatePreferences(nextPreferences, enabled ? 'Floating art enabled' : 'Floating art disabled');
  }

  function getChatOpacity() {
    const value = Number(appPreferences?.general?.chatOpacity);
    return Number.isFinite(value) ? Math.min(1, Math.max(0.3, value)) : 1;
  }

  function getSfxSettings() {
    return {
      ...DEFAULT_SFX_PREFERENCES,
      ...(appPreferences?.general?.sfx ?? {})
    };
  }

  function getSfxVolume() {
    const value = Number(getSfxSettings().volume);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_SFX_PREFERENCES.volume;
  }

  function isSfxEnabled(name) {
    return !!getSfxSettings()[name];
  }

  function updateSfxVolume(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(1, Math.max(0, value));

    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        sfx: {
          ...getSfxSettings(),
          volume: clamped
        }
      }
    };

    updatePreferences(nextPreferences);
  }

  function updateSfxEnabled(name, enabled) {
    if (!['chat', 'staff', 'inbox'].includes(name)) return;

    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        sfx: {
          ...getSfxSettings(),
          [name]: enabled
        }
      }
    };

    const labels = {
      chat: 'Chat',
      staff: 'Staff / DM',
      inbox: 'Inbox'
    };
    updatePreferences(nextPreferences, `${labels[name]} sound ${enabled ? 'enabled' : 'disabled'}`);
  }

  function updateChatOpacity(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(1, Math.max(0.3, value));

    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        chatOpacity: clamped
      }
    };

    updatePreferences(nextPreferences);
  }

  function getLocalBoardBackgroundColor() {
    return appPreferences?.general?.localBoardBackgroundColor ?? '';
  }

  function updateLocalBoardBackgroundColor(value) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        localBoardBackgroundColor: value || null
      }
    };

    updatePreferences(nextPreferences, value ? 'Local board background updated' : 'Room background restored');
  }

  function updateSidebarSide(enabled) {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        sidebarSide: enabled ? 'left' : 'right'
      }
    };

    updatePreferences(nextPreferences, `Sidebar moved to the ${enabled ? 'left' : 'right'}`);
  }

  function hide() {
    appState.appSettingsVisible = false;
    listeningTarget = null;
    listeningDraftBinding = null;
    search = '';
  }

  function displayMessage(text, type = 'success') {
    message = text;
    messageType = type;
    showMessage = true;
    setTimeout(() => {
      showMessage = false;
    }, 2400);
  }

  function setTab(tab) {
    appState.appSettingsTab = tab;
    listeningTarget = null;
    listeningDraftBinding = null;
  }

  function updatePreferences(nextPreferences, toastMessage = '') {
    const saved = app?.setAppPreferences?.(nextPreferences) ?? nextPreferences;
    appState.appPreferences = saved;
    if (toastMessage) {
      app?.ui?.showToast?.(toastMessage);
    }
  }

  function updateKeybinding(actionId, slot, binding, toastMessage = 'Shortcut updated') {
    const current = keybindSlots(actionId);
    const nextPreferences = {
      ...appPreferences,
      keybinds: {
        ...appPreferences.keybinds,
        [actionId]: {
          ...current,
          [slot]: binding
        }
      }
    };

    updatePreferences(nextPreferences, toastMessage);
  }

  function restoreDefaults() {
    const defaults = createDefaultAppPreferences();
    updatePreferences(defaults, 'Default app settings restored');
  }

  function syncThemeColorDrafts() {
    const saved = appPreferences?.general?.themeColors ?? {};
    themeColorDrafts = {
      bg:     saved.bg     || THEME_BASE_COLORS.bg,
      accent: saved.accent || THEME_BASE_COLORS.accent,
      text:   saved.text   || THEME_BASE_COLORS.text
    };
  }

  function updateThemeColor(key, value) {
    if (!['bg', 'accent', 'text'].includes(key)) return;
    const nextThemeColors = {
      bg: themeColorDrafts.bg ?? THEME_BASE_COLORS.bg,
      accent: themeColorDrafts.accent ?? THEME_BASE_COLORS.accent,
      text: themeColorDrafts.text ?? THEME_BASE_COLORS.text,
      [key]: value
    };
    themeColorDrafts = nextThemeColors;

    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        themeColors: nextThemeColors
      }
    };

    updatePreferences(nextPreferences);
  }

  function restoreThemeDefaults() {
    const nextPreferences = {
      ...appPreferences,
      general: {
        ...(appPreferences?.general ?? {}),
        themeColors: {},
        localBoardBackgroundColor: null
      }
    };

    updatePreferences(nextPreferences, 'Default colours restored');
    syncThemeColorDrafts();
  }

  function restoreActionDefault(actionId) {
    const nextPreferences = {
      ...appPreferences,
      keybinds: {
        ...appPreferences.keybinds,
        [actionId]: {
          primary: KEYBIND_ACTIONS_BY_ID[actionId]?.defaultBinding ?? null,
          secondary: null
        }
      }
    };

    updatePreferences(nextPreferences, 'Shortcut slots restored');
  }

  function clearActionBinding(actionId, slot) {
    updateKeybinding(actionId, slot, null, `${slot === 'primary' ? 'Primary' : 'Secondary'} shortcut cleared`);
  }

  function startListening(actionId, slot) {
    listeningTarget = { actionId, slot };
    listeningDraftBinding = null;
    showMessage = false;
  }

  function stopListening() {
    listeningTarget = null;
    listeningDraftBinding = null;
  }

  function keybindSlots(actionId) {
    const stored = appPreferences?.keybinds?.[actionId];
    if (stored && typeof stored === 'object') {
      return {
        primary: stored.primary ?? KEYBIND_ACTIONS_BY_ID[actionId]?.defaultBinding ?? null,
        secondary: stored.secondary ?? null
      };
    }

    return {
      primary: stored ?? KEYBIND_ACTIONS_BY_ID[actionId]?.defaultBinding ?? null,
      secondary: null
    };
  }

  function bindingForSlot(actionId, slot) {
    return keybindSlots(actionId)[slot];
  }

  function captureListeningBinding(event) {
    if (!visible || !listeningTarget) return;

    event.preventDefault();
    event.stopPropagation();

    const binding = eventToBinding(event);
    if (!binding) return;
    listeningDraftBinding = binding;
  }

  function applyListeningBinding() {
    if (!visible || !listeningTarget || !listeningDraftBinding) return;

    const binding = normalizeBinding(listeningDraftBinding);
    if (!binding) return;

    const conflict = findConflict(listeningTarget.actionId, listeningTarget.slot, binding);
    if (conflict) {
      const slotLabel = conflict.slot === 'primary' ? 'primary' : 'secondary';
      displayMessage(`Already used by "${conflict.action.label}" (${slotLabel})`, 'error');
      return;
    }

    updateKeybinding(listeningTarget.actionId, listeningTarget.slot, binding);
    stopListening();
  }

  function findConflict(actionId, slot, binding) {
    if (!binding) return null;

    for (const action of KEYBIND_ACTIONS) {
      const slots = keybindSlots(action.id);
      for (const candidateSlot of ['primary', 'secondary']) {
        if (action.id === actionId && candidateSlot === slot) continue;
        const currentBinding = normalizeBinding(slots[candidateSlot]);
        if (currentBinding && currentBinding === binding) {
          return {
            action,
            slot: candidateSlot
          };
        }
      }
    }

    return null;
  }

  function searchQuery() {
    return search.trim().toLowerCase();
  }

  function filteredCategories() {
    const query = searchQuery();
    const grouped = new Map();

    for (const category of KEYBIND_CATEGORY_ORDER) {
      grouped.set(category, []);
    }

    for (const action of KEYBIND_ACTIONS) {
      if (
        query &&
        !action.label.toLowerCase().includes(query) &&
        !action.description.toLowerCase().includes(query) &&
        !formatBindingForDisplay(bindingForSlot(action.id, 'primary')).toLowerCase().includes(query) &&
        !formatBindingForDisplay(bindingForSlot(action.id, 'secondary')).toLowerCase().includes(query)
      ) {
        continue;
      }

      if (!grouped.has(action.category)) {
        grouped.set(action.category, []);
      }
      grouped.get(action.category).push(action);
    }

    return [...grouped.entries()].filter(([, actions]) => actions.length > 0);
  }

  $effect(() => {
    appPreferences;
    visible;
    syncThemeColorDrafts();
  });

  $effect(() => {
    function handleKeydown(event) {
      if (!visible) return;

      if (listeningTarget) {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
          stopListening();
          return;
        }

        captureListeningBinding(event);
        return;
      }

      if (event.key === 'Escape' && appState.appSettingsVisible) {
        hide();
      }
    }

    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });

  $effect(() => {
    function handlePointerdown(event) {
      if (event.target?.closest?.('[data-keybind-capture-control]')) return;
      captureListeningBinding(event);
    }

    function suppressContextMenu(event) {
      if (!visible || !listeningTarget) return;
      event.preventDefault();
      event.stopPropagation();
    }

    document.addEventListener('pointerdown', handlePointerdown, true);
    document.addEventListener('contextmenu', suppressContextMenu, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerdown, true);
      document.removeEventListener('contextmenu', suppressContextMenu, true);
    };
  });
</script>

{#if visible}
  <div class="app-settings-overlay" onclick={(e) => e.target === e.currentTarget && hide()} role="presentation">
    <div class="app-settings-dialog" onclick={(e) => e.stopPropagation()} role="presentation">
      <div class="app-settings-header">
        <div class="app-settings-header-main">
          <h3>App Settings</h3>
          <div class="app-settings-tabs" role="tablist" aria-label="App settings sections">
            <button
              class:active={activeTab === TAB_GENERAL}
              class="app-settings-tab"
              onclick={() => setTab(TAB_GENERAL)}
              type="button"
            >General</button>
            <button
              class:active={activeTab === TAB_KEYBINDS}
              class="app-settings-tab"
              onclick={() => setTab(TAB_KEYBINDS)}
              type="button"
            >Keybinds</button>
          </div>
        </div>
        <button class="app-settings-close" type="button" onclick={hide} title="Close">&times;</button>
      </div>

      <div class="app-settings-body">
        {#if showMessage}
          <div class="app-settings-message {messageType}">{message}</div>
        {/if}

        {#if activeTab === TAB_GENERAL}
          <section class="settings-panel">
            <div class="settings-toggles-row">
              <label class="settings-toggle-compact">
                <input
                  type="checkbox"
                  checked={isSidebarOnLeft()}
                  onchange={(event) => updateSidebarSide(event.currentTarget.checked)}
                />
                <span>Sidebar on Left</span>
              </label>
              <label class="settings-toggle-compact">
                <input
                  type="checkbox"
                  checked={isHideOwnLabelAbove150()}
                  onchange={(event) => updateHideOwnLabelAbove150(event.currentTarget.checked)}
                />
                <span>Hide Own Username at High Zoom</span>
              </label>
              <label class="settings-toggle-compact">
                <input
                  type="checkbox"
                  checked={isShowRawPixelsAtHighZoom()}
                  onchange={(event) => updateShowRawPixelsAtHighZoom(event.currentTarget.checked)}
                />
                <span>Show Raw Pixels Above 500%</span>
              </label>
              <label class="settings-toggle-compact">
                <input
                  type="checkbox"
                  checked={isUseDesynchronizedBoardContexts()}
                  onchange={(event) => updateUseDesynchronizedBoardContexts(event.currentTarget.checked)}
                />
                <span>Low-Latency Canvas (Refresh)</span>
              </label>
              <label class="settings-toggle-compact">
                <input
                  type="checkbox"
                  checked={isLowPowerMode()}
                  onchange={(event) => updateLowPowerMode(event.currentTarget.checked)}
                />
                <span>Low-Power Mode (30 TPS / 30 FPS)</span>
              </label>
              <label class="settings-toggle-compact">
                <input
                  type="checkbox"
                  checked={isShowFloatingArt()}
                  onchange={(event) => updateShowFloatingArt(event.currentTarget.checked)}
                />
                <span>Show Floating Art</span>
              </label>
            </div>

            <div class="settings-slider-stack">
              <div class="settings-slider-card">
                <label class="settings-slider-label">
                  <span class="settings-slider-title">SFX Volume</span>
                  <span class="settings-slider-value">{Math.round(getSfxVolume() * 100)}%</span>
                </label>
                <input
                  type="range"
                  class="settings-slider"
                  min="0"
                  max="1"
                  step="0.05"
                  value={getSfxVolume()}
                  oninput={(event) => updateSfxVolume(event.currentTarget.value)}
                />
                <div class="settings-toggles-row settings-toggles-row-tight">
                  <label class="settings-toggle-compact">
                    <input
                      type="checkbox"
                      checked={isSfxEnabled('chat')}
                      onchange={(event) => updateSfxEnabled('chat', event.currentTarget.checked)}
                    />
                    <span>Chat</span>
                  </label>
                  <label class="settings-toggle-compact">
                    <input
                      type="checkbox"
                      checked={isSfxEnabled('staff')}
                      onchange={(event) => updateSfxEnabled('staff', event.currentTarget.checked)}
                    />
                    <span>Staff / DM</span>
                  </label>
                  <label class="settings-toggle-compact">
                    <input
                      type="checkbox"
                      checked={isSfxEnabled('inbox')}
                      onchange={(event) => updateSfxEnabled('inbox', event.currentTarget.checked)}
                    />
                    <span>Inbox</span>
                  </label>
                </div>
              </div>

              <div class="settings-slider-card">
                <label class="settings-slider-label">
                  <span class="settings-slider-title">Chat Opacity</span>
                  <span class="settings-slider-value">{Math.round(getChatOpacity() * 100)}%</span>
                </label>
                <input
                  type="range"
                  class="settings-slider"
                  min="0.3"
                  max="1"
                  step="0.05"
                  value={getChatOpacity()}
                  oninput={(event) => updateChatOpacity(event.currentTarget.value)}
                />
              </div>
            </div>

            <h4>App Colours</h4>
            <p>Pick your app colours and local board background.</p>
            <div class="theme-grid-compact">
              {#each THEME_COLOR_FIELDS as field (field.key)}
                <label class="theme-color-field-compact">
                  <span>{field.label}</span>
                  <div class="theme-color-input-wrap">
                    {#if field.key === 'boardBg'}
                      <input
                        type="color"
                        class="theme-color-picker"
                        value={getLocalBoardBackgroundColor() || '#ffffff'}
                        oninput={(event) => updateLocalBoardBackgroundColor(event.currentTarget.value)}
                        onchange={(event) => updateLocalBoardBackgroundColor(event.currentTarget.value)}
                      />
                      <code>{getLocalBoardBackgroundColor() || '#ffffff'}</code>
                    {:else}
                      <input
                        type="color"
                        class="theme-color-picker"
                        value={themeColorDrafts[field.key] ?? THEME_BASE_COLORS[field.key]}
                        oninput={(event) => updateThemeColor(field.key, event.currentTarget.value)}
                        onchange={(event) => updateThemeColor(field.key, event.currentTarget.value)}
                      />
                      <code>{themeColorDrafts[field.key] ?? THEME_BASE_COLORS[field.key]}</code>
                    {/if}
                  </div>
                </label>
              {/each}
            </div>
            <div class="settings-actions">
              <button class="btn secondary" type="button" onclick={() => setTab(TAB_KEYBINDS)}>Open Keybinds</button>
              <button class="btn danger" type="button" onclick={restoreThemeDefaults}>Restore Default Colours</button>
            </div>
          </section>
          <div class="settings-global-actions">
            <button class="btn danger" type="button" onclick={restoreDefaults}>Restore All Defaults</button>
          </div>
        {:else}
          <section class="settings-panel">
            <div class="keybind-toolbar">
              <div>
                <h4>Custom Keybinds</h4>
                <p>Edit shortcuts, pointer buttons, then apply them once the full combo looks right.</p>
              </div>
              <div class="keybind-toolbar-actions">
                <input
                  type="text"
                  bind:value={search}
                  class="settings-input keybind-search"
                  placeholder="Search actions or shortcuts..."
                />
                <button class="btn secondary small" type="button" onclick={restoreDefaults}>Reset All</button>
              </div>
            </div>

            {#if filteredCategories().length === 0}
              <div class="keybind-empty">No shortcuts match this search.</div>
            {:else}
              {#each filteredCategories() as [category, actions]}
                <div class="keybind-category">
                  <h5>{category}</h5>
                  <div class="keybind-list">
                    {#each actions as action (action.id)}
                      <div class="keybind-row">
                        <div class="keybind-copy">
                          <strong>{action.label}</strong>
                          <span>{action.description}</span>
                        </div>

                        <div class="keybind-binding-wrap">
                          <div class="keybind-slot-row">
                            <span class="keybind-slot-label">Primary</span>
                            <span class:capturing={listeningTarget?.actionId === action.id && listeningTarget?.slot === 'primary'} class="keybind-binding">
                              {#if listeningTarget?.actionId === action.id && listeningTarget?.slot === 'primary'}
                                {#if listeningDraftBinding}
                                  {formatBindingForDisplay(listeningDraftBinding)}
                                {:else}
                                  Press a shortcut or button
                                {/if}
                              {:else}
                                {formatBindingForDisplay(bindingForSlot(action.id, 'primary'))}
                              {/if}
                            </span>
                            {#if listeningTarget?.actionId === action.id && listeningTarget?.slot === 'primary'}
                              <button class="btn secondary small" type="button" onclick={applyListeningBinding} disabled={!listeningDraftBinding} data-keybind-capture-control="true">
                                Apply
                              </button>
                              <button class="btn secondary small" type="button" onclick={stopListening} data-keybind-capture-control="true">
                                Cancel
                              </button>
                            {:else}
                              <button class="btn secondary small" type="button" onclick={() => startListening(action.id, 'primary')}>
                                Edit
                              </button>
                              <button class="btn secondary small" type="button" onclick={() => clearActionBinding(action.id, 'primary')}>
                                Clear
                              </button>
                            {/if}
                          </div>
                          <div class="keybind-slot-row">
                            <span class="keybind-slot-label">Secondary</span>
                            <span class:capturing={listeningTarget?.actionId === action.id && listeningTarget?.slot === 'secondary'} class="keybind-binding">
                              {#if listeningTarget?.actionId === action.id && listeningTarget?.slot === 'secondary'}
                                {#if listeningDraftBinding}
                                  {formatBindingForDisplay(listeningDraftBinding)}
                                {:else}
                                  Press a shortcut or button
                                {/if}
                              {:else}
                                {formatBindingForDisplay(bindingForSlot(action.id, 'secondary'))}
                              {/if}
                            </span>
                            {#if listeningTarget?.actionId === action.id && listeningTarget?.slot === 'secondary'}
                              <button class="btn secondary small" type="button" onclick={applyListeningBinding} disabled={!listeningDraftBinding} data-keybind-capture-control="true">
                                Apply
                              </button>
                              <button class="btn secondary small" type="button" onclick={stopListening} data-keybind-capture-control="true">
                                Cancel
                              </button>
                            {:else}
                              <button class="btn secondary small" type="button" onclick={() => startListening(action.id, 'secondary')}>
                                Edit
                              </button>
                              <button class="btn secondary small" type="button" onclick={() => clearActionBinding(action.id, 'secondary')}>
                                Clear
                              </button>
                            {/if}
                          </div>
                          <span class="keybind-default">
                            Default: {formatBindingForDisplay(KEYBIND_ACTIONS_BY_ID[action.id]?.defaultBinding)}
                          </span>
                          <div class="keybind-row-footer">
                            <button class="btn secondary small keybind-reset-btn" type="button" onclick={() => restoreActionDefault(action.id)}>
                              Reset
                            </button>
                          </div>
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            {/if}
          </section>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .app-settings-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(4px);
    z-index: 10010;
  }

  .app-settings-dialog {
    width: min(100%, 980px);
    height: min(90vh, 760px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }

  .app-settings-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    padding: 1.25rem 1.5rem 0;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-subtle);
  }

  .app-settings-header-main {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    min-width: 0;
    flex: 1;
  }

  .app-settings-header h3,
  .settings-panel h4,
  .keybind-category h5 {
    margin: 0;
  }

  .settings-panel p {
    margin: 0.35rem 0 0;
    color: var(--text-secondary);
  }

  .app-settings-close {
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
  }

  .app-settings-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: -1px;
  }

  .app-settings-tab {
    border: 1px solid var(--border-subtle);
    border-bottom: none;
    background: color-mix(in srgb, var(--bg-primary) 72%, transparent);
    color: color-mix(in srgb, var(--text-secondary) 88%, var(--text-muted));
    padding: 0.7rem 1rem;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    font-weight: 600;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .app-settings-tab:hover {
    background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
    color: var(--text-primary);
  }

  .app-settings-tab.active {
    background: color-mix(in srgb, var(--bg-elevated) 94%, var(--accent-primary) 6%);
    border-color: color-mix(in srgb, var(--border-subtle) 60%, var(--accent-primary) 40%);
    color: var(--text-primary);
  }

  .app-settings-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 1rem 1.1rem 1.1rem;
    overflow-y: auto;
  }

  .app-settings-message {
    margin-bottom: 0.8rem;
    padding: 0.8rem 1rem;
    border-radius: var(--radius-sm);
  }

  .app-settings-message.success {
    background: rgba(80, 200, 120, 0.14);
    border: 1px solid rgba(80, 200, 120, 0.28);
    color: #aef0c2;
  }

  .app-settings-message.error {
    background: rgba(220, 80, 90, 0.14);
    border: 1px solid rgba(220, 80, 90, 0.28);
    color: #ffb7bd;
  }

  .settings-panel {
    min-height: 100%;
    box-sizing: border-box;
    background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 1rem;
  }

  .settings-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .settings-global-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .settings-option-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
    padding: 0.9rem 1rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--bg-primary);
  }

  .settings-toggles-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .settings-toggle-compact {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
  }

  .settings-toggle-compact input {
    margin: 0;
    accent-color: var(--accent-primary);
  }

  .settings-slider-stack {
    display: flex;
    flex-wrap: wrap;
    gap: 0.85rem;
    margin-bottom: 1rem;
  }

  .settings-slider-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.65rem 0.8rem;
    width: min(320px, 100%);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
  }

  .settings-slider-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 600;
  }

  .settings-slider-value {
    font-variant-numeric: tabular-nums;
    color: var(--accent-primary);
    font-size: 0.78rem;
    font-weight: 700;
  }

  .settings-slider {
    appearance: none;
    width: min(220px, 100%);
    height: 6px;
    margin: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 28%, var(--bg-elevated));
    outline: none;
    accent-color: var(--accent-primary);
  }

  .settings-slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-primary);
    border: 2px solid var(--bg-primary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }

  .settings-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-primary);
    border: 2px solid var(--bg-primary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }

  .settings-toggles-row-tight {
    margin-top: 0.35rem;
    margin-bottom: 0;
  }

  .theme-grid-compact {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .theme-color-field-compact {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 0;
  }

  .theme-color-field-compact span {
    color: var(--text-secondary);
    font-size: 0.84rem;
    font-weight: 600;
  }

  .theme-color-input-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.7rem;
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
  }

  .theme-color-picker {
    width: 44px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
  }

  .theme-color-input-wrap code {
    color: var(--text-primary);
    font-size: 0.82rem;
  }

  .keybind-toolbar {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .keybind-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .settings-input {
    width: 100%;
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    padding: 0.62rem 0.72rem;
    font: inherit;
  }

  .keybind-search {
    min-width: 260px;
  }

  .keybind-category + .keybind-category {
    margin-top: 1rem;
  }

  .keybind-category h5 {
    margin-bottom: 0.65rem;
    color: var(--text-primary);
    font-size: 0.95rem;
  }

  .keybind-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .keybind-row {
    display: grid;
    grid-template-columns: minmax(220px, 1.4fr) minmax(420px, 1fr);
    gap: 0.85rem;
    align-items: start;
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 0.75rem;
  }

  .keybind-copy {
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
    min-width: 0;
  }

  .keybind-copy span,
  .keybind-default,
  .keybind-empty {
    color: var(--text-secondary);
    font-size: 0.82rem;
    line-height: 1.4;
  }

  .keybind-binding-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
  }

  .keybind-slot-row {
    display: grid;
    grid-template-columns: 88px minmax(130px, 1fr) auto auto;
    gap: 0.5rem;
    align-items: center;
  }

  .keybind-slot-label {
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .keybind-binding {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    min-width: 110px;
    padding: 0.45rem 0.8rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    font-weight: 700;
    color: var(--text-primary);
    box-sizing: border-box;
    white-space: nowrap;
  }

  .keybind-binding.capturing {
    border-color: var(--border-active);
    background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
    color: var(--text-primary);
  }

  .keybind-empty {
    padding: 1rem 0.25rem 0.1rem;
  }

  .keybind-row-footer {
    display: flex;
    justify-content: flex-start;
  }

  .keybind-reset-btn {
    width: auto;
    min-width: 84px;
    max-width: 120px;
    flex: 0 0 auto;
  }

  .btn.small {
    padding: 0.42rem 0.68rem;
    font-size: 0.8rem;
  }

  @media (max-width: 860px) {
    .keybind-toolbar,
    .keybind-row {
      grid-template-columns: 1fr;
      display: grid;
    }

    .keybind-slot-row {
      grid-template-columns: 1fr 1fr;
      align-items: stretch;
    }

    .keybind-slot-label,
    .keybind-binding {
      grid-column: 1 / -1;
    }

    .keybind-toolbar-actions {
      flex-direction: column;
      align-items: stretch;
    }

    .keybind-search {
      min-width: 0;
    }

  }
</style>
