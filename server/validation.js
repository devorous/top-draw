/** @fileoverview Server-side sanitization and validation for inbound WebSocket messages. */

import { T, Tool } from '../shared/MessageTypes.js';
import { CHAT_IMAGE_MIME_TYPES, INLINE_IMAGE_MIME_TYPES, validateDataUrlImage, validateImageBytes } from './imageValidation.js';

function hasOwnField(message, key) {
  return !!message && Object.prototype.hasOwnProperty.call(message, key);
}

const MIN_BRUSH_SIZE = 25;
const MAX_BRUSH_SIZE = 10000;
const MAX_SPACING = 5000;
const MAX_SMOOTHING = 50;
const MAX_HARDNESS = 100;
const MAX_PRESSURE = 100;
const MAX_BLUR_RADIUS = 25;
const MAX_FILL_BLUR_RADIUS = 25;
const MAX_LAYER_INDEX = 4;
const MAX_NAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 500;
const MAX_GLOBAL_MESSAGE_LENGTH = 500;
const MAX_CHAT_MESSAGE_ID_LENGTH = 64;
const MAX_CHAT_REACTION_LENGTH = 16;
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_WIDTH = 8192;
const MAX_INLINE_IMAGE_HEIGHT = 8192;
const MAX_INLINE_IMAGE_PIXELS = 16_777_216;
const MAX_ROOM_PREVIEW_BYTES = 100 * 1024;
const MAX_SYNC_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_IMAGE_PIXELS = 33_554_432;
const MAX_SYNC_BATCH_STROKES = 256;
const MAX_TILE_LIST = 4096;
const MAX_PATH_VALUES = 1024;
const MAX_SELECTION_POINTS = 2048;
const MAX_BRUSH_DATA_LENGTH = 1024 * 1024;
const MAX_MIRROR_REGION_PAYLOAD = 64 * 1024;
const MAX_AUTH_TOKEN_LENGTH = 4096;
const MAX_AUTH_STRING_LENGTH = 256;
const MAX_SECRET_QUESTION_LENGTH = 200;
const MAX_MOD_REASON_LENGTH = 200;
const MAX_ROOM_DESCRIPTION_LENGTH = 200;
const MAX_USERNAME_LOOKUP_LENGTH = 32;
const MAX_COORD = 50000;
const MIN_COORD = -50000;
// ps is transmitted as quantized (x10) delta-encoded sint32. Absolute values
// fit in ±MAX_COORD * 10; deltas can briefly exceed that after a big jump, so
// keep comfortable headroom without letting pathological values through.
const MAX_PS_VALUE = 600000;
const MIN_PS_VALUE = -600000;
const MAX_DIMENSION = 10000;
const MAX_DURATION_MINUTES = 60 * 24 * 365;
const MAX_ROOM_USERS = 60;

const VALID_MESSAGE_TYPES = new Set(Object.values(T));
const VALID_BLEND_MODES = new Set([
  'source-over',
  'multiply',
  'screen',
  'lighter',
  'overlay',
  'darken',
  'lighten',
  'difference',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'destination-out'
]);
const VALID_JOIN_POLICIES = new Set(['open', 'registered', 'trusted']);

const IMAGE_MESSAGE_TYPES = new Set([T.IMG_PASTE, T.SEL_LIFT, T.GLITCH_RESULT]);

const clampInt = (value, min, max, fallback = min) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
};

const sanitizeString = (value, maxLength, { trim = true } = {}) => {
  if (typeof value !== 'string') return '';
  const output = trim ? value.trim() : value;
  return output.slice(0, maxLength);
};

const sanitizeBoolean = (value) => !!value;

const sanitizeFloatArray = (value, {
  min = MIN_COORD,
  max = MAX_COORD,
  maxLength = MAX_PATH_VALUES,
  requireEvenLength = false
} = {}) => {
  if (!Array.isArray(value)) return [];
  const out = [];

  for (const item of value) {
    const num = Number(item);
    if (!Number.isFinite(num)) continue;
    out.push(Math.min(Math.max(num, min), max));
    if (out.length >= maxLength) break;
  }

  if (requireEvenLength && out.length % 2 !== 0) {
    out.pop();
  }

  return out;
};

