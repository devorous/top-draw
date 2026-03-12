/**
 * @fileoverview Unified interface for authentication and room selection.
 */

/**
 * LandingPage class
 */
export class LandingPage {
  /**
   * @param {Object} params
   * @param {WebSocketClient} params.wsClient - WebSocket client instance
   * @param {Auth} params.auth - Auth manager instance
   * @param {Function} params.onRoomSelected - Callback when room is selected
   * @param {Function} params.onOffline - Callback for offline mode
   */
  constructor({ wsClient, auth, onRoomSelected, onOffline }) {
    this.wsClient = wsClient;
    this.auth = auth;
    this.onRoomSelected = onRoomSelected;
    this.onOffline = onOffline;
    this.els = {};
    this.rooms = [];
    this.selectedRoom = null;
    this.isAuthenticated = false;
    this.authToken = null;
    this.username = null;
  }

  /**
   * Initializes the landing page component.
   */
  init() {
    this.els = {
      landingPage: document.getElementById('landingPage'),
      roomList: document.getElementById('roomList'),
      roomIdInput: document.getElementById('roomIdInput'),
      refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
      joinBtn: document.getElementById('joinBtn'),
      loginOfflineBtn: document.getElementById('loginOfflineBtn'),
      landingConnectionStatus: document.getElementById('landingConnectionStatus')
    };

    this.setupListeners();
    this.show();

    const urlRoom = this.getRoomFromURL();
    if (urlRoom) {
      this.selectedRoom = urlRoom;
      if (this.els.roomIdInput) {
        this.els.roomIdInput.value = urlRoom;
      }
    }

    this.updateConnectionStatus('disconnected');
  }

  /**
   * Checks if the landing page is currently visible.
   * @returns {boolean}
   */
  get isVisible() {
    return this.els.landingPage && this.els.landingPage.style.display !== 'none';
  }

