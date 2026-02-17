/**
 * EditableValueHandler
 *
 * Handles click-to-edit and drag-to-adjust functionality for numeric value displays.
 *
 * Features:
 * - Click to open inline number input editor
 * - Vertical drag to adjust value (up = increase, down = decrease)
 * - Shift = 10x sensitivity, Alt = 0.1x sensitivity
 * - Drag threshold prevents accidental drags on clicks
 * - Enter commits, Escape cancels, blur commits
 * - Dynamic step sizes via dragStep function
 *
 * Usage:
 *   const handler = new EditableValueHandler();
 *   handler.makeEditable(spanElement, {
 *     min: 0,
 *     max: 100,
 *     step: 1,
 *     suffix: 'px',
 *     onCommit: (value) => { ... },
 *     dragStep: (currentVal) => currentVal < 10 ? 0.1 : 1  // optional
 *   });
 */
export class EditableValueHandler {
  constructor() {
    this.DRAG_THRESHOLD = 3; // px of vertical movement before drag starts
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

      // Use dragStep function for dynamic step sizes, or fall back to fixed step
      const currentStep = dragStep ? dragStep(dragState.lastVal ?? dragState.startVal) : step;

      let sensitivity = currentStep;
      if (e.shiftKey) sensitivity = currentStep * 10;
      else if (e.altKey) sensitivity = currentStep * 0.1;

      let val = dragState.startVal + dy * sensitivity;
      val = Math.max(min, Math.min(max, val));
      // Snap to the appropriate step for the current value
      const snapStep = dragStep ? dragStep(val) : step;
      val = Math.round(val / snapStep) * snapStep;
      val = parseFloat(val.toFixed(10));
      dragState.lastVal = val;

      spanEl.textContent = suffix ? `${val}${suffix}` : String(val);
      onCommit(val);
    });

    const endDrag = (e) => {
      if (!dragState) return;
      const wasDragging = dragState.dragging;
      spanEl.classList.remove('dragging');
      document.body.classList.remove('parameter-dragging');
      dragState = null;

      // If it was a click (no drag), open the text editor
      if (!wasDragging) {
        openEditor();
      }
    };

    spanEl.addEventListener('pointerup', endDrag);
    spanEl.addEventListener('pointercancel', endDrag);
  }
}
