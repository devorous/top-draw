/**
 * Binds a button-like element so touch/pen pointer releases activate
 * immediately without waiting for a synthesized click.
 * @param {HTMLElement|null} element
 * @param {(event: Event) => void} handler
 */
export function bindPressAction(element, handler) {
  if (!element || typeof handler !== 'function') return;

  let lastPointerActivationAt = 0;
  const activationWindowMs = 400;

  element.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    lastPointerActivationAt = performance.now();
    e.preventDefault();
    handler(e);
  });

  element.addEventListener('click', (e) => {
    if (performance.now() - lastPointerActivationAt < activationWindowMs) {
      e.preventDefault();
      return;
    }
    handler(e);
  });
}
