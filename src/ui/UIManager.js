/**
 * UIManager - Manages UI elements like buttons, sliders, and color picker
 */

import { MessageType } from '../network/Protocol.js';

export class UIManager {
  #stateManager = null;
  #toolManager = null;
  #wsClient = null;
  #canvasManager = null;
  #picker = null;

  /**
   * Create a UIManager
   * @param {StateManager} stateManager - State manager
   * @param {ToolManager} toolManager - Tool manager
   * @param {WebSocketClient} wsClient - WebSocket client
   * @param {CanvasManager} canvasManager - Canvas manager
   */
  constructor(stateManager, toolManager, wsClient, canvasManager) {
    this.#stateManager = stateManager;
    this.#toolManager = toolManager;
    this.#wsClient = wsClient;
    this.#canvasManager = canvasManager;
  }

  /**
   * Initialize UI event listeners
   */
  init() {
    this.#initToolButtons();
    this.#initBoardButtons();
    this.#initSliders();
    this.#initColorPicker();
    this.#initGimpFileInput();
    this.#initSaveButton();
    this.#initKeyboardShortcuts();
  }

  #initToolButtons() {
    const buttons = {
      brushBtn: 'brush',
      textBtn: 'text',
      eraseBtn: 'erase',
      gimpBtn: 'gimp'
    };

