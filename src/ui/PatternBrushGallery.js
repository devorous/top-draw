/**
 * @fileoverview Pattern Brush Gallery - selects the image used for the grid pattern.
 */
import { BrushGallery } from './BrushGallery.js';

export class PatternBrushGallery extends BrushGallery {
  constructor(options = {}) {
    super({ ...options, kind: 'pattern', includeGih: false });
    this.brushListEl = null;
  }

  init() {
    this.galleryEl = null;
    this.brushListEl = document.getElementById('patternBrushList');
    this.fillBrushListEl = document.getElementById('fillPatternBrushList');
    this.selectionBrushListEl = document.getElementById('selectionPatternBrushList');
    this.listElements = [this.brushListEl, this.fillBrushListEl, this.selectionBrushListEl].filter(Boolean);

    if (!this.brushListEl) {
      console.warn('Pattern brush list element not found');
      return;
    }

    this.renderUploadTile();
    this._initDefaultShapes();
    this.initHeaderActions();
    this.loadBrushes();
  }

  _initDefaultShapes() {
    // Circle brush
    const circleBrush = {
      type: 'svg',
      brushName: 'Circle',
      gimpUrl: this._createDefaultIcon('circle')
    };
    const circleImg = new Image();
    circleImg.src = circleBrush.gimpUrl;
    circleBrush.image = circleImg;
    this.registerBrush({
      ...circleBrush,
      id: 'builtin:pattern:circle',
      source: 'builtin',
      kind: this.kind,
      // After pepper (order 0) in the flat list; these register before the
      // manifest loads, so the order has to be explicit.
      order: 1
    });

    // Square brush
    const squareBrush = {
      type: 'svg',
      brushName: 'Square',
      gimpUrl: this._createDefaultIcon('square')
    };
    const squareImg = new Image();
    squareImg.src = squareBrush.gimpUrl;
    squareBrush.image = squareImg;
    this.registerBrush({
      ...squareBrush,
      id: 'builtin:pattern:square',
      source: 'builtin',
      kind: this.kind,
      order: 2
    });
  }

  shouldIncludeManifestEntry(entry) {
    // Pinned dot/square belong to the image brush gallery; the pattern
    // gallery already provides its own built-in circle and square.
    if (entry.pinned) return false;
    return super.shouldIncludeManifestEntry(entry);
  }

  _createDefaultIcon(shape) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(400, 400, 360, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(40, 40, 720, 720);
    }
    return canvas.toDataURL('image/png');
  }

  addBrushToGallery(brush) {
    super.addBrushToGallery(brush);
    if (brush.brushName === 'Circle' && !this.selectedBrush) {
      const defaultItem = this.brushListEl?.querySelector(`.brushItem[data-asset-id="${brush.id}"]`);
      if (defaultItem) {
        this.selectBrush(brush, defaultItem);
      }
    }
  }

  getBuiltinAssetCount() {
    return super.getBuiltinAssetCount() + 2;
  }



  _folderGroupId(brush) {
    // Keep circle and square in the main list, not in a folder
    if (brush?.id === 'builtin:pattern:circle' || brush?.id === 'builtin:pattern:square') {
      return null;
    }
    return super._folderGroupId(brush);
  }

  /**
   * Override selectBrush to handle all three galleries (pattern, fill pattern, selection pattern).
   * @param {Object} brush - Brush data object
   * @param {HTMLElement} itemEl - The gallery item element that was clicked
   */
  selectBrush(brush, itemEl) {
    this._clearSelectionInAllGalleries();

    itemEl.classList.add('selected');
    this.selectedBrush = brush;

    this.onSelect(brush);
  }
}
