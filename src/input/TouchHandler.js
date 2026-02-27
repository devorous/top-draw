/**
 * Handles touch events for pinch-to-zoom, rotation, pan, and touch keyboard support.
 * Uses mode detection: analyzes initial finger movement to determine gesture type,
 * then locks into that mode (pan, zoom, or rotate) for the duration of the gesture.
 */
export class TouchHandler {
  constructor(app) {
    this.app = app;
    this.element = null;
    this.state = {
      active: false,
      mode: null, // 'pan', 'zoom', 'rotate', or null (still detecting)
      gestureStartedWithTwoFingers: false,
      isPinching: false, // For compatibility with App.js drawing suppression

      // Initial touch state (captured when two fingers touch)
      initialDistance: null,
      initialAngle: null,
      initialCenter: null,

      // Board state at gesture/mode start
      initialZoom: null,
      initialRotation: null,
      initialPanX: null,
      initialPanY: null,

      // Pivot point in canvas coords (for zoom/rotate centering)
      pivotCanvasX: null,
      pivotCanvasY: null
    };

    // Bind handlers
    this.handleTouchStart = this.handleTouchStart.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handleTouchEnd = this.handleTouchEnd.bind(this);
  }

  get board() { return this.app.board; }
  get ui() { return this.app.ui; }
  get self() { return this.app.self; }
  get wsClient() { return this.app.wsClient; }
  get toolManager() { return this.app.toolManager; }

  init(element) {
    this.element = element;

    // Use native touch events for precise control
    element.addEventListener('touchstart', this.handleTouchStart, { passive: false });
    element.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    element.addEventListener('touchend', this.handleTouchEnd, { passive: false });
    element.addEventListener('touchcancel', this.handleTouchEnd, { passive: false });
  }

  // Calculate distance between two touches
  getDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Calculate angle between two touches (in degrees)
  getAngle(touches) {
    const dx = touches[1].clientX - touches[0].clientX;
    const dy = touches[1].clientY - touches[0].clientY;
    return Math.atan2(dy, dx) * (180 / Math.PI);
  }

