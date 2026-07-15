/**
 * @fileoverview Supporter popup — the pitch + purchase dialog for the monthly
 * supporter subscription.
 *
 * Shows an animated preview of the supporter cosmetics (gold cursor + name on
 * the board, gold chat name, supporter badge) and a checkout button that
 * redirects to Stripe. Self-contained like ProfileDialog: injects its own
 * styles and builds its DOM on demand.
 */

const GOLD = '#f5c542';

const STYLES = `
.supporter-dialog-backdrop {
  position: fixed; inset: 0; z-index: 10050;
  background: rgba(10, 12, 18, 0.6);
  display: flex; align-items: center; justify-content: center;
  animation: supporterFadeIn 0.18s ease;
  backdrop-filter: blur(2px);
}
@keyframes supporterFadeIn { from { opacity: 0; } to { opacity: 1; } }

.supporter-dialog {
  position: relative;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  background: var(--bg-secondary, #1d2330);
  color: var(--text-primary, #f0f2f5);
  border: 1px solid rgba(245, 197, 66, 0.35);
  border-radius: var(--radius-lg, 16px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 24px rgba(245, 197, 66, 0.12);
  padding: 20px;
  animation: supporterPopIn 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
@keyframes supporterPopIn { from { transform: scale(0.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }

.supporter-dialog-close {
  position: absolute; top: 10px; right: 12px;
  background: none; border: none; cursor: pointer;
  color: inherit; opacity: 0.6; font-size: 22px; line-height: 1;
}
.supporter-dialog-close:hover { opacity: 1; }

.supporter-dialog h2 {
  margin: 0 0 4px; font-size: 20px; text-align: center;
  color: ${GOLD};
}
.supporter-dialog .supporter-sub {
  margin: 0 0 14px; text-align: center; font-size: 13px; opacity: 0.75;
}

/* --- Showcase row: cursor preview on the left, mock chat on the right. --- */
.supporter-showcase {
  display: flex; gap: 10px; margin-bottom: 14px;
}

/* Static cursor preview: mirrors the live board look from _cursors.scss
   (SVG ring with 1px gold stroke + 3px drop-shadow; name label offset
   up-right of the point like the live .name element), at 2x ring size. */
.supporter-preview {
  position: relative; overflow: hidden;
  flex: 1; min-width: 0; height: 110px; border-radius: 10px;
  background: var(--bg-primary, #141926);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.supporter-preview .previewCursor {
  position: absolute; left: 50%; top: 62%; width: 0; height: 0;
}
.supporter-preview .previewRing {
  position: absolute; left: -20px; top: -20px; width: 40px; height: 40px;
  border: 1px solid ${GOLD}; border-radius: 50%;
  filter: drop-shadow(0 0 3px rgba(245, 197, 66, 0.45));
}
.supporter-preview .previewName {
  position: absolute; left: 3px; top: -32px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
  color: ${GOLD}; text-shadow: 0 0 4px rgba(245, 197, 66, 0.45);
}

/* --- Badge showcase: the golden pepper as it appears next to your name. --- */
.supporter-badge-panel {
  flex: 1; min-width: 0; height: 110px; border-radius: 10px;
  box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  background: var(--bg-primary, #141926);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.supporter-badge-panel img { width: 42px; height: 42px; object-fit: contain; }
.supporter-badge-panel .badgeCaption { font-size: 12px; opacity: 0.75; }

/* --- Perks --- */
.supporter-perks { list-style: none; margin: 0 0 16px; padding: 0; font-size: 13.5px; }
.supporter-perks li { display: flex; gap: 8px; align-items: center; padding: 3px 0; }
.supporter-perks li::before { content: '★'; color: ${GOLD}; font-size: 12px; }

/* --- CTA --- */
.supporter-cta-row { display: flex; gap: 8px; }
.supporter-cta-row .supporter-cta { flex: 1; }
.supporter-cta {
  display: block; width: 100%; padding: 12px; border: none; cursor: pointer;
  border-radius: 10px; font-size: 15px; font-weight: 700;
  color: #201a08; background: linear-gradient(180deg, #ffd76a, ${GOLD});
  box-shadow: 0 2px 12px rgba(245, 197, 66, 0.35);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.supporter-cta:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(245, 197, 66, 0.5); }
.supporter-cta:disabled { opacity: 0.55; cursor: default; }
.supporter-cta.secondary {
  background: none; color: ${GOLD};
  border: 1px solid rgba(245, 197, 66, 0.5); box-shadow: none;
}
.supporter-note { margin: 10px 0 0; text-align: center; font-size: 12px; opacity: 0.6; }
.supporter-error { margin: 10px 0 0; text-align: center; font-size: 12.5px; color: #ff8a8a; }
.supporter-thanks { text-align: center; font-size: 14px; margin: 0 0 10px; color: ${GOLD}; }
`;

export class SupporterDialog {
  constructor({ apiBaseUrl = '' } = {}) {
    this.apiBaseUrl = apiBaseUrl;
    this._backdrop = null;
    this._stylesInjected = false;
    this._busy = false;
    this._boundKeydown = (e) => { if (e.key === 'Escape') this.close(); };
  }

