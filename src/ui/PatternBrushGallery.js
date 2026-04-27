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
    // Circle image
    const circleBrush = {
      type: 'image',
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
      kind: this.kind
    });

    // Square image
    const squareBrush = {
      type: 'image',
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
      kind: this.kind
    });

  }

  _createDefaultIcon(shape) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(20, 20, 18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(2, 2, 36, 36);
    }
    return canvas.toDataURL();
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

  /**
   * Override selectBrush to handle all three galleries (pattern, fill pattern, selection pattern).
   * @param {Object} brush - Brush data object
   * @param {HTMLElement} itemEl - The gallery item element that was clicked
   */
  selectBrush(brush, itemEl) {
    // Clear selection from all three galleries
    if (this.brushListEl) {
      const prevSelected = this.brushListEl.querySelector('.brushItem.selected');
      if (prevSelected) prevSelected.classList.remove('selected');
    }
    if (this.fillBrushListEl) {
      const prevSelected = this.fillBrushListEl.querySelector('.brushItem.selected');
      if (prevSelected) prevSelected.classList.remove('selected');
    }
    if (this.selectionBrushListEl) {
      const prevSelected = this.selectionBrushListEl.querySelector('.brushItem.selected');
      if (prevSelected) prevSelected.classList.remove('selected');
    }

    // Add selection to the clicked item
    itemEl.classList.add('selected');
    this.selectedBrush = brush;

    // Call onSelect callback
    this.onSelect(brush);
  }
}