  // Calculate center point between two touches
  getCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2
    };
  }

  // Convert screen coordinates to canvas coordinates
  // Must produce values consistent with pointer event offsetX/offsetY
  screenToCanvas(screenX, screenY) {
    const rect = this.element.getBoundingClientRect();

    // Position within the visual bounding box
    const visualX = screenX - rect.left;
    const visualY = screenY - rect.top;

    // The transform is scale(zoom) around the element's center
    // Visual center is at rect.width/2, rect.height/2
    // Canvas center is at element.offsetWidth/2, element.offsetHeight/2
    const zoom = this.board.zoom;
    const canvasCenterX = this.element.offsetWidth / 2;
    const canvasCenterY = this.element.offsetHeight / 2;
    const visualCenterX = rect.width / 2;
    const visualCenterY = rect.height / 2;

    // Position relative to visual center
    const relX = visualX - visualCenterX;
    const relY = visualY - visualCenterY;

    // Scale back to canvas coordinates (inverse of the scale transform)
    const canvasX = canvasCenterX + relX / zoom;
    const canvasY = canvasCenterY + relY / zoom;

    return { x: canvasX, y: canvasY };
  }

  handleTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();

      this.state.active = true;
      this.state.mode = null; // Start in detection mode
      this.state.gestureStartedWithTwoFingers = true;
      this.state.isPinching = true;

      // Cancel any current drawing stroke
      if (this.app.self && this.app.self.mousedown) {
        this.app.cancelCurrentStroke();
      }

      // Hide cursor during gestures
      this.ui.hideCursor();
      if (this.wsClient && this.wsClient.connected) {
        this.wsClient.broadcastHideCursor();
      }

      // Capture initial touch state
      this.state.initialDistance = this.getDistance(e.touches);
      this.state.initialAngle = this.getAngle(e.touches);
      this.state.initialCenter = this.getCenter(e.touches);

      // Capture initial board state
      this.state.initialZoom = this.board.zoom;
      this.state.initialRotation = this.board.rotation;
      this.state.initialPanX = this.board.panX;
      this.state.initialPanY = this.board.panY;

      // Calculate pivot point in canvas coords (center between fingers)
      const pivot = this.screenToCanvas(
        this.state.initialCenter.x,
        this.state.initialCenter.y
      );
      this.state.pivotCanvasX = pivot.x;
      this.state.pivotCanvasY = pivot.y;
    }
  }

  handleTouchMove(e) {
    if (!this.state.active || e.touches.length !== 2) return;
    e.preventDefault();

    const currentDistance = this.getDistance(e.touches);
    const currentAngle = this.getAngle(e.touches);
    const currentCenter = this.getCenter(e.touches);

    // If mode not yet determined, analyze movement to detect gesture type
    if (this.state.mode === null) {
      const distanceChange = Math.abs(currentDistance - this.state.initialDistance);

      // Handle angle wraparound (-180 to 180)
      let angleChange = currentAngle - this.state.initialAngle;
      if (angleChange > 180) angleChange -= 360;
      if (angleChange < -180) angleChange += 360;
      angleChange = Math.abs(angleChange);

      const centerDx = currentCenter.x - this.state.initialCenter.x;
      const centerDy = currentCenter.y - this.state.initialCenter.y;
      const centerMove = Math.sqrt(centerDx * centerDx + centerDy * centerDy);

      // Thresholds for gesture detection
      const ZOOM_THRESHOLD = 30;    // pixels of distance change
      const ROTATE_THRESHOLD = 8;   // degrees of rotation
      const PAN_THRESHOLD = 20;     // pixels of center movement

      // Determine which gesture has the strongest signal
      const zoomStrength = distanceChange / ZOOM_THRESHOLD;
      const rotateStrength = angleChange / ROTATE_THRESHOLD;
      const panStrength = centerMove / PAN_THRESHOLD;

      // Need at least one to exceed threshold
      if (zoomStrength >= 1 || rotateStrength >= 1 || panStrength >= 1) {
        // Pick the strongest signal
        if (zoomStrength >= rotateStrength && zoomStrength >= panStrength) {
          this.state.mode = 'zoom';
        } else if (rotateStrength >= zoomStrength && rotateStrength >= panStrength) {
          this.state.mode = 'rotate';
        } else {
          this.state.mode = 'pan';
        }

        // Reset initial values now that we've locked into a mode
        this.state.initialDistance = currentDistance;
        this.state.initialAngle = currentAngle;
        this.state.initialCenter = currentCenter;
        this.state.initialZoom = this.board.zoom;
        this.state.initialRotation = this.board.rotation;
        this.state.initialPanX = this.board.panX;
        this.state.initialPanY = this.board.panY;

        // Recalculate pivot for the current touch center
        const pivot = this.screenToCanvas(currentCenter.x, currentCenter.y);
        this.state.pivotCanvasX = pivot.x;
        this.state.pivotCanvasY = pivot.y;
      }

      return; // Don't apply any transformation until mode is locked
    }

    // Apply transformation based on locked mode
    switch (this.state.mode) {
      case 'pan': {
        const dx = currentCenter.x - this.state.initialCenter.x;
        const dy = currentCenter.y - this.state.initialCenter.y;
        this.board.panX = this.state.initialPanX + dx;
        this.board.panY = this.state.initialPanY + dy;
        this.board.applyTransform();
        break;
      }

      case 'zoom': {
  const scale = currentDistance / this.state.initialDistance;
  const newZoom = Math.max(0.2, Math.min(3, this.state.initialZoom * scale));

  
  const px = this.state.pivotCanvasX;
  const py = this.state.pivotCanvasY;
  
  
  const rad = (this.board.rotation * Math.PI) / 180;

  
  const rotatedX = px * Math.cos(rad) - py * Math.sin(rad);
  const rotatedY = px * Math.sin(rad) + py * Math.cos(rad);

  
  this.board.zoom = newZoom;

  
  
  this.board.panX = this.state.initialCenter.x - (rotatedX * newZoom);
  this.board.panY = this.state.initialCenter.y - (rotatedY * newZoom);

  this.board.applyTransform();
  this.ui.updateZoomDisplay(this.board.getZoomPercent());
  break;
}

      case 'rotate': {
    let angleDelta = currentAngle - this.state.initialAngle;
    // Handle angle wraparound (-180 to 180)
    if (angleDelta > 180) angleDelta -= 360;
    if (angleDelta < -180) angleDelta += 360;

    const newRotation = this.state.initialRotation + angleDelta;
    const rad = (newRotation * Math.PI) / 180;
    const zoom = this.board.zoom;

    const px = this.state.pivotCanvasX;
    const py = this.state.pivotCanvasY;

    const rotatedCanvasX = px * Math.cos(rad) - py * Math.sin(rad);
    const rotatedCanvasY = px * Math.sin(rad) + py * Math.cos(rad);

    this.board.rotation = newRotation;

    this.board.panX = this.state.initialCenter.x - (rotatedCanvasX * zoom);
    this.board.panY = this.state.initialCenter.y - (rotatedCanvasY * zoom);


    this.board.applyTransform();
    break;
}
    }
  }

  handleTouchEnd(e) {
    if (e.touches.length < 2) {
      this.state.active = false;
      this.state.mode = null;
      this.state.isPinching = false;
    }

    if (e.touches.length === 0) {
      this.state.gestureStartedWithTwoFingers = false;
      
      // Restore cursor visibility if still on board
      if (this.app.isOnBoard) {
        this.ui.showCursor();
        if (this.wsClient && this.wsClient.connected) {
          this.wsClient.broadcastShowCursor();
        }
      }
    }
  }

  destroy() {
    if (this.element) {
      this.element.removeEventListener('touchstart', this.handleTouchStart);
      this.element.removeEventListener('touchmove', this.handleTouchMove);
      this.element.removeEventListener('touchend', this.handleTouchEnd);
      this.element.removeEventListener('touchcancel', this.handleTouchEnd);
    }
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
