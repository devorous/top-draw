/** @fileoverview Shared image validation helpers for uploads and WebSocket image payloads. */

let sharpModule = null;

async function getSharp() {
  if (sharpModule === null) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      sharpModule = false;
    }
  }
  return sharpModule || null;
}

export const INLINE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp'
]);

export const CHAT_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

const SHARP_MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

function readUInt16LE(buffer, offset) {
  if (offset + 2 > buffer.length) return 0;
  return buffer.readUInt16LE(offset);
}

function readUInt16BE(buffer, offset) {
  if (offset + 2 > buffer.length) return 0;
  return buffer.readUInt16BE(offset);
}

function readUInt24LE(buffer, offset) {
  if (offset + 3 > buffer.length) return 0;
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readUInt32BE(buffer, offset) {
  if (offset + 4 > buffer.length) return 0;
  return buffer.readUInt32BE(offset);
}

function readJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1];
    }

    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;

    const segmentLength = readUInt16BE(buffer, offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return null;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      return {
        width: readUInt16BE(buffer, offset + 5),
        height: readUInt16BE(buffer, offset + 3)
      };
    }

    offset += segmentLength;
  }

  return null;
}

function readWebpDimensions(buffer) {
  if (buffer.length < 30) return null;

  const chunkType = buffer.slice(12, 16).toString('ascii');
  if (chunkType === 'VP8X' && buffer.length >= 30) {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1
    };
  }

  if (chunkType === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))
    };
  }

  if (
    chunkType === 'VP8 ' &&
    buffer.length >= 30 &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return {
      width: readUInt16LE(buffer, 26) & 0x3fff,
      height: readUInt16LE(buffer, 28) & 0x3fff
    };
  }

  return null;
}

function extractDimensionsFromBuffer(buffer, mimeType) {
  if (!buffer?.length) return null;

  switch (mimeType) {
    case 'image/png':
      if (buffer.length >= 24) {
        return {
          width: readUInt32BE(buffer, 16),
          height: readUInt32BE(buffer, 20)
        };
      }
      return null;

    case 'image/gif':
      if (buffer.length >= 10) {
        return {
          width: readUInt16LE(buffer, 6),
          height: readUInt16LE(buffer, 8)
        };
      }
      return null;

    case 'image/webp':
      return readWebpDimensions(buffer);

    case 'image/jpeg':
      return readJpegDimensions(buffer);

    default:
      return null;
  }
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.alloc(0);
}

function normalizeMimeType(mimeType) {
  return String(mimeType || '').trim().toLowerCase();
}

function guessMimeFromSignature(buffer) {
  if (!buffer || buffer.length < 12) return '';

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }

  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (buffer.slice(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif';
  }

  return '';
}

/**
 * Validates image bytes against file-size and, when available, pixel-dimension limits.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} bytes
 * @param {{
 *   maxBytes: number,
 *   maxWidth: number,
 *   maxHeight: number,
 *   maxPixels: number,
 *   allowedMimeTypes?: Set<string>,
 *   mimeTypeHint?: string
 * }} options
 * @returns {Promise<{ ok: boolean, error?: string, buffer?: Buffer, mimeType?: string, width?: number, height?: number }>}
 */
export async function validateImageBytes(bytes, {
  maxBytes,
  maxWidth,
  maxHeight,
  maxPixels,
  allowedMimeTypes = INLINE_IMAGE_MIME_TYPES,
  mimeTypeHint = ''
}) {
  const buffer = toBuffer(bytes);
  if (!buffer.length) {
    return { ok: false, error: 'Image payload is empty' };
  }

  if (buffer.length > maxBytes) {
    return { ok: false, error: `Image exceeds the ${maxBytes} byte limit` };
  }

  const hintedMime = normalizeMimeType(mimeTypeHint);
  const signatureMime = guessMimeFromSignature(buffer);
  const resolvedMime = signatureMime || hintedMime;

  if (!resolvedMime || !allowedMimeTypes.has(resolvedMime)) {
    return { ok: false, error: 'Unsupported image type' };
  }

  const sharp = await getSharp();
  if (!sharp) {
    const dimensions = extractDimensionsFromBuffer(buffer, resolvedMime);
    const width = Number(dimensions?.width || 0);
    const height = Number(dimensions?.height || 0);

    if (!width || !height) {
      return { ok: false, error: 'Could not determine image dimensions' };
    }
    if (width > maxWidth || height > maxHeight) {
      return { ok: false, error: `Image dimensions exceed ${maxWidth}x${maxHeight}` };
    }
    if (width * height > maxPixels) {
      return { ok: false, error: 'Image exceeds the maximum pixel count' };
    }

    return {
      ok: true,
      buffer,
      mimeType: resolvedMime,
      width,
      height
    };
  }

  try {
    const metadata = await sharp(buffer, { limitInputPixels: maxPixels }).metadata();
    const actualMimeType = normalizeMimeType(SHARP_MIME_BY_FORMAT[metadata.format] || resolvedMime);
    const width = Number(metadata.width || 0);
    const height = Number(metadata.height || 0);

    if (!actualMimeType || !allowedMimeTypes.has(actualMimeType)) {
      return { ok: false, error: 'Unsupported image type' };
    }
    if (!width || !height) {
      return { ok: false, error: 'Could not determine image dimensions' };
    }
    if (width > maxWidth || height > maxHeight) {
      return { ok: false, error: `Image dimensions exceed ${maxWidth}x${maxHeight}` };
    }
    if (width * height > maxPixels) {
      return { ok: false, error: 'Image exceeds the maximum pixel count' };
    }

    return {
      ok: true,
      buffer,
      mimeType: actualMimeType,
      width,
      height
    };
  } catch (err) {
    return { ok: false, error: err?.message || 'Invalid image data' };
  }
}

/**
 * Validates a base64 data URL image and returns the decoded buffer on success.
 *
 * @param {string} dataUrl
 * @param {{
 *   maxBytes: number,
 *   maxWidth: number,
 *   maxHeight: number,
 *   maxPixels: number,
 *   allowedMimeTypes?: Set<string>,
 *   maxDataUrlLength?: number
 * }} options
 */
export async function validateDataUrlImage(dataUrl, {
  maxBytes,
  maxWidth,
  maxHeight,
  maxPixels,
  allowedMimeTypes = INLINE_IMAGE_MIME_TYPES,
  maxDataUrlLength = Math.ceil(maxBytes * 1.5) + 256
}) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return { ok: false, error: 'Expected an image data URL' };
  }

  if (dataUrl.length > maxDataUrlLength) {
    return { ok: false, error: 'Image data URL is too large' };
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) {
    return { ok: false, error: 'Malformed image data URL' };
  }

  const mimeType = normalizeMimeType(match[1]);
  if (!allowedMimeTypes.has(mimeType)) {
    return { ok: false, error: 'Unsupported image type' };
  }

  const base64 = match[2].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return { ok: false, error: 'Invalid base64 image data' };
  }

  const buffer = Buffer.from(base64, 'base64');
  return validateImageBytes(buffer, {
    maxBytes,
    maxWidth,
    maxHeight,
    maxPixels,
    allowedMimeTypes,
    mimeTypeHint: mimeType
  });
}
