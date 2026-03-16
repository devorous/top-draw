/**
 * @fileoverview Highlight utility for drawing attention to UI elements.
 * Adds an animated pulsing glow effect to any element. Useful for tutorials,
 * hints, and guiding users to relevant controls.
 */

const HIGHLIGHT_CLASS = 'ui-highlight';
const STYLE_ID = 'ui-highlight-style';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes ui-highlight-pulse {
      0%   { box-shadow: 0 0 4px 2px rgba(59, 130, 246, 0.5); }
      50%  { box-shadow: 0 0 12px 6px rgba(59, 130, 246, 0.8); }
      100% { box-shadow: 0 0 4px 2px rgba(59, 130, 246, 0.5); }
    }
    .${HIGHLIGHT_CLASS} {
      animation: ui-highlight-pulse 1.2s ease-in-out infinite;
      border-radius: 4px;
      position: relative;
      z-index: 1;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Highlight an element with a pulsing glow animation.
 * @param {HTMLElement} el - The element to highlight.
 * @param {number} [duration=3000] - How long to keep the highlight (ms). 0 = indefinite.
 * @returns {() => void} A function to remove the highlight early.
 */
export function highlight(el, duration = 3000) {
  if (!el) return () => {};
  ensureStyles();

  el.classList.add(HIGHLIGHT_CLASS);

  const remove = () => el.classList.remove(HIGHLIGHT_CLASS);

  if (duration > 0) {
    const timer = setTimeout(remove, duration);
    return () => { clearTimeout(timer); remove(); };
  }

  return remove;
}

/**
 * Remove highlight from an element immediately.
 * @param {HTMLElement} el - The element to unhighlight.
 */
export function unhighlight(el) {
  if (el) el.classList.remove(HIGHLIGHT_CLASS);
}
