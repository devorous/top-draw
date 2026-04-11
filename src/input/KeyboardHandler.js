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
  'Mod+Shift+W'
]);

export class KeyboardHandler {
  constructor(app) {
    this.app = app;
  }

  /**
   * Initialize keyboard event listeners
   */
  init() {
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    document.addEventListener('keyup', (e) => this.handleKeyUp(e));
    document.addEventListener('paste', (e) => this.handlePaste(e));
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

  getActionForEvent(e) {
    const binding = eventToBinding(e);
    if (!binding) return null;

    for (const action of KEYBIND_ACTIONS) {
      const actionBindings = this.getBindingsForAction(action.id);
      if (actionBindings.includes(binding)) {
        return action.id;
      }
    }

    return null;
  }

  shouldSuppressBrowserShortcut(binding) {
    return !!binding && BLOCKED_BROWSER_BINDINGS.has(binding);
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

      case 'tool.temporaryEyedropper':
        if (app.self.tool === 'text') return false;
        if (!e.repeat && app.self.tool !== 'inkdropper') {
          app.selectTool('inkdropper');
        }
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
          app.selectTool('select');
          selectTool.paste();
          return true;
        }
        return false;

      case 'selection.selectAll':
        if (!selectTool) return false;
        app.selectTool('select');
        selectTool.selectAll();
        return true;

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

      default:
        return false;
    }
  }

  handleKeyDown(e) {
    const { app } = this;

    // Skip keyboard shortcuts/input if user is typing in a form field or the touch keyboard hidden input
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
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
      app.wsClient.broadcastKeyPress(e.key);
      const textTool = app.toolManager.getTool('text');
      const text = textTool.onKeyPress(app.self, e.key);
      app.ui.updateSelfTextInput(text);
      app._updateTextPreview();
      return;
    }

    const actionId = this.getActionForEvent(e);

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

    this.dispatchAction(actionId, e);
  }

  handleKeyUp(e) {
    const { app } = this;
    const binding = eventToBinding(e);

    if (binding && this.getBindingsForAction('canvas.temporaryPan').includes(binding)) {
      if (app.self.tool !== 'text' && app.self.tool !== 'pan' && app.self.tool !== 'rotate') {
        app.self.panning = false;
        app.wsClient.broadcastPan(false);
        app.wsClient.broadcastShowCursor();
        app.ui.hidePanCursor(app.self.tool, app.self);
      }
      return;
    }

    if (binding && this.getBindingsForAction('canvas.temporaryZoom').includes(binding)) {
      if (app.self.tool === 'zoom' && app._temporaryZoomPreviousTool) {
        e.preventDefault();
        const previousTool = app._temporaryZoomPreviousTool;
        app._temporaryZoomPreviousTool = null;
        app.selectTool(previousTool);
      }
      return;
    }

    if (binding && this.getBindingsForAction('tool.temporaryEyedropper').includes(binding)) {
      if (app.self.tool === 'inkdropper' && app.previousTool) {
        e.preventDefault();
        app.selectTool(app.previousTool);
        app.previousTool = null;
      }
    }
  }
}
