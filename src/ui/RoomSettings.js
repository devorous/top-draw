/** @fileoverview UI for managing room settings. */

import { T } from '../../shared/MessageTypes.js';

/**
 * RoomSettings class - only accessible for registered (owned) rooms
 */
export class RoomSettings {
  /**
   * @param {Object} params
   * @param {WebSocketClient} params.wsClient - WebSocket client instance
   * @param {Board} params.board - Board instance
   * @param {UI} params.ui - UI instance
   * @param {Function} params.onUpdate - Callback for room updates
   * @param {Function} [params.onUnregister] - Callback when room is unregistered
   */
  constructor({ wsClient, board, ui, onUpdate, onUnregister }) {
    this.wsClient = wsClient;
    this.board = board;
    this.ui = ui;
    this.onUpdate = onUpdate;
    this.onUnregister = onUnregister;
    this.visible = false;
    this.currentRoom = null;
    this.els = {};
  }

  /**
   * Initializes DOM element references and event listeners.
   */
  init() {
    this.els = {
      overlay: document.getElementById('roomSettingsOverlay'),
      dialog: document.querySelector('.roomSettingsDialog'),
      closeBtn: document.getElementById('roomSettingsCloseBtn'),
      cancelBtn: document.getElementById('roomSettingsCancelBtn'),
      saveBtn: document.getElementById('roomSettingsSaveBtn'),
      unregisterBtn: document.getElementById('roomSettingsUnregisterBtn'),
      message: document.getElementById('roomSettingsMessage'),
      idInput: document.getElementById('roomSettingsId'),
      descInput: document.getElementById('roomSettingsDescription'),
      ownerInput: document.getElementById('roomSettingsOwner'),
      backgroundColorInput: document.getElementById('roomSettingsBackgroundColor'),
      lockedCheck: document.getElementById('roomSettingsLocked'),
      maxUsersInput: document.getElementById('roomSettingsMaxUsers')
    };

    this.setupListeners();
    this.setupModResultListener();
  }

