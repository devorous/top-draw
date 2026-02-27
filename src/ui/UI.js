import { EditableValueHandler } from './EditableValueHandler.js';
import { RemoteUserUI } from './RemoteUserUI.js';
import { LayerPreview } from './LayerPreview.js';

/**
 * UI Manager for handling DOM interactions
 */
export class UI {
  constructor() {
    this.elements = {};
    this.icons = {};
    this.cursors = new Map();
    this.editableHandler = new EditableValueHandler();
    this.remoteUserUI = null; // Initialized after icons are created
    this.layerPreview = new LayerPreview();
  }

  init() {
    this.cacheElements();
    this.createIcons();
    this.remoteUserUI = new RemoteUserUI(this.elements, this.icons);
    this.layerPreview.init();
  }

  /**
   * Setup hover listeners for layer buttons to show miniatures
   * @param {LayerManager} layerManager - Reference to the layer system
   */
  setupLayerPreviewListeners(layerManager) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      btn.addEventListener('mouseenter', (e) => {
        const layerIdx = parseInt(btn.dataset.layer);
        const rect = btn.getBoundingClientRect();
        this.layerPreview.show(layerIdx, layerManager, rect.right, rect.top + rect.height / 2);
      });

      btn.addEventListener('mouseleave', () => {
        this.layerPreview.hide();
      });
    });
  }

  cacheElements() {
    this.elements = {
      overlay: document.getElementById('overlay'),
      login: document.getElementById('login'),
      connecting: document.getElementById('connecting'),
      joinBtn: document.getElementById('joinBtn'),
      offlineBtn: document.getElementById('offlineBtn'),
      loginOfflineBtn: document.getElementById('loginOfflineBtn'),
      loginUsername: document.getElementById('loginUsername'),

      boardContainer: document.getElementById('boardContainer'),
      boards: document.getElementById('boards'),
      board: document.getElementById('board'),
      topBoard: document.getElementById('topBoard'),
      userBoards: document.getElementById('userBoards'),

      cursorsSvg: document.getElementById('cursorsSvg'),
      selfCursor: document.querySelector('.cursor.self'),
      selfCircle: document.querySelector('.circle.self'),
      selfSquare: document.querySelector('.square.self'),
      selfCrosshair: document.querySelector('.crosshair.self'),
      selfHand: document.querySelector('.hand.self'),
      selfMutedIndicator: document.querySelector('.mutedIndicator.self'),
      selfText: document.querySelector('.text.self'),
      selfTextInput: document.querySelector('.textInput.self'),
      selfName: document.querySelector('.name.self'),
      mirrorLine: document.querySelector('.mirrorLine'),

      panBtn: document.getElementById('panBtn'),
      rotateBtn: document.getElementById('rotateBtn'),
      selectBtn: document.getElementById('selectBtn'),
      brushBtn: document.getElementById('brushBtn'),
      lineBtn: document.getElementById('lineBtn'),
      rectangleBtn: document.getElementById('rectangleBtn'),
      circleBtn: document.getElementById('circleBtn'),
      textBtn: document.getElementById('textBtn'),
      eraseBtn: document.getElementById('eraseBtn'),
      blurBtn: document.getElementById('blurBtn'),
      circleBlurBtn: document.getElementById('circleBlurBtn'),
      imageBrushBtn: document.getElementById('imageBrushBtn'),
      inkdropperBtn: document.getElementById('inkdropperBtn'),

      clearBtn: document.getElementById('clearBtn'),
      resetBtn: document.getElementById('resetBtn'),
      mirrorBtn: document.getElementById('mirrorBtn'),
      plusBtn: document.getElementById('plusBtn'),
      minusBtn: document.getElementById('minusBtn'),
      rotationResetBtn: document.getElementById('rotationResetBtn'),
      zoomPercent: document.querySelector('.zoomPercent'),
      hudUndoBtn: document.getElementById('hudUndoBtn'),
      hudRedoBtn: document.getElementById('hudRedoBtn'),
      mirrorText: document.querySelector('.mirrorOption'),

      devBtn: document.getElementById('devBtn'),
      devText: document.querySelector('.devOption'),
      debugOverlay: document.getElementById('debugOverlay'),

      chatBtn: document.getElementById('chatBtn'),
      saveBtn: document.getElementById('saveBtn'),

      sizeSlider: document.querySelector('.slider.size'),
      spacingSlider: document.querySelector('.slider.spacing'),
      pressureMinSlider: document.getElementById('pressureMinSlider'),
      pressureMaxSlider: document.getElementById('pressureMaxSlider'),
      pressureEnabled: document.getElementById('pressureEnabled'),
      pressureDualSlider: document.getElementById('pressureDualSlider'),
      pressureContainer: document.getElementById('pressure-container'),
      smoothingSlider: document.querySelector('.slider.smoothing'),
      hardnessSlider: document.querySelector('.slider.hardness'),
      opacitySlider: document.querySelector('.slider.opacity'),
      blurRadiusSlider: document.querySelector('.slider.blurRadius'),

      sizeValue: document.getElementById('sizeValue'),
      pressureValue: document.getElementById('pressureValue'),
      smoothingValue: document.getElementById('smoothingValue'),
      spacingValue: document.getElementById('spacingValue'),
      hardnessValue: document.getElementById('hardnessValue'),
      opacityValue: document.getElementById('opacityValue'),
      blurRadiusValue: document.getElementById('blurRadiusValue'),

      brushFileInput: document.getElementById('brush-file-input'),
      brushImage: document.getElementById('brushImage'),
      brushSpacing: document.getElementById('brush-spacing'),
      brushHardness: document.getElementById('brush-hardness'),
      opacityContainer: document.getElementById('brush-opacity'),
      blurRadiusContainer: document.getElementById('blur-radius'),

      selectionModeOptions: document.getElementById('selectionModeOptions'),
      eraserModeOptions: document.getElementById('eraserModeOptions'),
      brushModeOptions: document.getElementById('brushModeOptions'),
      blendModeOptions: document.getElementById('blendModeOptions'),
      blendModeSelect: document.getElementById('blendModeSelect'),
      layerPanel: document.getElementById('layerPanel'),
      layerList: document.getElementById('layerList'),

      // Lock buttons
      sizeLock: document.getElementById('sizeLock'),
      pressureLock: document.getElementById('pressureLock'),
      smoothingLock: document.getElementById('smoothingLock'),
      spacingLock: document.getElementById('spacingLock'),
      hardnessLock: document.getElementById('hardnessLock'),
      opacityLock: document.getElementById('opacityLock'),
      blurRadiusLock: document.getElementById('blurRadiusLock'),

      colorPicker: document.getElementById('colorPicker'),

      touchInput: document.getElementById('touchInput'),

      bottomBar: document.getElementById('bottomBar'),
      undoBtn: document.getElementById('undoBtn'),
      timeline: document.getElementById('timeline'),

      userList: document.getElementById('userList'),
      selfUserEntry: document.querySelector('.userEntry.self'),
      selfListTool: document.querySelector('.listTool.self'),
      selfListColor: document.querySelector('.listColor.self'),
      selfListUser: document.querySelector('.listUser.self'),
      selfListActive: document.querySelector('.listActive.self'),

      toast: document.getElementById('toast'),

      connectionStatus: document.getElementById('connectionStatus'),
      connectionDot: document.querySelector('.connectionDot'),
      connectionText: document.querySelector('.connectionText'),
      reconnectBtn: document.getElementById('reconnectBtn'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      userContextMenu: document.getElementById('userContextMenu'),
      modPanel: document.getElementById('modPanel'),
      modBtn: document.getElementById('modBtn')
    };
  }

  createIcons() {
    this.icons = {
      select: this.createIcon('images/select-icon.svg'),
      brush: this.createIcon('images/brush-icon.svg'),
      pen: this.createIcon('images/pen-icon.svg'),
      flowPen: this.createIcon('images/pen-icon.svg'),
      ink: this.createIcon('images/brush-icon.svg'),
      line: this.createIcon('images/line-icon.svg'),
      rectangle: this.createIcon('images/rectangle-icon.svg'),
      circle: this.createIcon('images/circle-icon.svg'),
      text: this.createIcon('images/text-icon.svg'),
      erase: this.createIcon('images/eraser-icon.svg'),
      blur: this.createIcon('images/brush-icon.svg'),
      circleBlur: this.createIcon('images/circle-icon.svg'),
      imageBrush: this.createIcon('images/pepper.png')
    };
  }

  createIcon(src) {
    const img = document.createElement('img');
    img.className = 'toolIcon';
    img.src = src;
    return img;
  }

  showLogin() {
    this.elements.login.style.display = 'block';
    this.elements.connecting.style.display = 'none';
  }

  hideOverlay() {
    this.elements.overlay.style.display = 'none';
  }

  showCursor() {
    // Show name (cursor div) - cursor shapes managed by updateToolDisplay()
    this.elements.selfCursor.style.display = 'block';
  }

  hideCursor() {
    // Hide everything: name and all cursor shapes
    this.elements.selfCursor.style.display = 'none';
    this.elements.selfCircle.style.display = 'none';
    this.elements.selfSquare.style.display = 'none';
    this.elements.selfCrosshair.style.display = 'none';
    this.elements.selfText.style.display = 'none';
  }

  updateSelfCursor(x, y, size) {
    const cursor = this.elements.selfCursor;
    const circle = this.elements.selfCircle;
    const square = this.elements.selfSquare;
    const crosshair = this.elements.selfCrosshair;
    const hand = this.elements.selfHand;
    const mutedIndicator = this.elements.selfMutedIndicator;

    cursor.style.left = `${x - 100}px`;
    cursor.style.top = `${y - 100}px`;
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    square.setAttribute('x', x - size);
    square.setAttribute('y', y - size);
    crosshair.setAttribute('transform', `translate(${x}, ${y})`);
    if (hand) {
      hand.setAttribute('transform', `translate(${x}, ${y})`);
    }
    if (mutedIndicator) {
      mutedIndicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  updateCursorSize(size) {
    this.elements.selfCircle.setAttribute('r', size);
    this.elements.selfSquare.setAttribute('width', size * 2);
    this.elements.selfSquare.setAttribute('height', size * 2);
  }

  setSelectCursor(isHand) {
    if (isHand) {
      this.elements.selfCrosshair.style.display = 'none';
      this.elements.selfHand.style.display = 'block';
    } else {
      this.elements.selfCrosshair.style.display = 'block';
      this.elements.selfHand.style.display = 'none';
    }
  }

  setMutedState(muted) {
    const indicator = this.elements.selfMutedIndicator;
    const circle = this.elements.selfCircle;
    if (indicator) {
      indicator.style.display = muted ? 'block' : 'none';
    }
    if (circle) {
      circle.setAttribute('stroke', muted ? '#ef4444' : 'grey');
    }
  }

  updateMutedIndicatorPosition(x, y) {
    const indicator = this.elements.selfMutedIndicator;
    if (indicator) {
      indicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  updateToolDisplay(tool) {
    const { selfCircle, selfSquare, selfCrosshair, selfHand, selfText, brushImage, brushFileInput, brushSpacing, brushHardness, opacityContainer, blurRadiusContainer, selectionModeOptions, eraserModeOptions, brushModeOptions, smoothingSlider } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfHand.style.display = 'none';
    selfText.style.display = 'none';
    brushImage.style.display = 'none';
    brushFileInput.style.display = 'none';
    brushSpacing.style.display = 'none';
    brushHardness.style.display = 'none';
    opacityContainer.style.display = 'block';
    if (blurRadiusContainer) {
      blurRadiusContainer.style.display = 'none';
    }
    if (selectionModeOptions) {
      selectionModeOptions.style.display = 'none';
    }
    if (eraserModeOptions) {
      eraserModeOptions.style.display = 'none';
    }
    if (brushModeOptions) {
      brushModeOptions.style.display = 'none';
    }
    // Show smoothing by default
    if (smoothingSlider && smoothingSlider.parentElement) {
      smoothingSlider.parentElement.style.display = 'block';
    }

    switch (tool) {
      case 'select':
        selfCrosshair.style.display = 'block';
        if (selectionModeOptions) {
          selectionModeOptions.style.display = 'block';
        }
        break;
      case 'brush':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        if (brushModeOptions) {
          brushModeOptions.style.display = 'block';
        }
        break;
      case 'flowPen':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        if (brushModeOptions) {
          brushModeOptions.style.display = 'block';
        }
        break;
      case 'ink':
        selfCircle.style.display = 'block';
        if (brushModeOptions) {
          brushModeOptions.style.display = 'block';
        }
        break;
      case 'line':
      case 'rectangle':
      case 'circle':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        break;
      case 'text':
        selfText.style.display = 'block';
        break;
      case 'erase':
        selfCircle.style.display = 'block';
        if (eraserModeOptions) {
          eraserModeOptions.style.display = 'block';
        }
        break;
      case 'circleBlur':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        break;
      case 'blur':
        selfSquare.style.display = 'block';
        if (blurRadiusContainer) {
          blurRadiusContainer.style.display = 'block';
        }
        // Hide smoothing for blur tool
        if (smoothingSlider && smoothingSlider.parentElement) {
          smoothingSlider.parentElement.style.display = 'none';
        }
        break;
      case 'imageBrush':
        selfSquare.style.display = 'block';
        // brushImage is shown only when a brush is selected (via setBrushPreview)
        brushFileInput.style.display = 'block';
        brushSpacing.style.display = 'block';
        break;
      case 'inkdropper':
        selfCrosshair.style.display = 'block';
        break;
      case 'pan':
        selfHand.style.display = 'block';
        opacityContainer.style.display = 'none';
        if (smoothingSlider && smoothingSlider.parentElement) {
          smoothingSlider.parentElement.style.display = 'none';
        }
        break;
      case 'rotate':
        selfCrosshair.style.display = 'block';
        opacityContainer.style.display = 'none';
        if (smoothingSlider && smoothingSlider.parentElement) {
          smoothingSlider.parentElement.style.display = 'none';
        }
        break;
    }

    this.updateToolButton(tool);
  }

  updateToolButton(tool) {
    const buttons = {
      pan: this.elements.panBtn,
      rotate: this.elements.rotateBtn,
      select: this.elements.selectBtn,
      brush: this.elements.brushBtn,
      line: this.elements.lineBtn,
      rectangle: this.elements.rectangleBtn,
      circle: this.elements.circleBtn,
      text: this.elements.textBtn,
      erase: this.elements.eraseBtn,
      blur: this.elements.blurBtn,
      circleBlur: this.elements.circleBlurBtn,
      imageBrush: this.elements.imageBrushBtn,
      inkdropper: this.elements.inkdropperBtn
    };

    Object.values(buttons).forEach(btn => btn && btn.classList.remove('selected'));
    // Map flowPen/ink to brush button (unified brush)
    const buttonTool = (tool === 'flowPen' || tool === 'ink') ? 'brush' : tool;
    if (buttons[buttonTool]) {
      buttons[buttonTool].classList.add('selected');
    }

    const toolIcon = this.icons[tool];
    if (toolIcon) {
      const toolEntry = this.elements.selfListTool;
      if (toolEntry.children[0]) {
        toolEntry.children[0].remove();
      }
      toolEntry.appendChild(toolIcon.cloneNode(true));
    }
  }

  updateZoomDisplay(percent) {
    this.elements.zoomPercent.textContent = percent;
  }

  updateMirrorDisplay(enabled) {
    this.elements.mirrorText.textContent = enabled ? 'ON' : 'OFF';
  }

  updateDevModeDisplay(enabled) {
    this.elements.devText.textContent = enabled ? 'ON' : 'OFF';
    this.elements.devText.classList.toggle('active', enabled);
  }

  updateBrushModeDisplay(mode) {
    const radios = document.querySelectorAll('input[name="brushMode"]');
    radios.forEach(r => {
      r.checked = (r.value === mode);
    });
  }

  updateActiveLayerDisplay(layerIndex) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      const btnLayer = parseInt(btn.dataset.layer);
      btn.classList.toggle('active', btnLayer === layerIndex);
    });
  }

  updateBlendModeDisplay(blendMode) {
    if (this.elements.blendModeSelect) {
      this._updatingBlendMode = true;  // Set flag to prevent change event
      this.elements.blendModeSelect.value = blendMode;
      this._updatingBlendMode = false;  // Clear flag
    }
  }

  updateSelfColor(color) {
    this.elements.selfListColor.style.backgroundColor = `rgba(${color.join(',')})`;
  }

  updateSelfTextInput(text) {
    this.elements.selfTextInput.innerHTML = text;
  }

  updateSelfName(name) {
    this.elements.selfName.textContent = name;
    this.elements.selfListUser.textContent = name;
  }

  updateSelfTextStyle(size, color) {
    this.elements.selfText.style.fontSize = `${size + 5}px`;
    // Square the alpha to match board rendering (globalAlpha * colorAlpha)
    const [r, g, b, a] = color;
    this.elements.selfText.style.color = `rgba(${r}, ${g}, ${b}, ${a * a})`;
  }

  /**
   * Move and focus the hidden touch input to trigger the virtual keyboard.
   * Moving it to the touch location makes the trigger more reliable on some OSs.
   * @param {number} x - Screen X (clientX)
   * @param {number} y - Screen Y (clientY)
   */
  activateTouchInput(x, y) {
    const input = this.elements.touchInput;
    if (!input) return;

    // Move to touch location
    input.style.left = `${x}px`;
    input.style.top = `${y}px`;
    
    // Set a placeholder space so the virtual keyboard enables the backspace key
    input.value = ' ';
    
    // Temporarily enable pointer events so the OS sees this as a valid target
    input.style.pointerEvents = 'auto';
    
    // Use timeout to ensure browser state is settled before requesting keyboard
    setTimeout(() => {
      input.focus();
      // Keep pointer-events active for a moment to 'bless' the focus
      setTimeout(() => {
        input.style.pointerEvents = 'none';
      }, 500);
    }, 10);
  }

  setBrushPreview(url) {
    this.elements.brushImage.src = url;
    this.elements.brushImage.style.display = 'block';
  }

  updateSizeValue(size) {
    if (this.elements.sizeValue) {
      this.elements.sizeValue.textContent = size;
    }
  }

  updatePressureValue(min, max) {
    if (this.elements.pressureValue) {
      if (max === undefined) {
        // Legacy single-value call: treat as max with min=0
        this.elements.pressureValue.textContent = `0-${min}`;
      } else {
        this.elements.pressureValue.textContent = `${min}-${max}`;
      }
    }
  }

  updateSmoothingValue(smoothing) {
    if (this.elements.smoothingValue) {
      this.elements.smoothingValue.textContent = `${smoothing}%`;
    }
  }

  updateSpacingValue(spacing) {
    if (this.elements.spacingValue) {
      this.elements.spacingValue.textContent = spacing;
    }
  }

  updateHardnessValue(hardness) {
    if (this.elements.hardnessValue) {
      this.elements.hardnessValue.textContent = Math.round(hardness * 100);
    }
  }

  updateBlurRadiusValue(radius) {
    if (this.elements.blurRadiusValue) {
      this.elements.blurRadiusValue.textContent = radius;
    }
  }

  updateopacityValue(opacity) {
    if (this.elements.opacityValue) {
      this.elements.opacityValue.textContent = Math.round(opacity * 100) + '%';
    }
  }

  updateLockButton(property, locked) {
    const btn = this.elements[`${property}Lock`];
    if (!btn) return;

    btn.textContent = locked ? '🔒' : '🔓';
    btn.classList.toggle('locked', locked);
    btn.title = locked ? `Unlock ${property} for current tool` : `Lock ${property} for current tool`;
  }

  /**
   * Make a slider value span interactive:
   * - Click: opens a text input for precise editing
   * - Drag up/down: parameter ladder (scrub to adjust value)
   * @param {HTMLElement} spanEl - The .sliderValue span element
   * @param {Object} opts - { min, max, step, suffix, onCommit(val) }
   */
  makeValueEditable(spanEl, opts) {
    return this.editableHandler.makeEditable(spanEl, opts);
  }

  hideRemoteCursor(userId) {
    return this.remoteUserUI.hideRemoteCursor(userId);
  }

  showRemoteCursor(userId) {
    return this.remoteUserUI.showRemoteCursor(userId);
  }
  
  createRemoteUser(userId, userData) {
    return this.remoteUserUI.createRemoteUser(userId, userData);
  }

  createUserBoard(userId) {
    return this.remoteUserUI.createUserBoard(userId);
  }

  createUserListEntry(userId, userData) {
    return this.remoteUserUI.createUserListEntry(userId, userData);
  }

  updateRemoteCursor(userId, x, y, size) {
    return this.remoteUserUI.updateRemoteCursor(userId, x, y, size);
  }

  updateRemoteToolDisplay(userId, tool) {
    this.remoteUserUI.updateRemoteToolDisplay(userId, tool);
    this.remoteUserUI.updateRemoteToolIcon(userId, tool);
  }

  updateRemoteSize(userId, size) {
    return this.remoteUserUI.updateRemoteSize(userId, size);
  }

  updateRemoteColor(userId, color) {
    return this.remoteUserUI.updateRemoteColor(userId, color);
  }

  updateRemoteName(userId, name) {
    return this.remoteUserUI.updateRemoteName(userId, name);
  }

  updateRemoteText(userId, textContent) {
    return this.remoteUserUI.updateRemoteText(userId, textContent);
  }

  setRemoteUserAfk(userId, afk) {
    return this.remoteUserUI.setRemoteUserAfk(userId, afk);
  }

  removeRemoteUser(userId) {
    return this.remoteUserUI.removeRemoteUser(userId);
  }

  getRemoteUserBoard(userId) {
    return this.remoteUserUI.getRemoteUserBoard(userId);
  }

  /**
   * Show a toast notification
   * @param {string} message - The message to display
   * @param {number} duration - How long to show the toast (ms), default 2000
   */
  showToast(message, duration = 2000) {
    const toast = this.elements.toast;
    if (!toast) return;

    // Clear any existing timeout
    if (this._toastTimeout) {
      clearTimeout(this._toastTimeout);
    }

    toast.textContent = message;
    toast.classList.add('show');

    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }
  
  showConnectionStatus(state) {
    const { connectionStatus, connectionText, reconnectBtn } = this.elements;
    if (!connectionStatus) return;

    connectionStatus.style.display = 'flex';
    connectionStatus.className = `connectionStatus ${state}`;

    const labels = {
      connected: 'Connected',
      disconnected: 'Disconnected',
      connecting: 'Connecting...'
    };
    connectionText.textContent = labels[state] || state;
    reconnectBtn.style.display = state === 'disconnected' ? 'inline-flex' : 'none';
  }

  hideConnectionStatus() {
    const { connectionStatus } = this.elements;
    if (connectionStatus) {
      connectionStatus.style.display = 'none';
    }
  }
  
  updateUserRoleBadge(userId, role) {
    const id = `u${userId}`;
    const badge = document.querySelector(`.roleBadge.${id}`);
    if (!badge) return;

    badge.classList.remove('mod', 'admin');
    if (role === 2) {
      badge.textContent = 'admin';
      badge.classList.add('admin');
      badge.style.display = '';
    } else if (role === 1) {
      badge.textContent = 'mod';
      badge.classList.add('mod');
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}
