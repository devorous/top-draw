import { getRoomId, encryptMessage, decryptMessage, getMessageKey } from '../utils/crypto.js';

class MessengerState {
  messages = $state([]);
  inbox = $state([]); // [{ roomId, lastMessage, otherUserId }]
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

  async init(currentUserId, targetUser = null) {
    this.currentUserId = currentUserId;
    
    const wsUrl = import.meta.env.VITE_MESSENGER_WS_URL || `ws://localhost:3001`;
    this.ws = new WebSocket(`${wsUrl}?userId=${currentUserId}`);
    
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
        this.inbox = payload;
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
