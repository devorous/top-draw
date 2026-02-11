/**
 * Client-side Moderation module
 * Manages context menu, mod panel, and role-based visibility.
 * No server/database — roles are hardcoded for now.
 */
export class Moderation {
  constructor() {
    // Hardcoded to 'admin' for testing; wire to auth later
    this.localRole = 'admin';

    // Mod panel state
    this.modEntries = [];
    this.activeTab = 'bans';
    this.panelVisible = false;

    // Context menu state
    this.targetSessionIndex = null;
    this.targetUser = null;

    // Callbacks wired by App.js
    this.onSync = null;
    this.onPM = null;
    this.onMute = null;
    this.onKick = null;
    this.onBan = null;
  }

  isMod() {
    return this.localRole === 'mod' || this.localRole === 'admin';
  }

  isAdmin() {
    return this.localRole === 'admin';
  }

  /**
   * Show/hide .modOnly elements based on current role
   */
  updateModVisibility() {
    const elements = document.querySelectorAll('.modOnly');
    elements.forEach(el => {
      if (this.isMod()) {
        el.classList.add('visible');
      } else {
        el.classList.remove('visible');
      }
    });
  }

  /**
   * Position and show the user context menu
   */
  showContextMenu(event, targetSessionIndex, targetUser) {
    event.preventDefault();
    event.stopPropagation();

    this.targetSessionIndex = targetSessionIndex;
    this.targetUser = targetUser;

    const menu = document.getElementById('userContextMenu');
    if (!menu) return;

    menu.style.display = 'flex';

    // Position at click, clamped to viewport
    const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 10);
    const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 10);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  hideContextMenu() {
    const menu = document.getElementById('userContextMenu');
    if (menu) {
      menu.style.display = 'none';
    }
    this.targetSessionIndex = null;
    this.targetUser = null;
  }

  /**
   * Handle context menu button clicks
   */
  handleMenuAction(action) {
    const sessionIndex = this.targetSessionIndex;
    const user = this.targetUser;
    this.hideContextMenu();

    if (!sessionIndex && sessionIndex !== 0) return;

    switch (action) {
      case 'sync':
        if (this.onSync) this.onSync(sessionIndex);
        break;
      case 'pm':
        if (this.onPM) this.onPM(sessionIndex, user);
        break;
      case 'mute':
        if (this.onMute) this.onMute(sessionIndex, user);
        break;
      case 'kick':
        if (this.onKick) this.onKick(sessionIndex, user);
        break;
      case 'ban':
        if (this.onBan) this.onBan(sessionIndex, user);
        break;
    }
  }

  // --- Mod Panel ---

  togglePanel() {
    this.panelVisible = !this.panelVisible;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = this.panelVisible ? 'flex' : 'none';
    }
  }

  showPanel() {
    this.panelVisible = true;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = 'flex';
    }
  }

  hidePanel() {
    this.panelVisible = false;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = 'none';
    }
  }

  setActiveTab(tab) {
    this.activeTab = tab;

    // Update tab button states
    const tabs = document.querySelectorAll('.modTab');
    tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    this.renderEntries();
  }

  renderEntries() {
    const list = document.getElementById('modEntryList');
    if (!list) return;

    const filtered = this.modEntries.filter(e => e.type === this.activeTab);

    if (filtered.length === 0) {
      list.innerHTML = '<div class="modNoEntries">No entries</div>';
      return;
    }

    list.innerHTML = filtered.map(entry => `
      <div class="modEntry">
        <span class="modEntryUser">${this.escapeHtml(entry.username)}</span>
        <span class="modEntryReason">${this.escapeHtml(entry.reason || '')}</span>
        <span class="modEntryTime">${entry.timestamp || ''}</span>
        <button class="modEntryAction" data-id="${entry.id}">Remove</button>
      </div>
    `).join('');
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
