/**
 * Shared message type and tool enums
 * Used by both client and server to ensure consistency
 */

// Message type enum matching proto
export const T = {
  CONNECT: 0, USERS: 1, SETTINGS: 2, LEFT: 3,
  MM: 10, MD: 11, MU: 12, CP: 13, CS: 14, CT: 15, CC: 16,
  CSP: 17, CN: 18, KP: 19, CLR: 20, MIR: 21, MSG: 22, GMP: 23, AFK: 24, PAN: 25, CANCEL: 26,
  HIDE_CURSOR: 27, SHOW_CURSOR: 28, CSM: 29,
  SEL_LIFT: 30, SEL_MOVE: 31, SEL_COMMIT: 32, SEL_DELETE: 33, SEL_FILL: 34, SEL_STAMP: 35, SEL_CANCEL: 36, SEL_TO_BRUSH: 37, IMG_PASTE: 38, DM: 39,
  CHAT_IMG: 40, SYNC_REQUEST: 41, SYNC_PROVIDE: 42, SYNC_CANVAS: 43, SYNC_COMPLETE: 44, CHD: 45,
  AUTH_REGISTER: 50, AUTH_LOGIN: 51, AUTH_RESULT: 52,
  MOD_ACTION: 53, MOD_RESULT: 54, MOD_NOTIFY: 55, MOD_LIST: 56,
  CBR: 57
};

// Tool enum matching proto
export const Tool = {
  BRUSH: 0, TEXT: 1, ERASE: 2, IMAGE_BRUSH: 3,
  SELECT: 4, PEN: 5, LINE: 6, RECTANGLE: 7, CIRCLE: 8, INK: 9, INKDROPPER: 10, BLUR: 11, CIRCLE_BLUR: 12
};

export const ToolNames = [
  'brush', 'text', 'erase', 'imageBrush',
  'select', 'flowPen', 'line', 'rectangle', 'circle', 'ink', 'inkdropper', 'blur', 'circleBlur'
];

export const ToolToEnum = {
  brush: 0, text: 1, erase: 2, imageBrush: 3,
  select: 4, flowPen: 5, line: 6, rectangle: 7, circle: 8, ink: 9, inkdropper: 10, blur: 11, circleBlur: 12
};
