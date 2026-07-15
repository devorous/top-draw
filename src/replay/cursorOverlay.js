/**
 * @fileoverview Shared bot-cursor overlay rendering for replay surfaces.
 *
 * Used by both ReplayEngine (which bakes cursors into the live mini/full
 * replay output canvas) and TimeLapseExporter (which draws cursors onto the
 * export canvas with a region offset so they stay native-size regardless of
 * crop/zoom). Keeping a single implementation means both surfaces stay in sync.
 *
 * Matches the live remote cursor look (RemoteUserUI._applyRemoteToolDisplay),
 * which shows exactly ONE shape per tool — not a ring plus an embellishment.
 * The shape is chosen by tool family, each stroked in the user's color over a
 * soft white halo so it reads on any background:
 *   - select                         → 10px crosshair (no ring).
 *   - blur / glitchBlur / imageBrush
 *     / pixel                        → hollow square footprint (no ring).
 *   - text                           → no shape; the in-progress text preview is
 *                                      already painted onto the canvas, so the
 *                                      cursor is just the name label.
 *   - brush-family / everything else → ring at brush radius.
 * A username label, brightened toward white for readability, is centered above
 * the cursor for every tool.
 */

// Tool families, mirroring RemoteUserUI._applyRemoteToolDisplay. Anything not
// listed falls through to the ring (matches the live circle default).
const SELECT_TOOLS = new Set(['select']);
const SQUARE_TOOLS = new Set(['blur', 'glitchBlur', 'imageBrush', 'pixel']);
const NO_SHAPE_TOOLS = new Set(['text']);

// Supporter gold, mirroring --supporter-gold in _variables.scss (canvas can't
// resolve CSS vars, so the value is duplicated here).
const SUPPORTER_GOLD = 'rgba(245, 197, 66, 1)';

/**
 * Brighten a color toward white until it clears a luminance floor, so a dark
 * (e.g. near-black) brush color still produces a readable label.
 * @param {number[]} rgba
 * @returns {string} CSS rgba() string
 */
export function brightenForReadability(rgba) {
  const r0 = rgba[0] | 0, g0 = rgba[1] | 0, b0 = rgba[2] | 0;
  const lum = (0.299 * r0 + 0.587 * g0 + 0.114 * b0) / 255;
  const target = 0.55;
  if (lum >= target) return `rgba(${r0}, ${g0}, ${b0}, 1)`;
  const t = Math.min(1, (target - lum) / (1 - lum));
  const r = Math.round(r0 + (255 - r0) * t);
  const g = Math.round(g0 + (255 - g0) * t);
  const b = Math.round(b0 + (255 - b0) * t);
  return `rgba(${r}, ${g}, ${b}, 1)`;
}

/**
 * Draw a single bot cursor (ring + tool embellishment + name label).
 * Caller is responsible for any visibility/idle gating and for save/restore of
 * broader canvas state; this routine resets the few properties it touches.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,size?:number,color?:number[],tool?:string,username?:string,id?:number}} user
 * @param {number} [offsetX=0] - Subtracted from user.x (e.g. export region origin).
 * @param {number} [offsetY=0] - Subtracted from user.y.
 * @returns {void}
 */
export function drawReplayCursor(ctx, user, offsetX = 0, offsetY = 0) {
  const x = Number(user?.x);
  const y = Number(user?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const cx = x - offsetX;
  const cy = y - offsetY;
  const size = Math.max(1, Number(user.size) || 10);

  const c = Array.isArray(user.color) ? user.color : [120, 120, 120, 1];
  const alpha = typeof c[3] === 'number' ? c[3] : 1;
  const isSupporter = !!user.isSupporter;
  const strokeStr = isSupporter
    ? SUPPORTER_GOLD
    : `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${alpha})`;
  const tool = user.tool || 'brush';

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // Stroke the given path builder twice: a wide white halo, then the user's
  // color on top, so the single tool-specific shape reads on any background.
  const strokeHaloed = (buildPath) => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    buildPath();
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = strokeStr;
    buildPath();
    ctx.stroke();
  };

  // Exactly one shape per tool family, mirroring the live cursor. The text
  // tool draws no shape — its in-progress preview is already on the canvas.
  if (SELECT_TOOLS.has(tool)) {
    const ch = 10;
    strokeHaloed(() => {
      ctx.beginPath();
      ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy);
      ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch);
    });
  } else if (SQUARE_TOOLS.has(tool)) {
    strokeHaloed(() => {
      ctx.beginPath();
      ctx.rect(cx - size, cy - size, size * 2, size * 2);
    });
  } else if (!NO_SHAPE_TOOLS.has(tool)) {
    // Ring at brush radius (brush, pen, line, shapes, eraser, pattern, …).
    strokeHaloed(() => {
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
    });
  }

  // Username label — brightened color with a thin dark outline for contrast.
  const name = String(user.username || `User ${user.id}`);
  const fontPx = Math.min(16, Math.max(10, Math.round(size * 0.6 + 8)));
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'center';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.strokeText(name, cx, cy - size - 4);
  ctx.fillStyle = isSupporter ? SUPPORTER_GOLD : brightenForReadability(c);
  ctx.fillText(name, cx, cy - size - 4);

  ctx.restore();
}