  _injectStyles() {
    if (this._stylesInjected) return;
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
    this._stylesInjected = true;
  }

  _getAuthToken() {
    try { return localStorage.getItem('topDrawAuthToken') || ''; }
    catch { return ''; }
  }

  _isLoggedIn() {
    return !!(this._getAuthToken() && window.app?.self?.registeredName);
  }

  _isSupporter() {
    return !!window.app?.self?.isSupporter;
  }

  show() {
    this._injectStyles();
    this.close();

    const loggedIn = this._isLoggedIn();
    const isSupporter = this._isSupporter();

    this._backdrop = document.createElement('div');
    this._backdrop.className = 'supporter-dialog-backdrop';
    this._backdrop.innerHTML = `
      <div class="supporter-dialog" role="dialog" aria-label="Become a Supporter">
        <button class="supporter-dialog-close" title="Close">&times;</button>
        <h2>Support Top Draw</h2>
        <p class="supporter-sub">Keep the boards running — and draw with gold.</p>

        <div class="supporter-showcase" aria-hidden="true">
          <div class="supporter-preview">
            <div class="previewCursor">
              <div class="previewRing"></div>
              <div class="previewName">You!</div>
            </div>
          </div>

          <div class="supporter-badge-panel">
            <img src="/images/pepper-gold.png" alt="Golden pepper badge">
            <span class="badgeCaption">Golden Pepper badge</span>
          </div>
        </div>

        <ul class="supporter-perks">
          <li>Golden cursor &amp; name on the board</li>
          <li>Exclusive Golden Pepper badge</li>
          <li>Your gold shows in replays &amp; timelapses too</li>
        </ul>

        ${isSupporter ? '<p class="supporter-thanks">You’re a supporter — thank you! 💛</p>' : ''}
        ${isSupporter
          ? `<button class="supporter-cta secondary" data-action="portal" ${loggedIn ? '' : 'disabled'}>Manage your support</button>`
          : `<div class="supporter-cta-row">
              <button class="supporter-cta secondary" data-action="checkout-once" ${loggedIn ? '' : 'disabled'}>Support once</button>
              <button class="supporter-cta" data-action="checkout-monthly" ${loggedIn ? '' : 'disabled'}>Support monthly</button>
            </div>`}
        <p class="supporter-note">${loggedIn
          ? (isSupporter ? 'Update payment details or cancel anytime.' : 'One time or monthly support · cancel anytime · secure checkout via Stripe')
          : 'Log in to become a supporter.'}</p>
        <p class="supporter-error" style="display:none"></p>
      </div>
    `;

    this._backdrop.addEventListener('click', (e) => {
      if (e.target === this._backdrop) this.close();
    });
    this._backdrop.querySelector('.supporter-dialog-close').addEventListener('click', () => this.close());
    for (const btn of this._backdrop.querySelectorAll('.supporter-cta')) {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'portal') this._openPortal(btn);
        else if (action === 'checkout-once') this._startCheckout('once', btn);
        else if (action === 'checkout-monthly') this._startCheckout('monthly', btn);
      });
    }
    document.addEventListener('keydown', this._boundKeydown);
    document.body.appendChild(this._backdrop);
  }

  close() {
    document.removeEventListener('keydown', this._boundKeydown);
    this._backdrop?.remove();
    this._backdrop = null;
    this._busy = false;
  }

  async _startCheckout(type, btn) {
    await this._redirectTo('/api/stripe/create-checkout-session', 'Starting checkout…', btn, { type });
  }

  async _openPortal(btn) {
    await this._redirectTo('/api/stripe/create-portal-session', 'Opening billing portal…', btn);
  }

  async _redirectTo(endpoint, busyLabel, btn, body = null) {
    if (this._busy) return;
    btn = btn || this._backdrop?.querySelector('.supporter-cta');
    const errEl = this._backdrop?.querySelector('.supporter-error');
    if (!btn) return;
    this._busy = true;
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    if (errEl) errEl.style.display = 'none';

    try {
      const res = await fetch(`${this.apiBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this._getAuthToken()}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Payments are not available right now');
      }
      window.location.href = data.url;
    } catch (err) {
      this._busy = false;
      btn.disabled = false;
      btn.textContent = originalLabel;
      if (errEl) {
        errEl.textContent = err.message || 'Something went wrong';
        errEl.style.display = '';
      }
    }
  }

  /**
   * Handle the ?supporter=success|cancelled return from Stripe checkout.
   * Call once on app startup; strips the param and shows a toast.
   */
  handleCheckoutReturn() {
    let params;
    try { params = new URLSearchParams(window.location.search); }
    catch { return; }
    const result = params.get('supporter');
    if (!result) return;

    params.delete('supporter');
    const query = params.toString();
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);

    if (result === 'success') {
      window.app?.ui?.showToast?.('Welcome aboard, Supporter! Your gold arrives as soon as the payment settles. 💛', 6000);
    } else if (result === 'cancelled') {
      window.app?.ui?.showToast?.('Checkout cancelled — no worries.', 3500);
    }
  }

  _escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
}

export const supporterDialog = new SupporterDialog({
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || ''
});
