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

    if (!this.brushListEl) {
      console.warn('Pattern brush list element not found');
      return;
    }

    this._initDefaultShapes();
    this.loadBrushes();
  }

  async loadBrushes() {
    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      const response = await fetch(`${apiBase}/api/brushes`);
      if (!response.ok) throw new Error('Failed to fetch brushes');

      const manifest = await response.json();
      if (!manifest.brushes) return;

      for (const entry of manifest.brushes) {
        if (entry.file.endsWith('.gih')) continue;

        try {
          const brush = await this.loadBrush(`${apiBase}/brushes/${entry.file}`);
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

    // Pepper preset
    const apiBase = import.meta.env.VITE_API_BASE_URL || '';
    this.loadBrush(`${apiBase}/brushes/pepper.gbr`).then(brush => {
      if (brush) {
        this.brushes.push(brush);
        this.addBrushToGallery(brush);
      }
    }).catch(err => console.warn('Failed to load pepper preset:', err));
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

    // Default selection
    if (brush.brushName === 'Circle' && !this.selectedBrush) {
      this.selectBrush(brush, item);
    }
  }
}
