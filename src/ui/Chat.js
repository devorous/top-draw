/**
 * @fileoverview Chat manager for handling chat functionality with tabs, DM support, and emoji picker.
 */

/**
 * Chat class
 */
export class Chat {
  /**
   * @param {Object} [options={}] - Configuration options
   */
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

    this.emojiList = [];
    this.emojiPickerInitialized = false;
    this.recentEmojis = this.loadRecentEmojis();

    this.pendingImage = null;
    this.isDragging = false;

    this.unreadCount = 0;
    this.badgeElement = null;
    this.toastContainer = null;
  }

  /**
   * Initializes the chat component and sets up DOM references.
   */
  init() {
    this.container = document.getElementById('chat');
    this.messageList = document.getElementById('messageList');
    this.messagesContainer = document.getElementById('chatMessages');
    this.input = document.getElementById('chatInput');
    this.sendButton = document.getElementById('sendMessageBtn');
    this.emojiPicker = document.getElementById('chatEmojiPicker');
    this.fileInput = document.getElementById('chatFileInput');
    this.chatBtn = document.getElementById('chatBtn');

    this.container.style.display = 'none';
    if (this.chatBtn) this.chatBtn.style.display = 'none'; // Hidden until others join
    this.makeDraggable();
    this.setupEventListeners();
    this.setupTextareaAutoResize();

    this.badgeElement = document.getElementById('chatBadge');
    this.toastContainer = document.getElementById('chatToastContainer');
  }

  /**
   * Sets up event listeners for chat interactions.
   */
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

    // Drag and drop images into chat
    this.container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.container.classList.add('chat-dragover');
    });
    this.container.addEventListener('dragleave', (e) => {
      if (!this.container.contains(e.relatedTarget)) {
        this.container.classList.remove('chat-dragover');
      }
    });
    this.container.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.container.classList.remove('chat-dragover');
      const file = e.dataTransfer.files?.[0];
      if (file) {
        this.handleFileUpload({ target: { files: [file] } });
      }
    });

    document.addEventListener('click', (e) => {
      if (!this.emojiPicker.contains(e.target) &&
          e.target.id !== 'chatEmojiBtn') {
        this.emojiPicker.style.display = 'none';
      }
    });
  }

  /**
   * Switches the active chat tab.
   * @param {string} tab - Tab identifier ('all' or 'dm')
   */
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

  /**
   * Renders the list of users for direct messaging.
   */
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

  /**
   * Renders the message conversation with the current DM recipient.
   */
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
        img.alt = 'Shared image';
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
          <div class="dmMessageContent">${this.linkifyText(msg.message)}</div>
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

  /**
   * Selects a user as the current DM recipient.
   * @param {Object} user - User object
   */
  selectDMRecipient(user) {
    this.dmRecipient = user;
    this.switchTab('dm');
  }

  /**
   * Gets the number of unread DM messages from a specific user.
   * @param {string} userId - User identifier
   * @returns {number}
   */
  getUnreadCount(userId) {
    const messages = this.messages.dms.get(userId) || [];
    return messages.filter(msg => !msg.fromSelf && !msg.read).length;
  }

  /**
   * Handles sending a message or image.
   */
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

  /**
   * Sets up automatic resizing for the message textarea.
   */
  setupTextareaAutoResize() {
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = this.input.scrollHeight + 'px';
    });
  }

  /**
   * Resets the textarea height to default.
   */
  resetTextareaHeight() {
    this.input.style.height = 'auto';
  }

  /**
   * Sets up the emoji picker, loading data if necessary.
   * @returns {Promise<void>}
   */
  async setupEmojiPicker() {
    if (this.emojiPickerInitialized) {
      return;
    }

    try {
      const emojiData = await loadEmojiData();
      const popularGroups = [0, 1, 3, 4, 5, 6, 7, 8];

      this.emojiList = emojiData
        .filter(e => {
          return popularGroups.includes(e.group) &&
                 (!e.version || e.version <= 11) &&
                 e.type !== 5;
        })
        .slice(0, 300);

      this.renderEmojiGrid();
      this.renderRecentEmojis();
      this.emojiPickerInitialized = true;
    } catch (error) {
      console.error('Failed to setup emoji picker:', error);
      const grid = document.getElementById('emojiPickerGrid');
      if (grid) {
        grid.innerHTML = '<div style="padding: 20px; text-align: center;">Failed to load emojis</div>';
      }
    }
  }

  /**
   * Renders the grid of emojis in the picker.
   */
  renderEmojiGrid() {
    const grid = document.getElementById('emojiPickerGrid');
    grid.innerHTML = '';

    this.emojiList.forEach(emojiData => {
      const btn = this.createEmojiButton(emojiData.unicode);
      grid.appendChild(btn);
    });
  }

  /**
   * Creates a button element for an emoji.
   * @param {string} emoji - Unicode emoji character
   * @returns {HTMLElement}
   */
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

  /**
   * Loads recently used emojis from localStorage.
   * @returns {Array}
   */
  loadRecentEmojis() {
    try {
      const stored = localStorage.getItem('chatRecentEmojis');
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Saves recently used emojis to localStorage.
   */
  saveRecentEmojis() {
    try {
      localStorage.setItem('chatRecentEmojis', JSON.stringify(this.recentEmojis));
    } catch (e) {
      console.warn('Failed to save recent emojis:', e);
    }
  }

  /**
   * Adds an emoji to the recently used list.
   * @param {string} emoji - Unicode emoji character
   */
  addToRecent(emoji) {
    this.recentEmojis = this.recentEmojis.filter(e => e !== emoji);
    this.recentEmojis.unshift(emoji);

    if (this.recentEmojis.length > 20) {
      this.recentEmojis = this.recentEmojis.slice(0, 20);
    }

    this.saveRecentEmojis();
    this.renderRecentEmojis();
  }

  /**
   * Renders the row of recently used emojis.
   */
  renderRecentEmojis() {
    const recentContainer = document.getElementById('emojiRecentRow');
    if (!recentContainer) return;

    if (this.recentEmojis.length === 0) {
      recentContainer.style.display = 'none';
      return;
    }

    recentContainer.style.display = 'flex';

    const label = recentContainer.querySelector('label');
    recentContainer.innerHTML = '';
    if (label) {
      recentContainer.appendChild(label);
    } else {
      const newLabel = document.createElement('label');
      newLabel.textContent = 'Recently Used';
      recentContainer.appendChild(newLabel);
    }

    this.recentEmojis.slice(0, 14).forEach(emoji => {
      const btn = this.createEmojiButton(emoji);
      recentContainer.appendChild(btn);
    });
  }

  /**
   * Toggles the emoji picker visibility.
   * @returns {Promise<void>}
   */
  async toggleEmojiPicker() {
    const isVisible = this.emojiPicker.style.display !== 'none';

    if (isVisible) {
      this.emojiPicker.style.display = 'none';
    } else {
      this.emojiPicker.style.display = 'block';

      if (!this.emojiPickerInitialized) {
        await this.setupEmojiPicker();
      }
    }
  }

  /**
   * Inserts an emoji into the chat input.
   * @param {string} emoji - Unicode emoji character
   */
  insertEmoji(emoji) {
    const cursorPos = this.input.selectionStart;
    const textBefore = this.input.value.substring(0, cursorPos);
    const textAfter = this.input.value.substring(cursorPos);

    this.input.value = textBefore + emoji + textAfter;
    this.input.selectionStart = this.input.selectionEnd = cursorPos + emoji.length;
    this.input.focus();

    this.input.dispatchEvent(new Event('input'));
    this.addToRecent(emoji);
  }

  /**
   * Handles file upload for sending images.
   * @param {Event} e - Change event
   */
  handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.addSystemMessage('Only image files are supported');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      this.addSystemMessage('Image too large (max 5MB)');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const imageData = event.target.result;
      this.pendingImage = imageData;
      this.showImagePreviewInInput();
    };

    reader.readAsDataURL(file);
    this.fileInput.value = '';
  }

  /**
   * Shows a preview of the pending image in the chat UI.
   */
  showImagePreviewInInput() {
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
    img.alt = 'Image preview';
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

  /**
   * Clears the pending image preview.
   */
  clearImagePreview() {
    this.pendingImage = null;
    const previewContainer = document.getElementById('chatImagePreview');
    if (previewContainer) {
      previewContainer.remove();
    }
  }

  /**
   * Adds an image preview message to the chat list.
   * @param {string} imageData - Base64 image data
   */
  addImagePreview(imageData) {
    const li = document.createElement('li');
    li.className = 'message imageMessage';

    const img = document.createElement('img');
    img.src = imageData;
    img.alt = 'Shared image';
    img.style.maxWidth = '200px';
    img.style.maxHeight = '200px';
    img.style.borderRadius = 'var(--radius-sm)';
    img.style.marginTop = '4px';

    li.appendChild(img);
    this.messageList.appendChild(li);
    this.scrollToBottom();
  }

  /**
   * Adds an image message to the public chat history.
   * @param {string} imageData - Base64 image data
   * @param {Object} user - Sending user object
   */
  addChatImage(imageData, user) {
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

    if (!this.visible) {
      this.unreadCount++;
      this.updateBadge();
      this.showChatToast(user?.username || 'Anon', '[sent an image]', user?.color);
    }
  }

  /**
   * Adds an image to a DM conversation.
   * @param {string} imageData - Base64 image data
   * @param {string} userId - Other user ID
   * @param {boolean} [fromSelf=false] - Whether I am the sender
   */
  addDMImage(imageData, userId, fromSelf = false) {
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

  /**
   * Adds a text message to public chat history.
   * @param {string} message - Text message
   * @param {Object|string} user - Sending user object or 'system'
   * @param {boolean} [isDM=false] - Whether it's a DM
   */
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

    if (!this.visible && user !== 'system') {
      this.unreadCount++;
      this.updateBadge();
      this.showChatToast(user?.username || 'Anon', message, user?.color);
    }
  }

  /**
   * Adds a text message to a DM conversation.
   * @param {string} message - Text message
   * @param {string} userId - Other user ID
   * @param {boolean} [fromSelf=false] - Whether I am the sender
   */
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

  /**
   * Renders the public chat messages.
   */
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
        img.alt = 'Shared image';
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
          <span class='messageText'>${this.linkifyText(msg.message)}</span>
        `;
      }

      this.messageList.appendChild(li);
    });

    this.scrollToBottom();
  }

  /**
   * Adds a system notification message.
   * @param {string} message - Notification text
   */
  addSystemMessage(message) {
    this.addMessage(message, 'system');
  }

  /**
   * Updates the internal list of online users for DM selection.
   * @param {Array} users - Array of online user objects
   */
  updateUserList(users) {
    this.users.clear();
    users.forEach(user => {
      if (!user.isSelf) {
        this.users.set(user.id, user);
      }
    });

    // Hide chat button and close chat when alone
    if (this.chatBtn) {
      const hasOthers = this.users.size > 0;
      this.chatBtn.style.display = hasOthers ? '' : 'none';
      if (!hasOthers && this.visible) this.hide();
    }

    if (this.currentTab === 'dm' && !this.dmRecipient) {
      this.renderDMUserList();
    }
  }

  /**
   * Scrolls the public message container to the bottom.
   */
  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  /**
   * Scrolls the active DM conversation to the bottom.
   */
  scrollDMToBottom() {
    const dmMessages = document.getElementById('chatDMMessages');
    if (dmMessages) {
      dmMessages.scrollTop = dmMessages.scrollHeight;
    }
  }

  /**
   * Escapes HTML special characters.
   * @param {string} text - Raw text
   * @returns {string} - Escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Converts URLs in text to clickable links (after escaping HTML).
   * @param {string} text - Raw text
   * @returns {string} - HTML with clickable links
   */
  linkifyText(text) {
    const escaped = this.escapeHtml(text);
    // Match URLs starting with http://, https://, or www.
    const urlPattern = /(\bhttps?:\/\/[^\s<]+)|(\bwww\.[^\s<]+)/gi;
    return escaped.replace(urlPattern, (match) => {
      const href = match.startsWith('www.') ? 'https://' + match : match;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${match}</a>`;
    });
  }

  /**
   * Toggles chat visibility.
   */
  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'flex' : 'none';
    if (this.visible) {
      this.input.focus();
      this.clearUnread();
    }
  }

  /**
   * Shows the chat component.
   */
  show() {
    this.visible = true;
    this.container.style.display = 'flex';
    this.input.focus();
    this.clearUnread();
  }

  /**
   * Hides the chat component.
   */
  hide() {
    this.visible = false;
    this.container.style.display = 'none';
  }

  /**
   * Resets chat position to default.
   */
  resetPosition() {
    const containerWidth = document.getElementById('boardContainer').clientWidth;
    this.container.style.top = '30px';
    this.container.style.left = `${containerWidth - 200}px`;
  }

  /**
   * Clears all message history.
   */
  clearMessages() {
    this.messages.all = [];
    this.messages.dms.clear();
    this.renderMessages();
  }

  /**
   * Updates the unread message badge.
   */
  updateBadge() {
    if (!this.badgeElement) return;

    if (this.unreadCount > 0) {
      this.badgeElement.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
      this.badgeElement.style.display = '';
    } else {
      this.badgeElement.style.display = 'none';
    }
  }

  /**
   * Shows a brief toast notification for new messages.
   * @param {string} username - Sender username
   * @param {string} message - Message content
   * @param {string} [color='#888'] - Sender color
   */
  showChatToast(username, message, color = '#888') {
    if (!this.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = 'chatToast';

    const truncated = message.length > 100 ? message.slice(0, 100) + '...' : message;

    toast.innerHTML = `
      <span class="chatToastUsername" style="color: ${color}">${this.escapeHtml(username)}:</span>
      <span class="chatToastMessage">${this.escapeHtml(truncated)}</span>
    `;

    toast.addEventListener('click', () => {
      this.show();
      toast.remove();
    });

    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, 4000);

    const toasts = this.toastContainer.querySelectorAll('.chatToast:not(.hiding)');
    if (toasts.length > 3) {
      toasts[0].classList.add('hiding');
      setTimeout(() => toasts[0].remove(), 300);
    }
  }

  /**
   * Resets the unread message count.
   */
  clearUnread() {
    this.unreadCount = 0;
    this.updateBadge();
  }

  /**
   * Makes the chat window draggable by its header.
   */
  makeDraggable() {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const header = this.container.querySelector('#chatHeader');
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName !== 'INPUT') {
        isDragging = true;
        offsetX = e.clientX - this.container.offsetLeft;
        offsetY = e.clientY - this.container.offsetTop;
        this.container.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        this.isDragging = true;
        this.container.style.left = `${e.clientX - offsetX}px`;
        this.container.style.top = `${e.clientY - offsetY}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        this.container.style.cursor = 'default';
        setTimeout(() => { this.isDragging = false; }, 50);
      }
    });
  }
}
