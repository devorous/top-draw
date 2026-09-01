/**
 * KeyboardHandler - Manages keyboard shortcuts and key events
 * Handles tool switching, selection operations, panning, and text input
 */

import { appState } from '../state.svelte.js';
import { getEffectiveKeybinding, getEffectiveKeybindings } from '../config/AppPreferences.js';
import { eventToBinding } from './keybinds/KeybindMatcher.js';
import { KEYBIND_ACTIONS } from './keybinds/KeybindRegistry.js';

const BLOCKED_BROWSER_BINDINGS = new Set([
  'Alt+ArrowLeft',
  'Alt+ArrowRight',
  'Mod+0',
  'Mod+1',
  'Mod+2',
  'Mod+3',
  'Mod+4',
  'Mod+5',
  'Mod+6',
  'Mod+7',
  'Mod+8',
  'Mod+9',
  'Mod+Comma',
  'Mod+D',
  'Mod+Equal',
  'Mod+L',
  'Mod+Minus',
  'Mod+N',
  'Mod+O',
  'Mod+P',
  'Mod+S',
  'Mod+T',
  'Mod+Shift+N',
  'Mod+Shift+T',
  'Mod+Shift+W',
  'Mod+Space'
]);

export class KeyboardHandler {
  constructor(app) {
    this.app = app;
    this._pendingInternalPaste = null;
    this._holdActionIntervals = new Map();
    this._temporaryEyedropperActive = false;
  }

  /**
   * Initialize keyboard event listeners
   */
  init() {
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keyup', (e) => this.handleKeyUp(e));
    document.addEventListener('paste', (e) => this.handlePaste(e));
    window.addEventListener('blur', () => {
      this.clearAllHoldActions();
      this.restoreTemporaryEyedropper();
    });
  }

