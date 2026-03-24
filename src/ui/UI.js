/**
 * @fileoverview Main UI Manager for handling DOM interactions, icons, and specialized sub-UI components.
 */
import { EditableValueHandler } from './EditableValueHandler.js';
import { RemoteUserUI } from './RemoteUserUI.js';
import { LayerPreview } from './LayerPreview.js';

/**
 * UI Manager class
 */
export class UI {
  constructor() {
    this.elements = {};
    this.icons = {};
    this.cursors = new Map();
    this.editableHandler = new EditableValueHandler();
    this.remoteUserUI = null;
    this.layerPreview = new LayerPreview();
  }

  /**
   * Initializes the UI manager and its sub-components.
   */
  init() {
    this.cacheElements();
    this.createIcons();
    this.remoteUserUI = new RemoteUserUI(this.elements, this.icons);
    this.layerPreview.init();
    this.setupScrollIndicator();
  }

  /**
   * Sets up the scroll indicator for the options panel
   */
  setupScrollIndicator() {
    const optionsPanel = document.getElementById('options');
    const scrollIndicator = document.getElementById('optionsScrollIndicator');

    if (!optionsPanel || !scrollIndicator) return;

    const updateScrollIndicator = () => {
      const hasScroll = optionsPanel.scrollHeight > optionsPanel.clientHeight;
      const scrollTop = optionsPanel.scrollTop;
      const isNearBottom = optionsPanel.scrollHeight - scrollTop <= optionsPanel.clientHeight + 20;

      // Show only when: has scroll, at top (not scrolled), and not at bottom
      if (hasScroll && scrollTop < 10 && !isNearBottom) {
        scrollIndicator.classList.add('visible');
      } else {
        scrollIndicator.classList.remove('visible');
      }
    };

    // Initial check
    updateScrollIndicator();

    // Update on scroll
    optionsPanel.addEventListener('scroll', updateScrollIndicator);

    // Update when window resizes or content changes
    const resizeObserver = new ResizeObserver(updateScrollIndicator);
    resizeObserver.observe(optionsPanel);

    // Also check after a short delay (for dynamic content)
    setTimeout(updateScrollIndicator, 500);
  }

  /**
   * Setup hover listeners for layer buttons to show miniatures.
   * @param {LayerManager} layerManager - Reference to the layer system
   */
  setupLayerPreviewListeners(layerManager) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      btn.addEventListener('mouseenter', (e) => {
        const layerIdx = parseInt(btn.dataset.layer);
        const rect = btn.getBoundingClientRect();
        this.layerPreview.show(layerIdx, layerManager, rect.right, rect.top + rect.height / 2);
      });

