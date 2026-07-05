// Central mobile/Android detection. Mirrors the split in desktop.js:
// Tauri globals alone mean "Tauri app", not "desktop" — the Android build
// exposes the same globals, so the UA distinguishes the two.
function hasTauriGlobals() {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);
}

function isAndroidUserAgent() {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

// True only inside the Tauri Android app.
export function isAndroidApp() {
  return hasTauriGlobals() && isAndroidUserAgent();
}

// Evaluated once at module load. Mobile-ness must not flap mid-session
// (e.g. soft-keyboard resizes shrink the viewport below any width threshold).
const MOBILE = (() => {
  if (typeof window === 'undefined') return false;
  if (isAndroidApp()) return true;
  try {
    return (
      window.matchMedia('(pointer: coarse)').matches &&
      Math.min(window.screen.width, window.screen.height) < 768
    );
  } catch {
    return false;
  }
})();

export function isMobile() {
  return MOBILE;
}

// Tools hidden from the local UI on mobile. Registry/rendering keeps them so
// remote users drawing with these tools still render correctly.
export const MOBILE_HIDDEN_TOOLS = ['confetti', 'glitchBlur', 'imageBrush', 'pattern'];
