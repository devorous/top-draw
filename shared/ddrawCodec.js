/**
 * @fileoverview .ddraw file format — pack/unpack a ReplayRecording bundle.
 *
 * v3 layout (little-endian), current encoder output:
 *   bytes  0..4    magic        "DDRAW"
 *   byte   5       version      3
 *   byte   6       flags        bit0 = has blob section
 *   byte   7       jsonAlgo     0 = none, 1 = gzip, 2 = brotli
 *   byte   8       blobAlgo     0 = none, 1 = gzip, 2 = brotli (meaningless if no blob section)
 *   bytes  9..12   jsonLength   compressed length of the JSON payload
 *   bytes 13..14   reserved     0
 *   bytes 15..N    JSON payload (compressed per jsonAlgo)
 *   bytes  N..end  blob section, present when flags bit0 is set:
 *                    u32 blobCount
 *                    per blob: u8 kind (0 = Uint8Array, 1 = webp Blob), u32 rawLength
 *                    u32 compressedBodyLength
 *                    compressed bytes (per blobAlgo) of every blob's raw bytes concatenated in order
 *
 * Every `Uint8Array`/`Blob` anywhere in the recording tree — not just
 * `visualCheckpoints` thumbnails — is pulled out of the JSON before it's
 * stringified and replaced with `{ __u8ref: index }`. This matters because
 * QOI-encoded layer state (`openingSnapshot.canvasData`, intra-checkpoint
 * snapshots, etc.) is already-compressed binary: base64-inlining it into the
 * JSON text (the v1/v2 approach) both inflates it ~33% and leaves gzip
 * almost nothing to do (compressed bytes re-encoded as base64 text don't
 * have the redundancy a general-purpose compressor can exploit). Keeping it
 * as raw bytes in its own section, compressed once as a single concatenated
 * blob, measured ~3x smaller on real recordings. The JSON section — now just
 * protocol messages and structural scaffolding — compresses far better under
 * brotli than gzip (in testing, real recordings shrank another 2-4x).
 *
 * Brotli support: `CompressionStream`/`DecompressionStream` gained a
 * `'brotli'` format across major browsers; Node's WHATWG streams haven't
 * caught up yet as of Node 22, so the Node path uses `node:zlib`'s
 * `brotliCompressSync`/`brotliDecompressSync` instead — same wire format,
 * fully interoperable either direction. Gzip still goes through
 * `CompressionStream`/`DecompressionStream`, which both runtimes support.
 * If neither compressor is available, algo 0 (store raw) is used — decode
 * always works, encode just isn't as small.
 *
 * v1/v2 decode paths are kept verbatim for backward compatibility with
 * previously-exported files: v1 has no jsonLength/blob section (gzip-or-raw
 * JSON runs to EOF); v2 adds jsonLength + an uncompressed blob section
 * (webp visualCheckpoints only, base64-inlined Uint8Arrays elsewhere). The
 * encoder only ever produces v3.
 *
 * Lives in shared/ rather than src/replay/ because the server (Node) needs to
 * decode `.ddraw` bytes too (room_snapshots checkpoints), not just the
 * client.
 */
const MAGIC = new Uint8Array([0x44, 0x44, 0x52, 0x41, 0x57]); // "DDRAW"
const FORMAT_VERSION = 3;
const HEADER_V1_SIZE = 9;
const HEADER_V2_SIZE = 13; // adds u32 jsonLength
const HEADER_V3_SIZE = 15; // adds jsonAlgo + blobAlgo bytes
const V2_FLAG_GZIP = 0x01;
const V2_FLAG_BLOBS = 0x02;
const V3_FLAG_BLOBS = 0x01;

const ALGO_NONE = 0;
const ALGO_GZIP = 1;
const ALGO_BROTLI = 2;

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

let _zlibPromise = null;
/** Lazily import node:zlib. Dynamic + `@vite-ignore` so the browser bundle never tries to resolve it. */
async function _nodeZlib() {
  if (!_zlibPromise) {
    const modName = 'node:zlib';
    _zlibPromise = import(/* @vite-ignore */ modName);
  }
  return _zlibPromise;
}

/**
 * Feeds each chunk to the stream as a separate write — CompressionStream
 * compresses incrementally, so this never needs a single buffer holding
 * every chunk concatenated (which for a long multi-user recording's blob
 * section can be the largest allocation in the whole encode and is what
 * blew the tab's memory budget before this was chunked).
 */
