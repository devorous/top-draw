/** @fileoverview Polyfill shim to provide a browser-like environment in Node.js for benchmarks. */

global.window = global;
global.self = global;
global.performance = performance;

/**
 * Mock ImageData class.
 */
global.ImageData = class ImageData {
  /**
   * @param {Uint8ClampedArray} data - The pixel data.
   * @param {number} width - The width.
   * @param {number} height - The height.
   */
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

global.document = {
  /**
   * Mocks document.createElement.
   * @param {string} tag - The HTML tag to create.
   * @returns {Object} - The mocked element.
   */
  createElement: (tag) => {
    return {
      width: 0,
      height: 0,
      style: {},
      /**
       * Gets a mocked 2D context.
       * @returns {Object}
       */
      getContext: () => ({
        clearRect: () => {},
        drawImage: () => {},
        /**
         * Mocks getImageData.
         * @param {number} x - X coordinate.
         * @param {number} y - Y coordinate.
         * @param {number} w - Width.
         * @param {number} h - Height.
         * @returns {Object}
         */
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
        globalCompositeOperation: 'source-over'
      }),
      /**
       * Mocks toDataURL.
       * @returns {string}
       */
      toDataURL: () => ''
    };
  }
};
