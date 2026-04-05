    if (this.tileGrid) this.tileGrid.markAllDirty();
    if (this.tileTracker) {
      // Re-scan tiles for occupancy
      const tileIndices = [];
      for (let i = 0; i < this.tileTracker.cols * this.tileTracker.rows; i++) {
        tileIndices.push(i);
      }
      this.checkErasedTilesByIndices(new Set(tileIndices), true);
    }
    
    this.compositeAllLayers();
  }

  /**
   * Helper to create a canvas from ImageData.
   * @param {ImageData} imageData
   * @returns {HTMLCanvasElement}
   * @private
   */
  _createCanvasFromImageData(imageData) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * Check if tile pixel data is empty (transparent or only background color).
   * @param {Uint8ClampedArray} data - RGBA pixel data
   * @returns {boolean} True if all pixels are transparent or match background
   * @private
   */
  _checkTileEmpty(data) {
    const [bgR, bgG, bgB, bgA] = this.backgroundColor;
    const bgAlpha = Math.round(bgA * 255);
    const tolerance = 5; // Handle anti-aliasing artifacts

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];

      // Transparent pixel = empty
      if (a === 0) continue;

      // Check if close to background (within tolerance)
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (Math.abs(a - bgAlpha) <= tolerance &&
          Math.abs(r - bgR) <= tolerance &&
          Math.abs(g - bgG) <= tolerance &&
          Math.abs(b - bgB) <= tolerance) {
        continue;
      }

      // Has other content
      return false;
    }
    return true;
  }
}
