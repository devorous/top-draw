/**
 * @fileoverview GIMP brush file parser for .gbr (static) and .gih (animated/multi-dimensional) formats.
 */

/**
 * Converts a Uint8Array chunk to a string.
 * @param {Uint8Array} chunk - Data chunk.
 * @returns {string} - Resulting string.
 */
function chunkToString(chunk) {
  let string = '';
  for (let i = 0; i < chunk.length; i++) {
    const letter = String.fromCharCode(chunk[i]);
    string += letter;
  }
  return string;
}

/**
 * Concatenates a Uint8Array chunk into a hex string.
 * @param {Uint8Array} chunk - Data chunk.
 * @returns {string} - Resulting hex string.
 */
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

/**
 * Parses a GIMP .gbr brush file.
 * @param {ArrayBuffer} arrayBuffer - File data.
 * @returns {Object} - Parsed brush object.
 */
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

/**
 * Splits a Uint8Array based on a delimiter.
 * @param {Uint8Array} array - Input array.
 * @param {number} delimiter - Byte delimiter.
 * @returns {Array<Uint8Array>} - Array of chunks.
 */
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
 * Hard limits to prevent runaway brushes from lagging the app.
 * GIMP itself caps dim at 4 (GIMP_PIXPIPE_MAXDIM).
 */
const MAX_DIMENSIONS = 4;
const MAX_RANKS_PER_DIM = 32;
const MAX_TOTAL_CELLS = 256;
const MAX_FILE_BYTES = 1_500_000;

/**
 * Parse the GIH info line to extract dimensions and selection modes.
 * Supports both modern GIMP format (key:value pairs with dim/rank0/sel0/...) and
 * legacy positional format ("ncells [dim] rank1 sel1 rank2 sel2 ...").
 */