      btn.addEventListener('mouseleave', () => {
        this.layerPreview.hide();
      });
    });
  }

  /**
   * Caches commonly used DOM element references.
   */
  cacheElements() {
    this.elements = {
      overlay: document.getElementById('overlay'),
      landingPage: document.getElementById('landingPage'),
      login: document.getElementById('login'),
      connecting: document.getElementById('connecting'),
      joinBtn: document.getElementById('joinBtn'),
      joinBtnLoggedIn: document.getElementById('joinBtnLoggedIn'),
      offlineBtn: document.getElementById('offlineBtn'),
      loginOfflineBtn: document.getElementById('loginOfflineBtn'),
      loginUsername: document.getElementById('loginUsername'),
      loginPassword: document.getElementById('loginPassword'),
      loginForm: document.getElementById('loginForm'),
      loginBtn: document.getElementById('loginBtn'),
      rememberMe: document.getElementById('rememberMe'),

      boardContainer: document.getElementById('boardContainer'),
      boards: document.getElementById('boards'),
      board: document.getElementById('board'),
      topBoard: document.getElementById('topBoard'),
      userBoards: document.getElementById('userBoards'),

      cursorsSvg: document.getElementById('cursorsSvg'),
      selfCursor: document.querySelector('.cursor.self'),
      selfCircle: document.querySelector('.circle.self'),
      selfPressureCircle: document.querySelector('.pressureCircle.self'),
      selfSquare: document.querySelector('.square.self'),
      selfPressureSquare: document.querySelector('.pressureSquare.self'),
      selfCrosshair: document.querySelector('.crosshair.self'),
      selfHand: document.querySelector('.hand.self'),
      selfMutedIndicator: document.querySelector('.mutedIndicator.self'),
      selfText: document.querySelector('.text.self'),
      selfTextInput: document.querySelector('.textInput.self'),
      selfName: document.querySelector('.name.self'),
      mirrorLine: document.querySelector('.mirrorLine'),

      panBtn: document.getElementById('panBtn'),
      rotateBtn: document.getElementById('rotateBtn'),
      selectBtn: document.getElementById('selectBtn'),
      brushBtn: document.getElementById('brushBtn'),
      lineBtn: document.getElementById('lineBtn'),
      rectangleBtn: document.getElementById('rectangleBtn'),
      circleBtn: document.getElementById('circleBtn'),
      textBtn: document.getElementById('textBtn'),
      fillBtn: document.getElementById('fillBtn'),
      eraseBtn: document.getElementById('eraseBtn'),
      blurBtn: document.getElementById('blurBtn'),
      circleBlurBtn: document.getElementById('circleBlurBtn'),
      glitchBlurBtn: document.getElementById('glitchBlurBtn'),
      imageBrushBtn: document.getElementById('imageBrushBtn'),
      patternBtn: document.getElementById('patternBtn'),
      uploadBtn: document.getElementById('uploadBtn'),
      imageUploadInput: document.getElementById('imageUploadInput'),
      inkdropperBtn: document.getElementById('inkdropperBtn'),

      clearBtn: null, // injected dynamically by Moderation._injectModUI()
      resetBtn: document.getElementById('resetBtn'),
      mirrorBtn: document.getElementById('mirrorBtn'),
      plusBtn: document.getElementById('plusBtn'),
      minusBtn: document.getElementById('minusBtn'),
      rotationResetBtn: document.getElementById('rotationResetBtn'),
      zoomPercent: document.querySelector('.zoomPercent'),
      hudUndoBtn: document.getElementById('hudUndoBtn'),
      hudRedoBtn: document.getElementById('hudRedoBtn'),
      mirrorText: document.querySelector('.mirrorOption'),

      menuBtn: document.getElementById('menuBtn'),
      collapsibleBtns: document.getElementById('collapsibleBtns'),
      sidebarToggleBtn: document.getElementById('sidebarToggleBtn'),
      sideMenu: document.getElementById('sideMenu'),
      toolOptions: document.getElementById('toolOptions'),

      devBtn: null, // injected dynamically by Moderation._injectModUI()
      devText: null, // injected dynamically
      debugOverlay: document.getElementById('debugOverlay'),
      perfSettingsBtn: null, // injected dynamically by Moderation._injectModUI()

      chatBtn: document.getElementById('chatBtn'),
      saveBtn: document.getElementById('saveBtn'),

      saveModeOverlay: document.getElementById('saveModeOverlay'),
      saveModeCloseBtn: document.getElementById('saveModeCloseBtn'),
      saveModeCancelBtn: document.getElementById('saveModeCancelBtn'),
      saveAreaBoard: document.getElementById('saveAreaBoard'),
      saveAreaSelection: document.getElementById('saveAreaSelection'),
      saveAreaSelectionLabel: document.getElementById('saveAreaSelectionLabel'),
      saveTransparent: document.getElementById('saveTransparent'),
      saveModeGallery: document.getElementById('saveModeGallery'),
      saveToGalleryBtn: document.getElementById('saveToGalleryBtn'),
      saveLocallyBtn: document.getElementById('saveLocallyBtn'),

      sizeSlider: document.querySelector('.slider.size'),
      spacingSlider: document.querySelector('.slider.spacing'),
      pressureMinSlider: document.getElementById('pressureMinSlider'),
      pressureMaxSlider: document.getElementById('pressureMaxSlider'),
      pressureEnabled: document.getElementById('pressureEnabled'),
      pressureDualSlider: document.getElementById('pressureDualSlider'),
      pressureContainer: document.getElementById('pressure-container'),
      smoothingContainer: document.getElementById('smoothing-container'),
      smoothingSlider: document.querySelector('.slider.smoothing'),
      hardnessSlider: document.querySelector('.slider.hardness'),
      opacitySlider: document.querySelector('.slider.opacity'),
      blurRadiusSlider: document.querySelector('.slider.blurRadius'),
      thinningSlider: document.querySelector('.slider.thinning'),
      patternScaleSlider: document.querySelector('.slider.patternScale'),
      patternRotationSlider: document.querySelector('.slider.patternRotation'),
      patternSpacingSlider: document.querySelector('.slider.patternSpacing'),
      patternOffsetXSlider: document.querySelector('.slider.patternOffsetX'),
      patternOffsetYSlider: document.querySelector('.slider.patternOffsetY'),
      patternColorModeRadios: document.querySelectorAll('input[name="patternColorMode"]'),

      fillPatternScaleSlider: document.querySelector('.slider.fillPatternScale'),
      fillPatternRotationSlider: document.querySelector('.slider.fillPatternRotation'),
      fillPatternSpacingSlider: document.querySelector('.slider.fillPatternSpacing'),
      fillPatternOffsetXSlider: document.querySelector('.slider.fillPatternOffsetX'),
      fillPatternOffsetYSlider: document.querySelector('.slider.fillPatternOffsetY'),
      fillPatternColorModeRadios: document.querySelectorAll('input[name="fillPatternColorMode"]'),
      fillPatternScaleValue: document.getElementById('fillPatternScaleValue'),
      fillPatternRotationValue: document.getElementById('fillPatternRotationValue'),
      fillPatternSpacingValue: document.getElementById('fillPatternSpacingValue'),
      fillPatternOffsetXValue: document.getElementById('fillPatternOffsetXValue'),
      fillPatternOffsetYValue: document.getElementById('fillPatternOffsetYValue'),
      fillPatternBrushList: document.getElementById('fillPatternBrushList'),

      selectionPatternScaleSlider: document.querySelector('.slider.selectionPatternScale'),
      selectionPatternRotationSlider: document.querySelector('.slider.selectionPatternRotation'),
      selectionPatternSpacingSlider: document.querySelector('.slider.selectionPatternSpacing'),
      selectionPatternOffsetXSlider: document.querySelector('.slider.selectionPatternOffsetX'),
      selectionPatternOffsetYSlider: document.querySelector('.slider.selectionPatternOffsetY'),
      selectionPatternColorModeRadios: document.querySelectorAll('input[name="selectionPatternColorMode"]'),
      selectionPatternScaleValue: document.getElementById('selectionPatternScaleValue'),
      selectionPatternRotationValue: document.getElementById('selectionPatternRotationValue'),
      selectionPatternSpacingValue: document.getElementById('selectionPatternSpacingValue'),
      selectionPatternOffsetXValue: document.getElementById('selectionPatternOffsetXValue'),
      selectionPatternOffsetYValue: document.getElementById('selectionPatternOffsetYValue'),
      selectionPatternBrushList: document.getElementById('selectionPatternBrushList'),

      sizeValue: document.getElementById('sizeValue'),
      pressureValue: document.getElementById('pressureValue'),
      smoothingValue: document.getElementById('smoothingValue'),
      spacingValue: document.getElementById('spacingValue'),
      hardnessValue: document.getElementById('hardnessValue'),
      opacityValue: document.getElementById('opacityValue'),
      blurRadiusValue: document.getElementById('blurRadiusValue'),
      thinningValue: document.getElementById('thinningValue'),
      patternScaleValue: document.getElementById('patternScaleValue'),
      patternRotationValue: document.getElementById('patternRotationValue'),
      patternSpacingValue: document.getElementById('patternSpacingValue'),
      patternOffsetXValue: document.getElementById('patternOffsetXValue'),
      patternOffsetYValue: document.getElementById('patternOffsetYValue'),

      brushFileInput: document.getElementById('brush-file-input'),
      brushImage: document.getElementById('brushImage'),
      sizeContainer: document.getElementById('size-container'),
      brushSpacing: document.getElementById('brush-spacing'),
      brushHardness: document.getElementById('brush-hardness'),
      opacityContainer: document.getElementById('brush-opacity'),
      blurRadiusContainer: document.getElementById('blur-radius'),
      inkThinningContainer: document.getElementById('ink-thinning'),

      selectionModeOptions: document.getElementById('selectionModeOptions'),
      eraserModeOptions: document.getElementById('eraserModeOptions'),
      brushModeOptions: document.getElementById('brushModeOptions'),
      circleBlurModeOptions: document.getElementById('circleBlurModeOptions'),
      fillModeOptions: document.getElementById('fillModeOptions'),
      patternModeOptions: document.getElementById('patternModeOptions'),
      patternBrushList: document.getElementById('patternBrushList'),
      patternImageBtn: document.getElementById('patternImageBtn'),
      patternImageUploadInput: document.getElementById('patternImageUploadInput'),
      patternShapeSelect: document.getElementById('patternShapeSelect'),
      patternShapeUploadBtn: document.getElementById('patternShapeUploadBtn'),
      patternShapeUploadInput: document.getElementById('patternShapeUploadInput'),

      sizeLock: document.getElementById('sizeLock'),
      pressureLock: document.getElementById('pressureLock'),
      smoothingLock: document.getElementById('smoothingLock'),
      spacingLock: document.getElementById('spacingLock'),
      hardnessLock: document.getElementById('hardnessLock'),
      opacityLock: document.getElementById('opacityLock'),
      blurRadiusLock: document.getElementById('blurRadiusLock'),
      thinningLock: document.getElementById('thinningLock'),
      simulatePressureCheckbox: document.getElementById('simulatePressureCheckbox'),

      colorPicker: document.getElementById('colorPicker'),

      touchInput: document.getElementById('touchInput'),

      bottomBar: document.getElementById('bottomBar'),
      undoBtn: document.getElementById('undoBtn'),
      timeline: document.getElementById('timeline'),

      userList: document.getElementById('userList'),
      selfUserEntry: document.querySelector('.userEntry.self'),
      selfListTool: document.querySelector('.listTool.self'),
      selfListColor: document.querySelector('.listColor.self'),
      selfListUser: document.querySelector('.listUser.self'),
      selfListActive: document.querySelector('.listActive.self'),

      toast: document.getElementById('toast'),

      connectionStatus: document.getElementById('connectionStatus'),
      connectionDot: document.querySelector('.connectionDot'),
      connectionText: document.querySelector('.connectionText'),
      connectionRoom: document.getElementById('connectionRoom'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      userContextMenu: document.getElementById('userContextMenu'),
      modPanel: null, // injected dynamically by Moderation._injectModUI()
      modBtn: null // injected dynamically by Moderation._injectModUI()
    };
  }

  /**
   * Populates the internal icons map from image sources.
   */
  createIcons() {
    this.icons = {
      select: this.createIcon('/images/select-icon.svg'),
      brush: this.createIcon('/images/brush-icon.svg'),
      pen: this.createIcon('/images/brush-icon.svg'),
      flowPen: this.createIcon('/images/brush-icon.svg'),
      ink: this.createIcon('/images/brush-icon.svg'),
      line: this.createIcon('/images/line-icon.svg'),
      rectangle: this.createIcon('/images/rectangle-icon.svg'),
      circle: this.createIcon('/images/circle-icon.svg'),
      text: this.createIcon('/images/text-icon.svg'),
      erase: this.createIcon('/images/eraser-icon.svg'),
      blur: this.createIcon('/images/brush-icon.svg'),
      circleBlur: this.createIcon('/images/circle-blur-icon.svg'),
      glitchBlur: this.createIcon('/images/circle-blur-icon.svg'),
      inkdropper: this.createIcon('/images/inkdropper-icon.svg'),
      pan: this.createIcon('/images/move-icon.svg'),
      rotate: this.createIcon('/images/rotate-icon.svg'),
      imageBrush: this.createIcon('/images/pepper.png'),
      pixel: this.createIcon('/images/brush-icon.svg')
    };
  }

  /**
   * Creates an icon image element.
   * @param {string} src - Image source path
   * @returns {HTMLImageElement}
   */
  createIcon(src) {
    const img = document.createElement('img');
    img.className = 'toolIcon';
    img.src = src;
    return img;
  }

  /**
   * Shows the login interface on the landing page.
   */
  showLogin() {
    this.elements.landingPage.style.display = 'flex';
    this.elements.login.style.display = 'none';
    this.elements.connecting.style.display = 'none';
  }

  /**
   * Hides the global overlay.
   */
  hideOverlay() {
    this.elements.overlay.style.display = 'none';
  }

  /**
   * Shows the local user's cursor elements.
   */
  showCursor() {
    this.elements.selfCursor.style.display = 'block';
  }

  /**
   * Hides the local user's cursor elements.
   */
  hideCursor() {
    this.elements.selfCursor.style.display = 'none';
    this.elements.selfCircle.style.display = 'none';
    this.elements.selfSquare.style.display = 'none';
    this.elements.selfCrosshair.style.display = 'none';
    this.elements.selfText.style.display = 'none';
    if (this.elements.selfPressureCircle) {
      this.elements.selfPressureCircle.style.display = 'none';
    }
    if (this.elements.selfPressureSquare) {
      this.elements.selfPressureSquare.style.display = 'none';
    }
  }

  /**
   * Updates the position and basic scale of the local user's cursor.
   * @param {number} x - Board X
   * @param {number} y - Board Y
   * @param {number} size - Base tool size
   */
  updateSelfCursor(x, y, size) {
    const cursor = this.elements.selfCursor;
    const circle = this.elements.selfCircle;
    const pressureCircle = this.elements.selfPressureCircle;
    const square = this.elements.selfSquare;
    const pressureSquare = this.elements.selfPressureSquare;
    const crosshair = this.elements.selfCrosshair;
    const hand = this.elements.selfHand;
    const mutedIndicator = this.elements.selfMutedIndicator;

    this._lastCursorX = x;
    this._lastCursorY = y;

    cursor.style.left = `${x - 100}px`;
    cursor.style.top = `${y - 100}px`;
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    if (pressureCircle) {
      pressureCircle.setAttribute('cx', x);
      pressureCircle.setAttribute('cy', y);
    }
    square.setAttribute('x', x - size);
    square.setAttribute('y', y - size);
    if (pressureSquare && pressureSquare.style.display !== 'none') {
      const psizeAttr = pressureSquare.getAttribute('width') || 10;
      const psize = parseFloat(psizeAttr) / 2;
      pressureSquare.setAttribute('x', x - psize);
      pressureSquare.setAttribute('y', y - psize);
    }
    crosshair.setAttribute('transform', `translate(${x}, ${y})`);
    if (hand) {
      hand.setAttribute('transform', `translate(${x}, ${y})`);
    }
    if (mutedIndicator) {
      mutedIndicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  /**
   * Updates the static radius/dimensions of the local cursor.
   * @param {number} size - Base tool size
   */
  updateCursorSize(size) {
    this.elements.selfCircle.setAttribute('r', size);
    this.elements.selfSquare.setAttribute('width', size * 2);
    this.elements.selfSquare.setAttribute('height', size * 2);
  }

  /**
   * Updates the pressure-sensitive feedback circle radius.
   * @param {number} r - Pressure-scaled radius
   * @param {number} baseSize - Unscaled base size
   */
  updatePressureCursorRadius(r, baseSize) {
    const el = this.elements.selfPressureCircle;
    if (!el) return;

    if (baseSize !== undefined && r < baseSize) {
      el.style.display = 'block';
      el.setAttribute('r', Math.max(1, r));
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * Updates the pressure-sensitive feedback square size.
   * @param {number} squareSize - Pressure-scaled half-width
   * @param {number} baseSize - Unscaled base size
   */
  updatePressureSquareSize(squareSize, baseSize) {
    const el = this.elements.selfPressureSquare;
    if (!el) return;

    if (baseSize !== undefined && squareSize < baseSize) {
      el.style.display = 'block';
      const sizeDoubled = Math.max(2, squareSize * 2);
      el.setAttribute('width', sizeDoubled);
      el.setAttribute('height', sizeDoubled);
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * Synchronizes square cursor shapes with the current mouse position.
   * @param {number} size - Base tool size
   */
  updateSquarePositions(size) {
    const x = this._lastCursorX || 0;
    const y = this._lastCursorY || 0;
    const square = this.elements.selfSquare;
    const pressureSquare = this.elements.selfPressureSquare;

    if (square && square.style.display !== 'none') {
      square.setAttribute('x', x - size);
      square.setAttribute('y', y - size);
    }

    if (pressureSquare && pressureSquare.style.display !== 'none') {
      const psizeAttr = parseFloat(pressureSquare.getAttribute('width') || 2);
      const psize = psizeAttr / 2;
      pressureSquare.setAttribute('x', x - psize);
      pressureSquare.setAttribute('y', y - psize);
    }
  }

  /**
   * Switches between crosshair and hand for the selection tool.
   * @param {boolean} isHand - Whether to show the hand icon
   */
  setSelectCursor(isHand) {
    if (isHand) {
      this.elements.selfCrosshair.style.display = 'none';
      this.elements.selfHand.style.display = 'block';
    } else {
      this.elements.selfCrosshair.style.display = 'block';
      this.elements.selfHand.style.display = 'none';
    }
  }

  /**
   * Updates the muted indicator state on the local cursor.
   * @param {boolean} muted - Whether the user is muted
   */
  setMutedState(muted) {
    const indicator = this.elements.selfMutedIndicator;
    const circle = this.elements.selfCircle;
    if (indicator) {
      indicator.style.display = muted ? 'block' : 'none';
    }
    if (circle) {
      circle.setAttribute('stroke', muted ? '#ef4444' : 'grey');
    }
  }

  /**
   * Updates the position of the muted indicator.
   * @param {number} x - Board X
   * @param {number} y - Board Y
   */
  updateMutedIndicatorPosition(x, y) {
    const indicator = this.elements.selfMutedIndicator;
    if (indicator) {
      indicator.setAttribute('transform', `translate(${x}, ${y})`);
    }
  }

  /**
   * Updates tool options and cursor shapes based on the current tool.
   * @param {string} tool - Current tool name
   * @param {Object} [user=null] - Local user object
   */
  updateToolDisplay(tool, user = null) {
    const {
      selfCircle, selfPressureCircle, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfText,
      brushImage, brushFileInput, sizeContainer, pressureContainer, smoothingContainer,
      brushSpacing, brushHardness, opacityContainer, blurRadiusContainer,
      selectionModeOptions, eraserModeOptions, brushModeOptions, circleBlurModeOptions, fillModeOptions, patternModeOptions
    } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfHand.style.display = 'none';
    selfText.style.display = 'none';
    brushImage.style.display = 'none';
    brushFileInput.style.display = 'none';
    brushSpacing.style.display = 'none';
    brushHardness.style.display = 'none';

    sizeContainer.style.display = 'block';
    pressureContainer.style.display = 'block';
    smoothingContainer.style.display = 'block';
    opacityContainer.style.display = 'block';

    if (blurRadiusContainer) blurRadiusContainer.style.display = 'none';
    if (selectionModeOptions) selectionModeOptions.style.display = 'none';
    if (eraserModeOptions) eraserModeOptions.style.display = 'none';
    if (brushModeOptions) brushModeOptions.style.display = 'none';
    if (circleBlurModeOptions) circleBlurModeOptions.style.display = 'none';
    if (this.elements.fillModeOptions) this.elements.fillModeOptions.style.display = 'none';
    if (patternModeOptions) patternModeOptions.style.display = 'none';
    if (this.elements.inkThinningContainer) this.elements.inkThinningContainer.style.display = 'none';
    
    const { blendModeOptions } = this.elements;
    if (blendModeOptions) {
      const layerManager = window.app?.board?.layerManager;
      const activeLayer = window.app?.self?.activeLayer ?? 0;
      const allowComplex = layerManager ? layerManager.getLayerAllowComplexBlendModes(activeLayer) : true;
      blendModeOptions.style.display = (this.toolSupportsBlendMode(tool) && allowComplex) ? 'block' : 'none';
    }

    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';

    switch (tool) {
      case 'select':
        selfCrosshair.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        if (selectionModeOptions) selectionModeOptions.style.display = 'block';
        break;

      case 'brush':
      case 'flowPen':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        if (selfPressureCircle) selfPressureCircle.style.display = 'block';
        break;

      case 'ink':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        if (selfPressureCircle) selfPressureCircle.style.display = 'block';
        if (this.elements.inkThinningContainer) this.elements.inkThinningContainer.style.display = 'block';
        break;

      case 'line':
      case 'rectangle':
      case 'circle':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        break;

      case 'text':
        selfText.style.display = 'block';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        break;

      case 'erase':
        selfCircle.style.display = 'block';
        opacityContainer.style.display = 'block';
        brushHardness.style.display = 'block';
        if (eraserModeOptions) eraserModeOptions.style.display = 'block';
        if (selfPressureCircle) selfPressureCircle.style.display = 'block';
        break;

      case 'circleBlur':
        selfCircle.style.display = 'block';
        brushSpacing.style.display = 'block';
        brushHardness.style.display = 'block';
        if (selfPressureCircle) selfPressureCircle.style.display = 'block';
        break;

      case 'glitchBlur':
        selfSquare.style.display = 'block';
        brushSpacing.style.display = 'block';
        smoothingContainer.style.display = 'none';
        if (blurRadiusContainer) blurRadiusContainer.style.display = 'block';
        break;

      case 'blur':
        selfSquare.style.display = 'block';
        brushSpacing.style.display = 'block';
        smoothingContainer.style.display = 'none';
        if (blurRadiusContainer) blurRadiusContainer.style.display = 'block';
        break;

      case 'imageBrush':
        selfSquare.style.display = 'block';
        if (user && user.imageBrush) brushImage.style.display = 'block';
        brushFileInput.style.display = 'block';
        brushSpacing.style.display = 'block';
        if (selfPressureSquare) selfPressureSquare.style.display = 'block';
        break;

      case 'pattern':
        if (user && user.patternShape === 'square') {
          selfSquare.style.display = 'block';
          if (selfPressureSquare) selfPressureSquare.style.display = 'block';
        } else {
          selfCircle.style.display = 'block';
          if (selfPressureCircle) selfPressureCircle.style.display = 'block';
        }
        brushSpacing.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if (patternModeOptions) patternModeOptions.style.display = 'block';
        break;

      case 'pixel':
        selfSquare.style.display = 'block';
        brushSpacing.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        break;

      case 'fill':
        selfCrosshair.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if (fillModeOptions) fillModeOptions.style.display = 'block';
        break;

      case 'inkdropper':
        selfCrosshair.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;

      case 'pan':
        selfHand.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;

      case 'rotate':
        selfCrosshair.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;
    }

    this.updateToolButton(tool);
  }

  /**
   * Check if a tool supports blend modes.
   * @param {string} tool - Tool name
   * @returns {boolean}
   */
  toolSupportsBlendMode(tool) {
    const noBlendTools = ['erase', 'select', 'pan', 'rotate', 'inkdropper'];
    return !noBlendTools.includes(tool);
  }

  /**
   * Updates the selected state of tool buttons in the toolbar.
   * @param {string} tool - Selected tool name
   */
  updateToolButton(tool) {
    const buttons = {
      pan: this.elements.panBtn,
      rotate: this.elements.rotateBtn,
      select: this.elements.selectBtn,
      brush: this.elements.brushBtn,
      pixel: this.elements.brushBtn,
      line: this.elements.lineBtn,
      rectangle: this.elements.rectangleBtn,
      circle: this.elements.circleBtn,
      text: this.elements.textBtn,
      erase: this.elements.eraseBtn,
      blur: this.elements.blurBtn,
      circleBlur: this.elements.circleBlurBtn,
      glitchBlur: this.elements.glitchBlurBtn,
      imageBrush: this.elements.imageBrushBtn,
      pattern: this.elements.patternBtn,
      inkdropper: this.elements.inkdropperBtn
    };

    Object.values(buttons).forEach(btn => btn && btn.classList.remove('selected'));
    let buttonTool = tool;
    if (tool === 'flowPen' || tool === 'ink') buttonTool = 'brush';
    if (buttons[buttonTool]) {
      buttons[buttonTool].classList.add('selected');
    }

    const toolIcon = this.icons[tool];
    if (toolIcon) {
      const toolEntry = this.elements.selfListTool;
      if (toolEntry.children[0]) {
        toolEntry.children[0].remove();
      }
      toolEntry.appendChild(toolIcon.cloneNode(true));
    }
  }

  /**
   * Updates the zoom percentage display.
   * @param {string} percent - Zoom percentage text
   */
  updateZoomDisplay(percent) {
    this.elements.zoomPercent.textContent = percent;
  }

  /**
   * Updates the mirror line toggle display.
   * @param {boolean} enabled - Whether mirror is enabled
   */
  updateMirrorDisplay(enabled) {
    this.elements.mirrorText.textContent = enabled ? 'ON' : 'OFF';
  }

  /**
   * Updates the dev mode toggle display.
   * @param {boolean} enabled - Whether dev mode is enabled
   */
  updateDevModeDisplay(enabled) {
    // devText is injected dynamically; re-query in case it was added after init
    const devText = this.elements.devText || document.querySelector('.devOption');
    if (devText) {
      this.elements.devText = devText;
      devText.textContent = enabled ? 'ON' : 'OFF';
      devText.classList.toggle('active', enabled);
    }
  }

  /**
   * Updates the brush mode radio buttons.
   * @param {string} mode - Selected brush mode
   */
  updateBrushModeDisplay(mode) {
    const radios = document.querySelectorAll('input[name="brushMode"]');
    radios.forEach(r => {
      r.checked = (r.value === mode);
    });
  }

  /**
   * Updates the circle blur mode radio buttons.
   * @param {string} tool - Selected circle blur tool
   * @deprecated Circle blur no longer has soft/hard modes
   */
  updateCircleBlurModeDisplay(tool) {
    // No-op: Circle blur now only has one mode (averaged color circles)
  }

  /**
   * Updates the highlighted layer button in the layers panel.
   * @param {number} layerIndex - Active layer index
   */
  updateActiveLayerDisplay(layerIndex) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      const btnLayer = parseInt(btn.dataset.layer);
      btn.classList.toggle('active', btnLayer === layerIndex);
    });
  }

  /**
   * Enable/disable blur tool buttons based on active layer.
   * Blur only works on layer 0.
   * @param {number} layerIndex - Active layer index
   */
  updateBlurToolState(layerIndex) {
    const disabled = layerIndex !== 0;
    if (this.elements.blurBtn) {
      this.elements.blurBtn.classList.toggle('tool-disabled', disabled);
    }
  }

  /**
   * Updates the selected blend mode in the dropdown.
   * @param {string} blendMode - Selected blend mode
   */
  updateBlendModeDisplay(blendMode) {
    if (this.elements.blendModeSelect) {
      this._updatingBlendMode = true;
      this.elements.blendModeSelect.value = blendMode;
      this._updatingBlendMode = false;
    }
  }

  /**
   * Updates blend mode section visibility based on layer support.
   * @param {boolean} allowComplex - Whether the active layer allows blend modes
   * @returns {boolean} - True if a reset to Normal was performed
   */
  updateBlendModeForLayer(allowComplex) {
    const section = this.elements.blendModeOptions;
    if (!section) return false;

    const tool = window.app?.self?.tool;
    const toolSupports = tool ? this.toolSupportsBlendMode(tool) : true;

    if (allowComplex && toolSupports) {
      section.style.display = 'block';
      return false;
    } else {
      section.style.display = 'none';
      const select = this.elements.blendModeSelect;
      if (select && select.value !== 'source-over') {
        this._updatingBlendMode = true;
        select.value = 'source-over';
        this._updatingBlendMode = false;
        return true;
      }
      return false;
    }
  }

  /**
   * Updates the local user's color in the user list.
   * @param {Array} color - [r, g, b, a] color array
   */
  updateSelfColor(color) {
    this.elements.selfListColor.style.backgroundColor = `rgba(${color.join(',')})`;
  }

  /**
   * Updates the local text input preview.
   * @param {string} text - Current text input
   */
  updateSelfTextInput(text) {
    this.elements.selfTextInput.innerHTML = text;
  }

  /**
   * Updates the local username display.
   * @param {string} name - New username
   */
  updateSelfName(name) {
    this.elements.selfName.textContent = name;
    this.elements.selfListUser.textContent = name;
  }

  /**
   * Updates the local tool icon in the user list.
   * @param {string} tool - Current tool name
   */
  updateSelfToolIcon(tool) {
    const { selfListTool } = this.elements;
    if (selfListTool) {
      selfListTool.innerHTML = '';
      const icon = this.icons[tool] || this.icons.brush;
      selfListTool.appendChild(icon.cloneNode(true));
    }
  }

  /**
   * Updates the local floating text cursor style.
   * @param {number} size - Font size
   * @param {Array} color - [r, g, b, a] color array
   */
  updateSelfTextStyle(size, color) {
    this.elements.selfText.style.fontSize = `${size + 5}px`;
    const [r, g, b, a] = color;
    this.elements.selfText.style.color = `rgba(${r}, ${g}, ${b}, ${a * a})`;
  }

  /**
   * Updates the mix-blend-mode on the floating text cursor preview.
   * @param {string} cssBlendMode - CSS mix-blend-mode value
   */
  updateTextPreviewBlendMode(cssBlendMode) {
    if (this.elements.selfText) {
      this.elements.selfText.style.mixBlendMode = cssBlendMode;
    }
  }

  /**
   * Move and focus the hidden touch input to trigger virtual keyboard.
   * @param {number} x - Client X
   * @param {number} y - Client Y
   */
  activateTouchInput(x, y) {
    const input = this.elements.touchInput;
    if (!input) return;

    input.style.left = `${x}px`;
    input.style.top = `${y}px`;
    input.value = ' ';
    input.style.pointerEvents = 'auto';
    
    setTimeout(() => {
      input.focus();
      setTimeout(() => {
        input.style.pointerEvents = 'none';
      }, 500);
    }, 10);
  }

  /**
   * Sets the image brush preview source.
   * @param {string} url - Image data URL
   */
  setBrushPreview(url) {
    this.elements.brushImage.src = url;
    this.elements.brushImage.style.display = 'block';
  }

  /**
   * Updates the tool size value display.
   * @param {number} size - Current size
   */
  updateSizeValue(size) {
    if (this.elements.sizeValue) {
      this.elements.sizeValue.textContent = size;
    }
  }

  /**
   * Updates the pressure sensitivity range display.
   * @param {number} min - Minimum pressure scale
   * @param {number} [max] - Maximum pressure scale
   */
  updatePressureValue(min, max) {
    if (this.elements.pressureValue) {
      if (max === undefined) {
        this.elements.pressureValue.textContent = `0-${min}`;
      } else {
        this.elements.pressureValue.textContent = `${min}-${max}`;
      }
    }
  }

  /**
   * Updates the smoothing factor display.
   * @param {number} smoothing - Smoothing value
   */
  updateSmoothingValue(smoothing) {
    if (this.elements.smoothingValue) {
      this.elements.smoothingValue.textContent = Math.round(smoothing);
    }
  }

  /**
   * Updates the brush spacing factor display.
   * @param {number} spacing - Spacing value
   */
  updateSpacingValue(spacing) {
    if (this.elements.spacingValue) {
      this.elements.spacingValue.textContent = spacing;
    }
  }

  /**
   * Updates the brush hardness factor display.
   * @param {number} hardness - Hardness value
   */
  updateHardnessValue(hardness) {
    if (this.elements.hardnessValue) {
      this.elements.hardnessValue.textContent = Math.round(hardness);
    }
  }

  /**
   * Updates the blur radius value display.
   * @param {number} radius - Blur radius
   */
  updateBlurRadiusValue(radius) {
    if (this.elements.blurRadiusValue) {
      this.elements.blurRadiusValue.textContent = radius;
    }
  }

  /**
   * Updates the tool opacity value display.
   * @param {number} opacity - Opacity (0-1)
   */
  updateopacityValue(opacity) {
    if (this.elements.opacityValue) {
      this.elements.opacityValue.textContent = Math.round(opacity * 100);
    }
  }

  /**
   * Updates the ink thinning value display.
   * @param {number} thinning - Thinning value (0-100)
   */
  updateThinningValue(thinning) {
    if (this.elements.thinningValue) {
      this.elements.thinningValue.textContent = thinning;
    }
    if (this.elements.thinningSlider) {
      this.elements.thinningSlider.value = thinning;
    }
  }

  /**
   * Updates the simulate pressure checkbox state.
   * @param {boolean} simulate - Whether simulate pressure is enabled.
   */
  updateSimulatePressure(simulate) {
    if (this.elements.simulatePressureCheckbox) {
      this.elements.simulatePressureCheckbox.checked = simulate;
    }
  }

  /**
   * Updates the lock/unlock state of a tool property button.
   * @param {string} property - Property name
   * @param {boolean} locked - Whether it's locked
   * @param {boolean} [visible=true] - Whether the lock button should be shown
   */
  updateLockButton(property, locked, visible = true) {
    const btn = this.elements[`${property}Lock`];
    if (!btn) return;

    btn.style.display = visible ? 'inline-block' : 'none';
    btn.textContent = locked ? '🔒' : '🔓';
    btn.classList.toggle('locked', locked);
    btn.title = locked ? `Unlock ${property} for current tool` : `Lock ${property} for current tool`;
  }

  /**
   * Delegate making an element editable to EditableValueHandler.
   * @param {HTMLElement} spanEl - Element to make editable
   * @param {Object} opts - Configuration options
   */
  makeValueEditable(spanEl, opts) {
    return this.editableHandler.makeEditable(spanEl, opts);
  }

  hideRemoteCursor(userId) {
    return this.remoteUserUI.hideRemoteCursor(userId);
  }

  showRemoteCursor(userId) {
    return this.remoteUserUI.showRemoteCursor(userId);
  }
  
  /**
   * Toggles the collapsible toolbar menu.
   */
  toggleMenu() {
    const menu = this.elements.collapsibleBtns;
    if (menu) {
      menu.classList.toggle('show');
    }
  }

  /**
   * Closes the collapsible toolbar menu.
   */
  closeMenu() {
    const menu = this.elements.collapsibleBtns;
    if (menu) {
      menu.classList.remove('show');
    }
  }

  /**
   * Toggles the tool options sidebar.
   * @returns {boolean} - New collapsed state
   */
  toggleSidebar() {
    const toolOptions = this.elements.toolOptions;
    const btn = this.elements.sidebarToggleBtn;
    if (toolOptions) {
      const isCollapsed = toolOptions.classList.toggle('collapsed');
      if (btn) btn.classList.toggle('active', isCollapsed);
      return isCollapsed;
    }
    return false;
  }

  /**
   * Force sets the sidebar collapsed state.
   * @param {boolean} collapsed - Target collapsed state
   */
  setSidebarCollapsed(collapsed) {
    const toolOptions = this.elements.toolOptions;
    const btn = this.elements.sidebarToggleBtn;
    if (toolOptions) {
      toolOptions.classList.toggle('collapsed', collapsed);
      if (btn) btn.classList.toggle('active', collapsed);
    }
  }

  createRemoteUser(userId, userData) {
    return this.remoteUserUI.createRemoteUser(userId, userData);
  }

  createUserBoard(userId) {
    return this.remoteUserUI.createUserBoard(userId);
  }

  createUserListEntry(userId, userData) {
    return this.remoteUserUI.createUserListEntry(userId, userData);
  }

  updateRemoteCursor(userId, x, y, size) {
    return this.remoteUserUI.updateRemoteCursor(userId, x, y, size);
  }

  updateRemoteToolDisplay(userId, tool) {
    this.remoteUserUI.updateRemoteToolDisplay(userId, tool);
    this.remoteUserUI.updateRemoteToolIcon(userId, tool);
  }

  updateRemoteSize(userId, size) {
    return this.remoteUserUI.updateRemoteSize(userId, size);
  }

  updateRemoteColor(userId, color) {
    return this.remoteUserUI.updateRemoteColor(userId, color);
  }

  updateRemoteName(userId, name) {
    return this.remoteUserUI.updateRemoteName(userId, name);
  }

  updateRemoteText(userId, textContent) {
    return this.remoteUserUI.updateRemoteText(userId, textContent);
  }

  setRemoteTextDomVisible(userId, visible) {
    return this.remoteUserUI.setRemoteTextDomVisible(userId, visible);
  }

  setRemoteUserAfk(userId, afk) {
    return this.remoteUserUI.setRemoteUserAfk(userId, afk);
  }

  removeRemoteUser(userId) {
    return this.remoteUserUI.removeRemoteUser(userId);
  }

  getRemoteUserBoard(userId) {
    return this.remoteUserUI.getRemoteUserBoard(userId);
  }

  /**
   * Shows a toast notification.
   * @param {string} message - Notification message
   * @param {number} [duration=2000] - Duration in ms
   * @param {string} [type=''] - Toast type (e.g., 'error')
   */
  showToast(message, duration = 2000, type = '') {
    const toast = this.elements.toast;
    if (!toast) return;

    if (this._toastTimeout) {
      clearTimeout(this._toastTimeout);
    }

    toast.textContent = message;
    toast.classList.remove('error');
    if (type === 'error') toast.classList.add('error');
    toast.classList.add('show');

    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('show', 'error');
    }, duration);
  }
  
  /**
   * Updates the global connection status indicator.
   * @param {string} state - Connection state string
   */
  showConnectionStatus(state, roomId = null) {
    const { connectionStatus, connectionText, connectionRoom } = this.elements;
    if (!connectionStatus) return;

    connectionStatus.style.display = 'flex';
    connectionStatus.className = `connectionStatus ${state}`;

    const labels = {
      connected: 'Connected',
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      offline: 'Drawing Alone'
    };
    connectionText.textContent = labels[state] || state;

    if (connectionRoom) {
      if (roomId && state === 'connected') {
        connectionRoom.textContent = roomId;
        connectionRoom.style.display = 'inline';
      } else {
        connectionRoom.style.display = 'none';
      }
    }
  }

  /**
   * Hides the connection status indicator.
   */
  hideConnectionStatus() {
    const { connectionStatus } = this.elements;
    if (connectionStatus) {
      connectionStatus.style.display = 'none';
    }
  }
  
  /**
   * Updates a user's role badge in the user list.
   * @param {string} userId - User identifier
   * @param {number} role - Role level
   */
  updateUserRoleBadge(userId, role) {
    const id = `u${userId}`;
    const badge = document.querySelector(`.roleBadge.${id}`);
    if (!badge) return;

    badge.classList.remove('mod', 'admin');
    if (role >= 5) {
      badge.textContent = 'admin';
      badge.classList.add('admin');
      badge.style.display = '';
    } else if (role >= 4) {
      badge.textContent = 'mod';
      badge.classList.add('mod');
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  /**
   * Updates the self user entry's role styling in the user list.
   * @param {number} role - Role level (0-8)
   */
  updateSelfRole(role) {
    const el = this.elements.selfListUser;
    if (!el) return;

    // Remove all rank classes
    const rankClasses = ['rank-helper', 'rank-mod', 'rank-admin', 'rank-noble', 'rank-holy', 'rank-deity'];
    el.classList.remove(...rankClasses);

    // Import would create circular dependency, so inline the mapping
    if (role >= 8) el.classList.add('rank-deity');
    else if (role >= 7) el.classList.add('rank-holy');
    else if (role >= 6) el.classList.add('rank-noble');
    else if (role >= 5) el.classList.add('rank-admin');
    else if (role >= 4) el.classList.add('rank-mod');
    else if (role >= 3) el.classList.add('rank-helper');

    // Also update the self userEntry glow
    const entry = el.closest('.userEntry');
    if (entry) {
      entry.classList.remove(...rankClasses);
      if (role >= 8) entry.classList.add('rank-deity');
      else if (role >= 7) entry.classList.add('rank-holy');
      else if (role >= 6) entry.classList.add('rank-noble');
    }
  }

  /**
   * Updates a remote user's rank styling in the user list.
   * @param {number} sessionIndex
   * @param {number} role - Role level (0-8)
   */
  updateRemoteUserRank(sessionIndex, role) {
    const id = `u${sessionIndex}`;
    const rankClasses = ['rank-helper', 'rank-mod', 'rank-admin', 'rank-noble', 'rank-holy', 'rank-deity'];

    const listUser = document.querySelector(`.listUser.${id}`);
    if (listUser) {
      listUser.classList.remove(...rankClasses);
      if (role >= 8) listUser.classList.add('rank-deity');
      else if (role >= 7) listUser.classList.add('rank-holy');
      else if (role >= 6) listUser.classList.add('rank-noble');
      else if (role >= 5) listUser.classList.add('rank-admin');
      else if (role >= 4) listUser.classList.add('rank-mod');
      else if (role >= 3) listUser.classList.add('rank-helper');
    }

    const entry = document.querySelector(`.userEntry.${id}`);
    if (entry) {
      entry.classList.remove(...rankClasses);
      if (role >= 6) {
        if (role >= 8) entry.classList.add('rank-deity');
        else if (role >= 7) entry.classList.add('rank-holy');
        else entry.classList.add('rank-noble');
      }
    }
  }
}
