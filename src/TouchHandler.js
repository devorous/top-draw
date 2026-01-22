/**
 * Handles touch events for pinch-to-zoom and touch keyboard support
 */
export class TouchHandler {
  constructor(app) {
    this.app = app;
    this.state = {
      touches: [],
      initialDistance: null,
      initialZoom: null,
      isPinching: false,
      centerPoint: null
    };
  }

  get board() { return this.app.board; }
  get ui() { return this.app.ui; }
  get self() { return this.app.self; }
  get wsClient() { return this.app.wsClient; }
  get toolManager() { return this.app.toolManager; }

  handleTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      this.state.isPinching = true;
      this.state.initialDistance = this.getTouchDistance(e.touches);
      this.state.initialZoom = this.board.zoom;
      this.state.centerPoint = this.getTouchCenter(e.touches);
    }
  }

  handleTouchMove(e) {
    if (this.state.isPinching && e.touches.length === 2) {
      e.preventDefault();

      const currentDistance = this.getTouchDistance(e.touches);
      const scale = currentDistance / this.state.initialDistance;
      const newZoom = this.state.initialZoom * scale;

      // Get center point for zoom
      const center = this.getTouchCenter(e.touches);
      const boardRect = this.ui.elements.boards.getBoundingClientRect();

      // Convert screen coordinates to canvas coordinates
      const canvasX = (center.x - boardRect.left - this.board.panX) / this.board.zoom;
      const canvasY = (center.y - boardRect.top - this.board.panY) / this.board.zoom;

      this.board.setZoom(newZoom, { x: canvasX, y: canvasY });
      this.ui.updateZoomDisplay(this.board.getZoomPercent());
    }
  }

  handleTouchEnd(e) {
    if (e.touches.length < 2) {
      this.state.isPinching = false;
      this.state.initialDistance = null;
      this.state.initialZoom = null;
      this.state.centerPoint = null;
    }
  }

  getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTouchCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  // Hidden input handlers for touch keyboard
  handleTouchInput(e) {
    if (this.self.tool !== 'text') return;

    const textTool = this.toolManager.getTool('text');

    // Handle each character typed
    if (e.inputType === 'insertText' && e.data) {
      for (const char of e.data) {
        textTool.onKeyPress(this.self, char);
        this.wsClient.broadcastKeyPress(char);
      }
    } else if (e.inputType === 'deleteContentBackward') {
      textTool.onKeyPress(this.self, 'Backspace');
      this.wsClient.broadcastKeyPress('Backspace');
    }

    this.ui.updateSelfTextInput(this.self.text);
    e.target.value = ''; // Clear input after processing
  }

  handleTouchInputBlur() {
    // Optionally handle when keyboard is dismissed
  }
}
