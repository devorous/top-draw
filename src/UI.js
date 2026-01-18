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
      usernameInput: document.getElementById('usernameInput'),

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
      selfText: document.querySelector('.text.self'),
      selfTextInput: document.querySelector('.textInput.self'),
      selfName: document.querySelector('.name.self'),
      mirrorLine: document.querySelector('.mirrorLine'),

      selectBtn: document.getElementById('selectBtn'),
      brushBtn: document.getElementById('brushBtn'),
      penBtn: document.getElementById('penBtn'),
      lineBtn: document.getElementById('lineBtn'),
      rectangleBtn: document.getElementById('rectangleBtn'),
      circleBtn: document.getElementById('circleBtn'),
      textBtn: document.getElementById('textBtn'),
      eraseBtn: document.getElementById('eraseBtn'),
      gimpBtn: document.getElementById('gimpBtn'),

      clearBtn: document.getElementById('clearBtn'),
      resetBtn: document.getElementById('resetBtn'),
      mirrorBtn: document.getElementById('mirrorBtn'),
      plusBtn: document.getElementById('plusBtn'),
      minusBtn: document.getElementById('minusBtn'),
      zoomPercent: document.querySelector('.zoomPercent'),
      mirrorText: document.querySelector('.mirrorOption'),

      chatBtn: document.getElementById('chatBtn'),
      chatResetBtn: document.getElementById('chatResetBtn'),
      saveBtn: document.getElementById('saveBtn'),

      sizeSlider: document.querySelector('.slider.size'),
      spacingSlider: document.querySelector('.slider.spacing'),
      pressureSlider: document.querySelector('.slider.pressure'),

      gimpFileInput: document.getElementById('gimp-file-input'),
      gimpImage: document.getElementById('gimpImage'),
      gimpSpacing: document.getElementById('gimp-spacing'),

      colorPicker: document.getElementById('colorPicker'),

      bottomBar: document.getElementById('bottomBar'),
      timeline: document.getElementById('timeline'),

      userList: document.getElementById('userList'),
      selfUserEntry: document.querySelector('.userEntry.self'),
      selfListTool: document.querySelector('.listTool.self'),
      selfListColor: document.querySelector('.listColor.self'),
      selfListUser: document.querySelector('.listUser.self'),
      selfListActive: document.querySelector('.listActive.self')
    };
  }

  createIcons() {
    this.icons = {
      select: this.createIcon('images/select-icon.svg'),
      brush: this.createIcon('images/brush-icon.svg'),
      pen: this.createIcon('images/pen-icon.svg'),
      line: this.createIcon('images/line-icon.svg'),
      rectangle: this.createIcon('images/rectangle-icon.svg'),
      circle: this.createIcon('images/circle-icon.svg'),
      text: this.createIcon('images/text-icon.svg'),
      erase: this.createIcon('images/eraser-icon.svg'),
      gimp: this.createIcon('images/pepper.png')
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
    this.elements.selfCursor.style.display = 'block';
  }

  updateSelfCursor(x, y, size) {
    const cursor = this.elements.selfCursor;
    const circle = this.elements.selfCircle;
    const square = this.elements.selfSquare;
    const crosshair = this.elements.selfCrosshair;

    cursor.style.left = `${x - 100}px`;
    cursor.style.top = `${y - 100}px`;
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    square.setAttribute('x', x - size);
    square.setAttribute('y', y - size);
    crosshair.setAttribute('transform', `translate(${x}, ${y})`);
  }

  updateCursorSize(size) {
    this.elements.selfCircle.setAttribute('r', size);
    this.elements.selfSquare.setAttribute('width', size * 2);
    this.elements.selfSquare.setAttribute('height', size * 2);
  }

  updateToolDisplay(tool) {
    const { selfCircle, selfSquare, selfCrosshair, selfText, gimpImage, gimpFileInput, gimpSpacing } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfText.style.display = 'none';
    gimpImage.style.display = 'none';
    gimpFileInput.style.display = 'none';
    gimpSpacing.style.display = 'none';

    switch (tool) {
      case 'select':
        selfCrosshair.style.display = 'block';
        break;
      case 'brush':
      case 'pen':
      case 'line':
      case 'rectangle':
      case 'circle':
        selfCircle.style.display = 'block';
        break;
      case 'text':
        selfText.style.display = 'block';
        break;
      case 'erase':
        selfCircle.style.display = 'block';
        break;
      case 'gimp':
        selfSquare.style.display = 'block';
        // gimpImage is shown only when a brush is selected (via setGimpPreview)
        gimpFileInput.style.display = 'block';
        gimpSpacing.style.display = 'block';
        break;
    }

    this.updateToolButton(tool);
  }

  updateToolButton(tool) {
    const buttons = {
      select: this.elements.selectBtn,
      brush: this.elements.brushBtn,
      pen: this.elements.penBtn,
      line: this.elements.lineBtn,
      rectangle: this.elements.rectangleBtn,
      circle: this.elements.circleBtn,
      text: this.elements.textBtn,
      erase: this.elements.eraseBtn,
      gimp: this.elements.gimpBtn
    };

    Object.values(buttons).forEach(btn => btn.classList.remove('selected'));
    if (buttons[tool]) {
      buttons[tool].classList.add('selected');
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

  setGimpPreview(url) {
    this.elements.gimpImage.src = url;
    this.elements.gimpImage.style.display = 'block';
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

    if (userData.tool !== 'gimp') {
      square.style.display = 'none';
    }

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
    cursor.appendChild(name);
    cursor.appendChild(text);

    document.querySelector('.cursors').appendChild(cursor);

    this.createUserListEntry(userId, userData);
    this.createUserBoard(userId);

    this.cursors.set(userId, { cursor, circle, square, text, textInput, name });
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

    return { board, context };
  }

  createUserListEntry(userId, userData) {
    const id = `u${userId}`;
    const entry = document.createElement('div');
    entry.className = `userEntry ${id}`;

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

    const activeEntry = document.createElement('span');
    activeEntry.className = `listActive ${id}`;

    entry.appendChild(toolEntry);
    entry.appendChild(colorEntry);
    entry.appendChild(userEntry);
    entry.appendChild(activeEntry);

    this.elements.userList.appendChild(entry);
  }

  updateRemoteCursor(userId, x, y, size) {
    const id = `u${userId}`;
    const cursor = document.querySelector(`.cursor.${id}`);
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);

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
  }

  updateRemoteToolDisplay(userId, tool) {
    const id = `u${userId}`;
    const circle = document.querySelector(`.circle.${id}`);
    const square = document.querySelector(`.square.${id}`);
    const text = document.querySelector(`.text.${id}`);
    const toolEntry = document.querySelector(`.listTool.${id}`);

    if (circle) circle.style.display = 'none';
    if (square) square.style.display = 'none';
    if (text) text.style.display = 'none';

    switch (tool) {
      case 'select':
        // No cursor indicator for select tool
        break;
      case 'brush':
      case 'pen':
      case 'line':
      case 'rectangle':
      case 'circle':
      case 'erase':
        if (circle) circle.style.display = 'block';
        break;
      case 'text':
        if (text) text.style.display = 'block';
        break;
      case 'gimp':
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
}
