/** @fileoverview UI for selecting or creating a drawing room. */

/**
 * RoomSelector class
 */
export class RoomSelector {
  /**
   * @param {Object} params
   * @param {Function} params.onRoomSelected - Callback when a room is selected
   */
  constructor({ onRoomSelected }) {
    this.onRoomSelected = onRoomSelected;
    this.els = {};
  }

  /**
   * Initializes DOM element references and event listeners.
   */
  init() {
    this.els = {
      overlay: document.getElementById('overlay'),
      roomSelector: document.getElementById('roomSelector'),
      createRoomBtn: document.getElementById('createRoomBtn'),
      joinRoomBtn: document.getElementById('joinRoomBtn'),
      roomIdInput: document.getElementById('roomIdInput'),
      roomPasswordInput: document.getElementById('roomPasswordInput'),
      randomRoomBtn: document.getElementById('randomRoomBtn'),
      roomList: document.getElementById('roomList'),
      refreshRoomsBtn: document.getElementById('refreshRoomsBtn')
    };

    this.setupListeners();
    this.checkUrlForRoom();
  }

  /**
   * Sets up event listeners for the room selector UI.
   */
  setupListeners() {
    this.els.createRoomBtn?.addEventListener('click', () => this.createRoom());
    this.els.joinRoomBtn?.addEventListener('click', () => this.joinRoom());
    this.els.randomRoomBtn?.addEventListener('click', () => this.generateRandomRoomId());

    this.els.roomIdInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });

    this.els.refreshRoomsBtn?.addEventListener('click', () => this.refreshRoomList());
  }

  /**
   * Check URL for room parameter and auto-join.
   * @returns {boolean} - True if a room ID was found in the URL
   */
  checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');

    if (roomId) {
      this.joinRoomById(roomId);
      return true;
    }

    this.show();
    return false;
  }

  /**
   * Create a new room with random ID.
   */
  createRoom() {
    const roomId = this.generateRoomId();
    this.joinRoomById(roomId);
  }

  /**
   * Join room with ID from input.
   */
  joinRoom() {
    const roomId = this.els.roomIdInput?.value.trim();
    const password = this.els.roomPasswordInput?.value;

    if (!roomId) {
      this.showError('Please enter a room ID');
      return;
    }

    this.joinRoomById(roomId, password);
  }

  /**
   * Join a specific room by ID
   * @param {string} roomId - Room identifier
   * @param {string} [password] - Optional room password
   */
  joinRoomById(roomId, password = null) {
    const url = new URL(window.location);
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url);

    this.hide();

    if (this.onRoomSelected) {
      this.onRoomSelected(roomId, password);
    }
  }

  /**
   * Generate a random room ID
   * @returns {string} - Randomly generated room ID
   */
  generateRoomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  /**
   * Generate and fill random room ID into input.
   */
  generateRandomRoomId() {
    if (this.els.roomIdInput) {
      this.els.roomIdInput.value = this.generateRoomId();
    }
  }

  /**
   * Refresh the room list (placeholder for future implementation).
   */
  refreshRoomList() {
    console.log('[RoomSelector] Room list refresh not yet implemented');
  }

  /**
   * Show error message using toast notification or alert.
   * @param {string} message - Error message to display
   */
  showError(message) {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = message;
      toast.style.display = 'block';
      setTimeout(() => {
        toast.style.display = 'none';
      }, 3000);
    } else {
      alert(message);
    }
  }

  /**
   * Show the room selector UI.
   */
  show() {
    if (this.els.roomSelector) {
      this.els.roomSelector.style.display = 'block';
    }
    if (this.els.overlay) {
      this.els.overlay.style.display = 'flex';
    }
  }

  /**
   * Hide the room selector UI.
   */
  hide() {
    if (this.els.roomSelector) {
      this.els.roomSelector.style.display = 'none';
    }
  }

  /**
   * Get current room ID from URL.
   * @returns {string|null} - Current room ID or null
   */
  getCurrentRoomId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('room');
  }
}
