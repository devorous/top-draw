import { inject } from '@vercel/analytics';
import { isTauriDesktop } from '../platform/desktop.js';

inject();

if (!isTauriDesktop()) {
  window.location.replace('/go/');
}

const CHANNEL_NAME = 'ddraw-board-viewer-popout';
const MIN_VIEW_ZOOM = 0.05;
const MAX_VIEW_ZOOM = 8;

const stage = document.querySelector('.boardViewerPopoutStage');
const canvas = document.getElementById('boardViewerPopoutCanvas');
const ctx = canvas.getContext('2d');
const controls = document.querySelector('.boardViewerPopoutControls');
const zoomLabel = document.querySelector('[data-action="reset"]');
const channel = new BroadcastChannel(CHANNEL_NAME);

let latestFrame = null;
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d');
let viewZoom = 1;
let panX = 0;
let panY = 0;
let dragState = null;
let fitted = false;

function fitToStage() {
  if (!latestFrame) return;
  const rect = stage.getBoundingClientRect();
  viewZoom = Math.min(rect.width / latestFrame.width, rect.height / latestFrame.height);
  panX = (rect.width - latestFrame.width * viewZoom) / 2;
  panY = (rect.height - latestFrame.height * viewZoom) / 2;
  fitted = true;
}

function zoomAt(nextZoom, pivotX = null, pivotY = null) {
  const rect = stage.getBoundingClientRect();
  const px = pivotX ?? rect.width / 2;
  const py = pivotY ?? rect.height / 2;
  const oldZoom = viewZoom;
  const clamped = Math.max(MIN_VIEW_ZOOM, Math.min(MAX_VIEW_ZOOM, nextZoom));
  const boardX = (px - panX) / oldZoom;
  const boardY = (py - panY) / oldZoom;
  viewZoom = clamped;
  panX = px - boardX * clamped;
  panY = py - boardY * clamped;
}

function render() {
  requestAnimationFrame(render);
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#1b1f27';
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (latestFrame) {
    ctx.imageSmoothingEnabled = viewZoom < 4;
    ctx.setTransform(dpr * viewZoom, 0, 0, dpr * viewZoom, dpr * panX, dpr * panY);
    ctx.drawImage(frameCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  zoomLabel.textContent = `${Math.round(viewZoom * 100)}%`;
}

channel.onmessage = (event) => {
  const message = event.data;
  if (message?.type !== 'board-viewer-frame' || !message.imageData) return;

  latestFrame = {
    width: message.width,
    height: message.height
  };
  if (frameCanvas.width !== message.width || frameCanvas.height !== message.height) {
    frameCanvas.width = message.width;
    frameCanvas.height = message.height;
  }
  frameCtx.putImageData(message.imageData, 0, 0);
  if (!fitted) fitToStage();
};

controls.addEventListener('click', (event) => {
  const action = event.target.closest('button')?.dataset.action;
  if (action === 'zoomIn') zoomAt(viewZoom * 1.2);
  if (action === 'zoomOut') zoomAt(viewZoom / 1.2);
  if (action === 'reset') fitToStage();
});

stage.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  stage.setPointerCapture(event.pointerId);
  dragState = { x: event.clientX, y: event.clientY, panX, panY };
});
stage.addEventListener('pointermove', (event) => {
  if (!dragState) return;
  panX = dragState.panX + event.clientX - dragState.x;
  panY = dragState.panY + event.clientY - dragState.y;
});
stage.addEventListener('pointerup', () => { dragState = null; });
stage.addEventListener('pointercancel', () => { dragState = null; });
stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  zoomAt(viewZoom * Math.pow(2, -event.deltaY / 360), event.offsetX, event.offsetY);
}, { passive: false });

window.addEventListener('resize', () => {
  if (fitted) fitToStage();
});
window.addEventListener('beforeunload', () => {
  channel.postMessage({ type: 'board-viewer-closed' });
  channel.close();
});

render();