  /**
   * Sets up event listeners for the settings dialog.
   */
  setupListeners() {
    this.els.closeBtn?.addEventListener('click', () => this.hide());
    this.els.cancelBtn?.addEventListener('click', () => this.hide());

    this.els.overlay?.addEventListener('click', (e) => {
      if (e.target === this.els.overlay) this.hide();
    });

    this.els.saveBtn?.addEventListener('click', () => this.save());
    this.els.unregisterBtn?.addEventListener('click', () => this.confirmUnregister());

    this.els.descInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) this.save();
    });
  }

  /**
   * Sets up listener for MOD_RESULT responses from server.
   */
  setupModResultListener() {
    // Track if we're waiting for a save response
    this._waitingForSave = false;

    this.wsClient.on('mod_result', (data) => {
      // Only respond if we initiated a save from this dialog
      if (!this._waitingForSave) return;

      this._waitingForSave = false;

      if (data.success) {
        this.showMessage('Settings saved!', 'success');
      } else {
        this.showMessage(data.error || 'Failed to save settings', 'error');
      }
    });

    // Listen for settings updates to refresh the dialog
    this.wsClient.on('settings', (data) => {
      if (!this.visible || !this.currentRoom) return;

      // Update displayed values if dialog is open
      if (data.backgroundColor && this.els.backgroundColorInput) {
        this.els.backgroundColorInput.value = data.backgroundColor;
        this.currentRoom.backgroundColor = data.backgroundColor;
      }
    });
  }

  /**
   * Shows a temporary message in the settings dialog.
   * @param {string} text - Message text
   * @param {string} type - Message type ('success' or 'error')
   */
  showMessage(text, type = 'success') {
    if (!this.els.message) return;

    this.els.message.textContent = text;
    this.els.message.className = `roomSettingsMessage ${type}`;
    this.els.message.style.display = 'block';

    setTimeout(() => {
      if (this.els.message) {
        this.els.message.style.display = 'none';
      }
    }, 3000);
  }

  /**
   * Show the room settings dialog
   * @param {Object} roomData - Current room data from server
   * @param {number} userRole - User's role level
   * @param {string} [username] - Current user's username
   */
  show(roomData, userRole, username) {
    if (!roomData) return;

    console.log('[RoomSettings] Opening with roomData:', roomData);

    this.currentRoom = roomData;
    this.userRole = userRole;
    this.currentUsername = username;

    if (this.els.idInput) this.els.idInput.value = roomData.id || '';
    if (this.els.descInput) this.els.descInput.value = roomData.description || '';
    if (this.els.ownerInput) {
      this.els.ownerInput.value = roomData.ownerUsername || 'Unregistered';
    }
    if (this.els.backgroundColorInput) {
      // Get current background color from Board (convert RGBA array to hex)
      const [r, g, b] = this.board.backgroundColor;
      const bgColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      this.els.backgroundColorInput.value = bgColor;
    }
    if (this.els.lockedCheck) this.els.lockedCheck.checked = !!roomData.locked;
    if (this.els.maxUsersInput) {
      const maxUsers = roomData.maxUsers !== undefined ? roomData.maxUsers : 40;
      console.log('[RoomSettings] Setting maxUsers to:', maxUsers, 'from roomData.maxUsers:', roomData.maxUsers);
      this.els.maxUsersInput.value = maxUsers;
    }

    // Show unregister button only for room owner (by username) or DEITY (role 9+)
    // and only if the room is registered
    if (this.els.unregisterBtn) {
      const isOwner = roomData.ownerUsername && username && roomData.ownerUsername === username;
      const isDeity = userRole >= 9;
      const hasOwner = !!roomData.ownerId;
      this.els.unregisterBtn.style.display = (hasOwner && (isOwner || isDeity)) ? '' : 'none';
    }

    if (this.els.overlay) {
      this.els.overlay.style.display = 'flex';
    }

    this.visible = true;

    setTimeout(() => this.els.descInput?.focus(), 100);
  }

  /**
   * Hides the room settings dialog.
   */
  hide() {
    if (this.els.overlay) {
      this.els.overlay.style.display = 'none';
    }
    this.visible = false;
    this.currentRoom = null;
  }

  /**
   * Saves room settings and sends updates to the server.
   */
  save() {
    if (!this.currentRoom) return;

    const description = this.els.descInput?.value.trim() || '';
    const backgroundColor = this.els.backgroundColorInput?.value || '#ffffff';
    const locked = this.els.lockedCheck?.checked || false;
    let maxUsers = parseInt(this.els.maxUsersInput?.value) || 40;

    // Clamp max users to 2-60 range
    maxUsers = Math.max(2, Math.min(60, maxUsers));

    // Update the input to show clamped value
    if (this.els.maxUsersInput) {
      this.els.maxUsersInput.value = maxUsers;
    }

    this.wsClient.send({
      t: T.ROOM_UPDATE,
      roomDescription: description,
      roomBackgroundColor: backgroundColor,
      roomLocked: locked,
      roomMaxUsers: maxUsers
    });

    // Show floating toast
    this.ui.showToast('Settings saved!');

    if (this.onUpdate) {
      this.onUpdate({
        ...this.currentRoom,
        description,
        backgroundColor,
        locked,
        maxUsers
      });
    }
  }

  /**
   * Shows confirmation dialog before unregistering.
   */
  confirmUnregister() {
    if (!this.currentRoom) return;

    const roomName = this.currentRoom.id;
    const confirmed = confirm(
      `Are you sure you want to unregister "${roomName}"?\n\n` +
      `This will remove ownership and allow anyone to register the room.`
    );

    if (confirmed) {
      this.unregister();
    }
  }

  /**
   * Unregisters the room (removes ownership).
   */
  unregister() {
    if (!this.currentRoom) return;

    this.wsClient.send({ t: T.ROOM_UNREGISTER });
    this.hide();

    if (this.onUnregister) {
      this.onUnregister();
    }
  }

  /**
   * Check if user can edit room settings
   * @param {Object} roomData - Room information
   * @param {number} userRole - User's role level (0-9)
   * @returns {boolean} - True if the user has permission to edit
   */
  canEdit(roomData, userRole) {
    // Room must be registered (have an owner) to have settings
    if (!roomData.ownerId) return false;

    // Global ranks (NOBLE=7, HOLY=8, DEITY=9) can edit any registered room
    if (userRole >= 7) return true;

    // OWNER(6) can edit their room
    if (userRole >= 6) return true;

    // ADMIN(5) can edit registered rooms
    if (userRole >= 5) return true;

    return false;
  }
}
