/**
 * UI Manager for handling DOM interactions
 */
export class UI {
  constructor() {
    this.elements = {};
    this.icons = {};
    this.cursors = new Map();
  }

  init() {
    this.cacheElements();
    this.createIcons();
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
      selfMutedIndicator: document.querySelector('.mutedIndicator.self'),
      selfText: document.querySelector('.text.self'),
      selfTextInput: document.querySelector('.textInput.self'),
      selfName: document.querySelector('.name.self'),
      mirrorLine: document.querySelector('.mirrorLine'),

      selectBtn: document.getElementById('selectBtn'),
      brushBtn: document.getElementById('brushBtn'),
      lineBtn: document.getElementById('lineBtn'),
      rectangleBtn: document.getElementById('rectangleBtn'),
      circleBtn: document.getElementById('circleBtn'),
      textBtn: document.getElementById('textBtn'),
      eraseBtn: document.getElementById('eraseBtn'),
      imageBrushBtn: document.getElementById('imageBrushBtn'),

      clearBtn: document.getElementById('clearBtn'),
      resetBtn: document.getElementById('resetBtn'),
      mirrorBtn: document.getElementById('mirrorBtn'),
      plusBtn: document.getElementById('plusBtn'),
      minusBtn: document.getElementById('minusBtn'),
      rotationResetBtn: document.getElementById('rotationResetBtn'),
      zoomPercent: document.querySelector('.zoomPercent'),
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
      imageBrushOpacitySlider: document.querySelector('.slider.imageBrushOpacity'),

      sizeValue: document.getElementById('sizeValue'),
      pressureValue: document.getElementById('pressureValue'),
      smoothingValue: document.getElementById('smoothingValue'),
      spacingValue: document.getElementById('spacingValue'),
      hardnessValue: document.getElementById('hardnessValue'),
      imageBrushOpacityValue: document.getElementById('imageBrushOpacityValue'),

      brushFileInput: document.getElementById('brush-file-input'),
      brushImage: document.getElementById('brushImage'),
      brushSpacing: document.getElementById('brush-spacing'),
      brushHardness: document.getElementById('brush-hardness'),
      imageBrushOpacityContainer: document.getElementById('image-brush-opacity'),

      selectionModeOptions: document.getElementById('selectionModeOptions'),
      brushModeOptions: document.getElementById('brushModeOptions'),

      // Lock buttons
      sizeLock: document.getElementById('sizeLock'),
      pressureLock: document.getElementById('pressureLock'),
      smoothingLock: document.getElementById('smoothingLock'),
      spacingLock: document.getElementById('spacingLock'),
      hardnessLock: document.getElementById('hardnessLock'),
      imageBrushOpacityLock: document.getElementById('imageBrushOpacityLock'),

      colorPicker: document.getElementById('colorPicker'),

      touchInput: document.getElementById('touchInput'),

      bottomBar: document.getElementById('bottomBar'),
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
    const mutedIndicator = this.elements.selfMutedIndicator;

    cursor.style.left = `${x - 100}px`;
    cursor.style.top = `${y - 100}px`;
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    square.setAttribute('x', x - size);
    square.setAttribute('y', y - size);
    crosshair.setAttribute('transform', `translate(${x}, ${y})`);
    if (mutedIndicator) {
      mutedIndicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  updateCursorSize(size) {
    this.elements.selfCircle.setAttribute('r', size);
    this.elements.selfSquare.setAttribute('width', size * 2);
    this.elements.selfSquare.setAttribute('height', size * 2);
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
    const { selfCircle, selfSquare, selfCrosshair, selfText, brushImage, brushFileInput, brushSpacing, brushHardness, imageBrushOpacityContainer, selectionModeOptions, brushModeOptions } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfText.style.display = 'none';
    brushImage.style.display = 'none';
    brushFileInput.style.display = 'none';
    brushSpacing.style.display = 'none';
    brushHardness.style.display = 'none';
    imageBrushOpacityContainer.style.display = 'none';
    if (selectionModeOptions) {
      selectionModeOptions.style.display = 'none';
    }
    if (brushModeOptions) {
      brushModeOptions.style.display = 'none';
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
        break;
      case 'imageBrush':
        selfSquare.style.display = 'block';
        // brushImage is shown only when a brush is selected (via setBrushPreview)
        brushFileInput.style.display = 'block';
        brushSpacing.style.display = 'block';
        imageBrushOpacityContainer.style.display = 'block';
        break;
    }

    this.updateToolButton(tool);
  }

  updateToolButton(tool) {
    const buttons = {
      select: this.elements.selectBtn,
      brush: this.elements.brushBtn,
      line: this.elements.lineBtn,
      rectangle: this.elements.rectangleBtn,
      circle: this.elements.circleBtn,
      text: this.elements.textBtn,
      erase: this.elements.eraseBtn,
      imageBrush: this.elements.imageBrushBtn
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

  updateSelfColor(color) {
    this.elements.selfListColor.style.backgroundColor = `rgba(${color.join(',')})`;
  }

  updateSelfTextInput(text) {
    this.elements.selfTextInput.innerHTML = text.replace(/ /g, '&nbsp;');
  }

  updateSelfName(name) {
    this.elements.selfName.textContent = name;
    this.elements.selfListUser.textContent = name;
  }

  updateSelfTextStyle(size, color) {
    this.elements.selfText.style.fontSize = `${size + 5}px`;
    this.elements.selfText.style.color = `rgba(${color.join(',')})`;
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

  updateImageBrushOpacityValue(opacity) {
    if (this.elements.imageBrushOpacityValue) {
      this.elements.imageBrushOpacityValue.textContent = Math.round(opacity * 100) + '%';
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
    const { min, max, step, suffix = '', onCommit, dragStep } = opts;
    const DRAG_THRESHOLD = 3; // px of vertical movement before drag starts

    let dragState = null;

    const openEditor = () => {
      if (spanEl.querySelector('.sliderValueInput')) return;

      const originalText = spanEl.textContent;
      const currentVal = parseFloat(originalText.replace(suffix, '').trim());

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sliderValueInput';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = isNaN(currentVal) ? min : currentVal;

      spanEl.textContent = '';
      spanEl.appendChild(input);
      input.focus();
      input.select();

      const commit = () => {
        let val = parseFloat(input.value);
        if (isNaN(val)) val = min;
        val = Math.max(min, Math.min(max, val));
        val = Math.round(val / step) * step;
        val = parseFloat(val.toFixed(10));

        spanEl.textContent = suffix ? `${val}${suffix}` : String(val);
        onCommit(val);
      };

      const cancel = () => {
        spanEl.textContent = originalText;
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') {
          ke.preventDefault();
          input.removeEventListener('blur', commit);
          commit();
        } else if (ke.key === 'Escape') {
          ke.preventDefault();
          input.removeEventListener('blur', commit);
          cancel();
        }
        ke.stopPropagation();
      });
    };

    spanEl.addEventListener('pointerdown', (e) => {
      if (spanEl.querySelector('.sliderValueInput')) return;
      e.preventDefault();

      const currentText = spanEl.textContent;
      const startVal = parseFloat(currentText.replace(suffix, '').trim()) || min;

      dragState = {
        startY: e.clientY,
        startVal,
        dragging: false,
        pointerId: e.pointerId
      };

      spanEl.setPointerCapture(e.pointerId);
    });

    spanEl.addEventListener('pointermove', (e) => {
      if (!dragState) return;

      const dy = dragState.startY - e.clientY; // up = positive

      if (!dragState.dragging) {
        if (Math.abs(dy) < DRAG_THRESHOLD) return;
        dragState.dragging = true;
        spanEl.classList.add('dragging');
        document.body.classList.add('parameter-dragging');
      }

      // Use dragStep function for dynamic step sizes, or fall back to fixed step
      const currentStep = dragStep ? dragStep(dragState.lastVal ?? dragState.startVal) : step;

      let sensitivity = currentStep;
      if (e.shiftKey) sensitivity = currentStep * 10;
      else if (e.altKey) sensitivity = currentStep * 0.1;

      let val = dragState.startVal + dy * sensitivity;
      val = Math.max(min, Math.min(max, val));
      // Snap to the appropriate step for the current value
      const snapStep = dragStep ? dragStep(val) : step;
      val = Math.round(val / snapStep) * snapStep;
      val = parseFloat(val.toFixed(10));
      dragState.lastVal = val;

      spanEl.textContent = suffix ? `${val}${suffix}` : String(val);
      onCommit(val);
    });

    const endDrag = (e) => {
      if (!dragState) return;
      const wasDragging = dragState.dragging;
      spanEl.classList.remove('dragging');
      document.body.classList.remove('parameter-dragging');
      dragState = null;

      // If it was a click (no drag), open the text editor
      if (!wasDragging) {
        openEditor();
      }
    };

    spanEl.addEventListener('pointerup', endDrag);
    spanEl.addEventListener('pointercancel', endDrag);
  }

  hideRemoteCursor(userId) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;

    cursorElements.cursor.style.display = 'none';
    cursorElements.circle.style.display = 'none';
    cursorElements.square.style.display = 'none';
    cursorElements.crosshair.style.display = 'none';
    cursorElements.text.style.display = 'none';
  }

  showRemoteCursor(userId) {
    const cursorElements = this.cursors.get(userId);
    if (!cursorElements) return;

    cursorElements.cursor.style.display = 'block';
    // Note: circle, square, crosshair, text visibility is managed by updateRemoteToolDisplay()
    // This will be called after showing to restore the correct cursor shape
  }
  
  createRemoteUser(userId, userData) {
    const id = `u${userId}`;
    const cursor = document.createElement('div');
    cursor.className = `cursor ${id}`;
    cursor.style.left = `${userData.x}px`;
    cursor.style.top = `${userData.y}px`;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', `circle ${id}`);
    circle.setAttribute('stroke', 'grey');
    circle.setAttribute('stroke-width', '1');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('cx', '0');
    circle.setAttribute('cy', '0');
    circle.setAttribute('r', '10');

    const square = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    square.setAttribute('class', `square ${id}`);
    square.setAttribute('stroke', 'grey');
    square.setAttribute('stroke-width', '1');
    square.setAttribute('fill', 'none');
    square.setAttribute('x', userData.x - userData.size);
    square.setAttribute('y', userData.y - userData.size);
    square.setAttribute('height', userData.size * 2);
    square.setAttribute('width', userData.size * 2);

    if (userData.tool !== 'imageBrush') {
      square.style.display = 'none';
    }

    // Crosshair cursor for select tool
    const crosshair = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    crosshair.setAttribute('class', `crosshair ${id}`);
    crosshair.style.display = userData.tool === 'select' ? 'block' : 'none';
    const chSize = 10;
    const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hLine.setAttribute('x1', -chSize);
    hLine.setAttribute('y1', '0');
    hLine.setAttribute('x2', chSize);
    hLine.setAttribute('y2', '0');
    hLine.setAttribute('stroke', 'grey');
    hLine.setAttribute('stroke-width', '1');
    const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    vLine.setAttribute('x1', '0');
    vLine.setAttribute('y1', -chSize);
    vLine.setAttribute('x2', '0');
    vLine.setAttribute('y2', chSize);
    vLine.setAttribute('stroke', 'grey');
    vLine.setAttribute('stroke-width', '1');
    crosshair.appendChild(hLine);
    crosshair.appendChild(vLine);

    const name = document.createElement('text');
    name.className = `name ${id}`;
    name.textContent = userData.username || userId;

    const text = document.createElement('text');
    text.className = `text ${id}`;
    text.style.width = '400px';
    text.style.color = `rgba(${userData.color.join(',')})`;
    text.style.fontSize = `${userData.size + 5}px`;

    if (userData.tool !== 'text') {
      text.style.display = 'none';
    }

    const textInput = document.createElement('text');
    textInput.className = `textInput ${id}`;
    textInput.textContent = userData.text || '';

    const line = document.createElement('text');
    line.textContent = '|';

    text.appendChild(textInput);
    text.appendChild(line);

    this.elements.cursorsSvg.appendChild(circle);
    this.elements.cursorsSvg.appendChild(square);
    this.elements.cursorsSvg.appendChild(crosshair);
    cursor.appendChild(name);
    cursor.appendChild(text);

    document.querySelector('.cursors').appendChild(cursor);

    this.createUserListEntry(userId, userData);
    this.createUserBoard(userId);

    this.cursors.set(userId, { cursor, circle, square, crosshair, text, textInput, name });
  }

  createUserBoard(userId) {
    const id = `u${userId}`;
    const board = document.createElement('canvas');
    board.setAttribute('height', this.elements.board.height);
    board.setAttribute('width', this.elements.board.width);
    board.className = `userBoard ${id}`;
    this.elements.userBoards.appendChild(board);

    const context = board.getContext('2d');
    context.lineCap = 'round';
    context.lineJoin = 'round';

    return { board, context };
  }

  createUserListEntry(userId, userData) {
    const id = `u${userId}`;
    const entry = document.createElement('div');
    entry.className = `userEntry ${id}`;
    entry.dataset.sessionIndex = userId;

    const toolEntry = document.createElement('a');
    toolEntry.className = `listTool ${id}`;
    const icon = this.icons[userData.tool] || this.icons.brush;
    toolEntry.appendChild(icon.cloneNode(true));

    const colorEntry = document.createElement('a');
    colorEntry.className = `listColor ${id}`;
    colorEntry.style.backgroundColor = `rgba(${userData.color.join(',')})`;

    const userEntry = document.createElement('span');
    userEntry.className = `listUser ${id}`;
    userEntry.textContent = userData.username || userId;

    // Role badge (hidden by default, shown when role > 0)
    const roleBadge = document.createElement('span');
    roleBadge.className = `roleBadge ${id}`;
    roleBadge.style.display = 'none';
    if (userData.role === 2) {
      roleBadge.textContent = 'admin';
      roleBadge.classList.add('admin');
      roleBadge.style.display = '';
    } else if (userData.role === 1) {
      roleBadge.textContent = 'mod';
      roleBadge.classList.add('mod');
      roleBadge.style.display = '';
    }

    const activeEntry = document.createElement('span');
    activeEntry.className = `listActive ${id}`;

    entry.appendChild(toolEntry);
    entry.appendChild(colorEntry);
    entry.appendChild(userEntry);
    entry.appendChild(roleBadge);
    entry.appendChild(activeEntry);

    this.elements.userList.appendChild(entry);
  }

  updateRemoteCursor(userId, x, y, size) {
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);

    if (cursor) {
      cursor.style.left = `${x - 100}px`;
      cursor.style.top = `${y - 100}px`;
    }
    if (circle) {
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
    }
    if (square) {
      square.setAttribute('x', x - size);
      square.setAttribute('y', y - size);
    }
    if (crosshair) {
      crosshair.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  updateRemoteToolDisplay(userId, tool) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const crosshair = document.querySelector(`.crosshair.${id}`);
    const text = document.querySelector(`.text.${id}`);
    const toolEntry = document.querySelector(`.listTool.${id}`);

    if (circle) circle.style.display = 'none';
    if (square) square.style.display = 'none';
    if (crosshair) crosshair.style.display = 'none';
    if (text) text.style.display = 'none';

    switch (tool) {
      case 'select':
        if (crosshair) crosshair.style.display = 'block';
        break;
      case 'brush':
      case 'flowPen':
      case 'ink':
      case 'line':
      case 'rectangle':
      case 'circle':
      case 'erase':
        if (circle) circle.style.display = 'block';
        break;
      case 'text':
        if (text) text.style.display = 'block';
        break;
      case 'imageBrush':
        if (square) square.style.display = 'block';
        break;
    }

    if (toolEntry && this.icons[tool]) {
      if (toolEntry.children[0]) {
        toolEntry.children[0].remove();
      }
      toolEntry.appendChild(this.icons[tool].cloneNode(true));
    }
  }

  updateRemoteSize(userId, size) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const text = document.querySelector(`.text.${id}`);

    if (circle) circle.setAttribute('r', size);
    if (square) {
      square.setAttribute('height', size * 2);
      square.setAttribute('width', size * 2);
    }
    if (text) text.style.fontSize = `${size + 5}px`;
  }

  updateRemoteColor(userId, color) {
    const id = `u${userId}`;
    const text = document.querySelector(`.text.${id}`);
    const colorEntry = document.querySelector(`.listColor.${id}`);
    const colorStr = `rgba(${color.join(',')})`;

    if (text) text.style.color = colorStr;
    if (colorEntry) colorEntry.style.backgroundColor = colorStr;
  }

  updateRemoteName(userId, name) {
    const id = `u${userId}`;
    const nameEl = document.querySelector(`.name.${id}`);
    const listUser = document.querySelector(`.listUser.${id}`);

    if (nameEl) nameEl.textContent = name;
    if (listUser) listUser.textContent = name;
  }

  updateRemoteText(userId, textContent) {
    const id = `u${userId}`;
    const textInput = document.querySelector(`.textInput.${id}`);
    if (textInput) {
      textInput.innerHTML = textContent.replace(/ /g, '&nbsp;');
    }
  }

  setRemoteUserAfk(userId, afk) {
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const userEntry = document.querySelector(`.userEntry.${id}`);

    if (cursor) {
      cursor.style.opacity = afk ? '0' : '1';
      cursor.style.transition = 'opacity 0.5s ease';
    }
    if (circle) {
      circle.style.opacity = afk ? '0' : '1';
      circle.style.transition = 'opacity 0.5s ease';
    }
    if (square) {
      square.style.opacity = afk ? '0' : '1';
      square.style.transition = 'opacity 0.5s ease';
    }
    if (userEntry) {
      userEntry.style.opacity = afk ? '0.5' : '1';
      userEntry.style.transition = 'opacity 0.3s ease';
    }
  }

  removeRemoteUser(userId) {
    const id = `u${userId}`;
    const elements = document.querySelectorAll(`.${id}`);
    elements.forEach(el => el.remove());
    this.cursors.delete(userId);
  }

  getRemoteUserBoard(userId) {
    const id = `u${userId}`;
    const board = document.querySelector(`.userBoard.${id}`);
    if (board) {
      return { board, context: board.getContext('2d') };
    }
    return null;
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
