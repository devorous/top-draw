/**
 * @fileoverview Mounts and manages Svelte UI components for the drawing app
 */

import { mount, unmount } from 'svelte';
import BoardMenu from './BoardMenu.svelte';
import ProfileDialog from './ProfileDialog.svelte';
import RoomSettings from './RoomSettings.svelte';
import AppSettings from './AppSettings.svelte';
import AdminPanel from './AdminPanel.svelte';
import ColorPalette from './ColorPalette.svelte';
import Chat from './Chat.svelte';
import Messenger from '../../messenger/Messenger.svelte';
import Timebar from '../../timebar/Timebar.svelte';
import FeedbackWidget from './FeedbackWidget.svelte';
import SnapshotMenu from './SnapshotMenu.svelte';

import { appState, showProfile as showProfileFromState, toggleMessenger } from '../../state.svelte.js';
import { messenger } from '../../messenger/messenger.svelte.js';
import { isTauriDesktop } from '../../platform/desktop.js';
import {
  broadcastChatPopoutState,
  closeChatPopout,
  focusChatPopout,
  getChatSharedState,
  initMainChatPopoutBridge,
  openChatPopoutWindow
} from '../../platform/chatPopoutBridge.js';

function chatNameColor(color) {
  if (!Array.isArray(color)) return color || '#8ba3c7';
  const [r = 139, g = 163, b = 199] = color;
  const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  if (luminance < 72) return 'var(--role-user)';
  return `rgb(${r}, ${g}, ${b})`;
}

// Internal wrapper to handle conditional rendering of Messenger based on appState
const MessengerWrapper = (function() {
  return class {
    constructor({ target, props }) {
      this.target = target;
      this.app = props.app;
      
      this.effect = $effect.root(() => {
        $effect(() => {
          const visible = appState.messengerVisible;
          const targetUser = appState.messengerTargetUser;

          if (visible) {
            if (!this.instance) {
              this.instance = mount(Messenger, {
                target: this.target,
                props: {
                  initialTargetUser: targetUser || null,
                  isFloating: true
                }
              });
            }
          } else {
            if (this.instance) {
              console.log('Unmounting Messenger');
              unmount(this.instance);
              this.instance = null;
            }
          }
        });
      });
    }
    
    destroy() {
      if (this.instance) unmount(this.instance);
      this.effect();
    }
  };
})();

// Internal wrapper for SnapshotMenu
const SnapshotMenuWrapper = (function() {
  return class {
    constructor({ target, props }) {
      this.target = target;
      this.app = props.app;
      
      this.effect = $effect.root(() => {
        $effect(() => {
          const visible = appState.snapshotMenuVisible;
          if (visible) {
            if (!this.instance) {
              this.instance = mount(SnapshotMenu, {
                target: this.target,
                props: { app: this.app }
              });
              // Sync the local isVisible state if needed, 
              // but SnapshotMenu.svelte uses appState.snapshotMenuVisible (Wait, let's check)
            }
          } else {
            if (this.instance) {
              unmount(this.instance);
              this.instance = null;
            }
          }
        });
      });
    }
    destroy() {
      if (this.instance) unmount(this.instance);
      this.effect();
    }
  };
})();

/**
 * Initialize and mount all Svelte UI components
 * @param {Object} app - Main DrawingApp instance
 */
