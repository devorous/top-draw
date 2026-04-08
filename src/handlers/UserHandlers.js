/** @fileoverview Handles user-related events including lifecycle, AFK status, and cursor visibility. */

import { User } from '../User.js';
import { appState } from '../state.svelte.js';

/**
 * Sets up WebSocket event handlers for user-related actions and state changes.
 * @param {WebSocketClient} wsClient - The WebSocket client instance.
 * @param {App} app - The main application instance.
 */
export function setupUserHandlers(wsClient, app) {
  const { users, ui, board, chat } = app;

  const abortSyncIfRoomIsEmpty = () => {
    if (!app.syncClient?.isSyncing()) return;

    const hasOtherUsers = [...users.keys()].some((sessionIndex) => sessionIndex !== app.sessionIndex);
    if (!hasOtherUsers) {
      app.syncClient.abortSync('Sync stopped - no other users remain in the room');
      app.updateRecordingButtonState?.();
    }
  };

  wsClient.on('users', (data) => {
    // Authoritative Removal: Find users we have locally who are NOT in the new list
    const remoteIndices = new Set(data.users.map(u => u.sessionIndex));
    users.forEach((user, sessionIndex) => {
      if (sessionIndex !== app.sessionIndex && !remoteIndices.has(sessionIndex)) {
        console.log(`[USERS] Removing ghost user ${user.username}(${sessionIndex})`);
        app.cleanupRemoteUserState(sessionIndex, { preserveVisuals: true });
      }
    });

    // Authoritative Update/Create
    data.users.forEach(userData => {
      
      const username = userData.name || userData.username || '';

      if (userData.sessionIndex === app.sessionIndex) {
        // Authoritative update for SELF (e.g. if name was forced unique)
        app.syncClient?.setInactive(!!userData.afk);
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
        return;
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
          textPositionOffset: userData.textPositionOffset
        };

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

      ui.setRemoteUserAfk(userData.sessionIndex, !!userData.afk);
      ui.setRemoteUserMuted?.(userData.sessionIndex, !!userData.isMuted);
    });

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
    if (data.dedicatedReplayUser !== undefined) {
      app.currentRoomData.dedicatedReplayUser = data.dedicatedReplayUser;
    }
    if (data.electedUploader !== undefined) {
      app.currentRoomData.electedUploader = data.electedUploader;
    }
    // Re-evaluate on any settings change that could affect upload eligibility
    app._updatePreviewUploadEligibility();
    // Mirror is not persisted to DB, but update it locally
    app.currentRoomData.mirror = data.mirror;
    app.currentRoomData.mirrorRegions = data.mirrorRegions || [];
    appState.currentRoomData = app.currentRoomData;
  });

  wsClient.on('left', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      if (app.svelteComponents?.chat) {
        app.svelteComponents.chat.addSystemMessage(`${user.username || 'User'} has left the room`);
      }

      // Bake out all user strokes (preserves visuals, frees memory)
      app.cleanupRemoteUserState(data.sessionIndex, { preserveVisuals: true });

      app.updateChatUserList();
      abortSyncIfRoomIsEmpty();
    }
  });

  wsClient.on('afk', (data) => {
    if (data.sessionIndex === app.sessionIndex) {
      app.syncClient?.setInactive(data.afk);
      return;
    }
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setAfk(data.afk);
      ui.setRemoteUserAfk(data.sessionIndex, data.afk);
    }
  });

  wsClient.on('cn', (data) => {
    if (data.sessionIndex === app.sessionIndex) {
      return;
    }

    let user = users.get(data.sessionIndex);
    const hadName = user ? !!user.username : false;
    const action = !user ? 'joined (new)' : (!hadName ? 'joined (was nameless)' : 'changed name');
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
      const hadName = !!user.username;
      user.setUsername(data.name);

      if (data.size !== undefined) user.setSize(data.size);
      if (data.tool !== undefined) user.setTool(data.tool);
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
      if (data.font !== undefined) user.setFont(data.font);
      if (data.textPositionMultiplier !== undefined) user.setTextPositionMultiplier(data.textPositionMultiplier);
      if (data.textPositionOffset !== undefined) user.setTextPositionOffset(data.textPositionOffset);
      if (data.thinning !== undefined) user.setThinning(data.thinning);
      if (data.simulatePressure !== undefined) user.setSimulatePressure(data.simulatePressure);

      if (!hadName) {
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
    if (app.svelteComponents?.chat) {
      app.svelteComponents.chat.addSystemMessage(`${data.name} joined the room`);
    }
    app.updateChatUserList();

  });

  wsClient.on('hide_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text' && user.text) {
      return;
    }
    ui.hideRemoteCursor(data.sessionIndex);
  });

  wsClient.on('show_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
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
