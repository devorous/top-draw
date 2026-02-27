/**
 * ToolLockManager - Manages per-tool locked property values
 * Allows users to lock tool properties (size, pressure, smoothing, etc.) so they persist when switching tools
 */

export class ToolLockManager {
  constructor(app) {
    this.app = app;
    this.toolLocks = this.loadToolLocks();
  }

  loadToolLocks() {
    try {
      const saved = localStorage.getItem('topDrawToolLocks');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load tool locks:', e);
    }

    // Default structure
    return this.getDefaultToolLocks();
  }

  getDefaultToolLocks() {
    const tools = {
      brush: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      flowPen: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      ink: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      line: ['size', 'pressure', 'hardness', 'opacity'],
      rectangle: ['size', 'pressure', 'hardness', 'opacity'],
      circle: ['size', 'pressure', 'hardness', 'opacity'],
      erase: ['size', 'pressure', 'opacity'],
      blur: ['size', 'blurRadius', 'spacing'],
      imageBrush: ['size', 'pressure', 'spacing', 'opacity'],
      text: ['size', 'opacity'],
      select: [],
      inkdropper: []
    };

    const locks = {};

    for (const [tool, props] of Object.entries(tools)) {
      locks[tool] = {};
      props.forEach(prop => {
        if (prop === 'pressure') {
          locks[tool][prop] = { locked: false, min: 0, max: 100, enabled: true };
        } else {
          // Default values based on property type
          let defaultValue = 0;
          if (prop === 'size') defaultValue = 10;
          if (prop === 'smoothing') defaultValue = 0.3;
          if (prop === 'hardness') defaultValue = 1.0;
          if (prop === 'opacity') defaultValue = 1.0;
          if (prop === 'blurRadius') defaultValue = 5;
          if (prop === 'spacing') defaultValue = 0;

          locks[tool][prop] = { locked: false, value: defaultValue };
        }
      });
    }

    return locks;
  }

  saveToolLocks() {
    try {
      localStorage.setItem('topDrawToolLocks', JSON.stringify(this.toolLocks));
    } catch (e) {
      console.warn('Failed to save tool locks:', e);
    }
  }

  saveLockedValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, pressureEnabled } = this.app;

    // Only save values for properties that exist for this tool and are locked
    for (const [prop, state] of Object.entries(locks)) {
      if (!state.locked) continue;

      if (prop === 'size') state.value = self.size;
      else if (prop === 'pressure') {
        state.min = Number(ui.elements.pressureMinSlider.value);
        state.max = Number(ui.elements.pressureMaxSlider.value);
        state.enabled = pressureEnabled;
      }
      else if (prop === 'smoothing') state.value = self.smoothing;
      else if (prop === 'spacing') state.value = self.spacing;
      else if (prop === 'hardness') state.value = self.hardness;
      else if (prop === 'opacity') state.value = self.opacity;
      else if (prop === 'blurRadius') state.value = self.blurRadius;
    }

    this.saveToolLocks();
  }

  restoreLockedValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, wsClient, connected, pressureEnabled, colorPicker } = this.app;
    const { elements } = ui;

    // Only restore values for properties that exist for this tool and are locked
    for (const [prop, state] of Object.entries(locks)) {
      if (!state.locked) continue;

      if (prop === 'size') {
        self.setSize(state.value);
        ui.updateSizeValue(state.value);
        ui.updateCursorSize(state.value);
        if (elements.sizeSlider) elements.sizeSlider.value = state.value;
        if (connected) {
          wsClient.broadcastSizeChange(state.value);
        }
      }
      else if (prop === 'pressure') {
        // Backward compat check
        let pMin, pMax, pEnabled;
        if (state.value !== undefined && state.min === undefined) {
          pMin = 0;
          pMax = Math.round(state.value * 100);
          pEnabled = true;
        } else {
          pMin = state.min ?? 0;
          pMax = state.max ?? 100;
          pEnabled = state.enabled ?? true;
        }
        if (elements.pressureMinSlider) elements.pressureMinSlider.value = pMin;
        if (elements.pressureMaxSlider) elements.pressureMaxSlider.value = pMax;
        ui.updatePressureValue(pMin, pMax);
        this.app.pressureEnabled = pEnabled;
        if (elements.pressureEnabled) elements.pressureEnabled.checked = pEnabled;
        if (elements.pressureDualSlider) elements.pressureDualSlider.style.display = pEnabled ? '' : 'none';
      }
      else if (prop === 'smoothing') {
        self.setSmoothing(state.value);
        ui.updateSmoothingValue(state.value * 100);
        if (elements.smoothingSlider) elements.smoothingSlider.value = state.value * 100;
        if (connected) {
          wsClient.broadcastSmoothingChange(state.value);
        }
      }
      else if (prop === 'spacing') {
        self.setSpacing(state.value);
        ui.updateSpacingValue(state.value);
        if (elements.spacingSlider) elements.spacingSlider.value = state.value;
        if (connected) {
          wsClient.broadcastSpacingChange(state.value);
        }
      }
      else if (prop === 'hardness') {
        self.setHardness(state.value);
        ui.updateHardnessValue(state.value * 100);
        if (elements.hardnessSlider) elements.hardnessSlider.value = state.value * 100;
        if (connected) {
          wsClient.broadcastHardnessChange(state.value);
        }
      }
      else if (prop === 'opacity') {
        const currentColor = [...self.color];
        currentColor[3] = state.value;
        self.setColor(currentColor);
        self.setOpacity(state.value);
        ui.updateopacityValue(state.value);
        if (elements.opacitySlider) elements.opacitySlider.value = state.value * 100;
        if (colorPicker) {
          colorPicker.setColor(`rgba(${currentColor.join(',')})`, true);
        }
        if (connected) {
          wsClient.broadcastColorChange(currentColor);
        }
      }
      else if (prop === 'blurRadius') {
        self.setBlurRadius(state.value);
        ui.updateBlurRadiusValue(state.value);
        if (elements.blurRadiusSlider) elements.blurRadiusSlider.value = state.value;
        if (connected) {
          wsClient.broadcastBlurRadiusChange(state.value);
        }
      }
    }
  }

  updateAllLockButtons(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { ui } = this.app;
    const allProps = ['size', 'pressure', 'smoothing', 'spacing', 'hardness', 'opacity', 'blurRadius'];
    
    allProps.forEach(prop => {
      const lock = locks[prop];
      if (lock) {
        ui.updateLockButton(prop, lock.locked, true); // visible
      } else {
        ui.updateLockButton(prop, false, false); // hidden
      }
    });
  }

  toggleLock(property) {
    const { self, ui, pressureEnabled } = this.app;
    const tool = self.tool;
    if (!this.toolLocks[tool]) return;

    // Only allow toggling if the property is defined for this tool
    if (!(property in this.toolLocks[tool])) {
      console.warn(`Property ${property} is not lockable for tool ${tool}`);
      return;
    }

    const lock = this.toolLocks[tool][property];

    // Toggle lock state
    lock.locked = !lock.locked;

    // If locking, save current value
    if (lock.locked) {
      if (property === 'pressure') {
        lock.min = Number(ui.elements.pressureMinSlider.value);
        lock.max = Number(ui.elements.pressureMaxSlider.value);
        lock.enabled = pressureEnabled;
      } else if (property === 'opacity') {
        lock.value = self.opacity;
      } else {
        lock.value = self[property];
      }
    }

    // Update UI
    ui.updateLockButton(property, lock.locked, true);

    // Save to localStorage
    this.saveToolLocks();

    console.log(`${property} ${lock.locked ? 'locked' : 'unlocked'} for ${tool} tool`);
  }
}
