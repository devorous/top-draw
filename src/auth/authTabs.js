/**
 * Guest / Sign in / Register segmented control on the landing page.
 *
 * This lives outside Auth.js on purpose: the landing page is interactive well
 * before the deferred App chunk (and with it Auth) finishes loading, so the
 * tabs have to be wired from main.js at first paint. Auth then adopts the same
 * singleton controller instead of binding its own listeners.
 *
 * The markup does the heavy lifting — panes toggle via the [hidden] attribute
 * and the sliding thumb is positioned purely off [data-active-tab] — so nothing
 * here writes inline styles.
 */

let controller = null;

/**
 * Wire the tablist. Idempotent: repeat calls return the existing controller.
 * @returns {{ setActive: Function, getActive: Function, subscribe: Function } | null}
 */
export function initAuthTabs() {
  if (controller) return controller;

  const tabs = document.getElementById('authTabs');
  const container = document.getElementById('authNotLoggedIn');
  if (!tabs || !container) return null;

  const buttons = Array.from(tabs.querySelectorAll('[data-auth-tab]'));
  const panes = Array.from(container.querySelectorAll('[data-auth-pane]'));
  if (!buttons.length) return null;

  let active = null;
  const listeners = new Set();

  /**
   * @param {string} name - 'guest' | 'signin' | 'register'
   * @param {{ focus?: boolean }} [options] - `focus` drops the caret into the
   *   pane's first text field, but only on fine pointers so tapping a tab on
   *   mobile doesn't fling the on-screen keyboard open.
   */
  function setActive(name, { focus = false } = {}) {
    if (!name || !buttons.some((btn) => btn.dataset.authTab === name)) return;

    active = name;
    tabs.setAttribute('data-active-tab', name);

    buttons.forEach((btn) => {
      const selected = btn.dataset.authTab === name;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
    });

    let activePane = null;
    panes.forEach((pane) => {
      const selected = pane.dataset.authPane === name;
      pane.hidden = !selected;
      if (selected) activePane = pane;
    });

    listeners.forEach((fn) => fn(name));

    if (focus && activePane && window.matchMedia?.('(pointer: fine)').matches) {
      activePane.querySelector('input:not([type="checkbox"]):not([type="hidden"])')?.focus();
    }
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      setActive(btn.dataset.authTab, { focus: true });
    });
  });

  // Roving tabindex: arrow keys move between tabs, per the tablist pattern.
  tabs.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const current = buttons.findIndex((btn) => btn.dataset.authTab === active);
    const next = (current + dir + buttons.length) % buttons.length;
    setActive(buttons[next].dataset.authTab);
    buttons[next].focus();
  });

  controller = {
    setActive,
    getActive: () => active,
    /** @returns {Function} unsubscribe */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };

  // Adopt whichever tab the markup marks selected, defaulting to Guest.
  const initial = buttons.find((btn) => btn.getAttribute('aria-selected') === 'true');
  setActive(initial?.dataset.authTab || buttons[0].dataset.authTab);

  return controller;
}

export function setActiveAuthTab(name, options) {
  initAuthTabs()?.setActive(name, options);
}

export function getActiveAuthTab() {
  return controller?.getActive() || 'guest';
}
