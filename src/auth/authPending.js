/**
 * The "Loading account..." state on the landing page.
 *
 * Split out of Auth.js so main.js can set it at first paint: Auth lives in the
 * deferred App chunk, and until that lands nothing was hiding the login form —
 * so the Guest/Sign in/Register tabs rendered underneath the loading row.
 */

export const AUTH_TOKEN_KEY = 'topDrawAuthToken';

/**
 * Is there a stored token to resolve? Without one there is nothing to wait for,
 * so the form can be shown immediately instead of flashing a spinner over it.
 * @returns {boolean}
 */
export function hasStoredAuthToken() {
  try {
    return !!localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return false;
  }
}

/**
 * Toggle the loading row against the login form. DOM only — Auth layers its
 * own bookkeeping (pending timeout, join-button disabling) on top of this.
 * @param {boolean} pending
 */
export function applyAuthPendingUI(pending) {
  document.getElementById('landingAuthPanel')?.classList.toggle('auth-is-pending', pending);

  const loadingState = document.getElementById('authLoadingState');
  if (loadingState) loadingState.style.display = pending ? 'flex' : 'none';

  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.style.display = pending ? 'none' : '';
}
