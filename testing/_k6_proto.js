/**
 * Shared Protobuf encoding helpers for k6 stress tests.
 * Handles delta-encoded, quantized mouse movement packets (ps field).
 */

/**
 * Encodes a signed integer as a Protobuf varint.
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
 * Encodes the `ps` field: quantized (×10), delta-encoded points, ZigZag + varint.
 * First point is absolute; subsequent points are deltas from previous.
 * @param {Array<number>} points - Flat array: [x1, y1, x2, y2, ...]. Can be 1 or more points.
 * @returns {Uint8Array} - Encoded ps field body (without tag/length prefix).
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
      // First point: absolute
      dx = qx;
      dy = qy;
    } else {
      // Subsequent points: delta from previous
      dx = qx - prevQx;
      dy = qy - prevQy;
    }

    prevQx = qx;
    prevQy = qy;

    // ZigZag encode and varint encode each delta
    const encodedDx = encodeVarint(zigzagEncode(dx));
    const encodedDy = encodeVarint(zigzagEncode(dy));

    psBody.push(...encodedDx, ...encodedDy);
  }

  return new Uint8Array(psBody);
}

/**
 * Builds a binary Protobuf message with the application's schema.
 * @param {Object} fields - The message fields to include.
 * @returns {ArrayBuffer} - The serialized binary message.
 */
export function buildMsg(fields) {
  let parts = [];

  // t (field 1, uint32, tag 0x08)
  if (fields.t !== undefined) {
    parts.push(new Uint8Array([0x08, ...encodeVarint(fields.t)]));
  }

  // u (field 2, uint32, tag 0x10)
  if (fields.u !== undefined) {
    parts.push(new Uint8Array([0x10, ...encodeVarint(fields.u)]));
  }

  // ps (field 3, repeated sint32, tag 0x1A, packed)
  if (fields.ps !== undefined) {
    const psBody = encodePs(fields.ps);
    if (psBody.length > 0) {
      const psLength = encodeVarint(psBody.length);
      parts.push(new Uint8Array([0x1A, ...psLength, ...psBody]));
    }
  }

  // p (field 4, uint32, tag 0x20)
  if (fields.p !== undefined) {
    parts.push(new Uint8Array([0x20, ...encodeVarint(fields.p)]));
  }

  // s (field 5, int32, tag 0x28)
  if (fields.s !== undefined) {
    parts.push(new Uint8Array([0x28, ...encodeVarint(fields.s)]));
  }

  // l (field 6, enum Tool, tag 0x30)
  if (fields.l !== undefined) {
    parts.push(new Uint8Array([0x30, ...encodeVarint(fields.l)]));
  }

  // c (field 7, fixed32, tag 0x3D)
  if (fields.c !== undefined) {
    const b = new ArrayBuffer(4);
    new DataView(b).setUint32(0, fields.c, true);
    parts.push(new Uint8Array([0x3D, ...new Uint8Array(b)]));
  }

  // n (field 11, string, tag 0x5A)
  if (fields.n !== undefined) {
    const nameBytes = new Uint8Array(Array.from(fields.n).map(c => c.charCodeAt(0)));
    const nameLength = encodeVarint(nameBytes.length);
    parts.push(new Uint8Array([0x5A, ...nameLength, ...nameBytes]));
  }

  // g (field 12, string, tag 0x62)
  if (fields.g !== undefined) {
    const gBytes = new Uint8Array(Array.from(fields.g).map(c => c.charCodeAt(0)));
    const gLength = encodeVarint(gBytes.length);
    parts.push(new Uint8Array([0x62, ...gLength, ...gBytes]));
  }

  // sp (field 16, uint32, tag 0x80, 0x01)
  if (fields.sp !== undefined) {
    parts.push(new Uint8Array([0x80, 0x01, ...encodeVarint(fields.sp)]));
  }

  // sm (field 23, uint32, tag 0xB8, 0x01)
  if (fields.sm !== undefined) {
    parts.push(new Uint8Array([0xB8, 0x01, ...encodeVarint(fields.sm)]));
  }

  // hd (field 28, uint32, tag 0xE0, 0x01)
  if (fields.hd !== undefined) {
    parts.push(new Uint8Array([0xE0, 0x01, ...encodeVarint(fields.hd)]));
  }

  // br (field 43, uint32, tag 0xD8, 0x02)
  if (fields.br !== undefined) {
    parts.push(new Uint8Array([0xD8, 0x02, ...encodeVarint(fields.br)]));
  }

  // ly (field 44, uint32, tag 0xE0, 0x02)
  if (fields.ly !== undefined) {
    parts.push(new Uint8Array([0xE0, 0x02, ...encodeVarint(fields.ly)]));
  }

  // bm (field 45, string, tag 0xEA, 0x02)
  if (fields.bm !== undefined) {
    const bmBytes = new Uint8Array(Array.from(fields.bm).map(c => c.charCodeAt(0)));
    const bmLength = encodeVarint(bmBytes.length);
    parts.push(new Uint8Array([0xEA, 0x02, ...bmLength, ...bmBytes]));
  }

  // th (field 59, uint32, tag 0xD8, 0x03)
  if (fields.th !== undefined) {
    parts.push(new Uint8Array([0xD8, 0x03, ...encodeVarint(fields.th)]));
  }

  // sim (field 60, uint32, tag 0xE0, 0x03)
  if (fields.sim !== undefined) {
    parts.push(new Uint8Array([0xE0, 0x03, ...encodeVarint(fields.sim)]));
  }

  // stroke_ts (field 46, uint64, tag 0xF0, 0x02)
  if (fields.stroke_ts !== undefined) {
    parts.push(new Uint8Array([0xF0, 0x02, ...encodeVarint(fields.stroke_ts)]));
  }

  let totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  let result = new Uint8Array(totalLength);
  let offset = 0;
  for (let p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result.buffer;
}
