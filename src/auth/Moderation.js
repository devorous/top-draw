/**
 * Client-side Moderation module
 * Manages context menu, mod panel, action dialogs, and role-based visibility.
 */
export class Moderation {
  constructor() {
    // Numeric role: 0=guest, 1=user, 2=mod, 3=admin
    this.localRole = 0;

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
    this.onModAction = null;       // (actionType, sessionIndex, reason, duration)
    this.onRequestModList = null;   // ()
    this.onRevokeEntry = null;      // (entryId, type)
    this.onModWipe = null;          // (sessionIndex, targetName)
  }

  setRole(role) {
    this.localRole = role;
    this.updateModVisibility();
  }

  isMod() {
    return this.localRole >= 2;
  }

  isAdmin() {
    return this.localRole >= 3;
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

    // Update mute button text based on whether user is already muted
    if (this.isMod()) {
      const muteBtn = menu.querySelector('[data-action="mute"]');
      if (muteBtn && targetUser) {
        muteBtn.textContent = targetUser.isMuted ? 'Unmute' : 'Mute';
      }
    }

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
      case 'wipe':
        // Wipe all strokes from this user
        if (confirm(`Wipe all strokes from ${user?.username || 'User ' + sessionIndex}?`)) {
          if (this.onModWipe) this.onModWipe(sessionIndex, user?.username || '');
        }
        break;
      case 'mute':
        if (user?.isMuted) {
          // Unmute immediately (no dialog needed)
          if (this.onModAction) this.onModAction(3, sessionIndex, '', 0);
        } else {
          this.showModDialog('mute', sessionIndex, user);
        }
        break;
      case 'kick':
        this.showModDialog('kick', sessionIndex, user);
        break;
      case 'ban':
        this.showModDialog('ban', sessionIndex, user);
        break;
    }
  }

  // --- Mod Action Dialog ---

  /**
   * Show a dialog to collect reason/duration before executing a mod action
   * @param {'kick'|'mute'|'ban'} action
   * @param {number} sessionIndex
   * @param {Object} user
   */
  showModDialog(action, sessionIndex, user) {
    const username = user?.username || `User ${sessionIndex}`;

    // Action type codes: 0=kick, 1=mute, 2=ban
    const actionCodes = { kick: 0, mute: 1, ban: 2 };
    const actionCode = actionCodes[action];
    const isDanger = action === 'ban';
    const showDuration = action !== 'kick';

    const overlay = document.createElement('div');
    overlay.className = 'modDialog-overlay';

    const title = `${action.charAt(0).toUpperCase() + action.slice(1)} ${this.escapeHtml(username)}`;

    overlay.innerHTML = `
      <div class="modDialog">
        <h3 class="${isDanger ? 'danger' : ''}">${title}</h3>
        <label for="modDialogReason">Reason (optional)</label>
        <input type="text" id="modDialogReason" placeholder="Enter reason..." maxlength="200" autocomplete="off">
        ${showDuration ? `
          <label for="modDialogDuration">Duration</label>
          <select id="modDialogDuration">
            <option value="0">Permanent</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60" selected>1 hour</option>
            <option value="1440">1 day</option>
            <option value="10080">1 week</option>
          </select>
        ` : ''}
        <div class="modDialog-buttons">
          <a class="btn" id="modDialogCancel">Cancel</a>
          <a class="btn ${isDanger ? 'danger' : ''}" id="modDialogConfirm">${action.charAt(0).toUpperCase() + action.slice(1)}</a>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const reasonInput = overlay.querySelector('#modDialogReason');
    const durationSelect = overlay.querySelector('#modDialogDuration');
    const confirmBtn = overlay.querySelector('#modDialogConfirm');
    const cancelBtn = overlay.querySelector('#modDialogCancel');

    reasonInput.focus();

    const close = () => {
      overlay.remove();
    };

    const confirm = () => {
      const reason = reasonInput.value.trim();
      const duration = durationSelect ? Number(durationSelect.value) : 0;
      close();
      if (this.onModAction) {
        this.onModAction(actionCode, sessionIndex, reason, duration);
      }
    };

    confirmBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    reasonInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') close();
      e.stopPropagation();
    });
  }

  // --- Mod Panel ---

  togglePanel() {
    this.panelVisible = !this.panelVisible;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = this.panelVisible ? 'flex' : 'none';
    }
    // Request fresh data when opening
    if (this.panelVisible && this.onRequestModList) {
      this.onRequestModList();
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

  /**
   * Update mod entries from server MOD_LIST response
   */
  updateModEntries(entries) {
    // Map numeric type to tab name: 0=ban, 1=mute
    this.modEntries = (entries || []).map(e => ({
      id: e.id,
      type: e.type === 0 ? 'bans' : 'mutes',
      username: e.username || '',
      reason: e.reason || '',
      ip: e.ip || '',
      issuedBy: e.issuedBy || '',
      createdAt: e.createdAt || 0,
      expiresAt: e.expiresAt || 0,
      active: e.active
    }));
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

    list.innerHTML = filtered.map(entry => {
      const date = entry.createdAt ? new Date(Number(entry.createdAt)).toLocaleDateString() : '';
      const expires = entry.expiresAt
        ? new Date(Number(entry.expiresAt)).toLocaleDateString()
        : 'permanent';

      return `
        <div class="modEntry">
          <span class="modEntryUser">${this.escapeHtml(entry.username)}</span>
          <span class="modEntryReason">${this.escapeHtml(entry.reason || 'No reason')}</span>
          <span class="modEntryTime">${date} — ${expires}</span>
          <span class="modEntryInfo">${this.escapeHtml(entry.ip)} by ${this.escapeHtml(entry.issuedBy)}</span>
          <button class="modEntryAction" data-id="${this.escapeHtml(entry.id)}" data-type="${entry.type}" data-username="${this.escapeHtml(entry.username)}">Remove</button>
        </div>
      `;
    }).join('');

    // Wire up remove buttons
    list.querySelectorAll('.modEntryAction').forEach(btn => {
      btn.addEventListener('click', () => {
        const entryId = btn.dataset.id;
        const entryType = btn.dataset.type;
        const username = btn.dataset.username;
        if (this.onRevokeEntry) {
          this.onRevokeEntry(entryId, entryType, username);
        }
      });
    });
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
