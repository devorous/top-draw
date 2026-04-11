import { appState } from '../state.svelte.js';
import { isTauriDesktop } from './desktop.js';

const CHANNEL_NAME = 'ddraw-chat-popout';

const ALLOWED_POPOUT_METHODS = new Set([
  'addChatMessage',
  'addChatDM',
  'addStaffMessage',
  'addStaffImage',
  'addDMImage',
  'addChatImage',
  'applyReaction'
]);

let mainChannel = null;
let popupChannel = null;
let popupWindowRef = null;
let mainBridgeConfig = null;

function canUseBridge() {
  return typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined';
}

function createChannel(onMessage) {
  if (!canUseBridge()) return null;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event) => onMessage?.(event.data);
  return channel;
}

function serializeUsers(users) {
  return [...users.values()].map((user) => ({ ...user }));
}

function applySharedState(sharedState = {}) {
  if (Array.isArray(sharedState.users)) {
    appState.users = new Map(sharedState.users.map((user) => [user.id, user]));
  }

  if (sharedState.sessionIndex !== undefined) {
    appState.sessionIndex = sharedState.sessionIndex;
  }

  if (sharedState.selfRole !== undefined) {
    appState.selfRole = sharedState.selfRole;
  }

  if ('dmRecipient' in sharedState) {
    appState.dmRecipient = sharedState.dmRecipient;
  }

  if (sharedState.chatUnreadCount !== undefined) {
    appState.chatUnreadCount = sharedState.chatUnreadCount;
  }
}

export function getChatSharedState() {
  return {
    users: serializeUsers(appState.users),
    sessionIndex: appState.sessionIndex,
    selfRole: appState.selfRole,
    dmRecipient: appState.dmRecipient,
    chatUnreadCount: appState.chatUnreadCount
  };
}

export function initMainChatPopoutBridge({ getSnapshot, handleAction, onPopupClosed } = {}) {
  if (!canUseBridge()) return;

  mainBridgeConfig = { getSnapshot, handleAction, onPopupClosed };

  if (mainChannel) {
    mainChannel.close();
  }

  mainChannel = createChannel((message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'chat-popout-request-snapshot') {
      const snapshot = mainBridgeConfig?.getSnapshot?.();
      if (snapshot) {
        mainChannel.postMessage({ type: 'chat-popout-snapshot', snapshot });
      }
      return;
    }

    if (message.type === 'chat-popout-action') {
      mainBridgeConfig?.handleAction?.(message.action);
      return;
    }

    if (message.type === 'chat-popout-closed') {
      popupWindowRef = null;
      mainBridgeConfig?.onPopupClosed?.();
    }
  });
}

export function isChatPopoutOpen() {
  return !!(popupWindowRef && !popupWindowRef.closed);
}

export function closeChatPopout() {
  if (popupWindowRef && !popupWindowRef.closed) {
    popupWindowRef.close?.();
    popupWindowRef = null;
  }
}

export function focusChatPopout() {
  if (popupWindowRef && !popupWindowRef.closed) {
    popupWindowRef.focus();
    return true;
  }
  return false;
}

export function openChatPopoutWindow() {
  if (typeof window === 'undefined') return;

  if (popupWindowRef && !popupWindowRef.closed) {
    popupWindowRef.focus();
    return popupWindowRef;
  }

  if (isTauriDesktop()) {
    void import('@tauri-apps/api/webviewWindow').then(async ({ WebviewWindow }) => {
      const chatWindow = new WebviewWindow('chat-popout', {
        url: '/chat/',
        title: 'DDraw Chat',
        width: 980,
        height: 760,
        minWidth: 760,
        minHeight: 640,
        decorations: false,
        resizable: true,
        center: true,
        focus: true
      });

      chatWindow.once('tauri://created', () => {
        popupWindowRef = {
          closed: false,
          focus: () => {
            void chatWindow.setFocus();
          },
          close: () => {
            void chatWindow.close();
          }
        };
      });

      chatWindow.once('tauri://error', (error) => {
        console.error('[ChatPopout] Failed to create popout window:', error);
      });

      chatWindow.once('tauri://destroyed', () => {
        popupWindowRef = null;
        mainBridgeConfig?.onPopupClosed?.();
      });
    });

    return null;
  }

  return null;
}

export function broadcastChatPopoutSnapshot(snapshot) {
  if (!mainChannel || !snapshot) return;
  mainChannel.postMessage({ type: 'chat-popout-snapshot', snapshot });
}

export function broadcastChatPopoutState(sharedState = getChatSharedState()) {
  if (!mainChannel) return;
  mainChannel.postMessage({ type: 'chat-popout-state', sharedState });
}

export function broadcastChatPopoutEvent(method, args = []) {
  if (!mainChannel) return;
  mainChannel.postMessage({ type: 'chat-popout-event', method, args });
}

export function initChatPopoutClient({ component }) {
  if (!canUseBridge()) return () => {};

  if (popupChannel) {
    popupChannel.close();
  }

  popupChannel = createChannel((message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'chat-popout-snapshot') {
      component?.applySnapshot?.(message.snapshot?.chat ?? null);
      applySharedState(message.snapshot?.sharedState ?? {});
      return;
    }

    if (message.type === 'chat-popout-state') {
      applySharedState(message.sharedState ?? {});
      return;
    }

    if (message.type === 'chat-popout-event') {
      const method = message.method;
      if (ALLOWED_POPOUT_METHODS.has(method) && typeof component?.[method] === 'function') {
        component[method](...(Array.isArray(message.args) ? message.args : []));
      }
    }
  });

  popupChannel.postMessage({ type: 'chat-popout-request-snapshot' });

  const handleBeforeUnload = () => {
    popupChannel?.postMessage({ type: 'chat-popout-closed' });
  };

  window.addEventListener('beforeunload', handleBeforeUnload);

  return () => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    popupChannel?.close();
    popupChannel = null;
  };
}

export function sendChatPopoutAction(action) {
  popupChannel?.postMessage({ type: 'chat-popout-action', action });
}
