/**
 * TextTool - Text input and drawing tool
 */

import { Tool } from './Tool.js';
import { MessageType } from '../network/Protocol.js';

export class TextTool extends Tool {
  constructor(stateManager, canvasManager, drawingEngine, wsClient) {
    super('text', stateManager, canvasManager, drawingEngine, wsClient);
  }

  activate() {
    this.canvas.setCompositeOperation('source-over');

    // Show text cursor
    const textElement = document.querySelector('.text.self');
    if (textElement) {
      textElement.style.display = 'block';
    }

    const circleElement = document.querySelector('.circle.self');
    if (circleElement) {
      circleElement.style.display = 'none';
    }
  }

  deactivate() {
    // Hide text cursor
    const textElement = document.querySelector('.text.self');
    if (textElement) {
      textElement.style.display = 'none';
    }

    // Clear any pending text
    const user = this.localUser;
    if (user) {
      user.text = '';
      const input = document.querySelector('.textInput.self');
      if (input) {
        input.innerHTML = '';
      }
    }
  }

  onPointerDown(e) {
    const user = this.localUser;

    if (user.text && user.text.trim() !== '') {
      // Draw the text
      this.drawing.drawText(user);

      // Clear text buffer
      user.text = '';
      const input = document.querySelector('.textInput.self');
      if (input) {
        input.innerHTML = '';
      }

      // Broadcast pointer down
      this.ws.broadcast(MessageType.POINTER_DOWN, {});
    }
  }

  onKeyDown(e) {
    const user = this.localUser;
    const input = document.querySelector('.textInput.self');
    if (!input) return;

    const key = e.key;

    if (key.length === 1) {
      // Single character
      const char = key === ' ' ? '&nbsp;' : key;
      input.innerHTML += char;
      user.text += char;

      this.ws.broadcast(MessageType.TEXT_INPUT, { key });
    } else {
      switch (key) {
        case 'Enter':
          // Clear text (don't draw)
          input.innerHTML = '';
          user.text = '';
          this.ws.broadcast(MessageType.TEXT_INPUT, { key });
          break;

        case 'Backspace':
          if (input.innerHTML.length > 0) {
            if (input.innerHTML.endsWith('&nbsp;')) {
              input.innerHTML = input.innerHTML.slice(0, -6);
              user.text = user.text.slice(0, -6);
            } else {
              input.innerHTML = input.innerHTML.slice(0, -1);
              user.text = user.text.slice(0, -1);
            }
            this.ws.broadcast(MessageType.TEXT_INPUT, { key });
          }
          break;
      }
    }
  }

  handleRemotePointerDown(data, user) {
    if (user.text && user.text.trim() !== '') {
      this.drawing.drawText(user);
      user.text = '';

      const input = document.querySelector(`.${user.id} .textInput`);
      if (input) {
        input.innerHTML = '';
      }
    }
  }

  handleRemoteKeyDown(data, user) {
    const input = document.querySelector(`.${user.id} .textInput`);
    if (!input) return;

    const key = data.key;

    if (key.length === 1) {
      const char = key === ' ' ? '&nbsp;' : key;
      input.innerHTML += char;
      user.text += char;
    } else {
      switch (key) {
        case 'Enter':
          input.innerHTML = '';
          user.text = '';
          break;

        case 'Backspace':
          if (input.innerHTML.length > 0) {
            if (input.innerHTML.endsWith('&nbsp;')) {
              input.innerHTML = input.innerHTML.slice(0, -6);
              user.text = user.text.slice(0, -6);
            } else {
              input.innerHTML = input.innerHTML.slice(0, -1);
              user.text = user.text.slice(0, -1);
            }
          }
          break;
      }
    }
  }

  getCursorClass() {
    return 'text';
  }
}
