/**
 * @fileoverview Handles click-to-edit functionality for numeric value displays.
 */

/**
 * EditableValueHandler class
 */
export class EditableValueHandler {
  /**
   * Make a span element editable by clicking it to type a value.
   *
   * These values sit on top of the slider track now, so there is deliberately
   * no drag-to-adjust: a vertical drag on the number fought with the bar
   * underneath it, and the bar is the faster way to change the value anyway.
   *
   * @param {HTMLElement} spanEl - The span element to make editable
   * @param {Object} opts - Configuration options
   * @param {number|Function} opts.min - Minimum value or function returning it
   * @param {number|Function} opts.max - Maximum value or function returning it
   * @param {number} opts.step - Step size for snapping
   * @param {string} [opts.suffix=''] - Suffix to append to display value (e.g., 'px', '%')
   * @param {Function} opts.onCommit - Callback when value changes: (newValue) => {}
   */
  makeEditable(spanEl, opts) {
    const { min, max, step, suffix = '', onCommit } = opts;
    const resolveBound = (bound) => {
      const value = typeof bound === 'function' ? bound() : bound;
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    };

    /**
     * Opens the inline text editor for the value.
     */
    const openEditor = () => {
      if (spanEl.querySelector('.sliderValueInput')) return;

      const originalText = spanEl.textContent;
      const currentMin = resolveBound(min);
      const currentMax = resolveBound(max);
      const currentVal = parseFloat(originalText.replace(suffix, '').trim());

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sliderValueInput';
      input.inputMode = Number.isInteger(step) ? 'numeric' : 'decimal';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = isNaN(currentVal) ? currentMin : currentVal;
      input.style.width = `${Math.max(String(input.value).length, 2)}ch`;

      spanEl.textContent = '';
      spanEl.appendChild(input);
      input.focus();
      input.select();

      const commit = () => {
        const commitMin = resolveBound(min);
        const commitMax = resolveBound(max);
        let val = parseFloat(input.value);
        if (isNaN(val)) val = commitMin;
        val = Math.max(commitMin, Math.min(commitMax, val));
        val = Math.round(val / step) * step;
        val = parseFloat(val.toFixed(10));

        spanEl.textContent = suffix ? `${val}${suffix}` : String(val);
        onCommit(val);
      };

      const cancel = () => {
        spanEl.textContent = originalText;
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') {
          ke.preventDefault();
          input.removeEventListener('blur', commit);
          commit();
        } else if (ke.key === 'Escape') {
          ke.preventDefault();
          input.removeEventListener('blur', commit);
          cancel();
        }
        ke.stopPropagation();
      });
    };

    // Kept off the track underneath, which owns the drag.
    spanEl.addEventListener('pointerdown', (e) => {
      if (spanEl.querySelector('.sliderValueInput')) return;
      e.stopPropagation();
    });

    // Opened on click, not pointerdown: a touch swipe that starts on the number
    // should scroll the panel, and only a real tap produces a click.
    spanEl.addEventListener('click', (e) => {
      if (spanEl.querySelector('.sliderValueInput')) return;
      e.stopPropagation();
      openEditor();
    });
  }
}
