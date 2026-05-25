/**
 * Shared action helpers for the all-inclusive k6 stress test suite.
 *
 * Each helper composes one or more Protobuf messages (via _k6_proto.buildMsg)
 * representing a high-level user action — drawing a stroke, performing a
 * selection + homography transform, typing text with a font, configuring
 * the confetti/pattern brushes, applying a blend mode, flood fill, etc.
 *
 * Tests pull from these helpers to build realistic, all-tools-exercised
 * traffic. The behavior tests pick actions randomly per profile; the
 * ordered tests cycle every tool through the full set sequentially.
 */

import { buildMsg } from './_k6_proto.js';

// ─── Wire-level constants (mirror proto T enum) ─────────────────────────────

export const T = {
  CONNECT: 0,
  MM: 10, MD: 11, MU: 12, CP: 13, CS: 14, CT: 15, CC: 16, CSP: 17,
  KP: 19, CLR: 20, MSG: 22, GMP: 23, SHOW_CURSOR: 28, CSM: 29,
  SEL_LIFT: 30, SEL_MOVE: 31, SEL_COMMIT: 32, SEL_DELETE: 33,
  SEL_FILL: 34, SEL_STAMP: 35, SEL_CANCEL: 36, SEL_FLIP: 67,
  SEL_PENDING: 68, SEL_MASK: 93,
  CHD: 45, CBR: 57, CL: 58, CBM: 59,
  UNDO: 60, REDO: 61,
  CTHN: 71, CSIM: 72, FILL: 73,
  GPT: 82, CPM: 84,
  CSDM: 91, TEXT_APPLY: 90, CF: 116,
  IMAGE_TOOL: 134,
};

// ─── Tool enum (matches proto Tool enum) ────────────────────────────────────

export const Tool = {
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3, SELECT: 4,
  PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8, INK: 9,
  INKDROPPER: 10, BLUR: 11, CIRCLE_BLUR: 12, GLITCH_BLUR: 13,
  PIXEL: 14, FLOODFILL: 15, PATTERN: 16, CONFETTI: 17,
};

export const TOOL_NAMES = Object.fromEntries(
  Object.entries(Tool).map(([name, idx]) => [idx, name])
);

/** Every drawable tool in id order. */
export const ALL_TOOLS = Object.values(Tool);

export function isFillTargetTool(tool) {
  return tool === Tool.BRUSH ||
         tool === Tool.PEN ||
         tool === Tool.INK ||
         tool === Tool.PIXEL ||
         tool === Tool.IMAGE_BRUSH ||
         tool === Tool.PATTERN;
}

// ─── Common content / settings ──────────────────────────────────────────────

export const TEXT_PHRASES = [
  'hello!', 'nice', 'cool drawing', 'lol', 'hey', 'sup', ':)', 'wow', 'brb',
  'nice work', 'test', 'drawing', 'awesome', 'haha', 'cool', 'ty', 'thanks',
  'sweet', 'hi', 'yo', 'art', 'nice!', 'omg', 'epic', 'gg', 'whoa', 'neat',
];

export const FONTS = [
  'Arial',
  'Comic Sans MS',
  'Courier New',
  'Georgia',
  'Impact',
  'Times New Roman',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Helvetica',
];

export const BLEND_MODES = [
  'source-over',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
];

export const SHAPE_DRAW_MODES = ['corner-to-corner', 'center-scaling'];

export const COMMON_COLORS = [
  0x000000FF, 0xFF0000FF, 0x0000FFFF, 0x00FF00FF, 0xFFFF00FF, 0xFF00FFFF,
  0x00FFFFFF, 0xFFFFFFFF, 0x808080FF, 0xFFA500FF, 0x800080FF, 0x8B4513FF,
  0xFFC0CBFF, 0x90EE90FF,
];

// Tiny 1x1 fully-transparent PNG. NOT sent by default for SEL_LIFT — the
// previous version of this helper attached this as `g` on every selection
// lift, which forced receivers' handleSelectionLift to stretch a 1x1 image
// over the entire selection rect (baking a solid rectangle on commit). Bots
// have no canvas, so the correct path is to omit `g` entirely: the server
// falls through to default broadcast (server/index.js SEL_LIFT case), and
// the receiver's _populateLiftedSelectionFromLayer captures the real pixels
// from its own copy of the user's active layer. Only kept exported because
// a handful of tests pass it explicitly via opts.imageData to exercise the
// image-load codepath specifically.
export const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

// Available GIMP brushes shipped with the app.
export const GIMP_BRUSHES = ['pepper.gbr', 'pixel.gbr', 'galaxy_small.gbr'];

// ─── Random helpers ─────────────────────────────────────────────────────────

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
export function randColor() {
  if (Math.random() < 0.7) return pick(COMMON_COLORS);
  const r = randInt(0, 255), g = randInt(0, 255), b = randInt(0, 255);
  return ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;
}