const sanitizeUintArray = (value, { max = 0xffffffff, maxLength = MAX_TILE_LIST } = {}) => {
  if (!Array.isArray(value)) return [];
  const out = [];

  for (const item of value) {
    const num = Number(item);
    if (!Number.isInteger(num) || num < 0) continue;
    out.push(Math.min(num, max));
    if (out.length >= maxLength) break;
  }

  return out;
};

const sanitizeBlendMode = (value) => {
  const blendMode = sanitizeString(value, 32);
  return VALID_BLEND_MODES.has(blendMode) ? blendMode : 'source-over';
};

const sanitizeBlendBakeMode = (value) => (
  sanitizeString(value, 32) === 'background' ? 'background' : 'existing'
);

const sanitizeImageRect = (data) => ({
  sx: clampInt(data.sx, MIN_COORD, MAX_COORD, 0),
  sy: clampInt(data.sy, MIN_COORD, MAX_COORD, 0),
  sw: clampInt(data.sw, 0, MAX_DIMENSION, 0),
  sh: clampInt(data.sh, 0, MAX_DIMENSION, 0)
});

function sanitizeStrokeRecord(record) {
  if (!record || typeof record !== 'object') return null;

  let img = record.img;
  if (img && typeof img === 'object' && !Buffer.isBuffer(img) && !(img instanceof Uint8Array)) {
    img = null;
  }
  if (img && img.length > MAX_SYNC_IMAGE_BYTES) {
    return null;
  }

  return {
    img,
    userId: clampInt(record.userId, 0, 65535, 0),
    x: clampInt(record.x, MIN_COORD, MAX_COORD, 0),
    y: clampInt(record.y, MIN_COORD, MAX_COORD, 0),
    width: clampInt(record.width, 0, MAX_DIMENSION, 0),
    height: clampInt(record.height, 0, MAX_DIMENSION, 0),
    blendMode: sanitizeBlendMode(record.blendMode),
    blendBakeMode: sanitizeBlendBakeMode(record.blendBakeMode),
    timestamp: Number.isFinite(Number(record.timestamp)) ? Number(record.timestamp) : 0,
    isRedo: sanitizeBoolean(record.isRedo),
    redoBatch: clampInt(record.redoBatch, 0, 10000, 0),
    layerIdx: clampInt(record.layerIdx, 0, MAX_LAYER_INDEX, 0),
    affectedTiles: sanitizeUintArray(record.affectedTiles, { max: 1_000_000, maxLength: MAX_TILE_LIST }),
    eraseAll: sanitizeBoolean(record.eraseAll)
  };
}

/**
 * Validates and sanitizes a decoded protobuf/JSON message.
 * Returns `null` when the message violates server policy.
 *
 * @param {Record<string, any>} data
 * @returns {Promise<Record<string, any>|null>}
 */
