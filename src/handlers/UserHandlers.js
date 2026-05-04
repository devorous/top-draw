/** @fileoverview Handles user-related events including lifecycle, AFK status, and cursor visibility. */

import { User } from '../User.js';
import { appState } from '../state.svelte.js';
import { BOARD_SIZE_PRESETS, applyRoomBoardSize } from '../config/BoardSizes.js';

const ROLE_NAMES = ['Guest', 'User', 'Trusted', 'Helper', 'Mod', 'Admin', 'Owner', 'Noble', 'Holy', 'Deity'];
const JOIN_ANNOUNCE_DELAY_MS = 700;

const JOIN_ANNOUNCE_RETRY_MS = 500;
const JOIN_ANNOUNCE_TIMEOUT_MS = 15000;

function getRoleName(role) {
  return ROLE_NAMES[role] || 'Guest';
}

function formatPresenceName(user) {
  const visibleUsername = String(user?.username || '').trim() || 'User';
  const registeredUsername = String(user?.registeredName || '').trim();
  if (registeredUsername && registeredUsername !== visibleUsername) {
    return `${visibleUsername} (${registeredUsername})`;
  }
  return visibleUsername;
}

function formatRoomPresenceMessage(user, verb) {
  return `${getRoleName(user?.role ?? 0)} ${formatPresenceName(user)} ${verb}`;
}

function formatJoinPresenceMessage(user) {
  return formatRoomPresenceMessage(user, 'has joined');
}

function clearRemoteTextDraft(app, user) {
  if (!user) return;
  if (user.context) {
    user.context.clearRect(0, 0, app.board.getWidth(), app.board.getHeight());
  }
  app.ui.setRemoteTextDomVisible(user.id, true);
  app.ui.updateRemoteText(user.id, '');
}

