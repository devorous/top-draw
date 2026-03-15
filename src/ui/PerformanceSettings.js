/**
 * @fileoverview User-accessible performance settings modal for choosing render FPS target.
 */

const LS_KEY = 'topdraw_renderFPS';
const FPS_OPTIONS = [
  { label: 'Uncapped', value: 0 },
  { label: '20 FPS', value: 20 },
  { label: '30 FPS', value: 30 },
  { label: '60 FPS', value: 60 },
  { label: '90 FPS', value: 90 },
];

export class PerformanceSettings {
  constructor() {
    /** @type {HTMLElement|null} */
    this._overlay = null;
    /** @type {Board|null} */
    this._board = null;
    this.isVisible = false;
  }

  /**
   * @param {Board} board
   */
  init(board) {
    this._board = board;
    this._buildDOM();
    this._loadSaved();
  }

  _buildDOM() {
    this._overlay = document.createElement('div');
    this._overlay.className = 'perfSettingsOverlay';
    this._overlay.innerHTML = `
      <div class="perfSettingsDialog">
        <div class="perfSettingsHeader">
          <h2>Performance Settings</h2>
          <button class="perfSettingsClose" aria-label="Close">&times;</button>
        </div>
        <div class="perfSettingsBody">
          <div class="perfSettingsSection">
            <label class="perfSettingsLabel">Render FPS Target</label>
            <p class="perfSettingsDesc">
              Limits how often the canvas is composited. Lower values reduce GPU load on slower devices.
              Stroke preview is always instant — only the final composited result is affected.
            </p>
            <div class="perfFpsOptions" id="perfFpsOptions"></div>
          </div>
        </div>
      </div>
    `;

    const optionsContainer = this._overlay.querySelector('#perfFpsOptions');
    for (const opt of FPS_OPTIONS) {
      const btn = document.createElement('button');
      btn.className = 'perfFpsBtn';
      btn.dataset.value = opt.value;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => this._selectFPS(opt.value));
      optionsContainer.appendChild(btn);
    }

    this._overlay.querySelector('.perfSettingsClose').addEventListener('click', () => this.hide());
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.hide();
    });

    document.body.appendChild(this._overlay);
  }

  _loadSaved() {
    const saved = localStorage.getItem(LS_KEY);
    const value = saved !== null ? parseInt(saved, 10) : 0;
    this._applyFPS(value);
    this._updateButtons(value);
  }

  _selectFPS(value) {
    this._applyFPS(value);
    this._updateButtons(value);
    localStorage.setItem(LS_KEY, value);
  }

  _applyFPS(value) {
    if (this._board) {
      this._board.setTargetFPS(value);
    }
  }

  _updateButtons(activeValue) {
    const btns = this._overlay?.querySelectorAll('.perfFpsBtn') ?? [];
    for (const btn of btns) {
      btn.classList.toggle('active', parseInt(btn.dataset.value, 10) === activeValue);
    }
  }

  show() {
    if (!this._overlay) return;
    this._overlay.classList.add('visible');
    this.isVisible = true;
  }

  hide() {
    if (!this._overlay) return;
    this._overlay.classList.remove('visible');
    this.isVisible = false;
  }
}
