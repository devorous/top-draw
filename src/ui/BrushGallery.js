/**
 * @fileoverview Brush Gallery - loads and displays GIMP or image brushes from the brushes folder.
 */
import { parseGbr, parseGih } from '../utils/parseGimp.js';
import { BRUSH_MANIFEST } from './brushManifest.js';

/**
 * BrushGallery class
 */
export class BrushGallery {
  /**
   * @param {Object} [options={}] - Configuration options
   */
  constructor(options = {}) {
    this.brushListEl = null;
    this.galleryEl = null;
    this.brushes = [];
    this.selectedBrush = null;
    this.onSelect = options.onSelect || (() => {});
  }

  /**
   * Initializes the brush gallery by setting up DOM references and loading brushes.
   */
  init() {
    this.galleryEl = document.getElementById('brushGallery');
    this.brushListEl = document.getElementById('brushList');

    if (!this.brushListEl) {
      console.warn('Brush gallery elements not found');
      return;
    }

    this.loadBrushes();
  }

  /**
   * Loads brush files from the checked-in manifest.
   * @returns {Promise<void>}
   */
  async loadBrushes() {
    try {
      for (const entry of BRUSH_MANIFEST) {
        try {
          const brushPath = entry.path || `/brushes/${entry.file}`;
          const brush = await this.loadBrush(brushPath, entry.file);
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

  /**
   * Loads a single brush file and parses its content.
   * @param {string} filePath - Path to the brush file
   * @returns {Promise<Object|null>} - Parsed brush data or null
   */
  async loadBrush(filePath, hintFileName) {
    const response = await fetch(filePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filePath}`);
    }

    const fileName = hintFileName || filePath.split('/').pop();
    const fileType = fileName.split('.').pop().toLowerCase();

    let brushData = null;

    if (fileType === 'gbr') {
      const arrayBuffer = await response.arrayBuffer();
      brushData = parseGbr(arrayBuffer);
      if (brushData) {
        brushData.type = 'gbr';
        brushData.fileName = fileName;
        const image = new Image();
        image.src = brushData.gimpUrl;
        brushData.image = image;
      }
    } else if (fileType === 'gih') {
      const arrayBuffer = await response.arrayBuffer();
      brushData = parseGih(arrayBuffer);
      if (brushData) {
        brushData.type = 'gih';
        brushData.fileName = fileName;
        const images = brushData.gBrushes.map(brush => {
          const img = new Image();
          img.src = brush.gimpUrl;
          return img;
        });
        brushData.images = images;
      }
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(fileType)) {
      const blob = await response.blob();
      const imageUrl = URL.createObjectURL(blob);

      brushData = {
        type: 'image',
        fileName: fileName,
        imageFormat: fileType,
        brushName: fileName.replace(/\.[^/.]+$/, ''),
        gimpUrl: imageUrl,
        width: 0,
        height: 0
      };

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => {
          brushData.width = image.width;
          brushData.height = image.height;
          resolve();
        };
        image.onerror = reject;
        image.src = imageUrl;
      });
      brushData.image = image;
    } else if (fileType === 'svg') {
      const svgText = await response.text();
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
      const previewUrl = URL.createObjectURL(svgBlob);
      brushData = {
        type: 'svg',
        fileName: fileName,
        brushName: fileName.replace(/\.[^/.]+$/, ''),
        gimpUrl: filePath,
        previewUrl: previewUrl,
        svgContent: svgText,
        width: 0,
        height: 0
      };

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => {
          brushData.width = image.naturalWidth || image.width;
          brushData.height = image.naturalHeight || image.height;
          resolve();
        };
        image.onerror = () => {
          URL.revokeObjectURL(previewUrl);
          reject(new Error(`Failed to load SVG brush ${fileName}`));
        };
        image.src = previewUrl;
      });
      brushData.image = image;
    }

    return brushData;
  }

  /**
   * Adds a brush item to the gallery UI.
   * @param {Object} brush - Brush data object
   */
  addBrushToGallery(brush) {
    const item = document.createElement('div');
    item.className = 'brushItem';
    item.title = brush.brushName || brush.name || brush.fileName;

    const img = document.createElement('img');
    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      img.src = brush.gBrushes[0].gimpUrl;
    } else if (brush.type === 'image' || brush.type === 'gbr') {
      img.src = brush.gimpUrl;
    } else {
      img.src = brush.previewUrl || brush.gimpUrl;
    }
    img.alt = brush.brushName || brush.name || 'Brush';

    item.appendChild(img);

    item.addEventListener('click', () => {
      this.selectBrush(brush, item);
    });

    this.brushListEl.appendChild(item);
  }

  /**
   * Selects a brush in the gallery.
   * @param {Object} brush - Brush data object
   * @param {HTMLElement} itemEl - The gallery item element
   */
  selectBrush(brush, itemEl) {
    const prevSelected = this.brushListEl.querySelector('.brushItem.selected');
    if (prevSelected) {
      prevSelected.classList.remove('selected');
    }

    itemEl.classList.add('selected');
    this.selectedBrush = brush;

    this.onSelect(brush);
  }

  /**
   * Shows the brush gallery.
   */
  show() {
    if (this.galleryEl) {
      this.galleryEl.style.display = 'block';
      window.app?.ui?.refreshToolOptionsLayout?.(window.app?.self?.tool);
    }
  }

  /**
   * Hides the brush gallery.
   */
  hide() {
    if (this.galleryEl) {
      this.galleryEl.style.display = 'none';
      window.app?.ui?.refreshToolOptionsLayout?.(window.app?.self?.tool);
    }
  }

  /**
   * Gets the currently selected brush.
   * @returns {Object|null} - Selected brush data
   */
  getSelectedBrush() {
    return this.selectedBrush;
  }
}
