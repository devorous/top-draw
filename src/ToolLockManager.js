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
    const tools = ['brush', 'flowPen', 'ink', 'line', 'rectangle', 'circle', 'imageBrush', 'erase', 'text', 'select', 'blur', 'inkdropper'];
    const locks = {};

    tools.forEach(tool => {
      locks[tool] = {
        size: { locked: false, value: 10 },
        pressure: { locked: false, min: 0, max: 100, enabled: true },
        smoothing: { locked: false, value: 0.3 },
        spacing: { locked: false, value: 0 },
        hardness: { locked: false, value: 1.0 },
        imageBrushOpacity: { locked: false, value: 1.0 },
        blurRadius: { locked: false, value: 5 }
      };
    });

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

    // Save current values for locked properties
    if (locks.size?.locked) locks.size.value = self.size;
    if (locks.pressure?.locked) {
      locks.pressure.min = Number(ui.elements.pressureMinSlider.value);
      locks.pressure.max = Number(ui.elements.pressureMaxSlider.value);
      locks.pressure.enabled = pressureEnabled;
    }
    if (locks.smoothing?.locked) locks.smoothing.value = self.smoothing;
    if (locks.spacing?.locked) locks.spacing.value = self.spacing;
    if (locks.hardness?.locked) locks.hardness.value = self.hardness;
    if (locks.imageBrushOpacity?.locked) {
      // imageBrushOpacity is derived from color alpha
      locks.imageBrushOpacity.value = self.opacity;
    }
    if (locks.blurRadius?.locked) locks.blurRadius.value = self.blurRadius;

    this.saveToolLocks();
  }

  restoreLockedValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, wsClient, connected, pressureEnabled, colorPicker } = this.app;
    const { elements } = ui;

    // Restore locked values
    if (locks.size?.locked) {
      self.setSize(locks.size.value);
      ui.updateSizeValue(locks.size.value);
      ui.updateCursorSize(locks.size.value);
      if (elements.sizeSlider) elements.sizeSlider.value = locks.size.value;
      if (connected) {
        wsClient.broadcastSizeChange(locks.size.value);
      }
    }
    if (locks.pressure?.locked) {
      // Backward compat: if old lock has .value instead of .min/.max
      let pMin, pMax, pEnabled;
      if (locks.pressure.value !== undefined && locks.pressure.min === undefined) {
        pMin = 0;
        pMax = Math.round(locks.pressure.value * 100);
        pEnabled = true;
      } else {
        pMin = locks.pressure.min ?? 0;
        pMax = locks.pressure.max ?? 100;
        pEnabled = locks.pressure.enabled ?? true;
      }
      if (elements.pressureMinSlider) elements.pressureMinSlider.value = pMin;
      if (elements.pressureMaxSlider) elements.pressureMaxSlider.value = pMax;
      ui.updatePressureValue(pMin, pMax);
      this.app.pressureEnabled = pEnabled;
      if (elements.pressureEnabled) elements.pressureEnabled.checked = pEnabled;
      if (elements.pressureDualSlider) elements.pressureDualSlider.style.display = pEnabled ? '' : 'none';
    }
    if (locks.smoothing?.locked) {
      self.setSmoothing(locks.smoothing.value);
      ui.updateSmoothingValue(locks.smoothing.value * 100);
      if (elements.smoothingSlider) elements.smoothingSlider.value = locks.smoothing.value * 100;
      if (connected) {
        wsClient.broadcastSmoothingChange(locks.smoothing.value);
      }
    }
    if (locks.spacing?.locked) {
      self.setSpacing(locks.spacing.value);
      ui.updateSpacingValue(locks.spacing.value);
      if (elements.spacingSlider) elements.spacingSlider.value = locks.spacing.value;
      if (connected) {
        wsClient.broadcastSpacingChange(locks.spacing.value);
      }
    }
    if (locks.hardness?.locked) {
      self.setHardness(locks.hardness.value);
      ui.updateHardnessValue(locks.hardness.value * 100);
      if (elements.hardnessSlider) elements.hardnessSlider.value = locks.hardness.value * 100;
      if (connected) {
        wsClient.broadcastHardnessChange(locks.hardness.value);
      }
    }
    if (locks.imageBrushOpacity?.locked) {
      // Update color alpha (opacity)
      const currentColor = [...self.color];
      currentColor[3] = locks.imageBrushOpacity.value;
      self.setColor(currentColor);
      self.setOpacity(locks.imageBrushOpacity.value);
      ui.updateImageBrushOpacityValue(locks.imageBrushOpacity.value);
      if (elements.imageBrushOpacitySlider) elements.imageBrushOpacitySlider.value = locks.imageBrushOpacity.value * 100;

      // Update color picker to reflect the locked opacity
      if (colorPicker) {
        colorPicker.setColor(`rgba(${currentColor.join(',')})`, true);
      }

      if (connected) {
        wsClient.broadcastColorChange(currentColor);
      }
    }
    if (locks.blurRadius?.locked) {
      self.setBlurRadius(locks.blurRadius.value);
      ui.updateBlurRadiusValue(locks.blurRadius.value);
      if (elements.blurRadiusSlider) elements.blurRadiusSlider.value = locks.blurRadius.value;
      if (connected) {
        wsClient.broadcastBlurRadiusChange(locks.blurRadius.value);
      }
    }
  }

  updateAllLockButtons(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { ui } = this.app;
    ui.updateLockButton('size', locks.size?.locked || false);
    ui.updateLockButton('pressure', locks.pressure?.locked || false);
    ui.updateLockButton('smoothing', locks.smoothing?.locked || false);
    ui.updateLockButton('spacing', locks.spacing?.locked || false);
    ui.updateLockButton('hardness', locks.hardness?.locked || false);
    ui.updateLockButton('imageBrushOpacity', locks.imageBrushOpacity?.locked || false);
    ui.updateLockButton('blurRadius', locks.blurRadius?.locked || false);
  }

  toggleLock(property) {
    const { self, ui, pressureEnabled } = this.app;
    const tool = self.tool;
    if (!this.toolLocks[tool]) return;

    const lock = this.toolLocks[tool][property];
    if (!lock) {
      // Initialize lock if it doesn't exist
      this.toolLocks[tool][property] = { locked: false, value: self[property] || 0 };
      return;
    }

    // Toggle lock state
    lock.locked = !lock.locked;

    // If locking, save current value
    if (lock.locked) {
      if (property === 'pressure') {
        lock.min = Number(ui.elements.pressureMinSlider.value);
        lock.max = Number(ui.elements.pressureMaxSlider.value);
        lock.enabled = pressureEnabled;
      } else if (property === 'imageBrushOpacity') {
        lock.value = self.opacity;
      } else {
        lock.value = self[property];
      }
    }

    // Update UI
    ui.updateLockButton(property, lock.locked);

    // Save to localStorage
    this.saveToolLocks();

    console.log(`${property} ${lock.locked ? 'locked' : 'unlocked'} for ${tool} tool at value ${lock.value}`);
  }
}
