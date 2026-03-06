/**
 * KeyboardHandler - Manages keyboard shortcuts and key events
 * Handles tool switching, selection operations, panning, and text input
 */

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

    if (e.key === ' ' && app.self.tool !== 'text' && !app.self.panning && !app.self.mousedown) {
      app.self.panning = true;
      app.wsClient.broadcastPan(true);
    }

    // TAB key for temporary inkdropper mode
    if (e.key === 'Tab' && app.self.tool !== 'text') {
      e.preventDefault();
      if (app.self.tool !== 'inkdropper') {
        app.previousTool = app.self.tool;
        app.selectTool('inkdropper');
      }
      return;
    }

    app.wsClient.broadcastKeyPress(e.key);

    if (app.self.tool === 'text') {
      const textTool = app.toolManager.getTool('text');
      const text = textTool.onKeyPress(app.self, e.key);
      app.ui.updateSelfTextInput(text);
    } else if (app.inputBufferManager.tickTimer) {
      // Handle shortcuts only when in drawing mode (tick loop running)
      const selectTool = app.toolManager.getTool('select');

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              app.handleRedo();
            } else {
              app.handleUndo();
            }
            return;
          case 'c':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.copy();
            }
            return;
          case 'x':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.cut();
            }
            return;
          case 'v':
            // The 'paste' event listener will handle system clipboard pastes (e.g., images).
            // Here, we only need to handle the application's internal clipboard.
            const selectTool = app.toolManager.getTool('select');
            if (selectTool && selectTool.hasClipboard()) {
              // If we have an internal clipboard, prevent the native paste event
              // and use our internal paste logic.
              e.preventDefault();
              app.selectTool('select');
              selectTool.paste();
            }
            // If there's no internal clipboard, we do nothing and allow the native 'paste'
            // event to proceed, which is handled by our 'handlePaste' method.
            return;
          case 'a':
            e.preventDefault();
            app.selectTool('select');
            selectTool.selectAll();
            return;
          case 'd':
            if (selectTool && selectTool.hasSelection()) {
              e.preventDefault();
              selectTool.deselect();
            }
            return;
        }
      }

      // Delete/Backspace to delete selection
      if ((e.key === 'Delete' || e.key === 'Backspace') && app.self.tool === 'select') {
        if (selectTool && selectTool.hasSelection()) {
          e.preventDefault();
          selectTool.deleteSelection();
        }
        return;
      }

      // Escape to deselect
      if (e.key === 'Escape' && app.self.tool === 'select') {
        if (selectTool && selectTool.hasSelection()) {
          selectTool.deselect();
        }
        return;
      }

      switch (e.key) {
        case 's':
          app.selectTool('select');
          break;
        case 'b':
          app.selectTool(app.brushModeManager.getCurrentToolName());
          break;
        case 'p':
          if (app.self.tool === 'brush' || app.self.tool === 'flowPen' || app.self.tool === 'ink') {
            // Cycle: classic -> fluid -> ink -> classic
            const currentMode = app.brushModeManager.getMode();
            const nextMode = currentMode === 'classic' ? 'fluid' : currentMode === 'fluid' ? 'ink' : 'classic';
            app.brushModeManager.setMode(nextMode);
          } else {
            app.brushModeManager.setMode('fluid');
          }
          break;
        case 'l':
          app.selectTool('line');
          break;
        case 'r':
          app.selectTool('rectangle');
          break;
        case 'c':
          app.selectTool('circle');
          break;
        case 't':
          app.selectTool('text');
          break;
        case 'e':
          app.selectTool('erase');
          break;
        case 'u':
          app.selectTool('blur');
          break;
        case 'y':
          app.selectTool('circleBlur');
          break;
        case 'g':
          app.selectTool('imageBrush');
          break;
        case 'i':
          app.selectTool('inkdropper');
          break;
        case 'h':
          app.selectTool('pan');
          break;
        case 'n':
          app.selectTool('rotate');
          break;
      }
    }
  }

  handleKeyUp(e) {
    const { app } = this;

    if (e.key === ' ' && app.self.tool !== 'text' && app.self.tool !== 'pan' && app.self.tool !== 'rotate') {
      app.self.panning = false;
      app.wsClient.broadcastPan(false);
    }

    // TAB key release - return to previous tool
    if (e.key === 'Tab' && app.self.tool === 'inkdropper' && app.previousTool) {
      e.preventDefault();
      app.selectTool(app.previousTool);
      app.previousTool = null;
    }
  }
}
