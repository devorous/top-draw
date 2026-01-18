/**
 * GIMP brush file parser (.gbr and .gih formats)
 */

function chunkToString(chunk) {
  let string = '';
  for (let i = 0; i < chunk.length; i++) {
    const letter = String.fromCharCode(chunk[i]);
    string += letter;
  }
  return string;
}

function concatChunk(chunk) {
  let hexString = '';
  for (let i = 0; i < chunk.length; i++) {
    let hex = chunk[i].toString(16);
    if (hex.length === 1) {
      hex = '0' + hex;
    }
    hexString += hex;
  }
  return hexString;
}

export function parseGbr(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);

  const headerChunk = view.slice(0, 4);
  const headerLength = Number('0x' + concatChunk(headerChunk));

  const chunks = [];
  for (let i = 0; i <= 27; i += 4) {
    const chunk = view.slice(i, i + 4);
    const chunkHex = concatChunk(chunk);
    chunks.push(chunkHex);
  }

  const lastchunk = view.slice(28, headerLength - 1);
  const lastchunkHex = chunkToString(lastchunk);
  chunks.push(lastchunkHex);

  const headerSize = Number('0x' + chunks[0]);
  const version = Number('0x' + chunks[1]);
  const width = Number('0x' + chunks[2]);
  const height = Number('0x' + chunks[3]);
  const colorDepth = Number('0x' + chunks[4]);
  const magicNumber = chunks[5];
  const spacing = Number('0x' + chunks[6]);
  const brushName = chunks[7];

  const imageData = view.slice(headerLength, view.length);

  const brushObject = {
    headerSize,
    version,
    width,
    height,
    colorDepth,
    magicNumber,
    spacing,
    brushName
  };

  const gimpCanvas = document.createElement('canvas');
  gimpCanvas.height = height;
  gimpCanvas.width = width;
  const gCtx = gimpCanvas.getContext('2d');
  const gimpImageData = gCtx.createImageData(width, height);
  const gData = gimpImageData.data;

  if (colorDepth === 4) {
    for (let i = 0; i < gData.length; i += 4) {
      const r = imageData[i];
      const g = imageData[i + 1];
      const b = imageData[i + 2];
      const a = imageData[i + 3];
      gData[i] = r;
      gData[i + 1] = g;
      gData[i + 2] = b;
      gData[i + 3] = a;
    }
  }

  if (colorDepth === 1) {
    for (let i = 0; i < imageData.length; i++) {
      const v = imageData[i];
      gData[i * 4] = 255 - v;
      gData[i * 4 + 1] = 255 - v;
      gData[i * 4 + 2] = 255 - v;
      gData[i * 4 + 3] = 255;
    }
  }

  gCtx.putImageData(gimpImageData, 0, 0);

  const url = gimpCanvas.toDataURL('image/png', 1.0);
  brushObject.gimpUrl = url;

  return brushObject;
}

