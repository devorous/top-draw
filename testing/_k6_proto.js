/**
 * Shared Protobuf encoding helpers for k6 stress tests.
 * Handles delta-encoded, quantized mouse movement packets (ps field)
 * and the full set of fields used by the all-inclusive stress suite
 * (selection/homography, text+fonts, blend modes, image-tool payloads).
 */

/**
 * Encodes an unsigned integer as a Protobuf varint.
 * @param {number} value - The value to encode.
 * @returns {number[]} - The byte array representation.
 */
export function encodeVarint(value) {
  let bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value & 0xFF);
  return bytes;
}

/**
 * ZigZag encodes a signed integer (for use with sint32/sint64).
 * Maps -1→1, -2→3, 0→0, 1→2, 2→4, etc.
 * @param {number} value - The signed integer.
 * @returns {number} - The ZigZag encoded value.
 */
export function zigzagEncode(value) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

/**
 * Encodes a Protobuf tag (field number + wire type) as a varint.
 * @param {number} fieldNumber
 * @param {number} wireType - 0=varint, 1=64-bit, 2=length-delim, 5=32-bit
 * @returns {number[]}
 */
function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/**
 * Encodes a 32-bit float as little-endian 4 bytes (proto fixed32 / float).
 * @param {number} value
 * @returns {Uint8Array}
 */
function encodeFloat32(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return new Uint8Array(buf);
}

/**
 * Encodes the `ps` field: quantized (×10), delta-encoded points, ZigZag + varint.
 * First point is absolute; subsequent points are deltas from previous.
 * @param {Array<number>} points - Flat array: [x1, y1, x2, y2, ...].
 * @returns {Uint8Array}
 */
export function encodePs(points) {
  if (!points || points.length === 0) return new Uint8Array([]);

  const psBody = [];
  let prevQx = 0;
  let prevQy = 0;

  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];

    const qx = Math.floor(x * 10);
    const qy = Math.floor(y * 10);

    let dx, dy;
    if (i === 0) {
      dx = qx;
      dy = qy;
    } else {
      dx = qx - prevQx;
      dy = qy - prevQy;
    }

    prevQx = qx;
    prevQy = qy;

    psBody.push(...encodeVarint(zigzagEncode(dx)));
    psBody.push(...encodeVarint(zigzagEncode(dy)));
  }

  return new Uint8Array(psBody);
}

/**
 * Encodes a packed `repeated float` field (e.g. selection corners `cr`).
 * @param {Array<number>} values
 * @returns {Uint8Array} - Body only (no tag/length prefix).
 */
function encodePackedFloats(values) {
  if (!values || values.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    dv.setFloat32(i * 4, values[i], true);
  }
  return out;
}

/**
 * Encodes a UTF-8 string body (no tag/length prefix).
 * @param {string} str
 * @returns {Uint8Array}
 */
function encodeStringBody(str) {
  // K6's runtime does not expose TextEncoder reliably; use char codes.
  // Stress tests only emit ASCII/safe-Latin1 payloads (JSON, simple text).
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xFF;
  return arr;
}

/**
 * Helper: pushes a length-delimited field (wire type 2).
 * @param {number[]} parts
 * @param {number} fieldNumber
 * @param {Uint8Array} body
 */
function pushLenDelim(parts, fieldNumber, body) {
  const tag = encodeTag(fieldNumber, 2);
  const len = encodeVarint(body.length);
  const out = new Uint8Array(tag.length + len.length + body.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(body, tag.length + len.length);
  parts.push(out);
}

/** Push a varint-encoded uint field. */
function pushVarint(parts, fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 0);
  const v = encodeVarint(value >>> 0);
  parts.push(new Uint8Array([...tag, ...v]));
}

/** Push a fixed32 little-endian integer (e.g. color). */
function pushFixed32(parts, fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 5);
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, value, true);
  parts.push(new Uint8Array([...tag, ...new Uint8Array(buf)]));
}

/** Push a 32-bit float (wire type 5). */
function pushFloat(parts, fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 5);
  parts.push(new Uint8Array([...tag, ...encodeFloat32(value)]));
}

/** Push a packed repeated float field. */
function pushPackedFloats(parts, fieldNumber, values) {
  pushLenDelim(parts, fieldNumber, encodePackedFloats(values));
}

/** Push a string field. */
function pushString(parts, fieldNumber, str) {
  pushLenDelim(parts, fieldNumber, encodeStringBody(str));
}

/**
 * Builds a binary Protobuf message with the application's schema.
 * Recognized fields (see public/messages.proto):
 *   t, u, ps, rs, p, s, l, c, a, m, n, g
 *   sx, sy, sw, sh, cr (selection / homography)
 *   sp, sm, hd, br, ly, bm, bbm (tool settings)
 *   stroke_ts, stroke_redo, stroke_redo_batch
 *   th, sim (ink)
 *   pb, pm (pattern)
 *   fo, tm, to (text+font)
 *   sdm (shape draw mode)
 *   mk (selection mask)
 *   cb, cbt (selection source crop)
 *   image_tool_type, image_tool_data (IMAGE_TOOL payload)
 *   text_id, text_lifetime_ms, text_fade_ms, text_pixel (text overlay)
 *
 * @param {Object} fields - The message fields to include.
 * @returns {ArrayBuffer}
 */
