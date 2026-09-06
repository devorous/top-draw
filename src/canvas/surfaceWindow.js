/**
 * @fileoverview The shared viewport window for the board's display surfaces.
 *
 * viewCanvas, topCanvas, upperLayersCanvas and every `.userBoard` are the
 * surfaces the user actually looks at. They have always been board-sized and
 * moved around by a single CSS transform on `#boards`, which is free to pan and
 * zoom but costs one full board-sized backing store each — 126.6 MiB apiece on
 * an 8k board, and the `.userBoard` term multiplies by user count. That is what
 * OOM-kills the renderer on a weak client.
 *
 * A "surface window" decouples two things that used to be the same number:
 *
 *   - the CSS box, in BOARD units, still positioned inside the transformed
 *     `#boards` wrapper, so pan/zoom/rotate/flip keep working exactly as they
 *     do now and nothing about input, z-order or `mix-blend-mode` changes;
 *   - the backing store, in DEVICE pixels, covering only the visible slice of
 *     the board at only the resolution the screen can show.
 *
 * The backing store then works out at roughly `container × dpr` pixels at EVERY
 * zoom level, because the window grows as the zoom shrinks and the two cancel:
 *
 *     store = (containerW / zoom) × (zoom × dpr) = containerW × dpr
 *
 * Drawing code is unchanged: `applyWindowTransform` puts the context in board
 * coordinates, exactly the way the active-stroke windowing campaign did for
 * stroke canvases. Same rule applies — nothing may `setTransform` back to the
 * identity mid-draw without restoring the window transform.
 *
 * ONE window is shared by all the surfaces, not one each, because they are
 * drawn into each other: the eraser preview reads topCanvas into viewCtx with
 * `destination-out`, and `_drawCompositeCanvas` blits them 1:1. Different
 * windows or scales would turn those into resampling bugs.
 *
 * A module-level singleton rather than a Board field, because
 * `userLayerPresence` sizes the per-user surfaces and has no board reference —
 * it already assumes a single live board. `ReplayBoard` does not participate:
 * its surfaces are offscreen and stay board-sized.
 */

/**
 * The active window. `scale` is device pixels per board pixel; `x`/`y`/`width`/
 * `height` are board coordinates. Starts as "the whole board at 1:1", which is
 * the pre-windowing behaviour and what stays in force while
 * `Board.windowedSurfaces` is off.
 */
const current = { x: 0, y: 0, width: 0, height: 0, scale: 1 };

/**
 * The current surface window. Treat as read-only.
 * @returns {{x:number,y:number,width:number,height:number,scale:number}}
 */
export function getSurfaceWindow() {
  return current;
}

/**
 * Replace the active window.
 * @param {{x:number,y:number,width:number,height:number,scale:number}} win
 * @returns {boolean} whether anything changed
 */
export function setSurfaceWindow(win) {
  if (current.x === win.x && current.y === win.y &&
      current.width === win.width && current.height === win.height &&
      current.scale === win.scale) {
    return false;
  }
  current.x = win.x;
  current.y = win.y;
  current.width = win.width;
  current.height = win.height;
  current.scale = win.scale;
  return true;
}

/** Whether `win` fully contains the board-space rect `rect`. */
export function windowCovers(win, rect) {
  if (!win || !rect) return false;
  return rect.x >= win.x &&
    rect.y >= win.y &&
    rect.x + rect.width <= win.x + win.width &&
    rect.y + rect.height <= win.y + win.height;
}

/**
 * Backing-store dimensions for a window, in device pixels.
 * @param {{width:number,height:number,scale:number}} win
 * @returns {{width:number,height:number}}
 */
export function storeSize(win) {
  return {
    width: Math.max(1, Math.round(win.width * win.scale)),
    height: Math.max(1, Math.round(win.height * win.scale))
  };
}

/**
 * Point a canvas at the window: CSS box in board units, backing store in device
 * pixels.
 *
 * Assigning `width`/`height` drops and re-creates the backing store, which is
 * the operation measured to stall (see userLayerPresence: a fresh 8k canvas per
 * frame took 180 fps to 92 with JS self-time flat), so it is guarded — a window
 * that only MOVED re-positions the element and leaves the store alone.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{x:number,y:number,width:number,height:number,scale:number}} [win]
 * @returns {boolean} true if the backing store was re-allocated, which also
 *   means the canvas was cleared and its context state reset.
 */
