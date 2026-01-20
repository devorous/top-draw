import { User } from './User.js';
import { Board } from './Board.js';
import { ToolManager, BrushTool } from './Tools.js';
import { WebSocketClient } from './WebSocketClient.js';
import { Chat } from './Chat.js';
import { UI } from './UI.js';
import { BrushGallery } from './BrushGallery.js';
import { manhattanDistance, mirrorLine } from './utils/drawing.js';
import { Homography } from './utils/homography.js';

/**
 * Main application class
 */
export class DrawingApp {
  constructor(options = {}) {
    this.sessionIndex = null;  // Assigned by server on connect
    this.users = new Map();    // sessionIndex -> User
    this.connected = false;

    this.board = new Board({
      dimensions: options.dimensions || [720, 1280]
    });
    this.board.app = this; // Allow tools to access wsClient

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();
    this.chat = new Chat({
      onSend: (message) => this.handleChatSend(message)
    });
    this.brushGallery = new BrushGallery({
      onSelect: (brush) => this.handleBrushSelect(brush)
    });

    this.wsClient = new WebSocketClient({
      serverUrl: options.serverUrl,
      onConnect: (sessionIndex) => this.handleWSConnect(sessionIndex),
      onDisconnect: () => this.handleWSDisconnect()
    });

    this.self = null;
    this.colorPicker = null;
    this.isOnBoard = false;
  }

  async init() {
    this.ui.init();
    this.board.init('#boardContainer');
    this.chat.init();
    this.brushGallery.init();

    this.createSelf();
    this.setupColorPicker();
    this.setupEventListeners();
    this.setupWebSocketHandlers();

    this.toolManager.setTool('brush');
    this.ui.updateToolDisplay('brush');

    await this.wsClient.connect(this.self.toJSON());
  }

  createSelf() {
    // Create self with temporary ID, will be updated when server assigns sessionIndex
    this.self = new User(0, {
      context: this.board.topCtx,
      board: this.board.mainCanvas
    });
  }

  setupColorPicker() {
    if (typeof Picker !== 'undefined') {
      this.colorPicker = new Picker({
        parent: this.ui.elements.colorPicker,
        popup: false,
        alpha: true,
        editor: true,
        color: '#000',
        onChange: (color) => {
          this.self.setColor(color.rgba);
          this.ui.updateSelfColor(color.rgba);
          this.ui.updateSelfTextStyle(this.self.size, color.rgba);
          if (this.connected) {
            this.wsClient.broadcastColorChange(color.rgba);
          }
        }
      });
    }
  }


