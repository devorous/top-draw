import init, { qoi_encode } from '../wasm/ddraw_wasm.js';

let wasmReady = false;
let initPromise = null;

function ensureWasm() {
  if (!initPromise) {
    initPromise = init().then(() => {
      wasmReady = true;
    }).catch((err) => {
      wasmReady = false;
      throw err;
    });
  }
  return initPromise;
}

function computeHashLayers(layers) {
  let hash = 0;
  for (const data of layers) {
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data[i];
      hash |= 0;
    }
  }
  return hash;
}

function normalizeBackgroundColor(color) {
  if (Array.isArray(color)) {
    const [r = 255, g = 255, b = 255, a = 1] = color;
    return [r, g, b, Math.round(a * 255)];
  }
  return [255, 255, 255, 255];
}

function stripSnapshotBackground(data, width, height, backgroundColor) {
  if (!data || width <= 0 || height <= 0) return;

  const [bgR, bgG, bgB, bgAlpha] = normalizeBackgroundColor(backgroundColor);
  const tolerance = 3;
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const queue = new Uint32Array(totalPixels);
  let head = 0;
  let tail = 0;

  const matchesBackground = (pixelIndex) => {
    const offset = pixelIndex * 4;
    return Math.abs(data[offset] - bgR) <= tolerance &&
      Math.abs(data[offset + 1] - bgG) <= tolerance &&
      Math.abs(data[offset + 2] - bgB) <= tolerance &&
      Math.abs(data[offset + 3] - bgAlpha) <= tolerance;
  };

  const enqueue = (pixelIndex) => {
    if (pixelIndex < 0 || pixelIndex >= totalPixels) return;
    if (visited[pixelIndex] || !matchesBackground(pixelIndex)) return;
    visited[pixelIndex] = 1;
    queue[tail++] = pixelIndex;
  };

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(y * width);
    enqueue(y * width + (width - 1));
  }

  while (head < tail) {
    const pixelIndex = queue[head++];
    data[pixelIndex * 4 + 3] = 0;

    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }
}

self.onmessage = async (event) => {
  const { id, type, layers, width, height, backgroundColor } = event.data || {};
  if (type !== 'ENCODE_SNAPSHOT') return;

  try {
    await ensureWasm();
    if (!wasmReady) throw new Error('WASM not initialized');

    const encodedLayers = [];
    for (let i = 0; i < layers.length; i++) {
      const data = layers[i];
      // An empty (unused) layer arrives as a zero-length buffer — pass it through
      // as zero-length so it stays cheap and is skipped on restore / parity.
      if (!data || data.length === 0) {
        encodedLayers.push(new Uint8Array(0));
        continue;
      }
      if (i === 0) stripSnapshotBackground(data, width, height, backgroundColor);
      encodedLayers.push(qoi_encode(data, width, height));
    }

    self.postMessage({
      id,
      type: 'ENCODE_SNAPSHOT_RESULT',
      layers: encodedLayers,
      hash: computeHashLayers(encodedLayers),
    }, encodedLayers.map((layer) => layer.buffer));
  } catch (err) {
    self.postMessage({
      id,
      type: 'ENCODE_SNAPSHOT_ERROR',
      error: err?.message || 'Snapshot encode failed',
    });
  }
};
