/**
 * @fileoverview Mounts and manages Svelte UI components for the drawing app
 */

import { mount } from 'svelte';
import BoardMenu from './BoardMenu.svelte';
import ProfileDialog from './ProfileDialog.svelte';
import RoomSettings from './RoomSettings.svelte';
import ColorPalette from './ColorPalette.svelte';
import Chat from './Chat.svelte';

import { appState, showProfile as showProfileFromState } from '../../state.svelte.js';

/**
 * Initialize and mount all Svelte UI components
 * @param {Object} app - Main DrawingApp instance
 */
export function initSvelteUI(app) {
  const components = {};

  // Mount BoardMenu (top-right of board)
  const boardMenuTarget = document.getElementById('boardMenu');
  if (boardMenuTarget) {
    components.boardMenu = mount(BoardMenu, { target: boardMenuTarget });
  }

  // Mount ProfileDialog (modal)
  const profileDialogTarget = document.getElementById('profileDialogMount');
  if (profileDialogTarget) {
    components.profileDialog = mount(ProfileDialog, {
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
    components.roomSettings = mount(RoomSettings, {
      target: roomSettingsTarget,
      props: {
        wsClient: app.wsClient,
        board: app.board,
        onUpdate: (roomData) => {
          app.currentRoomData = roomData;
          appState.currentRoomData = roomData;
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
    components.colorPalette = mount(ColorPalette, {
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
    components.chat = mount(Chat, {
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
  showProfileFromState(username);
}

/**
 * Toggle chat visibility
 */
export function toggleChat() {
  appState.chatVisible = !appState.chatVisible;
}

/**
 * Sync state values from App instance
 * @param {Object} app - DrawingApp instance
 */
export function syncStoresFromApp(app) {
  if (app.board?.layerManager) {
    appState.layerManager = app.board.layerManager;
  }

  if (app.self) {
    appState.currentColor = app.self.color || [0, 0, 0, 255];
    appState.activeLayer = app.self.activeLayer ?? 2;
    appState.username = app.self.name || '';
  }

  if (app.currentRoomData) {
    appState.currentRoomData = app.currentRoomData;
  }

  if (app.selfRole !== undefined) {
    appState.selfRole = app.selfRole;
  }

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
    appState.users = userMap;
  }
}