  setupEventListeners() {
    const { elements } = this.ui;

    // Track touch state for pinch-to-zoom
    this.touchState = {
      touches: [],
      initialDistance: null,
      initialZoom: null,
      isPinching: false
    };

    elements.joinBtn.addEventListener('click', () => this.handleJoin());
    elements.offlineBtn.addEventListener('click', () => this.startOfflineMode());
    elements.selectBtn.addEventListener('click', () => this.selectTool('select'));
    elements.brushBtn.addEventListener('click', () => this.selectTool('brush'));
    elements.penBtn.addEventListener('click', () => this.selectTool('pen'));
    elements.lineBtn.addEventListener('click', () => this.selectTool('line'));
    elements.rectangleBtn.addEventListener('click', () => this.selectTool('rectangle'));
    elements.circleBtn.addEventListener('click', () => this.selectTool('circle'));
    elements.textBtn.addEventListener('click', () => this.selectTool('text'));
    elements.eraseBtn.addEventListener('click', () => this.selectTool('erase'));
    elements.gimpBtn.addEventListener('click', () => this.selectTool('gimp'));

    elements.clearBtn.addEventListener('click', () => this.handleClear());
    elements.resetBtn.addEventListener('click', () => this.handleResetBoard());
    elements.mirrorBtn.addEventListener('click', () => this.handleToggleMirror());
    elements.plusBtn.addEventListener('click', () => this.handleZoomIn());
    elements.minusBtn.addEventListener('click', () => this.handleZoomOut());
    elements.saveBtn.addEventListener('click', () => this.board.saveAsImage());

    elements.chatBtn.addEventListener('click', () => this.chat.toggle());
    elements.chatResetBtn.addEventListener('click', () => this.chat.resetPosition());

    elements.sizeSlider.addEventListener('input', (e) => this.handleSizeChange(e));
    elements.spacingSlider.addEventListener('input', (e) => this.handleSpacingChange(e));
    elements.gimpFileInput.addEventListener('change', (e) => this.handleGimpFileLoad(e));

    elements.board.addEventListener('pointermove', (e) => this.handlePointerMove(e));
    elements.board.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    elements.board.addEventListener('pointerup', (e) => this.handlePointerUp(e));
    elements.board.addEventListener('pointerenter', () => { this.isOnBoard = true; });
    elements.board.addEventListener('pointerleave', (e) => this.handlePointerLeave(e));
    elements.board.addEventListener('wheel', (e) => this.handleWheel(e));
    elements.board.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cancelCurrentStroke();
    });
    elements.boardContainer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    // Touch events for pinch-to-zoom
    elements.boards.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    elements.boards.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    elements.boards.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });

    // Hidden input for touch keyboard (text tool)
    if (elements.touchInput) {
      elements.touchInput.addEventListener('input', (e) => this.handleTouchInput(e));
      elements.touchInput.addEventListener('blur', () => this.handleTouchInputBlur());
    }

    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keyup', (e) => this.handleKeyUp(e));

    window.addEventListener('resize', () => this.handleResize());
  }

  setupWebSocketHandlers() {
    // Users list received
    this.wsClient.on('users', (data) => {
      data.users.forEach(userData => {
        if (userData.sessionIndex !== this.sessionIndex) {
          let user = this.users.get(userData.sessionIndex);

          if (!user) {
            // Create new remote user
            user = new User(userData.sessionIndex, {
              ...userData,
              afk: userData.afk || false
            });
            this.users.set(userData.sessionIndex, user);

            const boardData = this.ui.createUserBoard(userData.sessionIndex);
            user.board = boardData.board;
            user.context = boardData.context;

            this.ui.createRemoteUser(userData.sessionIndex, userData);
          }

          // Apply AFK status
          if (userData.afk) {
            this.ui.setRemoteUserAfk(userData.sessionIndex, true);
          }
        }
      });
    });

    // Board settings
    this.wsClient.on('settings', (data) => {
      this.board.setMirror(data.mirror);
      this.ui.updateMirrorDisplay(data.mirror);
    });

    // User left
    this.wsClient.on('left', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.chat.addSystemMessage(`${user.username || 'User'} has left the room`);
        this.users.delete(data.sessionIndex);
        this.ui.removeRemoteUser(data.sessionIndex);
      }
    });

    // AFK status change
    this.wsClient.on('afk', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.setAfk(data.afk);
        this.ui.setRemoteUserAfk(data.sessionIndex, data.afk);
      }
    });

    // Mouse move
    this.wsClient.on('mm', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteMouseMove(user, data);
      }
    });

    // Mouse down
    this.wsClient.on('md', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteMouseDown(user);
      }
    });

    // Mouse up
    this.wsClient.on('mu', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteMouseUp(user);
      }
    });

    // Pressure change
    this.wsClient.on('cp', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.setPressure(data.pressure);
        if (user.mousedown && user.tool === 'brush') {
          this.commitRemoteLine(user);
        }
      }
    });

    // Size change
    this.wsClient.on('cs', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.setSize(data.size);
        this.ui.updateRemoteSize(data.sessionIndex, data.size);
        if (user.mousedown && user.tool === 'brush') {
          this.commitRemoteLine(user);
        }
      }
    });

    // Tool change
    this.wsClient.on('ct', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        // Clear pending selection if switching away from select tool
        if (user.pendingSelection && data.tool !== 'select') {
          user.pendingSelection = null;
          user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
        }
        user.setTool(data.tool);
        this.ui.updateRemoteToolDisplay(data.sessionIndex, data.tool);
      }
    });

    // Color change
    this.wsClient.on('cc', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.setColor(data.color);
        this.ui.updateRemoteColor(data.sessionIndex, data.color);
      }
    });

    // Spacing change
    this.wsClient.on('csp', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.setSpacing(data.spacing);
      }
    });

    // Name change
    this.wsClient.on('cn', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.setUsername(data.name);
        this.ui.updateRemoteName(data.sessionIndex, data.name);
        this.chat.addSystemMessage(`${data.name} joined the room`);
      }
    });

    // Key press
    this.wsClient.on('kp', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user && user.tool === 'text') {
        this.handleRemoteKeyPress(user, data.key);
      }
    });

    // Clear canvas
    this.wsClient.on('clr', () => {
      this.board.clear();
    });

    // Toggle mirror
    this.wsClient.on('mir', () => {
      const mirror = this.board.toggleMirror();
      this.ui.updateMirrorDisplay(mirror);
    });

    // Chat message
    this.wsClient.on('msg', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.chat.addMessage(data.message, user);
      }
    });

    // GIMP brush
    this.wsClient.on('gmp', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteGimpLoad(user, data.gimpData);
      }
    });

    // Pan mode
    this.wsClient.on('pan', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        user.panning = data.panning;
      }
    });

    // Cancel stroke
    this.wsClient.on('cancel', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteCancel(user);
      }
    });

    // Selection lift - remote user lifted a selection
    this.wsClient.on('sel_lift', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteSelectionLift(user, data.selection);
      }
    });

    // Selection move - remote user moved/transformed selection
    this.wsClient.on('sel_move', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteSelectionMove(user, data.corners);
      }
    });

    // Selection commit - remote user committed selection
    this.wsClient.on('sel_commit', (data) => {
      const user = this.users.get(data.sessionIndex);
      if (user) {
        this.handleRemoteSelectionCommit(user);
      }
    });
  }

