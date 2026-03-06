/**
 * RoomSelector - UI for selecting or creating a drawing room
 */
export class RoomSelector {
  constructor({ onRoomSelected }) {
    this.onRoomSelected = onRoomSelected;
    this.els = {};
  }

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

  setupListeners() {
    // Create new room
    this.els.createRoomBtn?.addEventListener('click', () => this.createRoom());

    // Join existing room
    this.els.joinRoomBtn?.addEventListener('click', () => this.joinRoom());

    // Generate random room ID
    this.els.randomRoomBtn?.addEventListener('click', () => this.generateRandomRoomId());

    // Enter key on room ID input
    this.els.roomIdInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });

    // Refresh room list
    this.els.refreshRoomsBtn?.addEventListener('click', () => this.refreshRoomList());
  }

  /**
   * Check URL for room parameter and auto-join
   */
  checkUrlForRoom() {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');

    if (roomId) {
      // Auto-join room from URL
      this.joinRoomById(roomId);
      return true;
    }

    // No room in URL, show selector
    this.show();
    return false;
  }

  /**
   * Create a new room with random ID
   */
  createRoom() {
    const roomId = this.generateRoomId();
    this.joinRoomById(roomId);
  }

  /**
   * Join room with ID from input
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
   */
  joinRoomById(roomId, password = null) {
    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url);

    // Hide selector and trigger callback
    this.hide();

    if (this.onRoomSelected) {
      this.onRoomSelected(roomId, password);
    }
  }

  /**
   * Generate a random room ID
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
   * Generate and fill random room ID into input
   */
  generateRandomRoomId() {
    if (this.els.roomIdInput) {
      this.els.roomIdInput.value = this.generateRoomId();
    }
  }

  /**
   * Refresh the room list (when implemented on backend)
   */
  refreshRoomList() {
    // TODO: Fetch room list from server via WebSocket or HTTP
    console.log('[RoomSelector] Room list refresh not yet implemented');
  }

  /**
   * Show error message
   */
  showError(message) {
    // Use toast notification if available
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
   * Show the room selector
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
   * Hide the room selector
   */
  hide() {
    if (this.els.roomSelector) {
      this.els.roomSelector.style.display = 'none';
    }
  }

  /**
   * Get current room ID from URL
   */
  getCurrentRoomId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('room');
  }
}
