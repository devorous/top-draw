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
   * @param {number} opts.min - Minimum value
   * @param {number} opts.max - Maximum value
   * @param {number} opts.step - Step size for snapping
   * @param {string} [opts.suffix=''] - Suffix to append to display value (e.g., 'px', '%')
   * @param {Function} opts.onCommit - Callback when value changes: (newValue) => {}
   * @param {Function} [opts.dragStep] - Optional function to compute dynamic step: (currentVal) => step
   */
  makeEditable(spanEl, opts) {
    const { min, max, step, suffix = '', onCommit, dragStep } = opts;

    let dragState = null;

    /**
     * Opens the inline text editor for the value.
     */
    const openEditor = () => {
      if (spanEl.querySelector('.sliderValueInput')) return;

      const originalText = spanEl.textContent;
      const currentVal = parseFloat(originalText.replace(suffix, '').trim());

      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sliderValueInput';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = isNaN(currentVal) ? min : currentVal;

      spanEl.textContent = '';
      spanEl.appendChild(input);
      input.focus();
      input.select();

      const commit = () => {
        let val = parseFloat(input.value);
        if (isNaN(val)) val = min;
        val = Math.max(min, Math.min(max, val));
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
      const startVal = parseFloat(currentText.replace(suffix, '').trim()) || min;

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
      val = Math.max(min, Math.min(max, val));
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