export function buildMsg(fields) {
  const parts = [];

  // === Core high-frequency fields ===
  if (fields.t !== undefined)  pushVarint(parts, 1, fields.t);
  if (fields.u !== undefined)  pushVarint(parts, 2, fields.u);

  if (fields.ps !== undefined) {
    const body = encodePs(fields.ps);
    if (body.length > 0) pushLenDelim(parts, 3, body);
  }

  if (fields.p !== undefined)  pushVarint(parts, 4, fields.p);
  if (fields.s !== undefined)  pushVarint(parts, 5, fields.s);
  // Stamp metadata, one entry per point pair in `ps`: radii for pen/blur,
  // deterministic seeds for confetti. Real clients send this on every
  // broadcastStampMove / broadcastMouseDown; without it a bot's stamped
  // strokes render at a single uniform width on every receiver.
  if (fields.rs !== undefined) pushPackedFloats(parts, 13, fields.rs);
  if (fields.l !== undefined)  pushVarint(parts, 6, fields.l);
  if (fields.c !== undefined)  pushFixed32(parts, 7, fields.c);
  if (fields.a !== undefined)  pushVarint(parts, 8, fields.a ? 1 : 0);
  if (fields.m !== undefined)  pushVarint(parts, 9, fields.m ? 1 : 0);
  if (fields.k !== undefined)  pushString(parts, 10, String(fields.k));
  if (fields.n !== undefined)  pushString(parts, 11, String(fields.n));
  if (fields.g !== undefined)  pushString(parts, 12, String(fields.g));

  // === Lower-frequency fields ===
  if (fields.sp !== undefined) pushVarint(parts, 16, fields.sp);

  // Selection rect (int32: 18-21)
  if (fields.sx !== undefined) pushVarint(parts, 18, fields.sx);
  if (fields.sy !== undefined) pushVarint(parts, 19, fields.sy);
  if (fields.sw !== undefined) pushVarint(parts, 20, fields.sw);
  if (fields.sh !== undefined) pushVarint(parts, 21, fields.sh);

  // Selection control region / homography corners (packed repeated float)
  if (fields.cr !== undefined) pushPackedFloats(parts, 22, fields.cr);

  if (fields.sm !== undefined) pushVarint(parts, 23, fields.sm);
  if (fields.hd !== undefined) pushVarint(parts, 28, fields.hd);
  if (fields.br !== undefined) pushVarint(parts, 43, fields.br);
  if (fields.ly !== undefined) pushVarint(parts, 44, fields.ly);
  if (fields.bm !== undefined) pushString(parts, 45, String(fields.bm));
  if (fields.bbm !== undefined) pushString(parts, 74, String(fields.bbm));

  if (fields.stroke_ts !== undefined) pushVarint(parts, 46, fields.stroke_ts);

  // Ink thinning / simulate pressure
  if (fields.th !== undefined)  pushVarint(parts, 59, fields.th);
  if (fields.sim !== undefined) pushVarint(parts, 60, fields.sim);

  // Pattern brush data and pattern mode
  if (fields.pb !== undefined)  pushString(parts, 83, String(fields.pb));
  if (fields.pm !== undefined)  pushVarint(parts, 84, fields.pm ? 1 : 0);

  // Text font / baseline (CF message + USERS)
  if (fields.fo !== undefined)  pushString(parts, 85, String(fields.fo));
  if (fields.tm !== undefined)  pushFloat(parts, 86, fields.tm);
  if (fields.to !== undefined)  pushFloat(parts, 87, fields.to);

  // Shape draw mode ('corner-to-corner' | 'center-scaling')
  if (fields.sdm !== undefined) pushString(parts, 88, String(fields.sdm));

  // Selection mask active flag
  if (fields.mk !== undefined)  pushVarint(parts, 89, fields.mk ? 1 : 0);

  // Selection source crop / cumulative source crop (packed repeated float)
  if (fields.cb !== undefined)  pushPackedFloats(parts, 154, fields.cb);
  if (fields.cbt !== undefined) pushPackedFloats(parts, 155, fields.cbt);

  // IMAGE_TOOL payload (confetti / pattern / image-brush JSON)
  if (fields.image_tool_type !== undefined) pushString(parts, 159, String(fields.image_tool_type));
  if (fields.image_tool_data !== undefined) pushString(parts, 160, String(fields.image_tool_data));
  // Aliases matching app-side camelCase usage
  if (fields.imageToolType !== undefined && fields.image_tool_type === undefined) pushString(parts, 159, String(fields.imageToolType));
  if (fields.imageToolData !== undefined && fields.image_tool_data === undefined) pushString(parts, 160, String(fields.imageToolData));

  // Text overlay fields
  if (fields.text_id !== undefined)           pushString(parts, 164, String(fields.text_id));
  if (fields.text_lifetime_ms !== undefined)  pushVarint(parts, 165, fields.text_lifetime_ms);
  if (fields.text_fade_ms !== undefined)      pushVarint(parts, 166, fields.text_fade_ms);
  if (fields.text_pixel !== undefined)        pushVarint(parts, 168, fields.text_pixel ? 1 : 0);

  let totalLength = 0;
  for (const p of parts) totalLength += p.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result.buffer;
}
