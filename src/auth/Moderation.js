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
    this.showHistory = false;
    this.searchQuery = '';

    // Context menu state
    this.targetSessionIndex = null;
    this.targetUser = null;
    this.targetIpHash = null;

    // Callbacks wired by App.js
    this.onSync = null;
    this.onPM = null;
    this.onModAction = null;         // (actionType, sessionIndex, reason, duration)
    this.onModUpdateReason = null;   // (originalActionCode, sessionIndex, reason)
    this.onModGroupUpdateReason = null; // (action, ipHash, reason)
    this.onRequestModList = null;    // ({ showHistory, search })
    this.onRevokeEntry = null;       // (entryId, type)
    this.onModWipe = null;           // (sessionIndex, targetName)
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
  showContextMenu(event, targetSessionIndex, targetUser, ipHash = null) {
    event.preventDefault();
    event.stopPropagation();

    this.targetSessionIndex = targetSessionIndex;
    this.targetUser = targetUser;
    this.targetIpHash = ipHash;

    const menu = document.getElementById('userContextMenu');
    if (!menu) return;

    // Show/hide group-specific menu items
    const groupItems = menu.querySelectorAll('.group-only');
    const isGroup = ipHash && !targetSessionIndex && targetSessionIndex !== 0;
    groupItems.forEach(item => {
      item.style.display = isGroup ? 'block' : 'none';
    });

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
    const ipHash = this.targetIpHash;
    this.hideContextMenu();

    if (!sessionIndex && sessionIndex !== 0 && !ipHash) return;

    const isGroup = !!(ipHash && !sessionIndex && sessionIndex !== 0);
    const targetName = isGroup ? `Group ${ipHash}` : (user?.username || `User ${sessionIndex}`);

    switch (action) {
      case 'sync':
        if (this.onSync) this.onSync(sessionIndex);
        break;
      case 'pm':
        if (this.onPM) this.onPM(sessionIndex, user);
        break;
      case 'wipe': {
        const targetLabel = isGroup ? `all users in IP group ${ipHash}` : targetName;
        if (confirm(`Wipe all strokes from ${targetLabel}?`)) {
          if (isGroup) {
            if (this.onModGroupAction) this.onModGroupAction('wipe', ipHash);
          } else {
            if (this.onModWipe) this.onModWipe(sessionIndex, user?.username || '');
          }
        }
        break;
      }
      case 'mute':
        if (user?.isMuted && !ipHash) {
          // Unmute immediately
          if (this.onModAction) this.onModAction(3, sessionIndex, '', 0);
        } else {
          // Mute immediately with 1hr default, then offer reason
          if (isGroup) {
            if (this.onModGroupAction) this.onModGroupAction('mute', ipHash, '', 60);
          } else {
            if (this.onModAction) this.onModAction(1, sessionIndex, '', 60);
          }
          this.showReasonCard('mute', sessionIndex, targetName, isGroup, ipHash);
        }
        break;
      case 'kick':
        // Kick immediately, then offer reason
        console.log('[Mod] Kick clicked, sessionIndex:', sessionIndex, 'isGroup:', isGroup, 'ipHash:', ipHash, 'onModAction:', !!this.onModAction);
        if (isGroup) {
          if (this.onModGroupAction) this.onModGroupAction('kick', ipHash, '', 0);
        } else {
          if (this.onModAction) this.onModAction(0, sessionIndex, '', 0);
        }
        this.showReasonCard('kick', sessionIndex, targetName, isGroup, ipHash);
        break;
      case 'ban':
        // Ban immediately (permanent), then offer reason
        if (isGroup) {
          if (this.onModGroupAction) this.onModGroupAction('ban', ipHash, '', 0);
        } else {
          if (this.onModAction) this.onModAction(2, sessionIndex, '', 0);
        }
        this.showReasonCard('ban', sessionIndex, targetName, isGroup, ipHash);
        break;
    }
  }

  // --- Reason Card (non-blocking, shown after instant action) ---

  /**
   * Show a small non-blocking card to optionally add a reason after an instant action.
   */
  showReasonCard(action, sessionIndex, targetName, isGroup, ipHash) {
    const existing = document.getElementById('modReasonCard');
    if (existing) existing.remove();

    const actionCodes = { kick: 0, mute: 1, ban: 2 };
    const actionCode = actionCodes[action];
    const isDanger = action === 'ban';
    const pastTense = { kick: 'Kicked', mute: 'Muted', ban: 'Banned' };
    const actionLabel = pastTense[action] || action;

    const card = document.createElement('div');
    card.id = 'modReasonCard';
    card.className = `modReasonCard${isDanger ? ' danger' : ''}`;
    card.innerHTML = `
      <div class="modReasonCard-header">
        <span class="modReasonCard-title">✓ ${actionLabel}: <strong>${this.escapeHtml(targetName)}</strong></span>
        <button class="modReasonCard-close" id="modReasonClose" title="Dismiss">✕</button>
      </div>
      <div class="modReasonCard-body">
        <input type="text" id="modReasonInput" class="modReasonCard-input" placeholder="Add a reason... (optional)" maxlength="200" autocomplete="off">
        <button class="modReasonCard-submit" id="modReasonSubmit">Add</button>
      </div>
      <div class="modReasonCard-timer" id="modReasonTimer"></div>
    `;
    document.body.appendChild(card);

    requestAnimationFrame(() => card.classList.add('modReasonCard-visible'));

    const input = card.querySelector('#modReasonInput');
    const submitBtn = card.querySelector('#modReasonSubmit');
    const closeBtn = card.querySelector('#modReasonClose');
    const timerBar = card.querySelector('#modReasonTimer');

    input.focus();

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(autoTimeout);
      card.classList.remove('modReasonCard-visible');
      setTimeout(() => card.remove(), 250);
    };

    const submit = () => {
      const reason = input.value.trim();
      if (reason) {
        if (isGroup) {
          if (this.onModGroupUpdateReason) this.onModGroupUpdateReason(action, ipHash, reason);
        } else {
          if (this.onModUpdateReason) this.onModUpdateReason(actionCode, sessionIndex, reason);
        }
      }
      dismiss();
    };

    submitBtn.addEventListener('click', submit);
    closeBtn.addEventListener('click', dismiss);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') dismiss();
      e.stopPropagation();
      // Reset auto-dismiss on typing
      clearTimeout(autoTimeout);
      timerBar.style.transition = 'none';
      timerBar.style.width = '100%';
      autoTimeout = setTimeout(dismiss, AUTO_DISMISS_MS);
      requestAnimationFrame(() => {
        timerBar.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
        timerBar.style.width = '0%';
      });
    });

    // Auto-dismiss timer with progress bar
    const AUTO_DISMISS_MS = 8000;
    requestAnimationFrame(() => {
      timerBar.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
      timerBar.style.width = '0%';
    });
    let autoTimeout = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  // --- Mod Panel ---

  _requestList() {
    if (this.onRequestModList) {
      this.onRequestModList({ showHistory: this.showHistory, search: this.searchQuery });
    }
  }

  togglePanel() {
    this.panelVisible = !this.panelVisible;
    const panel = document.getElementById('modPanel');
    if (panel) {
      panel.style.display = this.panelVisible ? 'flex' : 'none';
    }
    if (this.panelVisible) {
      this._requestList();
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

  setShowHistory(val) {
    this.showHistory = val;
    const btn = document.getElementById('modHistoryToggle');
    if (btn) {
      btn.textContent = val ? 'All History' : 'Active Only';
      btn.classList.toggle('active', val);
    }
    this._requestList();
  }

  setSearch(query) {
    this.searchQuery = query;
    this._requestList();
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
      const label = this.searchQuery
        ? `No ${this.activeTab} match "${this.escapeHtml(this.searchQuery)}"`
        : `No ${this.activeTab}`;
      list.innerHTML = `<div class="modNoEntries">${label}</div>`;
      return;
    }

    const now = Date.now();

    list.innerHTML = filtered.map(entry => {
      const createdDate = entry.createdAt
        ? new Date(Number(entry.createdAt)).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : '';
      const expiresDate = entry.expiresAt
        ? new Date(Number(entry.expiresAt)).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        : 'Permanent';

      const isExpired = entry.expiresAt && Number(entry.expiresAt) < now;
      const statusLabel = !entry.active ? 'Revoked' : isExpired ? 'Expired' : 'Active';
      const statusClass = !entry.active ? 'revoked' : isExpired ? 'expired' : 'active';

      const canRemove = entry.active && !isExpired;

      return `
        <div class="modEntry ${statusClass}">
          <div class="modEntryTop">
            <span class="modEntryUser">${this.escapeHtml(entry.username)}</span>
            <span class="modEntryStatus ${statusClass}">${statusLabel}</span>
          </div>
          ${entry.reason ? `<div class="modEntryReason">"${this.escapeHtml(entry.reason)}"</div>` : ''}
          <div class="modEntryMeta">
            <span>by ${this.escapeHtml(entry.issuedBy || 'Unknown')}</span>
            <span>${createdDate}</span>
          </div>
          <div class="modEntryMeta">
            <span class="modEntryIp">${this.escapeHtml(entry.ip)}</span>
            <span>expires: ${expiresDate}</span>
          </div>
          ${canRemove ? `<button class="modEntryRemove" data-id="${this.escapeHtml(entry.id)}" data-type="${entry.type}" data-username="${this.escapeHtml(entry.username)}">Revoke</button>` : ''}
        </div>
      `;
    }).join('');

    // Wire up revoke buttons
    list.querySelectorAll('.modEntryRemove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.onRevokeEntry) {
          this.onRevokeEntry(btn.dataset.id, btn.dataset.type, btn.dataset.username);
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
