import { User } from './User.js';

/**
 * Sets up all WebSocket message handlers for the app
 */
export function setupWebSocketHandlers(app) {
  const { wsClient, users, ui, board, chat, remoteUserHandler } = app;

  // Users list received
  wsClient.on('users', (data) => {
    data.users.forEach(userData => {
      if (userData.sessionIndex !== app.sessionIndex) {
        let user = users.get(userData.sessionIndex);

        if (!user) {
          // Map 'name' to 'username' for User class compatibility
          const userOptions = {
            ...userData,
            username: userData.name || userData.username || '',
            afk: userData.afk || false
          };

          // Create new remote user
          user = new User(userData.sessionIndex, userOptions);
          users.set(userData.sessionIndex, user);

          const boardData = ui.createUserBoard(userData.sessionIndex);
          user.board = boardData.board;
          user.context = boardData.context;

          ui.createRemoteUser(userData.sessionIndex, userOptions);
        }

        // Apply AFK status
        if (userData.afk) {
          ui.setRemoteUserAfk(userData.sessionIndex, true);
        }
      }
    });
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
      users.delete(data.sessionIndex);
      ui.removeRemoteUser(data.sessionIndex);
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

  // Mouse move
  wsClient.on('mm', (data) => {
    const user = users.get(data.sessionIndex);
    if (!user || !data.ps || data.ps.length < 2) return;
    remoteUserHandler.handleMouseMove(user, data);
  });

  // Mouse down
  wsClient.on('md', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseDown(user);
    }
  });

  // Mouse up
  wsClient.on('mu', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleMouseUp(user);
    }
  });

  // Pressure change
  wsClient.on('cp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setPressure(data.pressure);
      if (user.mousedown && user.tool === 'brush') {
        remoteUserHandler.commitLine(user);
      }
    }
  });

  // Size change
  wsClient.on('cs', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSize(data.size);
      ui.updateRemoteSize(data.sessionIndex, data.size);
      if (user.mousedown && user.tool === 'brush') {
        remoteUserHandler.commitLine(user);
      }
    }
  });

  // Tool change
  wsClient.on('ct', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      // Clear pending selection if switching away from select tool
      if (user.pendingSelection && data.tool !== 'select') {
        user.pendingSelection = null;
        user.context.clearRect(0, 0, board.getWidth(), board.getHeight());
      }
      user.setTool(data.tool);
      ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
    }
  });

  // Color change
  wsClient.on('cc', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setColor(data.color);
      ui.updateRemoteColor(data.sessionIndex, data.color);
    }
  });

  // Spacing change
  wsClient.on('csp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setSpacing(data.spacing);
    }
  });

  // Name change
  wsClient.on('cn', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.setUsername(data.name);
      ui.updateRemoteName(data.sessionIndex, data.name);
      chat.addSystemMessage(`${data.name} joined the room`);
    }
  });

  // Key press
  wsClient.on('kp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user && user.tool === 'text') {
      remoteUserHandler.handleKeyPress(user, data.key);
    }
  });

  // Clear canvas
  wsClient.on('clr', () => {
    board.clear();
  });

  // Toggle mirror
  wsClient.on('mir', () => {
    const mirror = board.toggleMirror();
    ui.updateMirrorDisplay(mirror);
  });

  // Chat message
  wsClient.on('msg', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      chat.addMessage(data.message, user);
    }
  });

  // GIMP brush
  wsClient.on('gmp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleGimpLoad(user, data.gimpData);
    }
  });

  // Pan mode
  wsClient.on('pan', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      user.panning = data.panning;
    }
  });

  // Cancel stroke
  wsClient.on('cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleCancel(user);
    }
  });

  // Selection lift - remote user lifted a selection
  wsClient.on('sel_lift', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionLift(user, data.selection);
    }
  });

  // Selection move - remote user moved/transformed selection
  wsClient.on('sel_move', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionMove(user, data.corners);
    }
  });

  // Selection commit - remote user committed selection
  wsClient.on('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.handleSelectionCommit(user);
    }
  });
}