function splitUint8Array(array, delimiter) {
  const chunks = [];
  let chunk = [];
  let count = 0;

  for (const value of array) {
    if (value === delimiter) {
      chunks.push(chunk);
      chunk = [];
      count++;
      if (count === 2) {
        break;
      }
    } else {
      chunk.push(value);
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Selection modes for GIH brush dimensions
 */
const SELECTION_MODES = {
  INCREMENTAL: 'incremental',
  ANGULAR: 'angular',
  RANDOM: 'random',
  PRESSURE: 'pressure',
  VELOCITY: 'velocity',
  TILT_X: 'tilt-x',
  TILT_Y: 'tilt-y',
  CONSTANT: 'constant'
};

/**
 * Parse the GIH info line to extract dimensions and selection modes
 * Format: "ncells [dim] rank1 sel1 rank2 sel2 ..." or "ncells key:value key:value ..."
 */
function parseGihInfo(info) {
  const parts = info.trim().split(/\s+/);
  const result = {
    ncells: parseInt(parts[0], 10) || 1,
    dimensions: []
  };

  // Check if using key:value format (legacy/simple format)
  if (parts.length > 1 && parts[1].includes(':')) {
    // Parse key:value pairs
    for (let i = 1; i < parts.length; i++) {
      const [key, value] = parts[i].split(':');
      if (key && value !== undefined) {
        result[key] = isNaN(Number(value)) ? value : Number(value);
      }
    }
    // If no dimensions specified, create a single incremental dimension
    if (result.dimensions.length === 0 && result.ncells > 1) {
      result.dimensions.push({
        ranks: result.ncells,
        selection: SELECTION_MODES.INCREMENTAL,
        currentIndex: 0
      });
    }
  } else {
    // Parse dimension format: ncells [numDimensions] rank1 sel1 rank2 sel2 ...
    let idx = 1;

    // Check if second number is the dimension count
    let numDimensions = 1;
    if (parts.length > 1 && !isNaN(parseInt(parts[1], 10))) {
      const possibleDimCount = parseInt(parts[1], 10);
      // If it's a small number (1-4) and we have enough parts for rank/sel pairs, it's dimension count
      if (possibleDimCount <= 4 && parts.length >= 2 + possibleDimCount * 2) {
        numDimensions = possibleDimCount;
        idx = 2;
      }
    }

    // Parse rank/selection pairs
    while (idx < parts.length - 1) {
      const ranks = parseInt(parts[idx], 10);
      const selection = (parts[idx + 1] || 'incremental').toLowerCase();

      if (!isNaN(ranks) && ranks > 0) {
        result.dimensions.push({
          ranks,
          selection: normalizeSelectionMode(selection),
          currentIndex: 0
        });
      }
      idx += 2;
    }

    // If no dimensions parsed, create default
    if (result.dimensions.length === 0 && result.ncells > 1) {
      result.dimensions.push({
        ranks: result.ncells,
        selection: SELECTION_MODES.INCREMENTAL,
        currentIndex: 0
      });
    }
  }

  return result;
}

/**
 * Normalize selection mode string to standard format
 */
function normalizeSelectionMode(mode) {
  const normalized = mode.toLowerCase().trim();
  switch (normalized) {
    case 'incremental':
    case 'inc':
      return SELECTION_MODES.INCREMENTAL;
    case 'angular':
    case 'angle':
      return SELECTION_MODES.ANGULAR;
    case 'random':
    case 'rand':
      return SELECTION_MODES.RANDOM;
    case 'pressure':
    case 'press':
      return SELECTION_MODES.PRESSURE;
    case 'velocity':
    case 'vel':
    case 'speed':
      return SELECTION_MODES.VELOCITY;
    case 'tilt-x':
    case 'tiltx':
    case 'xtilt':
      return SELECTION_MODES.TILT_X;
    case 'tilt-y':
    case 'tilty':
    case 'ytilt':
      return SELECTION_MODES.TILT_Y;
    case 'constant':
    case 'const':
      return SELECTION_MODES.CONSTANT;
    default:
      return SELECTION_MODES.INCREMENTAL;
  }
}

/**
 * Calculate brush index based on dimension selections
 * Dimensions work like an odometer - rightmost changes fastest
 */
function calculateBrushIndex(dimensions) {
  let index = 0;
  let multiplier = 1;

  // Process dimensions from last to first (rightmost to leftmost)
  for (let i = dimensions.length - 1; i >= 0; i--) {
    const dim = dimensions[i];
    index += dim.currentIndex * multiplier;
    multiplier *= dim.ranks;
  }

  return index;
}

/**
 * Get the next brush index based on context (angle, pressure, velocity, etc.)
 * @param {Object} gihObject - The parsed GIH object
 * @param {Object} context - Drawing context { angle, pressure, velocity, tiltX, tiltY, lastPos, currentPos }
 * @returns {number} - The brush index to use
 */
function getNextBrushIndex(gihObject, context = {}) {
  const { angle = 0, pressure = 0.5, velocity = 0, tiltX = 0, tiltY = 0 } = context;

  for (const dim of gihObject.dimensions) {
    switch (dim.selection) {
      case SELECTION_MODES.INCREMENTAL:
        dim.currentIndex = (dim.currentIndex + 1) % dim.ranks;
        break;

      case SELECTION_MODES.ANGULAR:
        // Angle is 0-360, map to ranks
        // 0° = up, 90° = right, 180° = down, 270° = left
        let normalizedAngle = ((angle % 360) + 360) % 360;
        const angleStep = 360 / dim.ranks;
        dim.currentIndex = Math.floor(normalizedAngle / angleStep) % dim.ranks;
        break;

      case SELECTION_MODES.RANDOM:
        dim.currentIndex = Math.floor(Math.random() * dim.ranks);
        break;

      case SELECTION_MODES.PRESSURE:
        // Pressure is 0-1, map to ranks
        dim.currentIndex = Math.min(dim.ranks - 1, Math.floor(pressure * dim.ranks));
        break;

      case SELECTION_MODES.VELOCITY:
        // Velocity mapped to ranks (normalize velocity to 0-1 range)
        // Higher velocity = higher rank
        const normalizedVelocity = Math.min(1, velocity / 50); // 50px movement = max
        dim.currentIndex = Math.min(dim.ranks - 1, Math.floor(normalizedVelocity * dim.ranks));
        break;

      case SELECTION_MODES.TILT_X:
        // Tilt is typically -1 to 1, map to ranks
        const normTiltX = (tiltX + 1) / 2; // Convert to 0-1
        dim.currentIndex = Math.min(dim.ranks - 1, Math.floor(normTiltX * dim.ranks));
        break;

      case SELECTION_MODES.TILT_Y:
        const normTiltY = (tiltY + 1) / 2;
        dim.currentIndex = Math.min(dim.ranks - 1, Math.floor(normTiltY * dim.ranks));
        break;

      case SELECTION_MODES.CONSTANT:
      default:
        // Keep current index (or 0 if not set)
        dim.currentIndex = dim.currentIndex || 0;
        break;
    }
  }

  return calculateBrushIndex(gihObject.dimensions);
}

export function parseGih(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);

  if (view.length > 1500000) {
    console.error('File too large!');
    return null;
  }

  const chunks = splitUint8Array(view, 10);
  const name = chunkToString(chunks[0]);
  const info = chunkToString(chunks[1]);

  // Parse the info line to get dimensions and selection modes
  const gihObject = parseGihInfo(info);
  gihObject.name = name;

  const data = view.slice(chunks[0].length + chunks[1].length + 2);
  const colorDepth = data[19];
  const imageBytes = gihObject.cellheight * gihObject.cellwidth * colorDepth;

  const indices = [];
  let acc = 0;

  for (let i = 0; i < gihObject.ncells; i++) {
    indices.push(acc);
    const headerChunk = data.slice(acc, acc + 4);
    const headerLength = Number('0x' + concatChunk(headerChunk));
    const cellSize = imageBytes + headerLength;
    acc += cellSize;
  }
  indices.push(acc);

  const brushes = [];

  for (let i = 0; i < gihObject.ncells; i++) {
    const index = indices[i];
    const currentData = data.slice(index, index + indices[i + 1]);
    const currentBrush = parseGbr(currentData);
    brushes.push(currentBrush);
  }

  gihObject.gBrushes = brushes;

  // Add helper method for getting next brush
  gihObject.getNextBrush = function(context) {
    const idx = getNextBrushIndex(this, context);
    return {
      brush: this.gBrushes[idx],
      index: idx
    };
  };

  // Add method to reset dimension indices
  gihObject.reset = function() {
    for (const dim of this.dimensions) {
      dim.currentIndex = 0;
    }
  };

  return gihObject;
}

// Export for use in Tools.js
export { SELECTION_MODES, getNextBrushIndex };
