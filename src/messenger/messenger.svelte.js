import { getRoomId, encryptMessage, decryptMessage, getMessageKey } from '../utils/crypto.js';
import { appState } from '../state.svelte.js';
import { playSfx } from '../utils/sfx.js';

const TOKEN_KEY = 'topDrawAuthToken';
const USERNAME_KEY = 'topDrawUsername';

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
  key = null;
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

    const wsBase = import.meta.env.VITE_WS_SERVER_URL || 'ws://localhost:8000';
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
        const decryptedInbox = await Promise.all(payload.map(async m => {
          const roomId = m.room_id;
          const key = await getMessageKey(roomId);
          try {
            return {
              ...m,
              content: await decryptMessage(m.encrypted_content, m.iv, key)
            };
          } catch (e) {
            return { ...m, content: "[Decryption Failed]" };
          }
        }));
        this.inbox = decryptedInbox;
      } else if (type === 'history') {
        const decryptedHistory = await Promise.all(payload.map(async m => ({
          ...m,
          content: await decryptMessage(m.encrypted_content, m.iv, this.key)
        })));
        this.messages = decryptedHistory;
      } else if (type === 'new_message') {
        const isIncoming = payload.sender_id !== this.currentUserId;
        // If it belongs to active chat, decrypt and add
        const roomId = getRoomId(this.currentUserId, this.activeChat?.id);
        if (payload.room_id === roomId) {
          const decrypted = {
            ...payload,
            content: await decryptMessage(payload.encrypted_content, payload.iv, this.key)
          };
          this.messages.push(decrypted);
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
    this.key = await getMessageKey(roomId);
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
    const { encrypted_content, iv } = await encryptMessage(text, this.key);

    this.ws.send(JSON.stringify({
      type: 'send_message',
      payload: {
        room_id: roomId,
        sender_id: this.currentUserId,
        receiver_id: this.activeChat.id,
        encrypted_content,
        iv
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
