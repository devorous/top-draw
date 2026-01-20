import { User } from './User.js';
import { Board } from './Board.js';
import { ToolManager, BrushTool } from './Tools.js';
import { WebSocketClient } from './WebSocketClient.js';
import { Chat } from './Chat.js';
import { UI } from './UI.js';
import { manhattanDistance, mirrorLine } from './utils/drawing.js';

/**
 * Main application class
 */
export class DrawingApp {
  constructor(options = {}) {
    this.userId = Math.floor(Math.random() * 9999999);
    this.users = new Map();
    this.connected = false;

    this.board = new Board({
      dimensions: options.dimensions || [720, 1280]
    });

    this.toolManager = new ToolManager(this.board);
    this.ui = new UI();
    this.chat = new Chat({
      onSend: (message) => this.handleChatSend(message)
    });

    this.wsClient = new WebSocketClient({
      serverUrl: options.serverUrl,
      onConnect: () => this.handleWSConnect(),
      onDisconnect: () => this.handleWSDisconnect()
    });

    this.self = null;
    this.colorPicker = null;
    this.isOnBoard = false;
  }

  init() {
    this.ui.init();
    this.board.init('#boardContainer');
    this.chat.init();

    this.createSelf();
    this.setupColorPicker();
    this.setupEventListeners();
    this.setupWebSocketHandlers();

    this.toolManager.setTool('brush');
    this.ui.updateToolDisplay('brush');

    this.wsClient.connect(this.userId, this.self.toJSON());
  }

  createSelf() {
    this.self = new User(this.userId, {
      context: this.board.topCtx,
      board: this.board.mainCanvas
    });
    this.users.set(this.userId, this.self);
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

    elements.joinBtn.addEventListener('click', () => this.handleJoin());
    elements.brushBtn.addEventListener('click', () => this.selectTool('brush'));
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
    elements.board.addEventListener('pointerleave', () => { this.isOnBoard = false; });
    elements.board.addEventListener('wheel', (e) => this.handleWheel(e));

    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keyup', (e) => this.handleKeyUp(e));

    window.addEventListener('resize', () => this.handleResize());
  }

  setupWebSocketHandlers() {
    this.wsClient.on('connected', () => {});

    this.wsClient.on('currentUsers', (data) => {
      data.users.forEach(userData => {
        if (userData.id !== this.userId && !this.users.has(userData.id)) {
          const user = new User(userData.id, {
            ...userData.userdata,
            afk: userData.afk || false
          });
          this.users.set(userData.id, user);

          const boardData = this.ui.createUserBoard(userData.id);
          user.board = boardData.board;
          user.context = boardData.context;

          this.ui.createRemoteUser(userData.id, userData.userdata);

          // Apply initial AFK status
          if (userData.afk) {
            this.ui.setRemoteUserAfk(userData.id, true);
          }
        }
      });
    });

    this.wsClient.on('boardSettings', (data) => {
      this.board.setMirror(data.settings.mirror);
      this.ui.updateMirrorDisplay(data.settings.mirror);
    });

    this.wsClient.on('userLeft', (data) => {
      const user = this.users.get(data.id);
      if (user) {
        this.chat.addSystemMessage(`${user.username || 'User'} has left the room`);
        this.users.delete(data.id);
        this.ui.removeRemoteUser(data.id);
      }
    });

    this.wsClient.on('broadcast', (data) => this.handleBroadcast(data));
  }

