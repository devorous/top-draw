/**
 * @fileoverview Main UI Manager for handling DOM interactions, icons, and specialized sub-UI components.
 */
import { EditableValueHandler } from './EditableValueHandler.js';
import { RemoteUserUI } from './RemoteUserUI.js';
import { LayerPreview } from './LayerPreview.js';
import { ResizableSections } from './ResizableSections.js';
import { appState } from '../state.svelte.js';
import {
  DEFAULT_TEXT_FONT,
  ensureTextFontsLoaded,
  normalizeTextFont,
  TEXT_FONT_OPTIONS
} from '../config/textFonts.js';
import {
  DEFAULT_APPLIED_TEXT_OFFSET,
  DEFAULT_APPLIED_TEXT_SIZE_MULTIPLIER,
  getPreviewTextLayout
} from '../utils/textLayout.js';

import selectIconUrl from '../assets/icons/select-icon.svg';
import brushIconUrl from '../assets/icons/brush-icon.svg';
import lineIconUrl from '../assets/icons/line-icon.svg';
import rectangleIconUrl from '../assets/icons/rectangle-icon.svg';
import circleIconUrl from '../assets/icons/circle-icon.svg';
import textIconUrl from '../assets/icons/text-icon.svg';
import eraserIconUrl from '../assets/icons/eraser-icon.svg';
import circleBlurIconUrl from '../assets/icons/circle-blur-icon.svg';
import glitchIconUrl from '../assets/icons/glitch-icon.svg';
import inkdropperIconUrl from '../assets/icons/inkdropper-icon.svg';
import moveIconUrl from '../assets/icons/move-icon.svg';
import rotateIconUrl from '../assets/icons/rotate-icon.svg';
import pepperIconUrl from '../assets/icons/pepper.png';
import patternIconUrl from '../assets/icons/pattern-icon.svg';

const fillBucketIconUrl = '../images/fillbucket-icon.svg';
const blendIconUrl = '../images/blend-icon.svg';
const zoomIconUrl = '../images/magnifying-glass.svg';

/**
 * UI Manager class
 */
export class UI {
  constructor() {
    this.elements = {};
    this.svgCache = new Map(); // Initialize SVG cache
    this.icons = {}; // Will store references to cached SVG data or image elements
    this.cursors = new Map();
    this.editableHandler = new EditableValueHandler();
    this.remoteUserUI = null;
    this.layerPreview = new LayerPreview();
    this.resizableSections = null;
  }

  /**
   * Initializes the UI manager and its sub-components.
   */
  async init() { // Made init async
    this.cacheElements();
    await this._preloadSVGIcons(); // Await preloading of SVG icons
    this.remoteUserUI = new RemoteUserUI(this.elements, this.icons);
    this.layerPreview.init();
    this.setupScrollIndicator();
    this.initResizableSections();
    this.setupSidebarResizers();
    
    // Initial application from preferences
    if (window.app?.appPreferences) {
      this.applySidebarWidths(window.app.appPreferences);
    }
  }

  /**
   * Initializes resizable sections in the tool options panel
   */
  initResizableSections() {
    this.resizableSections = new ResizableSections('sidebarTop', [
      { id: 'userList', minHeight: 40, defaultHeight: 150, hasPersistentContent: true },
      { id: 'toolSliders', minHeight: 100, defaultHeight: 250, contentSelector: '.sliders' },
      { id: 'toolExtras', minHeight: 100, defaultHeight: 300 }
    ], {
      getContextKey: () => window.app?.self?.tool || 'default',
      sharedSectionIds: ['userList']
    });
  }

  /**
   * Setup sidebar and toolbar drag resizers.
   */
  setupSidebarResizers() {
    const { sidebarResizeHandle, toolsResizer } = this.elements;

    const setupResizer = (handle, cssVar, prefKey, min, max, isToolbar = false) => {
      if (!handle) return;

      let startX, startWidth;

      const onMouseMove = (e) => {
        const isLeft = document.documentElement.dataset.sidebarSide === 'left';
        let delta = e.clientX - startX;
        
        // If sidebar is on the right, dragging left (negative delta) increases width
        // If sidebar is on the left, dragging right (positive delta) increases width
        if (!isLeft) {
          delta = -delta;
        }
        
        const newWidth = Math.min(Math.max(startWidth + delta, min), max);
        document.documentElement.style.setProperty(cssVar, `${newWidth}px`);

        // Update preference in memory (save on mouseup)
        if (window.app?.appPreferences) {
          window.app.appPreferences.general[prefKey] = newWidth;
        }
      };

      const onMouseUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.documentElement.style.cursor = '';

        if (window.app?.appPreferences) {
          if (typeof window.app.setAppPreferences === 'function') {
            window.app.setAppPreferences(window.app.appPreferences);
          }
        }
      };

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        const currentStyle = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
        startWidth = parseInt(currentStyle, 10) || (isToolbar ? 48 : 200);
        
        handle.classList.add('dragging');
        document.body.classList.add('resizing');
        document.documentElement.style.cursor = 'col-resize';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    };