async function _pipeThroughStream(chunks, stream) {
  const writer = stream.writable.getWriter();
  for (const chunk of chunks) writer.write(chunk);
  writer.close();
  const blob = await new Response(stream.readable).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

function _concatChunks(chunks) {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** @returns {Promise<Uint8Array|null>} null when brotli isn't available here. */
async function _tryBrotliCompress(chunks) {
  if (isNode) {
    try {
      const zlib = await _nodeZlib();
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
      return new Uint8Array(zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
      }));
    } catch {
      return null;
    }
  }
  if (typeof CompressionStream === 'undefined') return null;
  try {
    return await _pipeThroughStream(chunks, new CompressionStream('brotli'));
  } catch {
    return null; // format not supported by this browser
  }
}

/** @returns {Promise<Uint8Array|null>} null when gzip isn't available here. */
async function _tryGzipCompress(chunks) {
  if (typeof CompressionStream !== 'undefined') {
    try {
      return await _pipeThroughStream(chunks, new CompressionStream('gzip'));
    } catch {
      // fall through to Node zlib below
    }
  }
  if (isNode) {
    try {
      const zlib = await _nodeZlib();
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
      return new Uint8Array(zlib.gzipSync(buf, { level: 9 }));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {Uint8Array|Uint8Array[]} bytesOrChunks - a single buffer, or several
 *   chunks to be compressed as one stream without pre-concatenating them.
 * @returns {Promise<{ algo: number, data: Uint8Array }>}
 */
async function _compress(bytesOrChunks) {
  const chunks = Array.isArray(bytesOrChunks) ? bytesOrChunks : [bytesOrChunks];
  const brotli = await _tryBrotliCompress(chunks);
  if (brotli) return { algo: ALGO_BROTLI, data: brotli };
  const gzip = await _tryGzipCompress(chunks);
  if (gzip) return { algo: ALGO_GZIP, data: gzip };
  return { algo: ALGO_NONE, data: _concatChunks(chunks) };
}

/**
 * @param {number} algo
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function _decompress(algo, bytes) {
  if (algo === ALGO_NONE) return bytes;
  if (algo === ALGO_BROTLI) {
    if (isNode) {
      const zlib = await _nodeZlib();
      return new Uint8Array(zlib.brotliDecompressSync(Buffer.from(bytes)));
    }
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('[ddraw] brotli decompression not supported in this environment');
    }
    return _pipeThroughStream([bytes], new DecompressionStream('brotli'));
  }
  if (algo === ALGO_GZIP) {
    if (typeof DecompressionStream !== 'undefined') {
      return _pipeThroughStream([bytes], new DecompressionStream('gzip'));
    }
    if (isNode) {
      const zlib = await _nodeZlib();
      return new Uint8Array(zlib.gunzipSync(Buffer.from(bytes)));
    }
    throw new Error('[ddraw] gzip decompression not supported in this environment');
  }
  throw new Error(`[ddraw] unknown compression algo ${algo}`);
}

// ── v1/v2 legacy decode support (gzip-only, base64-inlined binaries) ───────

/** Legacy JSON reviver: turns `{ __u8: base64 }` back into a Uint8Array. */
function _legacyReviver(_key, value) {
  if (value && typeof value === 'object' && typeof value.__u8 === 'string') {
    const bin = atob(value.__u8);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return value;
}

async function _legacyGunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    if (isNode) {
      const zlib = await _nodeZlib();
      return new Uint8Array(zlib.gunzipSync(Buffer.from(bytes)));
    }
    return bytes;
  }
  return _pipeThroughStream([bytes], new DecompressionStream('gzip'));
}

function _legacyAttachVisualCheckpointBlobs(recording, blobs) {
  const vc = recording?.visualCheckpoints;
  if (!Array.isArray(vc) || vc.length === 0) return recording;
  recording.visualCheckpoints = vc
    .map((entry) => {
      const idx = entry?.blobIndex;
      if (typeof idx !== 'number' || idx < 0 || idx >= blobs.length) return null;
      return { ts: entry.ts, blob: blobs[idx] };
    })
    .filter(Boolean);
  return recording;
}

async function _decodeLegacy(bytes, version) {
  const flags = bytes[6];
  let jsonStart;
  let jsonEnd;
  if (version === 1) {
    jsonStart = HEADER_V1_SIZE;
    jsonEnd = bytes.length;
  } else {
    if (bytes.length < HEADER_V2_SIZE) throw new Error('[ddraw] truncated v2 header');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = dv.getUint32(9, true);
    jsonStart = HEADER_V2_SIZE;
    jsonEnd = HEADER_V2_SIZE + jsonLength;
    if (jsonEnd > bytes.length) throw new Error('[ddraw] truncated JSON section');
  }

  let payload = bytes.subarray(jsonStart, jsonEnd);
  if (flags & V2_FLAG_GZIP) payload = await _legacyGunzip(payload);

  const json = new TextDecoder().decode(payload);
  const recording = JSON.parse(json, _legacyReviver);

  if (version === 2 && (flags & V2_FLAG_BLOBS)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = jsonEnd;
    if (offset + 4 > bytes.length) throw new Error('[ddraw] truncated blob section');
    const blobCount = dv.getUint32(offset, true);
    offset += 4;
    const blobs = [];
    for (let i = 0; i < blobCount; i++) {
      if (offset + 4 > bytes.length) throw new Error('[ddraw] truncated blob length');
      const len = dv.getUint32(offset, true);
      offset += 4;
      if (offset + len > bytes.length) throw new Error('[ddraw] truncated blob data');
      const chunk = bytes.slice(offset, offset + len);
      blobs.push(new Blob([chunk], { type: 'image/webp' }));
      offset += len;
    }
    _legacyAttachVisualCheckpointBlobs(recording, blobs);
  }

  return recording;
}

// ── v3 encode/decode ────────────────────────────────────────────────────────

/**
 * Recursively pull every Uint8Array/Blob out of `node`, pushing `{ kind, raw }`
 * onto `blobs` and replacing the value in the returned tree with
 * `{ __u8ref: index }`. Async because materialising a Blob's bytes is async.
 */
async function _extractBinaries(node, blobs) {
  if (node instanceof Uint8Array) {
    const idx = blobs.length;
    blobs.push({ kind: 0, raw: node });
    return { __u8ref: idx };
  }
  if (typeof Blob !== 'undefined' && node instanceof Blob) {
    const raw = new Uint8Array(await node.arrayBuffer());
    const idx = blobs.length;
    blobs.push({ kind: 1, raw });
    return { __u8ref: idx };
  }
  if (Array.isArray(node)) {
    const out = new Array(node.length);
    for (let i = 0; i < node.length; i++) out[i] = await _extractBinaries(node[i], blobs);
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const k in node) out[k] = await _extractBinaries(node[k], blobs);
    return out;
  }
  return node;
}

/** Inverse of `_extractBinaries`: replace `{ __u8ref: index }` with the resolved blob. */
function _reviveRefs(node, blobs) {
  if (Array.isArray(node)) return node.map((x) => _reviveRefs(x, blobs));
  if (node && typeof node === 'object') {
    if (typeof node.__u8ref === 'number' && Object.keys(node).length === 1) {
      return blobs[node.__u8ref];
    }
    const out = {};
    for (const k in node) out[k] = _reviveRefs(node[k], blobs);
    return out;
  }
  return node;
}

/**
 * Encode a ReplayRecording bundle as a .ddraw Blob.
 * @param {import('./Recorder.js').ReplayRecording} recording
 * @returns {Promise<Blob>}
 */
export async function encodeDdraw(recording) {
  if (!recording) throw new Error('[ddraw] no recording');

  const blobs = []; // { kind: 0|1, raw: Uint8Array }[]
  const stripped = await _extractBinaries(recording, blobs);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(stripped));
  const { algo: jsonAlgo, data: jsonBody } = await _compress(jsonBytes);

  const hasBlobs = blobs.length > 0;
  let blobSection = new Uint8Array(0);
  let blobAlgo = ALGO_NONE;

  if (hasBlobs) {
    // Compressed as one stream of chunks rather than concatenated into a
    // single buffer first — for a long multi-user recording that buffer
    // (every checkpoint/layer snapshot for the whole tape, back to back)
    // can be the single largest allocation in the encode.
    const compressed = await _compress(blobs.map((b) => b.raw));
    blobAlgo = compressed.algo;

    const metaSize = 4 + blobs.length * 5; // u32 count + per-blob (u8 kind, u32 len)
    blobSection = new Uint8Array(metaSize + 4 + compressed.data.length);
    const mdv = new DataView(blobSection.buffer);
    mdv.setUint32(0, blobs.length, true);
    let p = 4;
    for (const b of blobs) {
      blobSection[p] = b.kind;
      p += 1;
      mdv.setUint32(p, b.raw.length, true);
      p += 4;
    }
    mdv.setUint32(p, compressed.data.length, true);
    p += 4;
    blobSection.set(compressed.data, p);
  }

  const out = new Uint8Array(HEADER_V3_SIZE + jsonBody.length + blobSection.length);
  out.set(MAGIC, 0);
  out[5] = FORMAT_VERSION;
  out[6] = hasBlobs ? V3_FLAG_BLOBS : 0;
  out[7] = jsonAlgo;
  out[8] = blobAlgo;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(9, jsonBody.length, true);
  out[13] = 0;
  out[14] = 0;
  out.set(jsonBody, HEADER_V3_SIZE);
  out.set(blobSection, HEADER_V3_SIZE + jsonBody.length);

  return new Blob([out], { type: 'application/x-ddraw-replay' });
}