  handlePaste(e) {
    const { app } = this;

    // Skip if user is typing in a form field
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        // A system-clipboard image wins over the internal clipboard — cancel any
        // pending internal paste queued by the Ctrl+V keydown so we don't double-paste.
        if (this._pendingInternalPaste) {
          clearTimeout(this._pendingInternalPaste);
          this._pendingInternalPaste = null;
        }
        if (!app.canUseImageFeatures(true)) {
          e.preventDefault();
          break;
        }

        const blob = items[i].getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            const selectTool = app.toolManager.getTool('select');
            if (selectTool) {
              selectTool.pasteImage(img);
            }
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(blob);
        e.preventDefault();
        break;
      }
    }
  }

  getBindingForAction(actionId) {
    return getEffectiveKeybinding(this.app.appPreferences, actionId);
  }

  getBindingsForAction(actionId) {
    return getEffectiveKeybindings(this.app.appPreferences, actionId) ?? [];
  }

  getActionForBinding(binding) {
    for (const action of KEYBIND_ACTIONS) {
      const actionBindings = this.getBindingsForAction(action.id);
      if (actionBindings.includes(binding)) {
        return action.id;
      }
    }

    return null;
  }

  getActionForEvent(e) {
    const binding = eventToBinding(e);
    if (!binding) return null;
    return this.getActionForBinding(binding);
  }

  shouldSuppressBrowserShortcut(binding) {
    return !!binding && BLOCKED_BROWSER_BINDINGS.has(binding);
  }

  startHoldAction(actionId, e) {
    if (this._holdActionIntervals.has(actionId)) return true;

    const dispatched = this.dispatchAction(actionId, e);
    if (!dispatched) return false;

    const intervalId = setInterval(() => {
      const syntheticEvent = { ...e, repeat: true };
      this.dispatchAction(actionId, syntheticEvent);
    }, 40);
    this._holdActionIntervals.set(actionId, intervalId);
    return true;
  }

  stopHoldAction(actionId) {
    const intervalId = this._holdActionIntervals.get(actionId);
    if (intervalId) {
      clearInterval(intervalId);
      this._holdActionIntervals.delete(actionId);
      return true;
    }
    return false;
  }

  clearAllHoldActions() {
    for (const intervalId of this._holdActionIntervals.values()) {
      clearInterval(intervalId);
    }
    this._holdActionIntervals.clear();
  }

  restoreTemporaryEyedropper(e = null) {
    const { app } = this;
    if (!this._temporaryEyedropperActive) return false;

    this._temporaryEyedropperActive = false;
    if (app.self.tool === 'inkdropper' && app.previousTool) {
      e?.preventDefault?.();
      const previousTool = app.previousTool;
      app.previousTool = null;
      app.selectTool(previousTool);
      return true;
    }

    return false;
  }

  dispatchAction(actionId, e) {
    const { app } = this;
    const selectTool = app.toolManager.getTool('select');

    switch (actionId) {
      case 'app.openSettings':
        app.handleAppSettings();
        return true;

      case 'panel.performanceDebug':
        if (!app.performanceDebugPanel) return false;
        app.performanceDebugPanel.toggle();
        app.performanceDebugPanel.update();
        return true;

      case 'canvas.temporaryPan':
        if (app.self.tool === 'text' || app.self.panning || app.self.mousedown) return false;
        app.self.panning = true;
        app.wsClient.broadcastPan(true);
        app.wsClient.broadcastHideCursor();
        app.ui.showPanCursor();
        return true;

      case 'canvas.temporaryZoom':
        if (app.self.tool === 'text' || app.self.mousedown || app._temporaryZoomPreviousTool) return false;
        if (!e.repeat && app.self.tool !== 'zoom') {
          app._temporaryZoomPreviousTool = app.self.tool;
          app.selectTool('zoom');
        }
        return true;

      case 'canvas.zoomIn':
        app.handleZoomIn();
        return true;

      case 'canvas.zoomOut':
        app.handleZoomOut();
        return true;

      case 'tool.sizeUp':
        app.adjustToolSize(1);
        return true;

      case 'tool.sizeDown':
        app.adjustToolSize(-1);
        return true;

      case 'tool.temporaryEyedropper':
        if (app.self.tool === 'text') return false;
        if (!e.repeat && app.self.tool !== 'inkdropper') {
          this._temporaryEyedropperActive = true;
          app.selectTool('inkdropper');
        }
        return true;

      case 'tool.swapColors':
        app.swapColorSlots();
        return true;

      case 'history.undo':
        app.handleUndo();
        return true;

      case 'history.redo':
        app.handleRedo();
        return true;

      case 'history.cancelStroke':
        app.cancelCurrentStroke();
        return true;

      case 'selection.copy':
        if (selectTool && selectTool.hasSelection()) {
          selectTool.copy();
          return true;
        }
        return false;

      case 'selection.cut':
        if (selectTool && selectTool.hasSelection()) {
          selectTool.cut();
          return true;
        }
        return false;

      case 'selection.paste':
        if (selectTool && selectTool.hasClipboard()) {
          // Defer to a microtask so the browser's `paste` event (which fires
          // after keydown) can cancel this if the system clipboard has an image.
          if (this._pendingInternalPaste) clearTimeout(this._pendingInternalPaste);
          this._pendingInternalPaste = setTimeout(() => {
            this._pendingInternalPaste = null;
            app.selectTool('select');
            selectTool.paste();
          }, 0);
          return true;
        }
        return false;

      case 'selection.deselect':
        if (selectTool && selectTool.hasSelection()) {
          selectTool.deselect();
          return true;
        }
        return false;

      case 'selection.delete':
        if (app.self.tool === 'select' && selectTool && selectTool.hasSelection()) {
          selectTool.deleteSelection();
          return true;
        }
        return false;

      case 'tool.select':
        app.selectTool('select');
        return true;

      case 'tool.brush':
        app.selectTool(app.brushModeManager.getCurrentToolName());
        return true;

      case 'tool.line':
        app.selectTool('line');
        return true;

      case 'tool.rectangle':
        app.selectTool('rectangle');
        return true;

      case 'tool.circle':
        app.selectTool('circle');
        return true;

      case 'tool.text':
        app.selectTool('text');
        return true;

      case 'tool.fill':
        app.selectTool('fill');
        return true;

      case 'tool.erase':
        app.selectTool('erase');
        return true;

      case 'tool.blur':
        app.selectTool('blur');
        return true;

      case 'tool.circleBlur':
        app.selectTool('circleBlur');
        return true;

      case 'tool.imageBrush':
        app.selectTool('imageBrush');
        return true;

      case 'tool.eyedropper':
        app.selectTool('inkdropper');
        return true;

      case 'tool.pan':
        app.selectTool('pan');
        return true;

      case 'tool.zoom':
        app.selectTool('zoom');
        return true;

      case 'tool.rotate':
        app.selectTool('rotate');
        return true;

      case 'color.slot1':
      case 'color.slot2':
      case 'color.slot3':
      case 'color.slot4':
      case 'color.slot5':
      case 'color.slot6':
      case 'color.slot7':
      case 'color.slot8': {
        const idx = parseInt(actionId.replace('color.slot', ''), 10) - 1;
        const preset = appState.customColors[idx];
        if (preset) {
          app.applyCustomPreset(preset);
        }
        return !!preset;
      }

      default:
        return false;
    }
  }

  shouldIgnoreShortcutTarget(target) {
    if (!target) return false;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
  }

  handleBindingRelease(binding, e) {
    const { app } = this;

    const releaseActionId = binding ? this.getActionForBinding(binding) : null;
    if (releaseActionId) {
      this.stopHoldAction(releaseActionId);
    }

    if (binding && this.getBindingsForAction('canvas.temporaryPan').includes(binding)) {
      if (app.self.tool !== 'text' && app.self.tool !== 'pan' && app.self.tool !== 'rotate') {
        app.self.panning = false;
        app.wsClient.broadcastPan(false);
        app.wsClient.broadcastShowCursor();
        app.ui.hidePanCursor(app.self.tool, app.self);
      }
      return true;
    }

    if (binding && this.getBindingsForAction('canvas.temporaryZoom').includes(binding)) {
      if (app.self.tool === 'zoom' && app._temporaryZoomPreviousTool) {
        e.preventDefault?.();
        const previousTool = app._temporaryZoomPreviousTool;
        app._temporaryZoomPreviousTool = null;
        app.selectTool(previousTool);
      }
      return true;
    }

    if (binding && this.getBindingsForAction('tool.temporaryEyedropper').includes(binding)) {
      this.restoreTemporaryEyedropper(e);
      return true;
    }

    return false;
  }

  handlePointerDown(e) {
    const { app } = this;

    if (this.shouldIgnoreShortcutTarget(e.target)) {
      return false;
    }

    if (app.landingPage?.isVisible || appState.appSettingsVisible || appState.roomSettingsVisible || appState.adminPanelVisible) {
      return false;
    }

    if (e.pointerType === 'touch') {
      return false;
    }

    const binding = eventToBinding(e);
    if (!binding) return false;

    const actionId = this.getActionForBinding(binding);
    const action = actionId ? KEYBIND_ACTIONS.find((candidate) => candidate.id === actionId) : null;
    if (!actionId) return false;

    if (actionId !== 'app.openSettings' && actionId !== 'panel.performanceDebug' && !app.inputBufferManager.tickTimer) {
      return false;
    }

    e.preventDefault?.();
    e.stopPropagation?.();
    if (action?.isHoldAction) {
      return this.startHoldAction(actionId, e);
    }
    return this.dispatchAction(actionId, e);
  }

  handlePointerUp(e) {
    if (this.shouldIgnoreShortcutTarget(e.target) || e.pointerType === 'touch') {
      return false;
    }

    const binding = eventToBinding(e);
    if (!binding) return false;
    return this.handleBindingRelease(binding, e);
  }

  handleKeyDown(e) {
    const { app } = this;

    // Skip keyboard shortcuts/input if user is typing in a form field or the touch keyboard hidden input
    const target = e.target;
    if (this.shouldIgnoreShortcutTarget(target)) {
      return;
    }

    // Skip all drawing shortcuts if the landing page is visible
    if (app.landingPage?.isVisible) {
      return;
    }

    // Close context menu on Escape
    if (e.key === 'Escape' && app.ui.elements.userContextMenu?.style.display !== 'none') {
      app.moderation.hideContextMenu();
      return;
    }

    if (e.key === '/' || e.key === "'") {
      e.preventDefault();
    }

    const binding = eventToBinding(e);
    if (binding === 'Mod+R') {
      app.requestRefreshUnloadWarning?.();
      return;
    }

    if (this.shouldSuppressBrowserShortcut(binding)) {
      e.preventDefault();
    }

    if (appState.appSettingsVisible || appState.roomSettingsVisible || appState.adminPanelVisible) {
      return;
    }

    if (app.self.tool === 'text') {
      const binding = eventToBinding(e);
      const isCtrlOrModBinding = binding && (binding.startsWith('Ctrl+') || binding.startsWith('Mod+'));
      // Only let through Ctrl/Mod shortcuts that have actual keybinding actions (like undo/redo)
      const hasAction = isCtrlOrModBinding && !!this.getActionForBinding(binding);

      if (!hasAction) {
        const textTool = app.toolManager.getTool('text');
        const result = textTool.onKeyPress(app.self, e.key, e.ctrlKey || e.metaKey, e.shiftKey);

        // Build the key string with modifiers for broadcast
        let broadcastKey = e.key;
        if (e.ctrlKey || e.metaKey) {
          broadcastKey = 'Ctrl+' + e.key;
        } else if (e.shiftKey && e.key === 'Enter') {
          broadcastKey = 'Shift+Enter';
        }
        app.inputBufferManager.queueBroadcast(()=> app.wsClient.broadcastKeyPress(broadcastKey));

        // null result means swap back to previous tool
        if (result === null) {
          if (app.previousTool) {
            app.selectTool(app.previousTool);
          }
        } else {
          app.ui.updateSelfTextInput(result);
          app._updateTextPreview();
        }
        return;
      }
    }

    const actionId = this.getActionForEvent(e);
    const action = actionId ? KEYBIND_ACTIONS.find((candidate) => candidate.id === actionId) : null;

    if (actionId === 'app.openSettings' || actionId === 'panel.performanceDebug') {
      if (this.dispatchAction(actionId, e)) {
        return;
      }
    }

    if (!app.inputBufferManager.tickTimer) {
      return;
    }

    const selectTool = app.toolManager.getTool('select');

    if (e.key === 'Escape' && app.self.tool === 'select') {
      if (selectTool && selectTool.hasSelection()) {
        selectTool.deselect();
      }
      return;
    }

    if (!actionId) {
      return;
    }

    if (action?.isHoldAction) {
      this.startHoldAction(actionId, e);
      return;
    }

    this.dispatchAction(actionId, e);
  }

  handleKeyUp(e) {
    const binding = eventToBinding(e);
    this.handleBindingRelease(binding, e);
  }
}
