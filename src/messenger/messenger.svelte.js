import { getRoomId } from '../utils/crypto.js';
import { appState } from '../state.svelte.js';
import { playSfx } from '../utils/sfx.js';

const TOKEN_KEY = 'topDrawAuthToken';
const USERNAME_KEY = 'topDrawUsername';

function resolveMessengerWsBase() {
  const configured = (
    import.meta.env.VITE_MESSENGER_WS_SERVER_URL ||
    import.meta.env.VITE_WS_SERVER_URL ||
    ''
  ).trim();

  const isLocalPage =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '0.0.0.0';

  if (isLocalPage) {
    const configuredIsLocal = /^(wss?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(configured);
    if (!configured || configuredIsLocal) {
      return 'wss://top-draw.koyeb.app';
    }
  }

  if (configured) {
    return configured;
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}`;
}

function getStoredMessengerIdentity(fallback = '') {
  const preferred = (fallback || '').trim();
  if (preferred) {
    return preferred;
  }

  try {
    return (localStorage.getItem(USERNAME_KEY) || '').trim();
  } catch {
    return preferred;
  }
}

class MessengerState {
  messages = $state([]);
  inbox = $state([]); // [{ roomId, lastMessage, otherUserId }]
  unreadCounts = $state({}); // { [room_id]: number }
  isConnected = $state(false);
  activeChat = $state(null); // User object { id, name }
  ws = null;
  currentUserId = null;
  view = $state('inbox'); // 'inbox' or 'chat'
  _pendingInboxRefresh = false;
  _pendingTargetUser = null;
  _isReady = false;

  // Derived state
  unreadCount = $derived(this.messages.filter(m => !m.read && m.receiver_id === this.currentUserId).length);
  
  groupedMessages = $derived(() => {
    const groups = {};
    this.messages.forEach(m => {
      const date = new Date(m.timestamp).toLocaleDateString();
      if (!groups[date]) groups[date] = [];
      groups[date].push(m);
    });
    return groups;
  });

  syncUnreadBadge(counts = this.unreadCounts) {
    const total = Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0);
    appState.messengerUnreadCount = total;
  }


  async init(currentUserId, targetUser = null) {
    const nextUserId = getStoredMessengerIdentity(currentUserId);
    const existingUserId = this.currentUserId;
    this.currentUserId = nextUserId;
    this._pendingTargetUser = targetUser;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || !this.currentUserId) {
      this.isConnected = false;
      this._isReady = false;
      this.syncUnreadBadge();
      return;
    }

    if (this.ws && existingUserId === this.currentUserId) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.fetchInbox();
        if (this._pendingTargetUser) {
          const pendingTarget = this._pendingTargetUser;
          this._pendingTargetUser = null;
          void this.openChat(pendingTarget);
        }
        return;
      }

      if (this.ws.readyState === WebSocket.CONNECTING) {
        return;
      }
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const wsBase = resolveMessengerWsBase();
    const wsUrl = wsBase.replace(/\/$/, '');
    this.ws = new WebSocket(
      `${wsUrl}/messenger?userId=${encodeURIComponent(this.currentUserId)}&token=${encodeURIComponent(token)}`
    );
    
    this.ws.onopen = () => {
      this.isConnected = true;
      this._isReady = false;
    };

    this.ws.onmessage = async (event) => {
      const { type, payload } = JSON.parse(event.data);
      
      if (type === 'ready') {
        this._isReady = true;
        this.fetchInbox();
        if (this._pendingTargetUser) {
          const pendingTarget = this._pendingTargetUser;
          this._pendingTargetUser = null;
          this.openChat(pendingTarget);
        }
      } else if (type === 'inbox') {
        // Server decrypts at rest and sends plaintext `content`.
        this.inbox = payload;
      } else if (type === 'history') {
        this.messages = payload;
      } else if (type === 'new_message') {
        const isIncoming = payload.sender_id !== this.currentUserId;
        const roomId = getRoomId(this.currentUserId, this.activeChat?.id);
        if (payload.room_id === roomId) {
          this.messages.push(payload);
        } else if (isIncoming) {
          // Incoming message from a different conversation — increment unread
          this.unreadCounts = {
            ...this.unreadCounts,
            [payload.room_id]: (this.unreadCounts[payload.room_id] ?? 0) + 1
          };
          this.syncUnreadBadge();
        }
        if (isIncoming) playSfx('inbox');
        // Refresh inbox in all cases to update last message
        this.fetchInbox();
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this._isReady = false;
      this._pendingInboxRefresh = false;
      this._pendingTargetUser = null;
      this.ws = null;
    };
  }

  fetchInbox() {
    if (!this.ws || !this.currentUserId) return;
    if (!this.isConnected || !this._isReady) {
      this._pendingInboxRefresh = true;
      return;
    }

    this._pendingInboxRefresh = false;
    this.ws.send(JSON.stringify({ type: 'get_inbox', payload: { userId: this.currentUserId } }));
  }

  refreshOnOpen() {
    this.fetchInbox();
  }

  async openChat(user) {
    this.activeChat = user;
    this.view = 'chat';
    const roomId = getRoomId(this.currentUserId, user.id);
    // Clear unread count for this conversation
    if (this.unreadCounts[roomId]) {
      const { [roomId]: _, ...rest } = this.unreadCounts;
      this.unreadCounts = rest;
      this.syncUnreadBadge();
    }
    this.messages = []; // Clear for new chat
    
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify({ type: 'init_chat', payload: { roomId } }));
    }
  }

  backToInbox() {
    this.activeChat = null;
    this.view = 'inbox';
    this.messages = [];
    this.fetchInbox();
  }

  async sendMessage(text) {
    if (!this.ws || !this.isConnected || !this.activeChat) return;

    const roomId = getRoomId(this.currentUserId, this.activeChat.id);

    // Plaintext over TLS; the server encrypts at rest.
    this.ws.send(JSON.stringify({
      type: 'send_message',
      payload: {
        room_id: roomId,
        sender_id: this.currentUserId,
        receiver_id: this.activeChat.id,
        content: text
      }
    }));
  }

  cleanup() {
    this.activeChat = null;
    this.messages = [];
    this.view = 'inbox';
    this._pendingInboxRefresh = false;
    this._pendingTargetUser = null;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
    this.messages = [];
    this.inbox = [];
    this.unreadCounts = {};
    this.isConnected = false;
    this._isReady = false;
    this.activeChat = null;
    this.currentUserId = null;
    this.view = 'inbox';
    this._pendingInboxRefresh = false;
    this._pendingTargetUser = null;
    this.syncUnreadBadge({});
  }
}

export const messenger = new MessengerState();
