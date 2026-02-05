# Lock Feature Implementation Plan

## Overview
Add lock buttons (🔒) to all sliders that allow users to "lock" specific values per-tool. When a value is locked for a tool, it persists when switching away and back to that tool.

## User Requirements
Based on user feedback:
- ✅ **Per-tool locks**: Each tool remembers its own locked values independently
- ✅ **All sliders**: Add locks to every slider (Size, Pressure, Smoothing, Spacing, Hardness, Image Brush Opacity)
- ✅ **localStorage**: Persist lock states across browser sessions
- ✅ **Local only**: Lock states are NOT synced between users (personal preference)

## How It Works

### Example Usage
1. User selects **Brush** tool
2. Sets size to 20 and clicks lock icon 🔒 next to size slider
3. Switches to **Pen** tool → size changes to pen's unlocked value (e.g., 10)
4. Switches back to **Brush** → size returns to 20 (locked value)
5. If user tries to change size while locked, it stays at 20 (or lock automatically unlocks)

### Lock Behavior Options
**Option A - Lock prevents changes:**
- Slider is disabled/grayed out when locked
- Cannot change value while locked
- Must unlock first to adjust

**Option B - Lock auto-unlocks on change:**
- Can still adjust slider
- Adjusting automatically unlocks it
- Lock just means "remember this value for this tool"

**Recommendation: Option B** (more flexible, less frustrating)

## Data Structure

### Storage Format (localStorage)
```json
{
  "toolLocks": {
    "brush": {
      "size": { "locked": true, "value": 20 },
      "pressure": { "locked": false, "value": 1.0 },
      "smoothing": { "locked": true, "value": 0.5 },
      "spacing": { "locked": false, "value": 0 },
      "hardness": { "locked": false, "value": 1.0 }
    },
    "flowPen": {
      "size": { "locked": false, "value": 15 },
      "pressure": { "locked": true, "value": 0.8 },
      "smoothing": { "locked": false, "value": 0.3 },
      "spacing": { "locked": false, "value": 0 },
      "hardness": { "locked": true, "value": 0.7 }
    },
    "line": { /* ... */ },
    "rectangle": { /* ... */ },
    "circle": { /* ... */ },
    "imageBrush": {
      "size": { "locked": false, "value": 30 },
      "pressure": { "locked": false, "value": 1.0 },
      "smoothing": { "locked": false, "value": 0 },
      "spacing": { "locked": true, "value": 5 },
      "hardness": { "locked": false, "value": 1.0 }
    },
    "erase": { /* ... */ },
    "text": { /* ... */ },
    "select": { /* ... */ }
  }
}
```

### In-Memory State
Add to `App.js`:
```javascript
this.toolLocks = {
  /* structure same as above */
};
```

## Implementation Steps

### 1. HTML Changes (`index.html`)
Add lock button next to each slider:

```html
<div class="sliderContainer">
  <label>
    Size <span class="sliderValue" id="sizeValue">10</span>
    <button class="lock-btn" id="sizeLock" title="Lock size for current tool">🔓</button>
  </label>
  <input type="range" min="1" max="100" value="10" class="slider size">
</div>
```

**Sliders that need lock buttons:**
- Size (`#sizeLock`)
- Pressure (`#pressureLock`)
- Smoothing (`#smoothingLock`)
- Spacing (`#spacingLock`) - only visible for imageBrush
- Hardness (`#hardnessLock`) - only visible for brush/flowPen/line/rectangle/circle
- Image Brush Opacity (`#imageBrushOpacityLock`) - only visible for imageBrush

### 2. CSS Styling
```css
.lock-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  margin-left: 4px;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.lock-btn:hover {
  opacity: 1;
}

.lock-btn.locked {
  opacity: 1;
}
```

### 3. UI.js Changes
Cache lock button elements:
```javascript
this.elements = {
  // ... existing elements ...
  sizeLock: document.getElementById('sizeLock'),
  pressureLock: document.getElementById('pressureLock'),
  smoothingLock: document.getElementById('smoothingLock'),
  spacingLock: document.getElementById('spacingLock'),
  hardnessLock: document.getElementById('hardnessLock'),
  imageBrushOpacityLock: document.getElementById('imageBrushOpacityLock'),
};
```

Add methods:
```javascript
updateLockButton(property, locked) {
  const btn = this.elements[`${property}Lock`];
  if (!btn) return;

  btn.textContent = locked ? '🔒' : '🔓';
  btn.classList.toggle('locked', locked);
}
```

### 4. App.js Changes

#### A. Initialize toolLocks
```javascript
constructor() {
  // ... existing code ...
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
  const tools = ['brush', 'flowPen', 'line', 'rectangle', 'circle', 'imageBrush', 'erase', 'text', 'select'];
  const locks = {};

  tools.forEach(tool => {
    locks[tool] = {
      size: { locked: false, value: 10 },
      pressure: { locked: false, value: 1.0 },
      smoothing: { locked: false, value: 0.3 },
      spacing: { locked: false, value: 0 },
      hardness: { locked: false, value: 1.0 }
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
```

