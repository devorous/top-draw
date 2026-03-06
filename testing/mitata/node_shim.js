global.window = global;
global.self = global;
global.performance = performance;

global.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

global.document = {
  createElement: (tag) => {
    return {
      width: 0,
      height: 0,
      style: {},
      getContext: () => ({
        clearRect: () => {},
        drawImage: () => {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData: () => {},
        globalCompositeOperation: 'source-over'
      }),
      toDataURL: () => ''
    };
  }
};
