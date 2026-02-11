/**
 * User class representing a drawing session participant
 */
export class User {
  constructor(id, options = {}) {
    this.id = id;
    this.x = options.x || 0;
    this.y = options.y || 0;
    this.lastx = null;
    this.lasty = null;
    this.size = options.size || 10;
    this.pressure = options.pressure || 1;
    this.prevpressure = 1;
    this.spacing = options.spacing || 0;
    this.smoothing = options.smoothing !== undefined ? options.smoothing : 0.3;  // Stroke stabilization (0-1), default 30%
    this.opacity = options.opacity || 1;       // Brush opacity (0-1)
    this.hardness = options.hardness !== undefined ? options.hardness : 1.0;  // Brush hardness (0-1), default 100%
    this.spaceIndex = 0;
    this.color = options.color || [0, 0, 0, 1];
    this.tool = options.tool || 'brush';
    this.text = options.text || '';
    this.mousedown = false;
    this.panning = false;
    this.username = options.username || '';
    this.context = options.context || null;
    this.board = options.board || null;
    this.imageBrush = null;
    this.blendMode = options.blendMode || 'source-over';
    this.currentLine = [];
    this.lineLength = 0;
    this.afk = options.afk || false;
    this.role = options.role || 0;  // 0=guest, 1=user, 2=mod, 3=admin
    this.isMuted = options.isMuted || false;
  }

  setAfk(afk) {
    this.afk = afk;
  }

  setPosition(x, y) {
    this.lastx = this.x;
    this.lasty = this.y;
    this.x = x;
    this.y = y;
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'text') {
      this.text = '';
    }
  }

  setColor(color) {
    this.color = color;
  }

  setSize(size) {
    this.size = size;
  }

  setPressure(pressure) {
    this.prevpressure = this.pressure;
    this.pressure = pressure;
  }

  setSpacing(spacing) {
    this.spacing = spacing;
  }

  setSmoothing(smoothing) {
    this.smoothing = smoothing;
  }

  setOpacity(opacity) {
    this.opacity = opacity;
  }

  setHardness(hardness) {
    this.hardness = hardness;
  }

  setUsername(username) {
    this.username = username;
  }

  startLine(pos) {
    this.currentLine = [pos];
    this.lineLength = 0;
  }

  addToLine(pos) {
    this.currentLine.push(pos);
  }

  clearLine() {
    this.currentLine = [];
    this.lineLength = 0;
  }

  getColorString() {
    return `rgba(${this.color.join(',')})`;
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      size: this.size,
      pressure: this.pressure,
      spacing: this.spacing,
      smoothing: this.smoothing,
      opacity: this.opacity,
      color: this.color,
      tool: this.tool,
      text: this.text,
      username: this.username,
      blendMode: this.blendMode
    };
  }

  updateFrom(data) {
    const fields = ['x', 'y', 'size', 'pressure', 'spacing', 'smoothing', 'opacity', 'color', 'tool', 'text', 'username', 'blendMode'];
    fields.forEach(field => {
      if (data[field] !== undefined) {
        this[field] = data[field];
      }
    });
  }
}
