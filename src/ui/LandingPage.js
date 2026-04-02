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

    // Auto-trigger offline mode if URL is /go/offline
    if (this.getRoomFromURL() === 'offline') {
      if (this.onOffline) this.onOffline();
      return;
    }

    this.show();
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
      if (e.key !== 'Enter') return;
      e.preventDefault();
      document.getElementById('loginForm')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
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
      if (!this.selectedRoom) {
        this.selectRoom(this.getRoomFromURL() || 'lobby');
      }
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
   * Converts preview bytes to a data URL.
   * @param {Uint8Array|null} preview - Preview image bytes
   * @returns {string|null} - Data URL or null
   */
  previewToDataUrl(preview) {
    if (!preview || preview.length === 0) return null;
    try {
      const blob = new Blob([preview], { type: 'image/png' });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  /**
   * Render room list in the UI.
   * @param {Array} rooms - List of room objects
   */
  renderRooms(rooms) {
    if (!this.els.roomList) return;

    // Clean up old preview URLs
    if (this._previewUrls) {
      this._previewUrls.forEach(url => URL.revokeObjectURL(url));
    }
    this._previewUrls = [];

    if (rooms.length === 0) {
      this.els.roomList.innerHTML = '<div class="roomListEmpty">No active rooms. Create one to get started!</div>';
      return;
    }

    this.els.roomList.innerHTML = rooms.map(room => {
      const previewUrl = this.previewToDataUrl(room.preview);
      if (previewUrl) this._previewUrls.push(previewUrl);

      return `
      <div class="roomListItem ${this.selectedRoom === room.id ? 'selected' : ''}" data-room-id="${room.id}">
        ${previewUrl ? `
          <div class="roomPreview">
            <img src="${previewUrl}" alt="Room preview" loading="lazy" />
          </div>
        ` : `
          <div class="roomPreview roomPreviewEmpty">
            <span>No preview</span>
          </div>
        `}
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
    `}).join('');

    this.els.roomList.querySelectorAll('.roomListItem').forEach(item => {
      item.addEventListener('click', () => {
        const roomId = item.dataset.roomId;
        this.selectRoom(roomId);
      });
    });

    // Setup preview expansion on hover/tap
    this.setupPreviewExpansion();
  }

  /**
   * Sets up hover/tap expansion for room previews.
   */
  setupPreviewExpansion() {
    const previews = this.els.roomList.querySelectorAll('.roomPreview img');

    previews.forEach(img => {
      // Create expanded preview container (reuse existing or create new)
      let expandedPreview = document.getElementById('expandedRoomPreview');
      if (!expandedPreview) {
        expandedPreview = document.createElement('div');
        expandedPreview.id = 'expandedRoomPreview';
        expandedPreview.className = 'expandedRoomPreview';
        document.body.appendChild(expandedPreview);
      }

      const showExpanded = (e) => {
        const rect = img.getBoundingClientRect();
        expandedPreview.innerHTML = `<img src="${img.src}" alt="Expanded preview" />`;
        expandedPreview.style.display = 'block';

        // Position above or below the thumbnail depending on available space
        const previewHeight = Math.min(window.innerHeight * 0.4, 400);
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;

        if (spaceBelow >= previewHeight + 20 || spaceBelow > spaceAbove) {
          expandedPreview.style.top = `${rect.bottom + 8}px`;
          expandedPreview.style.bottom = 'auto';
        } else {
          expandedPreview.style.bottom = `${window.innerHeight - rect.top + 8}px`;
          expandedPreview.style.top = 'auto';
        }

        // Center horizontally relative to thumbnail
        const previewWidth = Math.min(window.innerWidth * 0.8, 600);
        let left = rect.left + rect.width / 2 - previewWidth / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - previewWidth - 10));
        expandedPreview.style.left = `${left}px`;
      };

      const hideExpanded = () => {
        expandedPreview.style.display = 'none';
      };

      // Desktop: hover
      img.addEventListener('mouseenter', showExpanded);
      img.addEventListener('mouseleave', hideExpanded);

      // Mobile: tap to toggle
      img.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        if (expandedPreview.style.display === 'block') {
          hideExpanded();
        } else {
          showExpanded(e);
        }
      });
    });

    // Hide expanded preview when clicking elsewhere
    document.addEventListener('click', (e) => {
      const expandedPreview = document.getElementById('expandedRoomPreview');
      if (expandedPreview && !e.target.closest('.roomPreview')) {
        expandedPreview.style.display = 'none';
      }
    });
  }

  /**
   * Join a room based on input or selection.
   */
  joinAsGuest() {
    if (!this.wsClient || !this.wsClient.connected) {
      this.showError('Not connected to server');
      return;
    }

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
    // Update URL to /go/roomName
    const newPath = `/go/${roomId}`;
    if (window.location.pathname !== newPath) {
      window.history.pushState({ room: roomId }, '', newPath);
    }

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
   * Get room ID from URL path (/go/roomName).
   * @returns {string|null} - Room ID or null
   */
  getRoomFromURL() {
    const path = window.location.pathname;
    const match = path.match(/^\/go\/([a-zA-Z0-9_-]+)$/);
    if (match) {
      const room = match[1];
      if (room.startsWith('offline-')) {
        return null;
      }
      return room;
    }
    return null;
  }

  /**
   * Show error message.
   * @param {string} message - Error message
   */
  showError(message) {
    const form = document.getElementById('loginForm');
    if (form) {
      let errorEl = document.getElementById('landingError');
      if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.id = 'landingError';
        errorEl.className = 'landingError';
        form.appendChild(errorEl);
      }
      errorEl.textContent = message;
      errorEl.style.display = 'block';
      return;
    }

    console.error('[LandingPage]', message);
  }

  /**
   * Clears any landing-page error message.
   */
  clearError() {
    const errorEl = document.getElementById('landingError');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
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