  /**
   * Sets up event listeners for the landing page.
   */
  setupListeners() {
    this.els.loginOfflineBtn?.addEventListener('click', () => {
      if (this.onOffline) this.onOffline();
    });

    this.els.refreshRoomsBtn?.addEventListener('click', () => this.refreshRooms());

    this.els.roomIdInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinAsGuest();
    });
  }

  /**
   * Show the landing page and load rooms.
   */
  show() {
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.style.background = 'transparent';
      overlay.style.backdropFilter = 'none';
    }

    if (this.els.landingPage) {
      this.els.landingPage.style.display = 'flex';
    }

    this.loadRooms();
  }

  /**
   * Hide the landing page.
   */
  hide() {
    if (this.els.landingPage) {
      this.els.landingPage.style.display = 'none';
    }

    const overlay = document.getElementById('overlay');
    const login = document.getElementById('login');
    const connecting = document.getElementById('connecting');
    if (overlay &&
        (!login || login.style.display === 'none') &&
        (!connecting || connecting.style.display === 'none')) {
      overlay.style.display = 'none';
    }
  }

  /**
   * Load room list from server.
   * @returns {Promise<void>}
   */
  async loadRooms() {
    try {
      const lobbyRoom = {
        id: 'lobby',
        userCount: 0,
        locked: false,
        hasPassword: false
      };
      this.rooms = [lobbyRoom];
      this.renderRooms(this.rooms);
      this.selectRoom('lobby');
    } catch (err) {
      console.error('[LandingPage] Failed to load rooms:', err);
      this.showError('Failed to load rooms');
    }
  }

  /**
   * Refresh room list from the server.
   */
  refreshRooms() {
    if (this.wsClient && this.wsClient.connected) {
      this.wsClient.requestRoomList();
      this.renderRooms([]);
      this.els.roomList.innerHTML = '<div class="roomListEmpty">Loading rooms...</div>';
    } else {
      this.showError('Not connected to server');
    }
  }

  /**
   * Handle room list response from server.
   * @param {Array} rooms - List of room objects
   */
  handleRoomListResponse(rooms) {
    this.rooms = rooms || [];

    const lobbyRoom = this.rooms.find(r => r.id === 'lobby');
    if (lobbyRoom) {
      this.rooms = this.rooms.filter(r => r.id !== 'lobby');
      this.rooms.unshift(lobbyRoom);
    } else {
      this.rooms.unshift({
        id: 'lobby',
        userCount: 0,
        locked: false,
        hasPassword: false
      });
    }

    this.renderRooms(this.rooms);

    if (!this.selectedRoom) {
      this.selectRoom('lobby');
    }
  }

  /**
   * Render room list in the UI.
   * @param {Array} rooms - List of room objects
   */
  renderRooms(rooms) {
    if (!this.els.roomList) return;

    if (rooms.length === 0) {
      this.els.roomList.innerHTML = '<div class="roomListEmpty">No active rooms. Create one to get started!</div>';
      return;
    }

    this.els.roomList.innerHTML = rooms.map(room => `
      <div class="roomListItem ${this.selectedRoom === room.id ? 'selected' : ''}" data-room-id="${room.id}">
        <div class="roomInfo">
          <div class="roomId">${room.id}</div>
          ${room.description ? `<div class="roomDescription">${this.escapeHtml(room.description)}</div>` : ''}
          <div class="roomMeta">
            <span class="roomUserCount">${room.userCount || 0} ${room.userCount === 1 ? 'user' : 'users'}</span>
            ${room.id === 'lobby' ? '<span class="roomBadge default">Default</span>' : ''}
            ${room.locked ? '<span class="roomBadge locked">Locked</span>' : ''}
            ${room.hasPassword ? '<span class="roomBadge">Password</span>' : ''}
          </div>
        </div>
      </div>
    `).join('');

    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.addEventListener('click', () => {
        const roomId = item.dataset.roomId;
        this.selectRoom(roomId);
      });
    });
  }

  /**
   * Join a room based on input or selection.
   */
  joinAsGuest() {
    let roomId = this.els.roomIdInput?.value.trim() || this.selectedRoom || 'lobby';

    if (roomId !== 'lobby') {
      if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
        this.showError('Room name can only contain letters, numbers, dashes, and underscores');
        return;
      }
      if (roomId.length < 2 || roomId.length > 20) {
        this.showError('Room name must be 2-20 characters');
        return;
      }
    }

    this.selectedRoom = roomId;
    this.proceedToRoom(roomId, null);
  }

  /**
   * Select a room in the UI.
   * @param {string} roomId - Room identifier
   */
  selectRoom(roomId) {
    this.selectedRoom = roomId;

    if (this.els.roomIdInput) {
      this.els.roomIdInput.value = roomId;
    }

    this.highlightRoom(roomId);
  }

  /**
   * Highlight selected room in UI.
   * @param {string} roomId - Room identifier
   */
  highlightRoom(roomId) {
    if (!this.els.roomList) return;

    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.classList.remove('selected');
    });

    const item = this.els.roomList.querySelector(`[data-room-id="${roomId}"]`);
    if (item) {
      item.classList.add('selected');
    }
  }

  /**
   * Proceed to join a specific room.
   * @param {string} roomId - Room identifier
   * @param {string|null} password - Optional room password
   */
  proceedToRoom(roomId, password = null) {
    console.log(`[LandingPage] Proceeding to room: ${roomId}`);
    this.hide();
    if (this.onRoomSelected) {
      this.onRoomSelected(roomId, password);
    }
  }

  /**
   * Handle successful authentication.
   * @param {string} token - Auth token
   * @param {string} username - Logged-in username
   */
  handleAuthSuccess(token, username) {
    this.isAuthenticated = true;
    this.authToken = token;
    this.username = username;
  }

  /**
   * Generate a random room ID.
   * @returns {string} - Randomly generated ID
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
   * Update connection status display.
   * @param {string} status - Connection status string
   */
  updateConnectionStatus(status) {
    if (!this.els.landingConnectionStatus) return;

    const statusEl = this.els.landingConnectionStatus;
    const textEl = statusEl.querySelector('.connectionText');

    statusEl.classList.remove('connected', 'disconnected', 'connecting');

    switch (status) {
      case 'connected':
        statusEl.classList.add('connected');
        textEl.textContent = 'Connected';
        this.setRoomFeaturesEnabled(true);
        if (this.wsClient && this.wsClient.connected) {
          this.wsClient.requestRoomList();
        }
        break;

      case 'disconnected':
        statusEl.classList.add('disconnected');
        textEl.textContent = 'Not Connected';
        this.setRoomFeaturesEnabled(false);
        break;

      case 'connecting':
      default:
        statusEl.classList.add('connecting');
        textEl.textContent = 'Connecting...';
        this.setRoomFeaturesEnabled(false);
        break;
    }
  }

  /**
   * Enable/disable room features based on connection.
   * @param {boolean} enabled - Whether features should be enabled
   */
  setRoomFeaturesEnabled(enabled) {
    if (this.els.refreshRoomsBtn) {
      this.els.refreshRoomsBtn.disabled = !enabled;
      this.els.refreshRoomsBtn.classList.toggle('disabled', !enabled);
    }
  }

  /**
   * Get room ID from URL query parameters.
   * @returns {string|null} - Room ID or null
   */
  getRoomFromURL() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room && room.startsWith('offline-')) {
      return null;
    }
    return room;
  }

  /**
   * Show error message.
   * @param {string} message - Error message
   */
  showError(message) {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    } else {
      console.error('[LandingPage]', message);
    }
  }

  /**
   * Escape HTML to prevent XSS.
   * @param {string} str - Input string
   * @returns {string} - Escaped string
   */
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
