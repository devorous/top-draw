/**
 * BrushTool - Freehand brush drawing tool
 */

import { Tool } from './Tool.js';
import { MessageType } from '../network/Protocol.js';
import { manhattanDistance } from '../utils/math.js';

export class BrushTool extends Tool {
  constructor(stateManager, canvasManager, drawingEngine, wsClient) {
    super('brush', stateManager, canvasManager, drawingEngine, wsClient);
  }

  activate() {
    this.canvas.setCompositeOperation('source-over');
  }

  onPointerDown(e) {
    const user = this.localUser;
    if (user.panning) return;

    const pos = { x: e.offsetX, y: e.offsetY };

    user.mousedown = true;
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;
    user.currentLine = [pos, pos];
    user.lineLength = 0;

    // Draw initial point
    this.drawing.drawLineArray(user.currentLine, this.canvas.topCtx, user);

    // Broadcast
    this.ws.broadcast(MessageType.POINTER_DOWN, {});
  }

  onPointerMove(e) {
    const user = this.localUser;
    if (!user.mousedown || user.panning) return;

    const pos = { x: e.offsetX, y: e.offsetY };
    const lastpos = { x: user.lastx, y: user.lasty };

    // Add point to line
    user.currentLine.push(pos);

    // Preview on top canvas
    this.canvas.clearTop();
    this.canvas.topCtx.beginPath();
    this.drawing.drawLineWithMirror(user.currentLine, this.canvas.topCtx, user, this.mirror);

    // Draw empty line on main canvas to fix opacity issue
    this.drawing.drawLineArray([], this.canvas.mainCtx, user);

    // Update line length
    user.lineLength += manhattanDistance(pos, lastpos);
  }

  onPointerUp(e) {
    const user = this.localUser;
    if (user.panning) return;

    // Commit line to main canvas
    if (user.currentLine.length > 0) {
      this.drawing.commitLine(user.currentLine, user, this.mirror);
    }

    user.mousedown = false;
    user.currentLine = [];
    user.lineLength = 0;

    // Broadcast
    this.ws.broadcast(MessageType.POINTER_UP, {});
  }

  onSizeChange(sizeDelta) {
    const user = this.localUser;

    // If drawing, commit current line before size change
    if (user.mousedown && user.currentLine.length > 0) {
      this.drawing.commitLine(user.currentLine, user, this.mirror);

      // Start new line from current position
      user.currentLine = [{ x: user.x, y: user.y }];
      user.lineLength = 0;
    }
  }

  handlePressureChange(pressure) {
    const user = this.localUser;

    if (user.mousedown && user.currentLine.length > 0) {
      // Commit current line at old pressure
      this.drawing.commitLine(user.currentLine, user, this.mirror);

      // Start new line at new pressure
      user.currentLine = [{ x: user.x, y: user.y }];
      user.lineLength = 0;
    }
  }

  handleRemotePointerDown(data, user) {
    if (user.panning) return;

    user.mousedown = true;
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;
    user.currentLine.push({ x: user.x, y: user.y });
  }

  handleRemotePointerMove(data, user) {
    if (!user.mousedown || user.panning) return;

    const pos = { x: user.x, y: user.y };
    const lastpos = { x: user.lastx, y: user.lasty };

    user.currentLine.push(pos);

    // Check if pressure changed
    if (user.pressure !== user.prevpressure) {
      // Commit to main canvas
      const userBoard = this.canvas.getUserBoard(user.id);
      if (userBoard) {
        userBoard.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        userBoard.context.beginPath();
      }

      this.drawing.drawLineWithMirror(user.currentLine, this.canvas.mainCtx, user, this.mirror);

      user.currentLine = [pos];
      user.lineLength = 0;
    } else {
      // Draw preview on user's board
      const userBoard = this.canvas.getUserBoard(user.id);
      if (userBoard) {
        userBoard.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.drawing.drawLineWithMirror(user.currentLine, userBoard.context, user, this.mirror);
      }
    }

    user.prevpressure = user.pressure;
  }

  handleRemotePointerUp(data, user) {
    if (user.panning) return;

    // Commit line
    this.drawing.drawLineWithMirror(user.currentLine, this.canvas.mainCtx, user, this.mirror);

    // Clear user's preview board
    const userBoard = this.canvas.getUserBoard(user.id);
    if (userBoard) {
      userBoard.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    user.currentLine = [];
    user.mousedown = false;
  }

  getCursorClass() {
    return 'circle';
  }
}
