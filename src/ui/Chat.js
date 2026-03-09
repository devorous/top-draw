/**
 * Chat manager for handling chat functionality with tabs and DM support
 */
export class Chat {
  constructor(options = {}) {
    this.container = null;
    this.messageList = null;
    this.messagesContainer = null;
    this.input = null;
    this.sendButton = null;
    this.visible = false;
    this.onSend = options.onSend || null;
    this.onDM = options.onDM || null;
    this.onSendImage = options.onSendImage || null;
    this.users = new Map();
    this.currentTab = 'all';
    this.dmRecipient = null;

    this.messages = {
      all: [],
      dms: new Map()
    };

    // Emoji picker state
    this.emojiList = [];
    this.emojiPickerInitialized = false;
    this.recentEmojis = this.loadRecentEmojis();

    // Image upload state
    this.pendingImage = null;
    this.isDragging = false;

    // Notification state
    this.unreadCount = 0;
    this.badgeElement = null;
    this.toastContainer = null;
  }

  init() {
    this.container = document.getElementById('chat');
    this.messageList = document.getElementById('messageList');
    this.messagesContainer = document.getElementById('chatMessages');
    this.input = document.getElementById('chatInput');
    this.sendButton = document.getElementById('sendMessageBtn');
    this.emojiPicker = document.getElementById('chatEmojiPicker');
    this.fileInput = document.getElementById('chatFileInput');

    this.container.style.display = 'none';
    this.makeDraggable();
    this.setupEventListeners();
    this.setupTextareaAutoResize();
    // Don't setup emoji picker yet - wait until user clicks emoji button

    // Notification elements
    this.badgeElement = document.getElementById('chatBadge');
    this.toastContainer = document.getElementById('chatToastContainer');
  }

