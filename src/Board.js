/**
 * Board class managing canvas elements and viewport
 */
export class Board {
  constructor(options = {}) {
    this.dimensions = options.dimensions || [720, 1280];
    this.zoom = 1;
    this.defaultZoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.defaultPanX = 0;
    this.defaultPanY = 0;
    this.mirror = false;

    this.container = null;
    this.boardsWrapper = null;
    this.mainCanvas = null;
    this.topCanvas = null;
    this.mainCtx = null;
    this.topCtx = null;
    this.cursorsSvg = null;
    this.mirrorLine = null;
  }

  init(containerSelector) {
    this.container = document.querySelector(containerSelector);
    this.boardsWrapper = document.getElementById('boards');
    this.mainCanvas = document.getElementById('board');
    this.topCanvas = document.getElementById('topBoard');
    this.cursorsSvg = document.getElementById('cursorsSvg');
    this.mirrorLine = document.querySelector('.mirrorLine');

    this.mainCtx = this.mainCanvas.getContext('2d');
    this.topCtx = this.topCanvas.getContext('2d');

    this.setupCanvas();
    this.calculateDefaultView();
    this.resetView();
  }

  setupCanvas() {
    const [height, width] = this.dimensions;

    this.boardsWrapper.style.height = `${height}px`;
    this.boardsWrapper.style.width = `${width}px`;

    this.mainCanvas.height = height;
    this.mainCanvas.width = width;
    this.topCanvas.height = height;
    this.topCanvas.width = width;

    this.mainCtx.globalCompositeOperation = 'source-over';
    this.mainCtx.imageSmoothingQuality = 'high';
    this.mainCtx.lineCap = 'round';
    this.mainCtx.lineJoin = 'round';

    this.topCtx.imageSmoothingQuality = 'high';
    this.topCtx.lineCap = 'round';
    this.topCtx.lineJoin = 'round';

    this.mirrorLine.setAttribute('x1', width / 2);
    this.mirrorLine.setAttribute('y1', 0);
    this.mirrorLine.setAttribute('x2', width / 2);
    this.mirrorLine.setAttribute('y2', height);
    this.mirrorLine.style.display = 'none';

    this.boardsWrapper.style.transformOrigin = 'top left';
  }

  calculateDefaultView() {
    const containerWidth = this.container.clientWidth * 0.95;
    const containerHeight = this.container.clientHeight * 0.95 - 30;
    const [height, width] = this.dimensions;

    let zoom = Math.round((containerWidth / width) * 1000) / 1000;
    let panX = (containerWidth * 0.05) / 2;
    let panY = containerHeight / 2 - height * zoom / 2 + 30;

    if (zoom > Math.round((containerHeight / height) * 1000) / 1000) {
      zoom = Math.round((containerHeight / height) * 1000) / 1000;
      panX = containerWidth / 2 - width * zoom / 2;
      panY = (containerHeight * 0.05) / 2 + 30;
    }

    this.defaultZoom = zoom;
    this.defaultPanX = panX;
    this.defaultPanY = panY;
  }

  resetView() {
    this.zoom = this.defaultZoom;
    this.panX = this.defaultPanX;
    this.panY = this.defaultPanY;

    this.boardsWrapper.style.transformOrigin = 'top left';
    this.applyTransform();
  }

  applyTransform() {
    this.boardsWrapper.style.left = `${this.panX}px`;
    this.boardsWrapper.style.top = `${this.panY}px`;
    this.boardsWrapper.style.scale = this.zoom;
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.applyTransform();
  }

  setZoom(zoom, cursorPos = null) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.2, Math.min(3, zoom));

    if (cursorPos) {
      // Zoom centered on cursor position
      // Calculate the cursor position relative to the container
      const containerRect = this.container.getBoundingClientRect();
      const cursorScreenX = cursorPos.x * oldZoom + this.panX;
      const cursorScreenY = cursorPos.y * oldZoom + this.panY;

      // Adjust pan so the cursor stays in the same screen position
      this.panX = cursorScreenX - cursorPos.x * this.zoom;
      this.panY = cursorScreenY - cursorPos.y * this.zoom;
    } else {
      // Zoom centered on board center
      const [height, width] = this.dimensions;
      const centerX = width / 2;
      const centerY = height / 2;

      const containerWidth = this.container.clientWidth;
      const containerHeight = this.container.clientHeight;

      // Calculate where center currently is on screen
      const centerScreenX = centerX * oldZoom + this.panX;
      const centerScreenY = centerY * oldZoom + this.panY;

      // Adjust pan so center stays in same screen position
      this.panX = centerScreenX - centerX * this.zoom;
      this.panY = centerScreenY - centerY * this.zoom;
    }

    this.applyTransform();
    return this.zoom;
  }

  zoomIn(step = 0.1, cursorPos = null) {
    return this.setZoom(Math.round((this.zoom + step) * 10) / 10, cursorPos);
  }

  zoomOut(step = 0.1, cursorPos = null) {
    return this.setZoom(Math.round((this.zoom - step) * 10) / 10, cursorPos);
  }

  getZoomPercent() {
    return `${(this.zoom * 100).toFixed(1)}%`;
  }

  toggleMirror() {
    this.mirror = !this.mirror;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
    return this.mirror;
  }

  setMirror(value) {
    this.mirror = value;
    this.mirrorLine.style.display = this.mirror ? 'block' : 'none';
  }

  clear() {
    const [height, width] = this.dimensions;
    this.mainCtx.beginPath();
    this.topCtx.beginPath();
    this.mainCtx.clearRect(0, 0, width, height);
    this.topCtx.clearRect(0, 0, width, height);
  }

  clearTop() {
    const [height, width] = this.dimensions;
    this.topCtx.clearRect(0, 0, width, height);
  }

  getWidth() {
    return this.dimensions[1];
  }

  getHeight() {
    return this.dimensions[0];
  }

  saveAsImage() {
    const dataURL = this.mainCanvas.toDataURL();
    const link = document.createElement('a');
    link.download = `${new Date().toString().slice(0, 24)}.png`;
    link.href = dataURL;
    link.click();
  }
}
