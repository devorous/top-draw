import { User } from '../User.js';

/**
 * UserHandlers
 *
 * Handles user lifecycle events:
 * - User list sync
 * - User join/leave
 * - AFK status changes
 * - Cursor visibility
 * - Board settings
 */

export function setupUserHandlers(wsClient, app) {
  const { users, ui, board, chat } = app;

  // Users list received (initial sync or updates)
  wsClient.on('users', (data) => {
    console.log(`[USERS] Received ${data.users.length} users:`, data.users.map(u => `${u.name || 'unnamed'}(${u.sessionIndex})`).join(', '), `My sessionIndex: ${app.sessionIndex}`);
    
    // 1. Authoritative Removal: Find users we have locally who are NOT in the new list
    const remoteIndices = new Set(data.users.map(u => u.sessionIndex));
    users.forEach((user, sessionIndex) => {
      if (sessionIndex !== app.sessionIndex && !remoteIndices.has(sessionIndex)) {
        console.log(`[USERS] Removing ghost user ${user.username}(${sessionIndex})`);
        users.delete(sessionIndex);
        ui.removeRemoteUser(sessionIndex);
      }
    });

    // 2. Authoritative Update/Create
    data.users.forEach(userData => {
      console.log(`[USERS] Processing user ${userData.name}(${userData.sessionIndex}), self=${app.sessionIndex}`);
      if (userData.sessionIndex !== app.sessionIndex) {
        let user = users.get(userData.sessionIndex);
        const username = userData.name || userData.username || '';

        if (!user) {
          // New user
          const userOptions = {
            ...userData,
            username,
            afk: userData.afk || false,
            opacity: userData.color ? userData.color[3] : 1,
            role: userData.role || 0
          };

          user = new User(userData.sessionIndex, userOptions);
          user.setTool(userData.tool);
          users.set(userData.sessionIndex, user);

          const brushData = userData.ib || userData.imageBrush;
          if (brushData && app.remoteUserHandler) {
            app.remoteUserHandler.handleBrushLoad(user, brushData);
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

          if (userData.role !== undefined && userData.role !== user.role) {
            user.role = userData.role;
            // Update role badge if needed
          }
        }

        // Apply AFK status
        ui.setRemoteUserAfk(userData.sessionIndex, !!userData.afk);
      }
    });

    // Update chat user list for DM functionality
    app.updateChatUserList();

    // Trigger sync on first USERS message after connecting
    if (app._needsSync) {
      app._needsSync = false;
      const otherUsers = data.users.filter(u => u.sessionIndex !== app.sessionIndex);
      if (otherUsers.length > 0) {
        // Other users exist — request canvas sync
        app.syncClient.requestSync();
      } else {
        // We're alone — no sync needed, just hide the overlay
        app.syncClient.hideOverlay();
        app.syncClient.hasCompletedSync = true;
      }
    }
  });

  // Board settings
  wsClient.on('settings', (data) => {
    board.setMirror(data.mirror);
    ui.updateMirrorDisplay(data.mirror);
  });

  // User left
  wsClient.on('left', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addSystemMessage(`${user.username || 'User'} has left the room`);

      // Clean up any active strokes from this user (e.g., if they disconnected mid-stroke)
      if (board.layerManager) {
        board.layerManager.cleanupUserStrokes(data.sessionIndex);
        board.requestUpdate();
      }

      users.delete(data.sessionIndex);
      ui.removeRemoteUser(data.sessionIndex);

      // Update chat user list
      app.updateChatUserList();
    }
  });

  // AFK status change
  wsClient.on('afk', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setAfk(data.afk);
      ui.setRemoteUserAfk(data.sessionIndex, data.afk);
    }
  });

  // Name change (user joining)
  wsClient.on('cn', (data) => {
    // Skip if this is our own session (defensive check)
    if (data.sessionIndex === app.sessionIndex) {
      return;
    }

    let user = users.get(data.sessionIndex);
    const hadName = user ? !!user.username : false;
    const action = !user ? 'joined (new)' : (!hadName ? 'joined (was nameless)' : 'changed name');
    console.log(`[CN] User ${data.name}(${data.sessionIndex}) ${action}`);
    if (!user) {
      // User wasn't in any users list yet — create from scratch
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
        blendMode: data.blendMode
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

      // Apply any properties that were bundled with the join message
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

      if (!hadName) {
        // User existed but had no UI entry yet (was nameless on connect)
        ui.createRemoteUser(data.sessionIndex, user);
      } else {
        ui.updateRemoteName(data.sessionIndex, data.name);
        // Refresh UI for properties that might have changed
        if (data.tool !== undefined) ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
        if (data.color !== undefined) ui.updateRemoteColor(data.sessionIndex, data.color);
        if (data.size !== undefined) ui.updateRemoteSize(data.sessionIndex, data.size);
      }
    }
    chat.addSystemMessage(`${data.name} joined the room`);
    // Update chat user list
    app.updateChatUserList();
  });

  // Hide cursor
  wsClient.on('hide_cursor', (data) => {
    ui.hideRemoteCursor(data.sessionIndex);
  });

  // Show cursor
  wsClient.on('show_cursor', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      ui.showRemoteCursor(data.sessionIndex);
      // Refresh tool display to show correct cursor shape
      ui.updateRemoteToolDisplay(data.sessionIndex, user.tool);
    }
  });

  // Pan mode
  wsClient.on('pan', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.panning = data.panning;
    }
  });
}