/**
 * Sets up WebSocket event handlers for user-related actions and state changes.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupUserHandlers(wsClient, app) {
  const { users, ui, board } = app;
  let hasProcessedInitialUsers = false;
  let knownRemoteSessionIds = new Set();
  const pendingJoinAnnouncements = new Map();
  const announcedJoinSessionIds = new Set();
  const vacatedSlots = new Map();

  const cancelPendingJoinAnnouncement = (sessionIndex) => {
    const pending = pendingJoinAnnouncements.get(sessionIndex);
    if (pending?.timerId) {
      clearTimeout(pending.timerId);
    }
    pendingJoinAnnouncements.delete(sessionIndex);
  };

  const clearJoinTracking = (sessionIndex) => {
    cancelPendingJoinAnnouncement(sessionIndex);
    announcedJoinSessionIds.delete(sessionIndex);
  };

  const isSelfImmuneToInactiveResync = (role = app.self?.role ?? app.selfRole ?? 0) => {
    const numericRole = Number(role) || 0;
    return numericRole >= 5 || (!!app.currentRoomData?.modInactiveImmune && numericRole >= 4);
  };

  const applySelfInactiveState = (afk = app.self?.afk, role = app.self?.role ?? app.selfRole ?? 0) => {
    app.syncClient?.setInactive(!!afk && !isSelfImmuneToInactiveResync(role));
  };

  const announceJoinIfReady = (sessionIndex) => {
    if (announcedJoinSessionIds.has(sessionIndex)) return true;

    const user = users.get(sessionIndex);
    if (!user?.username || !app.svelteComponents?.chat) return false;

    cancelPendingJoinAnnouncement(sessionIndex);
    announcedJoinSessionIds.add(sessionIndex);
    app.svelteComponents.chat.addSystemMessage(formatJoinPresenceMessage(user));
    return true;
  };

  const scheduleJoinAnnouncement = (sessionIndex, delayMs = JOIN_ANNOUNCE_DELAY_MS) => {
    if (announcedJoinSessionIds.has(sessionIndex)) return;
    if (announceJoinIfReady(sessionIndex)) return;

    const existing = pendingJoinAnnouncements.get(sessionIndex);
    if (existing?.timerId) return;

    const queuedAt = existing?.queuedAt ?? Date.now();
    const timerId = setTimeout(() => {
      const pending = pendingJoinAnnouncements.get(sessionIndex);
      if (pending) pending.timerId = null;

      if (announceJoinIfReady(sessionIndex)) return;

      const shouldRetry = users.has(sessionIndex) && Date.now() - queuedAt < JOIN_ANNOUNCE_TIMEOUT_MS;
      if (shouldRetry) {
        scheduleJoinAnnouncement(sessionIndex, JOIN_ANNOUNCE_RETRY_MS);
      }
    }, delayMs);

    pendingJoinAnnouncements.set(sessionIndex, { queuedAt, timerId });
  };

  const abortSyncIfRoomIsEmpty = () => {
    if (!app.syncClient?.isSyncing()) return;

    const hasOtherUsers = [...users.keys()].some((sessionIndex) => sessionIndex !== app.sessionIndex);
    if (!hasOtherUsers) {
      app.syncClient.abortSync('Sync stopped - no other users remain in the room');
      app.updateRecordingButtonState?.();
    }
  };

  wsClient.on('users', (data) => {
    const incomingRemoteSessionIds = new Set(
      data.users
        .map((u) => Number(u.sessionIndex))
        .filter((sessionIndex) => Number.isFinite(sessionIndex) && sessionIndex !== Number(app.sessionIndex))
    );
    const joinedSessionIds = [...incomingRemoteSessionIds].filter((sessionIndex) => !knownRemoteSessionIds.has(sessionIndex));

    // Authoritative Removal: Find users we have locally who are NOT in the new list
    const remoteIndices = new Set(data.users.map(u => u.sessionIndex));
    users.forEach((user, sessionIndex) => {
      if (sessionIndex !== app.sessionIndex && !remoteIndices.has(sessionIndex)) {
        console.log(`[USERS] Removing ghost user ${user.username}(${sessionIndex})`);
        clearJoinTracking(sessionIndex);
        app.cleanupRemoteUserState(sessionIndex, { preserveVisuals: true });
      }
    });

    // Authoritative Update/Create
    data.users.forEach(userData => {

      const username = userData.name || userData.username || '';

      if (userData.sessionIndex === app.sessionIndex) {
        // Authoritative update for SELF (e.g. if name was forced unique)
        app.self.instanceId = userData.iid || '';
        const selfAfk = !!userData.afk;
        app.self.setAfk?.(selfAfk);
        app.ui.setSelfUserAfk?.(selfAfk);
        if (username && username !== app.self.username) {
          app.self.setUsername(username);
          app.ui.updateSelfName(username);
        }
        if (userData.registeredName) {
          app.self.registeredName = userData.registeredName;
        }
        if (userData.isMuted !== undefined && userData.isMuted !== app.self.isMuted) {
          app.self.isMuted = !!userData.isMuted;
          ui.setMutedState(app.self.isMuted);
          app._updateBlurCannotDraw?.();
          ui.setSelfUserMuted?.(app.self.isMuted);
        }
        if (userData.role !== undefined && userData.role !== app.self.role) {
          app.selfRole = userData.role;
          app.self.role = userData.role;
          appState.selfRole = userData.role;
          ui.updateSelfRole(userData.role);
          if (app.moderation) app.moderation.setRole(userData.role);
        }
        if (userData.thinning !== undefined) {
          app.self.setThinning(userData.thinning);
          app.ui.updateThinningValue(Math.round(userData.thinning * 100));
        }
        // Only apply server's simulatePressure if we don't have a localStorage preference
        const savedSimulatePressure = localStorage.getItem('topDrawSimulatePressure');
        if (userData.simulatePressure !== undefined && savedSimulatePressure === null) {
          app.self.setSimulatePressure(userData.simulatePressure);
          app.ui.updateSimulatePressure(userData.simulatePressure);
        }
        applySelfInactiveState(selfAfk, userData.role ?? app.self.role ?? app.selfRole);
        return;
      }

      // Detect session index reuse with different instanceId and trigger cleanup
      const previousIid = vacatedSlots.get(userData.sessionIndex);
      if (previousIid && previousIid !== userData.iid) {
        console.log(`[Ghost User Prevention] Session ${userData.sessionIndex} reused: old iid=${previousIid} → new iid=${userData.iid}`);
        app.forceCleanupResidualState?.(userData.sessionIndex);
        vacatedSlots.delete(userData.sessionIndex);
      }

      let user = users.get(userData.sessionIndex);

      if (!user) {
        // New user
        const userOptions = {
          ...userData,
          username,
          afk: userData.afk || false,
          opacity: userData.color ? userData.color[3] : 1,
          role: userData.role || 0,
          isMuted: !!userData.isMuted,
          ipHash: userData.iph || userData.ipHash || '',
          visibleIp: userData.visibleIp || '',
          patternMode: userData.pm || userData.patternMode || false,
          textPositionMultiplier: userData.textPositionMultiplier,
          textPositionOffset: userData.textPositionOffset,
          instanceId: userData.iid || ''
        };

      // Use persistent color based on fingerprintId if available
      const fpId = userData.fpId || userData.fingerprintId;
      if (fpId && app.fingerprintIdUserColorCache.has(fpId)) {
        userOptions.color = app.fingerprintIdUserColorCache.get(fpId);
      } else if (fpId && userData.color) {
        // Cache the color for this fingerprintId for future rejoins
        app.fingerprintIdUserColorCache.set(fpId, userData.color);
      }
      
      userOptions.fingerprintId = fpId || '';

      const pendingFontChange = app._pendingRemoteFontChanges?.get(userData.sessionIndex);
      if (pendingFontChange) {
          userOptions.font = pendingFontChange.font ?? userOptions.font;
          if (pendingFontChange.textPositionMultiplier !== undefined) {
            userOptions.textPositionMultiplier = pendingFontChange.textPositionMultiplier;
          }
          if (pendingFontChange.textPositionOffset !== undefined) {
            userOptions.textPositionOffset = pendingFontChange.textPositionOffset;
          }
          app._pendingRemoteFontChanges.delete(userData.sessionIndex);
        }

        user = new User(userData.sessionIndex, userOptions);
        user.setTool(userData.tool);
        users.set(userData.sessionIndex, user);

        const brushData = userData.ib || userData.imageBrush;
        if (brushData && app.remoteUserHandler) {
          app.remoteUserHandler.handleBrushLoad(user, brushData);
        }

        const patternData = userData.patternBrush || userData.pb;
        if (patternData && app.remoteUserHandler) {
          app.remoteUserHandler.handlePatternBrushLoad(user, patternData);
        }

        const boardData = ui.createUserBoard(userData.sessionIndex);
        user.board = boardData.board;
        user.context = boardData.context;
        user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(user.blendMode);

        if (username) {
          ui.createRemoteUser(userData.sessionIndex, userOptions);
          if (userData.cursorHidden) ui.hideRemoteCursor(userData.sessionIndex);
        }
      } else {
        // Existing user - Update properties if they changed
        user.instanceId = userData.iid || '';
        const hadName = !!user.username;

        if (username && username !== user.username) {
          user.setUsername(username);
          if (!hadName) {
            // User gained a name - create UI
            ui.createRemoteUser(userData.sessionIndex, { ...userData, username });
          } else {
            ui.updateRemoteName(userData.sessionIndex, username);
          }
        }

        if (userData.tool && userData.tool !== user.tool) {
          if (user.tool === 'text' && userData.tool !== 'text') {
            clearRemoteTextDraft(app, user);
          }
          user.setTool(userData.tool);
          ui.updateRemoteToolDisplay(userData.sessionIndex, userData.tool);
        }

        if (userData.color && (userData.color[0] !== user.color[0] || userData.color[1] !== user.color[1] || userData.color[2] !== user.color[2])) {
          user.setColor(userData.color);
          ui.updateRemoteColor(userData.sessionIndex, userData.color);
        }

        if (userData.size !== undefined && userData.size !== user.size) {
          user.setSize(userData.size);
          ui.updateRemoteSize(userData.sessionIndex, userData.size);
        }

        if (userData.font !== undefined && userData.font !== user.font) {
          user.setFont(userData.font);
          ui.updateRemoteFont(userData.sessionIndex, userData.font);
        }

        if (userData.textPositionMultiplier !== undefined) {
          user.setTextPositionMultiplier(userData.textPositionMultiplier);
        }

        if (userData.textPositionOffset !== undefined) {
          user.setTextPositionOffset(userData.textPositionOffset);
        }

        if (userData.font !== undefined || userData.textPositionMultiplier !== undefined || userData.textPositionOffset !== undefined || userData.size !== undefined) {
          ui.updateRemoteTextLayout(userData.sessionIndex, user);
        }

        if (userData.role !== undefined && userData.role !== user.role) {
          user.role = userData.role;
          ui.updateRemoteUserRank(userData.sessionIndex, userData.role);
        }

        if (userData.registeredName) {
          user.registeredName = userData.registeredName;
        }
        if (userData.visibleIp !== undefined) {
          user.visibleIp = userData.visibleIp || '';
        }
        if (userData.isMuted !== undefined && userData.isMuted !== user.isMuted) {
          user.isMuted = !!userData.isMuted;
          ui.setRemoteUserMuted?.(userData.sessionIndex, user.isMuted);
        }
      }

      const isAfk = !!userData.afk;
      user.setAfk?.(isAfk);
      ui.setRemoteUserAfk(userData.sessionIndex, isAfk);
      ui.setRemoteUserMuted?.(userData.sessionIndex, !!userData.isMuted);
      if (pendingJoinAnnouncements.has(userData.sessionIndex)) {
        announceJoinIfReady(userData.sessionIndex);
      }
    });

    if (hasProcessedInitialUsers && joinedSessionIds.length > 0) {
      joinedSessionIds.forEach((sessionIndex) => {
        scheduleJoinAnnouncement(sessionIndex);
      });
    }

    hasProcessedInitialUsers = true;
    knownRemoteSessionIds = incomingRemoteSessionIds;

    app.updateChatUserList();
    abortSyncIfRoomIsEmpty();

    // Trigger sync on first USERS message after connecting
    if (app._needsSync) {
      app._needsSync = false;
      const selfIdx = Number(app.sessionIndex);
      const otherUsers = data.users.filter(u => Number(u.sessionIndex) !== selfIdx);
      
      if (otherUsers.length > 0) {
        // Small delay to ensure we're fully joined and ready to receive
        setTimeout(() => {
          app.syncClient.requestSync();
        }, 500);
      } else {
        app.syncClient.hideOverlay();
        app.syncClient.hasCompletedSync = true;
        app.updateRecordingButtonState?.();
      }
    }
  });

  wsClient.on('settings', (data) => {
    board.setMirror(data.mirror);
    board.setMirrorRegions(data.mirrorRegions || []);
    ui.updateMirrorDisplay(data.mirror);
    if (data.backgroundColor) {
      board.setBackgroundColor(data.backgroundColor);
      const patternTool = app.toolManager?.getTool('pattern');
      if (patternTool?.updatePreview) {
        patternTool.updatePreview(app.self);
      }
    }

    // Initialize currentRoomData if it doesn't exist
    if (!app.currentRoomData) {
      app.currentRoomData = { id: app.currentRoomId };
    }

    // Update currentRoomData with new settings
    if (data.backgroundColor) {
      app.currentRoomData.backgroundColor = data.backgroundColor;
    }
    if (data.locked !== undefined) {
      app.currentRoomData.locked = data.locked;
    }
    if (data.maxUsers !== undefined) {
      app.currentRoomData.maxUsers = data.maxUsers;
    }
    if (data.modInactiveImmune !== undefined) {
      app.currentRoomData.modInactiveImmune = data.modInactiveImmune;
    }
    if (data.joinPolicy !== undefined) {
      app.currentRoomData.joinPolicy = data.joinPolicy;
    }
    if (data.autoMuteGuests !== undefined) {
      app.currentRoomData.autoMuteGuests = data.autoMuteGuests;
    }
    if (data.autoMuteVpnUsers !== undefined) {
      app.currentRoomData.autoMuteVpnUsers = data.autoMuteVpnUsers;
    }
    if (data.hideChatNotifications !== undefined) {
      app.currentRoomData.hideChatNotifications = data.hideChatNotifications;
    }
    if (data.dedicatedReplayUser !== undefined) {
      app.currentRoomData.dedicatedReplayUser = data.dedicatedReplayUser;
    }
    if (data.electedUploader !== undefined) {
      app.currentRoomData.electedUploader = data.electedUploader;
    }
    if (data.private !== undefined) {
      app.currentRoomData.private = data.private;
    }
    if (data.floatingGallerySeed !== undefined) {
      app.currentRoomData.floatingGallerySeed = data.floatingGallerySeed;
    }
    if (data.floatingGalleryIncludeIds !== undefined) {
      app.currentRoomData.floatingGalleryIncludeIds = data.floatingGalleryIncludeIds || [];
    }
    if (data.floatingGalleryExcludeIds !== undefined) {
      app.currentRoomData.floatingGalleryExcludeIds = data.floatingGalleryExcludeIds || [];
    }
    if (data.floatingGalleryVoronoi !== undefined) {
      app.currentRoomData.floatingGalleryVoronoi = data.floatingGalleryVoronoi || null;
    }
    if (data.boardSize && BOARD_SIZE_PRESETS[data.boardSize]) {
      applyRoomBoardSize(app, data.boardSize);
    }

    // Re-evaluate on any settings change that could affect upload eligibility
    app._updatePreviewUploadEligibility();
    // Mirror is not persisted to DB, but update it locally
    app.currentRoomData.mirror = data.mirror;
    app.currentRoomData.mirrorRegions = data.mirrorRegions || [];
    appState.currentRoomData = app.currentRoomData;
    applySelfInactiveState();
  });

  wsClient.on('left', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      clearJoinTracking(data.sessionIndex);
      if (app.svelteComponents?.chat) {
        app.svelteComponents.chat.addSystemMessage(formatRoomPresenceMessage(user, 'has left the room'));
      }

      // Save vacated slot with instanceId to detect reuse
      if (user.instanceId) {
        vacatedSlots.set(data.sessionIndex, user.instanceId);
      }

      // Bake out all user strokes (preserves visuals, frees memory)
      app.cleanupRemoteUserState(data.sessionIndex, { preserveVisuals: true });

      // Immediately composite to render baked strokes
      app.board?.compositeAllLayers?.();

      app.updateChatUserList();
      abortSyncIfRoomIsEmpty();
    }
  });

  wsClient.on('afk', (data) => {
    if (data.sessionIndex === app.sessionIndex) {
      app.self.setAfk?.(!!data.afk);
      if (data.afk) {
        app.self.mousedown = false;
        app.self.clearLine?.();
        app.board?.layerManager?.deepCleanupUserState?.(app.self.id, { preserveVisuals: true });
        app.board?.clearTop?.();
        app.board?.compositeAllLayers?.();
        app.board?.requestUpdate?.();
      }
      app.ui.setSelfUserAfk?.(!!data.afk);
      applySelfInactiveState(data.afk);
      return;
    }
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setAfk(data.afk);
      if (data.afk) {
        user.mousedown = false;
        app.remoteUserHandler?.cleanupUserState?.(user, { preserveVisuals: true });
      }
      ui.setRemoteUserAfk(data.sessionIndex, data.afk);
      app.updateChatUserList();
    }
  });

  wsClient.on('compress_user_strokes', async (data) => {
    let userId;
    if (data.sessionIndex === app.sessionIndex) {
      userId = app.self?.id;
    } else {
      const user = users.get(data.sessionIndex);
      if (!user) return;
      userId = user.id;
      console.log(`[AFK] Compressing strokes for ${user.username} (${data.sessionIndex})`);
    }
    if (userId !== undefined) {
      await app.board?.commitAllUserStrokesForAFKUser?.(userId);
    }
  });

  wsClient.on('cn', (data) => {
    if (data.sessionIndex === app.sessionIndex) {
      return;
    }

    let user = users.get(data.sessionIndex);
    const wasKnown = !!user;
    const hadNameBefore = !!user?.username;
    const action = !user ? 'joined (new)' : (!hadNameBefore ? 'joined (was nameless)' : 'changed name');
    console.log(`[CN] User ${data.name}(${data.sessionIndex}) ${action}`);
    if (!user) {
      const userOptions = {
        username: data.name,
        size: data.size,
        tool: data.tool,
        color: data.color,
        opacity: data.color ? data.color[3] : undefined,
        spacing: data.spacing,
        smoothing: data.smoothing,
        hardness: data.hardness,
        blurRadius: data.blurRadius,
        activeLayer: data.activeLayer,
        blendMode: data.blendMode,
        blendBakeMode: data.blendBakeMode,
        font: data.font,
        textPositionMultiplier: data.textPositionMultiplier,
        textPositionOffset: data.textPositionOffset,
        thinning: data.thinning,
        simulatePressure: data.simulatePressure
      };
      user = new User(data.sessionIndex, userOptions);
      users.set(data.sessionIndex, user);

      const boardData = ui.createUserBoard(data.sessionIndex);
      user.board = boardData.board;
      user.context = boardData.context;
      user.board.style.mixBlendMode = app.blendModeManager.toCSSBlendMode(user.blendMode);
      ui.createRemoteUser(data.sessionIndex, user);
    } else {
      user.setUsername(data.name);

      if (data.size !== undefined) user.setSize(data.size);
      if (data.tool !== undefined) {
        if (user.tool === 'text' && data.tool !== 'text') {
          clearRemoteTextDraft(app, user);
        }
        user.setTool(data.tool);
      }
      if (data.color !== undefined) {
        user.setColor(data.color);
        user.setOpacity(data.color[3]);
      }
      if (data.spacing !== undefined) user.setSpacing(data.spacing);
      if (data.smoothing !== undefined) user.setSmoothing(data.smoothing);
      if (data.hardness !== undefined) user.setHardness(data.hardness);
      if (data.blurRadius !== undefined) user.setBlurRadius(data.blurRadius);
      if (data.activeLayer !== undefined) user.setActiveLayer(data.activeLayer);
      if (data.blendMode !== undefined) user.setBlendMode(data.blendMode);
      if (data.blendBakeMode !== undefined) user.setBlendBakeMode(data.blendBakeMode);
      if (data.font !== undefined) user.setFont(data.font);
      if (data.textPositionMultiplier !== undefined) user.setTextPositionMultiplier(data.textPositionMultiplier);
      if (data.textPositionOffset !== undefined) user.setTextPositionOffset(data.textPositionOffset);
      if (data.thinning !== undefined) user.setThinning(data.thinning);
      if (data.simulatePressure !== undefined) user.setSimulatePressure(data.simulatePressure);

      if (!hadNameBefore) {
        ui.createRemoteUser(data.sessionIndex, user);
      } else {
        ui.updateRemoteName(data.sessionIndex, data.name);
        if (data.tool !== undefined) ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
        if (data.color !== undefined) ui.updateRemoteColor(data.sessionIndex, data.color);
        if (data.size !== undefined) ui.updateRemoteSize(data.sessionIndex, data.size);
        if (data.font !== undefined) ui.updateRemoteFont(data.sessionIndex, data.font);
        if (data.font !== undefined || data.textPositionMultiplier !== undefined || data.textPositionOffset !== undefined || data.size !== undefined) {
          ui.updateRemoteTextLayout(data.sessionIndex, user);
        }
      }
    }
    if (hasProcessedInitialUsers && (!wasKnown || !hadNameBefore)) {
      scheduleJoinAnnouncement(data.sessionIndex);
    }
    if (pendingJoinAnnouncements.has(data.sessionIndex)) {
      announceJoinIfReady(data.sessionIndex);
    }
    app.updateChatUserList();

  });

  wsClient.on('hide_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text' && user.text) {
      return;
    }
    if (user) {
      user.cursorHidden = true;
    }
    ui.hideRemoteCursor(data.sessionIndex);
  });

  wsClient.on('show_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.cursorHidden = false;
      ui.showRemoteCursor(data.sessionIndex);
      ui.updateRemoteToolDisplay(data.sessionIndex, user.tool);
    }
  });

  wsClient.on('pan', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.panning = data.panning;
    }
  });
}