function parseGihInfo(info) {
  const parts = info.trim().split(/\s+/);
  const result = {
    ncells: parseInt(parts[0], 10) || 1,
    dimensions: []
  };

  const usesKeyValue = parts.slice(1).some((p) => p.includes(':'));

  if (usesKeyValue) {
    // Modern format: "ncells:N cellwidth:W cellheight:H cellbpp:B ncells:N dim:D
    //                 cols:C rows:R placement:P rank0:.. rankN:.. sel0:.. selN:.."
    const kv = {};
    for (const part of parts) {
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) continue;
      const key = part.slice(0, colonIdx);
      const value = part.slice(colonIdx + 1);
      kv[key] = value;
    }

    if (kv.ncells !== undefined) {
      const n = parseInt(kv.ncells, 10);
      if (!isNaN(n) && n > 0) result.ncells = n;
    }
    if (kv.cellwidth !== undefined)  result.cellwidth  = parseInt(kv.cellwidth, 10);
    if (kv.cellheight !== undefined) result.cellheight = parseInt(kv.cellheight, 10);
    if (kv.cellbpp !== undefined)    result.cellbpp    = parseInt(kv.cellbpp, 10);
    if (kv.step !== undefined)       result.step       = parseInt(kv.step, 10);
    if (kv.cols !== undefined)       result.cols       = parseInt(kv.cols, 10);
    if (kv.rows !== undefined)       result.rows       = parseInt(kv.rows, 10);
    if (kv.placement !== undefined)  result.placement  = kv.placement;

    const declaredDim = kv.dim !== undefined ? parseInt(kv.dim, 10) : NaN;

    // Form A — explicit rank0/sel0, rank1/sel1, ... (what GIMP actually writes)
    if (!isNaN(declaredDim) && declaredDim > 0 && kv.rank0 !== undefined) {
      for (let i = 0; i < declaredDim; i++) {
        const ranks = parseInt(kv[`rank${i}`], 10);
        const sel = kv[`sel${i}`] !== undefined ? kv[`sel${i}`] : 'incremental';
        if (!isNaN(ranks) && ranks > 0) {
          result.dimensions.push({
            ranks,
            selection: normalizeSelectionMode(sel),
            currentIndex: 0
          });
        }
      }
    }
    // Form B — comma-separated lists "ranks:4,8 selection:angular,incremental"
    else if (kv.ranks !== undefined && String(kv.ranks).includes(',')) {
      const rankList = String(kv.ranks).split(',').map((s) => parseInt(s, 10));
      const selList = (kv.selection !== undefined ? String(kv.selection) : '')
        .split(',').map((s) => s.trim());
      for (let i = 0; i < rankList.length; i++) {
        if (isNaN(rankList[i]) || rankList[i] <= 0) continue;
        result.dimensions.push({
          ranks: rankList[i],
          selection: normalizeSelectionMode(selList[i] || 'incremental'),
          currentIndex: 0
        });
      }
    }
    // Form C — single ranks:N selection:mode (one dimension)
    else if (kv.ranks !== undefined) {
      const ranks = parseInt(kv.ranks, 10);
      if (!isNaN(ranks) && ranks > 0) {
        result.dimensions.push({
          ranks,
          selection: normalizeSelectionMode(kv.selection || 'incremental'),
          currentIndex: 0
        });
      }
    }

    // Fallback — treat as single incremental dim spanning all cells
    if (result.dimensions.length === 0 && result.ncells > 1) {
      result.dimensions.push({
        ranks: result.ncells,
        selection: normalizeSelectionMode(kv.selection || 'incremental'),
        currentIndex: 0
      });
    }
  } else {
    // Legacy positional format: "ncells [dim] rank1 sel1 rank2 sel2 ..."
    let idx = 1;
    let numDimensions = 1;

    if (parts.length > 1 && !isNaN(parseInt(parts[1], 10))) {
      const possibleDimCount = parseInt(parts[1], 10);
      if (possibleDimCount >= 1 && possibleDimCount <= MAX_DIMENSIONS &&
          parts.length >= 2 + possibleDimCount * 2) {
        numDimensions = possibleDimCount;
        idx = 2;
      }
    }

    for (let d = 0; d < numDimensions && idx + 1 < parts.length; d++) {
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

      case SELECTION_MODES.ANGULAR: {
        // Angle is 0-360, map to ranks. 0° = up, 90° = right, 180° = down, 270° = left.
        // Match GIMP's RINT(angle / step) so each cell is centered on its target
        // direction (e.g. for 4-dir: "up" cell fires for -45°..+45°, not 0°..90°).
        const normalizedAngle = ((angle % 360) + 360) % 360;
        const angleStep = 360 / dim.ranks;
        dim.currentIndex = Math.round(normalizedAngle / angleStep) % dim.ranks;
        break;
      }

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

/**
 * Parses a GIMP .gih (GIMP Image Hose) brush file.
 * @param {ArrayBuffer} arrayBuffer - File data.
 * @returns {Object|null} - Parsed GIH object or null if failed.
 */
export function parseGih(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);

  if (view.length > MAX_FILE_BYTES) {
    console.error(`parseGih: file too large (${view.length} > ${MAX_FILE_BYTES})`);
    return null;
  }

  const chunks = splitUint8Array(view, 10);
  if (chunks.length < 2) {
    console.error('parseGih: missing brush name/parameter header');
    return null;
  }
  const name = chunkToString(chunks[0]);
  const info = chunkToString(chunks[1]);

  const gihObject = parseGihInfo(info);
  gihObject.name = name;

  // Enforce sanity limits BEFORE allocating per-cell buffers.
  if (gihObject.ncells > MAX_TOTAL_CELLS) {
    console.error(`parseGih: brush "${name}" has ${gihObject.ncells} cells, ` +
                  `exceeds limit of ${MAX_TOTAL_CELLS}`);
    return null;
  }
  if (gihObject.dimensions.length > MAX_DIMENSIONS) {
    console.error(`parseGih: brush "${name}" declares ${gihObject.dimensions.length} ` +
                  `dimensions, exceeds limit of ${MAX_DIMENSIONS}`);
    return null;
  }
  for (const dim of gihObject.dimensions) {
    if (dim.ranks > MAX_RANKS_PER_DIM) {
      console.error(`parseGih: brush "${name}" dimension has ${dim.ranks} ranks, ` +
                    `exceeds limit of ${MAX_RANKS_PER_DIM}`);
      return null;
    }
  }

  const data = view.slice(chunks[0].length + chunks[1].length + 2);

  // Walk each cell's own GBR header to find its size. Each cell starts with:
  //   bytes 0-3  : header_size (uint32 BE)
  //   bytes 8-11 : width
  //   bytes 12-15: height
  //   bytes 16-19: bytes_per_pixel
  const indices = [];
  let acc = 0;
  for (let i = 0; i < gihObject.ncells; i++) {
    indices.push(acc);
    if (acc + 20 > data.length) {
      console.error(`parseGih: truncated brush data at cell ${i}`);
      return null;
    }
    const headerLength = Number('0x' + concatChunk(data.slice(acc, acc + 4)));
    const cellWidth    = Number('0x' + concatChunk(data.slice(acc + 8,  acc + 12)));
    const cellHeight   = Number('0x' + concatChunk(data.slice(acc + 12, acc + 16)));
    const cellBpp      = Number('0x' + concatChunk(data.slice(acc + 16, acc + 20)));
    const imageBytes = cellWidth * cellHeight * cellBpp;
    acc += headerLength + imageBytes;
    if (acc > data.length) {
      console.error(`parseGih: cell ${i} extends past end of file`);
      return null;
    }
  }
  indices.push(acc);

  const brushes = [];
  for (let i = 0; i < gihObject.ncells; i++) {
    const startIdx = indices[i];
    const endIdx = indices[i + 1];
    const currentData = data.slice(startIdx, endIdx);
    brushes.push(parseGbr(currentData));
  }

  gihObject.gBrushes = brushes;

  // Backfill cellwidth/cellheight/cellbpp from the first cell if the param
  // line didn't supply them (positional format, or older writers).
  if (brushes.length > 0) {
    if (gihObject.cellwidth  === undefined) gihObject.cellwidth  = brushes[0].width;
    if (gihObject.cellheight === undefined) gihObject.cellheight = brushes[0].height;
    if (gihObject.cellbpp    === undefined) gihObject.cellbpp    = brushes[0].colorDepth;
  }

  /**
   * Gets the next brush index based on context.
   * @param {Object} context - Drawing context { angle, pressure, velocity, tiltX, tiltY }.
   * @returns {Object} - { brush, index }
   */
  gihObject.getNextBrush = function(context) {
    const idx = getNextBrushIndex(this, context);
    return {
      brush: this.gBrushes[idx],
      index: idx
    };
  };

  /**
   * Resets dimension indices to 0.
   */
  gihObject.reset = function() {
    for (const dim of this.dimensions) {
      dim.currentIndex = 0;
    }
  };

  return gihObject;
}

// Export for use in Tools.js
export { SELECTION_MODES, getNextBrushIndex };
