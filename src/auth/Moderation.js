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

    // Whether mod UI elements have been injected into the DOM
    this._modUIInjected = false;

    // Context menu state
    this.targetSessionIndex = null;
    this.targetUser = null;
    this.targetIpHash = null;

    // Lazy-loaded PerformanceSettings instance
    this._perfSettings = null;
    this._perfSettingsLoading = false;

    // Callbacks wired by App.js
    this.onProfile = null;
    this.onSync = null;
    this.onSpectate = null;
    this.onPM = null;
    this.onModAction = null;         // (actionType, sessionIndex, reason, duration)
    this.onModUpdateReason = null;   // (originalActionCode, sessionIndex, reason)
    this.onModGroupUpdateReason = null; // (action, ipHash, reason)
    this.onRequestModList = null;    // ({ showHistory, search })
    this.onRevokeEntry = null;       // (entryId, type)
    this.onModWipe = null;           // (sessionIndex, targetName)
    this.onClear = null;             // ()
    this.onToggleDevMode = null;     // ()
    this.onRoomRoleSet = null;       // (targetUserId, role)
    this.onGlobalRoleSet = null;     // (targetUsername, newGlobalRole)
    this._wipePromptDismiss = null;
    this._clearPromptDismiss = null;
  }

  setRole(role) {
    this.localRole = role;
    this.updateModVisibility();
  }

  isMod() {
    return this.localRole >= 4;  // MOD(4)+
  }

  isAdmin() {
    return this.localRole >= 5;  // ADMIN(5)+
  }

  isOwner() {
    return this.localRole >= 6;  // OWNER(6)+
  }

  isDeity() {
    return this.localRole >= 9;  // DEITY(9) only
  }

  canManageRoomRoles() {
    return this.localRole >= 5;  // ADMIN(5)+
  }

  canMute() {
    return this.localRole >= 2;  // TRUSTED(2)+
  }

  canKickBanOrWipe() {
    return this.localRole >= 4;  // MOD(4)+
  }

  canUseMenuAction(action, targetUser, isGroup = false) {
    switch (action) {
      case 'mute':
        return this.canMute();
      case 'kick':
      case 'ban':
      case 'wipe':
        return this.canKickBanOrWipe();
      case 'shadowban':
      case 'promoteNoble':
      case 'promoteHoly':
      case 'demoteGlobal':
        return !isGroup && this.isDeity();
      case 'promote':
      case 'demote':
        return !isGroup && !!targetUser && this.canManageRoomRoles();
      case 'profile':
      case 'sync':
      case 'spectate':
        return !isGroup;
      default:
        return true;
    }
  }

  static roleName(role) {
    const names = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    return names[role] || 'Guest';
  }

  _ensureContextMenuInfo(menu) {
    let info = menu.querySelector('.menuInfo');
    if (info) return info;

    info = document.createElement('div');
    info.className = 'menuInfo';
    menu.prepend(info);
    return info;
  }

  _renderContextMenuInfo(menu, targetUser, ipHash = null) {
    const info = this._ensureContextMenuInfo(menu);
    const rows = [];

    if (targetUser) {
      rows.push({ label: 'Role', value: Moderation.roleName(targetUser.role || 0) });
      if (targetUser.visibleIp) {
        rows.push({ label: 'IP', value: targetUser.visibleIp });
      }
    } else if (ipHash) {
      rows.push({ label: 'Group', value: ipHash });
    }

    info.innerHTML = rows.map(({ label, value }) => (
      `<div class="menuInfoRow"><span class="menuInfoLabel">${label}</span><span class="menuInfoValue">${this.escapeHtml(String(value || ''))}</span></div>`
    )).join('');
    info.style.display = rows.length > 0 ? 'flex' : 'none';
  }

  /**
   * Show/hide .modOnly elements based on current role.
   * Injects mod-only toolbar buttons and panel into the DOM on first mod+ login.
   */
  updateModVisibility() {
    const hasToolbar = !!document.getElementById('modBtn');
    const hasPanel = !!document.getElementById('modPanel');

    if (this.isMod() && (!this._modUIInjected || !hasToolbar || !hasPanel)) {
      this._injectModUI();
    }

    const elements = document.querySelectorAll('.modOnly');
    elements.forEach(el => {
      if (this.isMod()) {
        el.classList.add('visible');
      } else {
        el.classList.remove('visible');
      }
    });

    // Admin-only elements (role assignment submenu) need ADMIN(5)+
    const adminElements = document.querySelectorAll('.adminOnly');
    adminElements.forEach(el => {
      if (this.isAdmin()) {
        el.classList.add('admin-visible');
      } else {
        el.classList.remove('admin-visible');
      }
    });
  }

  /**
   * Dynamically create and inject mod-only toolbar buttons and mod panel.
   * Called once when user is first confirmed as mod+.
   */
  _injectModUI() {
    const hasToolbar = !!document.getElementById('modBtn');
    const hasPanel = !!document.getElementById('modPanel');
    if (hasToolbar && hasPanel) {
      this._modUIInjected = true;
      return;
    }

    // --- Toolbar buttons ---
    const collapsible = document.getElementById('collapsibleBtns');
    if (collapsible && !hasToolbar) {
      const fragment = document.createDocumentFragment();

      // Clear button (inserted at the start of collapsible)
      const clearWrap = document.createElement('div');
      clearWrap.className = 'clearConfirmWrap modOnly';

      const clearBtn = document.createElement('a');
      clearBtn.className = 'btn';
      clearBtn.id = 'clearBtn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this._showClearPrompt(clearBtn);
      });
      clearWrap.appendChild(clearBtn);
      fragment.appendChild(clearWrap);

      // Dev button (toggles debug overlay)
      const devBtn = document.createElement('a');
      devBtn.className = 'btn modOnly';
      devBtn.id = 'devBtn';
      devBtn.innerHTML = '<span class="devOption">Dev</span>';
      devBtn.addEventListener('click', () => { if (this.onToggleDevMode) this.onToggleDevMode(); });
      fragment.appendChild(devBtn);

      // Mod button
      const modBtn = document.createElement('a');
      modBtn.className = 'btn modOnly';
      modBtn.id = 'modBtn';
      modBtn.textContent = 'Mod';
      modBtn.addEventListener('click', () => this.togglePanel());
      fragment.appendChild(modBtn);

      // Insert before the first child so Clear appears first
      collapsible.insertBefore(fragment, collapsible.firstChild);
    }

    // --- Mod panel ---
    const boardContainer = document.getElementById('boardContainer');
    if (boardContainer && !hasPanel) {
      const panel = document.createElement('div');
      panel.id = 'modPanel';
      panel.style.display = 'none';
      panel.innerHTML = `
        <div id="modPanelHeader">
          <div class="modTabs">
            <button class="modTab active" data-tab="bans">Bans</button>
            <button class="modTab" data-tab="mutes">Mutes</button>
            <button class="modTab deityOnly" data-tab="shadowbans">Shadow</button>
          </div>
          <button class="chatCloseBtn" id="modPanelCloseBtn">&times;</button>
        </div>
        <div class="modPanelControls">
          <input type="text" id="modSearchInput" class="modSearchInput" placeholder="Search username..." autocomplete="off">
          <button class="modHistoryToggle" id="modHistoryToggle">Active Only</button>
        </div>
        <div id="modEntryList" class="modEntryList">
          <div class="modNoEntries">No entries</div>
        </div>
      `;
      boardContainer.appendChild(panel);

      // Wire mod panel event listeners
      panel.querySelector('#modPanelCloseBtn')?.addEventListener('click', () => this.hidePanel());

      panel.querySelectorAll('.modTab').forEach(tab => {
        tab.addEventListener('click', () => this.setActiveTab(tab.dataset.tab));
      });

      const searchInput = panel.querySelector('#modSearchInput');
      if (searchInput) {
        let searchDebounce = null;
        searchInput.addEventListener('input', () => {
          clearTimeout(searchDebounce);
          searchDebounce = setTimeout(() => this.setSearch(searchInput.value.trim()), 300);
        });
        searchInput.addEventListener('keydown', (e) => e.stopPropagation());
      }

      const historyToggle = panel.querySelector('#modHistoryToggle');
      if (historyToggle) {
        historyToggle.addEventListener('click', () => this.setShowHistory(!this.showHistory));
      }
    }

    this._modUIInjected = !!document.getElementById('modBtn') && !!document.getElementById('modPanel');
  }

  /**
   * Lazy-load and show the PerformanceSettings modal.
   */
  async _showPerformanceSettings() {
    if (this._perfSettings) {
      this._perfSettings.show();
      return;
    }
    if (this._perfSettingsLoading) return;
    this._perfSettingsLoading = true;

    try {
      const { PerformanceSettings } = await import('../ui/PerformanceSettings.js');
      this._perfSettings = new PerformanceSettings();
      // board is available on window.app
      this._perfSettings.init(window.app.board);
      this._perfSettings.show();
    } catch (err) {
      console.error('[Mod] Failed to load PerformanceSettings:', err);
    } finally {
      this._perfSettingsLoading = false;
    }
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
    this._ensureSpectateMenuItem(menu);

    const isGroup = ipHash && !targetSessionIndex && targetSessionIndex !== 0;
    const isRegistered = targetUser && (targetUser.registeredName || targetUser.role >= 1);
    const isDeity = this.localRole >= 9;

    this._renderContextMenuInfo(menu, targetUser, ipHash);

    // Update mute button text based on whether user is already muted
    const muteBtn = menu.querySelector('[data-action="mute"]');
    if (muteBtn && targetUser && this.canMute()) {
      muteBtn.textContent = targetUser.isMuted ? 'Unmute' : 'Mute';
    }

    menu.querySelectorAll('.menuItem').forEach(item => {
      const action = item.dataset.action;
      const visible =
        (!item.classList.contains('group-only') || isGroup) &&
        (!item.classList.contains('registered-only') || isRegistered) &&
        (!item.classList.contains('deityOnly') || isDeity) &&
        (!action || this.canUseMenuAction(action, targetUser, isGroup));

      item.style.display = visible ? '' : 'none';
    });

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
    this.targetIpHash = null;
  }

  _ensureSpectateMenuItem(menu) {
    if (menu.querySelector('[data-action="spectate"]')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menuItem';
    button.dataset.action = 'spectate';
    button.textContent = 'Spectate';

    const syncButton = menu.querySelector('[data-action="sync"]');
    if (syncButton?.parentElement === menu) {
      syncButton.insertAdjacentElement('afterend', button);
    } else {
      menu.appendChild(button);
    }
  }

  /**
   * Handle context menu button clicks
   */
  async handleMenuAction(action, dataset = {}) {
    const sessionIndex = this.targetSessionIndex;
    const user = this.targetUser;
    const ipHash = this.targetIpHash;
    const anchorRect = this._getWipePromptAnchorRect(sessionIndex, ipHash);
    this.hideContextMenu();

    if (!sessionIndex && sessionIndex !== 0 && !ipHash) return;

    const isGroup = !!(ipHash && !sessionIndex && sessionIndex !== 0);
    const targetName = isGroup ? `Group ${ipHash}` : (user?.username || `User ${sessionIndex}`);
    const targetUsername = user?.username || targetName;

    switch (action) {
      case 'profile':
        if (this.onProfile) {
          const profileName = user?.registeredName || user?.username;
          if (profileName) this.onProfile(profileName);
        }
        return;
      case 'promote': {
        if (user && this.onRoomRoleSet) {
          const newRole = Math.min((user.role || 0) + 1, 5);
          this.onRoomRoleSet(sessionIndex, newRole);
        }
        return;
      }
      case 'demote': {
        if (user && this.onRoomRoleSet) {
          const newRole = Math.max((user.role || 0) - 1, 0);
          this.onRoomRoleSet(sessionIndex, newRole);
        }
        return;
      }
      case 'promoteNoble': {
        if (user && this.onGlobalRoleSet) {
          const targetUsername = user.registeredName || user.username || user.name;
          if (!targetUsername) {
            alert('Could not determine username for this user');
            return;
          }
          if (await window.showAppConfirm(`Promote ${targetUsername} to Noble (global rank)?`, {
            title: 'Promote global rank',
            confirmLabel: 'Promote'
          })) {
            this.onGlobalRoleSet(targetUsername, 7); // Noble = 7
          }
        }
        return;
      }
      case 'promoteHoly': {
        if (user && this.onGlobalRoleSet) {
          const targetUsername = user.registeredName || user.username || user.name;
          if (!targetUsername) {
            alert('Could not determine username for this user');
            return;
          }
          if (await window.showAppConfirm(`Promote ${targetUsername} to Holy (global rank)?`, {
            title: 'Promote global rank',
            confirmLabel: 'Promote'
          })) {
            this.onGlobalRoleSet(targetUsername, 8); // Holy = 8
          }
        }
        return;
      }
      case 'demoteGlobal': {
        if (user && this.onGlobalRoleSet) {
          const targetUsername = user.registeredName || user.username || user.name;
          if (!targetUsername) {
            alert('Could not determine username for this user');
            return;
          }
          const currentGlobalRole = user.globalRole || user.role || 0;
          if (currentGlobalRole >= 7) {
            // Demote from Noble/Holy to USER (1)
            if (await window.showAppConfirm(`Demote ${targetUsername} from global rank ${currentGlobalRole} to User?`, {
              title: 'Demote global rank',
              confirmLabel: 'Demote',
              danger: true
            })) {
              this.onGlobalRoleSet(targetUsername, 1); // USER = 1
            }
          }
        }
        return;
      }
      case 'sync':
        if (this.onSync) this.onSync(sessionIndex);
        break;
      case 'spectate':
        if (this.onSpectate) this.onSpectate(sessionIndex);
        break;
      case 'pm':
        if (this.onPM) this.onPM(sessionIndex, user);
        break;
      case 'wipe': {
        const targetLabel = isGroup ? `all users in IP group ${ipHash}` : targetName;
        if (await window.showAppConfirm(`Wipe all strokes from ${targetLabel}?`, {
          title: 'Wipe strokes?',
          confirmLabel: 'Wipe',
          danger: true
        })) {
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
          this.showWipePromptAfterAction('Muted', targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect);
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
        this.showWipePromptAfterAction('Kicked', targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect);
        this.showReasonCard('kick', sessionIndex, targetName, isGroup, ipHash);
        break;
      case 'ban':
        // Ban immediately (permanent), then offer reason
        if (isGroup) {
          if (this.onModGroupAction) this.onModGroupAction('ban', ipHash, '', 0);
        } else {
          if (this.onModAction) this.onModAction(2, sessionIndex, '', 0);
        }
        this.showWipePromptAfterAction('Banned', targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect);
        this.showReasonCard('ban', sessionIndex, targetName, isGroup, ipHash);
        break;
      case 'shadowban':
        if (isGroup) return;
        if (this.onModAction) this.onModAction(6, sessionIndex, '', 0);
        this.showReasonCard('shadowban', sessionIndex, targetName, false, ipHash);
        break;
    }
  }

  _showClearPrompt(anchor) {
    const existing = document.getElementById('clearConfirmPrompt');
    if (existing) existing.remove();
    if (this._clearPromptDismiss) {
      this._clearPromptDismiss();
      this._clearPromptDismiss = null;
    }

    const prompt = document.createElement('div');
    prompt.id = 'clearConfirmPrompt';
    prompt.className = 'clearConfirmPrompt';
    prompt.innerHTML = `
      <div class="clearConfirmText">Clear ALL layers?</div>
      <div class="clearConfirmActions">
        <button class="clearConfirmBtn clearConfirmBtn-danger" type="button">Clear</button>
        <button class="clearConfirmBtn" type="button">Cancel</button>
      </div>
    `;
    document.body.appendChild(prompt);
    this._positionClearPrompt(prompt, anchor);
    requestAnimationFrame(() => prompt.classList.add('clearConfirmPrompt-visible'));

    const clearBtn = prompt.querySelector('.clearConfirmBtn-danger');
    const cancelBtn = prompt.querySelectorAll('.clearConfirmBtn')[1];

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      prompt.classList.remove('clearConfirmPrompt-visible');
      setTimeout(() => prompt.remove(), 180);
      if (this._clearPromptDismiss === dismiss) {
        this._clearPromptDismiss = null;
      }
    };
    this._clearPromptDismiss = dismiss;

    clearBtn?.addEventListener('click', () => {
      if (this.onClear) this.onClear();
      dismiss();
    });
    cancelBtn?.addEventListener('click', dismiss);
  }

  _positionClearPrompt(prompt, anchor) {
    const margin = 8;
    const anchorRect = anchor?.getBoundingClientRect?.();
    if (!anchorRect) {
      prompt.style.left = `${margin}px`;
      prompt.style.top = `${margin}px`;
      return;
    }

    const promptRect = prompt.getBoundingClientRect();
    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;

    if (left + promptRect.width > window.innerWidth - margin) {
      left = window.innerWidth - promptRect.width - margin;
    }
    if (left < margin) left = margin;

    if (top + promptRect.height > window.innerHeight - margin) {
      const aboveTop = anchorRect.top - promptRect.height - 8;
      top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - promptRect.height - margin);
    }

    prompt.style.left = `${left}px`;
    prompt.style.top = `${top}px`;
  }

  _getWipePromptAnchorRect(sessionIndex, ipHash) {
    if (ipHash) {
      const groupHeader = document.querySelector(`.userGroup[data-ip-hash="${CSS.escape(ipHash)}"] .groupHeader`);
      if (groupHeader) return groupHeader.getBoundingClientRect();
    }

    if (sessionIndex || sessionIndex === 0) {
      const userEntry = document.querySelector(`.userEntry.u${sessionIndex}`);
      if (userEntry) return userEntry.getBoundingClientRect();
    }

    const userList = document.getElementById('userList');
    return userList?.getBoundingClientRect() || null;
  }

  showWipePromptAfterAction(actionLabel, targetName, isGroup, sessionIndex, ipHash, targetUsername, anchorRect) {
    const existing = document.getElementById('modWipePrompt');
    if (existing) existing.remove();
    if (this._wipePromptDismiss) {
      this._wipePromptDismiss();
      this._wipePromptDismiss = null;
    }

    const card = document.createElement('div');
    card.id = 'modWipePrompt';
    card.className = 'modWipePrompt';
    card.innerHTML = `
      <div class="modWipePrompt-header">
        <span class="modWipePrompt-title">${this.escapeHtml(actionLabel)} <strong>${this.escapeHtml(targetName)}</strong></span>
        <button class="modWipePrompt-close" type="button" title="Dismiss">✕</button>
      </div>
      <p class="modWipePrompt-text">${isGroup ? `Wipe current strokes for ${this.escapeHtml(targetName)}?` : `Wipe ${this.escapeHtml(targetName)}'s current strokes?`}</p>
      <div class="modWipePrompt-actions">
        <button class="modWipePrompt-btn modWipePrompt-btn-danger" type="button">Wipe Now</button>
        <button class="modWipePrompt-btn" type="button">Keep</button>
      </div>
      <div class="modWipePrompt-timer"></div>
    `;
    document.body.appendChild(card);

    this._positionWipePrompt(card, anchorRect);
    requestAnimationFrame(() => card.classList.add('modWipePrompt-visible'));

    const closeBtn = card.querySelector('.modWipePrompt-close');
    const wipeBtn = card.querySelector('.modWipePrompt-btn-danger');
    const keepBtn = card.querySelectorAll('.modWipePrompt-btn')[1];
    const timerBar = card.querySelector('.modWipePrompt-timer');
    const AUTO_DISMISS_MS = 12000;

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(autoTimeout);
      card.classList.remove('modWipePrompt-visible');
      setTimeout(() => card.remove(), 250);
      if (this._wipePromptDismiss === dismiss) {
        this._wipePromptDismiss = null;
      }
    };
    this._wipePromptDismiss = dismiss;

    const wipe = () => {
      if (isGroup) {
        if (this.onModGroupAction) this.onModGroupAction('wipe', ipHash);
      } else if (this.onModWipe) {
        this.onModWipe(sessionIndex, targetUsername || targetName || '');
      }
      dismiss();
    };

    closeBtn?.addEventListener('click', dismiss);
    keepBtn?.addEventListener('click', dismiss);
    wipeBtn?.addEventListener('click', wipe);

    requestAnimationFrame(() => {
      timerBar.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
      timerBar.style.width = '0%';
    });
    const autoTimeout = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  _positionWipePrompt(card, anchorRect) {
    const margin = 10;
    const cardRect = card.getBoundingClientRect();
    const fallbackLeft = Math.max(margin, window.innerWidth - cardRect.width - margin);
    const fallbackTop = 64;

    if (!anchorRect) {
      card.style.left = `${fallbackLeft}px`;
      card.style.top = `${fallbackTop}px`;
      return;
    }

    let left = anchorRect.left;
    let top = anchorRect.bottom + 8;

    if (left + cardRect.width > window.innerWidth - margin) {
      left = window.innerWidth - cardRect.width - margin;
    }
    if (left < margin) left = margin;

    if (top + cardRect.height > window.innerHeight - margin) {
      const aboveTop = anchorRect.top - cardRect.height - 8;
      top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - cardRect.height - margin);
    }

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // --- Reason Card (non-blocking, shown after instant action) ---

  /**
   * Show a small non-blocking card to optionally add a reason after an instant action.
   */
  showReasonCard(action, sessionIndex, targetName, isGroup, ipHash) {
    const existing = document.getElementById('modReasonCard');
    if (existing) existing.remove();

    const actionCodes = { kick: 0, mute: 1, ban: 2, shadowban: 6 };
    const actionCode = actionCodes[action];
    const isDanger = action === 'ban' || action === 'shadowban';
    const pastTense = { kick: 'Kicked', mute: 'Muted', ban: 'Banned', shadowban: 'Shadow Banned' };
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
    this.modEntries = (entries || []).map(e => ({
      id: e.id,
      type: e.type === 0 ? 'bans' : e.type === 1 ? 'mutes' : 'shadowbans',
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
