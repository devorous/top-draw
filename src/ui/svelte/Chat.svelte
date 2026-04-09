<script>
  import { appState } from '../../state.svelte.js';

  const CHAT_MODE_STORAGE_KEY = 'topdraw-chat-mode';
  const CHAT_POSITION_STORAGE_KEY = 'topdraw-chat-position';
  const EMOJI_USAGE_STORAGE_KEY = 'topdraw-chat-emoji-usage';
  const COMPOSER_EMOJIS = [
    '\u{1F600}', '\u{1F602}', '\u{1F60D}', '\u{1F525}', '\u{1F3A8}', '\u{1F44F}',
    '\u{1F91D}', '\u{1F4A1}', '\u2728', '\u{1F62E}', '\u{1F44D}', '\u{1F44E}'
  ];
  const REACTION_EMOJIS = [
    '\u{1F44D}', '\u2764\uFE0F', '\u{1F525}', '\u{1F602}', '\u{1F62E}', '\u{1F3A8}',
    '\u{1F44F}', '\u2728', '\u{1F389}', '\u{1F60D}', '\u{1F914}', '\u{1F44E}'
  ];

  let { onSend = null, onStaffSend = null, onStaffSendImage = null, onDM = null, onSendImage = null, onReact = null } = $props();

  let activeView = $state('all');
  let messageInput = $state('');
  let chatMode = $state(loadChatMode());
  let messages = $state({
    all: [],
    staff: [],
    dms: new Map()
  });
  let dmMeta = $state(new Map());
  let isDragging = $state(false);
  let chatEl = $state(null);
  let publicMessagesEl = $state(null);
  let dmMessagesEl = $state(null);
  let fileInputEl = $state(null);
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let isDropTarget = $state(false);
  let dropDepth = 0;
  let showEmojiPicker = $state(false);
  let composerImage = $state(null);
  let emojiUsage = $state(loadEmojiUsage());

  let visible = $derived(appState.chatVisible);
  let recipient = $derived.by(() => {
    const selected = appState.dmRecipient;
    if (!selected) return null;
    return getChatUser(selected.id) || selected;
  });

  let activeThreads = $derived.by(() => {
    const ids = new Set(messages.dms.keys());
    if (recipient?.id !== undefined && recipient?.id !== null) ids.add(recipient.id);

    return [...ids]
      .map((userId) => {
        const threadMessages = messages.dms.get(userId) || [];
        const lastMessage = threadMessages[threadMessages.length - 1];
        const user = getChatUser(userId);

        return { id: userId, user, lastMessage };
      })
      .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
  });

  let directoryUsers = $derived.by(() => {
    return [...appState.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  });

  let activeDMMessages = $derived.by(() => {
    if (!recipient?.id && recipient?.id !== 0) return [];
    return messages.dms.get(recipient.id) || [];
  });

  let groupedPublicMessages = $derived.by(() => {
    return groupChannelMessages(messages.all);
  });

  let groupedStaffMessages = $derived.by(() => {
    return groupChannelMessages(messages.staff);
  });

  let canAccessStaff = $derived(appState.selfRole >= 4);

  function groupChannelMessages(channelMessages) {
    return channelMessages.map((msg, index) => {
      const previous = channelMessages[index - 1];
      const next = channelMessages[index + 1];
      const groupedWithPrevious = Boolean(
        previous &&
        isChatMessage(previous) &&
        isChatMessage(msg) &&
        Number(previous.userId) === Number(msg.userId) &&
        msg.timestamp - previous.timestamp < 60_000
      );
      const groupedWithNext = Boolean(
        next &&
        isChatMessage(next) &&
        isChatMessage(msg) &&
        Number(next.userId) === Number(msg.userId) &&
        next.timestamp - msg.timestamp < 60_000
      );

      return { ...msg, groupedWithPrevious, groupedWithNext };
    });
  }

  let toasts = $state([]);
  let toastIdCounter = 0;

  function loadChatMode() {
    try {
      return localStorage.getItem(CHAT_MODE_STORAGE_KEY) === 'full' ? 'full' : 'compact';
    } catch {
      return 'compact';
    }
  }

  function persistChatMode(mode) {
    try {
      localStorage.setItem(CHAT_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures.
    }
  }

  function loadChatPositions() {
    try {
      const raw = localStorage.getItem(CHAT_POSITION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistChatPositions(nextPositions) {
    try {
      localStorage.setItem(CHAT_POSITION_STORAGE_KEY, JSON.stringify(nextPositions));
    } catch {
      // Ignore storage failures.
    }
  }

  function loadEmojiUsage() {
    try {
      const raw = localStorage.getItem(EMOJI_USAGE_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistEmojiUsage(nextUsage) {
    try {
      localStorage.setItem(EMOJI_USAGE_STORAGE_KEY, JSON.stringify(nextUsage));
    } catch {
      // Ignore storage failures.
    }
  }

  function createMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isChatMessage(message) {
    return message?.type === 'message' || message?.type === 'image';
  }

  function allEmojiChoices() {
    return [...new Set([...REACTION_EMOJIS, ...COMPOSER_EMOJIS])];
  }

  function sortedEmojis(source) {
    return [...source].sort((a, b) => {
      const usageA = emojiUsage[a] || { count: 0, lastUsed: 0 };
      const usageB = emojiUsage[b] || { count: 0, lastUsed: 0 };
      if (usageB.count !== usageA.count) return usageB.count - usageA.count;
      if (usageB.lastUsed !== usageA.lastUsed) return usageB.lastUsed - usageA.lastUsed;
      return source.indexOf(a) - source.indexOf(b);
    });
  }

  function recentEmojis(limit = 6) {
    return allEmojiChoices()
      .filter((emoji) => (emojiUsage[emoji]?.lastUsed || 0) > 0)
      .sort((a, b) => (emojiUsage[b]?.lastUsed || 0) - (emojiUsage[a]?.lastUsed || 0))
      .slice(0, limit);
  }

  function rankedComposerEmojis() {
    return sortedEmojis([...new Set([...COMPOSER_EMOJIS, ...REACTION_EMOJIS])]);
  }

  function hoverReactionEmojis(limit = 6) {
    const recent = recentEmojis(limit);
    const fallback = sortedEmojis(REACTION_EMOJIS);
    const combined = [...new Set([...recent, ...fallback])];
    return combined.slice(0, limit);
  }

  function selectableHoverReactionEmojis(message, limit = 5) {
    const existing = new Set((message.reactions || []).map((reaction) => reaction.emoji));
    return hoverReactionEmojis(limit + existing.size)
      .filter((emoji) => !existing.has(emoji))
      .slice(0, limit);
  }

  function recordEmojiUsage(emoji) {
    const nextUsage = {
      ...emojiUsage,
      [emoji]: {
        count: (emojiUsage[emoji]?.count || 0) + 1,
        lastUsed: Date.now()
      }
    };
    emojiUsage = nextUsage;
    persistEmojiUsage(nextUsage);
  }

  function createBaseMessage({
    id = createMessageId(),
    type = 'message',
    text = '',
    imageData = '',
    username = '',
    color = '#8ba3c7',
    timestamp = Date.now(),
    userId = null,
    fromSelf = false,
    read = false,
    threadUserId = null
  }) {
    return {
      id,
      type,
      text,
      imageData,
      username,
      color,
      timestamp,
      userId,
      fromSelf,
      read,
      threadUserId,
      reactions: []
    };
  }

  function cloneMessage(message) {
    return {
      ...message,
      reactions: (message.reactions || []).map((reaction) => ({
        ...reaction,
        users: [...(reaction.users || [])]
      }))
    };
  }

  function show() {
    appState.chatVisible = true;
    appState.chatUnreadCount = 0;
  }

  function hide() {
    appState.chatVisible = false;
  }

  function toggleMode() {
    persistCurrentChatPosition();
    chatMode = chatMode === 'compact' ? 'full' : 'compact';
    persistChatMode(chatMode);
    scheduleApplyStoredPosition();
  }

  function showPublic() {
    activeView = 'all';
    appState.dmRecipient = null;
  }

  function showDirectory() {
    activeView = 'directory';
    appState.dmRecipient = null;
  }

  function showStaff() {
    if (!canAccessStaff) return;
    activeView = 'staff';
    appState.dmRecipient = null;
  }

  function selectDMRecipient(user) {
    rememberDMUser(user);
    appState.dmRecipient = user;
    activeView = 'dm';
    markThreadRead(user.id);
  }

  function openThreadById(userId) {
    const user = getChatUser(userId);
    if (user) {
      selectDMRecipient(user);
      return;
    }

    const cachedUser = dmMeta.get(userId);
    if (cachedUser) {
      selectDMRecipient(cachedUser);
    }
  }

  function handleSend() {
    const msg = messageInput.trim();
    const recipientId = activeView === 'dm' && recipient ? recipient.id : null;
    const hasImage = !!composerImage;

    if (!msg && !hasImage) return;

    if (msg) {
      if (activeView === 'all' && onSend) onSend(msg);
      else if (activeView === 'staff' && onStaffSend) onStaffSend(msg);
      else if (recipientId !== null && onDM) onDM(msg, recipientId);
    }

    if (hasImage) {
      if (activeView === 'staff' && onStaffSendImage) {
        onStaffSendImage(composerImage.dataUrl);
      } else if (onSendImage) {
        onSendImage(composerImage.dataUrl, recipientId);
      }
    }

    messageInput = '';
    composerImage = null;
    showEmojiPicker = false;
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function linkify(text) {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(
      /https?:\/\/[^\s<>"]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`
    );
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function getChatUser(userId) {
    if (userId === null || userId === undefined) return null;
    if (Number(userId) === Number(appState.sessionIndex) && window.app?.self) {
      return {
        id: userId,
        username: window.app.self.username || window.app.self.name || 'You',
        color: `rgba(${window.app.self.color[0]}, ${window.app.self.color[1]}, ${window.app.self.color[2]}, ${window.app.self.color[3] / 255})`,
        role: window.app.self.role || appState.selfRole || 0
      };
    }

    return appState.users.get(userId) || window.app?.users?.get(Number(userId)) || dmMeta.get(userId) || null;
  }

  function rememberDMUser(userOrId) {
    const user = typeof userOrId === 'object' ? userOrId : getChatUser(userOrId);
    if (!user?.id && user?.id !== 0) return;

    dmMeta.set(user.id, {
      id: user.id,
      username: user.username || user.name || `User ${user.id}`,
      color: user.color || '#6f86a3',
      role: user.role || 0,
      visibleIp: user.visibleIp || ''
    });
    dmMeta = new Map(dmMeta);
  }

  function getUnreadCount(userId) {
    const threadMessages = messages.dms.get(userId) || [];
    return threadMessages.filter((msg) => !msg.fromSelf && !msg.read).length;
  }

  function markThreadRead(userId) {
    const threadMessages = messages.dms.get(userId);
    if (!threadMessages?.length) return;

    let changed = false;
    threadMessages.forEach((msg) => {
      if (!msg.fromSelf && !msg.read) {
        msg.read = true;
        changed = true;
      }
    });

    if (changed) messages.dms = new Map(messages.dms);
  }

  function showToast(username, message, color) {
    const id = ++toastIdCounter;
    const truncated = message.length > 90 ? `${message.slice(0, 90)}...` : message;
    toasts = [...toasts, { id, username, message: truncated, color }];
    setTimeout(() => dismissToast(id), 4000);
    if (toasts.length > 3) toasts = toasts.slice(toasts.length - 3);
  }

  function dismissToast(id) {
    toasts = toasts.filter((toast) => toast.id !== id);
  }

  function openFromToast(id) {
    dismissToast(id);
    show();
  }

  function createReactionList(existing = []) {
    return existing.map((reaction) => ({
      emoji: reaction.emoji,
      users: [...(reaction.users || [])]
    }));
  }

  function applyReactionToList(messageList, payload) {
    if (!Array.isArray(messageList) || !payload?.messageId || !payload?.emoji) return false;

    const messageIndex = messageList.findIndex((entry) => entry.id === payload.messageId);
    if (messageIndex === -1) return false;

    const message = cloneMessage(messageList[messageIndex]);
    const actorId = Number(payload.sessionIndex);
    let reactions = createReactionList(message.reactions);
    const reactionIndex = reactions.findIndex((reaction) => reaction.emoji === payload.emoji);

    if (reactionIndex === -1 && !payload.remove) {
      reactions = [...reactions, { emoji: payload.emoji, users: [actorId] }];
    } else if (reactionIndex !== -1) {
      const users = new Set(reactions[reactionIndex].users || []);
      if (payload.remove) users.delete(actorId);
      else users.add(actorId);

      if (users.size === 0) reactions.splice(reactionIndex, 1);
      else reactions[reactionIndex] = { ...reactions[reactionIndex], users: [...users] };
    }

    message.reactions = reactions;
    messageList[messageIndex] = message;
    return true;
  }

  function applyReactionLocally(payload) {
    let updated = applyReactionToList(messages.all, payload);
    if (updated) {
      messages.all = [...messages.all];
      return;
    }

    for (const [threadId, threadMessages] of messages.dms.entries()) {
      if (applyReactionToList(threadMessages, payload)) {
        messages.dms.set(threadId, [...threadMessages]);
        messages.dms = new Map(messages.dms);
        updated = true;
        break;
      }
    }
  }

  function toggleReaction(message, emoji) {
    if (!message?.id || !onReact) return;

    const selfId = Number(appState.sessionIndex);
    const existing = (message.reactions || []).find((reaction) => reaction.emoji === emoji);
    const reacted = existing?.users?.includes(selfId);
    const payload = {
      messageId: message.id,
      emoji,
      remove: !!reacted,
      recipientId: message.threadUserId ?? null,
      sessionIndex: selfId
    };

    applyReactionLocally(payload);
    recordEmojiUsage(emoji);
    onReact(payload);
  }

  function normalizedReactionPills(message) {
    return (message.reactions || [])
      .map((reaction) => ({
        emoji: reaction.emoji,
        count: (reaction.users || []).length,
        reactedBySelf: (reaction.users || []).includes(Number(appState.sessionIndex))
      }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  }

  function reactionUsersLabel(reaction) {
    const names = (reaction.users || [])
      .map((userId) => getChatUser(userId)?.username || (Number(userId) === Number(appState.sessionIndex) ? 'You' : `User ${userId}`));
    if (names.length === 0) return '';
    return `${reaction.emoji} by ${names.join(', ')}`;
  }

  function addPublicMessage(message) {
    messages.all = [...messages.all, message];
    if (!visible) {
      appState.chatUnreadCount++;
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(message.username, preview || '[image]', message.color);
    }
  }

  function addStaffChannelMessage(message) {
    messages.staff = [...messages.staff, message];
    const shouldCountUnread = !visible || activeView !== 'staff';
    if (shouldCountUnread) {
      appState.chatUnreadCount++;
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(message.username, `[Staff] ${preview || '[image]'}`, message.color);
    }
  }

  function addDirectMessage(userId, message) {
    rememberDMUser(userId);
    const threadMessages = messages.dms.get(userId) || [];
    threadMessages.push(message);
    messages.dms.set(userId, threadMessages);
    messages.dms = new Map(messages.dms);

    if (!message.fromSelf && !visible) {
      appState.chatUnreadCount++;
      const user = getChatUser(userId);
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(user?.username || 'DM', `[DM] ${preview || '[image]'}`, user?.color || '#8ba3c7');
    }
  }

  function activeHeaderTitle() {
    if (activeView === 'all') return 'Public';
    if (activeView === 'staff') return 'Staff';
    if (activeView === 'directory') return 'Private messages';
    return recipient?.username || 'Direct message';
  }

  function activeHeaderSubtitle() {
    if (activeView === 'all') return '';
    if (activeView === 'staff') return '';
    if (activeView === 'directory') {
      return `${directoryUsers.length} online contact${directoryUsers.length === 1 ? '' : 's'}`;
    }
    return recipient ? 'Private conversation' : 'Select someone to message';
  }

  function formatModeratorMeta(user) {
    if (!user || appState.selfRole < 4) return '';
    const roleNames = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
    const roleName = roleNames[user.role || 0] || 'Guest';
    return user.visibleIp ? `${roleName} | ${user.visibleIp}` : roleName;
  }

  function getRoleColor(userId) {
    const role = getChatUser(userId)?.role ?? 0;
    if (role >= 9) return 'var(--role-deity)';
    if (role === 8) return 'var(--role-holy)';
    if (role === 7) return 'var(--role-noble)';
    if (role >= 5) return 'var(--role-admin)';
    if (role === 4) return 'var(--role-mod)';
    if (role === 3) return 'var(--role-helper)';
    if (role >= 1) return 'var(--role-user)';
    return 'var(--role-guest)';
  }

  function openUserContextMenu(event, userId) {
    if (!window.app || userId === null || userId === undefined) return;

    if (Number(userId) === Number(appState.sessionIndex)) {
      window.app._showSelfContextMenu?.(event);
      return;
    }

    const user = window.app.users?.get(Number(userId)) || appState.users.get(userId);
    if (user) window.app.moderation?.showContextMenu(event, Number(userId), user);
  }

  function scrollToBottom(element) {
    if (!element) return;
    Promise.resolve().then(() => {
      element.scrollTop = element.scrollHeight;
    });
  }

  function clampChatPosition(left, top) {
    if (!chatEl) return { left, top };
    const maxLeft = Math.max(8, window.innerWidth - chatEl.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - chatEl.offsetHeight - 8);
    return {
      left: Math.max(8, Math.min(maxLeft, left)),
      top: Math.max(8, Math.min(maxTop, top))
    };
  }

  function setChatPosition(left, top) {
    if (!chatEl) return;
    const next = clampChatPosition(left, top);
    chatEl.style.left = `${next.left}px`;
    chatEl.style.top = `${next.top}px`;
    chatEl.style.right = 'auto';
    chatEl.style.bottom = 'auto';
  }

  function clearChatPosition() {
    if (!chatEl) return;
    chatEl.style.left = '';
    chatEl.style.top = '';
    chatEl.style.right = '';
    chatEl.style.bottom = '';
  }

  function applyStoredPositionForMode(mode = chatMode) {
    if (!chatEl) return;
    const positions = loadChatPositions();
    const saved = positions?.[mode];
    if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) {
      clearChatPosition();
      return;
    }
    setChatPosition(saved.left, saved.top);
  }

  function scheduleApplyStoredPosition(mode = chatMode) {
    requestAnimationFrame(() => applyStoredPositionForMode(mode));
  }

  function persistCurrentChatPosition(mode = chatMode) {
    if (!chatEl) return;
    const computed = window.getComputedStyle(chatEl);
    if (computed.left === 'auto' || computed.top === 'auto') return;

    const left = parseFloat(computed.left);
    const top = parseFloat(computed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;

    const positions = loadChatPositions();
    positions[mode] = clampChatPosition(left, top);
    persistChatPositions(positions);
  }

  function startDrag(event) {
    if (event.target.closest('button, textarea, input, a, label')) return;
    if (!chatEl) return;

    const rect = chatEl.getBoundingClientRect();
    setChatPosition(rect.left, rect.top);

    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    isDragging = true;
    event.preventDefault();
  }

  function onDrag(event) {
    if (!isDragging || !chatEl) return;

    const nextLeft = Math.max(8, Math.min(window.innerWidth - chatEl.offsetWidth - 8, event.clientX - dragOffsetX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - chatEl.offsetHeight - 8, event.clientY - dragOffsetY));

    setChatPosition(nextLeft, nextTop);
  }

  function endDrag() {
    if (isDragging) persistCurrentChatPosition();
    isDragging = false;
  }

  function isImageFile(file) {
    return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  async function queueComposerImage(file) {
    if (!isImageFile(file)) return;
    const dataUrl = await readFileAsDataUrl(file);
    composerImage = {
      name: file.name || 'image',
      dataUrl
    };
  }

  async function handleFileInputChange(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;
    await queueComposerImage(file);
    event.currentTarget.value = '';
  }

  function openFilePicker() {
    fileInputEl?.click();
  }

  function removeComposerImage() {
    composerImage = null;
  }

  async function handleDrop(event) {
    event.preventDefault();
    isDropTarget = false;
    dropDepth = 0;

    const file = [...(event.dataTransfer?.files || [])].find(isImageFile);
    if (file) await queueComposerImage(file);
  }

  function handleDragEnter(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    dropDepth += 1;
    isDropTarget = true;
  }

  function handleDragOver(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    isDropTarget = true;
  }

  function handleDragLeave(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) isDropTarget = false;
  }

  function insertEmoji(emoji) {
    messageInput = `${messageInput}${emoji}`;
    recordEmojiUsage(emoji);
  }

  function openEmojiPicker() {
    showEmojiPicker = !showEmojiPicker;
  }

  export function addChatMessage(username, message, color, userId = null, messageId = createMessageId()) {
    addPublicMessage(createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      username,
      color,
      userId
    }));
  }

  export function addChatImage(imageData, user, messageId = createMessageId()) {
    const username = user?.username || user?.name || 'User';
    const color = user?.color
      ? (Array.isArray(user.color)
          ? `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3] / 255})`
          : user.color)
      : '#8ba3c7';
    const userId = user?.id ?? user?.sessionIndex ?? null;

    addPublicMessage(createBaseMessage({
      id: messageId,
      type: 'image',
      imageData,
      username,
      color,
      userId
    }));
  }

  export function addStaffMessage(username, message, color, userId = null, messageId = createMessageId()) {
    addStaffChannelMessage(createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      username,
      color,
      userId
    }));
  }

  export function addStaffImage(imageData, user, messageId = createMessageId()) {
    const username = user?.username || user?.name || 'User';
    const color = user?.color
      ? (Array.isArray(user.color)
          ? `rgba(${user.color[0]}, ${user.color[1]}, ${user.color[2]}, ${user.color[3] / 255})`
          : user.color)
      : '#8ba3c7';
    const userId = user?.id ?? user?.sessionIndex ?? null;

    addStaffChannelMessage(createBaseMessage({
      id: messageId,
      type: 'image',
      imageData,
      username,
      color,
      userId
    }));
  }

  export function addSystemMessage(message) {
    addPublicMessage(createBaseMessage({
      type: 'system',
      text: message,
      username: 'System',
      color: '#8fd8ff'
    }));
  }

  export function addChatDM(message, senderId, fromSelf, messageId = createMessageId()) {
    rememberDMUser(senderId);
    addDirectMessage(senderId, createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      fromSelf,
      read: fromSelf || (visible && activeView === 'dm' && Number(recipient?.id) === Number(senderId)),
      threadUserId: senderId
    }));
  }

  export function addDMImage(imageData, senderId, fromSelf, messageId = createMessageId()) {
    rememberDMUser(senderId);
    addDirectMessage(senderId, createBaseMessage({
      id: messageId,
      type: 'image',
      imageData,
      fromSelf,
      read: fromSelf || (visible && activeView === 'dm' && Number(recipient?.id) === Number(senderId)),
      threadUserId: senderId
    }));
  }

  export function applyReaction(payload) {
    applyReactionLocally(payload);
  }

  $effect(() => {
    messages.all.length;
    if (visible && activeView === 'all') scrollToBottom(publicMessagesEl);
  });

  $effect(() => {
    messages.staff.length;
    if (visible && activeView === 'staff') scrollToBottom(publicMessagesEl);
  });

  $effect(() => {
    if (!canAccessStaff && activeView === 'staff') {
      activeView = 'all';
    }
  });

  $effect(() => {
    activeView;
    recipient?.id;
    activeDMMessages.length;
    if (visible && activeView === 'dm' && recipient) {
      markThreadRead(recipient.id);
      scrollToBottom(dmMessagesEl);
    }
  });

  $effect(() => {
    if (visible) appState.chatUnreadCount = 0;
  });

  $effect(() => {
    visible;
    chatMode;
    chatEl;
    if (visible && chatEl) {
      scheduleApplyStoredPosition(chatMode);
    }
  });

  $effect(() => {
    if (!visible || !chatEl) return;

    const handleResize = () => {
      const computed = window.getComputedStyle(chatEl);
      if (computed.left === 'auto' || computed.top === 'auto') return;
      const left = parseFloat(computed.left);
      const top = parseFloat(computed.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;
      setChatPosition(left, top);
      persistCurrentChatPosition();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  });

  $effect(() => {
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);

    return () => {
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', endDrag);
    };
  });
</script>

{#snippet messageContent(message)}
  {#if message.type === 'system'}
    <div class="system-pill">System</div>
    <p class="message-text">{message.text}</p>
  {:else}
    {#if message.type === 'image'}
      <button class="chat-image-card" onclick={() => window.open(message.imageData, '_blank')} type="button">
        <img src={message.imageData} alt="Chat upload" class="chat-image" />
      </button>
    {/if}
    {#if message.text}
      <p class="message-text">{@html linkify(message.text)}</p>
    {/if}
    <div class="reaction-row">
      <div class="reaction-pills">
        {#each normalizedReactionPills(message) as reaction (reaction.emoji)}
          <button class="reaction-pill" class:active={reaction.reactedBySelf} onclick={() => toggleReaction(message, reaction.emoji)} title={reactionUsersLabel(reaction)} type="button">
            <span>{reaction.emoji}</span>
            <span>{reaction.count}</span>
          </button>
        {/each}
      </div>
      <div class="reaction-actions">
        {#each selectableHoverReactionEmojis(message) as emoji (emoji)}
          <button class="quick-reaction" onclick={() => toggleReaction(message, emoji)} title={`React with ${emoji}`} type="button">
            {emoji}
          </button>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#if toasts.length > 0}
  <div class="chat-toasts">
    {#each toasts as toast (toast.id)}
      <button class="chat-toast" onclick={() => openFromToast(toast.id)}>
        <span class="chat-toast-swatch" style="background: {toast.color}"></span>
        <span class="chat-toast-copy">
          <span class="chat-toast-username">{toast.username}</span>
          <span class="chat-toast-message">{toast.message}</span>
        </span>
      </button>
    {/each}
  </div>
{/if}

{#if visible}
  <section class="chat-shell" class:full={chatMode === 'full'} class:compact={chatMode === 'compact'} class:dragging={isDragging} bind:this={chatEl}>
    <aside class="chat-rail">
      <button class="rail-tab public-tab" class:active={activeView === 'all'} onclick={showPublic} title="Public" type="button">
        <span class="rail-tab-name">Public</span>
      </button>

      {#if canAccessStaff}
        <button class="rail-tab public-tab" class:active={activeView === 'staff'} onclick={showStaff} title="Staff" type="button">
          <span class="rail-tab-name">Staff</span>
        </button>
      {/if}

      {#if activeThreads.length > 0}
        <div class="rail-section-label">DMs</div>
      {/if}

      <div class="rail-thread-list">
        {#each activeThreads as thread (thread.id)}
          <button class="rail-tab" class:active={activeView === 'dm' && Number(recipient?.id) === Number(thread.id)} onclick={() => openThreadById(thread.id)} title={thread.user?.username || 'Direct message'} type="button">
            <span class="rail-avatar" style="--avatar-color: {thread.user?.color || '#6f86a3'}">
              {(thread.user?.username || '?').slice(0, 1).toUpperCase()}
            </span>
            <span class="rail-tab-name">{thread.user?.username || 'Unknown'}</span>
            {#if getUnreadCount(thread.id) > 0}
              <span class="rail-badge">{getUnreadCount(thread.id)}</span>
            {/if}
          </button>
        {/each}
      </div>

      <button class="rail-action" class:active={activeView === 'directory'} onclick={showDirectory} title="Start direct message" type="button">
        <span>+</span>
        <span>New DM</span>
      </button>
    </aside>
    <div class="chat-main">
      <header class="chat-topbar" onmousedown={startDrag} role="presentation" aria-label="Chat window header">
        <div class="chat-topbar-copy">
          <p class="chat-kicker">{activeHeaderTitle()}</p>
          {#if activeHeaderSubtitle()}
            <span>{activeHeaderSubtitle()}</span>
          {/if}
        </div>

        <div class="chat-topbar-actions">
          <button class="topbar-btn" onclick={toggleMode} title={chatMode === 'full' ? 'Use compact mode' : 'Use full mode'} type="button">
            {chatMode === 'full' ? 'Small' : 'Full'}
          </button>
          <button class="topbar-btn close" onclick={hide} title="Close chat" type="button">X</button>
        </div>
      </header>

      <div class="chat-stage" class:drop-target={isDropTarget} ondragenter={handleDragEnter} ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop} role="region" aria-label="Chat messages">
        {#if isDropTarget}
          <div class="drop-overlay">Drop an image into chat</div>
        {/if}

        {#if activeView === 'directory'}
          <section class="directory-view">
            <div class="directory-header">
              <h3>Start a private message</h3>
              <p>Pick someone from the room to open a direct thread.</p>
            </div>

            <div class="directory-list">
              {#if directoryUsers.length === 0}
                <div class="directory-empty">Nobody else is online right now.</div>
              {:else}
                {#each directoryUsers as user (user.id)}
                  <button class="directory-user" onclick={() => selectDMRecipient(user)} oncontextmenu={(event) => openUserContextMenu(event, user.id)} title={formatModeratorMeta(user)} type="button">
                    <span class="directory-avatar" style="--avatar-color: {user.color}">
                      {user.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span class="directory-copy">
                      <strong>{user.username}</strong>
                      <small>{formatModeratorMeta(user) || 'Tap to open thread'}</small>
                    </span>
                    {#if getUnreadCount(user.id) > 0}
                      <span class="directory-badge">{getUnreadCount(user.id)}</span>
                    {/if}
                  </button>
                {/each}
              {/if}
            </div>
          </section>
        {:else if activeView === 'dm' && recipient}
          <section class="conversation-view">
            <div class="message-stream dm-stream" bind:this={dmMessagesEl}>
              {#if activeDMMessages.length === 0}
                <div class="message-empty">This thread is empty. Say hi.</div>
              {:else}
                {#each activeDMMessages as msg (msg.id)}
                  <article class="dm-bubble-row" class:self={msg.fromSelf}>
                    <div class="dm-bubble">
                      {@render messageContent(msg)}
                      <span>{formatShortTime(msg.timestamp)}</span>
                    </div>
                  </article>
                {/each}
              {/if}
            </div>
          </section>
        {:else if activeView === 'staff'}
          <section class="conversation-view">
            <div class="message-stream" bind:this={publicMessagesEl}>
              {#if messages.staff.length === 0}
                <div class="message-empty">Staff chat is empty.</div>
              {:else}
                {#each groupedStaffMessages as msg (msg.id)}
                  <article class="message-row" class:system={msg.type === 'system'} class:grouped={msg.groupedWithPrevious} class:group-tail={!msg.groupedWithNext}>
                    <span class="message-time">{msg.groupedWithPrevious ? '' : formatTime(msg.timestamp)}</span>
                    <div class="message-body">
                      {#if msg.type !== 'system' && !msg.groupedWithPrevious}
                        <button class="message-user" oncontextmenu={(event) => openUserContextMenu(event, msg.userId)} title={msg.userId !== null ? formatModeratorMeta(getChatUser(msg.userId)) : ''} type="button" style="color: {getRoleColor(msg.userId)}">
                          {msg.username}
                        </button>
                      {/if}
                      {@render messageContent(msg)}
                    </div>
                  </article>
                {/each}
              {/if}
            </div>
          </section>
        {:else}
          <section class="conversation-view">
            <div class="message-stream" bind:this={publicMessagesEl}>
              {#if messages.all.length === 0}
                <div class="message-empty"></div>
              {:else}
                {#each groupedPublicMessages as msg (msg.id)}
                  <article class="message-row" class:system={msg.type === 'system'} class:grouped={msg.groupedWithPrevious} class:group-tail={!msg.groupedWithNext}>
                    <span class="message-time">{msg.groupedWithPrevious ? '' : formatTime(msg.timestamp)}</span>
                    <div class="message-body">
                      {#if msg.type !== 'system' && !msg.groupedWithPrevious}
                        <button class="message-user" oncontextmenu={(event) => openUserContextMenu(event, msg.userId)} title={msg.userId !== null ? formatModeratorMeta(getChatUser(msg.userId)) : ''} type="button" style="color: {getRoleColor(msg.userId)}">
                          {msg.username}
                        </button>
                      {/if}
                      {@render messageContent(msg)}
                    </div>
                  </article>
                {/each}
              {/if}
            </div>
          </section>
        {/if}
      </div>

      <footer class="chat-composer">
        {#if composerImage}
          <div class="composer-preview">
            <img src={composerImage.dataUrl} alt="Upload preview" />
            <div class="composer-preview-copy">
              <strong>{composerImage.name}</strong>
              <span>Ready to send</span>
            </div>
            <button class="composer-preview-remove" onclick={removeComposerImage} type="button">Remove</button>
          </div>
        {/if}

        {#if showEmojiPicker}
          <div class="emoji-picker">
            {#if recentEmojis().length > 0}
              <div class="emoji-picker-section">
                <span class="reaction-picker-label">Recent</span>
                <div class="reaction-picker-grid">
                  {#each recentEmojis() as emoji (emoji)}
                    <button class="emoji-btn" onclick={() => insertEmoji(emoji)} type="button">{emoji}</button>
                  {/each}
                </div>
              </div>
            {/if}
            <div class="emoji-picker-section">
              <span class="reaction-picker-label">Most used</span>
              <div class="reaction-picker-grid">
            {#each rankedComposerEmojis() as emoji (emoji)}
              <button class="emoji-btn" onclick={() => insertEmoji(emoji)} type="button">{emoji}</button>
            {/each}
              </div>
            </div>
          </div>
        {/if}

        <div class="composer-row">
          <input class="composer-file-input" bind:this={fileInputEl} onchange={handleFileInputChange} accept="image/*" type="file" />
          <button class="composer-tool" onclick={openFilePicker} disabled={activeView === 'directory'} title="Upload image" type="button">+</button>
          <button class="composer-tool" onclick={openEmojiPicker} disabled={activeView === 'directory'} title="Add emoji" type="button">{COMPOSER_EMOJIS[0]}</button>
          <textarea class="chat-input" bind:value={messageInput} onkeydown={handleKeydown} placeholder={activeView === 'all' ? 'Message the room...' : activeView === 'staff' ? 'Message staff...' : activeView === 'dm' && recipient ? `Message ${recipient.username}...` : 'Select someone to start a DM...'} rows="1" disabled={activeView === 'directory'}></textarea>
          <button class="chat-send" onclick={handleSend} disabled={activeView === 'directory'} type="button">Send</button>
        </div>
      </footer>
    </div>
  </section>
{/if}

<style>
  .chat-shell {
    --chat-bg:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 94%, black), color-mix(in srgb, var(--bg-primary) 96%, black));
    --chat-border: var(--border-subtle);
    --chat-text: var(--text-primary);
    --chat-muted: var(--text-secondary);
    --chat-accent: var(--accent-primary);
    --chat-shadow: var(--shadow-lg);
    position: fixed;
    right: 18px;
    bottom: 22px;
    z-index: 1200;
    display: grid;
    grid-template-columns: 116px minmax(0, 1fr);
    width: min(420px, calc(100vw - 24px));
    height: min(560px, calc(100vh - 110px));
    min-height: 0;
    color: var(--chat-text);
    background: var(--chat-bg);
    border: 1px solid var(--chat-border);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--chat-shadow);
    backdrop-filter: blur(18px);
  }

  .chat-shell.full {
    width: min(880px, calc(100vw - 44px));
    height: min(612px, calc(100vh - 56px));
  }

  .chat-shell.compact {
    width: min(420px, calc(100vw - 24px));
    grid-template-columns: 92px minmax(0, 1fr);
  }

  .chat-rail {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    padding: 14px 12px;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 92%, black), color-mix(in srgb, var(--bg-primary) 96%, black)),
      radial-gradient(circle at top, color-mix(in srgb, var(--accent-primary) 15%, transparent), transparent 52%);
    border-right: 1px solid var(--border-subtle);
  }

  .rail-tab,
  .rail-action,
  .topbar-btn,
  .directory-user,
  .chat-send,
  .chat-toast,
  .composer-tool,
  .emoji-btn,
  .reaction-pill,
  .quick-reaction,
  .chat-image-card,
  .composer-preview-remove {
    border: 0;
    cursor: pointer;
  }

  .rail-section-label {
    padding: 0 0.35rem;
    color: color-mix(in srgb, var(--text-secondary) 70%, transparent);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .rail-thread-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow-y: auto;
  }

  .rail-tab,
  .rail-action {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0.7rem 0.5rem;
    background: color-mix(in srgb, var(--bg-elevated) 42%, transparent);
    color: var(--chat-muted);
    border-radius: 16px;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .rail-tab:hover,
  .rail-action:hover,
  .topbar-btn:hover,
  .directory-user:hover,
  .chat-send:hover,
  .chat-toast:hover,
  .composer-tool:hover,
  .emoji-btn:hover,
  .reaction-pill:hover,
  .quick-reaction:hover,
  .chat-image-card:hover,
  .composer-preview-remove:hover {
    transform: translateY(-1px);
  }

  .rail-tab:hover,
  .rail-action:hover,
  .rail-tab.active,
  .rail-action.active {
    background: color-mix(in srgb, var(--accent-primary) 16%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .public-tab {
    justify-content: center;
    text-align: left;
    min-height: 46px;
    width: calc(100% + 24px);
    margin-left: -12px;
    padding-left: 12px;
    padding-right: 12px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }

  .rail-action {
    margin-top: auto;
    padding-top: 0.85rem;
    padding-bottom: 0.85rem;
    background: color-mix(in srgb, var(--accent-primary) 24%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .rail-action:hover,
  .rail-action.active {
    background: color-mix(in srgb, var(--accent-primary) 32%, var(--bg-elevated));
  }

  .public-tab,
  .rail-tab.public-tab.active,
  .rail-tab.public-tab:hover {
    border-radius: 0;
  }

  .rail-avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 88%, white 12%);
    font-size: 1rem;
    font-weight: 800;
  }

  .rail-avatar,
  .directory-avatar {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--avatar-color) 78%, white), color-mix(in srgb, var(--avatar-color) 55%, black));
    color: white;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
  }

  .rail-tab-name {
    max-width: 100%;
    overflow: hidden;
    color: inherit;
    font-size: 0.72rem;
    font-weight: 700;
    line-height: 1.1;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .public-tab .rail-tab-name,
  .rail-action span:last-child {
    font-size: 0.91rem;
    letter-spacing: 0.01em;
  }

  .public-tab .rail-tab-name {
    font-weight: 800;
  }

  .rail-action span:first-child {
    font-size: 1.2rem;
    line-height: 1;
  }

  .rail-badge,
  .directory-badge {
    display: inline-flex;
    min-width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent-primary);
    color: var(--bg-primary);
    font-size: 0.68rem;
    font-weight: 800;
  }

  .rail-badge {
    position: absolute;
    top: 7px;
    right: 6px;
  }

  .chat-main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--accent-primary) 8%, transparent), transparent 18%),
      linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 95%, black), color-mix(in srgb, var(--bg-primary) 98%, black));
  }

  .chat-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.7rem 1.15rem;
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-elevated) 50%, transparent);
    cursor: move;
  }

  .chat-topbar-copy {
    min-width: 0;
  }

  .chat-kicker {
    margin: 0.5rem 0 0.25rem;
    color: color-mix(in srgb, var(--accent-primary) 58%, var(--text-primary));
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .chat-topbar-copy span {
    display: inline-block;
    margin-top: 0.1rem;
    color: var(--chat-muted);
    font-size: 0.8rem;
  }

  .chat-topbar-actions {
    display: flex;
    gap: 8px;
    align-self: center;
    margin-top: 0;
  }

  .chat-shell.dragging {
    user-select: none;
  }

  .topbar-btn {
    min-height: 36px;
    padding: 0 0.85rem;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--chat-text);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .topbar-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .topbar-btn.close {
    width: 36px;
    padding: 0;
  }

  .topbar-btn.close:hover {
    background: color-mix(in srgb, #ff6b6b 22%, var(--bg-elevated));
    color: white;
  }

  .chat-stage {
    position: relative;
    min-height: 0;
    overflow: hidden;
  }

  .chat-stage.drop-target {
    background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
  }

  .drop-overlay {
    position: absolute;
    inset: 16px;
    z-index: 5;
    display: grid;
    place-items: center;
    border: 1px dashed color-mix(in srgb, var(--accent-primary) 60%, transparent);
    border-radius: 20px;
    background: color-mix(in srgb, var(--bg-secondary) 84%, transparent);
    color: var(--chat-text);
    font-size: 0.96rem;
    font-weight: 700;
    pointer-events: none;
  }

  .conversation-view,
  .directory-view {
    display: grid;
    height: 100%;
    min-height: 0;
  }

  .directory-view {
    grid-template-rows: auto minmax(0, 1fr);
  }

  .directory-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.95rem 1.15rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    background: color-mix(in srgb, var(--bg-elevated) 32%, transparent);
  }

  .directory-header h3 {
    display: block;
    margin: 0;
    font-size: 0.95rem;
    font-weight: 800;
  }

  .directory-header p {
    display: block;
    margin: 0.18rem 0 0;
    color: var(--chat-muted);
    font-size: 0.76rem;
  }

  .message-stream,
  .directory-list {
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.15rem 1.1rem;
  }

  .message-empty,
  .directory-empty {
    display: grid;
    place-items: center;
    min-height: 100%;
    color: var(--chat-muted);
    font-size: 0.86rem;
    text-align: center;
  }

  .message-row {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    gap: 0.9rem;
    padding: 0.38rem 0;
    border-bottom: 0;
  }

  .message-row.system {
    grid-template-columns: 58px minmax(0, 1fr);
  }

  .message-row.grouped {
    padding-top: 0.02rem;
    padding-bottom: 0.02rem;
  }

  .message-row.group-tail {
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 45%, transparent);
    padding-bottom: 0.38rem;
  }

  .message-row.group-tail:not(.grouped) {
    margin-bottom: 0.12rem;
  }

  .message-time {
    color: color-mix(in srgb, var(--text-secondary) 72%, transparent);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .message-row.grouped .message-time {
    opacity: 0;
    pointer-events: none;
  }

  .message-body {
    min-width: 0;
  }

  .message-user {
    display: inline-flex;
    align-items: center;
    padding: 0;
    background: transparent;
    font-size: 0.88rem;
    font-weight: 800;
    border: 0;
    box-shadow: none;
    cursor: context-menu;
    line-height: 1.15;
  }

  .message-text {
    margin: 0.08rem 0 0;
    color: var(--text-primary);
    font-size: 0.9rem;
    line-height: 1.45;
    word-break: break-word;
  }

  .message-row.grouped .message-text {
    margin-top: 0;
  }

  .chat-image-card {
    display: block;
    max-width: min(100%, 360px);
    margin: 0.35rem 0 0;
    padding: 0;
    overflow: hidden;
    border-radius: 18px;
    background: color-mix(in srgb, var(--bg-elevated) 68%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent);
  }

  .chat-image {
    display: block;
    width: 100%;
    max-height: 260px;
    object-fit: cover;
  }

  .reaction-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.55rem;
  }

  .reaction-pills,
  .reaction-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .reaction-actions {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.14s ease;
  }

  .message-body:hover .reaction-actions,
  .dm-bubble:hover .reaction-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .reaction-pill,
  .quick-reaction {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 28px;
    padding: 0 0.55rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-elevated) 78%, transparent);
    color: var(--chat-text);
    font-size: 0.76rem;
  }

  .reaction-pill.active {
    background: color-mix(in srgb, var(--accent-primary) 24%, transparent);
    color: color-mix(in srgb, var(--accent-primary) 72%, white);
  }

  .quick-reaction {
    width: 28px;
    justify-content: center;
    padding: 0;
    opacity: 0.72;
  }

  .emoji-picker {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.55rem;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, black 6%);
  }

  .emoji-picker-section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .reaction-picker-label {
    color: var(--chat-muted);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .reaction-picker-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .system-pill {
    display: inline-flex;
    align-items: center;
    padding: 0.22rem 0.5rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
    color: color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary));
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .dm-stream {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .dm-bubble-row {
    display: flex;
  }

  .dm-bubble-row.self {
    justify-content: flex-end;
  }

  .dm-bubble {
    max-width: min(78%, 540px);
    padding: 0.8rem 0.9rem 0.7rem;
    border-radius: 18px 18px 18px 6px;
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
  }

  .dm-bubble-row.self .dm-bubble {
    border-radius: 18px 18px 6px 18px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 88%, white), color-mix(in srgb, var(--accent-secondary) 92%, black));
    color: var(--bg-primary);
  }

  .dm-bubble :global(.message-text) {
    color: inherit;
  }

  .dm-bubble span {
    display: block;
    margin-top: 0.35rem;
    font-size: 0.7rem;
    color: color-mix(in srgb, var(--text-secondary) 68%, transparent);
  }

  .dm-bubble-row.self .dm-bubble span {
    color: color-mix(in srgb, var(--bg-primary) 58%, transparent);
  }

  .directory-list {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .directory-user {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    width: 100%;
    padding: 0.8rem 0.9rem;
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-elevated) 55%, transparent);
    color: var(--chat-text);
    text-align: left;
  }

  .directory-avatar {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 1rem;
    font-weight: 800;
    flex-shrink: 0;
  }

  .directory-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .directory-copy strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.92rem;
  }

  .directory-copy small {
    margin-top: 0.18rem;
    color: var(--chat-muted);
    font-size: 0.74rem;
  }

  .chat-composer {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 0;
    padding: 1rem 1.15rem 1.1rem;
    border-top: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--bg-secondary) 65%, transparent);
    flex-shrink: 0;
  }

  .composer-row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 0.6rem;
    align-items: end;
  }

  .composer-file-input {
    display: none;
  }

  .composer-tool {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--chat-text);
    font-size: 1rem;
    font-weight: 800;
  }

  .composer-tool:hover {
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .composer-tool:disabled,
  .composer-preview-remove:disabled,
  .emoji-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
  }

  .composer-preview {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 90%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-elevated) 58%, transparent);
  }

  .composer-preview img {
    width: 56px;
    height: 56px;
    border-radius: 12px;
    object-fit: cover;
  }

  .composer-preview-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .composer-preview-copy strong,
  .composer-preview-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-preview-copy strong {
    font-size: 0.84rem;
  }

  .composer-preview-copy span {
    color: var(--chat-muted);
    font-size: 0.74rem;
  }

  .composer-preview-remove {
    min-height: 34px;
    padding: 0 0.8rem;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-secondary) 72%, transparent);
    color: var(--chat-text);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .emoji-picker {
    padding: 0.3rem 0 0;
  }

  .emoji-btn {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
    font-size: 1rem;
  }

  .chat-input {
    flex: 1;
    min-height: 46px;
    max-height: 120px;
    padding: 0.8rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-primary) 70%, transparent);
    color: var(--chat-text);
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.35;
    resize: none;
    outline: none;
  }

  .chat-input::placeholder {
    color: color-mix(in srgb, var(--text-secondary) 60%, transparent);
  }

  .chat-input:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .chat-input:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .chat-send {
    min-width: 82px;
    min-height: 46px;
    padding: 0 1.05rem;
    border-radius: 14px;
    background: linear-gradient(135deg, var(--accent-hover), var(--accent-primary));
    color: var(--bg-primary);
    font-size: 0.84rem;
    font-weight: 800;
  }

  .chat-send:hover {
    background: linear-gradient(135deg, var(--accent-primary), var(--accent-hover));
    color: var(--bg-primary);
  }

  .chat-send:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none;
  }

  .chat-toasts {
    position: fixed;
    right: 22px;
    bottom: 22px;
    z-index: 1300;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    pointer-events: none;
  }

  .chat-toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 220px;
    max-width: 320px;
    padding: 0.8rem 0.9rem;
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-secondary) 94%, black);
    color: var(--chat-text);
    box-shadow: var(--shadow-lg);
  }

  .chat-toast-swatch {
    width: 10px;
    height: 40px;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .chat-toast-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.12rem;
  }

  .chat-toast-username {
    font-size: 0.82rem;
    font-weight: 800;
  }

  .chat-toast-message {
    overflow: hidden;
    color: var(--chat-muted);
    font-size: 0.76rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.chat-link) {
    color: var(--accent-primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
  }

  :global(.chat-link:hover) {
    color: var(--accent-hover);
  }

  @media (max-width: 900px) {
    .chat-shell.full,
    .chat-shell.compact {
      right: 12px;
      bottom: 12px;
      width: calc(100vw - 24px);
      height: min(76vh, 620px);
    }
  }

  @media (max-width: 640px) {
    .chat-shell,
    .chat-shell.full,
    .chat-shell.compact {
      right: 8px;
      bottom: 8px;
      width: calc(100vw - 16px);
      height: calc(100vh - 90px);
      border-radius: 18px;
      grid-template-columns: 84px minmax(0, 1fr);
    }

    .chat-topbar,
    .directory-header,
    .message-stream,
    .directory-list,
    .chat-composer {
      padding-left: 0.9rem;
      padding-right: 0.9rem;
    }

    .composer-row {
      grid-template-columns: auto auto minmax(0, 1fr);
    }

    .chat-send {
      grid-column: 1 / -1;
    }

    .message-row {
      grid-template-columns: 50px minmax(0, 1fr);
      gap: 0.7rem;
    }

    .topbar-btn {
      min-width: 36px;
      padding: 0 0.72rem;
    }

    .chat-image-card {
      max-width: 100%;
    }

    .dm-bubble {
      max-width: 88%;
    }
  }
</style>
