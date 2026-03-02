/**
 * ToolLockManager - Manages per-tool locked property values
 * Allows users to lock tool properties (size, pressure, smoothing, etc.) so they persist when switching tools
 */

export class ToolLockManager {
  constructor(app) {
    this.app = app;
    this.toolLocks = this.loadToolLocks();
    this.globalUnlockedValues = this.loadGlobalUnlockedValues();
  }

  loadGlobalUnlockedValues() {
    const defaults = {
      size: 10,
      smoothing: 0.3,
      hardness: 1.0,
      opacity: 1.0,
      spacing: 0,
      blurRadius: 5,
      pressure: { min: 0, max: 100, enabled: true }
    };

    try {
      const saved = localStorage.getItem('topDrawGlobalUnlockedValues');
      if (saved) {
        const parsed = JSON.parse(saved);

        // Migrate percentage values to decimal (0-1) if needed
        if (parsed.hardness !== undefined && parsed.hardness > 1) {
          parsed.hardness = parsed.hardness / 100;
        }
        if (parsed.smoothing !== undefined && parsed.smoothing > 1) {
          parsed.smoothing = parsed.smoothing / 100;
        }
        if (parsed.opacity !== undefined && parsed.opacity > 1) {
          parsed.opacity = parsed.opacity / 100;
        }

        // Merge with defaults to ensure all properties exist
        return { ...defaults, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load global unlocked values:', e);
    }

    return defaults;
  }

  saveGlobalUnlockedValues() {
    try {
      localStorage.setItem('topDrawGlobalUnlockedValues', JSON.stringify(this.globalUnlockedValues));
    } catch (e) {
      console.warn('Failed to save global unlocked values:', e);
    }
  }

  loadToolLocks() {
    // Always start with defaults to ensure all tools are present
    const defaults = this.getDefaultToolLocks();

    try {
      const saved = localStorage.getItem('topDrawToolLocks');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Migrate old format to new format (with lockedValue/unlockedValue)
        const migrated = this.migrateToolLocks(parsed);

        // Merge migrated data into defaults (preserves any new tools added to codebase)
        for (const [tool, props] of Object.entries(migrated)) {
          if (defaults[tool]) {
            // Merge properties from migrated data
            for (const [prop, state] of Object.entries(props)) {
              if (defaults[tool][prop]) {
                defaults[tool][prop] = state;
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load tool locks:', e);
    }

    return defaults;
  }

  migrateToolLocks(oldLocks) {
    const newLocks = {};

    for (const [tool, props] of Object.entries(oldLocks)) {
      newLocks[tool] = {};

      for (const [prop, state] of Object.entries(props)) {
        // Check if already migrated (new format only has lockedValue, not unlockedValue)
        if (state.lockedValue !== undefined && state.unlockedValue === undefined) {
          // Ensure percentage values are converted to decimal
          if ((prop === 'hardness' || prop === 'smoothing' || prop === 'opacity') &&
              state.lockedValue > 1) {
            state.lockedValue = state.lockedValue / 100;
          }
          newLocks[tool][prop] = state;
          continue;
        }

        // Migrate old format
        if (prop === 'pressure') {
          newLocks[tool][prop] = {
            locked: state.locked ?? false,
            lockedValue: {
              min: state.min ?? 0,
              max: state.max ?? 100,
              enabled: state.enabled ?? true
            }
          };
        } else {
          let value = state.value ?? 0;

          // Convert percentage to decimal for hardness, smoothing, opacity
          if ((prop === 'hardness' || prop === 'smoothing' || prop === 'opacity') && value > 1) {
            value = value / 100;
          }

          newLocks[tool][prop] = {
            locked: state.locked ?? false,
            lockedValue: value
          };
        }
      }
    }

    return newLocks;
  }

  getDefaultToolLocks() {
    const tools = {
      brush: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      flowPen: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      ink: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      line: ['size', 'pressure', 'hardness', 'opacity'],
      rectangle: ['size', 'pressure', 'hardness', 'opacity'],
      circle: ['size', 'pressure', 'hardness', 'opacity'],
      erase: ['size', 'pressure'],
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
          locks[tool][prop] = {
            locked: false,
            lockedValue: { min: 0, max: 100, enabled: true }
          };
        } else {
          // Default values based on property type
          let defaultValue = 0;
          if (prop === 'size') defaultValue = 10;
          if (prop === 'smoothing') defaultValue = 0.3;
          if (prop === 'hardness') defaultValue = 1.0;
          if (prop === 'opacity') defaultValue = 1.0;
          if (prop === 'blurRadius') defaultValue = 5;
          if (prop === 'spacing') defaultValue = 0;

          locks[tool][prop] = {
            locked: false,
            lockedValue: defaultValue
          };
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

  saveCurrentValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, pressureEnabled } = this.app;

    // Save current values to either tool's lockedValue or global unlocked value
    for (const [prop, state] of Object.entries(locks)) {
      if (state.locked) {
        // Save to tool's locked value
        if (prop === 'size') {
          state.lockedValue = self.size;
        }
        else if (prop === 'pressure') {
          state.lockedValue = {
            min: Number(ui.elements.pressureMinSlider.value),
            max: Number(ui.elements.pressureMaxSlider.value),
            enabled: pressureEnabled
          };
        }
        else if (prop === 'smoothing') state.lockedValue = self.smoothing;
        else if (prop === 'spacing') state.lockedValue = self.spacing;
        else if (prop === 'hardness') state.lockedValue = self.hardness;
        else if (prop === 'opacity') state.lockedValue = self.opacity;
        else if (prop === 'blurRadius') state.lockedValue = self.blurRadius;
      } else {
        // Save to global unlocked value
        if (prop === 'size') {
          this.globalUnlockedValues.size = self.size;
        }
        else if (prop === 'pressure') {
          this.globalUnlockedValues.pressure = {
            min: Number(ui.elements.pressureMinSlider.value),
            max: Number(ui.elements.pressureMaxSlider.value),
            enabled: pressureEnabled
          };
        }
        else if (prop === 'smoothing') this.globalUnlockedValues.smoothing = self.smoothing;
        else if (prop === 'spacing') this.globalUnlockedValues.spacing = self.spacing;
        else if (prop === 'hardness') this.globalUnlockedValues.hardness = self.hardness;
        else if (prop === 'opacity') this.globalUnlockedValues.opacity = self.opacity;
        else if (prop === 'blurRadius') this.globalUnlockedValues.blurRadius = self.blurRadius;
      }
    }

    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }

  restoreToolValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, wsClient, connected, colorPicker } = this.app;
    const { elements } = ui;

    // Restore values from either tool's lockedValue or global unlocked value
    for (const [prop, state] of Object.entries(locks)) {
      const value = state.locked ? state.lockedValue : this.globalUnlockedValues[prop];

      if (prop === 'size') {
        self.setSize(value);
        ui.updateSizeValue(value);
        ui.updateCursorSize(value);
        if (elements.sizeSlider) elements.sizeSlider.value = value;
        if (connected) {
          wsClient.broadcastSizeChange(value);
        }
      }
      else if (prop === 'pressure') {
        const pMin = value.min ?? 0;
        const pMax = value.max ?? 100;
        const pEnabled = value.enabled ?? true;

        if (elements.pressureMinSlider) elements.pressureMinSlider.value = pMin;
        if (elements.pressureMaxSlider) elements.pressureMaxSlider.value = pMax;
        ui.updatePressureValue(pMin, pMax);
        this.app.pressureEnabled = pEnabled;
        if (elements.pressureEnabled) elements.pressureEnabled.checked = pEnabled;
        if (elements.pressureDualSlider) elements.pressureDualSlider.style.display = pEnabled ? '' : 'none';
      }
      else if (prop === 'smoothing') {
        self.setSmoothing(value);
        ui.updateSmoothingValue(value * 100);
        if (elements.smoothingSlider) elements.smoothingSlider.value = value * 100;
        if (connected) {
          wsClient.broadcastSmoothingChange(value);
        }
      }
      else if (prop === 'spacing') {
        self.setSpacing(value);
        ui.updateSpacingValue(value);
        if (elements.spacingSlider) elements.spacingSlider.value = value;
        if (connected) {
          wsClient.broadcastSpacingChange(value);
        }
      }
      else if (prop === 'hardness') {
        self.setHardness(value);
        ui.updateHardnessValue(value);
        if (elements.hardnessSlider) elements.hardnessSlider.value = value * 100;
        if (connected) {
          wsClient.broadcastHardnessChange(value);
        }
      }
      else if (prop === 'opacity') {
        const currentColor = [...self.color];
        currentColor[3] = value;
        self.setColor(currentColor);
        self.setOpacity(value);
        ui.updateopacityValue(value);
        if (elements.opacitySlider) elements.opacitySlider.value = value * 100;
        if (colorPicker) {
          colorPicker.setColor(`rgba(${currentColor.join(',')})`, true);
        }
        if (connected) {
          wsClient.broadcastColorChange(currentColor);
        }
      }
      else if (prop === 'blurRadius') {
        self.setBlurRadius(value);
        ui.updateBlurRadiusValue(value);
        if (elements.blurRadiusSlider) elements.blurRadiusSlider.value = value;
        if (connected) {
          wsClient.broadcastBlurRadiusChange(value);
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

    if (!this.toolLocks[tool]) {
      console.warn(`No tool locks for tool: ${tool}`);
      return;
    }

    // Only allow toggling if the property is defined for this tool
    if (!(property in this.toolLocks[tool])) {
      console.warn(`Property ${property} is not lockable for tool ${tool}`);
      return;
    }

    const lock = this.toolLocks[tool][property];

    // Toggle lock state
    lock.locked = !lock.locked;

    // Save current value to appropriate location
    if (lock.locked) {
      // Locking: save current value as this tool's locked value
      if (property === 'pressure') {
        lock.lockedValue = {
          min: Number(ui.elements.pressureMinSlider.value),
          max: Number(ui.elements.pressureMaxSlider.value),
          enabled: pressureEnabled
        };
      } else if (property === 'opacity') {
        lock.lockedValue = self.opacity;
      } else {
        lock.lockedValue = self[property];
      }
    } else {
      // Unlocking: save current value as global unlocked value
      if (property === 'pressure') {
        this.globalUnlockedValues.pressure = {
          min: Number(ui.elements.pressureMinSlider.value),
          max: Number(ui.elements.pressureMaxSlider.value),
          enabled: pressureEnabled
        };
      } else if (property === 'opacity') {
        this.globalUnlockedValues.opacity = self.opacity;
      } else {
        this.globalUnlockedValues[property] = self[property];
      }
    }

    // Update UI
    ui.updateLockButton(property, lock.locked, true);

    // Save to localStorage
    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }
}