handleRemoteMouseMove(user, data) {
  if (user.lastx === null) {
    user.lastx = data.x;
    user.lasty = data.y;
  }

  const lastPos = { x: user.x, y: user.y };
  user.setPosition(data.x, data.y);
  const pos = { x: user.x, y: user.y };

  this.ui.updateRemoteCursor(user.id, user.x, user.y, user.size);

  if (!user.panning && user.mousedown) {
    // Clear the remote user's specific top/preview layer before drawing frame-based tools
    // Brush and Erase often draw cumulatively, but Shapes and Select need a fresh frame.
    const needsClear = ['line', 'rectangle', 'circle', 'select'].includes(user.tool);
    if (needsClear) {
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }

    switch (user.tool) {
      case 'brush':
        user.addToLine(pos);
        if (user.pressure !== user.prevpressure) {
          this.commitRemoteLine(user);
        } else {
          user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
          this.drawLineArray(user.currentLine, user.context, user);
          if (this.board.mirror) {
            const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
            this.drawLineArray(mirrored, user.context, user);
          }
        }
        user.prevpressure = user.pressure;
        break;

      case 'erase':
        const eraserTool = this.toolManager.getTool('erase');
        eraserTool.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          eraserTool.erase(w - pos.x, pos.y, w - lastPos.x, lastPos.y, user.pressure * user.size * 2);
        }
        break;

      case 'gimp':
        if (user.gBrush) {
          this.toolManager.getTool('gimp').draw(user, pos);
        }
        break;

      case 'pen':
        // Pen tool typically uses an offscreen canvas for "stamping" 
        // to prevent opacity overlap before committing.
        this.toolManager.getTool('pen').onPointerMove(user, pos, lastPos);
        break;

      case 'line':
        this.toolManager.getTool('line').drawPreview(user.context, user, user.startPos, pos);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          this.toolManager.getTool('line').drawPreview(user.context, user, 
            { x: w - user.startPos.x, y: user.startPos.y }, 
            { x: w - pos.x, y: pos.y }
          );
        }
        break;

      case 'rectangle':
        this.toolManager.getTool('rectangle').drawRect(user.context, user, user.startPos, pos);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          this.toolManager.getTool('rectangle').drawRect(user.context, user, 
            { x: w - user.startPos.x, y: user.startPos.y }, 
            { x: w - pos.x, y: pos.y }
          );
        }
        break;

      case 'circle':
        this.toolManager.getTool('circle').drawEllipse(user.context, user, user.startPos, pos);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          this.toolManager.getTool('circle').drawEllipse(user.context, user, 
            { x: w - user.startPos.x, y: user.startPos.y }, 
            { x: w - pos.x, y: pos.y }
          );
        }
        break;

      case 'select':
        // Only draw selection box if user is creating a NEW selection
        // (not if they have an active floating selection being moved/transformed)
        if (!user.floatingCanvas && user.startPos) {
          const selectTool = this.toolManager.getTool('select');
          selectTool.drawSelectionBox(user.context, user.startPos, pos);
        }
        break;
    }
  }

  user.lastx = data.x;
  user.lasty = data.y;
}

handleRemoteMouseDown(user) {
  user.lastx = user.x;
  user.lasty = user.y;
  user.spaceIndex = 0;
  user.mousedown = true;

  const pos = { x: user.x, y: user.y };
  // Essential for all shape tools and selection
  user.startPos = pos; 

  switch (user.tool) {
    case 'brush':
      if (!user.panning) {
        // Add point twice (like local BrushTool) so single-click draws a dot
        user.addToLine(pos);
        user.addToLine(pos);
      }
      break;

    case 'pen':
      this.toolManager.getTool('pen').onPointerDown(user, pos);
      break;

    case 'erase':
      if (!user.panning) {
        const eraserTool = this.toolManager.getTool('erase');
        eraserTool.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2);
      }
      break;

    case 'text':
      if (user.text) {
        this.toolManager.getTool('text').drawText(user);
        user.text = '';
        this.ui.updateRemoteText(user.id, '');
      }
      break;

    case 'gimp':
      if (user.gBrush && !user.panning) {
        this.toolManager.getTool('gimp').draw(user, pos);
      }
      break;

    case 'line':
    case 'rectangle':
    case 'circle':
      // These tools primarily use startPos, which we set above.
      break;

    case 'select':
      // If starting a new selection OUTSIDE pending selection, clear it
      // If clicking inside, sel_lift will handle the transition
      if (user.pendingSelection && !user.floatingCanvas) {
        const s = user.pendingSelection;
        const clickedInside = pos.x >= s.x && pos.x <= s.x + s.width &&
                              pos.y >= s.y && pos.y <= s.y + s.height;
        if (!clickedInside) {
          user.pendingSelection = null;
          user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
        }
      }
      break;
  }
}