    for (const [btnId, toolName] of Object.entries(buttons)) {
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', () => {
          this.#toolManager.switchTool(toolName);
        });
      }
    }
  }

  #initBoardButtons() {
    // Clear button
    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.#canvasManager.clearAll();
        this.#wsClient.broadcast(MessageType.BOARD_CLEAR, {});
      });
    }

    // Reset button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.#stateManager.dispatchEvent(new CustomEvent('viewport:reset'));
      });
    }

    // Mirror button
    const mirrorBtn = document.getElementById('mirrorBtn');
    if (mirrorBtn) {
      mirrorBtn.addEventListener('click', () => {
        const mirror = !this.#stateManager.get('mirror');
        this.#stateManager.set('mirror', mirror);

        const mirrorLine = document.querySelector('.mirrorLine');
        const mirrorText = document.querySelector('.mirrorOption');

        if (mirrorLine) {
          mirrorLine.style.display = mirror ? 'block' : 'none';
        }
        if (mirrorText) {
          mirrorText.textContent = mirror ? 'ON' : 'OFF';
        }

        this.#wsClient.broadcast(MessageType.BOARD_MIRROR, {});
      });
    }

    // Zoom buttons
    const plusBtn = document.getElementById('plusBtn');
    const minusBtn = document.getElementById('minusBtn');

    if (plusBtn) {
      plusBtn.addEventListener('click', () => {
        this.#stateManager.dispatchEvent(new CustomEvent('viewport:zoom', {
          detail: { delta: 0.1 }
        }));
      });
    }

    if (minusBtn) {
      minusBtn.addEventListener('click', () => {
        this.#stateManager.dispatchEvent(new CustomEvent('viewport:zoom', {
          detail: { delta: -0.1 }
        }));
      });
    }
  }

  #initSliders() {
    const sizeSlider = document.querySelector('.slider.size');
    const spacingSlider = document.querySelector('.slider.spacing');
    const pressureSlider = document.querySelector('.slider.pressure');

    if (sizeSlider) {
      sizeSlider.addEventListener('input', (e) => {
        const size = Number(e.target.value);
        const user = this.#stateManager.get('localUser');
        if (user) {
          user.size = size;
          this.#updateCursorSize(size);
          this.#wsClient.broadcast(MessageType.USER_SIZE, { size });
        }
      });
    }

    if (spacingSlider) {
      spacingSlider.addEventListener('input', (e) => {
        const spacing = Number(e.target.value);
        const user = this.#stateManager.get('localUser');
        if (user) {
          user.spacing = spacing;
          this.#wsClient.broadcast(MessageType.USER_SPACING, { spacing });
        }
      });
    }

    if (pressureSlider) {
      // Pressure slider limits max pressure sensitivity
      pressureSlider.addEventListener('input', (e) => {
        // Store max pressure setting
        const maxPressure = Number(e.target.value) / 100;
        const user = this.#stateManager.get('localUser');
        if (user) {
          user.maxPressure = maxPressure;
        }
      });
    }
  }

  #initColorPicker() {
    const pickerParent = document.getElementById('colorPicker');
    if (!pickerParent || typeof Picker === 'undefined') return;

    this.#picker = new Picker({
      parent: pickerParent,
      popup: false,
      alpha: true,
      editor: true,
      color: '#000',
      onChange: (color) => {
        const user = this.#stateManager.get('localUser');
        if (!user) return;

        const rgba = color.rgba;
        user.color = rgba;

        // Update text input color
        const textInput = document.querySelector('.text.self');
        if (textInput) {
          textInput.style.color = `rgba(${rgba.join(',')})`;
        }

        // Update user list color
        const listColor = document.querySelector('.userEntry.self .listColor');
        if (listColor) {
          listColor.style.backgroundColor = `rgba(${rgba.join(',')})`;
        }

        // Broadcast if connected
        if (this.#stateManager.get('connected')) {
          this.#wsClient.broadcast(MessageType.USER_COLOR, { color: rgba });
        }
      }
    });
  }

  #initGimpFileInput() {
    const fileInput = document.getElementById('gimp-file-input');
    if (!fileInput) return;

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const gimpTool = this.#toolManager.getTool('gimp');
      if (gimpTool && gimpTool.loadBrushFile) {
        await gimpTool.loadBrushFile(file);
      }
    });
  }

  #initSaveButton() {
    const saveBtn = document.getElementById('saveBtn');
    if (!saveBtn) return;

    saveBtn.addEventListener('click', () => {
      const dataURL = this.#canvasManager.toDataURL();
      const link = document.createElement('a');
      link.download = `${new Date().toString().slice(0, 24)}.png`;
      link.href = dataURL;
      link.click();
    });
  }

  #initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Don't handle shortcuts when in text tool
      const user = this.#stateManager.get('localUser');
      if (user && user.tool === 'text') return;
      if (!this.#stateManager.get('connected')) return;

      switch (e.key.toLowerCase()) {
        case 'b':
          this.#toolManager.switchTool('brush');
          break;
        case 't':
          this.#toolManager.switchTool('text');
          break;
        case 'e':
          this.#toolManager.switchTool('erase');
          break;
        case 'g':
          this.#toolManager.switchTool('gimp');
          break;
      }
    });
  }

  #updateCursorSize(size) {
    const circle = document.querySelector('.circle.self');
    const square = document.querySelector('.square.self');
    const text = document.querySelector('.text.self');
    const user = this.#stateManager.get('localUser');

    if (circle) {
      circle.setAttribute('r', size);
    }

    if (square && user) {
      square.setAttribute('width', size * 2);
      square.setAttribute('height', size * 2);
      square.setAttribute('x', user.x - size);
      square.setAttribute('y', user.y - size);
    }

    if (text) {
      text.style.fontSize = `${size + 5}px`;
    }
  }

  /**
   * Handle wheel event for size change
   * @param {WheelEvent} e - Wheel event
   */
  handleWheelSize(e) {
    const user = this.#stateManager.get('localUser');
    if (!user || user.panning) return;

    const sizeSlider = document.querySelector('.slider.size');
    let size = Number(sizeSlider?.value || user.size);

    // Calculate step based on current size
    let step = 1;
    if (size < 2) step = 0.25;
    else if (size < 4) step = 0.5;
    else if (size <= 30) step = 1;
    else step = 2;

    if (e.deltaY > 0) {
      // Scrolling down - decrease size
      size = Math.max(0.25, size - step);
    } else {
      // Scrolling up - increase size
      size = Math.min(100, size + step);
    }

    size = Math.round(size * 100) / 100;

    // Update user and slider
    user.size = size;
    if (sizeSlider) {
      sizeSlider.value = size;
      sizeSlider.step = step;
    }

    this.#updateCursorSize(size);
    this.#wsClient.broadcast(MessageType.USER_SIZE, { size });

    // Notify tool of size change
    this.#toolManager.handleSizeChange(step * (e.deltaY > 0 ? -1 : 1));
  }
}
