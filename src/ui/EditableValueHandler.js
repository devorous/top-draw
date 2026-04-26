/**
 * @fileoverview Handles click-to-edit and drag-to-adjust functionality for numeric value displays.
 */

/**
 * EditableValueHandler class
 */
export class EditableValueHandler {
  constructor() {
    /**
     * Pixels of vertical movement before drag starts.
     * @type {number}
     */
    this.DRAG_THRESHOLD = 3;
  }

  /**
   * Make a span element editable with click-to-edit and drag-to-adjust
   * @param {HTMLElement} spanEl - The span element to make editable
   * @param {Object} opts - Configuration options
   * @param {number|Function} opts.min - Minimum value or function returning it
   * @param {number|Function} opts.max - Maximum value or function returning it
   * @param {number} opts.step - Step size for snapping
   * @param {string} [opts.suffix=''] - Suffix to append to display value (e.g., 'px', '%')
   * @param {Function} opts.onCommit - Callback when value changes: (newValue) => {}
   * @param {Function} [opts.dragStep] - Optional function to compute dynamic step: (currentVal) => step
   */
  makeEditable(spanEl, opts) {
    const { min, max, step, suffix = '', onCommit, dragStep } = opts;
    const resolveBound = (bound) => {
      const value = typeof bound === 'function' ? bound() : bound;
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    };

    let dragState = null;

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

    spanEl.addEventListener('pointerdown', (e) => {
      if (spanEl.querySelector('.sliderValueInput')) return;
      e.preventDefault();

      const currentText = spanEl.textContent;
      const currentMin = resolveBound(min);
      const startVal = parseFloat(currentText.replace(suffix, '').trim()) || currentMin;

      dragState = {
        startY: e.clientY,
        startVal,
        dragging: false,
        pointerId: e.pointerId
      };

      spanEl.setPointerCapture(e.pointerId);
    });

    spanEl.addEventListener('pointermove', (e) => {
      if (!dragState) return;

      const dy = dragState.startY - e.clientY; // up = positive

      if (!dragState.dragging) {
        if (Math.abs(dy) < this.DRAG_THRESHOLD) return;
        dragState.dragging = true;
        spanEl.classList.add('dragging');
        document.body.classList.add('parameter-dragging');
      }

      const currentStep = dragStep ? dragStep(dragState.lastVal ?? dragState.startVal) : step;

      let sensitivity = currentStep;
      if (e.shiftKey) sensitivity = currentStep * 10;
      else if (e.altKey) sensitivity = currentStep * 0.1;

      let val = dragState.startVal + dy * sensitivity;
      val = Math.max(resolveBound(min), Math.min(resolveBound(max), val));
      const snapStep = dragStep ? dragStep(val) : step;
      val = Math.round(val / snapStep) * snapStep;
      val = parseFloat(val.toFixed(10));
      dragState.lastVal = val;

      spanEl.textContent = suffix ? `${val}${suffix}` : String(val);
      onCommit(val);
    });

    /**
     * Ends the drag operation.
     * @param {PointerEvent} e - Pointer event
     */
    const endDrag = (e) => {
      if (!dragState) return;
      const wasDragging = dragState.dragging;
      spanEl.classList.remove('dragging');
      document.body.classList.remove('parameter-dragging');
      dragState = null;

      if (!wasDragging) {
        openEditor();
      }
    };

    spanEl.addEventListener('pointerup', endDrag);
    spanEl.addEventListener('pointercancel', endDrag);
  }
}
