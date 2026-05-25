/**
 * @fileoverview Dev-only floating panel that lists missing/extra/mismatched
 * strokes from the most recent parity check, with click-to-resync per row.
 *
 * Opt-in: shown via `window.app.debugSync.showPanel()` or hidden via
 * `hidePanel()`. Auto-refreshes when ParityClient emits a new mismatch
 * (App._handleParityMismatch calls panel.refresh()).
 */

export class ParityPanel {
  /**
   * @param {Object} app - The App instance (used for parityClient + lastMismatch)
   */
  constructor(app) {
    this.app = app;
    this.el = null;
  }

  show() {
    if (this.el) {
      this.el.style.display = 'block';
      this.refresh();
      return;
    }
    this._build();
    this.refresh();
  }

  hide() {
    if (this.el) this.el.style.display = 'none';
  }

  refresh() {
    if (!this.el) return;
    const diff = this.app._lastParityMismatch;
    const body = this.el.querySelector('.parityPanel__body');
    if (!body) return;
    if (!diff) {
      body.innerHTML = '<div class="parityPanel__empty">No mismatch on record. Try <code>app.debugSync.checkNow()</code>.</div>';
      return;
    }
    const sections = [
      this._renderSection('Missing', diff.missing, true),
      this._renderSection('Mismatched', diff.mismatched, true, true),
      this._renderSection('Extra', diff.extra, false),
    ].filter(Boolean).join('');
    body.innerHTML = `
      <div class="parityPanel__summary">
        <strong>${diff.percent.toFixed(2)}%</strong> parity ·
        server=${diff.serverCount} · client=${diff.clientCount}
        ${diff.truncatedChunks ? ' · <em>truncated</em>' : ''}
      </div>
      ${sections}
    `;
    this._wireRowResync(body);
  }

  _renderSection(label, list, canResync, isMismatched = false) {
    if (!Array.isArray(list) || list.length === 0) return '';
    const rows = list.slice(0, 50).map((item) => {
      const e = isMismatched ? item.server : item;
      const seq = isMismatched ? item.seq : e.seq;
      const fp = (e.fingerprint >>> 0).toString(16).padStart(8, '0');
      const action = canResync
        ? `<button class="parityPanel__resync" data-seq="${seq}">Replay</button>`
        : '';
      return `<tr>
        <td>${seq}</td>
        <td>${e.kind || ''}</td>
        <td>${e.userId ?? ''}</td>
        <td class="parityPanel__fp">${fp}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');
    const overflow = list.length > 50 ? `<div class="parityPanel__overflow">…and ${list.length - 50} more</div>` : '';
    return `
      <div class="parityPanel__section">
        <div class="parityPanel__sectionTitle">${label} (${list.length})</div>
        <table class="parityPanel__table"><thead>
          <tr><th>seq</th><th>kind</th><th>uid</th><th>fp</th><th></th></tr>
        </thead><tbody>${rows}</tbody></table>
        ${overflow}
      </div>
    `;
  }

  _wireRowResync(body) {
    body.querySelectorAll('.parityPanel__resync').forEach((btn) => {
      btn.addEventListener('click', () => {
        const seq = Number(btn.getAttribute('data-seq'));
        if (Number.isFinite(seq)) {
          this.app.parityClient?.requestResync([seq]);
          btn.disabled = true;
          btn.textContent = 'Sent';
        }
      });
    });
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'parityPanel';
    el.innerHTML = `
      <div class="parityPanel__header">
        <span class="parityPanel__title">Parity</span>
        <button class="parityPanel__checkNow">Check now</button>
        <button class="parityPanel__fixAll">Fix all</button>
        <button class="parityPanel__close">×</button>
      </div>
      <div class="parityPanel__body"></div>
    `;
    // Inline styles — keeps the dev-only panel self-contained without
    // touching the production stylesheets.
    Object.assign(el.style, {
      position: 'fixed', top: '60px', right: '12px', width: '480px',
      maxHeight: '70vh', overflowY: 'auto', background: 'rgba(20,20,28,0.96)',
      color: '#e6e6f0', border: '1px solid #3a3a4a', borderRadius: '6px',
      padding: '8px 10px', zIndex: '10000', fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: '11px', boxShadow: '0 6px 22px rgba(0,0,0,0.45)',
    });
    document.body.appendChild(el);
    this.el = el;

    el.querySelector('.parityPanel__close').addEventListener('click', () => this.hide());
    el.querySelector('.parityPanel__checkNow').addEventListener('click', () => {
      this.app.debugSync?.checkNow().then(() => this.refresh());
    });
    el.querySelector('.parityPanel__fixAll').addEventListener('click', () => {
      this.app._fixParityMismatch?.(this.app._lastParityMismatch);
    });

    // Minimal styles for child elements — appended once
    if (!document.getElementById('parityPanelStyles')) {
      const s = document.createElement('style');
      s.id = 'parityPanelStyles';
      s.textContent = `
        .parityPanel__header { display:flex; align-items:center; gap:6px; margin-bottom:6px; border-bottom:1px solid #2a2a36; padding-bottom:6px; }
        .parityPanel__title { font-weight:bold; flex:1; }
        .parityPanel button { background:#2a2a3a; color:#cfcfdf; border:1px solid #44445a; border-radius:3px; padding:2px 8px; cursor:pointer; font-size:11px; }
        .parityPanel button:hover { background:#3a3a50; }
        .parityPanel__close { padding:1px 6px !important; font-size:14px !important; }
        .parityPanel__summary { margin:4px 0 8px; }
        .parityPanel__section { margin-bottom:8px; }
        .parityPanel__sectionTitle { font-weight:bold; margin-bottom:2px; color:#a0a0b8; }
        .parityPanel__table { width:100%; border-collapse:collapse; }
        .parityPanel__table th, .parityPanel__table td { text-align:left; padding:1px 4px; border-bottom:1px solid #232330; }
        .parityPanel__fp { color:#7090c0; }
        .parityPanel__resync[disabled] { opacity:0.5; cursor:default; }
        .parityPanel__overflow { color:#777; font-style:italic; margin-top:2px; }
        .parityPanel__empty { color:#888; padding:10px 0; }
      `;
      document.head.appendChild(s);
    }
  }
}
