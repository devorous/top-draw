/** @fileoverview UI for managing room settings. */

/**
 * RoomSettings class
 */
export class RoomSettings {
  /**
   * @param {Object} params
   * @param {WebSocketClient} params.wsClient - WebSocket client instance
   * @param {Function} params.onUpdate - Callback for room updates
   */
  constructor({ wsClient, onUpdate }) {
    this.wsClient = wsClient;
    this.onUpdate = onUpdate;
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
      idInput: document.getElementById('roomSettingsId'),
      descInput: document.getElementById('roomSettingsDescription'),
      ownerInput: document.getElementById('roomSettingsOwner'),
      lockedCheck: document.getElementById('roomSettingsLocked'),
      maxUsersInput: document.getElementById('roomSettingsMaxUsers')
    };

    this.setupListeners();
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

    this.els.descInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) this.save();
    });
  }

  /**
   * Show the room settings dialog
   * @param {Object} roomData - Current room data from server
   * @param {number} userRole - User's role level
   * @param {string} userId - User's unique ID
   */
  show(roomData, userRole, userId) {
    if (!roomData) return;

    this.currentRoom = roomData;
    this.userRole = userRole;
    this.userId = userId;

    if (this.els.idInput) this.els.idInput.value = roomData.id || '';
    if (this.els.descInput) this.els.descInput.value = roomData.description || '';
    if (this.els.ownerInput) {
      this.els.ownerInput.value = roomData.ownerUsername || 'Unclaimed';
    }
    if (this.els.lockedCheck) this.els.lockedCheck.checked = !!roomData.locked;
    if (this.els.maxUsersInput) this.els.maxUsersInput.value = roomData.maxUsers || 0;

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
    const locked = this.els.lockedCheck?.checked || false;
    const maxUsers = parseInt(this.els.maxUsersInput?.value) || 0;

    this.wsClient.send({
      t: 66, // T.ROOM_UPDATE
      roomDescription: description,
      roomLocked: locked,
      roomMaxUsers: maxUsers,
      roomOwnerId: this.userId // Claim ownership if unclaimed
    });

    this.hide();

    if (this.onUpdate) {
      this.onUpdate({
        ...this.currentRoom,
        description,
        locked,
        maxUsers
      });
    }
  }

  /**
   * Check if user can edit room settings
   * @param {Object} roomData - Room information
   * @param {number} userRole - User's role level
   * @param {string} userId - User's unique ID
   * @returns {boolean} - True if the user has permission to edit
   */
  canEdit(roomData, userRole, userId) {
    if (!userId) return false;

    if (roomData.ownerId === userId) return true;

    if (userRole >= 2) return true;

    if (!roomData.ownerId) return true;

    return false;
  }
}
