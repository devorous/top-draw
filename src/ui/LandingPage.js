/**
 * LandingPage - Unified interface for authentication and room selection
 */
export class LandingPage {
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

  init() {
    this.els = {
      landingPage: document.getElementById('landingPage'),
      roomList: document.getElementById('roomList'),
      joinRoomBtn: document.getElementById('joinRoomBtn'),
      roomIdInput: document.getElementById('roomIdInput'),
      refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
      joinBtn: document.getElementById('joinBtn'),
      loginOfflineBtn: document.getElementById('loginOfflineBtn'),
      landingConnectionStatus: document.getElementById('landingConnectionStatus')
    };

    this.setupListeners();

    // Always show landing page - never auto-join
    this.show();

    // Check URL for room parameter to pre-select it
    const urlRoom = this.getRoomFromURL();
    if (urlRoom) {
      // Just select it, don't join automatically
      this.selectedRoom = urlRoom;
    }

    // Set initial connection status - not connected until user joins
    this.updateConnectionStatus('disconnected');
  }

  setupListeners() {
    // Join room by ID
    this.els.joinRoomBtn?.addEventListener('click', () => this.joinRoomById());

    // Join as guest
    this.els.joinBtn?.addEventListener('click', () => this.joinAsGuest());

    // Offline mode
    this.els.loginOfflineBtn?.addEventListener('click', () => {
      if (this.onOffline) this.onOffline();
    });

    // Refresh rooms
    this.els.refreshRoomsBtn?.addEventListener('click', () => this.refreshRooms());

    // Enter key on room ID input
    this.els.roomIdInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoomById();
    });
  }

  /**
   * Show the landing page and load rooms
   */
  show() {
    // Show the overlay parent but make it transparent (landing page has its own background)
    const overlay = document.getElementById('overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.style.background = 'transparent';
      overlay.style.backdropFilter = 'none';
    }

    // Show the landing page
    if (this.els.landingPage) {
      this.els.landingPage.style.display = 'flex';
    }

    this.loadRooms();
  }

  /**
   * Hide the landing page
   */
  hide() {
    if (this.els.landingPage) {
      this.els.landingPage.style.display = 'none';
    }

    // Also hide overlay if nothing else is showing
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
   * Load room list from server
   */
  async loadRooms() {
    try {
      // Show lobby by default while loading
      const lobbyRoom = {
        id: 'lobby',
        userCount: 0,
        locked: false,
        hasPassword: false
      };
      this.rooms = [lobbyRoom];
      this.renderRooms(this.rooms);

      // Auto-select lobby
      this.selectRoom('lobby');
    } catch (err) {
      console.error('[LandingPage] Failed to load rooms:', err);
      this.showError('Failed to load rooms');
    }
  }

  /**
   * Refresh room list
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
   * Handle room list response from server
   */
  handleRoomListResponse(rooms) {
    this.rooms = rooms || [];

    // Ensure lobby is always at the top of the list
    const lobbyRoom = this.rooms.find(r => r.id === 'lobby');
    if (lobbyRoom) {
      // Remove lobby from current position and add to front
      this.rooms = this.rooms.filter(r => r.id !== 'lobby');
      this.rooms.unshift(lobbyRoom);
    } else {
      // Add lobby if not present
      this.rooms.unshift({
        id: 'lobby',
        userCount: 0,
        locked: false,
        hasPassword: false
      });
    }

    this.renderRooms(this.rooms);

    // Auto-select lobby if nothing is selected yet
    if (!this.selectedRoom) {
      this.selectRoom('lobby');
    }
  }

  /**
   * Render room list
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
          <div class="roomMeta">
            <span class="roomUserCount">${room.userCount || 0}</span>
            ${room.id === 'lobby' ? '<span class="roomBadge default">Default</span>' : ''}
            ${room.locked ? '<span class="roomBadge locked">Locked</span>' : ''}
            ${room.hasPassword ? '<span class="roomBadge">Password</span>' : ''}
          </div>
        </div>
      </div>
    `).join('');

    // Add click handlers to room items
    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.addEventListener('click', () => {
        const roomId = item.dataset.roomId;
        this.selectRoom(roomId);
      });
    });
  }

  /**
   * Join room by ID from input (creates room if it doesn't exist)
   */
  joinRoomById() {
    const roomId = this.els.roomIdInput?.value.trim();

    if (!roomId) {
      this.showError('Please enter a room name');
      return;
    }

    // Validate room name (alphanumeric, dashes, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
      this.showError('Room name can only contain letters, numbers, dashes, and underscores');
      return;
    }

    if (roomId.length < 2 || roomId.length > 20) {
      this.showError('Room name must be 2-20 characters');
      return;
    }

    this.selectRoom(roomId);
  }

  /**
   * Join as guest (anonymous)
   */
  joinAsGuest() {
    // Default to lobby if no room selected
    const roomId = this.selectedRoom || 'lobby';
    this.proceedToRoom(roomId, null);
  }

  /**
   * Select a room (stores selection, waits for auth)
   */
  selectRoom(roomId) {
    this.selectedRoom = roomId;

    // Update URL
    const url = new URL(window.location);
    url.searchParams.set('room', roomId);
    window.history.pushState({}, '', url);

    // Highlight selected room in list
    this.highlightRoom(roomId);

    // If already authenticated or auth handled by Auth component,
    // proceed directly. Otherwise wait for user to login/join.
    // For now, we'll let the user click "Join as Guest" or login
  }

  /**
   * Highlight selected room in UI
   */
  highlightRoom(roomId) {
    if (!this.els.roomList) return;

    // Remove previous selection
    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.classList.remove('selected');
    });

    // Highlight new selection
    const item = this.els.roomList.querySelector(`[data-room-id="${roomId}"]`);
    if (item) {
      item.classList.add('selected');
    }
  }

  /**
   * Proceed to room (called after auth)
   */
  proceedToRoom(roomId, password = null) {
    console.log(`[LandingPage] Proceeding to room: ${roomId}`);

    this.hide();

    if (this.onRoomSelected) {
      this.onRoomSelected(roomId, password);
    }
  }

  /**
   * Handle successful authentication
   */
  handleAuthSuccess(token, username) {
    this.isAuthenticated = true;
    this.authToken = token;
    this.username = username;

    // If a room is selected, proceed to it
    if (this.selectedRoom) {
      this.proceedToRoom(this.selectedRoom);
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
   * Update connection status display
   */
  updateConnectionStatus(status) {
    if (!this.els.landingConnectionStatus) return;

    const statusEl = this.els.landingConnectionStatus;
    const textEl = statusEl.querySelector('.connectionText');

    // Remove all status classes
    statusEl.classList.remove('connected', 'disconnected', 'connecting');

    switch (status) {
      case 'connected':
        statusEl.classList.add('connected');
        textEl.textContent = 'Connected';
        // Enable room features
        this.setRoomFeaturesEnabled(true);
        // Auto-load room list
        if (this.wsClient && this.wsClient.connected) {
          this.wsClient.requestRoomList();
        }
        break;

      case 'disconnected':
        statusEl.classList.add('disconnected');
        textEl.textContent = 'Not Connected';
        // Keep room features enabled - connection happens when joining
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
   * Enable/disable room features based on connection
   */
  setRoomFeaturesEnabled(enabled) {
    // Create and Join by ID always work (don't need server connection)
    // Only refresh requires connection
    if (this.els.refreshRoomsBtn) {
      this.els.refreshRoomsBtn.disabled = !enabled;
      this.els.refreshRoomsBtn.classList.toggle('disabled', !enabled);
    }

    // Room list should still show lobby even when disconnected
    // Don't change the room list here
  }

  /**
   * Get room ID from URL
   */
  getRoomFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('room');
  }

  /**
   * Show error message
   */
  showError(message) {
    // Use toast notification if available
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
}
