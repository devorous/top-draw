/**
 * @fileoverview Tiny leveled debug gate for the client.
 *
 * Routes verbose/diagnostic logging through a single switch so it stays out of
 * production hot paths. Enabled when Vite is in dev mode, or at runtime by
 * setting `window.__DEBUG__ = true` (or `localStorage.debug = '1'`) — handy for
 * diagnosing a deployed build without a rebuild.
 *
 * Use this for chatty/per-frame/per-message/per-connection logs. Keep genuine
 * error reporting on `console.error` so real failures always surface.
 */

function isEnabled() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) return true;
  } catch { /* import.meta not available in some contexts */ }
  if (typeof window !== 'undefined') {
    if (window.__DEBUG__) return true;
    try {
      if (window.localStorage && window.localStorage.getItem('debug')) return true;
    } catch { /* localStorage can throw (privacy mode / sandboxed) */ }
  }
  return false;
}

export const debug = (...args) => { if (isEnabled()) console.log(...args); };
debug.warn = (...args) => { if (isEnabled()) console.warn(...args); };
debug.trace = (...args) => { if (isEnabled()) console.trace(...args); };
debug.enabled = isEnabled;

export default debug;