async function _decodeV3(bytes) {
  if (bytes.length < HEADER_V3_SIZE) throw new Error('[ddraw] truncated v3 header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[6];
  const jsonAlgo = bytes[7];
  const blobAlgo = bytes[8];
  const jsonLength = dv.getUint32(9, true);
  const jsonStart = HEADER_V3_SIZE;
  const jsonEnd = jsonStart + jsonLength;
  if (jsonEnd > bytes.length) throw new Error('[ddraw] truncated JSON section');

  const jsonBytes = await _decompress(jsonAlgo, bytes.subarray(jsonStart, jsonEnd));
  const obj = JSON.parse(new TextDecoder().decode(jsonBytes));

  let blobs = [];
  if (flags & V3_FLAG_BLOBS) {
    let offset = jsonEnd;
    if (offset + 4 > bytes.length) throw new Error('[ddraw] truncated blob metadata');
    const blobCount = dv.getUint32(offset, true);
    offset += 4;
    const metas = [];
    for (let i = 0; i < blobCount; i++) {
      if (offset + 5 > bytes.length) throw new Error('[ddraw] truncated blob metadata entry');
      const kind = bytes[offset];
      offset += 1;
      const rawLen = dv.getUint32(offset, true);
      offset += 4;
      metas.push({ kind, rawLen });
    }
    if (offset + 4 > bytes.length) throw new Error('[ddraw] truncated blob body length');
    const compressedBodyLength = dv.getUint32(offset, true);
    offset += 4;
    if (offset + compressedBodyLength > bytes.length) throw new Error('[ddraw] truncated blob body');
    const compressedBody = bytes.subarray(offset, offset + compressedBodyLength);

    const concat = await _decompress(blobAlgo, compressedBody);
    let p = 0;
    for (const m of metas) {
      const raw = concat.slice(p, p + m.rawLen);
      p += m.rawLen;
      blobs.push(m.kind === 1 ? new Blob([raw], { type: 'image/webp' }) : raw);
    }
  }

  return _reviveRefs(obj, blobs);
}

/**
 * Decode a .ddraw file (Blob, File, or ArrayBuffer) back into a recording.
 * @param {Blob | ArrayBuffer | Uint8Array} input
 * @returns {Promise<import('./Recorder.js').ReplayRecording>}
 */
export async function decodeDdraw(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (input && typeof input.arrayBuffer === 'function') {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else {
    throw new Error('[ddraw] unsupported input type');
  }
  if (bytes.length < HEADER_V1_SIZE) throw new Error('[ddraw] file too small');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('[ddraw] bad magic');
  }
  const version = bytes[5];
  if (version === 3) return _decodeV3(bytes);
  if (version === 1 || version === 2) return _decodeLegacy(bytes, version);
  throw new Error(`[ddraw] unsupported version ${version}`);
}

/**
 * Detect whether a filename or MIME suggests a .ddraw bundle.
 * @param {{ name?: string, type?: string }} file
 */
export function isDdrawFile(file) {
  if (!file) return false;
  if (typeof file.name === 'string' && /\.ddraw$/i.test(file.name)) return true;
  if (file.type === 'application/x-ddraw-replay') return true;
  return false;
}

/**
 * Build a default filename for the given recording, like
 *   ddraw_replay_2026-05-22_14-30-12.ddraw
 * @param {import('./Recorder.js').ReplayRecording} rec
 */
export function suggestDdrawFilename(rec) {
  const d = new Date(rec?.startedAt ?? Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `ddraw_replay_${stamp}.ddraw`;
}
