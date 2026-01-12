/**
 * EraseTool - Eraser tool
 */

import { Tool } from './Tool.js';
import { MessageType } from '../network/Protocol.js';

export class EraseTool extends Tool {
  constructor(stateManager, canvasManager, drawingEngine, wsClient) {
    super('erase', stateManager, canvasManager, drawingEngine, wsClient);
  }

  activate() {
    this.canvas.setCompositeOperation('destination-out');
    this.canvas.topCanvas.style.opacity = 1;

    // Show circle cursor
    const circleElement = document.querySelector('.circle.self');
    if (circleElement) {
      circleElement.style.display = 'block';
    }

    const textElement = document.querySelector('.text.self');
    if (textElement) {
      textElement.style.display = 'none';
    }

    const squareElement = document.querySelector('.square.self');
    if (squareElement) {
      squareElement.style.display = 'none';
    }
  }

  onPointerDown(e) {
    const user = this.localUser;
    if (user.panning) return;

    const pos = { x: e.offsetX, y: e.offsetY };

    user.mousedown = true;
    user.lastx = user.x;
    user.lasty = user.y;

    // Erase at current position
    const size = user.pressure * user.size * 2;
    this.drawing.eraseWithMirror(pos.x, pos.y, user.lastx, user.lasty, size, this.mirror);

    // Broadcast
    this.ws.broadcast(MessageType.POINTER_DOWN, {});
  }

  onPointerMove(e) {
    const user = this.localUser;
    if (!user.mousedown || user.panning) return;

    const pos = { x: e.offsetX, y: e.offsetY };
    const lastpos = { x: user.lastx, y: user.lasty };

    const size = user.pressure * user.size * 2;
    this.drawing.eraseWithMirror(pos.x, pos.y, lastpos.x, lastpos.y, size, this.mirror);
  }

  onPointerUp(e) {
    const user = this.localUser;

    user.mousedown = false;

    // Broadcast
    this.ws.broadcast(MessageType.POINTER_UP, {});
  }

  handleRemotePointerDown(data, user) {
    if (user.panning) return;

    user.mousedown = true;
    user.lastx = user.x;
    user.lasty = user.y;

    const pos = { x: user.x, y: user.y };
    const size = user.pressure * user.size * 2;
    this.drawing.eraseWithMirror(pos.x, pos.y, pos.x, pos.y, size, this.mirror);
  }

  handleRemotePointerMove(data, user) {
    if (!user.mousedown || user.panning) return;

    const pos = { x: user.x, y: user.y };
    const lastpos = { x: user.lastx, y: user.lasty };

    const size = user.pressure * user.size * 2;
    this.drawing.eraseWithMirror(pos.x, pos.y, lastpos.x, lastpos.y, size, this.mirror);
  }

  handleRemotePointerUp(data, user) {
    user.mousedown = false;
  }

  getCursorClass() {
    return 'circle';
  }
}