handleRemoteMouseUp(user) {
  const pos = { x: user.x, y: user.y };
  const mainCtx = this.board.mainCtx;
  
  switch (user.tool) {
    case 'brush':
      if (!user.panning) {
        this.drawLineArray(user.currentLine, mainCtx, user);
        if (this.board.mirror) {
          const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
          this.drawLineArray(mirrored, mainCtx, user);
        }
      }
      break;

    case 'pen':
      this.toolManager.getTool('pen').onPointerUp(user, pos);
      break;

    case 'line':
      this.toolManager.getTool('line').drawPreview(mainCtx, user, user.startPos, pos);
      if (this.board.mirror) {
        const w = this.board.getWidth();
        this.toolManager.getTool('line').drawPreview(mainCtx, user, 
          { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
      }
      break;

    case 'rectangle':
      this.toolManager.getTool('rectangle').drawRect(mainCtx, user, user.startPos, pos);
      if (this.board.mirror) {
        const w = this.board.getWidth();
        this.toolManager.getTool('rectangle').drawRect(mainCtx, user, 
          { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
      }
      break;

    case 'circle':
      this.toolManager.getTool('circle').drawEllipse(mainCtx, user, user.startPos, pos);
      if (this.board.mirror) {
        const w = this.board.getWidth();
        this.toolManager.getTool('circle').drawEllipse(mainCtx, user, 
          { x: w - user.startPos.x, y: user.startPos.y }, { x: w - pos.x, y: pos.y });
      }
      break;

    case 'select':
      // On MouseUp, the remote user has finished defining a selection area.
      // Store selection info on user (actual lift happens via sel_lift event)
      if (user.startPos) {
        const x = Math.min(user.startPos.x, pos.x);
        const y = Math.min(user.startPos.y, pos.y);
        const width = Math.abs(pos.x - user.startPos.x);
        const height = Math.abs(pos.y - user.startPos.y);
        if (width >= 5 && height >= 5) {
          user.pendingSelection = { x, y, width, height };
        }
      }
      break;
  }

    // Cleanup
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;

    // Redraw floating selection if user has one (persists after handle release)
    if (user.floatingCanvas && user.selection) {
      this.drawRemoteFloatingSelection(user);
    }
    // Draw pending selection rectangle if user just finished creating one
    else if (user.pendingSelection) {
      this.drawRemotePendingSelection(user);
    }
  }

  handleRemoteKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key === ' ' ? '&nbsp;' : key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      if (user.text.endsWith('&nbsp;')) {
        user.text = user.text.slice(0, -6);
      } else {
        user.text = user.text.slice(0, -1);
      }
    }
    this.ui.updateRemoteText(user.id, user.text);
  }

  handleRemoteGimpLoad(user, gimpDataStr) {
    // Parse JSON string from protobuf transport
    const gimpData = typeof gimpDataStr === 'string' ? JSON.parse(gimpDataStr) : gimpDataStr;

    if (gimpData.type === 'gbr') {
      const image = new Image();
      image.src = gimpData.gimpUrl;
      gimpData.image = image;
      user.gBrush = gimpData;
    } else if (gimpData.type === 'gih') {
      const images = gimpData.gBrushes.map(brush => {
        const img = new Image();
        img.src = brush.gimpUrl;
        return img;
      });
      gimpData.index = 0;
      gimpData.images = images;
      user.gBrush = gimpData;
    }
  }

  handleRemoteSelectionLift(user, selection) {
    // Clear pending selection since it's now being lifted
    user.pendingSelection = null;

    // Store selection info on user for rendering
    user.selection = selection;

    // Lift the pixels from main canvas into a floating canvas for this user
    const s = selection;
    user.floatingCanvas = document.createElement('canvas');
    user.floatingCanvas.width = s.width;
    user.floatingCanvas.height = s.height;
    user.floatingCtx = user.floatingCanvas.getContext('2d');

    // Copy selected region from main canvas
    const imageData = this.board.mainCtx.getImageData(s.x, s.y, s.width, s.height);
    user.floatingCtx.putImageData(imageData, 0, 0);

    // Clear the region on main canvas
    this.board.mainCtx.clearRect(s.x, s.y, s.width, s.height);

    // Initialize corners for transform
    user.selectionCorners = {
      tl: { x: s.x, y: s.y },
      tr: { x: s.x + s.width, y: s.y },
      bl: { x: s.x, y: s.y + s.height },
      br: { x: s.x + s.width, y: s.y + s.height }
    };
    user.originalCorners = {
      tl: { x: 0, y: 0 },
      tr: { x: s.width, y: 0 },
      bl: { x: 0, y: s.height },
      br: { x: s.width, y: s.height }
    };

    // Draw floating selection on user's preview layer
    this.drawRemoteFloatingSelection(user);
  }

  handleRemoteSelectionMove(user, corners) {
    if (!user.floatingCanvas || !user.selection) return;

    // Update corners
    user.selectionCorners = corners;

    // Update selection bounds from corners
    const c = corners;
    const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const maxX = Math.max(c.tl.x, c.tr.x, c.bl.x, c.br.x);
    const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    const maxY = Math.max(c.tl.y, c.tr.y, c.bl.y, c.br.y);
    user.selection.x = minX;
    user.selection.y = minY;
    user.selection.width = maxX - minX;
    user.selection.height = maxY - minY;

    // Clear user's layer and redraw
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    this.drawRemoteFloatingSelection(user);
  }

  handleRemoteSelectionCommit(user) {
    if (!user.floatingCanvas || !user.selection) return;

    const s = user.selection;
    const c = user.selectionCorners;

    // Check if transform was applied (corners moved from axis-aligned rectangle)
    const hasTransform = this.hasRemoteTransformedCorners(user);

    if (hasTransform && user.originalCorners) {
      // Apply homography transform
      try {
        const homography = new Homography('projective');

        const srcPoints = [
          [user.originalCorners.tl.x, user.originalCorners.tl.y],
          [user.originalCorners.tr.x, user.originalCorners.tr.y],
          [user.originalCorners.bl.x, user.originalCorners.bl.y],
          [user.originalCorners.br.x, user.originalCorners.br.y]
        ];

        const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
        const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

        const dstPoints = [
          [c.tl.x - minX, c.tl.y - minY],
          [c.tr.x - minX, c.tr.y - minY],
          [c.bl.x - minX, c.bl.y - minY],
          [c.br.x - minX, c.br.y - minY]
        ];

        homography.setSourcePoints(srcPoints, user.floatingCanvas);
        homography.setDestinyPoints(dstPoints);

        const result = homography.warp();
        if (result) {
          this.board.mainCtx.putImageData(result, minX, minY);
        } else {
          // Fallback
          this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote homography failed:', e);
        this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      // Simple draw without transform
      this.board.mainCtx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Cleanup user selection state
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.floatingCanvas = null;
    user.floatingCtx = null;
    user.selection = null;
    user.selectionCorners = null;
    user.originalCorners = null;
  }

  hasRemoteTransformedCorners(user) {
    if (!user.selectionCorners || !user.selection) return false;

    const s = user.selection;
    const c = user.selectionCorners;
    const tolerance = 0.5;

    return (
      Math.abs(c.tl.x - s.x) > tolerance ||
      Math.abs(c.tl.y - s.y) > tolerance ||
      Math.abs(c.tr.x - (s.x + s.width)) > tolerance ||
      Math.abs(c.tr.y - s.y) > tolerance ||
      Math.abs(c.bl.x - s.x) > tolerance ||
      Math.abs(c.bl.y - (s.y + s.height)) > tolerance ||
      Math.abs(c.br.x - (s.x + s.width)) > tolerance ||
      Math.abs(c.br.y - (s.y + s.height)) > tolerance
    );
  }

  drawRemoteFloatingSelection(user) {
    if (!user.floatingCanvas || !user.selection) return;

    const ctx = user.context;
    const s = user.selection;
    const c = user.selectionCorners;

    // Check if we need to apply homography transform
    if (c && user.originalCorners && this.hasRemoteTransformedCorners(user)) {
      try {
        const homography = new Homography('projective');

        // Source points (original corners of the floating canvas)
        const srcPoints = [
          [user.originalCorners.tl.x, user.originalCorners.tl.y],
          [user.originalCorners.tr.x, user.originalCorners.tr.y],
          [user.originalCorners.bl.x, user.originalCorners.bl.y],
          [user.originalCorners.br.x, user.originalCorners.br.y]
        ];

        // Destination points (current corner positions, relative to output)
        const minX = Math.min(c.tl.x, c.tr.x, c.bl.x, c.br.x);
        const minY = Math.min(c.tl.y, c.tr.y, c.bl.y, c.br.y);

        const dstPoints = [
          [c.tl.x - minX, c.tl.y - minY],
          [c.tr.x - minX, c.tr.y - minY],
          [c.bl.x - minX, c.bl.y - minY],
          [c.br.x - minX, c.br.y - minY]
        ];

        homography.setSourcePoints(srcPoints, user.floatingCanvas);
        homography.setDestinyPoints(dstPoints);

        const result = homography.warp();
        if (result) {
          ctx.putImageData(result, minX, minY);
        } else {
          // Fallback to simple draw
          ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
        }
      } catch (e) {
        console.warn('Remote homography preview failed:', e);
        ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
      }
    } else {
      // No transform, simple draw at current position
      ctx.drawImage(user.floatingCanvas, s.x, s.y, s.width, s.height);
    }

    // Draw marching ants border (simple static version for remote)
    if (c) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(c.tl.x, c.tl.y);
      ctx.lineTo(c.tr.x, c.tr.y);
      ctx.lineTo(c.br.x, c.br.y);
      ctx.lineTo(c.bl.x, c.bl.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  handleRemoteCancel(user) {
    // Clear any in-progress drawing
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.clearLine();
    user.mousedown = false;
    user.startPos = null;
    user.pendingSelection = null;
  }

  drawRemotePendingSelection(user) {
    if (!user.pendingSelection) return;

    const ctx = user.context;
    const s = user.pendingSelection;

    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    ctx.strokeStyle = '#000';
    ctx.strokeRect(s.x, s.y, s.width, s.height);

    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 4;
    ctx.strokeRect(s.x, s.y, s.width, s.height);

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  commitRemoteLine(user) {
    user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    user.context.beginPath();
    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
    user.addToLine({ x: user.x, y: user.y });
  }

  drawLineArray(points, ctx, user) {
    if (points.length === 0) return;

    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  handleWSConnect(sessionIndex) {
    this.sessionIndex = sessionIndex;
    this.self.id = sessionIndex;
    this.users.set(sessionIndex, this.self);
    this.ui.showLogin();
  }

  handleWSDisconnect() {
    this.connected = false;
  }

  handleJoin() {
    this.connected = true;
    const name = this.ui.elements.usernameInput.value || 'Anon';
    this.self.setUsername(name);

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName(name);

    this.wsClient.broadcastNameChange(name);
  }

  startOfflineMode() {
    // Set up offline mode - no server connection needed
    this.connected = true;
    this.sessionIndex = 1;
    this.self.id = 1;
    this.self.setUsername('Offline');

    this.ui.hideOverlay();
    this.ui.showCursor();
    this.ui.updateSelfName('Offline');

    // Disconnect WebSocket if it was trying to connect
    if (this.wsClient && this.wsClient.disconnect) {
      this.wsClient.disconnect();
    }
  }

  selectTool(tool) {
    // Commit any in-progress stroke before switching tools
    if (this.self.mousedown) {
      if (this.self.tool === 'brush' && this.self.currentLine.length > 0) {
        const brushTool = this.toolManager.getTool('brush');
        brushTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      } else if (this.self.tool === 'pen' && this.self.penPoints && this.self.penPoints.length > 0) {
        const penTool = this.toolManager.getTool('pen');
        penTool.onPointerUp(this.self, { x: this.self.x, y: this.self.y });
      }
      this.self.mousedown = false;
      this.wsClient.broadcastMouseUp();
    }

    this.self.setTool(tool);
    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool);
    this.wsClient.broadcastToolChange(tool);

    // Show/hide brush gallery for gimp tool
    if (tool === 'gimp') {
      this.brushGallery.show();
    } else {
      this.brushGallery.hide();
    }
  }

  handleBrushSelect(brush) {
    // Apply the selected brush to self
    this.self.gBrush = brush;

    // Update the preview image
    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      this.ui.setGimpPreview(brush.gBrushes[0].gimpUrl);
    } else {
      this.ui.setGimpPreview(brush.gimpUrl);
    }

    // Broadcast brush to other users
    this.wsClient.broadcastGimp(brush);
  }

  handleClear() {
    this.board.clear();
    this.wsClient.broadcastClear();
  }

  handleResetBoard() {
    this.board.resetView();
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  handleToggleMirror() {
    const mirror = this.board.toggleMirror();
    this.ui.updateMirrorDisplay(mirror);
    this.wsClient.broadcastMirror();
  }

  handleZoomIn() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomIn(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  handleZoomOut() {
    const cursorPos = this.isOnBoard ? { x: this.self.x, y: this.self.y } : null;
    this.board.zoomOut(0.1, cursorPos);
    this.ui.updateZoomDisplay(this.board.getZoomPercent());
  }

  handleSizeChange(e) {
    const size = Number(e.target.value);
    this.self.setSize(size);
    this.ui.updateCursorSize(size);
    this.ui.updateSelfTextStyle(size, this.self.color);
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
  }

  handleSpacingChange(e) {
    const spacing = Number(e.target.value);
    this.self.setSpacing(spacing);
    this.wsClient.broadcastSpacingChange(spacing);
  }

  async handleGimpFileLoad(e) {
    const file = e.target.files[0];
    if (!file) return;

    const gimpTool = this.toolManager.getTool('gimp');
    const gimpData = await gimpTool.loadBrush(file, this.self);

    if (gimpData) {
      this.ui.setGimpPreview(gimpData.gimpUrl || gimpData.gBrushes[0].gimpUrl);
      this.wsClient.broadcastGimp(gimpData);
    }
  }

  handleChatSend(message) {
    this.chat.addMessage(message, this.self);
    this.wsClient.broadcastChat(message);
  }

  handlePointerMove(e) {
    const x = e.offsetX;
    const y = e.offsetY;

    let pressure = 1;
    if (e.pointerType === 'pen' && !this.self.panning) {
      const maxPressure = Number(this.ui.elements.pressureSlider.value) / 100;
      pressure = Math.min(maxPressure, Math.round(e.pressure * 100) / 100);
      this.self.setPressure(pressure);

      if (this.self.pressure !== this.self.prevpressure && this.self.mousedown && this.self.tool === 'brush') {
        this.wsClient.broadcastPressureChange(pressure);
        this.commitSelfLine();
      }
    }

    this.self.setPosition(x, y);
    this.ui.updateSelfCursor(x, y, this.self.size);
    this.wsClient.broadcastMouseMove(x, y, this.self.lastx, this.self.lasty);

    if (this.self.panning && this.self.mousedown) {
      this.board.pan(e.movementX, e.movementY);
    } else if (this.self.mousedown) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerMove(this.self, { x, y }, { x: this.self.lastx, y: this.self.lasty }, e);
      }
    }
  }

  handlePointerDown(e) {
    // Middle-click enables panning mode
    if (e.button === 1) {
      e.preventDefault();
      this.self.panning = true;
      this.wsClient.broadcastPan(true);
      return;
    }

    // Right-click cancels current stroke
    if (e.button === 2) {
      this.cancelCurrentStroke();
      return;
    }

    // Only draw with left-click (button === 0)
    if (e.button !== 0) return;

    if (e.pointerType === 'mouse') {
      this.self.setPressure(1);
      this.wsClient.broadcastPressureChange(1);
    }

    const pos = { x: e.offsetX, y: e.offsetY };
    this.self.lastx = this.self.x;
    this.self.lasty = this.self.y;
    this.self.mousedown = true;
    this.self.spaceIndex = 0;

    this.wsClient.broadcastMouseDown();

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerDown(this.self, pos, e);

        // If text tool was used to commit text, update UI to clear the text display
        if (this.self.tool === 'text') {
          this.ui.updateSelfTextInput(this.self.text);

          // Focus hidden input for touch keyboard support
          if (e.pointerType === 'touch' && this.ui.elements.touchInput) {
            this.ui.elements.touchInput.focus();
          }
        }
      }
    }
  }

  handlePointerUp(e) {
    // Middle-click release disables panning mode
    if (e.button === 1) {
      this.self.panning = false;
      this.wsClient.broadcastPan(false);
      return;
    }

    // Only handle left-click release for drawing
    if (e.button !== 0) return;

    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerUp(this.self, { x: this.self.x, y: this.self.y }, e);
      }
    }

    this.self.mousedown = false;
    this.wsClient.broadcastMouseUp();
  }

  handleWheel(e) {
    e.preventDefault();

    if (this.self.panning) {
      const cursorPos = { x: this.self.x, y: this.self.y };
      if (e.deltaY > 0) {
        this.board.zoomOut(0.1, cursorPos);
      } else {
        this.board.zoomIn(0.1, cursorPos);
      }
      this.ui.updateZoomDisplay(this.board.getZoomPercent());
    } else {
      this.handleSizeScroll(e.deltaY);
    }
  }

  handleSizeScroll(deltaY) {
    let size = this.self.size;
    let step = 1;

    if (size < 2) step = 0.25;
    else if (size < 4) step = 0.5;
    else if (size <= 30) step = 1;
    else step = 2;

    if (deltaY > 0 && size - step > 0) {
      size -= step;
    } else if (deltaY < 0 && size + step < 100) {
      size += step;
    } else {
      return;
    }

    if (this.self.mousedown && this.self.tool === 'brush') {
      this.commitSelfLine();
    }

    size = Math.round(size * 100) / 100;
    this.self.setSize(size);
    this.ui.elements.sizeSlider.value = size;
    this.ui.updateCursorSize(size);
    this.ui.updateSelfTextStyle(size, this.self.color);
    this.board.mainCtx.lineWidth = size * 2;
    this.wsClient.broadcastSizeChange(size);
  }

  commitSelfLine() {
    const brushTool = this.toolManager.getTool('brush');
    brushTool.commitCurrentLine(this.self);
  }

  cancelCurrentStroke() {
    // Always clear the top canvas
    this.board.clearTop();

    // Clear brush stroke data
    this.self.clearLine();

    // Clear pen stroke data
    this.self.penPoints = [];
    const penTool = this.toolManager.getTool('pen');
    if (penTool && penTool.clearStroke) {
      penTool.clearStroke();
    }

    // Clear shape tool data
    const lineTool = this.toolManager.getTool('line');
    if (lineTool) lineTool.startPos = null;
    const rectangleTool = this.toolManager.getTool('rectangle');
    if (rectangleTool) rectangleTool.startPos = null;
    const circleTool = this.toolManager.getTool('circle');
    if (circleTool) circleTool.startPos = null;

    // Clear select tool state
    const selectTool = this.toolManager.getTool('select');
    if (selectTool) {
      selectTool.isSelecting = false;
      selectTool.isDragging = false;
      selectTool.startPos = null;
    }

    this.self.mousedown = false;
    this.wsClient.broadcastCancel();
  }

  handlePointerLeave(e) {
    this.isOnBoard = false;
  }

  handleKeyDown(e) {
    if (e.key === '/' || e.key === "'") {
      e.preventDefault();
    }

    if (e.key === ' ' && this.self.tool !== 'text' && !this.self.panning && !this.self.mousedown) {
      this.self.panning = true;
      this.wsClient.broadcastPan(true);
    }

    this.wsClient.broadcastKeyPress(e.key);

    if (this.self.tool === 'text') {
      const textTool = this.toolManager.getTool('text');
      const text = textTool.onKeyPress(this.self, e.key);
      this.ui.updateSelfTextInput(text);
    } else if (this.connected) {
      // Handle selection tool shortcuts
      const selectTool = this.toolManager.getTool('select');

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'c':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.copy();
            }
            return;
          case 'x':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.cut();
            }
            return;
          case 'v':
            if (selectTool && selectTool.hasClipboard()) {
              e.preventDefault();
              this.selectTool('select');
              selectTool.paste();
            }
            return;
          case 'a':
            e.preventDefault();
            this.selectTool('select');
            selectTool.selectAll();
            return;
          case 'd':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.deselect();
            }
            return;
        }
      }

      // Delete/Backspace to delete selection
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.self.tool === 'select') {
        if (selectTool && selectTool.hasSelection()) {
          e.preventDefault();
          selectTool.deleteSelection();
        }
        return;
      }

      // Escape to deselect
      if (e.key === 'Escape' && this.self.tool === 'select') {
        if (selectTool && selectTool.hasSelection()) {
          selectTool.deselect();
        }
        return;
      }

      switch (e.key) {
        case 's':
          this.selectTool('select');
          break;
        case 'b':
          this.selectTool('brush');
          break;
        case 'p':
          this.selectTool('pen');
          break;
        case 'l':
          this.selectTool('line');
          break;
        case 'r':
          this.selectTool('rectangle');
          break;
        case 'c':
          this.selectTool('circle');
          break;
        case 't':
          this.selectTool('text');
          break;
        case 'e':
          this.selectTool('erase');
          break;
        case 'g':
          this.selectTool('gimp');
          break;
      }
    }
  }

  handleKeyUp(e) {
    if (e.key === ' ' && this.self.tool !== 'text') {
      this.self.panning = false;
      this.wsClient.broadcastPan(false);
    }
  }

  handleResize() {
    this.board.calculateDefaultView();
  }

  // Touch event handlers for pinch-to-zoom
  handleTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      this.touchState.isPinching = true;
      this.touchState.initialDistance = this.getTouchDistance(e.touches);
      this.touchState.initialZoom = this.board.zoom;
      this.touchState.centerPoint = this.getTouchCenter(e.touches);
    }
  }

  handleTouchMove(e) {
    if (this.touchState.isPinching && e.touches.length === 2) {
      e.preventDefault();

      const currentDistance = this.getTouchDistance(e.touches);
      const scale = currentDistance / this.touchState.initialDistance;
      const newZoom = this.touchState.initialZoom * scale;

      // Get center point for zoom
      const center = this.getTouchCenter(e.touches);
      const boardRect = this.ui.elements.boards.getBoundingClientRect();

      // Convert screen coordinates to canvas coordinates
      const canvasX = (center.x - boardRect.left - this.board.panX) / this.board.zoom;
      const canvasY = (center.y - boardRect.top - this.board.panY) / this.board.zoom;

      this.board.setZoom(newZoom, { x: canvasX, y: canvasY });
      this.ui.updateZoomDisplay(this.board.getZoomPercent());
    }
  }

  handleTouchEnd(e) {
    if (e.touches.length < 2) {
      this.touchState.isPinching = false;
      this.touchState.initialDistance = null;
      this.touchState.initialZoom = null;
      this.touchState.centerPoint = null;
    }
  }

  getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTouchCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  // Hidden input handlers for touch keyboard
  handleTouchInput(e) {
    if (this.self.tool !== 'text') return;

    const inputValue = e.target.value;
    const textTool = this.toolManager.getTool('text');

    // Handle each character typed
    if (e.inputType === 'insertText' && e.data) {
      for (const char of e.data) {
        textTool.onKeyPress(this.self, char);
        this.wsClient.broadcastKeyPress(char);
      }
    } else if (e.inputType === 'deleteContentBackward') {
      textTool.onKeyPress(this.self, 'Backspace');
      this.wsClient.broadcastKeyPress('Backspace');
    }

    this.ui.updateSelfTextInput(this.self.text);
    e.target.value = ''; // Clear input after processing
  }

  handleTouchInputBlur() {
    // Optionally handle when keyboard is dismissed
  }
}