  handleBroadcast(data) {
    const user = this.users.get(data.id);
    if (!user) return;

    switch (data.type) {
      case 'clear':
        this.board.clear();
        break;

      case 'pan':
        user.panning = data.value;
        break;

      case 'Mm':
        this.handleRemoteMouseMove(user, data);
        break;

      case 'Md':
        this.handleRemoteMouseDown(user, data);
        break;

      case 'Mu':
        this.handleRemoteMouseUp(user, data);
        break;

      case 'ChSi':
        user.setSize(data.size);
        this.ui.updateRemoteSize(data.id, data.size);
        if (user.mousedown && user.tool === 'brush') {
          this.commitRemoteLine(user);
        }
        break;

      case 'ChSp':
        user.setSpacing(data.spacing);
        break;

      case 'ChT':
        user.setTool(data.tool);
        this.ui.updateRemoteToolDisplay(data.id, data.tool);
        break;

      case 'ChC':
        user.setColor(data.color);
        this.ui.updateRemoteColor(data.id, data.color);
        break;

      case 'ChP':
        user.setPressure(data.pressure);
        break;

      case 'ChNa':
        user.setUsername(data.name);
        this.ui.updateRemoteName(data.id, data.name);
        this.chat.addSystemMessage(`${data.name} joined the room`);
        break;

      case 'kp':
        if (user.tool === 'text') {
          this.handleRemoteKeyPress(user, data.key);
        }
        break;

      case 'gimp':
        this.handleRemoteGimpLoad(user, data.gimpData);
        break;

      case 'mirror':
        const mirror = this.board.toggleMirror();
        this.ui.updateMirrorDisplay(mirror);
        break;

      case 'chat':
        this.chat.addMessage(data.message, user);
        break;

      case 'afkStatus':
        if (user) {
          user.setAfk(data.afk);
          this.ui.setRemoteUserAfk(data.id, data.afk);
        }
        break;
    }
  }

  handleRemoteMouseMove(user, data) {
    if (user.lastx === null) {
      user.lastx = data.x;
      user.lasty = data.y;
    }

    const lastPos = { x: user.x, y: user.y };
    user.setPosition(data.x, data.y);
    const pos = { x: user.x, y: user.y };

    this.ui.updateRemoteCursor(data.id, user.x, user.y, user.size);

    if (!user.panning && user.mousedown) {
      if (user.tool === 'brush') {
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
      } else if (user.tool === 'erase') {
        const eraserTool = this.toolManager.getTool('erase');
        eraserTool.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2);
        if (this.board.mirror) {
          const w = this.board.getWidth();
          eraserTool.erase(w - pos.x, pos.y, w - lastPos.x, lastPos.y, user.pressure * user.size * 2);
        }
      } else if (user.tool === 'gimp' && user.gBrush) {
        const gimpTool = this.toolManager.getTool('gimp');
        gimpTool.draw(user, pos);
      }
    }

    user.lastx = data.x;
    user.lasty = data.y;
  }

  handleRemoteMouseDown(user) {
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;

    const pos = { x: user.x, y: user.y };

    if (user.tool === 'brush' && !user.panning) {
      user.addToLine(pos);
    } else if (user.tool === 'text' && user.text) {
      const textTool = this.toolManager.getTool('text');
      textTool.drawText(user);
      user.text = '';
      this.ui.updateRemoteText(user.id, '');
    } else if (user.tool === 'erase' && !user.panning) {
      const eraserTool = this.toolManager.getTool('erase');
      eraserTool.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2);
    } else if (user.tool === 'gimp' && user.gBrush && !user.panning) {
      const gimpTool = this.toolManager.getTool('gimp');
      gimpTool.draw(user, pos);
    }

    user.mousedown = true;
  }

  handleRemoteMouseUp(user) {
    if (user.tool === 'brush' && !user.panning) {
      this.drawLineArray(user.currentLine, this.board.mainCtx, user);
      if (this.board.mirror) {
        const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
        this.drawLineArray(mirrored, this.board.mainCtx, user);
      }
      user.context.clearRect(0, 0, this.board.getWidth(), this.board.getHeight());
    }
    user.clearLine();
    user.mousedown = false;
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

  handleRemoteGimpLoad(user, gimpData) {
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

  handleWSConnect() {
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

  selectTool(tool) {
    this.self.setTool(tool);
    this.toolManager.setTool(tool);
    this.ui.updateToolDisplay(tool);
    this.wsClient.broadcastToolChange(tool);
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
    this.wsClient.broadcastMouseMove(x, y);

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
      }
    }
  }

  handlePointerUp(e) {
    if (!this.self.panning) {
      const tool = this.toolManager.getCurrentTool();
      if (tool) {
        tool.onPointerUp(this.self, { x: e.offsetX, y: e.offsetY }, e);
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
      switch (e.key) {
        case 'b':
          this.selectTool('brush');
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
}
