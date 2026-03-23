/**
 * @fileoverview Mounts and manages Svelte UI components for the drawing app
 */

import BoardMenu from './BoardMenu.svelte';
import ProfileDialog from './ProfileDialog.svelte';
import RoomSettings from './RoomSettings.svelte';
import ColorPalette from './ColorPalette.svelte';
import Chat from './Chat.svelte';

import {
  layerManager,
  currentColor,
  blendMode,
  activeLayer,
  currentRoomData,
  username,
  selfRole,
  profileDialogState,
  users,
  chatVisible
} from '../../stores.js';

/**
 * Initialize and mount all Svelte UI components
 * @param {Object} app - Main DrawingApp instance
 */
export function initSvelteUI(app) {
  const components = {};

  // Mount BoardMenu (top-right of board)
  const boardMenuTarget = document.getElementById('boardMenu');
  if (boardMenuTarget) {
    components.boardMenu = new BoardMenu({
      target: boardMenuTarget
    });
  }

  // Mount ProfileDialog (modal)
  const profileDialogTarget = document.getElementById('profileDialogMount');
  if (profileDialogTarget) {
    components.profileDialog = new ProfileDialog({
      target: profileDialogTarget,
      props: {
        galleryBaseUrl: '/gallery',
        apiBaseUrl: '',
        onViewGallery: (username) => {
          window.location.href = `/gallery?author=${encodeURIComponent(username)}`;
        },
        onImageClick: (item) => {
          window.location.href = `/gallery?id=${item.id}`;
        }
      }
    });
  }

  // Mount RoomSettings (modal)
  const roomSettingsTarget = document.getElementById('roomSettingsMount');
  if (roomSettingsTarget) {
    components.roomSettings = new RoomSettings({
      target: roomSettingsTarget,
      props: {
        wsClient: app.wsClient,
        board: app.board,
        onUpdate: (roomData) => {
          app.currentRoomData = roomData;
          currentRoomData.set(roomData);
        },
        onUnregister: () => {
          if (app.currentRoomData) {
            app.currentRoomData.ownerId = null;
            app.currentRoomData.ownerUsername = null;
          }
          app.updateRoomSettingsButtonVisibility?.();
          setTimeout(() => app.wsClient.requestRoomList(), 500);
          app.ui?.showToast('Room unregistered');
        }
      }
    });
  }

  // Mount ColorPalette
  const colorPaletteTarget = document.getElementById('colorPaletteMount');
  if (colorPaletteTarget) {
    components.colorPalette = new ColorPalette({
      target: colorPaletteTarget,
      props: {
        onColorSelect: (colorOrCallback) => {
          if (typeof colorOrCallback === 'function') {
            colorOrCallback(app.self?.color || [0, 0, 0, 255]);
          } else {
            app.handleColorChange(colorOrCallback);
          }
        }
      }
    });
  }

  // Mount Chat
  const chatTarget = document.getElementById('chatMount');
  if (chatTarget) {
    components.chat = new Chat({
      target: chatTarget,
      props: {
        onSend: (message) => app.handleChatSend?.(message),
        onDM: (message, recipientId) => app.handleDMSend?.(message, recipientId),
        onSendImage: (imageData, recipientId) => app.handleChatImageSend?.(imageData, recipientId)
      }
    });
  }

  return components;
}

/**
 * Helper to show profile dialog
 * @param {string} username - Username to show profile for
 */
export function showProfile(username) {
  profileDialogState.update(state => ({
    ...state,
    visible: true,
    username,
    loading: true,
    error: null
  }));

  // Fetch profile data
  fetch(`/api/users/${encodeURIComponent(username)}`)
    .then(res => res.json())
    .then(data => {
      if (data.error) {
        profileDialogState.update(state => ({
          ...state,
          loading: false,
          error: data.error
        }));
      } else {
        profileDialogState.update(state => ({
          ...state,
          loading: false,
          data
        }));
      }
    })
    .catch(err => {
      profileDialogState.update(state => ({
        ...state,
        loading: false,
        error: 'Connection error'
      }));
    });
}

/**
 * Helper to toggle chat visibility
 */
export function toggleChat() {
  chatVisible.update(v => !v);
}

/**
 * Sync store values from App instance
 * @param {Object} app - DrawingApp instance
 */
export function syncStoresFromApp(app) {
  // Sync layer manager reference
  if (app.board?.layerManager) {
    layerManager.set(app.board.layerManager);
  }

  // Sync self data
  if (app.self) {
    currentColor.set(app.self.color || [0, 0, 0, 255]);
    activeLayer.set(app.self.activeLayer ?? 2);
    username.set(app.self.name || '');
  }

  // Sync room data
  if (app.currentRoomData) {
    currentRoomData.set(app.currentRoomData);
  }

  // Sync role
  if (app.selfRole !== undefined) {
    selfRole.set(app.selfRole);
  }

  // Sync users
  if (app.users) {
    const userMap = new Map();
    app.users.forEach((user, id) => {
      userMap.set(id, {
        id,
        username: user.name,
        color: `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3] / 255})`,
        isSelf: id === app.sessionIndex
      });
    });
    users.set(userMap);
  }
}