export function initSvelteUI(app) {
  const components = {};
  const cleanupFns = [];
  const desktopClient = isTauriDesktop();

  if (desktopClient) {
    document.body.classList.add('desktop-window-chrome');
    cleanupFns.push(() => document.body.classList.remove('desktop-window-chrome'));
  }

  const chatBadgeEffect = $effect.root(() => {
    $effect(() => {
      const unread = appState.chatUnreadCount;
      const badgeEl = document.getElementById('chatBadge');
      const chatBtn = document.getElementById('chatBtn');
      if (!badgeEl || !chatBtn) return;

      if (unread > 0) {
        badgeEl.textContent = unread > 99 ? '99+' : String(unread);
        badgeEl.style.display = 'inline-flex';
        chatBtn.setAttribute('data-has-unread', 'true');
        chatBtn.setAttribute('aria-label', `Chat (${unread} unread)`);
      } else {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
        chatBtn.removeAttribute('data-has-unread');
        chatBtn.setAttribute('aria-label', 'Chat');
      }
    });
  });
  cleanupFns.push(chatBadgeEffect);

  const chatPopoutStateEffect = $effect.root(() => {
    $effect(() => {
      appState.users;
      appState.sessionIndex;
      appState.selfRole;
      appState.dmRecipient;
      appState.chatUnreadCount;
      broadcastChatPopoutState(getChatSharedState());
    });
  });
  cleanupFns.push(chatPopoutStateEffect);

  const messengerConnectionEffect = $effect.root(() => {
    $effect(() => {
      const registeredName = appState.self?.registeredName || '';
      if (registeredName) {
        void messenger.init(registeredName);
      } else {
        messenger.disconnect();
      }
    });
  });
  cleanupFns.push(messengerConnectionEffect);

  const messengerBadgeEffect = $effect.root(() => {
    $effect(() => {
      const unread = appState.messengerUnreadCount;
      const badgeEl = document.getElementById('inboxBadge');
      const inboxBtn = document.getElementById('inboxBtn');
      if (!badgeEl || !inboxBtn) return;

      if (unread > 0) {
        badgeEl.textContent = unread > 99 ? '99+' : String(unread);
        badgeEl.style.display = 'inline-flex';
        inboxBtn.setAttribute('data-has-unread', 'true');
        inboxBtn.setAttribute('aria-label', `Inbox (${unread} unread)`);
      } else {
        badgeEl.textContent = '';
        badgeEl.style.display = 'none';
        inboxBtn.removeAttribute('data-has-unread');
        inboxBtn.setAttribute('aria-label', 'Inbox');
      }
    });
  });
  cleanupFns.push(messengerBadgeEffect);

  // Mount Messenger (1-1 E2EE)
  const messengerTarget = document.getElementById('messengerMount');
  if (messengerTarget) {
    components.messenger = new MessengerWrapper({
      target: messengerTarget,
      props: { app }
    });
  }

  // Mount BoardMenu (top-right of board)
  const boardMenuTarget = document.getElementById('boardMenu');
  if (boardMenuTarget) {
    components.boardMenu = mount(BoardMenu, {
      target: boardMenuTarget,
      props: {
        onBlendModeChange: (mode) => app.handleBlendModeChange(mode),
        onLayerSelect: (layerIdx) => app.handleLayerSelect(layerIdx),
        onLayerVisibilityToggle: (layerIdx) => app.handleLayerVisibilityToggle(layerIdx),
      }
    });
  }

  // Mount ProfileDialog (modal)
  const profileDialogTarget = document.getElementById('profileDialogMount');
  if (profileDialogTarget) {
    // In Tauri, relative URLs resolve to tauri://localhost — use absolute URL instead
    const galleryBase = isTauriDesktop() ? 'https://ddraw.ca/gallery' : '/gallery';
    components.profileDialog = mount(ProfileDialog, {
      target: profileDialogTarget,
      props: {
        galleryBaseUrl: galleryBase,
        apiBaseUrl: '',
        onViewGallery: (username) => {
          window.open(`${galleryBase}?author=${encodeURIComponent(username)}`, '_blank');
        },
        onImageClick: (item) => {
          window.open(`${galleryBase}?id=${item.id}`, '_blank');
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
        ui: app.ui,
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

  let appSettingsTarget = document.getElementById('appSettingsMount');
  if (!appSettingsTarget) {
    appSettingsTarget = document.createElement('div');
    appSettingsTarget.id = 'appSettingsMount';
    document.body.appendChild(appSettingsTarget);
  }
  components.appSettings = mount(AppSettings, {
    target: appSettingsTarget,
    props: {
      app
    }
  });

  let adminPanelTarget = document.getElementById('adminPanelMount');
  if (!adminPanelTarget) {
    adminPanelTarget = document.createElement('div');
    adminPanelTarget.id = 'adminPanelMount';
    document.body.appendChild(adminPanelTarget);
  }
  components.adminPanel = mount(AdminPanel, {
    target: adminPanelTarget,
    props: {}
  });

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
            app.handlePaletteColorSelect(colorOrCallback);
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
        onPopout: () => {
          appState.chatVisible = false;
          openChatPopoutWindow();
        },
        onSend: (message) => app.handleChatSend?.(message),
        onStaffSend: (message) => app.handleStaffChatSend?.(message),
        onStaffSendImage: (imageData) => app.handleStaffChatImageSend?.(imageData),
        onDM: (message, recipientId) => app.handleDMSend?.(message, recipientId),
        onSendImage: (imageData, recipientId) => app.handleChatImageSend?.(imageData, recipientId),
        onReact: (payload) => app.handleChatReaction?.(payload)
      }
    });
  }

  initMainChatPopoutBridge({
    getSnapshot: () => ({
      chat: components.chat?.getSnapshot?.() ?? null,
      sharedState: getChatSharedState()
    }),
    handleAction: (action) => {
      if (!action || typeof action !== 'object') return;

      switch (action.type) {
        case 'send':
          app.handleChatSend?.(action.message);
          break;
        case 'staff-send':
          app.handleStaffChatSend?.(action.message);
          break;
        case 'staff-send-image':
          app.handleStaffChatImageSend?.(action.imageData);
          break;
        case 'dm-send':
          app.handleDMSend?.(action.message, action.recipientId);
          break;
        case 'send-image':
          app.handleChatImageSend?.(action.imageData, action.recipientId);
          break;
        case 'react':
          components.chat?.applyReaction?.(action.payload);
          if (app.connected && action.payload?.messageId && action.payload?.emoji) {
            app.wsClient.broadcastChatReaction(action.payload);
          }
          break;
        default:
          break;
      }
    }
  });

  // Listen for tray "Open Chat" event; close popout when main window closes
  if (isTauriDesktop()) {
    void import('@tauri-apps/api/event').then(({ listen }) => {
      listen('open-chat', () => {
        if (!focusChatPopout()) {
          openChatPopoutWindow();
        }
      });
    });
    window.addEventListener('beforeunload', () => closeChatPopout(), { once: true });
  }

  // Mount FeedbackWidget (in landing page form)
  const feedbackTarget = document.getElementById('feedbackWidgetMount');
  if (feedbackTarget) {
    components.feedbackWidget = mount(FeedbackWidget, {
      target: feedbackTarget,
      props: { page: 'app' }
    });
  }

  // Mount Timebar
  const timebarTarget = document.getElementById('timebarMount');
  if (timebarTarget) {
    components.timebar = mount(Timebar, {
      target: timebarTarget,
      props: {
        wsClient: app.wsClient
      }
    });
  }

  // Mount SnapshotMenu
  let snapshotMenuTarget = document.getElementById('snapshotMenuMount');
  if (!snapshotMenuTarget) {
    snapshotMenuTarget = document.createElement('div');
    snapshotMenuTarget.id = 'snapshotMenuMount';
    document.body.appendChild(snapshotMenuTarget);
  }
  components.snapshotMenu = new SnapshotMenuWrapper({
    target: snapshotMenuTarget,
    props: { app }
  });

  components._cleanup = () => {
    cleanupFns.forEach((cleanup) => cleanup?.());
  };

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
  if (focusChatPopout()) return;
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
    appState.username = app.self.username || app.self.name || '';
  }

  if (app.sessionIndex !== undefined) {
    appState.sessionIndex = app.sessionIndex;
  }

  if (app.currentRoomData) {
    appState.currentRoomData = app.currentRoomData;
  }

  if (app.appPreferences) {
    appState.appPreferences = app.appPreferences;
  }

  if (app.selfRole !== undefined) {
    appState.selfRole = app.selfRole;
  }

  if (app.users) {
    const userMap = new Map();
    app.users.forEach((user, id) => {
      userMap.set(id, {
        id,
        username: user.username || user.name || '',
        color: chatNameColor(user.color),
        registeredName: user.registeredName || '',
        role: user.role || 0,
        isSelf: id === app.sessionIndex
      });
    });
    appState.users = userMap;
  }
}
