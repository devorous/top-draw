<script>
  import { appState } from '../../state.svelte.js';
  import { createDefaultAppPreferences } from '../../config/AppPreferences.js';
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
  let message = $state('');
  let messageType = $state('success');
  let showMessage = $state(false);

  function hide() {
    appState.appSettingsVisible = false;
    listeningTarget = null;
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
  }

  function updatePreferences(nextPreferences, toastMessage = '') {
    const saved = app?.setAppPreferences?.(nextPreferences) ?? nextPreferences;
    appState.appPreferences = saved;
    if (toastMessage) {
      displayMessage(toastMessage, 'success');
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
    updatePreferences(defaults, 'Default shortcuts restored');
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
    showMessage = false;
  }

  function stopListening() {
    listeningTarget = null;
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
    function handleKeydown(event) {
      if (!visible) return;

      if (listeningTarget) {
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') {
          stopListening();
          return;
        }

        const binding = eventToBinding(event);
        if (!binding) return;

        const conflict = findConflict(listeningTarget.actionId, listeningTarget.slot, binding);
        if (conflict) {
          const slotLabel = conflict.slot === 'primary' ? 'primary' : 'secondary';
          displayMessage(`Already used by "${conflict.action.label}" (${slotLabel})`, 'error');
          return;
        }

        updateKeybinding(listeningTarget.actionId, listeningTarget.slot, binding);
        stopListening();
        return;
      }

      if (event.key === 'Escape' && appState.appSettingsVisible) {
        hide();
      }
    }

    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if visible}
  <div class="app-settings-overlay" onclick={(e) => e.target === e.currentTarget && hide()} role="presentation">
    <div class="app-settings-dialog" onclick={(e) => e.stopPropagation()} role="presentation">
      <div class="app-settings-header">
        <div>
          <h3>App Settings</h3>
          <p>Manage app preferences and customize keyboard shortcuts.</p>
        </div>
        <button class="app-settings-close" type="button" onclick={hide} title="Close">&times;</button>
      </div>

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

      <div class="app-settings-body">
        {#if showMessage}
          <div class="app-settings-message {messageType}">{message}</div>
        {/if}

        {#if activeTab === TAB_GENERAL}
          <section class="settings-panel">
            <h4>Shortcut Customization</h4>
            <p>
              Keyboard shortcuts are now configurable per browser profile. Changes save immediately and
              take effect without a reload.
            </p>
            <div class="settings-actions">
              <button class="btn secondary" type="button" onclick={() => setTab(TAB_KEYBINDS)}>Open Keybinds</button>
              <button class="btn danger" type="button" onclick={restoreDefaults}>Restore All Defaults</button>
            </div>
          </section>
        {:else}
          <section class="settings-panel">
            <div class="keybind-toolbar">
              <div>
                <h4>Custom Keybinds</h4>
                <p>Edit shortcuts, clear them, or restore defaults one action at a time.</p>
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
                                Press a shortcut
                              {:else}
                                {formatBindingForDisplay(bindingForSlot(action.id, 'primary'))}
                              {/if}
                            </span>
                            <button class="btn secondary small" type="button" onclick={() => startListening(action.id, 'primary')}>
                              {listeningTarget?.actionId === action.id && listeningTarget?.slot === 'primary' ? 'Listening...' : 'Edit'}
                            </button>
                            <button class="btn secondary small" type="button" onclick={() => clearActionBinding(action.id, 'primary')}>
                              Clear
                            </button>
                          </div>
                          <div class="keybind-slot-row">
                            <span class="keybind-slot-label">Secondary</span>
                            <span class:capturing={listeningTarget?.actionId === action.id && listeningTarget?.slot === 'secondary'} class="keybind-binding">
                              {#if listeningTarget?.actionId === action.id && listeningTarget?.slot === 'secondary'}
                                Press a shortcut
                              {:else}
                                {formatBindingForDisplay(bindingForSlot(action.id, 'secondary'))}
                              {/if}
                            </span>
                            <button class="btn secondary small" type="button" onclick={() => startListening(action.id, 'secondary')}>
                              {listeningTarget?.actionId === action.id && listeningTarget?.slot === 'secondary' ? 'Listening...' : 'Edit'}
                            </button>
                            <button class="btn secondary small" type="button" onclick={() => clearActionBinding(action.id, 'secondary')}>
                              Clear
                            </button>
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
    background: #242830;
    color: #f0f2f5;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
  }

  .app-settings-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem 1.5rem;
    background: #2d323c;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .app-settings-header h3,
  .settings-panel h4,
  .keybind-category h5 {
    margin: 0;
  }

  .app-settings-header p,
  .settings-panel p {
    margin: 0.35rem 0 0;
    color: #a8b0bf;
  }

  .app-settings-close {
    background: transparent;
    border: none;
    color: #f0f2f5;
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
  }

  .app-settings-tabs {
    display: flex;
    gap: 0.5rem;
    padding: 0.9rem 1.5rem 0;
  }

  .app-settings-tab {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-bottom: none;
    background: rgba(255, 255, 255, 0.04);
    color: #cfd6e3;
    padding: 0.7rem 1rem;
    border-radius: 8px 8px 0 0;
    cursor: pointer;
    font-weight: 600;
  }

  .app-settings-tab.active {
    background: #313744;
    color: #fff;
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
    border-radius: 6px;
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
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 1rem;
  }

  .settings-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
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
    background: #1d2128;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    color: #f0f2f5;
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
    color: #dce3ef;
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
    background: #1b1f27;
    border: 1px solid rgba(255, 255, 255, 0.06);
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
    color: #9ea7b6;
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
    color: #9ea7b6;
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
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    font-weight: 700;
    color: #f3f5f8;
    box-sizing: border-box;
    white-space: nowrap;
  }

  .keybind-binding.capturing {
    border-color: rgba(93, 188, 255, 0.6);
    background: rgba(93, 188, 255, 0.16);
    color: #cfefff;
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
