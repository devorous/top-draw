/**
 * @fileoverview Pattern Brush Gallery - selects the image used for the grid pattern.
 */
import { BrushGallery } from './BrushGallery.js';

export class PatternBrushGallery extends BrushGallery {
  constructor(options = {}) {
    super(options);
    this.brushListEl = null;
  }

  init() {
    this.galleryEl = null;
    this.brushListEl = document.getElementById('patternBrushList');
    this.fillBrushListEl = document.getElementById('fillPatternBrushList');
    this.selectionBrushListEl = document.getElementById('selectionPatternBrushList');

    if (!this.brushListEl) {
      console.warn('Pattern brush list element not found');
      return;
    }

    this._initDefaultShapes();
    this.loadBrushes();
  }

  async loadBrushes() {
    try {
      // Fetch from public/brushes/manifest.json (served by Vite)
      const response = await fetch('/brushes/manifest.json');
      if (!response.ok) throw new Error('Failed to fetch brushes');
      
      const manifest = await response.json();
      if (!manifest.brushes) return;

      for (const entry of manifest.brushes) {
        if (entry.file.endsWith('.gih')) continue;

        try {
          const brush = await this.loadBrush(`/brushes/${entry.file}`);
          if (brush) {
            this.brushes.push(brush);
            this.addBrushToGallery(brush);
          }
        } catch (err) {
          console.warn(`Failed to load brush: ${entry.file}`, err);
        }
      }
    } catch (err) {
      console.warn('Failed to load brush manifest:', err);
    }
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
    this.brushes.push(circleBrush);
    this.addBrushToGallery(circleBrush);

    // Square image
    const squareBrush = {
      type: 'image',
      brushName: 'Square',
      gimpUrl: this._createDefaultIcon('square')
    };
    const squareImg = new Image();
    squareImg.src = squareBrush.gimpUrl;
    squareBrush.image = squareImg;
    this.brushes.push(squareBrush);
    this.addBrushToGallery(squareBrush);

  }

  _createDefaultIcon(shape) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ccc';
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
    const item = document.createElement('div');
    item.className = 'brushItem';
    item.title = brush.brushName || brush.name || brush.fileName;

    const img = document.createElement('img');
    img.src = brush.gimpUrl;
    img.alt = brush.brushName || brush.name || 'Brush';

    item.appendChild(img);
    item.addEventListener('click', () => this.selectBrush(brush, item));
    this.brushListEl.appendChild(item);

    // Also add to fill pattern brush list if it exists
    if (this.fillBrushListEl) {
      const fillItem = document.createElement('div');
      fillItem.className = 'brushItem';
      fillItem.title = brush.brushName || brush.name || brush.fileName;

      const fillImg = document.createElement('img');
      fillImg.src = brush.gimpUrl;
      fillImg.alt = brush.brushName || brush.name || 'Brush';

      fillItem.appendChild(fillImg);
      fillItem.addEventListener('click', () => this.selectBrush(brush, fillItem));
      this.fillBrushListEl.appendChild(fillItem);
    }

    // Also add to selection pattern brush list if it exists
    if (this.selectionBrushListEl) {
      const selectionItem = document.createElement('div');
      selectionItem.className = 'brushItem';
      selectionItem.title = brush.brushName || brush.name || brush.fileName;

      const selectionImg = document.createElement('img');
      selectionImg.src = brush.gimpUrl;
      selectionImg.alt = brush.brushName || brush.name || 'Brush';

      selectionItem.appendChild(selectionImg);
      selectionItem.addEventListener('click', () => this.selectBrush(brush, selectionItem));
      this.selectionBrushListEl.appendChild(selectionItem);
    }

    // Default selection
    if (brush.brushName === 'Circle' && !this.selectedBrush) {
      this.selectBrush(brush, item);
    }
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
