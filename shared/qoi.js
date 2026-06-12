import { getBoardDimensionsForSize } from './boardSizes.js';

const QOI_HEADER_SIZE = 14;
const QOI_MAGIC_Q = 0x71;
const QOI_MAGIC_O = 0x6f;
const QOI_MAGIC_I = 0x69;
const QOI_MAGIC_F = 0x66;

export function readQoiDimensions(encoded) {
  if (!encoded || encoded.length < QOI_HEADER_SIZE) return null;
  if (
    encoded[0] !== QOI_MAGIC_Q ||
    encoded[1] !== QOI_MAGIC_O ||
    encoded[2] !== QOI_MAGIC_I ||
    encoded[3] !== QOI_MAGIC_F
  ) {
    return null;
  }

  const width = (
    ((encoded[4] << 24) >>> 0) |
    (encoded[5] << 16) |
    (encoded[6] << 8) |
    encoded[7]
  ) >>> 0;
  const height = (
    ((encoded[8] << 24) >>> 0) |
    (encoded[9] << 16) |
    (encoded[10] << 8) |
    encoded[11]
  ) >>> 0;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

export function snapshotLayerDimensions(layerDatas) {
  if (!Array.isArray(layerDatas)) return null;

  for (const qoi of layerDatas) {
    const dimensions = readQoiDimensions(qoi);
    if (dimensions) return dimensions;
  }

  return null;
}

/**
 * Whether a snapshot's layers are at least as large as the room's board,
 * i.e. the snapshot fully covers the board area.
 * @param {Array} snapshotLayers - Encoded QOI layer buffers.
 * @param {{settings?: {boardSize?: string}}} room
 * @returns {boolean}
 */
export function snapshotCoversRoomBoard(snapshotLayers, room) {
  const snapshotDimensions = snapshotLayerDimensions(snapshotLayers);
  const [boardHeight, boardWidth] = getBoardDimensionsForSize(room?.settings?.boardSize);

  return !!snapshotDimensions &&
    snapshotDimensions.width >= boardWidth &&
    snapshotDimensions.height >= boardHeight;
}
