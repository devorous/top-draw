/**
 * @fileoverview .ddraw file format — pack/unpack a ReplayRecording bundle.
 *
 * Layout (little-endian):
 *   bytes  0..4    magic        "DDRAW"
 *   byte   5       version      1 or 2
 *   byte   6       flags        bit0 = gzipped JSON, bit1 = has blob section (v2+)
 *   bytes  7..8    reserved     0
 *   bytes  9..12   jsonLength   (v2+) length of JSON payload in bytes
 *   bytes 13..N    JSON payload (optionally gzip-compressed)
 *   bytes  N..end  blob section (v2+ when flag bit1 set):
 *                    u32 blobCount
 *                    for each blob: u32 length, then raw bytes
 *
 * Version 1 omits the jsonLength field and blob section — the payload runs
 * straight from byte 9 to EOF. Decoder switches on the version byte.
 *
 * JSON payload is the recording bundle. `visualCheckpoints` entries carry
 * `{ ts, blobIndex }` in JSON; the actual Blob bytes live in the blob section
 * indexed by `blobIndex`. Decode re-hydrates them back to `{ ts, blob }`.
 *
 * Lives in shared/ rather than src/replay/ because the server (Node) needs to
 * decode `.ddraw` bytes too (room_snapshots checkpoints), not just the
 * client. Every Web API this file touches — CompressionStream/
 * DecompressionStream, Blob, atob/btoa, TextEncoder/TextDecoder — is a stable
 * Node global as of Node 18, which is this repo's floor (see package.json
 * engines), so no browser/Node split was needed; encode/decode gzip
 * gracefully no-op if CompressionStream is ever missing (see _gzip/_gunzip).
 */
const MAGIC = new Uint8Array([0x44, 0x44, 0x52, 0x41, 0x57]); // "DDRAW"
const FORMAT_VERSION = 2;
const FLAG_GZIP = 0x01;
const FLAG_BLOBS = 0x02;
const HEADER_V1_SIZE = 9;
const HEADER_V2_SIZE = 13; // adds u32 jsonLength

/**
 * JSON replacer that re-encodes Uint8Array values as a tagged object so
 * decode can rebuild them. Most messages contain only primitives, so this
 * fires very rarely.
 */
function _replacer(_key, value) {
  if (value instanceof Uint8Array) {
    let bin = '';
    for (let i = 0; i < value.length; i++) bin += String.fromCharCode(value[i]);
    return { __u8: btoa(bin) };
  }
  return value;
}

function _reviver(_key, value) {
  if (value && typeof value === 'object' && typeof value.__u8 === 'string') {
    const bin = atob(value.__u8);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return value;
}

async function _gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const blob = await new Response(cs.readable).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

async function _gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') return bytes;
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const blob = await new Response(ds.readable).blob();
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Strip Blob refs out of visualCheckpoints, replacing them with index refs so
 * the JSON section is JSON-safe. Returns `{ stripped, blobs }`.
 */
function _extractVisualCheckpointBlobs(recording) {
  const vc = recording?.visualCheckpoints;
  if (!Array.isArray(vc) || vc.length === 0) {
    return { stripped: recording, blobs: [] };
  }
  const blobs = [];
  const stripped = {
    ...recording,
    visualCheckpoints: vc.map((entry) => {
      if (!entry?.blob) return { ts: entry?.ts ?? 0, blobIndex: -1 };
      const blobIndex = blobs.length;
      blobs.push(entry.blob);
      return { ts: entry.ts, blobIndex };
    }),
  };
  return { stripped, blobs };
}

/**
 * Inverse of _extractVisualCheckpointBlobs — runs after JSON decode.
 */
function _attachVisualCheckpointBlobs(recording, blobs) {
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

/**
 * Encode a ReplayRecording bundle as a .ddraw Blob.
 * @param {import('./Recorder.js').ReplayRecording} recording
 * @returns {Promise<Blob>}
 */
export async function encodeDdraw(recording) {
  if (!recording) throw new Error('[ddraw] no recording');

  const { stripped, blobs } = _extractVisualCheckpointBlobs(recording);
  const json = JSON.stringify(stripped, _replacer);
  const payload = new TextEncoder().encode(json);
  const useGzip = typeof CompressionStream !== 'undefined';
  const jsonBody = useGzip ? await _gzip(payload) : payload;

  // Materialise blob bodies once so we know the byte budget before allocating.
  const blobBuffers = [];
  let blobTotalBytes = 0;
  for (const b of blobs) {
    const buf = new Uint8Array(await b.arrayBuffer());
    blobBuffers.push(buf);
    blobTotalBytes += buf.length;
  }
  const hasBlobs = blobBuffers.length > 0;

  const blobSectionSize = hasBlobs
    ? 4 /* count */ + blobBuffers.length * 4 /* per-blob length */ + blobTotalBytes
    : 0;

  const out = new Uint8Array(HEADER_V2_SIZE + jsonBody.length + blobSectionSize);
  out.set(MAGIC, 0);
  out[5] = FORMAT_VERSION;
  out[6] = (useGzip ? FLAG_GZIP : 0) | (hasBlobs ? FLAG_BLOBS : 0);
  out[7] = 0;
  out[8] = 0;

  // jsonLength as u32 LE
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(9, jsonBody.length, true);
  out.set(jsonBody, HEADER_V2_SIZE);

  if (hasBlobs) {
    let offset = HEADER_V2_SIZE + jsonBody.length;
    dv.setUint32(offset, blobBuffers.length, true);
    offset += 4;
    for (const buf of blobBuffers) {
      dv.setUint32(offset, buf.length, true);
      offset += 4;
      out.set(buf, offset);
      offset += buf.length;
    }
  }

  return new Blob([out], { type: 'application/x-ddraw-replay' });
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
  if (version !== 1 && version !== 2) {
    throw new Error(`[ddraw] unsupported version ${version}`);
  }
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
  if (flags & FLAG_GZIP) payload = await _gunzip(payload);

  const json = new TextDecoder().decode(payload);
  const recording = JSON.parse(json, _reviver);

  if (version === 2 && (flags & FLAG_BLOBS)) {
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
    _attachVisualCheckpointBlobs(recording, blobs);
  }

  return recording;
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
