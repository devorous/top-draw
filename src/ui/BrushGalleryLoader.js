/**
 * BrushGalleryLoader
 *
 * Lazy-loads BrushGallery and parseGimp.js only when first shown.
 * This keeps ~40 KB of brush parsing code out of initial bundle.
 */

export class BrushGalleryLoader {
  constructor(options = {}) {
    this.options = options;
    this.realGallery = null;
    this.loadingPromise = null;
    this.galleryEl = null;
  }

  init() {
    // Store reference to gallery element but don't load brushes yet
    this.galleryEl = document.getElementById('brushGallery');
  }

  async loadRealGallery() {
    if (this.realGallery) {
      return this.realGallery;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = import('./BrushGallery.js')
      .then(module => {
        this.realGallery = new module.BrushGallery(this.options);
        this.realGallery.init();
        this.loadingPromise = null;
        return this.realGallery;
      })
      .catch(error => {
        this.loadingPromise = null;
        console.error('Failed to load BrushGallery:', error);
        throw error;
      });

    return this.loadingPromise;
  }

  async show() {
    // Lazy load gallery on first show
    if (!this.realGallery) {
      await this.loadRealGallery();
    }

    if (this.realGallery) {
      this.realGallery.show();
    }
  }

  hide() {
    // Hide immediately if already loaded
    if (this.realGallery) {
      this.realGallery.hide();
    } else if (this.galleryEl) {
      // Hide even if not loaded yet
      this.galleryEl.style.display = 'none';
    }
  }

  getSelectedBrush() {
    return this.realGallery ? this.realGallery.getSelectedBrush() : null;
  }
}
