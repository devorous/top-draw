/**
 * @fileoverview Mobile layout behaviour: keeps the tool options panel as a
 * tap-to-open overlay on mobile, and owns the desktop narrow-window
 * auto-collapse that previously lived inline in App.handleResize().
 */
import { isMobile } from '../platform/mobile.js';

export class MobileLayoutController {
  constructor(app) {
    this.app = app;
    this._wasNarrow = undefined;
    this._pressWasSelected = false;
  }

  /**
   * Called once after App.setupEventListeners(). No-op on desktop.
   */
  init() {
    if (!isMobile()) return;
    const ui = this.app.ui;

    this.relocateTopbarForMobile();

    // Start with the options overlay closed; only explicit taps open it.
    ui.setSidebarCollapsed(true);

    const tools = document.querySelector('#sideMenu .tools');
    if (tools) {
      // Whether the tapped tool was already selected must be read before the
      // button's own click handler selects it.
      tools.addEventListener('pointerdown', (event) => {
        const btn = event.target.closest('.tool.btn');
        this._pressWasSelected = !!btn?.classList.contains('selected');
      }, true);

      tools.addEventListener('click', (event) => {
        const btn = event.target.closest('.tool.btn');
        if (!btn) return;
        if (btn.classList.contains('sidebarToggleBtn') || btn.classList.contains('sidebarUtilityBtn')) return;
        // Re-tapping the active tool toggles its options overlay; switching
        // tools leaves the overlay as-is so sketching stays uninterrupted.
        if (this._pressWasSelected) {
          ui.toggleSidebar();
        }
      });
    }

    // Any interaction with the board area dismisses the overlay.
    document.getElementById('boardContainer')?.addEventListener('pointerdown', () => {
      if (!ui.elements.toolOptions?.classList.contains('collapsed')) {
        ui.setSidebarCollapsed(true);
      }
    }, true);
  }

  /**
   * Moves secondary topbar buttons into the hamburger dropdown
   * (#collapsibleBtns). IDs and event listeners survive appendChild, so all
   * existing wiring keeps working. Runs once at startup, before any
   * topbar collapse measurement could observe the bar
   * (App.updateTopbarCollapseState is also short-circuited on mobile).
   */
  relocateTopbarForMobile() {
    const menu = document.getElementById('collapsibleBtns');
    if (!menu) return;

    const moveSection = (selectors) => {
      const section = document.createElement('div');
      section.className = 'mobileMenuSection';
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) section.appendChild(el);
      }
      if (section.childElementCount > 0) menu.appendChild(section);
    };

    // View controls (zoom in/out + flip as one row, recorder below)
    moveSection(['.boardBtns .zoomBtns', '#tapeRecBtn']);
    // File / communication
    moveSection(['#uploadBtn', '#saveBtn', '#inboxBtn']);
    // Room / admin (mostly hidden unless relevant)
    moveSection(['#adminTopBtn', '#registerRoomBtn', '#roomSettingsBtn']);
  }

  /**
   * Desktop-only narrow-window auto-collapse (moved from App.handleResize).
   * On mobile the overlay never auto-opens or auto-closes on resize — the
   * soft keyboard resizes the viewport constantly.
   */
  handleResize() {
    if (isMobile()) return;
    const isNarrow = window.innerWidth < 768;
    if (this._wasNarrow !== isNarrow) {
      this.app.ui.setSidebarCollapsed(isNarrow);
      this._wasNarrow = isNarrow;
    }
  }
}