// ─── Tool-setting payload builders ──────────────────────────────────────────

/**
 * Build a confetti settings JSON payload for IMAGE_TOOL.
 */
export function makeConfettiPayload() {
  const shapes = ['circle', 'square', 'image'];
  const colorModes = ['active', 'random', 'image'];
  const rotationModes = ['random', 'fixed', 'follow'];
  return JSON.stringify({
    confettiParticles:         randInt(3, 12),
    confettiParticleSize:      randInt(6, 22),
    confettiSizeVariation:     randInt(0, 100),
    confettiOpacityRandomness: randInt(0, 100),
    confettiSpacing:           randInt(10, 50),
    confettiShape:             pick(shapes),
    confettiColorMode:         pick(colorModes),
    confettiRotationMode:      pick(rotationModes),
  });
}

/**
 * Build a pattern brush JSON payload for GPT / IMAGE_TOOL.
 */
export function makePatternPayload() {
  return JSON.stringify({
    url: `brushes/${pick(GIMP_BRUSHES)}`,
    scale: 0.5 + Math.random() * 1.5,
    rotation: Math.random() * 360,
    blendMode: pick(BLEND_MODES),
  });
}

/**
 * Build an image-brush (GIMP) JSON payload for GMP message.
 */
export function makeGimpPayload() {
  return JSON.stringify({ url: `brushes/${pick(GIMP_BRUSHES)}` });
}

// ─── Action helpers — each sends a coherent group of messages ───────────────

/**
 * Configure the user's basic tool state: tool/color/size + tool-specific
 * settings (hardness, smoothing, spacing, ink thinning/sim, blur radius,
 * shape draw mode, pattern/confetti payloads, gimp image-brush payload).
 *
 * Also sends SHOW_CURSOR so the bot is visible.
 *
 * @param {object} socket - k6 ws socket
 * @param {number} u      - session index
 * @param {number} tool   - Tool enum value
 * @param {object} [opts]
 *   color, size, hardness, smoothing, spacing, thinning, simPressure,
 *   blurRadius, shapeDrawMode, blendMode, activeLayer, patternMode,
 *   patternData, confettiData, gimpData
 */
export function configureTool(socket, u, tool, opts = {}) {
  const color    = opts.color    ?? randColor();
  const size     = opts.size     ?? randInt(500, 3500);
  const hardness = opts.hardness ?? randInt(20, 100);
  const smoothing= opts.smoothing?? randInt(0, 50);
  const spacing  = opts.spacing  ?? randInt(100, 600);

  socket.sendBinary(buildMsg({ t: T.CT, u, l: tool }));
  socket.sendBinary(buildMsg({ t: T.CC, u, c: color }));
  socket.sendBinary(buildMsg({ t: T.CS, u, s: size }));
  socket.sendBinary(buildMsg({ t: T.CHD, u, hd: hardness }));
  socket.sendBinary(buildMsg({ t: T.CSM, u, sm: smoothing }));
  socket.sendBinary(buildMsg({ t: T.CSP, u, sp: spacing }));

  if (opts.activeLayer !== undefined) {
    socket.sendBinary(buildMsg({ t: T.CL, u, ly: opts.activeLayer }));
  }
  if (opts.blendMode !== undefined) {
    socket.sendBinary(buildMsg({ t: T.CBM, u, bm: opts.blendMode }));
  }

  // Tool-specific extras
  if (tool === Tool.BLUR || tool === Tool.CIRCLE_BLUR || tool === Tool.GLITCH_BLUR) {
    socket.sendBinary(buildMsg({ t: T.CBR, u, br: opts.blurRadius ?? randInt(100, 2000) }));
  }
  if (tool === Tool.INK) {
    socket.sendBinary(buildMsg({ t: T.CTHN, u, th: opts.thinning ?? randInt(0, 100) }));
    socket.sendBinary(buildMsg({ t: T.CSIM, u, sim: (opts.simPressure ?? (Math.random() > 0.5)) ? 1 : 0 }));
  }
  if (tool === Tool.RECTANGLE || tool === Tool.CIRCLE) {
    socket.sendBinary(buildMsg({ t: T.CSDM, u, g: pick(SHAPE_DRAW_MODES) }));
  }
  if (tool === Tool.IMAGE_BRUSH) {
    socket.sendBinary(buildMsg({ t: T.GMP, u, g: opts.gimpData ?? makeGimpPayload() }));
  }
  if (tool === Tool.PATTERN) {
    const data = opts.patternData ?? makePatternPayload();
    socket.sendBinary(buildMsg({ t: T.GPT, u, g: data }));
    socket.sendBinary(buildMsg({ t: T.IMAGE_TOOL, u, image_tool_type: 'pattern', image_tool_data: data }));
    if (opts.patternMode !== undefined) {
      socket.sendBinary(buildMsg({ t: T.CPM, u, pm: opts.patternMode }));
    }
  }
  if (tool === Tool.CONFETTI) {
    const data = opts.confettiData ?? makeConfettiPayload();
    socket.sendBinary(buildMsg({ t: T.IMAGE_TOOL, u, image_tool_type: 'confetti', image_tool_data: data }));
  }

  socket.sendBinary(buildMsg({ t: T.SHOW_CURSOR, u }));
}