export async function sanitizeMessage(data) {
  if (!data || typeof data !== 'object') return null;

  const type = Number(data.t);
  if (!Number.isInteger(type) || !VALID_MESSAGE_TYPES.has(type)) return null;

  const sanitized = { t: type };

  switch (type) {
    case T.CONNECT:
      sanitized.n = sanitizeString(data.n, MAX_NAME_LENGTH);
      return sanitized;

    case T.MM:
    case T.MD: {
      sanitized.ps = sanitizeFloatArray(data.ps, {
        requireEvenLength: true,
        min: MIN_PS_VALUE,
        max: MAX_PS_VALUE
      });
      if (!sanitized.ps.length) return null;
      if (Array.isArray(data.rs)) {
        sanitized.rs = sanitizeFloatArray(data.rs, {
          min: 0,
          max: MAX_BRUSH_SIZE,
          maxLength: Math.min(512, sanitized.ps.length / 2)
        });
      }
      if (type === T.MD) {
        if (data.ly !== undefined) sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
        if (data.bm !== undefined) sanitized.bm = sanitizeBlendMode(data.bm);
        if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      }
      return sanitized;
    }

    case T.MU:
    case T.CLR:
    case T.MIR:
    case T.CANCEL:
    case T.HIDE_CURSOR:
    case T.SHOW_CURSOR:
    case T.UNDO:
    case T.REDO:
    case T.ROOM_LIST_REQUEST:
    case T.ROOM_REGISTER:
    case T.ROOM_UNREGISTER:
    case T.ROOM_ROLE_LIST_REQUEST:
    case T.PING:
    case T.PONG:
      if (data.lowPowerMode !== undefined) sanitized.lowPowerMode = sanitizeBoolean(data.lowPowerMode);
      if (data.tabHidden !== undefined) sanitized.tabHidden = sanitizeBoolean(data.tabHidden);
      return sanitized;

    case T.CS:
      sanitized.s = clampInt(data.s, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE, 1000);
      return sanitized;

    case T.CSP:
      sanitized.sp = clampInt(data.sp, 0, MAX_SPACING, 10);
      return sanitized;

    case T.CSM:
      sanitized.sm = clampInt(data.sm, 0, MAX_SMOOTHING, 15);
      return sanitized;

    case T.CHD:
      sanitized.hd = clampInt(data.hd, 0, MAX_HARDNESS, 100);
      return sanitized;

    case T.CBR:
      sanitized.br = clampInt(data.br, 0, MAX_BLUR_RADIUS, 5);
      return sanitized;

    case T.CP:
      sanitized.p = clampInt(data.p, 0, MAX_PRESSURE, 100);
      return sanitized;

    case T.CC:
      sanitized.c = Number.isInteger(data.c) ? data.c >>> 0 : 0;
      return sanitized;

    case T.CT:
      sanitized.l = clampInt(data.l, 0, Object.keys(Tool).length - 1, Tool.BRUSH);
      if (data.a !== undefined) sanitized.a = sanitizeBoolean(data.a);
      return sanitized;

    case T.CL:
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      return sanitized;

    case T.CBM:
      sanitized.bm = sanitizeBlendMode(data.bm);
      if (data.ly !== undefined) sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      return sanitized;

    case T.CN:
      sanitized.n = sanitizeString(data.n, MAX_NAME_LENGTH);
      return sanitized;

    case T.AFK:
    case T.PAN:
      sanitized.a = sanitizeBoolean(data.a);
      return sanitized;

    case T.MSG:
      sanitized.g = sanitizeString(data.g, MAX_CHAT_LENGTH, { trim: true });
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      return sanitized.g ? sanitized : null;

    case T.STAFF_MSG:
      sanitized.g = sanitizeString(data.g, MAX_CHAT_LENGTH, { trim: true });
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      return sanitized.g ? sanitized : null;

    case T.GLOBAL_MESSAGE:
      sanitized.g = sanitizeString(data.g, MAX_GLOBAL_MESSAGE_LENGTH, { trim: true });
      sanitized.k = sanitizeString(data.k, 32, { trim: true });
      sanitized.n = sanitizeString(data.n, MAX_NAME_LENGTH, { trim: true });
      sanitized.a = sanitizeBoolean(data.a);
      return sanitized.g ? sanitized : null;

    case T.DM:
      sanitized.g = sanitizeString(data.g, MAX_CHAT_LENGTH, { trim: true });
      sanitized.r = clampInt(data.r, 0, 65535, 0);
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      return sanitized.g ? sanitized : null;

    case T.CHAT_REACTION:
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      sanitized.chatReaction = sanitizeString(data.chatReaction ?? data.chat_reaction, MAX_CHAT_REACTION_LENGTH);
      sanitized.chatReactionRemove = sanitizeBoolean(data.chatReactionRemove ?? data.chat_reaction_remove);
      if (hasOwnField(data, 'r')) sanitized.r = clampInt(data.r, 0, 65535, 0);
      return sanitized.chatMessageId && sanitized.chatReaction ? sanitized : null;

    case T.KP:
      sanitized.k = sanitizeString(data.k, 20, { trim: false });
      return sanitized.k ? sanitized : null;

    case T.TEXT_APPLY:
      sanitized.g = sanitizeString(data.g, 2000, { trim: false });
      sanitized.ps = sanitizeFloatArray(data.ps, {
        requireEvenLength: true,
        maxLength: 2,
        min: MIN_PS_VALUE,
        max: MAX_PS_VALUE
      });
      sanitized.s = clampInt(data.s, MIN_BRUSH_SIZE, MAX_BRUSH_SIZE, 1000);
      sanitized.c = Number.isInteger(data.c) ? data.c >>> 0 : 0;
      sanitized.p = clampInt(data.p, 0, MAX_PRESSURE, 100);
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      sanitized.bm = sanitizeBlendMode(data.bm);
      sanitized.fo = sanitizeString(data.fo, 120, { trim: true });
      sanitized.tm = Math.min(Math.max(Number(data.tm), -1), 1);
      sanitized.to = Math.min(Math.max(Number(data.to), -20), 20);
      if (!Number.isFinite(sanitized.tm)) sanitized.tm = 0;
      if (!Number.isFinite(sanitized.to)) sanitized.to = 0;
      return sanitized.g && sanitized.ps.length === 2 ? sanitized : null;

    case T.GMP:
    case T.GPT:
    case T.SEL_TO_BRUSH:
      sanitized.g = sanitizeString(data.g, MAX_BRUSH_DATA_LENGTH, { trim: false });
      return sanitized.g ? sanitized : null;

    case T.CPM:
      sanitized.pm = sanitizeBoolean(data.pm);
      return sanitized;

    case T.CSDM: {
      const mode = sanitizeString(data.sdm, 24);
      sanitized.sdm = mode === 'center-scaling' ? 'center-scaling' : 'corner-to-corner';
      return sanitized;
    }

    case T.CF:
      sanitized.fo = sanitizeString(data.fo, 120, { trim: true });
      sanitized.tm = Math.min(Math.max(Number(data.tm), -1), 1);
      sanitized.to = Math.min(Math.max(Number(data.to), -20), 20);
      if (!Number.isFinite(sanitized.tm)) sanitized.tm = 0;
      if (!Number.isFinite(sanitized.to)) sanitized.to = 0;
      return sanitized.fo ? sanitized : null;

    case T.SEL_PENDING:
      Object.assign(sanitized, sanitizeImageRect(data));
      if (Array.isArray(data.ps)) {
        sanitized.ps = sanitizeFloatArray(data.ps, {
          requireEvenLength: true,
          maxLength: MAX_SELECTION_POINTS,
          min: MIN_PS_VALUE,
          max: MAX_PS_VALUE
        });
      }
      return sanitized;

    case T.SEL_MOVE:
      sanitized.cr = sanitizeFloatArray(data.cr, {
        requireEvenLength: true,
        maxLength: 8
      });
      if (Array.isArray(data.cb)) {
        const cb = sanitizeFloatArray(data.cb, {
          requireEvenLength: true,
          maxLength: 4,
          min: 0,
          max: MAX_COORD
        });
        if (cb.length === 4 && cb[2] > 0 && cb[3] > 0) {
          sanitized.cb = cb;
        }
      }
      if (Array.isArray(data.cbt)) {
        const cbt = sanitizeFloatArray(data.cbt, {
          requireEvenLength: true,
          maxLength: 4,
          min: 0,
          max: MAX_COORD
        });
        if (cbt.length === 4 && cbt[2] > 0 && cbt[3] > 0) {
          sanitized.cbt = cbt;
        }
      }
      return sanitized.cr.length === 8 ? sanitized : null;

    case T.SEL_COMMIT:
    case T.SEL_DELETE:
    case T.SEL_STAMP:
    case T.SEL_CANCEL:
    case T.SEL_FLIP:
      if (data.ly !== undefined) sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      return sanitized;

    case T.SEL_FILL:
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      sanitized.c = Number.isInteger(data.c) ? data.c >>> 0 : 0;
      return sanitized;

    case T.FILL:
      sanitized.sx = clampInt(data.sx, MIN_COORD, MAX_COORD, 0);
      sanitized.sy = clampInt(data.sy, MIN_COORD, MAX_COORD, 0);
      sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
      sanitized.s = clampInt(data.s, -MAX_BRUSH_SIZE, MAX_BRUSH_SIZE, 0);
      sanitized.br = clampInt(data.br, 0, MAX_FILL_BLUR_RADIUS * 100, 0);
      return sanitized;

    case T.SYNC_REQUEST:
      if (data.tu !== undefined) sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      return sanitized;

    case T.CTHN:
      sanitized.th = clampInt(data.th, 0, 100, 51);
      return sanitized;

    case T.CSIM:
      sanitized.sim = clampInt(data.sim, 0, 2, 2);
      return sanitized;

    case T.ROOM_PREVIEW: {
      const previewValidation = await validateImageBytes(data.img, {
        maxBytes: MAX_ROOM_PREVIEW_BYTES,
        maxWidth: 2048,
        maxHeight: 2048,
        maxPixels: 1_048_576,
        allowedMimeTypes: new Set(['image/png']),
        mimeTypeHint: 'image/png'
      });
      if (!previewValidation.ok) return null;
      sanitized.img = new Uint8Array(previewValidation.buffer);
      return sanitized;
    }

    case T.ROOM_UPDATE:
      if (data.roomDescription !== undefined) {
        sanitized.roomDescription = sanitizeString(data.roomDescription, MAX_ROOM_DESCRIPTION_LENGTH);
      }
      if (data.roomBackgroundColor !== undefined) {
        const color = sanitizeString(data.roomBackgroundColor, 7);
        if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
        sanitized.roomBackgroundColor = color;
      }
      if (data.roomLocked !== undefined) sanitized.roomLocked = sanitizeBoolean(data.roomLocked);
      if (data.roomModInactiveImmune !== undefined) sanitized.roomModInactiveImmune = sanitizeBoolean(data.roomModInactiveImmune);
      if (data.roomAutoMuteGuests !== undefined) sanitized.roomAutoMuteGuests = sanitizeBoolean(data.roomAutoMuteGuests);
      if (data.roomAutoMuteVpnUsers !== undefined) sanitized.roomAutoMuteVpnUsers = sanitizeBoolean(data.roomAutoMuteVpnUsers);
      if (data.roomHideChatNotifications !== undefined) sanitized.roomHideChatNotifications = sanitizeBoolean(data.roomHideChatNotifications);
      if (data.roomMaxUsers !== undefined) sanitized.roomMaxUsers = clampInt(data.roomMaxUsers, 2, MAX_ROOM_USERS, 40);
      if (data.roomJoinPolicy !== undefined) {
        const joinPolicy = sanitizeString(data.roomJoinPolicy, 16);
        sanitized.roomJoinPolicy = VALID_JOIN_POLICIES.has(joinPolicy) ? joinPolicy : 'open';
      }
      if (data.roomPrivate !== undefined) sanitized.roomPrivate = sanitizeBoolean(data.roomPrivate);
      if (data.roomDedicatedReplayUser !== undefined) {
        // null or empty string clears, otherwise sanitize as username
        sanitized.roomDedicatedReplayUser = data.roomDedicatedReplayUser
          ? sanitizeString(data.roomDedicatedReplayUser, MAX_NAME_LENGTH)
          : null;
      }
      if (data.roomBoardSize !== undefined) {
        sanitized.roomBoardSize = sanitizeString(data.roomBoardSize, 10);
      }
      if (data.roomFloatingGallerySeed !== undefined) {
        sanitized.roomFloatingGallerySeed = Number(data.roomFloatingGallerySeed);
      }
      if (data.roomFloatingGalleryIncludeIds !== undefined) {
        sanitized.roomFloatingGalleryIncludeIds = Array.isArray(data.roomFloatingGalleryIncludeIds)
          ? data.roomFloatingGalleryIncludeIds.map(id => sanitizeString(id, 24)).filter(id => /^[a-f0-9]{24}$/i.test(id))
          : [];
      }
      if (data.roomFloatingGalleryExcludeIds !== undefined) {
        sanitized.roomFloatingGalleryExcludeIds = Array.isArray(data.roomFloatingGalleryExcludeIds)
          ? data.roomFloatingGalleryExcludeIds.map(id => sanitizeString(id, 24)).filter(id => /^[a-f0-9]{24}$/i.test(id))
          : [];
      }
      return sanitized;

    case T.MIRROR_REGION:
      sanitized.mirrorRegionsJson = sanitizeString(data.mirrorRegionsJson, MAX_MIRROR_REGION_PAYLOAD, { trim: false });
      return sanitized.mirrorRegionsJson ? sanitized : null;

    case T.MOD_ACTION:
      sanitized.modActionType = clampInt(data.modActionType, 0, 5, 0);
      sanitized.modTarget = clampInt(data.modTarget, 0, 65535, 0);
      sanitized.modReason = sanitizeString(data.modReason, MAX_MOD_REASON_LENGTH);
      sanitized.modDuration = clampInt(data.modDuration, 0, MAX_DURATION_MINUTES, 0);
      sanitized.modTargetName = sanitizeString(data.modTargetName, MAX_NAME_LENGTH);
      return sanitized;

    case T.MOD_WIPE:
      sanitized.modTarget = clampInt(data.modTarget, 0, 65535, 0);
      sanitized.modTargetName = sanitizeString(data.modTargetName, MAX_NAME_LENGTH);
      return sanitized;

    case T.ROOM_ROLE_SET:
      sanitized.roomRoleTargetId = sanitizeString(data.roomRoleTargetId, MAX_AUTH_STRING_LENGTH);
      sanitized.roomRoleTargetName = sanitizeString(data.roomRoleTargetName, MAX_USERNAME_LOOKUP_LENGTH);
      sanitized.roomRoleValue = clampInt(data.roomRoleValue, 0, 5, 0);
      return sanitized;

    case T.GLOBAL_ROLE_SET:
      sanitized.targetUsername = sanitizeString(
        data.targetUsername ?? data.target_username,
        MAX_USERNAME_LOOKUP_LENGTH
      );
      sanitized.newGlobalRole = clampInt(
        data.newGlobalRole ?? data.new_global_role,
        0,
        255,
        0
      );
      return sanitized;

    case T.AUTH_LOGIN:
      if (data.authUsername !== undefined) sanitized.authUsername = sanitizeString(data.authUsername, MAX_USERNAME_LOOKUP_LENGTH);
      if (data.authPassword !== undefined) sanitized.authPassword = sanitizeString(data.authPassword, MAX_AUTH_STRING_LENGTH, { trim: false });
      if (data.authToken !== undefined) sanitized.authToken = sanitizeString(data.authToken, MAX_AUTH_TOKEN_LENGTH, { trim: false });
      if (!sanitized.authToken && !(sanitized.authUsername && sanitized.authPassword)) return null;
      return sanitized;

    case T.AUTH_REGISTER:
      sanitized.authUsername = sanitizeString(data.authUsername, MAX_USERNAME_LOOKUP_LENGTH);
      sanitized.authPassword = sanitizeString(data.authPassword, MAX_AUTH_STRING_LENGTH, { trim: false });
      sanitized.authEmail = sanitizeString(data.authEmail, MAX_AUTH_STRING_LENGTH);
      sanitized.authSecretQuestion = sanitizeString(data.authSecretQuestion, MAX_SECRET_QUESTION_LENGTH);
      sanitized.authSecretAnswer = sanitizeString(data.authSecretAnswer, MAX_AUTH_STRING_LENGTH, { trim: false });
      if (!sanitized.authUsername || !sanitized.authPassword) return null;
      return sanitized;

    case T.TILE_UPDATE:
      if (!Array.isArray(data.tiles)) return null;
      sanitized.tiles = data.tiles
        .slice(0, MAX_TILE_LIST)
        .map((entry) => {
          if (typeof entry === 'number') {
            return clampInt(entry, 0, 1_000_000, 0);
          }
          if (!entry || typeof entry !== 'object') return null;
          return {
            idx: clampInt(entry.idx, 0, 1_000_000, 0),
            users: sanitizeUintArray(entry.users, { max: 65535, maxLength: 32 })
          };
        })
        .filter((entry) => entry !== null);
      return sanitized;

    case T.TILE_CLEAR:
      sanitized.clearedTiles = sanitizeUintArray(data.clearedTiles, { max: 1_000_000, maxLength: MAX_TILE_LIST });
      return sanitized.clearedTiles.length ? sanitized : null;

    case T.SYNC_CANVAS:
    case T.SYNC_LAYER_BASE:
    case T.SYNC_STROKE: {
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      if (type === T.SYNC_LAYER_BASE || type === T.SYNC_STROKE) {
        sanitized.ly = clampInt(data.ly, 0, MAX_LAYER_INDEX, 0);
        sanitized.bm = sanitizeBlendMode(data.bm);
        if (data.bbm !== undefined) sanitized.bbm = sanitizeBlendBakeMode(data.bbm);
      }
      if (type === T.SYNC_STROKE) {
        sanitized.u = clampInt(data.u, 0, 65535, 0);
        Object.assign(sanitized, sanitizeImageRect(data));
        sanitized.strokeTs = Number.isFinite(Number(data.strokeTs ?? data.stroke_ts)) ? Number(data.strokeTs ?? data.stroke_ts) : 0;
        sanitized.strokeRedo = sanitizeBoolean(data.strokeRedo ?? data.stroke_redo);
        sanitized.strokeRedoBatch = clampInt(data.strokeRedoBatch ?? data.stroke_redo_batch, 0, 10000, 0);
        sanitized.a = sanitizeBoolean(data.a);
      }

      const syncValidation = await validateImageBytes(data.img, {
        maxBytes: MAX_SYNC_IMAGE_BYTES,
        maxWidth: MAX_INLINE_IMAGE_WIDTH,
        maxHeight: MAX_INLINE_IMAGE_HEIGHT,
        maxPixels: MAX_SYNC_IMAGE_PIXELS,
        allowedMimeTypes: new Set(['image/png']),
        mimeTypeHint: 'image/png'
      });
      if (!syncValidation.ok) return null;
      sanitized.img = new Uint8Array(syncValidation.buffer);
      return sanitized;
    }

    case T.SYNC_METADATA:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      sanitized.syncTotal = clampInt(data.syncTotal ?? data.sync_total, 0, 50000, 0);
      sanitized.boardWidth = clampInt(data.boardWidth ?? data.board_width, 0, MAX_COORD, 0);
      sanitized.boardHeight = clampInt(data.boardHeight ?? data.board_height, 0, MAX_COORD, 0);
      return sanitized;

    case T.SYNC_STROKE_BATCH:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      sanitized.layerIdx = clampInt(data.layerIdx, 0, MAX_LAYER_INDEX, 0);
      if (!Array.isArray(data.strokes) || data.strokes.length === 0) return null;
      sanitized.strokes = data.strokes
        .slice(0, MAX_SYNC_BATCH_STROKES)
        .map(sanitizeStrokeRecord)
        .filter(Boolean);
      return sanitized.strokes.length ? sanitized : null;

    case T.SYNC_STROKES_DONE:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      return sanitized;

    case T.SYNC_TILE_OWNERSHIP:
      sanitized.tu = clampInt(data.tu, 0, 65535, 0);
      sanitized.tiles = sanitizeUintArray(data.tiles || data.dirtyTiles, { max: 1_000_000, maxLength: MAX_TILE_LIST });
      return sanitized;

    case T.CHAT_IMG:
    case T.STAFF_CHAT_IMG: {
      const imageValidation = await validateImageBytes(data.cimg, {
        maxBytes: MAX_CHAT_IMAGE_BYTES,
        maxWidth: 4096,
        maxHeight: 4096,
        maxPixels: 8_388_608,
        allowedMimeTypes: CHAT_IMAGE_MIME_TYPES
      });
      if (!imageValidation.ok) return null;
      sanitized.cimg = new Uint8Array(imageValidation.buffer);
      sanitized.chatMessageId = sanitizeString(data.chatMessageId ?? data.chat_message_id, MAX_CHAT_MESSAGE_ID_LENGTH);
      if (!sanitized.chatMessageId) return null;
      if (hasOwnField(data, 'r')) sanitized.r = clampInt(data.r, 0, 65535, 0);
      return sanitized;
    }

    case T.BOARD_SNAPSHOT_SAVE:
      if (Array.isArray(data.snapshotLayers) && data.snapshotLayers.length > 0) {
        sanitized.snapshotLayers = data.snapshotLayers;
      } else {
        return null;
      }
      if (data.snapshotThumb && data.snapshotThumb.length > 0) {
        sanitized.snapshotThumb = data.snapshotThumb;
      }
      sanitized.a = sanitizeBoolean(data.a);
      sanitized.n = sanitizeString(data.n || '', MAX_NAME_LENGTH);
      // Optional flag used by local snapshot uploads to trigger an immediate
      // room-wide restore broadcast after persisting.
      sanitized.snapshotRestoreAfterSave = sanitizeBoolean(
        data.snapshotRestoreAfterSave ?? data.snapshot_restore_after_save
      );
      return sanitized;

    case T.BOARD_SNAPSHOT_LIST_REQUEST:
      if (data.snapshotTs !== undefined) {
        sanitized.snapshotTs = Math.max(0, Math.round(Number(data.snapshotTs) || 0));
      }
      return sanitized;

    case T.BOARD_SNAPSHOT_RESTORE:
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      if (!sanitized.snapshotId) return null;
      return sanitized;

    case T.BOARD_SNAPSHOT_DELETE:
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      if (!sanitized.snapshotId) return null;
      return sanitized;

    case T.BOARD_SNAPSHOT_GET:
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      if (!sanitized.snapshotId) return null;
      return sanitized;

    case T.BOARD_SNAPSHOT_REGION_RESTORE:
      sanitized.snapshotId = sanitizeString(data.snapshotId, 64);
      if (!sanitized.snapshotId) return null;
      sanitized.a = !!data.a;
      sanitized.sx = Math.round(data.sx) || 0;
      sanitized.sy = Math.round(data.sy) || 0;
      sanitized.sw = Math.round(data.sw) || 0;
      sanitized.sh = Math.round(data.sh) || 0;
      sanitized.cr = Array.isArray(data.cr) ? data.cr.map(Number).filter(isFinite) : [];
      return sanitized;

    case T.CHECKPOINT_UPLOAD: {
      const cpValidation = await validateImageBytes(data.checkpointImg, {
        maxBytes: MAX_SYNC_IMAGE_BYTES,
        maxWidth: MAX_INLINE_IMAGE_WIDTH,
        maxHeight: MAX_INLINE_IMAGE_HEIGHT,
        maxPixels: MAX_SYNC_IMAGE_PIXELS,
        allowedMimeTypes: new Set(['image/png']),
        mimeTypeHint: 'image/png'
      });
      if (!cpValidation.ok) return null;
      sanitized.checkpointImg = new Uint8Array(cpValidation.buffer);
      return sanitized;
    }

    case T.CHECKPOINT_LIST:
      return sanitized;

    case T.CHECKPOINT_GET:
      sanitized.checkpointId = sanitizeString(data.checkpointId, 64);
      if (!sanitized.checkpointId) return null;
      return sanitized;

    case T.BW_PROBE_CHUNK: {
      sanitized.probeId = sanitizeString(data.probeId ?? data.probe_id, 64);
      sanitized.probeSeq = clampInt(data.probeSeq ?? data.probe_seq, 0, 1000, 0);
      let buf = data.probeData ?? data.probe_data;
      if (buf && typeof buf === 'object' && !Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
        buf = null;
      }
      // Cap per-chunk size at 128 KB
      if (!buf || buf.length > 131072) return null;
      sanitized.probeData = buf;
      return sanitized.probeId ? sanitized : null;
    }

    case T.BW_REPORT:
      sanitized.uploadBps = clampInt(data.uploadBps ?? data.upload_bps, 0, 1_000_000_000, 0);
      return sanitized;

    case T.REPLAY_REQUEST:
      sanitized.replayStartTs = Number(data.replayStartTs);
      sanitized.replayEndTs = Number(data.replayEndTs);
      if (!Number.isFinite(sanitized.replayStartTs) || !Number.isFinite(sanitized.replayEndTs)) return null;
      if (sanitized.replayEndTs <= sanitized.replayStartTs) return null;
      // Cap replay window to 1 hour
      if (sanitized.replayEndTs - sanitized.replayStartTs > 3_600_000) return null;
      return sanitized;
  }

  if (IMAGE_MESSAGE_TYPES.has(type)) {
    Object.assign(sanitized, sanitizeImageRect(data));
    if (Array.isArray(data.cr)) {
      sanitized.cr = sanitizeFloatArray(data.cr, {
        requireEvenLength: true,
        maxLength: MAX_SELECTION_POINTS
      });
    }

    const imageValidation = await validateDataUrlImage(data.g, {
      maxBytes: MAX_INLINE_IMAGE_BYTES,
      maxWidth: MAX_INLINE_IMAGE_WIDTH,
      maxHeight: MAX_INLINE_IMAGE_HEIGHT,
      maxPixels: MAX_INLINE_IMAGE_PIXELS,
      allowedMimeTypes: INLINE_IMAGE_MIME_TYPES,
      maxDataUrlLength: 3 * 1024 * 1024
    });
    if (!imageValidation.ok) return null;
    sanitized.g = data.g;
    return sanitized;
  }

  return sanitized;
}
