let stylesInstalled = false;
let activeDialog = null;

function installStyles() {
  if (stylesInstalled || document.getElementById('appConfirmDialogStyles')) return;
  stylesInstalled = true;

  const style = document.createElement('style');
  style.id = 'appConfirmDialogStyles';
  style.textContent = `
    .appConfirmBackdrop {
      position: fixed;
      inset: 0;
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: rgba(0, 0, 0, 0.58);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .appConfirmDialog {
      width: min(420px, 100%);
      border: 1px solid color-mix(in srgb, var(--border-color, rgba(255, 255, 255, 0.18)) 78%, white);
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg-secondary, #1f2430) 92%, black);
      color: var(--text-primary, #f4f4f5);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.46);
      font: inherit;
      overflow: hidden;
    }

    .appConfirmHeader {
      padding: 16px 18px 8px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .appConfirmMessage {
      padding: 0 18px 18px;
      color: var(--text-secondary, #c8cbd3);
      font-size: 13px;
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .appConfirmActions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid color-mix(in srgb, var(--border-color, rgba(255, 255, 255, 0.14)) 75%, transparent);
      background: color-mix(in srgb, var(--bg-tertiary, #282d3a) 55%, transparent);
    }

    .appConfirmButton {
      min-width: 84px;
      min-height: 34px;
      border: 1px solid color-mix(in srgb, var(--border-color, rgba(255, 255, 255, 0.18)) 85%, white);
      border-radius: 6px;
      padding: 7px 13px;
      background: var(--bg-secondary, #252b38);
      color: var(--text-primary, #f4f4f5);
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
    }

    .appConfirmButton:hover,
    .appConfirmButton:focus-visible {
      border-color: var(--accent-primary, #7c5cbf);
      outline: none;
    }

    .appConfirmButton.primary {
      border-color: color-mix(in srgb, var(--accent-primary, #7c5cbf) 76%, white);
      background: var(--accent-primary, #7c5cbf);
      color: white;
    }

    .appConfirmButton.danger {
      border-color: color-mix(in srgb, var(--danger, #ff5f6d) 76%, white);
      background: var(--danger, #c93f4d);
      color: white;
    }
  `;
  document.head.appendChild(style);
}

function closeActiveDialog(result = false) {
  if (!activeDialog) return;
  const { backdrop, resolve, previousFocus } = activeDialog;
  activeDialog = null;
  backdrop.remove();
  previousFocus?.focus?.();
  resolve(result);
}

export function showAppConfirm(message, options = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);

  installStyles();
  if (activeDialog) closeActiveDialog(false);

  const {
    title = 'Confirm',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false
  } = options;

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'appConfirmBackdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'appConfirmDialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'appConfirmTitle');
    dialog.setAttribute('aria-describedby', 'appConfirmMessage');

    const header = document.createElement('div');
    header.id = 'appConfirmTitle';
    header.className = 'appConfirmHeader';
    header.textContent = title;

    const body = document.createElement('div');
    body.id = 'appConfirmMessage';
    body.className = 'appConfirmMessage';
    body.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'appConfirmActions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'appConfirmButton';
    cancel.textContent = cancelLabel;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = `appConfirmButton ${danger ? 'danger' : 'primary'}`;
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    dialog.append(header, body, actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    activeDialog = { backdrop, resolve, previousFocus };

    cancel.addEventListener('click', () => closeActiveDialog(false));
    confirm.addEventListener('click', () => closeActiveDialog(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeActiveDialog(false);
    });
    backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeActiveDialog(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        closeActiveDialog(true);
      }
    });

    confirm.focus();
  });
}

export function installAppConfirmGlobal() {
  if (typeof window === 'undefined') return;
  window.showAppConfirm = showAppConfirm;
}