/**
 * Send a single MM (move) message at the given coords.
 * @param {object} socket
 * @param {number} u
 * @param {number} x
 * @param {number} y
 * @param {boolean} [stamp=false] - include stroke_ts for latency tracking
 */
export function sendMove(socket, u, x, y, stamp = false) {
  const m = { t: T.MM, u, ps: [x, y] };
  if (stamp) m.stroke_ts = Date.now();
  socket.sendBinary(buildMsg(m));
}

export function sendDown(socket, u, x, y) {
  socket.sendBinary(buildMsg({ t: T.MD, u, ps: [x, y] }));
}

export function sendUp(socket, u) {
  socket.sendBinary(buildMsg({ t: T.MU, u }));
}

/**
 * Type text on the board with an explicit font. Sends CF (font/baseline)
 * then TEXT_APPLY (text + position).
 */
export function applyTextWithFont(socket, u, x, y, text, font, opts = {}) {
  const fontFamily = font ?? pick(FONTS);
  socket.sendBinary(buildMsg({
    t: T.CF, u,
    fo: fontFamily,
    tm: opts.tm ?? 1.0,
    to: opts.to ?? 0.0,
  }));
  socket.sendBinary(buildMsg({
    t: T.TEXT_APPLY, u,
    g: text,
    ps: [x, y],
    fo: fontFamily,
    text_id: opts.textId ?? `txt_${u}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    text_pixel: opts.textPixel ? 1 : 0,
    text_lifetime_ms: opts.textLifetimeMs ?? 0,
    text_fade_ms: opts.textFadeMs ?? 0,
  }));
}

/**
 * Perform a flood fill at (x, y) with the current color.
 */
export function applyFloodFill(socket, u, x, y, color) {
  const msg = { t: T.FILL, u, ps: [x, y] };
  if (color !== undefined) msg.c = color;
  socket.sendBinary(buildMsg(msg));
}

/**
 * Set an arbitrary blend mode (CBM).
 */
export function setBlendMode(socket, u, mode) {
  socket.sendBinary(buildMsg({ t: T.CBM, u, bm: mode ?? pick(BLEND_MODES) }));
}

/**
 * Perform a complete selection → homography transform → commit sequence.
 *
 * Sends:
 *   SEL_LIFT  with a small rect + dummy image payload (server requires g)
 *   SEL_MOVE  with 8-float corner array (tl, tr, br, bl) describing a
 *             perspective transform (homography)
 *   SEL_COMMIT (bakes the selection)
 *
 * @param {object} socket
 * @param {number} u
 * @param {object} [opts] { rect, corners }
 *   rect    – {x,y,width,height} on the board
 *   corners – {tl,tr,br,bl} target corners after homography; defaults to a
 *             trapezoid offset to the right with a perspective shrink
 */
export function performSelectionTransform(socket, u, opts = {}) {
  const rect = opts.rect ?? {
    x: randInt(200, 1200),
    y: randInt(200, 700),
    width: randInt(120, 300),
    height: randInt(120, 300),
  };
  const tl = { x: rect.x, y: rect.y };
  const tr = { x: rect.x + rect.width, y: rect.y };
  const br = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bl = { x: rect.x, y: rect.y + rect.height };

  // A perspective warp: shift right, shrink right edge ~25% to test homography
  const dx = randInt(100, 250);
  const dy = randInt(-60, 60);
  const shrink = 0.6 + Math.random() * 0.4;
  const corners = opts.corners ?? {
    tl: { x: tl.x + dx,                 y: tl.y + dy },
    tr: { x: tr.x + dx,                 y: tr.y + dy + (rect.height * (1 - shrink) * 0.5) },
    br: { x: br.x + dx,                 y: br.y + dy - (rect.height * (1 - shrink) * 0.5) },
    bl: { x: bl.x + dx,                 y: bl.y + dy },
  };

  // No `g` (image payload): receivers populate the floating canvas from their
  // own layer pixels via _populateLiftedSelectionFromLayer, which is what a
  // real lift would produce here. Sending a placeholder image causes the
  // receiver to stretch it over the whole selection on commit.
  socket.sendBinary(buildMsg({
    t: T.SEL_LIFT, u,
    sx: Math.round(rect.x),
    sy: Math.round(rect.y),
    sw: Math.round(rect.width),
    sh: Math.round(rect.height),
  }));

  socket.sendBinary(buildMsg({
    t: T.SEL_MOVE, u,
    cr: [
      corners.tl.x, corners.tl.y,
      corners.tr.x, corners.tr.y,
      corners.br.x, corners.br.y,
      corners.bl.x, corners.bl.y,
    ],
    cb:  [rect.x, rect.y, rect.width, rect.height],
    cbt: [rect.x, rect.y, rect.width, rect.height],
  }));

  socket.sendBinary(buildMsg({ t: T.SEL_COMMIT, u, ly: opts.layer ?? 0 }));
}

/**
 * Send a SEL_LIFT only — gives the test driver explicit control over the
 * full lift / move / commit / fill / delete / cancel sequence with its own
 * pacing.
 */
export function sendSelLift(socket, u, rect, opts = {}) {
  const msg = {
    t: T.SEL_LIFT, u,
    sx: Math.round(rect.x),
    sy: Math.round(rect.y),
    sw: Math.round(rect.width),
    sh: Math.round(rect.height),
  };
  // Only attach image data when a caller explicitly opts in; otherwise the
  // receiver lifts pixels from its own copy of the active layer (matching
  // what a real local lift would do without round-tripping a PNG).
  if (opts.imageData) {
    msg.g = opts.imageData;
  }
  // Lasso lift: cr is a flat [x0,y0,x1,y1,...] polygon path (≥3 points → ≥6 floats).
  if (opts.lassoPath && opts.lassoPath.length >= 6) {
    msg.cr = opts.lassoPath;
  }
  socket.sendBinary(buildMsg(msg));
}

/**
 * Send a SEL_MOVE describing a perspective transform via 4 corner points
 * (tl, tr, br, bl). cb/cbt source crop is optional.
 */
export function sendSelMove(socket, u, corners, opts = {}) {
  const msg = {
    t: T.SEL_MOVE, u,
    cr: [
      corners.tl.x, corners.tl.y,
      corners.tr.x, corners.tr.y,
      corners.br.x, corners.br.y,
      corners.bl.x, corners.bl.y,
    ],
  };
  if (opts.sourceCrop) {
    msg.cb = [opts.sourceCrop.x, opts.sourceCrop.y, opts.sourceCrop.width, opts.sourceCrop.height];
    msg.cbt = msg.cb;
  }
  socket.sendBinary(buildMsg(msg));
}

export function sendSelCommit(socket, u, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_COMMIT, u, ly: layer }));
}

export function sendSelCancel(socket, u) {
  socket.sendBinary(buildMsg({ t: T.SEL_CANCEL, u }));
}

export function sendSelDelete(socket, u, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_DELETE, u, ly: layer }));
}

export function sendSelFill(socket, u, color, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_FILL, u, c: color, ly: layer }));
}

export function sendSelStamp(socket, u, layer = 0) {
  socket.sendBinary(buildMsg({ t: T.SEL_STAMP, u, ly: layer }));
}

export function sendSelFlip(socket, u) {
  socket.sendBinary(buildMsg({ t: T.SEL_FLIP, u }));
}

/**
 * Send an UNDO message for the current user.
 */
export function sendUndo(socket, u) {
  socket.sendBinary(buildMsg({ t: T.UNDO, u }));
}

// ─── Parser for incoming binary frames (used by latency tracking) ──────────

/**
 * Minimal Protobuf parser that pulls out t/u/stroke_ts from incoming frames.
 * Mirrors the inline parser the original stress tests used.
 *
 * @returns {{ t: number, u: number, ts: number }}
 */
export function parseInbound(data) {
  const view = new Uint8Array(data);
  let t = 0; let u = -1; let ts = -1;
  let offset = 0;
  while (offset < view.length) {
    let tag = 0; let shift = 0;
    while (true) {
      if (offset >= view.length) break;
      const b = view[offset++];
      tag += (b & 0x7F) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 1) {
      let val = 0; let s = 0;
      while (true) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      t = val;
    } else if (fieldNum === 2) {
      let val = 0; let s = 0;
      while (true) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      u = val;
    } else if (fieldNum === 46) {
      let val = 0; let s = 0;
      while (true) { const b = view[offset++]; val += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
      ts = val;
    } else {
      if (wireType === 0) { while (view[offset++] & 0x80); }
      else if (wireType === 1) { offset += 8; }
      else if (wireType === 2) {
        let len = 0; let s = 0;
        while (true) { const b = view[offset++]; len += (b & 0x7F) * Math.pow(2, s); if (!(b & 0x80)) break; s += 7; }
        offset += len;
      }
      else if (wireType === 5) { offset += 4; }
    }
  }
  return { t, u, ts };
}
