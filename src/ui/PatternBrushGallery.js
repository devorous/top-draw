/**
 * @fileoverview Pattern Brush Gallery - selects the image used for the grid pattern.
 */
import { BrushGallery } from './BrushGallery.js';
import { BRUSH_MANIFEST } from './brushManifest.js';

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
      for (const entry of BRUSH_MANIFEST) {
        if (entry.file.endsWith('.gih')) continue;

        try {
          const brushPath = entry.path || `/brushes/${entry.file}`;
          const brush = await this.loadBrush(brushPath);
          if (brush) {
            this.brushes.push(brush);
            this.addBrushToGallery(brush);
          }
        } catch (err) {
          console.warn(`Failed to load brush: ${entry.file}`, err);
        }
      }
    } catch (err) {
      console.warn('Failed to load brushes:', err);
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
    const createGalleryItem = (brush) => {
      const item = document.createElement('div');
      item.className = 'brushItem';
      item.title = brush.brushName || brush.name || brush.fileName;

      if (brush.svgContent) {
        // If SVG content is available, inject it directly
        item.innerHTML = brush.svgContent;
        // Optionally, you might want to size the SVG or its container
        item.style.width = '40px'; // Example size, adjust as needed
        item.style.height = '40px';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'center';
      } else {
        // Fallback for non-SVG brushes (or if svgContent isn't available)
        const img = document.createElement('img');
        img.src = brush.gimpUrl;
        img.alt = brush.brushName || brush.name || 'Brush';
        item.appendChild(img);
      }

      item.addEventListener('click', () => this.selectBrush(brush, item));
      return item;
    };

    const item = createGalleryItem(brush);
    this.brushListEl.appendChild(item);

    // Also add to fill pattern brush list if it exists
    if (this.fillBrushListEl) {
      const fillItem = createGalleryItem(brush);
      this.fillBrushListEl.appendChild(fillItem);
    }

    // Also add to selection pattern brush list if it exists
    if (this.selectionBrushListEl) {
      const selectionItem = createGalleryItem(brush);
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