  setupEventListeners() {
    this.sendButton.addEventListener('click', () => {
      this.handleSend();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    const allTab = document.getElementById('chatTabAll');
    const dmTab = document.getElementById('chatTabDM');

    allTab?.addEventListener('click', () => {
      if (!this.isDragging) this.switchTab('all');
    });
    dmTab?.addEventListener('click', () => {
      if (!this.isDragging) this.switchTab('dm');
    });

    const backBtn = document.getElementById('chatBackBtn');
    backBtn?.addEventListener('click', () => {
      this.dmRecipient = null;
      this.switchTab('dm');
    });

    const closeBtn = document.getElementById('chatCloseBtn');
    closeBtn?.addEventListener('click', () => {
      this.hide();
    });

    const emojiBtn = document.getElementById('chatEmojiBtn');
    emojiBtn?.addEventListener('click', () => {
      this.toggleEmojiPicker();
    });

    const attachBtn = document.getElementById('chatAttachBtn');
    attachBtn?.addEventListener('click', () => {
      this.fileInput.click();
    });

    this.fileInput?.addEventListener('change', (e) => {
      this.handleFileUpload(e);
    });

    // Close emoji picker when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.emojiPicker.contains(e.target) &&
          e.target.id !== 'chatEmojiBtn') {
        this.emojiPicker.style.display = 'none';
      }
    });
  }

  switchTab(tab) {
    this.currentTab = tab;

    const allTab = document.getElementById('chatTabAll');
    const dmTab = document.getElementById('chatTabDM');
    const dmUserList = document.getElementById('chatDMUserList');
    const dmConversation = document.getElementById('chatDMConversation');

    if (tab === 'all') {
      allTab?.classList.add('active');
      dmTab?.classList.remove('active');
      this.messagesContainer.style.display = 'flex';
      dmUserList.style.display = 'none';
      dmConversation.style.display = 'none';
      this.input.placeholder = 'Type a message...';
      this.renderMessages();
    } else if (tab === 'dm') {
      allTab?.classList.remove('active');
      dmTab?.classList.add('active');
      this.messagesContainer.style.display = 'none';

      if (this.dmRecipient) {
        dmUserList.style.display = 'none';
        dmConversation.style.display = 'flex';
        this.input.placeholder = `Message ${this.dmRecipient.username}...`;
        this.renderDMConversation();
      } else {
        dmUserList.style.display = 'block';
        dmConversation.style.display = 'none';
        this.renderDMUserList();
      }
    }
  }

  renderDMUserList() {
    const userList = document.getElementById('dmUserListContent');
    userList.innerHTML = '';

    if (this.users.size === 0) {
      userList.innerHTML = '<div class="dmNoUsers">No other users online</div>';
      return;
    }

    this.users.forEach((user, userId) => {
      const userItem = document.createElement('div');
      userItem.className = 'dmUserItem';

      const unreadCount = this.getUnreadCount(userId);
      const unreadBadge = unreadCount > 0 ?
        `<span class="dmUnreadBadge">${unreadCount}</span>` : '';

      userItem.innerHTML = `
        <div class="dmUserColor" style="background-color: ${user.color}"></div>
        <span class="dmUserName">${user.username}</span>
        ${unreadBadge}
      `;

      userItem.addEventListener('click', () => {
        this.selectDMRecipient(user);
      });

      userList.appendChild(userItem);
    });
  }

  renderDMConversation() {
    if (!this.dmRecipient) return;

    const header = document.getElementById('chatDMHeader');
    header.innerHTML = `
      <button class="chatBackBtn" id="chatBackBtn">←</button>
      <div class="dmUserColor" style="background-color: ${this.dmRecipient.color}"></div>
      <span class="dmUserName">${this.dmRecipient.username}</span>
    `;

    const backBtn = document.getElementById('chatBackBtn');
    backBtn.addEventListener('click', () => {
      this.dmRecipient = null;
      this.switchTab('dm');
    });

    const messageList = document.getElementById('dmMessageList');
    messageList.innerHTML = '';

    const messages = this.messages.dms.get(this.dmRecipient.id) || [];
    messages.forEach(msg => {
      const li = document.createElement('li');
      li.className = `dmMessage ${msg.fromSelf ? 'self' : ''}`;

      const time = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });

      if (msg.type === 'image') {
        const contentDiv = document.createElement('div');
        contentDiv.className = 'dmMessageContent';

        const img = document.createElement('img');
        img.src = msg.imageData;
        img.style.maxWidth = '200px';
        img.style.maxHeight = '200px';
        img.style.borderRadius = 'var(--radius-sm)';
        img.style.display = 'block';

        contentDiv.appendChild(img);
        li.appendChild(contentDiv);

        const timeDiv = document.createElement('div');
        timeDiv.className = 'dmMessageTime';
        timeDiv.textContent = time;
        li.appendChild(timeDiv);
      } else {
        li.innerHTML = `
          <div class="dmMessageContent">${this.escapeHtml(msg.message)}</div>
          <div class="dmMessageTime">${time}</div>
        `;
      }

      messageList.appendChild(li);

      if (!msg.fromSelf && !msg.read) {
        msg.read = true;
      }
    });

    this.scrollDMToBottom();
  }

  selectDMRecipient(user) {
    this.dmRecipient = user;
    this.switchTab('dm');
  }

  getUnreadCount(userId) {
    const messages = this.messages.dms.get(userId) || [];
    return messages.filter(msg => !msg.fromSelf && !msg.read).length;
  }

  handleSend() {
    const message = this.input.value.trim();
    const hasImage = this.pendingImage !== null;

    if (!message && !hasImage) return;

    if (this.currentTab === 'all') {
      if (message && this.onSend) {
        this.onSend(message);
      }
      if (hasImage && this.onSendImage) {
        this.onSendImage(this.pendingImage);
      }
    } else if (this.currentTab === 'dm' && this.dmRecipient) {
      if (message && this.onDM) {
        this.onDM(message, this.dmRecipient.id);
        this.addDMMessage(message, this.dmRecipient.id, true);
      }
      if (hasImage && this.onSendImage) {
        this.onSendImage(this.pendingImage, this.dmRecipient.id);
      }
    }

    this.input.value = '';
    this.resetTextareaHeight();
    this.clearImagePreview();
  }

  setupTextareaAutoResize() {
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = this.input.scrollHeight + 'px';
    });
  }

  resetTextareaHeight() {
    this.input.style.height = 'auto';
  }

  async setupEmojiPicker() {
    if (this.emojiPickerInitialized) {
      return; // Already initialized
    }

    try {
      // Lazy load emoji data
      const emojiData = await loadEmojiData();

      // Filter to ~300 most common emojis from popular groups
      // Group 0: smileys-emotion, Group 1: people-body, Group 2: component (skin tones, etc)
      // Group 3: animals-nature, Group 4: food-drink, Group 5: travel-places
      // Group 6: activities, Group 7: objects, Group 8: symbols
      const popularGroups = [0, 1, 3, 4, 5, 6, 7, 8];

      this.emojiList = emojiData
        .filter(e => {
          // Only include emojis version 11 or older for better browser support (fewer squares)
          // Skip skin tone variations and gender variants
          return popularGroups.includes(e.group) &&
                 (!e.version || e.version <= 11) &&
                 e.type !== 5; // Skip components like skin tones
        })
        .slice(0, 300);

      this.renderEmojiGrid();
      this.renderRecentEmojis();
      this.emojiPickerInitialized = true;
    } catch (error) {
      console.error('Failed to setup emoji picker:', error);
      // Show error to user
      const grid = document.getElementById('emojiPickerGrid');
      if (grid) {
        grid.innerHTML = '<div style="padding: 20px; text-align: center;">Failed to load emojis</div>';
      }
    }
  }

  renderEmojiGrid() {
    const grid = document.getElementById('emojiPickerGrid');
    grid.innerHTML = '';

    this.emojiList.forEach(emojiData => {
      const btn = this.createEmojiButton(emojiData.unicode);
      grid.appendChild(btn);
    });
  }

  createEmojiButton(emoji) {
    const btn = document.createElement('button');
    btn.className = 'emojiBtn';
    btn.textContent = emoji;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.insertEmoji(emoji);
    });
    return btn;
  }

  loadRecentEmojis() {
    try {
      const stored = localStorage.getItem('chatRecentEmojis');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  saveRecentEmojis() {
    try {
      localStorage.setItem('chatRecentEmojis', JSON.stringify(this.recentEmojis));
    } catch (e) {
      console.warn('Failed to save recent emojis:', e);
    }
  }

  addToRecent(emoji) {
    // Remove if already exists
    this.recentEmojis = this.recentEmojis.filter(e => e !== emoji);

    // Add to front
    this.recentEmojis.unshift(emoji);

    // Limit to 20 emojis
    if (this.recentEmojis.length > 20) {
      this.recentEmojis = this.recentEmojis.slice(0, 20);
    }

    this.saveRecentEmojis();
    this.renderRecentEmojis();
  }

  renderRecentEmojis() {
    const recentContainer = document.getElementById('emojiRecentRow');
    if (!recentContainer) return;

    if (this.recentEmojis.length === 0) {
      recentContainer.style.display = 'none';
      return;
    }

    recentContainer.style.display = 'flex';

    // Clear except label
    const label = recentContainer.querySelector('label');
    recentContainer.innerHTML = '';
    if (label) {
      recentContainer.appendChild(label);
    } else {
      const newLabel = document.createElement('label');
      newLabel.textContent = 'Recently Used';
      recentContainer.appendChild(newLabel);
    }

    // Add up to 14 most recent emojis
    this.recentEmojis.slice(0, 14).forEach(emoji => {
      const btn = this.createEmojiButton(emoji);
      recentContainer.appendChild(btn);
    });
  }

  async toggleEmojiPicker() {
    const isVisible = this.emojiPicker.style.display !== 'none';

    if (isVisible) {
      // Just hide if already visible
      this.emojiPicker.style.display = 'none';
    } else {
      // Show picker and initialize if needed
      this.emojiPicker.style.display = 'block';

      if (!this.emojiPickerInitialized) {
        await this.setupEmojiPicker();
      }
    }
  }

  insertEmoji(emoji) {
    const cursorPos = this.input.selectionStart;
    const textBefore = this.input.value.substring(0, cursorPos);
    const textAfter = this.input.value.substring(cursorPos);

    this.input.value = textBefore + emoji + textAfter;
    this.input.selectionStart = this.input.selectionEnd = cursorPos + emoji.length;
    this.input.focus();

    // Trigger resize
    this.input.dispatchEvent(new Event('input'));

    // Track as recently used
    this.addToRecent(emoji);
  }

  handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Check if it's an image
    if (!file.type.startsWith('image/')) {
      this.addSystemMessage('Only image files are supported');
      return;
    }

    // Check file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      this.addSystemMessage('Image too large (max 5MB)');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const imageData = event.target.result;

      // Store pending image and show preview
      this.pendingImage = imageData;
      this.showImagePreviewInInput();
    };

    reader.readAsDataURL(file);

    // Reset file input
    this.fileInput.value = '';
  }

  showImagePreviewInInput() {
    // Create or update image preview in chat bottom area
    let previewContainer = document.getElementById('chatImagePreview');

    if (!previewContainer) {
      previewContainer = document.createElement('div');
      previewContainer.id = 'chatImagePreview';
      previewContainer.className = 'chatImagePreview';

      const chatBottom = this.container.querySelector('.chatBottom');
      chatBottom.insertBefore(previewContainer, chatBottom.firstChild);
    }

    previewContainer.innerHTML = '';

    const previewWrapper = document.createElement('div');
    previewWrapper.className = 'imagePreviewWrapper';

    const img = document.createElement('img');
    img.src = this.pendingImage;
    img.style.maxWidth = '120px';
    img.style.maxHeight = '120px';
    img.style.borderRadius = 'var(--radius-sm)';
    img.style.objectFit = 'cover';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'imagePreviewRemove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove image';
    removeBtn.addEventListener('click', () => {
      this.clearImagePreview();
    });

    previewWrapper.appendChild(img);
    previewWrapper.appendChild(removeBtn);
    previewContainer.appendChild(previewWrapper);
  }

  clearImagePreview() {
    this.pendingImage = null;
    const previewContainer = document.getElementById('chatImagePreview');
    if (previewContainer) {
      previewContainer.remove();
    }
  }

  addImagePreview(imageData) {
    // Add image preview to chat
    const li = document.createElement('li');
    li.className = 'message imageMessage';

    const img = document.createElement('img');
    img.src = imageData;
    img.style.maxWidth = '200px';
    img.style.maxHeight = '200px';
    img.style.borderRadius = 'var(--radius-sm)';
    img.style.marginTop = '4px';

    li.appendChild(img);
    this.messageList.appendChild(li);
    this.scrollToBottom();
  }

  addChatImage(imageData, user) {
    // Add image message to public chat
    const timestamp = Date.now();
    const msg = {
      type: 'image',
      imageData,
      user,
      timestamp
    };

    this.messages.all.push(msg);

    if (this.currentTab === 'all') {
      this.renderMessages();
    }

    // Show notification if chat is hidden
    if (!this.visible) {
      this.unreadCount++;
      this.updateBadge();
      this.showChatToast(user?.username || 'Anon', '[sent an image]', user?.color);
    }
  }

  addDMImage(imageData, userId, fromSelf = false) {
    // Add image to DM conversation
    if (!this.messages.dms.has(userId)) {
      this.messages.dms.set(userId, []);
    }

    const msg = {
      type: 'image',
      imageData,
      timestamp: Date.now(),
      fromSelf,
      read: fromSelf || (this.dmRecipient?.id === userId && this.currentTab === 'dm')
    };

    this.messages.dms.get(userId).push(msg);

    if (this.dmRecipient?.id === userId && this.currentTab === 'dm') {
      this.renderDMConversation();
    } else if (this.currentTab === 'dm' && !this.dmRecipient) {
      this.renderDMUserList();
    }

    // Show notification for incoming DM images when chat is hidden
    if (!fromSelf && !this.visible) {
      const user = this.users.get(userId);
      this.unreadCount++;
      this.updateBadge();
      this.showChatToast(
        user?.username || 'Anon',
        '[DM] sent an image',
        user?.color
      );
    }
  }

  addMessage(message, user, isDM = false) {
    if (!message) return;

    const timestamp = Date.now();
    const msg = {
      message,
      user,
      timestamp,
      isDM
    };

    if (user === 'system') {
      msg.type = 'system';
    }

    this.messages.all.push(msg);

    if (this.currentTab === 'all') {
      this.renderMessages();
    }

    // Show notification if chat is hidden and not a system message
    if (!this.visible && user !== 'system') {
      this.unreadCount++;
      this.updateBadge();
      this.showChatToast(user?.username || 'Anon', message, user?.color);
    }
  }

  addDMMessage(message, userId, fromSelf = false) {
    if (!this.messages.dms.has(userId)) {
      this.messages.dms.set(userId, []);
    }

    const msg = {
      message,
      timestamp: Date.now(),
      fromSelf,
      read: fromSelf || (this.dmRecipient?.id === userId && this.currentTab === 'dm')
    };

    this.messages.dms.get(userId).push(msg);

    if (this.dmRecipient?.id === userId && this.currentTab === 'dm') {
      this.renderDMConversation();
    } else if (this.currentTab === 'dm' && !this.dmRecipient) {
      this.renderDMUserList();
    }

    // Show notification for incoming DMs when chat is hidden
    if (!fromSelf && !this.visible) {
      const user = this.users.get(userId);
      this.unreadCount++;
      this.updateBadge();
      this.showChatToast(
        user?.username || 'Anon',
        `[DM] ${message}`,
        user?.color
      );
    }
  }

  renderMessages() {
    this.messageList.innerHTML = '';

    this.messages.all.forEach(msg => {
      const li = document.createElement('li');
      li.className = 'message';

      if (msg.type === 'system') {
        li.className = 'system message';
        li.innerHTML = `<span class='messageText'>${this.escapeHtml(msg.message)}</span>`;
      } else if (msg.type === 'image') {
        li.className = 'message imageMessage';
        const username = msg.user?.username || 'Anon';
        const userColor = msg.user?.color || '#888';
        li.innerHTML = `<span class='messageName' style='color: ${userColor}'>${this.escapeHtml(username)}: </span>`;

        const img = document.createElement('img');
        img.src = msg.imageData;
        img.style.maxWidth = '200px';
        img.style.maxHeight = '200px';
        img.style.borderRadius = 'var(--radius-sm)';
        img.style.marginTop = '4px';
        img.style.display = 'block';

        li.appendChild(img);
      } else {
        const username = msg.user?.username || 'Anon';
        const userColor = msg.user?.color || '#888';
        li.innerHTML = `
          <span class='messageName' style='color: ${userColor}'>${this.escapeHtml(username)}: </span>
          <span class='messageText'>${this.escapeHtml(msg.message)}</span>
        `;
      }

      this.messageList.appendChild(li);
    });

    this.scrollToBottom();
  }

  addSystemMessage(message) {
    this.addMessage(message, 'system');
  }

  updateUserList(users) {
    this.users.clear();
    users.forEach(user => {
      if (!user.isSelf) {
        this.users.set(user.id, user);
      }
    });

    if (this.currentTab === 'dm' && !this.dmRecipient) {
      this.renderDMUserList();
    }
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  scrollDMToBottom() {
    const dmMessages = document.getElementById('chatDMMessages');
    if (dmMessages) {
      dmMessages.scrollTop = dmMessages.scrollHeight;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'flex' : 'none';
    if (this.visible) {
      this.input.focus();
      this.clearUnread();
    }
  }

  show() {
    this.visible = true;
    this.container.style.display = 'flex';
    this.input.focus();
    this.clearUnread();
  }

  hide() {
    this.visible = false;
    this.container.style.display = 'none';
  }

  resetPosition() {
    const containerWidth = document.getElementById('boardContainer').clientWidth;
    this.container.style.top = '30px';
    this.container.style.left = `${containerWidth - 200}px`;
  }

  clearMessages() {
    this.messages.all = [];
    this.messages.dms.clear();
    this.renderMessages();
  }

  // ========================================
  // Notification Methods
  // ========================================

  updateBadge() {
    if (!this.badgeElement) return;

    if (this.unreadCount > 0) {
      this.badgeElement.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
      this.badgeElement.style.display = '';
    } else {
      this.badgeElement.style.display = 'none';
    }
  }

  showChatToast(username, message, color = '#888') {
    if (!this.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = 'chatToast';

    // Truncate long messages
    const truncated = message.length > 100 ? message.slice(0, 100) + '...' : message;

    toast.innerHTML = `
      <span class="chatToastUsername" style="color: ${color}">${this.escapeHtml(username)}:</span>
      <span class="chatToastMessage">${this.escapeHtml(truncated)}</span>
    `;

    // Click to open chat
    toast.addEventListener('click', () => {
      this.show();
      toast.remove();
    });

    this.toastContainer.appendChild(toast);

    // Auto-remove after 4 seconds
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, 4000);

    // Limit to 3 visible toasts
    const toasts = this.toastContainer.querySelectorAll('.chatToast:not(.hiding)');
    if (toasts.length > 3) {
      toasts[0].classList.add('hiding');
      setTimeout(() => toasts[0].remove(), 300);
    }
  }

  clearUnread() {
    this.unreadCount = 0;
    this.updateBadge();
  }

  makeDraggable() {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const header = this.container.querySelector('#chatHeader');
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
      // Allow dragging on header, tabs, and close button (but not input elements)
      if (e.target.tagName !== 'INPUT') {
        isDragging = true;
        offsetX = e.clientX - this.container.offsetLeft;
        offsetY = e.clientY - this.container.offsetTop;
        this.container.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        this.isDragging = true; // Use class property for external access
        this.container.style.left = `${e.clientX - offsetX}px`;
        this.container.style.top = `${e.clientY - offsetY}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.container.style.cursor = 'default';
        // Delay resetting isDragging class property slightly to catch final click events
        setTimeout(() => { this.isDragging = false; }, 50);
      }
    });
  }
}
