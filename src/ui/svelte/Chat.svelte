<script>
  import { onMount, tick } from 'svelte';
  import { appState } from '../../state.svelte.js';
  import { isTauriDesktop } from '../../platform/desktop.js';
  import { isChatPopoutOpen } from '../../platform/chatPopoutBridge.js';
  import WindowTitleBar from './WindowTitleBar.svelte';

  const CHAT_MODE_STORAGE_KEY = 'topdraw-chat-mode';
  const CHAT_POSITION_STORAGE_KEY = 'topdraw-chat-position';
  const COMPOSER_EMOJIS = [
    '\u{1F600}', '\u{1F603}', '\u{1F604}', '\u{1F601}', '\u{1F606}', '\u{1F605}',
    '\u{1F923}', '\u{1F602}', '\u{1F642}', '\u{1F643}', '\u{1F609}', '\u{1F60A}',
    '\u{1F60D}', '\u{1F970}', '\u{1F618}', '\u{1F60E}', '\u{1F929}', '\u{1F60F}',
    '\u{1F62D}', '\u{1F97A}', '\u{1F62E}', '\u{1F631}', '\u{1F92F}', '\u{1F525}',
    '\u2728', '\u{1F4AF}', '\u{1F389}', '\u{1F44F}', '\u{1F44D}', '\u{1F44E}',
    '\u{1F64C}', '\u{1F64F}', '\u{1F91D}', '\u2764\uFE0F', '\u{1F49C}',
    '\u{1F496}', '\u{1F4A5}', '\u{1F4A8}', '\u{1F4A6}', '\u{1F440}', '\u{1F440}',
    '\u{1F914}', '\u{1F928}', '\u{1F910}', '\u{1F92D}', '\u{1F92B}', '\u{1F4A9}',
    '\u{1F921}', '\u{1F975}', '\u{1F976}', '\u{1F383}', '\u{1F921}', '\u{1F47D}',
    '\u{1F47B}', '\u{1F480}', '\u{1F916}', '\u{1F47A}', '\u{1F47F}', '\u{1F32E}',
    '\u{1F34C}', '\u{1F355}', '\u{1F354}', '\u{1F36A}', '\u{1F37F}', '\u{1F3A8}',
    '\u{1F3AE}', '\u{1F3C6}', '\u{1F3C1}', '\u{1F680}', '\u{1F4A1}', '\u{1F44C}'
  ];
  const REACTION_EMOJIS = [
    '\u{1F44D}', '\u2764\uFE0F', '\u{1F525}', '\u{1F602}', '\u{1F62E}', '\u{1F3A8}',
    '\u{1F44F}', '\u2728', '\u{1F389}', '\u{1F60D}', '\u{1F914}', '\u{1F44E}',
    '\u{1F4AF}', '\u{1F4A9}', '\u{1F923}', '\u{1F97A}', '\u{1F62D}', '\u{1F440}',
    '\u{1F64C}', '\u{1F64F}', '\u{1F92F}', '\u{1F47D}', '\u{1F480}', '\u{1F32E}'
  ];
  const CHAT_UPLOAD_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ]);
  const MAX_CHAT_UPLOAD_BYTES = Math.floor(4.5 * 1024 * 1024);
  const MAX_CHAT_UPLOAD_DIMENSION = 4096;
  const MAX_CHAT_UPLOAD_PIXELS = 8_388_608;
  const GALLERY_LINK_HOSTS = new Set(['ddraw.ca', 'www.ddraw.ca']);

  let {
    onSend = null,
    onStaffSend = null,
    onStaffSendImage = null,
    onDM = null,
    onSendImage = null,
    onReact = null,
    onPopout = null,
    isPopout = false
  } = $props();

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
  let composerInputEl = $state(null);
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let isDropTarget = $state(false);
  let dropDepth = 0;
  let showEmojiPicker = $state(false);
  let composerImage = $state(null);
  let expandedImage = $state(null);
  let galleryPreviewCache = $state(new Map());
  let pendingGalleryPreviews = new Set();
  let chatPinnedToBottom = $state({
    all: true,
    staff: true,
    dm: true
  });

  let visible = $derived(isPopout || appState.chatVisible);
  let effectiveChatMode = $derived(isPopout ? 'full' : chatMode);
  let hideRoomNotifications = $derived(!!appState.currentRoomData?.hideChatNotifications);
  let isDesktopClient = $state(false);
  let desktopWindowApi = null;
  let desktopWindowState = $state({
    maximized: false,
    fullscreen: false
  });

  $effect(() => {
    if (hideRoomNotifications && toasts.length > 0) {
      toasts = [];
    }
  });
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

  function createMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isChatMessage(message) {
    return message?.type === 'message' || message?.type === 'image';
  }

  function rankedComposerEmojis() {
    return [...new Set([...COMPOSER_EMOJIS, ...REACTION_EMOJIS])];
  }

  function hoverReactionEmojis(limit = 6) {
    return [...new Set(REACTION_EMOJIS)].slice(0, limit);
  }

  function selectableHoverReactionEmojis(message, limit = 5) {
    const existing = new Set((message.reactions || []).map((reaction) => reaction.emoji));
    return hoverReactionEmojis(limit + existing.size)
      .filter((emoji) => !existing.has(emoji))
      .slice(0, limit);
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
    if (isPopout) {
      window.close();
      return;
    }

    appState.chatVisible = false;
  }

  async function closeChatWindow() {
    if (expandedImage) {
      closeImageViewer();
      return;
    }

    if (!isPopout) {
      hide();
      return;
    }

    if (desktopWindowApi) {
      await desktopWindowApi.close();
      return;
    }

    window.close();
  }

  function popoutChat() {
    onPopout?.();
  }

  async function syncDesktopWindowState() {
    if (!desktopWindowApi) return;

    desktopWindowState = {
      maximized: await desktopWindowApi.isMaximized(),
      fullscreen: await desktopWindowApi.isFullscreen()
    };
  }

  async function minimizeDesktopWindow() {
    if (!desktopWindowApi) return;
    await desktopWindowApi.minimize();
  }

  async function toggleMaximizeDesktopWindow() {
    if (!desktopWindowApi) return;
    await desktopWindowApi.toggleMaximize();
    await syncDesktopWindowState();
  }

  async function toggleFullscreenDesktopWindow() {
    if (!desktopWindowApi) return;
    const nextFullscreen = !(await desktopWindowApi.isFullscreen());
    await desktopWindowApi.setFullscreen(nextFullscreen);
    await syncDesktopWindowState();
  }

  function toggleMode() {
    if (isPopout) return;
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
    const pendingImage = composerImage;
    const hasImage = !!pendingImage;

    if (!msg && !hasImage) return;

    messageInput = '';
    composerImage = null;
    showEmojiPicker = false;

    if (msg) {
      if (activeView === 'all' && onSend) onSend(msg);
      else if (activeView === 'staff' && onStaffSend) onStaffSend(msg);
      else if (recipientId !== null && onDM) onDM(msg, recipientId);
    }

    if (hasImage) {
      if (activeView === 'staff' && onStaffSendImage) {
        onStaffSendImage(pendingImage.dataUrl);
      } else if (onSendImage) {
        onSendImage(pendingImage.dataUrl, recipientId);
      }
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function linkify(text) {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const withLinks = escaped.replace(
      /https?:\/\/[^\s<>"]+/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`
    );
    return withLinks.replace(
      /(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu,
      '<span class="chat-inline-emoji">$1</span>'
    );
  }

  function extractGalleryLinks(text) {
    if (!text) return [];
    const seen = new Set();
    const links = [];
    const matches = String(text).match(/https?:\/\/[^\s<>"]+/g) || [];

    for (const rawUrl of matches) {
      try {
        const url = new URL(rawUrl);
        const id = url.pathname.match(/^\/gallery\/([a-f0-9]{24})\/?$/i)?.[1];
        if (!id || !GALLERY_LINK_HOSTS.has(url.hostname.toLowerCase()) || seen.has(id)) continue;
        seen.add(id);
        links.push({ id, url: url.toString() });
      } catch {
        // Ignore malformed pasted URLs.
      }
    }

    return links;
  }

  function getGalleryPreview(link) {
    if (!link?.id) return null;
    const cached = galleryPreviewCache.get(link.id);
    if (cached || pendingGalleryPreviews.has(link.id)) return cached || null;

    pendingGalleryPreviews.add(link.id);
    fetch(`/api/gallery/${encodeURIComponent(link.id)}`)
      .then((res) => {
        if (res.ok) return res.json();
        return fetch(`/api/gallery-item?id=${encodeURIComponent(link.id)}`)
          .then((fallbackRes) => (fallbackRes.ok ? fallbackRes.json() : null));
      })
      .then((item) => {
        if (!item?.id) {
          galleryPreviewCache = new Map(galleryPreviewCache).set(link.id, { missing: true });
          return;
        }

        galleryPreviewCache = new Map(galleryPreviewCache).set(link.id, {
          id: item.id,
          title: item.title || 'Gallery image',
          author: item.author || 'DDraw artist',
          thumbUrl: item.thumbUrl || item.url,
          url: link.url,
          nsfw: Array.isArray(item.tags) && item.tags.includes('nsfw')
        });
      })
      .catch(() => {
        galleryPreviewCache = new Map(galleryPreviewCache).set(link.id, { missing: true });
      })
      .finally(() => {
        pendingGalleryPreviews.delete(link.id);
      });

    return null;
  }

  async function openChatUrl(href) {
    if (!href) return;

    if (isTauriDesktop()) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(href);
        return;
      } catch (error) {
        console.error('[Chat] Failed to open link via Tauri shell:', error);
      }
    }

    window.open(href, '_blank', 'noopener,noreferrer');
  }

  function handleChatLinkClick(event) {
    const link = event.target?.closest?.('a.chat-link, a.gallery-preview-card');
    if (!link?.href) return;
    event.preventDefault();
    event.stopPropagation();
    void openChatUrl(link.href);
  }

  function colorToCss(color, { opaque = false } = {}) {
    if (!color) return opaque ? '#8ba3c7' : '#8ba3c7';
    if (!Array.isArray(color)) {
      if (!opaque) return color;
      const rgbaMatch = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/i);
      if (!rgbaMatch) return color;
      const [, r, g, b] = rgbaMatch;
      return readableNameColor([Number(r), Number(g), Number(b)]);
    }

    const [r = 139, g = 163, b = 199, alpha = 1] = color;
    if (opaque) return readableNameColor([r, g, b]);
    const normalizedAlpha = alpha > 1 ? alpha / 255 : alpha;
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  function readableNameColor([r = 139, g = 163, b = 199]) {
    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    if (luminance >= 72) return `rgb(${r}, ${g}, ${b})`;

    const lift = Math.min(1, 72 / Math.max(luminance, 1));
    const nextR = Math.min(255, Math.round(r * lift));
    const nextG = Math.min(255, Math.round(g * lift));
    const nextB = Math.min(255, Math.round(b * lift));

    if ((0.2126 * nextR) + (0.7152 * nextG) + (0.0722 * nextB) < 72) {
      return 'var(--role-user)';
    }

    return `rgb(${nextR}, ${nextG}, ${nextB})`;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function getChatUser(userId) {
    if (userId === null || userId === undefined) return null;
    if (Number(userId) === Number(appState.sessionIndex) && window.app?.self) {
      return {
        id: userId,
        username: window.app.self.username || window.app.self.name || 'You',
        color: colorToCss(window.app.self.color, { opaque: true }),
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
      color: colorToCss(user.color, { opaque: true }),
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
    const nextThreadMessages = threadMessages.map((msg) => {
      if (!msg.fromSelf && !msg.read) {
        changed = true;
        return { ...msg, read: true };
      }
      return msg;
    });

    if (!changed) return;

    const nextDms = new Map(messages.dms);
    nextDms.set(userId, nextThreadMessages);
    messages = {
      ...messages,
      dms: nextDms
    };
  }

  function showToast(username, message, color, options = {}) {
    if (hideRoomNotifications) return;
    const id = ++toastIdCounter;
    const truncated = message.length > 90 ? `${message.slice(0, 90)}...` : message;
    toasts = [...toasts, {
      id,
      username,
      message: truncated,
      color,
      recipientId: options.recipientId ?? null
    }];
    setTimeout(() => dismissToast(id), 4000);
    if (toasts.length > 3) toasts = toasts.slice(toasts.length - 3);
  }

  function dismissToast(id) {
    toasts = toasts.filter((toast) => toast.id !== id);
  }

  function openFromToast(id) {
    const toast = toasts.find((entry) => entry.id === id);
    dismissToast(id);
    if (toast?.recipientId !== null && toast?.recipientId !== undefined) {
      void openDMThread(toast.recipientId);
      return;
    }
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
        const nextDms = new Map(messages.dms);
        nextDms.set(threadId, [...threadMessages]);
        messages = {
          ...messages,
          dms: nextDms
        };
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

    if (message.type === 'system') return;

    if (!visible && !isChatPopoutOpen()) {
      appState.chatUnreadCount++;
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(message.username, preview || '[image]', message.color);
    }
  }

  function addStaffChannelMessage(message) {
    messages.staff = [...messages.staff, message];
    const popoutOpen = isChatPopoutOpen();
    const shouldCountUnread = !popoutOpen && (!visible || activeView !== 'staff');
    if (shouldCountUnread) {
      appState.chatUnreadCount++;
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(message.username, `[Staff] ${preview || '[image]'}`, message.color);
    }
  }

  function addDirectMessage(userId, message) {
    rememberDMUser(userId);
    const threadMessages = messages.dms.get(userId) || [];
    const nextDms = new Map(messages.dms);
    nextDms.set(userId, [...threadMessages, message]);
    messages = {
      ...messages,
      dms: nextDms
    };

    if (!message.fromSelf && !visible && !isChatPopoutOpen()) {
      appState.chatUnreadCount++;
      const user = getChatUser(userId);
      const preview = message.type === 'image' ? `${message.text ? `${message.text} ` : ''}[image]` : message.text;
      showToast(
        user?.username || 'DM',
        `[DM] ${preview || '[image]'}`,
        user?.color || '#8ba3c7',
        { recipientId: userId }
      );
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

  function getRoleClass(userId) {
    const role = getChatUser(userId)?.role ?? 0;
    if (role >= 9) return 'rank-deity';
    if (role === 8) return 'rank-holy';
    if (role === 7) return 'rank-noble';
    if (role >= 5) return 'rank-admin';
    if (role === 4) return 'rank-mod';
    if (role === 3) return 'rank-helper';
    if (role === 2) return 'rank-trusted';
    if (role >= 1) return 'rank-user';
    return 'rank-guest';
  }

  function openUserContextMenu(event, userId) {
    if (isPopout) return;
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

  function isNearBottom(element, threshold = 28) {
    if (!element) return true;
    return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
  }

  function syncPinnedState(view, element) {
    if (!view) return;
    chatPinnedToBottom = {
      ...chatPinnedToBottom,
      [view]: isNearBottom(element)
    };
  }

  function handleMessageScroll(view, event) {
    syncPinnedState(view, event.currentTarget);
  }

  function jumpToPresent() {
    const view = activeView === 'staff' ? 'staff' : activeView === 'dm' ? 'dm' : 'all';
    const element = view === 'dm' ? dmMessagesEl : publicMessagesEl;
    scrollToBottom(element);
    chatPinnedToBottom = {
      ...chatPinnedToBottom,
      [view]: true
    };
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
    requestAnimationFrame(() => {
      applyStoredPositionForMode(mode);
      applyStoredSizeForMode(mode);
    });
  }

  function persistCurrentChatPosition(mode = chatMode) {
    if (!chatEl) return;
    const computed = window.getComputedStyle(chatEl);
    if (computed.left === 'auto' || computed.top === 'auto') return;

    const left = parseFloat(computed.left);
    const top = parseFloat(computed.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;

    const positions = loadChatPositions();
    const existing = positions[mode] || {};
    const clamped = clampChatPosition(left, top);
    positions[mode] = { ...existing, left: clamped.left, top: clamped.top };
    persistChatPositions(positions);
  }

  function startDrag(event) {
    if (isPopout) return;
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
    if ((event.buttons & 1) === 0) {
      endDrag();
      return;
    }

    const nextLeft = Math.max(8, Math.min(window.innerWidth - chatEl.offsetWidth - 8, event.clientX - dragOffsetX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - chatEl.offsetHeight - 8, event.clientY - dragOffsetY));

    setChatPosition(nextLeft, nextTop);
  }

  function endDrag() {
    if (isDragging) persistCurrentChatPosition();
    isDragging = false;
  }

  const MIN_CHAT_WIDTH = 280;
  const MIN_CHAT_HEIGHT = 240;
  let isResizing = $state(false);
  let resizeStart = null;
  let resizeDirection = $state('');

  function applyStoredSizeForMode(mode = chatMode) {
    if (!chatEl) return;
    const positions = loadChatPositions();
    const saved = positions?.[mode];
    if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      chatEl.style.width = `${saved.width}px`;
      chatEl.style.height = `${saved.height}px`;
    } else {
      chatEl.style.width = '';
      chatEl.style.height = '';
    }
  }

  function startResize(event, direction = 'se') {
    if (isPopout || !chatEl || !direction) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = chatEl.getBoundingClientRect();
    setChatPosition(rect.left, rect.top);
    chatEl.style.width = `${rect.width}px`;
    chatEl.style.height = `${rect.height}px`;

    resizeStart = {
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    resizeDirection = direction;
    isResizing = true;
  }

  function onResize(event) {
    if (!isResizing || !chatEl || !resizeStart) return;
    if ((event.buttons & 1) === 0) {
      endResize();
      return;
    }

    const deltaX = event.clientX - resizeStart.x;
    const deltaY = event.clientY - resizeStart.y;
    let nextLeft = resizeStart.left;
    let nextTop = resizeStart.top;
    let nextWidth = resizeStart.width;
    let nextHeight = resizeStart.height;

    if (resizeDirection.includes('e')) {
      const maxWidth = Math.max(MIN_CHAT_WIDTH, window.innerWidth - resizeStart.left - 8);
      nextWidth = Math.max(MIN_CHAT_WIDTH, Math.min(maxWidth, resizeStart.width + deltaX));
    }

    if (resizeDirection.includes('s')) {
      const maxHeight = Math.max(MIN_CHAT_HEIGHT, window.innerHeight - resizeStart.top - 8);
      nextHeight = Math.max(MIN_CHAT_HEIGHT, Math.min(maxHeight, resizeStart.height + deltaY));
    }

    if (resizeDirection.includes('w')) {
      const maxLeft = resizeStart.left + resizeStart.width - MIN_CHAT_WIDTH;
      nextLeft = Math.max(8, Math.min(maxLeft, resizeStart.left + deltaX));
      nextWidth = Math.max(MIN_CHAT_WIDTH, resizeStart.width - (nextLeft - resizeStart.left));
    }

    if (resizeDirection.includes('n')) {
      const maxTop = resizeStart.top + resizeStart.height - MIN_CHAT_HEIGHT;
      nextTop = Math.max(8, Math.min(maxTop, resizeStart.top + deltaY));
      nextHeight = Math.max(MIN_CHAT_HEIGHT, resizeStart.height - (nextTop - resizeStart.top));
    }

    setChatPosition(nextLeft, nextTop);
    chatEl.style.width = `${nextWidth}px`;
    chatEl.style.height = `${nextHeight}px`;
  }

  function endResize() {
    if (!isResizing) return;
    isResizing = false;
    resizeStart = null;
    resizeDirection = '';
    persistCurrentChatSize();
  }

  function persistCurrentChatSize(mode = chatMode) {
    if (!chatEl) return;
    const rect = chatEl.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

    const positions = loadChatPositions();
    const existing = positions[mode] || {};
    positions[mode] = {
      ...existing,
      left: Number.isFinite(existing.left) ? existing.left : rect.left,
      top: Number.isFinite(existing.top) ? existing.top : rect.top,
      width: rect.width,
      height: rect.height
    };
    persistChatPositions(positions);
  }

  function isImageFile(file) {
    return !!file && typeof file.type === 'string' && CHAT_UPLOAD_MIME_TYPES.has(file.type);
  }

  function emojiInsertValue(emoji) {
    return emoji;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read processed image'));
      reader.readAsDataURL(blob);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to process image'));
        }
      }, type, quality);
    });
  }

  async function loadImageForCompression(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file);
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Failed to decode image'));
        image.src = objectUrl;
      });
      return image;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function constrainImageSize(width, height, scale = 1) {
    let nextScale = Math.min(1, scale);
    if (width * nextScale > MAX_CHAT_UPLOAD_DIMENSION) {
      nextScale = Math.min(nextScale, MAX_CHAT_UPLOAD_DIMENSION / width);
    }
    if (height * nextScale > MAX_CHAT_UPLOAD_DIMENSION) {
      nextScale = Math.min(nextScale, MAX_CHAT_UPLOAD_DIMENSION / height);
    }
    const pixels = width * height * nextScale * nextScale;
    if (pixels > MAX_CHAT_UPLOAD_PIXELS) {
      nextScale = Math.min(nextScale, Math.sqrt(MAX_CHAT_UPLOAD_PIXELS / (width * height)));
    }

    return {
      width: Math.max(1, Math.round(width * nextScale)),
      height: Math.max(1, Math.round(height * nextScale))
    };
  }

  async function compressChatImage(file) {
    const source = await loadImageForCompression(file);
    const sourceWidth = source.width || source.naturalWidth || 0;
    const sourceHeight = source.height || source.naturalHeight || 0;

    if (!sourceWidth || !sourceHeight) {
      source.close?.();
      throw new Error('Unable to read image dimensions');
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      source.close?.();
      throw new Error('Failed to prepare image for chat upload.');
    }
    let bestBlob = null;
    const targetTypes = file.type === 'image/png'
      ? ['image/webp', 'image/png', 'image/jpeg']
      : ['image/webp', 'image/jpeg', file.type];
    const scaleSteps = [1, 0.85, 0.7, 0.55, 0.4];
    const qualitySteps = [0.92, 0.84, 0.76, 0.68, 0.6];

    try {
      for (const scaleStep of scaleSteps) {
        const { width, height } = constrainImageSize(sourceWidth, sourceHeight, scaleStep);
        canvas.width = width;
        canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(source, 0, 0, width, height);

        for (const type of targetTypes) {
          const attempts = type === 'image/png' ? [undefined] : qualitySteps;
          for (const quality of attempts) {
            const blob = await canvasToBlob(canvas, type, quality);
            if (!bestBlob || blob.size < bestBlob.size) {
              bestBlob = blob;
            }
            if (blob.size <= MAX_CHAT_UPLOAD_BYTES) {
              return blob;
            }
          }
        }
      }
    } finally {
      source.close?.();
    }

    throw new Error(
      bestBlob
        ? 'Image is still too large for chat after compression. Try a smaller image.'
        : 'Failed to process image for chat upload.'
    );
  }

  async function queueComposerImage(file) {
    if (!isImageFile(file)) {
      showToast('Chat', 'Only PNG, JPEG, WebP, and GIF are supported in chat.', '#ff9b73');
      return;
    }
    try {
      let dataUrl = '';
      if (file.type === 'image/gif') {
        if (file.size > MAX_CHAT_UPLOAD_BYTES) {
          showToast('Chat', 'GIFs must be under 4.5 MB for chat.', '#ff9b73');
          return;
        }
        dataUrl = await readFileAsDataUrl(file);
      } else {
        const processedBlob = await compressChatImage(file);
        dataUrl = await blobToDataUrl(processedBlob);
      }

      composerImage = {
        name: file.name || 'image',
        dataUrl
      };
    } catch (error) {
      showToast('Chat', error?.message || 'Failed to prepare image for chat.', '#ff9b73');
    }
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
    event.stopPropagation();
    isDropTarget = false;
    dropDepth = 0;

    const file = [...(event.dataTransfer?.files || [])].find(isImageFile);
    if (file) await queueComposerImage(file);
  }

  function handleDragEnter(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepth += 1;
    isDropTarget = true;
  }

  function handleDragOver(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    isDropTarget = true;
  }

  function handleDragLeave(event) {
    if (![...(event.dataTransfer?.items || [])].some((item) => item.type?.startsWith('image/'))) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) isDropTarget = false;
  }

  function insertEmoji(emoji) {
    messageInput = `${messageInput}${emojiInsertValue(emoji)}`;
  }

  function openEmojiPicker() {
    showEmojiPicker = !showEmojiPicker;
  }

  function openImageViewer(imageData) {
    expandedImage = imageData || null;
  }

  function closeImageViewer() {
    expandedImage = null;
  }

  function normalizeRecipient(userOrId, fallback = null) {
    const user = typeof userOrId === 'object' && userOrId
      ? userOrId
      : fallback || getChatUser(userOrId) || dmMeta.get(userOrId) || null;
    const userId = user?.id ?? userOrId;
    if (userId === undefined || userId === null) return null;

    return {
      id: userId,
      username: user?.username || user?.name || `User ${userId}`,
      color: colorToCss(user?.color, { opaque: true }),
      role: user?.role || 0,
      visibleIp: user?.visibleIp || ''
    };
  }

  async function openDMThread(userOrId, fallback = null) {
    const nextRecipient = normalizeRecipient(userOrId, fallback);
    if (!nextRecipient) return false;

    rememberDMUser(nextRecipient);
    if (!visible) {
      appState.chatVisible = true;
      await tick();
    }

    appState.dmRecipient = nextRecipient;
    activeView = 'dm';
    appState.chatVisible = true;
    appState.chatUnreadCount = 0;
    toasts = [];
    await tick();

    if (!isPopout && chatEl) scheduleApplyStoredPosition(chatMode);
    if (nextRecipient.id !== undefined && nextRecipient.id !== null) markThreadRead(nextRecipient.id);
    if (chatPinnedToBottom.dm) scrollToBottom(dmMessagesEl);
    composerInputEl?.focus();

    return true;
  }

  export function addChatMessage(username, message, color, userId = null, messageId = createMessageId()) {
    addPublicMessage(createBaseMessage({
      id: messageId,
      type: 'message',
      text: message,
      username,
      color: colorToCss(color, { opaque: true }),
      userId
    }));
  }

  export function addChatImage(imageData, user, messageId = createMessageId()) {
    const username = user?.username || user?.name || 'User';
    const color = colorToCss(user?.color, { opaque: true });
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
    const color = colorToCss(user?.color, { opaque: true });
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

  export function openDM(userId, user = null) {
    void openDMThread(userId, user);
  }

  function serializeMessages() {
    return {
      all: messages.all.map(cloneMessage),
      staff: messages.staff.map(cloneMessage),
      dms: [...messages.dms.entries()].map(([userId, threadMessages]) => [
        userId,
        threadMessages.map(cloneMessage)
      ])
    };
  }

  export function getSnapshot() {
    return {
      messages: serializeMessages(),
      dmMeta: [...dmMeta.entries()].map(([userId, user]) => [userId, { ...user }]),
      activeView,
      recipient: recipient ? { ...recipient } : null,
      chatMode
    };
  }

  export function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    if (snapshot.messages) {
      messages = {
        all: (snapshot.messages.all || []).map(cloneMessage),
        staff: (snapshot.messages.staff || []).map(cloneMessage),
        dms: new Map(
          (snapshot.messages.dms || []).map(([userId, threadMessages]) => [
            userId,
            (threadMessages || []).map(cloneMessage)
          ])
        )
      };
    }

    if (Array.isArray(snapshot.dmMeta)) {
      dmMeta = new Map(snapshot.dmMeta.map(([userId, user]) => [userId, { ...user }]));
    }

    if (typeof snapshot.activeView === 'string') {
      activeView = snapshot.activeView;
    }

    if ('recipient' in snapshot) {
      appState.dmRecipient = snapshot.recipient;
    }

    if (!isPopout && (snapshot.chatMode === 'full' || snapshot.chatMode === 'compact')) {
      chatMode = snapshot.chatMode;
    }
  }

  onMount(() => {
    isDesktopClient = isTauriDesktop();

    if (!isPopout || !isDesktopClient) {
      return;
    }

    let unlistenResize = null;
    let active = true;

    void import('@tauri-apps/api/webviewWindow').then(async ({ getCurrentWebviewWindow }) => {
      if (!active) return;
      desktopWindowApi = getCurrentWebviewWindow();
      await syncDesktopWindowState();
      unlistenResize = await desktopWindowApi.onResized(() => {
        void syncDesktopWindowState();
      });
    });

    return () => {
      active = false;
      desktopWindowApi = null;
      unlistenResize?.();
    };
  });

  $effect(() => {
    messages.all.length;
    if (visible && activeView === 'all' && chatPinnedToBottom.all) scrollToBottom(publicMessagesEl);
  });

  $effect(() => {
    messages.staff.length;
    if (visible && activeView === 'staff' && chatPinnedToBottom.staff) scrollToBottom(publicMessagesEl);
  });

  $effect(() => {
    if (!canAccessStaff && activeView === 'staff') {
      activeView = 'all';
    }
  });

  $effect(() => {
    const recipientId = recipient?.id;
    if (recipientId === undefined || recipientId === null) return;
    if (activeView !== 'dm') activeView = 'dm';
    markThreadRead(recipientId);
  });

  $effect(() => {
    activeView;
    recipient?.id;
    activeDMMessages.length;
    if (visible && activeView === 'dm' && recipient) {
      markThreadRead(recipient.id);
      if (chatPinnedToBottom.dm) scrollToBottom(dmMessagesEl);
    }
  });

  $effect(() => {
    activeView;
    visible;
    if (!visible) return;
    Promise.resolve().then(() => {
      if (activeView === 'dm') syncPinnedState('dm', dmMessagesEl);
      else if (activeView === 'staff') syncPinnedState('staff', publicMessagesEl);
      else if (activeView === 'all') syncPinnedState('all', publicMessagesEl);
    });
  });

  $effect(() => {
    if (visible) appState.chatUnreadCount = 0;
  });

  $effect(() => {
    visible;
    effectiveChatMode;
    chatEl;
    if (!isPopout && visible && chatEl) {
      scheduleApplyStoredPosition(effectiveChatMode);
    }
  });

  $effect(() => {
    if (isPopout || !visible || !chatEl) return;

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
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        endDrag();
      }
    };

    const handleBlurOrHide = () => {
      endDrag();
      endResize();
    };

    const handleDocumentKeydown = (event) => {
      if (event.key !== 'Escape' || (!visible && !isPopout)) return;
      event.preventDefault();
      event.stopPropagation();
      void closeChatWindow();
    };

    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('mousemove', onResize);
    window.addEventListener('mouseup', endResize);
    window.addEventListener('blur', handleBlurOrHide);
    document.addEventListener('keydown', handleDocumentKeydown);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('mousemove', onDrag);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('mousemove', onResize);
      window.removeEventListener('mouseup', endResize);
      window.removeEventListener('blur', handleBlurOrHide);
      document.removeEventListener('keydown', handleDocumentKeydown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });
</script>

{#snippet messageContent(message)}
  {#if message.type === 'system'}
    <p class="message-text">{message.text}</p>
  {:else}
    {@const galleryLinks = extractGalleryLinks(message.text)}
    <div class="message-content-row">
      <div class="message-copy">
        {#if message.type === 'image'}
          <button class="chat-image-card" onclick={() => openImageViewer(message.imageData)} type="button">
            <img src={message.imageData} alt="Chat upload" class="chat-image" />
          </button>
        {/if}
        {#if message.text}
          <p class="message-text">{@html linkify(message.text)}</p>
        {/if}
        {#each galleryLinks as link (link.id)}
          {@const preview = getGalleryPreview(link)}
          {#if preview && !preview.missing}
            <a class="gallery-preview-card" href={preview.url} target="_blank" rel="noopener noreferrer">
              {#if preview.nsfw}
                <span class="gallery-preview-fallback">NSFW</span>
              {:else}
                <img src={preview.thumbUrl} alt={preview.title} class="gallery-preview-image" loading="lazy" />
              {/if}
              <span class="gallery-preview-copy">
                <strong>{preview.title}</strong>
                <span>{preview.author}</span>
              </span>
            </a>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet channelRow(msg)}
  <article class="message-row" class:system={msg.type === 'system'} class:grouped={msg.groupedWithPrevious} class:group-tail={!msg.groupedWithNext}>
    <span class="message-time" title={formatTime(msg.timestamp)}>{msg.groupedWithPrevious ? '' : formatTime(msg.timestamp)}</span>
    <div class="message-body">
      {#if msg.type === 'system'}
        <p class="message-line system"><span class="message-text-inline">{msg.text}</span></p>
      {:else}
        <p class="message-line">{#if !msg.groupedWithPrevious}<button class={`message-user ${getRoleClass(msg.userId)}`} oncontextmenu={(event) => openUserContextMenu(event, msg.userId)} title={msg.userId !== null ? formatModeratorMeta(getChatUser(msg.userId)) : ''} type="button">{msg.username}</button>{' '}{/if}{#if msg.text}<span class="message-text-inline">{@html linkify(msg.text)}</span>{/if}</p>
        {#if msg.text}
          {@const galleryLinks = extractGalleryLinks(msg.text)}
          {#each galleryLinks as link (link.id)}
            {@const preview = getGalleryPreview(link)}
            {#if preview && !preview.missing}
              <a class="gallery-preview-card" href={preview.url} target="_blank" rel="noopener noreferrer">
                {#if preview.nsfw}
                  <span class="gallery-preview-fallback">NSFW</span>
                {:else}
                  <img src={preview.thumbUrl} alt={preview.title} class="gallery-preview-image" loading="lazy" />
                {/if}
                <span class="gallery-preview-copy">
                  <strong>{preview.title}</strong>
                  <span>{preview.author}</span>
                </span>
              </a>
            {/if}
          {/each}
        {/if}
        {#if msg.type === 'image' && msg.imageData}
          <button class="chat-image-card" onclick={() => openImageViewer(msg.imageData)} type="button">
            <img src={msg.imageData} alt="Chat upload" class="chat-image" />
          </button>
        {/if}
      {/if}
    </div>
  </article>
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

{#if expandedImage}
  <button class="chat-image-viewer" onclick={closeImageViewer} type="button" aria-label="Close image viewer">
    <div class="chat-image-viewer-frame">
      <img src={expandedImage} alt="Expanded chat upload" class="chat-image-viewer-image" />
    </div>
  </button>
{/if}

{#if visible}
  <section class="chat-shell" class:dragging={isDragging} class:resizing={isResizing} class:popout={isPopout} class:desktop-popout={isPopout && isDesktopClient} bind:this={chatEl} onclick={handleChatLinkClick}>
    <WindowTitleBar
      title="Chat"
      subtitle=""
      branded={true}
      draggable={!isPopout}
      tauriDragRegion={isPopout && isDesktopClient}
      onDragStart={startDrag}
      showPopoutButton={!isPopout && isDesktopClient}
      onPopout={popoutChat}
      showModeToggle={false}
      mode={effectiveChatMode}
      onModeToggle={toggleMode}
      showWindowControls={isPopout && isDesktopClient}
      showCloseButton={!isPopout}
      onClose={!isPopout ? hide : null}
      className="chat-titlebar"
    />

    <header class="chat-topbar" data-refactor-placeholder="true" style="display: none;" onmousedown={startDrag} role="presentation" aria-label="Chat window header" data-tauri-drag-region={isPopout && isDesktopClient ? 'true' : undefined}>
      <div class="chat-topbar-copy">
        {#if isPopout && isDesktopClient}
          <div class="chat-wordmark-wrap" data-tauri-drag-region="true">
            <div class="chat-wordmark-copy" data-tauri-drag-region="true">
              <p class="chat-kicker">DDraw!</p>
              <span>{activeHeaderTitle()}{#if activeHeaderSubtitle()} • {activeHeaderSubtitle()}{/if}</span>
            </div>
          </div>
        {:else}
          <p class="chat-kicker">{activeHeaderTitle()}</p>
          {#if activeHeaderSubtitle()}
            <span>{activeHeaderSubtitle()}</span>
          {/if}
        {/if}
      </div>

      <div class="chat-topbar-actions">
        {#if !isPopout && isDesktopClient}
          <button class="topbar-btn" onclick={popoutChat} title="Open chat in a separate window" type="button">
            Pop Out
          </button>
        {/if}
        {#if isPopout && isDesktopClient}
          <button class="topbar-btn chrome-btn" onclick={minimizeDesktopWindow} title="Minimize chat" type="button">_</button>
          <button class="topbar-btn chrome-btn" onclick={toggleMaximizeDesktopWindow} title={desktopWindowState.maximized ? 'Restore window' : 'Maximize window'} type="button">
            {desktopWindowState.maximized ? '❐' : '□'}
          </button>
          <button class="topbar-btn chrome-btn" onclick={toggleFullscreenDesktopWindow} title={desktopWindowState.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} type="button">
            {desktopWindowState.fullscreen ? '🡼' : '⛶'}
          </button>
        {/if}
        {#if !isPopout}
          <button class="topbar-btn" onclick={toggleMode} title={effectiveChatMode === 'full' ? 'Use compact mode' : 'Use full mode'} type="button">
            {effectiveChatMode === 'full' ? 'Small' : 'Full'}
          </button>
        {/if}
        <button class="topbar-btn close" onclick={hide} title="Close chat" type="button">X</button>
      </div>
    </header>

    <div class="chat-content">
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
            <button class="rail-tab thread-tab" class:active={activeView === 'dm' && Number(recipient?.id) === Number(thread.id)} onclick={() => openThreadById(thread.id)} title={thread.user?.username || 'Direct message'} type="button">
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
        <div class="chat-stage" class:drop-target={isDropTarget} ondragenter={handleDragEnter} ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop} role="region" aria-label="Chat messages">
          {#if (activeView === 'all' && !chatPinnedToBottom.all) || (activeView === 'staff' && !chatPinnedToBottom.staff) || (activeView === 'dm' && !chatPinnedToBottom.dm)}
            <button class="return-to-present" onclick={jumpToPresent} type="button">
              Return to present
            </button>
          {/if}
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
            <div class="message-stream dm-stream" bind:this={dmMessagesEl} onscroll={(event) => handleMessageScroll('dm', event)}>
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
            <div class="message-stream" bind:this={publicMessagesEl} onscroll={(event) => handleMessageScroll('staff', event)}>
              {#if messages.staff.length === 0}
                <div class="message-empty">Staff chat is empty.</div>
              {:else}
                {#each groupedStaffMessages as msg (msg.id)}
                  {@render channelRow(msg)}
                {/each}
              {/if}
            </div>
          </section>
        {:else}
          <section class="conversation-view">
            <div class="message-stream" bind:this={publicMessagesEl} onscroll={(event) => handleMessageScroll('all', event)}>
              {#if messages.all.length === 0}
                <div class="message-empty"></div>
              {:else}
                {#each groupedPublicMessages as msg (msg.id)}
                  {@render channelRow(msg)}
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
            <div class="emoji-picker-section">
              <span class="reaction-picker-label">Emojis</span>
              <div class="reaction-picker-grid composer-emoji-grid">
                {#each rankedComposerEmojis() as emoji (emoji)}
                  <button class="emoji-btn" onclick={() => insertEmoji(emoji)} type="button">
                    {emoji}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {/if}

      <div class="composer-row">
        <input class="composer-file-input" bind:this={fileInputEl} onchange={handleFileInputChange} accept="image/*" type="file" />
        <button class="composer-tool upload-tool" onclick={openFilePicker} disabled={activeView === 'directory'} title="Upload image" type="button">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M1 1H15V15H1V1ZM6 9L8 11L13 6V13H3V12L6 9ZM6.5 7C7.32843 7 8 6.32843 8 5.5C8 4.67157 7.32843 4 6.5 4C5.67157 4 5 4.67157 5 5.5C5 6.32843 5.67157 7 6.5 7Z" fill="currentColor"/></svg>
        </button>
        <button class="composer-tool emoji-tool" onclick={openEmojiPicker} disabled={activeView === 'directory'} title="Add emoji" type="button">{COMPOSER_EMOJIS[0]}</button>
        <div class="chat-input-wrap">
          <textarea class="chat-input" bind:this={composerInputEl} bind:value={messageInput} onkeydown={handleKeydown} placeholder={activeView === 'all' ? 'Message the room...' : activeView === 'staff' ? 'Message staff...' : activeView === 'dm' && recipient ? `Message ${recipient.username}...` : 'Select someone to start a DM...'} rows="1" disabled={activeView === 'directory'}></textarea>
        </div>
        <button class="chat-send" onclick={handleSend} disabled={activeView === 'directory'} type="button">Send</button>
      </div>
        </footer>
    </div>
    {#if !isPopout}
      <div class="chat-resize-handle edge-n" onmousedown={(event) => startResize(event, 'n')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle edge-e" onmousedown={(event) => startResize(event, 'e')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle edge-s" onmousedown={(event) => startResize(event, 's')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle edge-w" onmousedown={(event) => startResize(event, 'w')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-ne" onmousedown={(event) => startResize(event, 'ne')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-nw" onmousedown={(event) => startResize(event, 'nw')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-se" onmousedown={(event) => startResize(event, 'se')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-handle corner-sw" onmousedown={(event) => startResize(event, 'sw')} role="presentation" aria-hidden="true"></div>
      <div class="chat-resize-grip" class:active={isResizing} onmousedown={(event) => startResize(event, 'se')} role="presentation" aria-hidden="true" title="Drag to resize">
        <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
          <path d="M13 3L3 13 M13 7L7 13 M13 11L11 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </div>
    {/if}
  </section>
{/if}

<style>
  .chat-shell {
    --chat-bg: color-mix(in srgb, var(--bg-secondary) 94%, black);
    --chat-border: var(--border-subtle);
    --chat-text: var(--text-primary);
    --chat-muted: var(--text-secondary);
    --chat-accent: var(--accent-primary);
    --chat-shadow: var(--shadow-lg);
    --chat-opacity-raw: var(--chat-opacity, 1);
    --chat-surface-idle: 0.64;
    --chat-surface-active: 1;
    --chat-message-idle: 0.74;
    --chat-message-active: 0.96;
    position: fixed;
    right: 18px;
    bottom: 22px;
    z-index: 1200;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: min(420px, calc(100vw - 24px));
    height: min(560px, calc(100vh - 110px));
    min-width: 280px;
    min-height: 240px;
    color: var(--chat-text);
    background: transparent;
    border: 0;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--chat-shadow);
    font-family: 'Inter', sans-serif;
    isolation: isolate;
  }

  .chat-shell::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--chat-bg);
    border: 1px solid var(--chat-border);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    opacity: var(--chat-opacity-raw);
    pointer-events: none;
  }

  .chat-shell :global(.chat-titlebar) {
    background: color-mix(in srgb, black 15%, transparent);
  }

  .chat-shell :global(.chat-titlebar *),
  .rail-tab *,
  .rail-action *,
  .topbar-btn *,
  .directory-user *,
  .composer-tool *,
  .composer-preview-remove *,
  .emoji-picker .emoji-btn *,
  .chat-send * {
    opacity: 1;
  }

  .chat-shell.popout :global(.chat-titlebar) {
    background: color-mix(in srgb, var(--bg-elevated) 56%, #1a1f29);
  }

  .chat-resize-handle {
    position: absolute;
    z-index: 16;
  }

  .chat-resize-handle.edge-n,
  .chat-resize-handle.edge-s {
    left: 12px;
    right: 12px;
    height: 10px;
  }

  .chat-resize-handle.edge-e,
  .chat-resize-handle.edge-w {
    top: 12px;
    bottom: 12px;
    width: 10px;
  }

  .chat-resize-handle.edge-n {
    top: 0;
    cursor: ns-resize;
  }

  .chat-resize-handle.edge-e {
    right: 0;
    cursor: ew-resize;
  }

  .chat-resize-handle.edge-s {
    bottom: 0;
    cursor: ns-resize;
  }

  .chat-resize-handle.edge-w {
    left: 0;
    cursor: ew-resize;
  }

  .chat-resize-handle.corner-ne,
  .chat-resize-handle.corner-nw,
  .chat-resize-handle.corner-se,
  .chat-resize-handle.corner-sw {
    width: 16px;
    height: 16px;
  }

  .chat-resize-handle.corner-ne {
    top: 0;
    right: 0;
    cursor: nesw-resize;
  }

  .chat-resize-handle.corner-nw {
    top: 0;
    left: 0;
    cursor: nwse-resize;
  }

  .chat-resize-handle.corner-se {
    right: 0;
    bottom: 0;
    cursor: nwse-resize;
  }

  .chat-resize-handle.corner-sw {
    left: 0;
    bottom: 0;
    cursor: nesw-resize;
  }

  .chat-resize-grip {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    color: color-mix(in srgb, var(--text-secondary) 55%, transparent);
    cursor: nwse-resize;
    z-index: 20;
    border-radius: 0 0 10px 0;
    transition: color 0.15s ease, background 0.15s ease;
    user-select: none;
    -webkit-user-select: none;
  }

  .chat-resize-grip:hover,
  .chat-resize-grip.active {
    color: var(--accent-primary);
    background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  }

  .chat-shell.popout .chat-resize-grip {
    display: none;
  }

  .chat-shell.popout .chat-resize-handle {
    display: none;
  }

  .chat-shell.dragging .chat-resize-grip {
    pointer-events: none;
  }

  .chat-shell.popout,
  .chat-shell.popout.full,
  .chat-shell.popout.compact {
    inset: 0;
    width: 100vw;
    height: 100vh;
    min-width: 100vw;
    min-height: 100vh;
    border-radius: 0;
    border: 0;
    box-shadow: none;
    backdrop-filter: none;
  }

  .chat-shell.popout::before {
    opacity: 1;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border: 0;
    box-shadow: none;
    border-radius: 0;
    background: color-mix(in srgb, var(--bg-secondary) 95%, black);
  }

  .chat-shell.full {
    width: min(880px, calc(100vw - 44px));
    height: min(612px, calc(100vh - 56px));
  }

  .chat-shell.compact {
    width: min(420px, calc(100vw - 24px));
  }

  .chat-content {
    display: grid;
    grid-template-columns: 90px minmax(0, 1fr);
    min-height: 0;
    overflow: hidden;
  }

  .chat-shell.popout .chat-content {
    height: 100%;
  }

  .chat-shell.compact .chat-content {
    grid-template-columns: 92px minmax(0, 1fr);
  }

  .chat-shell.compact .chat-main {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    z-index: 3;
  }

  .chat-rail {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    padding: 14px 12px;
    background: color-mix(in srgb, black 12%, transparent);
    border-right: 1px solid var(--border-subtle);
    position: relative;
    z-index: 1;
  }

  .chat-shell.compact .chat-rail {
    padding-bottom: 112px;
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
    justify-content: center;
    text-align: left;
    min-height: 46px;
    width: calc(100% + 24px);
    margin-left: -12px;
    padding-top: 0.7rem;
    padding-bottom: 0.7rem;
    padding-left: 12px;
    padding-right: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 42%, transparent);
    color: var(--chat-muted);
    border-radius: 0;
  }

  .rail-action:hover,
  .rail-action.active {
    background: color-mix(in srgb, var(--accent-primary) 16%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .public-tab,
  .rail-action,
  .rail-tab.public-tab.active,
  .rail-tab.public-tab:hover,
  .rail-action.active,
  .rail-action:hover {
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
    background: color-mix(in srgb, var(--avatar-color) 82%, black 18%);
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
    font-weight: 600;
  }

  .rail-action span:first-child {
    font-size: 1rem;
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
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    background: transparent;
  }

  .chat-shell.popout .chat-main,
  .chat-shell.popout .chat-stage,
  .chat-shell.popout .conversation-view,
  .chat-shell.popout .directory-view {
    height: 100%;
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

  .chat-shell.popout .chat-topbar {
    border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    border-radius: 0;
  }

  .chat-topbar-copy {
    min-width: 0;
  }

  .chat-wordmark-wrap {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .chat-wordmark-copy {
    min-width: 0;
  }

  .chat-wordmark-copy .chat-kicker {
    margin: 0;
    font-family: 'Fredoka', sans-serif;
    font-size: 1.35rem;
    font-weight: 700;
    color: #00d4aa;
    transform: rotate(-2deg);
    transform-origin: left center;
    letter-spacing: 0.01em;
  }

  .chat-wordmark-copy span {
    display: block;
    margin-top: 0.18rem;
    color: var(--chat-muted);
    font-size: 0.76rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-kicker {
    margin: 0.5rem 0 0.25rem;
    color: color-mix(in srgb, var(--accent-primary) 58%, var(--text-primary));
    font-size: 0.72rem;
    font-weight: 500;
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
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .topbar-btn:hover {
    background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .topbar-btn.close {
    width: 36px;
    padding: 0;
  }

  .chrome-btn {
    width: 36px;
    padding: 0;
    font-size: 0.95rem;
  }

  .topbar-btn.close:hover {
    background: color-mix(in srgb, #ff6b6b 22%, var(--bg-elevated));
    color: white;
  }

  .chat-stage {
    position: relative;
    min-height: 0;
    overflow: hidden;
    transition: background 0.18s ease;
  }

  .chat-stage:hover,
  .chat-stage:focus-within,
  .chat-shell.dragging .chat-stage,
  .chat-shell.resizing .chat-stage {
    background: transparent;
  }

  .chat-stage :global(.message-row),
  .chat-stage :global(.message-body),
  .chat-stage :global(.message-line),
  .chat-stage :global(.message-text),
  .chat-stage :global(.message-text-inline),
  .chat-stage :global(.message-user),
  .chat-stage :global(.message-time),
  .chat-stage :global(.dm-bubble),
  .chat-stage :global(.dm-bubble span),
  .chat-stage :global(.message-empty),
  .chat-stage :global(.directory-empty) {
    opacity: 1;
  }

  .chat-stage.drop-target {
    background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
  }

  .chat-stage.drop-target::after {
    content: '';
    position: absolute;
    inset: 8px;
    border: 2px solid color-mix(in srgb, var(--accent-primary) 70%, white 10%);
    border-radius: 18px;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-primary) 24%, transparent);
    pointer-events: none;
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

  .return-to-present {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 8;
    min-height: 34px;
    padding: 0 0.9rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 82%, black 18%);
    color: #fff;
    font-size: 0.78rem;
    font-weight: 800;
    box-shadow: 0 10px 24px color-mix(in srgb, var(--accent-primary) 28%, transparent);
  }

  .conversation-view,
  .directory-view {
    display: grid;
    height: 100%;
    min-height: 0;
    background: color-mix(in srgb, var(--bg-elevated) 6%, transparent);
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
    overflow-x: hidden;
    padding: 0.8rem 1.15rem 0.9rem;
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
    grid-template-columns: 46px minmax(0, 1fr);
    gap: 0.55rem;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    padding: 0.1rem 0;
    border-bottom: 0;
    align-items: baseline;
  }

  .message-row.system {
    grid-template-columns: 46px minmax(0, 1fr);
  }

  .message-row.grouped {
    padding-top: 0;
    padding-bottom: 0;
  }

  .message-row.group-tail:not(.grouped) {
    margin-bottom: 0.18rem;
  }

  .message-row + .message-row:not(.grouped) {
    margin-top: 0.14rem;
  }

  .message-time {
    color: color-mix(in srgb, var(--text-secondary) 46%, transparent);
    font-size: 0.66rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    white-space: nowrap;
    text-align: right;
    padding-right: 0.1rem;
    user-select: none;
  }

  .message-row.grouped .message-time {
    opacity: 0;
    pointer-events: none;
  }

  .message-body {
    position: relative;
    min-width: 0;
    max-width: 100%;
  }

  .message-line {
    display: block;
    margin: 0;
    color: var(--text-primary);
    font-size: 0.9rem;
    line-height: 1.32;
    word-break: break-word;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }

  .message-line.system {
    color: color-mix(in srgb, var(--text-secondary) 72%, transparent);
    font-style: italic;
    font-size: 0.82rem;
  }

  .message-text-inline {
    display: inline;
  }

  .message-text-inline :global(a) {
    user-select: text;
    -webkit-user-select: text;
  }

  :global(.chat-inline-emoji) {
    display: inline-block;
    font-size: 1.35em;
    line-height: 1;
    vertical-align: -0.08em;
  }

  :global(.chat-inline-emoji-image) {
    width: 1.35em;
    height: 1.35em;
    object-fit: contain;
  }

  .message-content-row {
    display: block;
    min-width: 0;
    max-width: 100%;
  }

  .message-copy {
    flex: 0 1 auto;
    min-width: 0;
    max-width: min(100%, 36rem);
    user-select: text;
    -webkit-user-select: text;
  }

  .message-user {
    display: inline;
    padding: 0;
    margin: 0;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    font-weight: 700;
    border: 0;
    box-shadow: none;
    cursor: context-menu;
    line-height: inherit;
    text-align: left;
    vertical-align: baseline;
  }

  .message-user::after {
    content: '';
    display: inline;
    width: 0;
  }

  .message-line .message-user + .message-text-inline::before {
    content: ' · ';
    color: color-mix(in srgb, var(--text-secondary) 35%, transparent);
    margin: 0 0.08rem 0 0.12rem;
    font-weight: 500;
  }

  .message-user.rank-guest {
    color: var(--role-guest);
  }

  .message-user.rank-user {
    color: var(--role-user);
  }

  .message-user.rank-trusted {
    color: var(--role-trusted);
  }

  .message-user.rank-helper {
    color: var(--role-helper);
  }

  .message-user.rank-mod {
    color: var(--role-mod);
  }

  .message-user.rank-admin {
    color: var(--role-admin);
  }

  .message-user.rank-noble {
    color: var(--role-noble);
    text-shadow: 0 0 6px color-mix(in srgb, var(--role-noble), transparent 65%);
  }

  .message-user.rank-holy {
    color: var(--role-holy);
    text-shadow: 0 0 7px color-mix(in srgb, var(--role-holy), transparent 62%);
  }

  .message-user.rank-deity {
    color: var(--role-deity);
    text-shadow: 0 0 7px color-mix(in srgb, var(--role-deity), transparent 58%);
  }

  .thread-tab {
    justify-content: center;
    text-align: center;
    min-height: 46px;
    width: 100%;
    margin-left: 0;
    padding-left: 0.75rem;
    padding-right: 0.75rem;
    border-radius: 16px;
  }

  .thread-tab .rail-tab-name {
    width: 100%;
    font-size: 0.86rem;
    font-weight: 600;
    text-align: center;
  }

  .message-text {
    margin: 0 0 0;
    color: var(--text-primary);
    font-size: 0.9rem;
    line-height: 1.32;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }

  .message-row.grouped .message-text,
  .message-row.grouped .message-line {
    margin-top: 0;
  }

  .chat-image-card {
    display: block;
    max-width: min(100%, 360px);
    margin: 0.18rem 0 0;
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

  .gallery-preview-card {
    display: grid;
    grid-template-columns: 82px minmax(0, 1fr);
    align-items: center;
    width: min(100%, 340px);
    min-height: 68px;
    margin: 0.4rem 0 0;
    overflow: hidden;
    color: var(--chat-text);
    text-decoration: none;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 7%, transparent);
  }

  .gallery-preview-card:hover {
    border-color: color-mix(in srgb, var(--accent-primary) 44%, var(--border-subtle));
    background: color-mix(in srgb, var(--bg-elevated) 86%, transparent);
  }

  .gallery-preview-image,
  .gallery-preview-fallback {
    width: 82px;
    height: 68px;
  }

  .gallery-preview-image {
    display: block;
    object-fit: cover;
    background: color-mix(in srgb, var(--bg-secondary) 80%, black);
  }

  .gallery-preview-fallback {
    display: grid;
    place-items: center;
    color: var(--chat-muted);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    background: color-mix(in srgb, var(--bg-secondary) 78%, black);
  }

  .gallery-preview-copy {
    display: grid;
    gap: 0.18rem;
    min-width: 0;
    padding: 0.55rem 0.65rem;
  }

  .gallery-preview-copy strong,
  .gallery-preview-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gallery-preview-copy strong {
    color: var(--chat-text);
    font-size: 0.84rem;
    line-height: 1.2;
  }

  .gallery-preview-copy span {
    color: var(--chat-muted);
    font-size: 0.74rem;
  }


  .emoji-picker {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    padding: 0.6rem;
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    border-radius: 16px;
    background: color-mix(in srgb, var(--bg-elevated) 86%, black 6%);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
  }

  .emoji-picker-section {
    display: flex;
    flex-direction: column;
    gap: 0.24rem;
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
    gap: 0.3rem;
    padding-left: 0.1rem;
  }

  .composer-emoji-grid {
    max-height: 164px;
    overflow-y: auto;
    padding-top: 0.1rem;
    padding-right: 0.1rem;
  }

  .emoji-picker .emoji-btn {
    display: grid;
    place-items: center;
    min-width: 32px;
    min-height: 32px;
    padding: 0;
    border-radius: 12px;
    font-size: 1.08rem;
    line-height: 1;
    background: color-mix(in srgb, var(--bg-secondary) 64%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 74%, transparent);
  }

  .dm-stream {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .dm-bubble-row {
    display: flex;
  }

  .dm-bubble-row.self {
    justify-content: flex-end;
  }

  .dm-bubble {
    position: relative;
    max-width: min(78%, 540px);
    padding: 0.62rem 0.78rem 0.58rem;
    border-radius: 18px 18px 18px 6px;
    background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--border-subtle) 85%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 8%, transparent);
    user-select: text;
    -webkit-user-select: text;
  }

  .dm-bubble-row.self .dm-bubble {
    border-radius: 18px 18px 6px 18px;
    background: color-mix(in srgb, var(--accent-primary) 22%, var(--bg-elevated));
    color: var(--chat-text);
  }

  .dm-bubble :global(.message-text) {
    color: inherit;
  }

  .dm-bubble :global(.message-text),
  .dm-bubble :global(.message-row.grouped .message-text) {
    line-height: 1.14;
  }

  .message-row.grouped {
    padding-top: 0;
    padding-bottom: 0;
  }

  .message-row.grouped .message-body {
    padding-top: 0;
    padding-bottom: 0;
  }

  .message-row.grouped .reaction-row {
    margin-top: 0.12rem;
  }

  .dm-bubble span {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.7rem;
    color: color-mix(in srgb, var(--text-secondary) 68%, transparent);
    white-space: nowrap;
  }

  .dm-bubble :global(a),
  .message-copy :global(a) {
    user-select: text;
    -webkit-user-select: text;
  }

  .dm-bubble-row.self .dm-bubble span {
    color: color-mix(in srgb, var(--text-secondary) 68%, transparent);
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
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
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
    background: color-mix(in srgb, black 10%, transparent);
    flex-shrink: 0;
  }

  .chat-shell.compact .chat-composer {
    width: calc(100% + 92px);
    margin-left: -92px;
    padding: 0.8rem 0.85rem 0.9rem;
    background: color-mix(in srgb, var(--bg-secondary) 88%, black 6%);
    box-sizing: border-box;
    min-width: 0;
    max-width: none;
    overflow: hidden;
  }

  .composer-row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 0.6rem;
    align-items: end;
  }

  .chat-shell.compact .composer-row {
    grid-template-columns: 36px minmax(0, 1fr) auto;
    grid-template-rows: 1fr 1fr;
    column-gap: 0.45rem;
    row-gap: 0.3rem;
    align-items: stretch;
  }

  .composer-file-input {
    display: none;
  }

  .composer-tool {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 82%, transparent);
    color: var(--chat-text);
    font-size: 1rem;
    font-weight: 800;
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .chat-shell.compact .composer-tool {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    font-size: 0.92rem;
  }

  .chat-shell.compact .upload-tool {
    grid-column: 1;
    grid-row: 1;
  }

  .chat-shell.compact .emoji-tool {
    grid-column: 1;
    grid-row: 2;
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
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .emoji-picker {
    padding: 0.3rem 0 0;
  }

  .chat-shell.compact .emoji-picker {
    gap: 0.26rem;
    padding: 0.28rem 0.32rem 0.08rem 0.4rem;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .chat-shell.compact .emoji-picker-section {
    gap: 0.16rem;
    min-width: 0;
    max-width: 100%;
  }

  .chat-shell.compact .reaction-picker-label {
    font-size: 0.58rem;
    letter-spacing: 0.06em;
  }

  .chat-shell.compact .reaction-picker-grid {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 28px;
    grid-template-rows: repeat(2, 28px);
    gap: 0.18rem;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow-x: auto;
    overflow-y: hidden;
    align-content: start;
    padding: 0.02rem 0 0.24rem;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--accent-primary) 42%, transparent) transparent;
  }

  .chat-shell.compact .emoji-picker .emoji-btn {
    width: 28px;
    min-width: 28px;
    height: 28px;
    min-height: 28px;
    border-radius: 8px;
    font-size: 0.96rem;
  }

  .chat-shell.compact .reaction-picker-grid::-webkit-scrollbar {
    height: 8px;
  }

  .chat-shell.compact .reaction-picker-grid::-webkit-scrollbar-track {
    background: color-mix(in srgb, var(--bg-elevated) 42%, transparent);
    border-radius: 999px;
  }

  .chat-shell.compact .reaction-picker-grid::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--accent-primary) 44%, var(--bg-elevated));
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--bg-secondary) 70%, transparent);
  }

  .chat-shell.compact .reaction-picker-grid::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--accent-primary) 58%, var(--bg-elevated));
  }

  .emoji-picker .emoji-btn {
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .emoji-btn {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
    font-size: 1rem;
  }

  .chat-input-wrap {
    position: relative;
    min-width: 0;
  }

  .chat-input {
    min-height: 46px;
    max-height: 120px;
    padding: 0.8rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 14px;
    width: 100%;
    background: color-mix(in srgb, var(--bg-primary) 70%, transparent);
    color: var(--chat-text);
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.35;
    box-sizing: border-box;
    resize: none;
    outline: none;
  }

  .chat-shell.compact .chat-input {
    grid-column: 2;
    grid-row: 1 / span 2;
    min-height: 78px;
    padding: 0.7rem 0.85rem;
  }


  .chat-shell.compact .chat-input-wrap {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .chat-shell.compact .chat-input {
    min-height: 78px;
    padding: 0.7rem 0.85rem;
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
    transition: background 0.18s ease, color 0.18s ease, transform 0.18s ease;
  }

  .chat-shell.compact .chat-send {
    grid-column: 3;
    grid-row: 1 / span 2;
    min-width: 88px;
    min-height: 78px;
    padding: 0 1.15rem;
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
    position: absolute;
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

  .chat-image-viewer {
    position: fixed;
    inset: 0;
    z-index: 1400;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.72);
    border: 0;
    cursor: zoom-out;
  }

  .chat-image-viewer-frame {
    max-width: min(92vw, 1200px);
    max-height: min(88vh, 900px);
    padding: 10px;
    border-radius: 18px;
    background: color-mix(in srgb, var(--bg-secondary) 92%, black);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
  }

  .chat-image-viewer-image {
    display: block;
    max-width: min(88vw, 1120px);
    max-height: min(84vh, 820px);
    border-radius: 12px;
    object-fit: contain;
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
    .chat-toasts {
      right: 12px;
      bottom: 12px;
    }

    .chat-shell.full,
    .chat-shell.compact {
      right: 12px;
      bottom: 12px;
      width: calc(100vw - 24px);
      height: min(76vh, 620px);
    }
  }

  @media (max-width: 640px) {
    .chat-toasts {
      right: 8px;
      bottom: 8px;
      left: 8px;
      align-items: stretch;
    }

    .chat-toast {
      min-width: 0;
      max-width: none;
    }

    .chat-shell,
    .chat-shell.full,
    .chat-shell.compact {
      right: 8px;
      bottom: 8px;
      width: calc(100vw - 16px);
      height: calc(100vh - 90px);
      border-radius: 18px;
    }

    .chat-content,
    .chat-shell.compact .chat-content {
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

    .message-content-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.28rem;
    }

    .reaction-row,
    .reaction-pills,
    .reaction-actions {
      align-items: flex-start;
      justify-content: flex-start;
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
