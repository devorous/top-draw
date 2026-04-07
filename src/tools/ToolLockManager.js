/**
 * @fileoverview ToolLockManager - Manages per-tool locked property values
 */

/**
 * Manages tool properties (size, smoothing, opacity, etc.) and allows locking
 * values for specific tools or sharing unlocked values globally.
 */
export class ToolLockManager {
  /**
   * @param {Object} app - The main application instance
   */
  constructor(app) {
    this.app = app;
    this.toolLocks = this.loadToolLocks();
    this.globalUnlockedValues = this.loadGlobalUnlockedValues();
  }

  /**
   * Load global unlocked property values from localStorage
   * @returns {Object} Unlocked values mapping
   */
  loadGlobalUnlockedValues() {
    const defaults = {
      size: 10,
      smoothing: 15,
      hardness: 100,
      opacity: 1.0,
      spacing: 0,
      blurRadius: 5,
      thinning: 0.5,
      pressure: { min: 0, max: 100, enabled: true }
    };

    try {
      const saved = localStorage.getItem('topDrawGlobalUnlockedValues');
      if (saved) {
        const parsed = JSON.parse(saved);

        if (parsed.opacity !== undefined && parsed.opacity > 1) {
          parsed.opacity = parsed.opacity / 100;
        }

        return { ...defaults, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load global unlocked values:', e);
    }

    return defaults;
  }

  /**
   * Save global unlocked property values to localStorage
   */
  saveGlobalUnlockedValues() {
    try {
      localStorage.setItem('topDrawGlobalUnlockedValues', JSON.stringify(this.globalUnlockedValues));
    } catch (e) {
      console.warn('Failed to save global unlocked values:', e);
    }
  }

  /**
   * Load tool-specific lock configurations from localStorage
   * @returns {Object} Tool lock configurations
   */
  loadToolLocks() {
    const defaults = this.getDefaultToolLocks();

    try {
      const saved = localStorage.getItem('topDrawToolLocks');
      if (saved) {
        const parsed = JSON.parse(saved);
        const migrated = this.migrateToolLocks(parsed);

        for (const [tool, props] of Object.entries(migrated)) {
          if (defaults[tool]) {
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

  /**
   * Migrate old tool lock data formats to the current format
   * @param {Object} oldLocks - Old tool lock configuration
   * @returns {Object} Migrated configuration
   */
  migrateToolLocks(oldLocks) {
    const newLocks = {};

    for (const [tool, props] of Object.entries(oldLocks)) {
      newLocks[tool] = {};

      for (const [prop, state] of Object.entries(props)) {
        if (state.lockedValue !== undefined && state.unlockedValue === undefined) {
          if (prop === 'opacity' && state.lockedValue > 1) {
            state.lockedValue = state.lockedValue / 100;
          }
          newLocks[tool][prop] = state;
          continue;
        }

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

          if (prop === 'opacity' && value > 1) {
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

  /**
   * Get default tool lock configurations for all tools
   * @returns {Object}
   */
  getDefaultToolLocks() {
    const tools = {
      brush: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      flowPen: ['size', 'pressure', 'smoothing', 'hardness', 'opacity'],
      ink: ['size', 'pressure', 'smoothing', 'hardness', 'opacity', 'thinning'],
      pixel: ['size', 'pressure', 'smoothing', 'spacing', 'opacity'],
      line: ['size', 'hardness', 'opacity'],
      rectangle: ['size', 'hardness', 'opacity'],
      circle: ['size', 'hardness', 'opacity'],
      erase: ['size', 'pressure', 'hardness', 'opacity'],
      blur: ['size', 'pressure', 'spacing', 'blurRadius', 'opacity'],
      circleBlur: ['size', 'pressure', 'smoothing', 'hardness', 'spacing', 'opacity'],
      glitchBlur: ['size', 'pressure', 'spacing', 'blurRadius', 'opacity'],
      imageBrush: ['size', 'pressure', 'spacing', 'opacity'],
      pattern: ['size', 'pressure', 'opacity'],
      fill: ['opacity'],
      text: ['size', 'opacity'],
      select: [],
      inkdropper: [],
      pan: [],
      rotate: []
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
          let defaultValue = 0;
          if (prop === 'size') defaultValue = 10;
          if (prop === 'smoothing') defaultValue = 15;
          if (prop === 'hardness') defaultValue = 100;
          if (prop === 'opacity') defaultValue = 1.0;
          if (prop === 'blurRadius') defaultValue = 5;
          if (prop === 'spacing') defaultValue = 0;
          if (prop === 'thinning') defaultValue = 0.5;

          locks[tool][prop] = {
            locked: false,
            lockedValue: defaultValue
          };
        }
      });
    }

    return locks;
  }

  /**
   * Save tool-specific lock configurations to localStorage
   */
  saveToolLocks() {
    try {
      localStorage.setItem('topDrawToolLocks', JSON.stringify(this.toolLocks));
    } catch (e) {
      console.warn('Failed to save tool locks:', e);
    }
  }

  /**
   * Save current property values for a tool
   * @param {string} toolName - Name of the tool
   */
  saveCurrentValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, pressureEnabled } = this.app;

    for (const [prop, state] of Object.entries(locks)) {
      if (state.locked) {
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
        else if (prop === 'thinning') state.lockedValue = self.thinning;
      } else {
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
        else if (prop === 'thinning') this.globalUnlockedValues.thinning = self.thinning;
      }
    }

    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }

  /**
   * Restore property values for a tool from its locks or global values
   * @param {string} toolName - Name of the tool
   */
  restoreToolValues(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { self, ui, wsClient, connected, colorPicker } = this.app;
    const { elements } = ui;

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
        ui.updateSmoothingValue(value);
        if (elements.smoothingSlider) elements.smoothingSlider.value = value;
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
        if (elements.hardnessSlider) elements.hardnessSlider.value = value;
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
      else if (prop === 'thinning') {
        self.setThinning(value);
        ui.updateThinningValue(Math.round(value * 100));
        if (elements.thinningSlider) elements.thinningSlider.value = Math.round(value * 100);
        // Thinning is not yet broadcasted in UserHandlers/DrawingHandlers for some tools? 
        // But we update self.
      }
    }
  }

  /**
   * Update visibility of lock buttons for a tool
   * @param {string} toolName - Name of the tool
   */
  updateAllLockButtons(toolName) {
    const locks = this.toolLocks[toolName];
    if (!locks) return;

    const { ui } = this.app;
    const allProps = ['size', 'pressure', 'smoothing', 'spacing', 'hardness', 'opacity', 'blurRadius', 'thinning'];
    
    allProps.forEach(prop => {
      const lock = locks[prop];
      if (lock) {
        ui.updateLockButton(prop, lock.locked, true);
      } else {
        ui.updateLockButton(prop, false, false);
      }
    });
  }

  /**
   * Toggle the lock state for a property on the active tool
   * @param {string} property - Property name to toggle
   */
  toggleLock(property) {
    const { self, ui, pressureEnabled } = this.app;
    const tool = self.tool;

    if (!this.toolLocks[tool]) {
      console.warn(`No tool locks for tool: ${tool}`);
      return;
    }

    if (!(property in this.toolLocks[tool])) {
      console.warn(`Property ${property} is not lockable for tool ${tool}`);
      return;
    }

    const lock = this.toolLocks[tool][property];

    lock.locked = !lock.locked;

    if (lock.locked) {
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

    ui.updateLockButton(property, lock.locked, true);
    this.saveToolLocks();
    this.saveGlobalUnlockedValues();
  }
}
