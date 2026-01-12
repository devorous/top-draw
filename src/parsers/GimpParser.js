/**
 * GimpParser - Parse GIMP brush files (.gbr and .gih)
 */

/**
 * Convert a byte chunk to a string
 * @param {Uint8Array} chunk - Byte array
 * @returns {string}
 */
function chunkToString(chunk) {
  let string = '';
  for (let i = 0; i < chunk.length; i++) {
    string += String.fromCharCode(chunk[i]);
  }
  return string;
}

/**
 * Concatenate bytes into a hex string
 * @param {Uint8Array} chunk - Byte array
 * @returns {string}
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
 * Split a Uint8Array by a delimiter value
 * @param {Uint8Array} array - Byte array
 * @param {number} delimiter - Delimiter byte value
 * @returns {Array<Array>}
 */
function splitUint8Array(array, delimiter) {
  const chunks = [];
  let chunk = [];
  let i = 0;

  for (const value of array) {
    if (value === delimiter) {
      chunks.push(chunk);
      chunk = [];
      i++;
      if (i === 2) break;
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
 * Parse a GIMP brush file (.gbr)
 * @param {ArrayBuffer} arrayBuffer - File data
 * @returns {Object|null} Brush object with image data
 */
export function parseGbr(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);

  // Extract header chunks
  const headerChunk = view.slice(0, 4);
  const headerLength = Number('0x' + concatChunk(headerChunk));

  const chunks = [];
  for (let i = 0; i <= 27; i += 4) {
    const chunk = view.slice(i, i + 4);
    const chunkHex = concatChunk(chunk);
    chunks.push(chunkHex);
  }

  const lastChunk = view.slice(28, headerLength - 1);
  const lastChunkHex = chunkToString(lastChunk);
  chunks.push(lastChunkHex);

  // Extract values
  const brushObject = {
    headerSize: Number('0x' + chunks[0]),
    version: Number('0x' + chunks[1]),
    width: Number('0x' + chunks[2]),
    height: Number('0x' + chunks[3]),
    colorDepth: Number('0x' + chunks[4]),
    magicNumber: chunks[5],
    spacing: Number('0x' + chunks[6]),
    brushName: chunks[7]
  };

  const { width, height, colorDepth } = brushObject;
  const imageData = view.slice(headerLength, view.length);

  // Create canvas for brush image
  const gimpCanvas = document.createElement('canvas');
  gimpCanvas.height = height;
  gimpCanvas.width = width;
  const gCtx = gimpCanvas.getContext('2d');
  const gimpImageData = gCtx.createImageData(width, height);
  const gData = gimpImageData.data;

  // RGBA image
  if (colorDepth === 4) {
    for (let i = 0; i < gData.length; i += 4) {
      gData[i] = imageData[i];       // Red
      gData[i + 1] = imageData[i + 1]; // Green
      gData[i + 2] = imageData[i + 2]; // Blue
      gData[i + 3] = imageData[i + 3]; // Alpha
    }
  }

  // Greyscale image
  if (colorDepth === 1) {
    for (let i = 0; i < gData.length / 4; i++) {
      const v = imageData[i];
      gData[i * 4] = 255 - v;
      gData[i * 4 + 1] = 255 - v;
      gData[i * 4 + 2] = 255 - v;
      gData[i * 4 + 3] = 255;
    }
  }

  gCtx.putImageData(gimpImageData, 0, 0);

  brushObject.gimpUrl = gimpCanvas.toDataURL('image/png', 1.0);

  return brushObject;
}

/**
 * Parse a GIMP image hose file (.gih)
 * @param {ArrayBuffer} arrayBuffer - File data
 * @returns {Object|null} Brush hose object with multiple brushes
 */
export function parseGih(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);

  // Limit file size to avoid lag
  if (view.length > 1500000) {
    console.error('GIH file too large (>1.5MB)');
    return null;
  }

  // Split off the two heading chunks by newline (10 in decimal)
  const chunks = splitUint8Array(view, 10);
  const name = chunkToString(chunks[0]);
  const info = chunkToString(chunks[1]);

  // Parse info line
  const infoSplit = info.split(' ');
  const gihObject = { name };

  for (let i = 1; i < infoSplit.length; i++) {
    const splits = infoSplit[i].split(':');
    const head = splits[0];
    let value = splits[1];

    if (!isNaN(Number(value))) {
      value = Number(value);
    }
    gihObject[head] = value;
  }

  // Extract brush data
  const data = view.slice(chunks[0].length + chunks[1].length + 2);
  const colorDepth = data[19];
  const imageBytes = gihObject.cellheight * gihObject.cellwidth * colorDepth;

  // Find indices for each cell
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

  // Parse each brush
  const brushes = [];
  for (let i = 0; i < gihObject.ncells; i++) {
    const index = indices[i];
    const currentData = data.slice(index, index + indices[i + 1]);
    const currentBrush = parseGbr(currentData.buffer.slice(
      currentData.byteOffset,
      currentData.byteOffset + currentData.byteLength
    ));
    brushes.push(currentBrush);
  }

  gihObject.gBrushes = brushes;

  return gihObject;
}