    setupResizer(sidebarResizeHandle, '--sidebar-width', 'sidebarWidth', 160, 600);
    setupResizer(toolsResizer, '--tools-width', 'toolsWidth', 32, 120, true);
  }

  /**
   * Apply sidebar and toolbar widths from preferences.
   * @param {Object} preferences - App preferences object
   */
  applySidebarWidths(preferences) {
    const sidebarWidth = preferences?.general?.sidebarWidth ?? 200;
    const toolsWidth = preferences?.general?.toolsWidth ?? 48;

    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
    document.documentElement.style.setProperty('--tools-width', `${toolsWidth}px`);
  }

  /**
   * Sets up the scroll indicators for resizable sections
   */
  setupScrollIndicator() {
    const sections = [
      { panel: 'toolSliders', indicator: 'toolSlidersScrollIndicator' },
      { panel: 'toolExtras', indicator: 'toolExtrasScrollIndicator' }
    ];

    sections.forEach(({ panel: panelId, indicator: indicatorId }) => {
      const panel = document.getElementById(panelId);
      const indicator = document.getElementById(indicatorId);

      if (!panel || !indicator) return;

      let scheduledUpdate = null;
      const updateScrollIndicator = () => {
        if (scheduledUpdate) return;

        scheduledUpdate = requestAnimationFrame(() => {
          scheduledUpdate = null;
          const hasScroll = panel.scrollHeight > panel.clientHeight;
          const scrollTop = panel.scrollTop;
          const isNearBottom = panel.scrollHeight - scrollTop <= panel.clientHeight + 20;

          // Show only when: has scroll, at top (not scrolled), and not at bottom
          const shouldShow = hasScroll && scrollTop < 10 && !isNearBottom;
          if (shouldShow) {
            indicator.classList.add('visible');
          } else {
            indicator.classList.remove('visible');
          }
        });
      };

      // Initial check
      updateScrollIndicator();

      // Update on scroll
      panel.addEventListener('scroll', updateScrollIndicator);

      // Update when window resizes or content changes
      const resizeObserver = new ResizeObserver(updateScrollIndicator);
      resizeObserver.observe(panel);

      // Also check after a short delay (for dynamic content)
      setTimeout(updateScrollIndicator, 500);
    });
  }

  refreshToolOptionsLayout(tool = window.app?.self?.tool) {
    this.resizableSections?.refreshLayout(tool || 'default');
  }

  /**
   * Setup hover listeners for layer buttons to show miniatures.
   * @param {LayerManager} layerManager - Reference to the layer system
   */
  setupLayerPreviewListeners(layerManager) {
    const layerButtons = document.querySelectorAll('.layerButton');
    layerButtons.forEach(btn => {
      btn.addEventListener('touchstart', () => {
        this.layerPreview._longPressTimer = setTimeout(() => {
          const layerIdx = parseInt(btn.dataset.layer);
          const rect = btn.getBoundingClientRect();
          this.layerPreview.show(layerIdx, layerManager, rect.right, rect.top + rect.height / 2);
        }, 400);
      }, { passive: true });

      btn.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        const layerIdx = parseInt(btn.dataset.layer);
        const rect = btn.getBoundingClientRect();
        this.layerPreview.show(layerIdx, layerManager, rect.right, rect.top + rect.height / 2);
      });

      btn.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'mouse') return;
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
      selfZoom: document.querySelector('.zoom.self'),
      selfMutedIndicator: document.querySelector('.mutedIndicator.self'),
      selfText: document.querySelector('.text.self'),
      selfTextInput: document.querySelector('.textInput.self'),
      selfName: document.querySelector('.name.self'),
      mirrorLine: document.querySelector('.mirrorLine'),

      panBtn: document.getElementById('panBtn'),
      zoomBtn: document.getElementById('zoomBtn'),
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
menuBtn: document.getElementById('menuBtn'),
      collapsibleBtns: document.getElementById('collapsibleBtns'),
      fullscreenBtn: document.getElementById('fullscreenBtn'),
      sidebarToggleBtn: document.getElementById('sidebarToggleBtn'),
      sideMenu: document.getElementById('sideMenu'),
      toolOptions: document.getElementById('toolOptions'),

      devBtn: null, // injected dynamically by Moderation._injectModUI()
      devText: null, // injected dynamically
      debugOverlay: document.getElementById('debugOverlay'),
      perfSettingsBtn: null, // injected dynamically by Moderation._injectModUI(),

      chatBtn: document.getElementById('chatBtn'),
      recordBtn: document.getElementById('recordBtn'),
      adminTopBtn: document.getElementById('adminTopBtn'),
      inboxBtn: document.getElementById('inboxBtn'),
      saveBtn: document.getElementById('saveBtn'),
      historyBtn: document.getElementById('historyBtn'),

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
      textPositionMultiplierValue: document.getElementById('textPositionMultiplierValue'),
      textPositionOffsetValue: document.getElementById('textPositionOffsetValue'),
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
      fontContainer: document.getElementById('font-container'),
      textPositionMultiplierContainer: document.getElementById('text-position-multiplier-container'),
      textPositionOffsetContainer: document.getElementById('text-position-offset-container'),

      selectionModeOptions: document.getElementById('selectionModeOptions'),
      eraserModeOptions: document.getElementById('eraserModeOptions'),
      inkdropperModeOptions: document.getElementById('inkdropperModeOptions'),
      inkdropperAutoSwitch: document.getElementById('inkdropperAutoSwitch'),
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
      thinningEnabled: document.getElementById('thinningEnabled'),
      thinningSlider: document.querySelector('.slider.thinning'),
      textPositionMultiplierSlider: document.querySelector('.slider.textPositionMultiplier'),
      textPositionOffsetSlider: document.querySelector('.slider.textPositionOffset'),
      thinningSliderContainer: document.getElementById('thinningSlider'),
      simulatePressureCheckbox: document.getElementById('simulatePressureCheckbox'),

      fontSelect: document.getElementById('font-select'),

      colorPicker: document.getElementById('colorPicker'),
      sidebarTop: document.getElementById('sidebarTop'),
      sidebarBottom: document.getElementById('sidebarBottom'),
      sidebarResizeHandle: document.getElementById('sidebarResizeHandle'),
      toolsResizer: document.getElementById('toolsResizer'),

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

      disconnectionBanner: document.getElementById('disconnectionBanner'),
      retryConnectionBtn: document.getElementById('retryConnectionBtn'),
      switchToOfflineBtn: document.getElementById('switchToOfflineBtn'),

      connectionStatus: document.getElementById('connectionStatus'),
      connectionDot: document.querySelector('.connectionDot'),
      connectionText: document.querySelector('.connectionText'),
      connectionRoom: document.getElementById('connectionRoom'),
      disconnectBtn: document.getElementById('disconnectBtn'),
      userContextMenu: document.getElementById('userContextMenu'),
      modPanel: null, // injected dynamically by Moderation._injectModUI()
      modBtn: null // injected dynamically by Moderation._injectModUI()
    };

    this._initializeFontSelect();
  }

  /**
   * Preloads all SVG tool icons and stores their content.
   */
  async _preloadSVGIcons() {
    const iconMap = {
      select: selectIconUrl,
      brush: brushIconUrl,
      pen: brushIconUrl, // Reuse brush icon
      flowPen: brushIconUrl, // Reuse brush icon
      ink: brushIconUrl, // Reuse brush icon
      line: lineIconUrl,
      rectangle: rectangleIconUrl,
      circle: circleIconUrl,
      text: textIconUrl,
      fill: fillBucketIconUrl,
      erase: eraserIconUrl,
      blur: blendIconUrl,
      circleBlur: circleBlurIconUrl,
      glitchBlur: glitchIconUrl,
      inkdropper: inkdropperIconUrl,
      pan: moveIconUrl,
      zoom: zoomIconUrl,
      rotate: rotateIconUrl,
      pattern: patternIconUrl,
      lockClosed: '../images/lock-closed.svg', // Preload from static assets
      lockOpen: '../images/lock-open.svg'
    };

    const fetchPromises = Object.entries(iconMap).map(async ([toolName, url]) => {
      if (url.endsWith('.svg')) {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Failed to fetch ${url}`);
          const svgContent = await response.text();
          this.svgCache.set(toolName, { type: 'svg', content: svgContent, originalUrl: url });
        } catch (error) {
          console.error(`Error preloading SVG for ${toolName} (${url}):`, error);
          // Fallback to image element if preloading fails
          const img = document.createElement('img');
          img.className = 'toolIcon';
          img.src = url;
          img.alt = '';
          this.svgCache.set(toolName, { type: 'img', element: img, originalUrl: url });
        }
      } else {
        // Handle non-SVG icons (e.g., PNG) by creating an img element directly
        const img = document.createElement('img');
        img.className = 'toolIcon';
        img.src = url;
        img.alt = '';
        this.svgCache.set(toolName, { type: 'img', element: img, originalUrl: url });
      }
    });

    // Handle pepperIconUrl separately as it's a PNG and not in the main iconMap
    const pepperImg = document.createElement('img');
    pepperImg.className = 'toolIcon';
    pepperImg.src = pepperIconUrl;
    pepperImg.alt = '';
    this.svgCache.set('imageBrush', { type: 'img', element: pepperImg, originalUrl: pepperIconUrl });


    await Promise.all(fetchPromises);

    // Populate this.icons with references to the cached data
    for (const [toolName, data] of this.svgCache.entries()) {
      this.icons[toolName] = data;
    }
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
    const zoom = this.elements.selfZoom;
    const mutedIndicator = this.elements.selfMutedIndicator;

    this._lastCursorX = x;
    this._lastCursorY = y;

    cursor.style.transform = `translate(${x - 100}px, ${y - 100}px)`;
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
    if (zoom) {
      zoom.setAttribute('transform', `translate(${x}, ${y})`);
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
   * @param {boolean} tabletDetected - Whether tablet/pen input has been detected
   */
  updatePressureCursorRadius(r, baseSize, tabletDetected = false) {
    const el = this.elements.selfPressureCircle;
    if (!el) return;

    // Only show inner circle if tablet is detected and pressure is less than full size
    if (tabletDetected && baseSize !== undefined && r < baseSize) {
      el.style.display = 'block';
      el.setAttribute('r', Math.max(1, r));
      // Only show dashed line if size is 8 or larger
      el.setAttribute('stroke-dasharray', baseSize >= 8 ? '3,2' : '0');
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * Updates the pressure-sensitive feedback square size.
   * @param {number} squareSize - Pressure-scaled half-width
   * @param {number} baseSize - Unscaled base size
   * @param {boolean} tabletDetected - Whether tablet/pen input has been detected
   */
  updatePressureSquareSize(squareSize, baseSize, tabletDetected = false) {
    const el = this.elements.selfPressureSquare;
    if (!el) return;

    // Only show inner square if tablet is detected and pressure is less than full size
    if (tabletDetected && baseSize !== undefined && squareSize < baseSize) {
      el.style.display = 'block';
      const sizeDoubled = Math.max(2, squareSize * 2);
      el.setAttribute('width', sizeDoubled);
      el.setAttribute('height', sizeDoubled);
      // Only show dashed line if size is 8 or larger
      el.setAttribute('stroke-dasharray', baseSize >= 8 ? '3,2' : '0');
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
   * Shows the hand cursor for temporary panning (e.g. spacebar held),
   * hiding whatever cursor shape was previously visible.
   */
  showPanCursor() {
    const { selfCircle, selfPressureCircle, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfZoom, selfText, selfName } = this.elements;
    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfText.style.display = 'none';
    selfName.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    selfHand.style.display = 'block';
  }

  showZoomCursor() {
    const { selfCircle, selfPressureCircle, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfZoom, selfText, selfName } = this.elements;
    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfText.style.display = 'none';
    selfName.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfHand) selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'block';
  }

  /**
   * Restores the cursor shape for the current tool after temporary panning ends.
   * @param {string} tool - The current tool name
   * @param {Object} [user=null] - The local user object
   */
  hidePanCursor(tool, user = null) {
    this.elements.selfName.style.display = '';
    this.updateToolDisplay(tool, user);
  }

  /**
   * Switches between crosshair and hand for the selection tool.
   * @param {boolean} isHand - Whether to show the hand icon
   */
  setSelectCursor(isHand) {
    if (isHand) {
      this.elements.selfCrosshair.style.display = 'none';
      this.elements.selfName.style.display = 'none';
      if (this.elements.selfZoom) this.elements.selfZoom.style.display = 'none';
      this.elements.selfHand.style.display = 'block';
    } else {
      this.elements.selfCrosshair.style.display = 'block';
      this.elements.selfName.style.display = '';
      this.elements.selfHand.style.display = 'none';
      if (this.elements.selfZoom) this.elements.selfZoom.style.display = 'none';
    }
  }

  /**
   * Temporarily force the local cursor to use the select-style crosshair.
   */
  showMirrorRegionCursor() {
    const {
      selfCircle,
      selfPressureCircle,
      selfSquare,
      selfPressureSquare,
      selfCrosshair,
      selfHand,
      selfZoom,
      selfText
    } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'block';
    selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    selfText.style.display = 'none';
    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
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
      selfCircle, selfPressureCircle, selfSquare, selfPressureSquare, selfCrosshair, selfHand, selfZoom, selfText, selfName,
      brushImage, brushFileInput, sizeContainer, pressureContainer, smoothingContainer,
      brushSpacing, brushHardness, opacityContainer, blurRadiusContainer,
      selectionModeOptions, eraserModeOptions, inkdropperModeOptions, brushModeOptions, circleBlurModeOptions, fillModeOptions, patternModeOptions, fontContainer, textPositionMultiplierContainer, textPositionOffsetContainer
    } = this.elements;

    selfCircle.style.display = 'none';
    selfSquare.style.display = 'none';
    selfCrosshair.style.display = 'none';
    selfHand.style.display = 'none';
    if (selfZoom) selfZoom.style.display = 'none';
    selfText.style.display = 'none';
    brushImage.style.display = 'none';
    brushFileInput.style.display = 'none';
    brushSpacing.style.display = 'none';
    brushHardness.style.display = 'none';
    if (fontContainer) fontContainer.style.display = 'none'; // Hide by default
    if (textPositionMultiplierContainer) textPositionMultiplierContainer.style.display = 'none';
    if (textPositionOffsetContainer) textPositionOffsetContainer.style.display = 'none';

    sizeContainer.style.display = 'block';
    pressureContainer.style.display = 'block';
    smoothingContainer.style.display = 'block';
    opacityContainer.style.display = 'block';

    if (blurRadiusContainer) blurRadiusContainer.style.display = 'none';
    if (selectionModeOptions) selectionModeOptions.style.display = 'none';
    if (eraserModeOptions) eraserModeOptions.style.display = 'none';
    if (inkdropperModeOptions) inkdropperModeOptions.style.display = 'none';
    if (brushModeOptions) brushModeOptions.style.display = 'none';
    if (circleBlurModeOptions) circleBlurModeOptions.style.display = 'none';
    if (this.elements.fillModeOptions) this.elements.fillModeOptions.style.display = 'none';
    if (patternModeOptions) patternModeOptions.style.display = 'none';
    if (this.elements.inkThinningContainer) this.elements.inkThinningContainer.style.display = 'none';
    appState.patternPreviewVisible = false;
    
    const { blendModeOptions } = this.elements;
    if (blendModeOptions) {
      const layerManager = window.app?.board?.layerManager;
      const activeLayer = window.app?.self?.activeLayer ?? 0;
      const allowComplex = layerManager ? layerManager.getLayerAllowComplexBlendModes(activeLayer) : true;
      blendModeOptions.style.display = (this.toolSupportsBlendMode(tool) && allowComplex) ? 'block' : 'none';
    }

    if (selfPressureCircle) selfPressureCircle.style.display = 'none';
    if (selfPressureSquare) selfPressureSquare.style.display = 'none';
    if (selfName) selfName.style.display = (tool === 'pan' || tool === 'zoom') ? 'none' : '';

    switch (tool) {
      case 'select':
        selfCrosshair.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        if (selectionModeOptions) selectionModeOptions.style.display = 'block';
        {
          const selectTool = window.app?.toolManager?.getTool('select');
          if (selectTool?.patternMode) appState.patternPreviewVisible = true;
        }
        break;

      case 'brush':
      case 'flowPen':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
        break;

      case 'ink':
        selfCircle.style.display = 'block';
        brushHardness.style.display = 'block';
        if (brushModeOptions) brushModeOptions.style.display = 'block';
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
        if (fontContainer) fontContainer.style.display = 'block'; // Show font dropdown
        // Keeping the text tuning controls dormant for now.
        // if (textPositionMultiplierContainer) textPositionMultiplierContainer.style.display = 'block';
        // if (textPositionOffsetContainer) textPositionOffsetContainer.style.display = 'block';
        if (user) {
          this.updateFontSelect(user.font);
          this.updateTextPositionMultiplierValue(user.textPositionMultiplier);
          this.updateTextPositionOffsetValue(user.textPositionOffset);
        }
        break;

      case 'erase':
        selfCircle.style.display = 'block';
        opacityContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        brushHardness.style.display = 'none';
        if (eraserModeOptions) eraserModeOptions.style.display = 'block';
        break;

      case 'circleBlur':
        selfCircle.style.display = 'block';
        brushSpacing.style.display = 'block';
        brushHardness.style.display = 'block';
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
        break;

      case 'pattern':
        if (user && user.patternShape === 'square') {
          selfSquare.style.display = 'block';
        } else {
          selfCircle.style.display = 'block';
        }
        brushSpacing.style.display = 'none';
        smoothingContainer.style.display = 'none';
        if (patternModeOptions) patternModeOptions.style.display = 'block';
        appState.patternPreviewVisible = true;
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
        {
          const fillTool = window.app?.toolManager?.getTool('fill');
          if (fillTool?.patternMode) appState.patternPreviewVisible = true;
        }
        break;

      case 'inkdropper':
        selfCrosshair.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        if (inkdropperModeOptions) inkdropperModeOptions.style.display = 'block';
        break;

      case 'pan':
        selfHand.style.display = 'block';
        sizeContainer.style.display = 'none';
        pressureContainer.style.display = 'none';
        smoothingContainer.style.display = 'none';
        opacityContainer.style.display = 'none';
        break;

      case 'zoom':
        if (selfZoom) selfZoom.style.display = 'block';
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
    this.refreshToolOptionsLayout(tool);
  }

  /**
   * Check if a tool supports blend modes.
   * @param {string} tool - Tool name
   * @returns {boolean}
   */
  toolSupportsBlendMode(tool) {
    const noBlendTools = ['erase', 'select', 'pan', 'zoom', 'rotate', 'inkdropper'];
    return !noBlendTools.includes(tool);
  }

  /**
   * Updates the selected state of tool buttons in the toolbar.
   * @param {string} tool - Selected tool name
   */
  updateToolButton(tool) {
    const buttons = {
      pan: this.elements.panBtn,
      zoom: this.elements.zoomBtn,
      rotate: this.elements.rotateBtn,
      select: this.elements.selectBtn,
      brush: this.elements.brushBtn,
      pixel: this.elements.brushBtn,
      line: this.elements.lineBtn,
      rectangle: this.elements.rectangleBtn,
      circle: this.elements.circleBtn,
      text: this.elements.textBtn,
      fill: this.elements.fillBtn,
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

    const toolIconData = this.icons[tool]; // Renamed to avoid confusion with the DOM element

    if (toolIconData) {
      const toolEntry = this.elements.selfListTool;
      if (toolEntry.children[0]) {
        toolEntry.children[0].remove();
      }

      if (toolIconData.type === 'svg') {
        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'toolIcon'; // Apply class for consistent styling
        svgWrapper.innerHTML = toolIconData.content;
        toolEntry.appendChild(svgWrapper);
      } else if (toolIconData.type === 'img') {
        toolEntry.appendChild(toolIconData.element.cloneNode(true)); // Clone the pre-created img element
      }
    }
  }

  /**
   * Updates the zoom percentage display.
   * @param {string} percent - Zoom percentage text
   */
  updateZoomDisplay(percent) {
    this.elements.zoomPercent.textContent = percent;
    if (this._hideOwnLabelZoom) {
      const zoomValue = parseInt(percent, 10);
      this.elements.selfCursor?.classList.toggle('zoom-hide-name', zoomValue > 150);
    }
  }

  setHideOwnLabelZoom(enabled) {
    this._hideOwnLabelZoom = !!enabled;
    if (!enabled) {
      this.elements.selfCursor?.classList.remove('zoom-hide-name');
    } else {
      const zoomValue = parseInt(this.elements.zoomPercent?.textContent ?? '100', 10);
      this.elements.selfCursor?.classList.toggle('zoom-hide-name', zoomValue > 150);
    }
  }

  /**
   * Updates the mirror line toggle display.
   * @param {boolean} enabled - Whether mirror is enabled
   */
  updateMirrorDisplay(enabled) {
    const mirrorModeActive = !!window.app?.mirrorRegionController?.isActive?.();
    this.elements.mirrorBtn?.classList.toggle('selected', !!enabled || mirrorModeActive);
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
      this.refreshToolOptionsLayout(tool);
      return false;
    } else {
      section.style.display = 'none';
      this.refreshToolOptionsLayout(tool);
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

  setSelfUserMuted(muted) {
    const entry = this.elements.selfUserEntry;
    const userEl = this.elements.selfListUser;
    if (entry) entry.classList.toggle('muted', !!muted);
    if (userEl) userEl.classList.toggle('muted', !!muted);
  }

  /**
   * Updates the local tool icon in the user list.
   * @param {string} tool - Current tool name
   */
  updateSelfToolIcon(tool) {
    const { selfListTool } = this.elements;
    if (selfListTool) {
      selfListTool.innerHTML = '';
      const iconData = this.icons[tool] || this.icons.brush; // Use iconData to avoid confusion with DOM element

      if (iconData.type === 'svg') {
        const svgWrapper = document.createElement('div');
        svgWrapper.className = 'toolIcon'; // Apply class for consistent styling
        svgWrapper.innerHTML = iconData.content;
        selfListTool.appendChild(svgWrapper);
      } else if (iconData.type === 'img') {
        selfListTool.appendChild(iconData.element.cloneNode(true)); // Clone the pre-created img element
      }
    }
  }

  /**
   * Updates the local floating text cursor style.
   * @param {number} size - Font size
   * @param {Array} color - [r, g, b, a] color array
   * @param {string} font - CSS font-family string
   */
  updateSelfTextStyle(size, color, font) {
    const layout = getPreviewTextLayout({
      size,
      x: 0,
      y: 0
    });
    this.elements.selfText.style.fontSize = `${layout.fontSize}px`;
    const [r, g, b, a] = color;
    this.elements.selfText.style.color = `rgba(${r}, ${g}, ${b}, ${a * a})`;
    this.elements.selfText.style.fontFamily = normalizeTextFont(font);
    if (this.elements.selfTextInput) {
      this.elements.selfTextInput.style.fontFamily = normalizeTextFont(font);
    }
    this.elements.selfText.style.left = `${layout.domLeft}px`;
    this.elements.selfText.style.top = `${layout.domTop}px`;
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
      // Display whole numbers for sizes >= 4, keep decimals below 4
      const displaySize = size >= 4 ? Math.round(size) : size;
      this.elements.sizeValue.textContent = displaySize;
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
    if (this.elements.thinningEnabled) {
      this.elements.thinningEnabled.checked = simulate;
      // Update visibility to match checkbox state
      if (this.elements.thinningSliderContainer) {
        this.elements.thinningSliderContainer.style.display = simulate ? '' : 'none';
      }
      if (this.elements.thinningValue) {
        this.elements.thinningValue.style.display = simulate ? '' : 'none';
      }
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
    
    // Use preloaded SVG content from cache
    const cachedIcon = locked ? this.svgCache.get('lockClosed') : this.svgCache.get('lockOpen');
    if (cachedIcon && cachedIcon.type === 'svg') {
      btn.innerHTML = cachedIcon.content;
    } else {
      // Fallback
      btn.innerHTML = locked ? '<img src="../images/lock-closed.svg" alt="lock">' : '<img src="../images/lock-open.svg" alt="unlock">';
    }

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

  /**
   * Attaches an event listener to the font selection dropdown.
   * @param {App} app - Reference to the main App instance
   */
  attachFontChangeListener(app) {
    this.elements.fontSelect?.addEventListener('change', (e) => {
      this._applyFontSelectStyle(e.target.value);
      app.handleFontChange(e.target.value);
    });
  }

  /**
   * Updates the selected font in the dropdown.
   * @param {string} font - The font family string to set as selected
   */
  updateFontSelect(font) {
    if (this.elements.fontSelect) {
      const normalizedFont = normalizeTextFont(font);
      this.elements.fontSelect.value = normalizedFont;
      this._applyFontSelectStyle(normalizedFont);
    }
  }

  updateRemoteFont(userId, font) {
    return this.remoteUserUI.updateRemoteFont(userId, font);
  }

  updateRemoteTextLayout(userId, user) {
    return this.remoteUserUI.updateRemoteTextLayout(userId, user);
  }

  updateTextPositionMultiplierValue(multiplier) {
    if (this.elements.textPositionMultiplierValue) {
      this.elements.textPositionMultiplierValue.textContent = Number(multiplier).toFixed(2);
    }
    if (this.elements.textPositionMultiplierSlider) {
      this.elements.textPositionMultiplierSlider.value = Number(multiplier);
    }
  }

  updateTextPositionOffsetValue(offset) {
    if (this.elements.textPositionOffsetValue) {
      const rounded = Math.round(Number(offset) * 100) / 100;
      this.elements.textPositionOffsetValue.textContent = rounded;
    }
    if (this.elements.textPositionOffsetSlider) {
      this.elements.textPositionOffsetSlider.value = Number(offset);
    }
  }

  _initializeFontSelect() {
    const select = this.elements.fontSelect;
    if (!select) return;

    ensureTextFontsLoaded(document);
    select.innerHTML = '';

    TEXT_FONT_OPTIONS.forEach(font => {
      const option = document.createElement('option');
      option.value = font.family;
      option.textContent = font.label;
      option.style.fontFamily = font.family;
      option.style.fontSize = `${font.pickerFontSize ?? 12}px`;
      select.appendChild(option);
    });

    select.value = DEFAULT_TEXT_FONT;
    this._applyFontSelectStyle(DEFAULT_TEXT_FONT);
  }

  _applyFontSelectStyle(font) {
    const select = this.elements.fontSelect;
    if (!select) return;

    const normalizedFont = normalizeTextFont(font);
    const fontOption = TEXT_FONT_OPTIONS.find(option => option.family === normalizedFont);
    select.style.fontFamily = normalizedFont;
    select.style.fontSize = `${fontOption?.pickerFontSize ?? 12}px`;
  }

  hideRemoteCursor(userId) {
    return this.remoteUserUI.hideRemoteCursor(userId);
  }

  showRemoteCursor(userId) {
    return this.remoteUserUI.showRemoteCursor(userId);
  }

  markRemoteCursorActivity(userId) {
    return this.remoteUserUI.markRemoteCursorActivity(userId);
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
      if (btn) btn.title = isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar';
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
      if (btn) btn.title = collapsed ? 'Expand Sidebar' : 'Collapse Sidebar';
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

  setRemoteUserMuted(userId, muted) {
    return this.remoteUserUI.setRemoteUserMuted(userId, muted);
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
   * Shows the disconnection warning banner.
   */
  showDisconnectionBanner() {
    const { disconnectionBanner } = this.elements;
    console.log('[UI] showDisconnectionBanner called', { exists: !!disconnectionBanner });
    if (!disconnectionBanner) {
      console.error('[UI] disconnectionBanner element not found in DOM!');
      return;
    }

    disconnectionBanner.classList.add('show');
    this.setRetryButtonState(false); // Reset to normal state
    console.log('[UI] Banner should now be visible');
  }

  /**
   * Hides the disconnection warning banner.
   */
  hideDisconnectionBanner() {
    const { disconnectionBanner } = this.elements;
    if (!disconnectionBanner) return;

    disconnectionBanner.classList.remove('show');
    this.setRetryButtonState(false); // Reset state when hiding
  }

  /**
   * Sets the retry button to loading or normal state.
   * @param {boolean} isRetrying - Whether currently retrying
   */
  setRetryButtonState(isRetrying) {
    const { retryConnectionBtn } = this.elements;
    if (!retryConnectionBtn) return;

    if (isRetrying) {
      retryConnectionBtn.textContent = 'Retrying...';
      retryConnectionBtn.disabled = true;
      retryConnectionBtn.classList.add('loading');
    } else {
      retryConnectionBtn.textContent = 'Retry Connection';
      retryConnectionBtn.disabled = false;
      retryConnectionBtn.classList.remove('loading');
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
   * @param {number} role - Role level (0-9)
   */
  updateSelfRole(role) {
    const el = this.elements.selfListUser;
    if (!el) return;

    // Remove all possible rank classes
    const rankClasses = ['rank-guest', 'rank-user', 'rank-helper', 'rank-mod', 'rank-admin', 'rank-noble', 'rank-holy', 'rank-deity'];
    el.classList.remove(...rankClasses);

    const roleClass = RemoteUserUI.roleToClass(role);
    if (roleClass) {
      el.classList.add(roleClass);
    }

    // Also update the self userEntry glow
    const entry = el.closest('.userEntry');
    if (entry) {
      entry.classList.remove(...rankClasses);
      // Only apply row glow for Noble+
      if (role >= 7 && roleClass) {
        entry.classList.add(roleClass);
      }
    }
  }

  /**
   * Updates a remote user's rank styling in the user list.
   * @param {number} sessionIndex
   * @param {number} role - Role level (0-9)
   */
  updateRemoteUserRank(sessionIndex, role) {
    const id = `u${sessionIndex}`;
    const rankClasses = ['rank-guest', 'rank-user', 'rank-helper', 'rank-mod', 'rank-admin', 'rank-noble', 'rank-holy', 'rank-deity'];

    const roleClass = RemoteUserUI.roleToClass(role);

    const listUser = document.querySelector(`.listUser.${id}`);
    if (listUser) {
      listUser.classList.remove(...rankClasses);
      if (roleClass) {
        listUser.classList.add(roleClass);
      }
    }

    const entry = document.querySelector(`.userEntry.${id}`);
    if (entry) {
      entry.classList.remove(...rankClasses);
      // Only apply row glow for Noble+
      if (role >= 7 && roleClass) {
        entry.classList.add(roleClass);
      }
    }
  }
}