#### B. Tool Switching Logic
Modify `selectTool()`:
```javascript
selectTool(toolName) {
  const previousTool = this.self.tool;

  // Save current values for previous tool if locked
  if (previousTool && this.toolLocks[previousTool]) {
    this.saveLockedValues(previousTool);
  }

  // Switch tool
  this.self.setTool(toolName);
  this.toolManager.setTool(toolName);
  this.ui.updateToolDisplay(toolName);

  // Restore locked values for new tool
  if (this.toolLocks[toolName]) {
    this.restoreLockedValues(toolName);
  }

  // Update lock button states
  this.updateAllLockButtons(toolName);

  // ... existing broadcast code ...
}

saveLockedValues(toolName) {
  const locks = this.toolLocks[toolName];
  if (!locks) return;

  // Save current values for locked properties
  if (locks.size?.locked) locks.size.value = this.self.size;
  if (locks.pressure?.locked) locks.pressure.value = this.self.pressure;
  if (locks.smoothing?.locked) locks.smoothing.value = this.self.smoothing;
  if (locks.spacing?.locked) locks.spacing.value = this.self.spacing;
  if (locks.hardness?.locked) locks.hardness.value = this.self.hardness;

  this.saveToolLocks();
}

restoreLockedValues(toolName) {
  const locks = this.toolLocks[toolName];
  if (!locks) return;

  // Restore locked values
  if (locks.size?.locked) {
    this.self.setSize(locks.size.value);
    this.ui.updateSizeValue(locks.size.value);
  }
  if (locks.pressure?.locked) {
    this.self.setPressure(locks.pressure.value);
    this.ui.updatePressureValue(locks.pressure.value);
  }
  if (locks.smoothing?.locked) {
    this.self.setSmoothing(locks.smoothing.value);
    this.ui.updateSmoothingValue(locks.smoothing.value * 100);
  }
  if (locks.spacing?.locked) {
    this.self.setSpacing(locks.spacing.value);
    this.ui.updateSpacingValue(locks.spacing.value);
  }
  if (locks.hardness?.locked) {
    this.self.setHardness(locks.hardness.value);
    this.ui.updateHardnessValue(locks.hardness.value);
  }
}

updateAllLockButtons(toolName) {
  const locks = this.toolLocks[toolName];
  if (!locks) return;

  this.ui.updateLockButton('size', locks.size?.locked || false);
  this.ui.updateLockButton('pressure', locks.pressure?.locked || false);
  this.ui.updateLockButton('smoothing', locks.smoothing?.locked || false);
  this.ui.updateLockButton('spacing', locks.spacing?.locked || false);
  this.ui.updateLockButton('hardness', locks.hardness?.locked || false);
  this.ui.updateLockButton('imageBrushOpacity', locks.imageBrushOpacity?.locked || false);
}
```

#### C. Lock Button Handlers
Add event listeners in `setupEventListeners()`:
```javascript
elements.sizeLock.addEventListener('click', () => this.toggleLock('size'));
elements.pressureLock.addEventListener('click', () => this.toggleLock('pressure'));
elements.smoothingLock.addEventListener('click', () => this.toggleLock('smoothing'));
elements.spacingLock.addEventListener('click', () => this.toggleLock('spacing'));
elements.hardnessLock.addEventListener('click', () => this.toggleLock('hardness'));
elements.imageBrushOpacityLock.addEventListener('click', () => this.toggleLock('imageBrushOpacity'));
```

Add toggle method:
```javascript
toggleLock(property) {
  const tool = this.self.tool;
  if (!this.toolLocks[tool]) return;

  const lock = this.toolLocks[tool][property];
  if (!lock) return;

  // Toggle lock state
  lock.locked = !lock.locked;

  // If locking, save current value
  if (lock.locked) {
    lock.value = this.self[property];
  }

  // Update UI
  this.ui.updateLockButton(property, lock.locked);

  // Save to localStorage
  this.saveToolLocks();

  // Show toast
  const state = lock.locked ? 'Locked' : 'Unlocked';
  this.ui.showToast(`${property} ${state} for ${tool} tool`);
}
```

### 5. Testing Checklist
- [ ] Lock icons appear next to all sliders
- [ ] Clicking lock toggles between 🔒 and 🔓
- [ ] Locked values persist when switching tools and back
- [ ] Unlocked values change normally when switching tools
- [ ] Lock states persist after page refresh (localStorage)
- [ ] Lock states are per-tool (brush locks don't affect pen)
- [ ] Spacing/hardness locks only work for relevant tools
- [ ] Toast notifications appear when locking/unlocking

## Edge Cases to Handle
1. **Tool doesn't have a property**: E.g., text tool doesn't use hardness → skip it
2. **First time using app**: Use default unlocked state
3. **localStorage quota exceeded**: Gracefully handle, maybe show warning
4. **Corrupted localStorage data**: Fallback to defaults
5. **Slider visibility**: Only show lock buttons for visible sliders

## Future Enhancements (Optional)
- [ ] Import/Export lock configurations as JSON file
- [ ] Reset all locks button
- [ ] Visual indicator on slider when locked (disabled appearance?)
- [ ] Keyboard shortcuts for locking (e.g., Alt+Click on slider)
- [ ] Lock presets (save/load named configurations)

## Files to Modify
1. `index.html` - Add lock buttons
2. `styles.css` - Add lock button styling
3. `src/ui/UI.js` - Cache elements, add updateLockButton method
4. `src/App.js` - Main logic for locks, localStorage, tool switching
5. (Optional) `README.md` - Document the lock feature

## Estimated Complexity
- **Small**: ~2-3 hours
- **Medium complexity**: Per-tool state management, localStorage integration
- **Low risk**: Feature is purely additive, doesn't modify existing behavior
