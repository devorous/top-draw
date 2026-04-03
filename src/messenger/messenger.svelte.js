import { getRoomId, encryptMessage, decryptMessage, getMessageKey } from '../utils/crypto.js';

const TOKEN_KEY = 'topDrawAuthToken';

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

  async checkUser(username) {
    const baseUrl = (import.meta.env.VITE_WS_SERVER_URL || 'ws://localhost:8000')
      .replace(/^ws/, 'http');
    const res = await fetch(`${baseUrl}/api/messenger/check-user?username=${encodeURIComponent(username)}`);
    return res.json();
  }

  async init(currentUserId, targetUser = null) {
    this.currentUserId = currentUserId;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      this.isConnected = false;
      return;
    }

    const wsBase = import.meta.env.VITE_WS_SERVER_URL || 'ws://localhost:8000';
    const wsUrl = wsBase.replace(/\/$/, '');
    this.ws = new WebSocket(
      `${wsUrl}/messenger?userId=${encodeURIComponent(currentUserId)}&token=${encodeURIComponent(token)}`
    );
    
    this.ws.onopen = () => {
      this.isConnected = true;
      this.fetchInbox();
      if (targetUser) {
        this.openChat(targetUser);
      }
    };

    this.ws.onmessage = async (event) => {
      const { type, payload } = JSON.parse(event.data);
      
      if (type === 'inbox') {
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
        // If it belongs to active chat, decrypt and add
        const roomId = getRoomId(this.currentUserId, this.activeChat?.id);
        if (payload.room_id === roomId) {
          const decrypted = {
            ...payload,
            content: await decryptMessage(payload.encrypted_content, payload.iv, this.key)
          };
          this.messages.push(decrypted);
        } else if (payload.sender_id !== this.currentUserId) {
          // Incoming message from a different conversation — increment unread
          this.unreadCounts = {
            ...this.unreadCounts,
            [payload.room_id]: (this.unreadCounts[payload.room_id] ?? 0) + 1
          };
        }
        // Refresh inbox in all cases to update last message
        this.fetchInbox();
      }
    };

    this.ws.onclose = () => { this.isConnected = false; };
  }

  fetchInbox() {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify({ type: 'get_inbox', payload: { userId: this.currentUserId } }));
    }
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
    if (this.ws) this.ws.close();
    this.messages = [];
    this.inbox = [];
    this.isConnected = false;
    this.activeChat = null;
  }
}

export const messenger = new MessengerState();
