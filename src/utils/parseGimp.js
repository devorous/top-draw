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

export function parseGih(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);

  if (view.length > 1500000) {
    console.error('File too large!');
    return null;
  }

  const chunks = splitUint8Array(view, 10);
  const name = chunkToString(chunks[0]);
  const info = chunkToString(chunks[1]);

  const infoSplit = info.split(' ');
  const gihObject = { name };

  for (let i = 1; i < infoSplit.length; i++) {
    const splits = infoSplit[i].split(':');
    const head = splits[0];
    let value = splits[1];
    if (Number(value)) {
      value = Number(value);
    }
    gihObject[head] = value;
  }

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
  return gihObject;
}