export function sizeWindowedSurface(canvas, win = current) {
  if (!canvas) return false;
  const store = storeSize(win);

  // The element keeps living in the board-space wrapper, so its box is in board
  // units and the wrapper's transform still does pan/zoom/rotate/flip.
  const left = `${win.x}px`;
  const top = `${win.y}px`;
  const cssW = `${win.width}px`;
  const cssH = `${win.height}px`;
  if (canvas.style.left !== left) canvas.style.left = left;
  if (canvas.style.top !== top) canvas.style.top = top;
  if (canvas.style.width !== cssW) canvas.style.width = cssW;
  if (canvas.style.height !== cssH) canvas.style.height = cssH;

  if (canvas.width === store.width && canvas.height === store.height) return false;
  canvas.width = store.width;
  canvas.height = store.height;
  return true;
}

/**
 * Put a context into board coordinates for the given window.
 *
 * Every existing draw site keeps passing board coordinates and needs no change.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,scale:number}} [win]
 */
export function applyWindowTransform(ctx, win = current) {
  if (!ctx) return;
  ctx.setTransform(win.scale, 0, 0, win.scale, -win.x * win.scale, -win.y * win.scale);
}

/**
 * Expand a board-space rect out to whole device pixels for this window.
 *
 * At `scale < 1` a board-space rect lands on fractional device pixels; a clear
 * rounds one way and a fill the other, which leaves a one-device-pixel seam at
 * every dirty-rect boundary. Expanding outward makes the clear a superset of
 * the fill, so the seams cannot appear. Never shrinks a rect to nothing.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{scale:number}} [win]
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function snapRectToDevicePixels(rect, win = current) {
  const s = win.scale;
  if (!(s > 0) || s >= 1) return rect;
  const x = Math.floor(rect.x * s) / s;
  const y = Math.floor(rect.y * s) / s;
  const right = Math.ceil((rect.x + rect.width) * s) / s;
  const bottom = Math.ceil((rect.y + rect.height) * s) / s;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * A board-space rect expressed in a window's device pixels.
 *
 * For the surface-to-surface blits: two canvases on the same window hold the
 * same device pixels, so copying between them is a 1:1 blit in THEIR
 * coordinates, not in board coordinates. Rounded outward so a copy can never
 * leave a sliver of the region behind.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{x:number,y:number,scale:number}} [win]
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function boardRectToDevice(rect, win = current) {
  const s = win.scale;
  const x = Math.floor((rect.x - win.x) * s);
  const y = Math.floor((rect.y - win.y) * s);
  const right = Math.ceil((rect.x + rect.width - win.x) * s);
  const bottom = Math.ceil((rect.y + rect.height - win.y) * s);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Clamp a device-space rect to a canvas's backing store, or null if it misses.
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {HTMLCanvasElement} canvas
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function clampDeviceRect(rect, canvas) {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(canvas.width, rect.x + rect.width);
  const bottom = Math.min(canvas.height, rect.y + rect.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * A windowed surface re-expressed as a full board-space canvas.
 *
 * For the few places that serialise a preview surface as "an image of the whole
 * board" — the opening snapshot's topCanvas and per-user preview captures,
 * which the replay engine draws back at board (0, 0). A windowed surface holds
 * a scaled slice at some board offset, so handing its own pixels over would put
 * the content in the wrong place and at the wrong size.
 *
 * Returns the canvas itself when the window is already the whole board at 1:1,
 * so the common case allocates nothing.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} boardWidth
 * @param {number} boardHeight
 * @param {{x:number,y:number,width:number,height:number,scale:number}} [win]
 * @returns {HTMLCanvasElement}
 */
export function surfaceToBoardCanvas(canvas, boardWidth, boardHeight, win = current) {
  if (!canvas) return canvas;
  const isFull = win.scale >= 1 && win.x === 0 && win.y === 0 &&
    win.width >= boardWidth && win.height >= boardHeight;
  if (isFull) return canvas;

  const out = document.createElement('canvas');
  out.width = boardWidth;
  out.height = boardHeight;
  // Nothing to place if the surface is collapsed (an idle preview canvas).
  if (canvas.width > 1 || canvas.height > 1) {
    out.getContext('2d').drawImage(canvas, win.x, win.y, win.width, win.height);
  }
  return out;
}
