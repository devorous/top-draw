/** @fileoverview Lazy-loads BrushGallery and parseGimp.js only when first shown. */

/**
 * BrushGalleryLoader class
 * This keeps ~40 KB of brush parsing code out of initial bundle.
 */
export class BrushGalleryLoader {
  /**
   * @param {Object} options - Configuration options for BrushGallery
   */
  constructor(options = {}) {
    this.options = options;
    this.realGallery = null;
    this.loadingPromise = null;
    this.galleryEl = null;
  }

  /**
   * Initializes the loader by storing a reference to the gallery element.
   */
  init() {
    this.galleryEl = document.getElementById('brushGallery');
  }

  /**
   * Loads the real BrushGallery module and initializes it.
   * @returns {Promise<BrushGallery>} - Resolves with the BrushGallery instance
   */
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

  /**
   * Shows the BrushGallery, loading it first if necessary.
   * @returns {Promise<void>}
   */
  async show() {
    if (!this.realGallery) {
      await this.loadRealGallery();
    }

    if (this.realGallery) {
      this.realGallery.show();
    }
  }

  /**
   * Hides the BrushGallery.
   */
  hide() {
    if (this.realGallery) {
      this.realGallery.hide();
    } else if (this.galleryEl) {
      this.galleryEl.style.display = 'none';
    }
  }

  /**
   * Gets the currently selected brush from the gallery.
   * @returns {Object|null} - The selected brush or null if not loaded
   */
  getSelectedBrush() {
    return this.realGallery ? this.realGallery.getSelectedBrush() : null;
  }
}
