/**
 * RoomSettings - UI for managing room settings
 */
export class RoomSettings {
  constructor({ wsClient, onUpdate }) {
    this.wsClient = wsClient;
    this.onUpdate = onUpdate;
    this.visible = false;
    this.currentRoom = null;
    this.els = {};
  }

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

  setupListeners() {
    // Close handlers
    this.els.closeBtn?.addEventListener('click', () => this.hide());
    this.els.cancelBtn?.addEventListener('click', () => this.hide());

    // Close on overlay click
    this.els.overlay?.addEventListener('click', (e) => {
      if (e.target === this.els.overlay) this.hide();
    });

    // Save handler
    this.els.saveBtn?.addEventListener('click', () => this.save());

    // Enter to save
    this.els.descInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) this.save();
    });
  }

  /**
   * Show the room settings dialog
   * @param {Object} roomData - Current room data from server
   */
  show(roomData, userRole, userId) {
    if (!roomData) return;

    this.currentRoom = roomData;
    this.userRole = userRole;
    this.userId = userId;

    // Populate fields
    if (this.els.idInput) this.els.idInput.value = roomData.id || '';
    if (this.els.descInput) this.els.descInput.value = roomData.description || '';
    if (this.els.ownerInput) {
      this.els.ownerInput.value = roomData.ownerUsername || 'Unclaimed';
    }
    if (this.els.lockedCheck) this.els.lockedCheck.checked = !!roomData.locked;
    if (this.els.maxUsersInput) this.els.maxUsersInput.value = roomData.maxUsers || 0;

    // Show overlay
    if (this.els.overlay) {
      this.els.overlay.style.display = 'flex';
    }

    this.visible = true;

    // Focus description field
    setTimeout(() => this.els.descInput?.focus(), 100);
  }

  hide() {
    if (this.els.overlay) {
      this.els.overlay.style.display = 'none';
    }
    this.visible = false;
    this.currentRoom = null;
  }

  save() {
    if (!this.currentRoom) return;

    const description = this.els.descInput?.value.trim() || '';
    const locked = this.els.lockedCheck?.checked || false;
    const maxUsers = parseInt(this.els.maxUsersInput?.value) || 0;

    // Send update to server
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
   */
  canEdit(roomData, userRole, userId) {
    // Must be logged in
    if (!userId) return false;

    // Room owner can always edit
    if (roomData.ownerId === userId) return true;

    // Mods (role >= 2) can edit any room
    if (userRole >= 2) return true;

    // If room is unclaimed, any logged-in user can claim it
    if (!roomData.ownerId) return true;

    return false;
  }
}
