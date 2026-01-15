/**
 * WebSocket client for real-time communication
 */
export class WebSocketClient {
  constructor(options = {}) {
    this.socket = null;
    this.userId = null;
    this.connected = false;
    this.messageHandlers = new Map();
    this.onConnect = options.onConnect || null;
    this.onDisconnect = options.onDisconnect || null;
    this.serverUrl = options.serverUrl || null;
  }

  connect(userId, userData) {
    this.userId = userId;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // In development, use the Vite proxy; in production, connect directly
    const url = this.serverUrl || `${wsProtocol}://${window.location.hostname}:${window.location.port}/ws`;

    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.connected = true;
      this.send({
        command: 'connect',
        userdata: userData,
        id: userId
      });
      console.log('WebSocket connected!');
      if (this.onConnect) {
        this.onConnect();
      }
    };

    this.socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.socket.onclose = () => {
      this.connected = false;
      console.log('WebSocket disconnected');
      if (this.onDisconnect) {
        this.onDisconnect();
      }
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleMessage(data) {
    const handler = this.messageHandlers.get(data.command);
    if (handler) {
      handler(data);
    }

    const broadcastHandler = this.messageHandlers.get(`broadcast:${data.type}`);
    if (data.command === 'broadcast' && broadcastHandler) {
      broadcastHandler(data);
    }
  }

  on(event, handler) {
    this.messageHandlers.set(event, handler);
  }

  onBroadcast(type, handler) {
    this.messageHandlers.set(`broadcast:${type}`, handler);
  }

  send(data) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  broadcast(type, data = {}) {
    this.send({
      command: 'broadcast',
      type,
      id: this.userId,
      ...data
    });
  }

  broadcastMouseMove(x, y, lastx, lasty) {
    this.broadcast('Mm', { x, y, lastx, lasty });
  }

  broadcastMouseDown() {
    this.broadcast('Md');
  }

  broadcastMouseUp() {
    this.broadcast('Mu');
  }

  broadcastToolChange(tool) {
    this.broadcast('ChT', { tool });
  }

  broadcastColorChange(color) {
    this.broadcast('ChC', { color });
  }

  broadcastSizeChange(size) {
    this.broadcast('ChSi', { size });
  }

  broadcastSpacingChange(spacing) {
    this.broadcast('ChSp', { spacing });
  }

  broadcastPressureChange(pressure) {
    this.broadcast('ChP', { pressure });
  }

  broadcastNameChange(name) {
    this.broadcast('ChNa', { name });
  }

  broadcastKeyPress(key) {
    this.broadcast('kp', { key });
  }

  broadcastPan(value) {
    this.broadcast('pan', { value });
  }

  broadcastClear() {
    this.broadcast('clear');
  }

  broadcastMirror() {
    this.broadcast('mirror');
  }

  broadcastChat(message) {
    this.broadcast('chat', { message });
  }

  broadcastGimp(gimpData) {
    this.broadcast('gimp', { gimpData });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
  }
}
