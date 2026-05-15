/**
 * @fileoverview Shared message type and tool enums
 * Used by both client and server to ensure consistency
 */

/**
 * Message type enum matching protobuf definitions
 * @enum {number}
 */
export const T = {
  CONNECT: 0, USERS: 1, SETTINGS: 2, LEFT: 3,
  MM: 10, MD: 11, MU: 12, CP: 13, CS: 14, CT: 15, CC: 16,
  CSP: 17, CN: 18, KP: 19, CLR: 20, MIR: 21, MSG: 22, GMP: 23, AFK: 24, PAN: 25, CANCEL: 26,
  HIDE_CURSOR: 27, SHOW_CURSOR: 28, CSM: 29,
  SEL_LIFT: 30, SEL_MOVE: 31, SEL_COMMIT: 32, SEL_DELETE: 33, SEL_FILL: 34, SEL_STAMP: 35, SEL_CANCEL: 36, SEL_TO_BRUSH: 37, IMG_PASTE: 38, DM: 39,
  CHAT_IMG: 40, SYNC_REQUEST: 41, SYNC_PROVIDE: 42, SYNC_CANVAS: 43, SYNC_COMPLETE: 44, CHD: 45,
  SYNC_LAYER_BASE: 46, SYNC_STROKE: 47, SYNC_STROKES_DONE: 48, SYNC_METADATA: 49,
  AUTH_REGISTER: 50, AUTH_LOGIN: 51, AUTH_RESULT: 52,
  MOD_ACTION: 53, MOD_RESULT: 54, MOD_NOTIFY: 55, MOD_LIST: 56,
  CBR: 57, CL: 58, CBM: 59, UNDO: 60, REDO: 61, SYNC_STROKE_BATCH: 62,
  ROOM_LIST_REQUEST: 63, ROOM_LIST_RESPONSE: 64,
  MOD_WIPE: 65, ROOM_UPDATE: 66, SEL_FLIP: 67, SEL_PENDING: 68,
  PING: 69, PONG: 70, CTHN: 71, CSIM: 72, FILL: 73,
  ROOM_ROLE_SET: 74, SYNC_TILE_OWNERSHIP: 75, TILE_UPDATE: 76, TILE_CLEAR: 77,
  ROOM_REGISTER: 78, ROOM_UNREGISTER: 79, ROOM_OWNERSHIP: 80,
  MOD_UNDO_TO_STATE: 81, GPT: 82, GLITCH_RESULT: 83, CPM: 84,
  ROOM_PREVIEW: 85, MIRROR_REGION: 86,
  ROOM_ROLE_LIST_REQUEST: 87, ROOM_ROLE_LIST_RESPONSE: 88,
  GLOBAL_ROLE_SET: 89,
  TEXT_APPLY: 90,
  TEXT_REMOVE: 95,
  CSDM: 91,
  GLOBAL_MESSAGE: 92,
  SEL_MASK: 93,
  OBSCURE_REGION: 94,
  CF: 116,
  BW_PROBE_START: 130, BW_PROBE_CHUNK: 131, BW_REPORT: 132, METRICS_UPDATE: 133,
  IMAGE_TOOL: 134,
  BOARD_SNAPSHOT_SAVE: 96, BOARD_SNAPSHOT_LIST_REQUEST: 97, BOARD_SNAPSHOT_LIST_RESPONSE: 98,
  BOARD_SNAPSHOT_RESTORE: 99, BOARD_SNAPSHOT_DELETE: 100, BOARD_SNAPSHOT_REQUEST: 101,
  BOARD_SNAPSHOT_GET: 102,
  BOARD_SNAPSHOT_REGION_RESTORE: 103,
  BOARD_SNAPSHOT_JOIN_NOTIFY: 104,
  CHECKPOINT_UPLOAD: 110, CHECKPOINT_LIST: 111, CHECKPOINT_LIST_RESPONSE: 112, CHECKPOINT_GET: 113,
  REPLAY_REQUEST: 114, REPLAY_RESPONSE: 115, CHAT_REACTION: 117, STAFF_MSG: 118, STAFF_CHAT_IMG: 119,
  FLOATING_ART_UPDATE: 120,
  COMPRESS_USER_STROKES: 121
};

/**
 * Tool enum matching protobuf definitions
 * @enum {number}
 */
export const Tool = {
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3,
  SELECT: 4, PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8, INK: 9, INKDROPPER: 10, BLUR: 11, CIRCLE_BLUR: 12, GLITCH_BLUR: 13, PIXEL: 14, FLOODFILL: 15, PATTERN: 16, CONFETTI: 17
};

/**
 * Array of tool names corresponding to Tool enum indices
 * @type {string[]}
 */
export const ToolNames = [
  'brush', 'text', 'erase', 'imageBrush',
  'select', 'flowPen', 'line', 'rectangle', 'circle', 'ink', 'inkdropper', 'blur', 'circleBlur', 'glitchBlur', 'pixel', 'fill', 'pattern', 'confetti'
];

/**
 * Mapping from tool name strings to Tool enum indices
 * @type {Object.<string, number>}
 */
export const ToolToEnum = {
  brush: 0, text: 1, erase: 2, imageBrush: 3,
  select: 4, flowPen: 5, line: 6, rectangle: 7, circle: 8, ink: 9, inkdropper: 10, blur: 11, circleBlur: 12, glitchBlur: 13, pixel: 14, fill: 15, pattern: 16, confetti: 17
};
