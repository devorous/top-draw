/**
 * @fileoverview Compositing-tree presence and backing-store sizing for remote
 * users' preview canvases.
 *
 * Every remote user owns a full board-sized canvas in #userBoards. Those
 * canvases used to sit `display:block` for a user's entire session, so a room
 * of N users cost N full-board layers in the compositor's blend tree on every
 * composited frame — whether or not anyone was drawing. The content is
 * transient (previews are cleared once a stroke commits into the layer state),
 * so a canvas only needs to be in the tree while something is actually on it.
 *
 * `display:none` fixed the blend-tree cost but not the memory: a hidden canvas
 * keeps its full backing store. Measured at 1440p with 7 users in the room,
 * `.userBoard` elements held **183 MB across 13 canvases** — the single largest
 * holder in the app, and larger than the entire rest of the board put together.
 * (13 for 7 users because boards can outlive the user they belong to.) So a
 * canvas that is out of the tree is now also collapsed to 1x1, which is the
 * same treatment Board._sizeOverlayCanvas gives the selection overlays.
 *
 * Lives in its own module because the drawing sites are spread across
 * RemoteUserHandler and its sibling handlers (ink, pen, selection), none of
 * which hold a reference to each other.
 *
 * Presence is deliberately fail-safe: a missed hide costs a little compositing,
 * while a missed show would make a remote user's drawing invisible. Callers
 * should mark content on any path that draws, and clear it only where the
 * canvas has just been cleared.
 *
 * Sizing is fail-safe in the same direction, and more sharply so — a canvas
 * left at full size costs memory, but one left collapsed silently discards
 * everything drawn into it. Hence: inflate synchronously and unconditionally
 * whenever content is declared, and collapse only on a delay, only after the
 * canvas has been cleared, and never from the display-only path.
 */

import { getSurfaceWindow, sizeWindowedSurface, applyWindowTransform } from '../canvas/surfaceWindow.js';

/**
 * How long a preview canvas stays allocated after its content is cleared.
 *
 * Long, and measured rather than guessed. Collapse/inflate is an
 * allocate-and-zero-fill of a full-board canvas, which is precisely the
 * operation that stalls — a fresh 8k canvas per frame drops 180 fps to 92 while
 * JS self-time stays at 0.14 ms.
 *
 * This was first set to 2 s, on the reasoning that a user drawing continuously
 * would keep cancelling the timer. That was wrong, and an A/B at 1440p with 7
 * users says so: against the same build with collapse effectively disabled, the
 * 2 s version was worse on every axis — GPU 1225 vs 968 MB, worst stall 396 vs
 * 222 ms, renderer 87 % vs 68 % busy. Remote strokes arrive in bursts with gaps
 * longer than 2 s, so it thrashed.
 *
 * 60 s only catches a user who is genuinely parked, which is the case that
 * actually leaks: present, not drawing, and not idle long enough to trip AFK.
 * Departure and AFK do not wait for it — they call releaseUserLayer directly.
 * This is the same conclusion the plan reached for the ink/pen offscreens
 * (idle reclaim, not free-at-stroke-end); the cost model is identical and so is
 * the answer.
 */
const COLLAPSE_IDLE_MS = 60000;


/**
 * The canvas presence is allowed to manage for this user, or null.
 *
 * Presence hides canvases and collapses them to 1x1, so it must only ever be
 * handed a canvas whose entire content is a transient per-user preview. The
 * local user's `board`/`context` point at shared display surfaces (topCanvas,
 * and viewCanvas before that), and collapsing or `display:none`-ing one of
 * those blanks the board for everyone looking at this client. Membership of
 * #userBoards is the structural test for "this is a per-user preview canvas" —
 * createUserBoard is the only thing that puts a canvas there.
 *
 * @param {Object} user - User model.
 * @returns {HTMLCanvasElement|null}
 * @private
 */
function previewCanvasOf(user) {
  const canvas = user?.board || user?.context?.canvas;
  if (!canvas || canvas.parentElement?.id !== 'userBoards') return null;
  return canvas;
}

/**
 * Drop a preview canvas's backing store and the window box that went with it.
 *
 * The inline box is cleared as well as the store: a collapsed canvas left at
 * the old window's `left`/`top`/`width`/`height` would be a 1x1 store stretched
 * across a window-sized box, which is a visible smear for the frame between
 * inflating and the first draw.
 *
 * @param {HTMLCanvasElement} canvas
 * @private
 */
function collapseCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
  canvas.style.left = '';
  canvas.style.top = '';
  canvas.style.width = '';
  canvas.style.height = '';
}

function cancelCollapse(user) {
  if (user?._layerCollapseTimer) {
    clearTimeout(user._layerCollapseTimer);
    user._layerCollapseTimer = null;
  }
}

/**
 * Inflate a remote user's preview canvas to full board size.
 *
 * Synchronous and idempotent. Must run before anything draws into the canvas —
 * every `setUserLayerContent(user, true)` call site already sits ahead of its
 * drawing, which is what makes this safe to hang off that call.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 */
export function ensureUserLayerSized(user) {
  const canvas = previewCanvasOf(user);
  if (!canvas) return;
  cancelCollapse(user);

  const win = getSurfaceWindow();
  if (!(win.width > 0) || !(win.height > 0)) return;

  // The SAME window the board's own display surfaces use, not the board's
  // dimensions. These canvases blend against viewCanvas with mix-blend-mode and
  // are drawn 1:1 alongside it, so a different window or scale here would be a
  // resampling bug rather than a saving. With windowedSurfaces off the window
  // is the whole board at 1:1, which is what this used to do.
  const reallocated = sizeWindowedSurface(canvas, win);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (reallocated) {
    // Assigning width/height resets the 2D context to spec defaults. These two
    // are set at creation in RemoteUserUI.createUserBoard and are load-bearing:
    // a fresh context uses butt caps, so losing them makes this client render
    // remote strokes differently from everyone else — a pixel-level divergence
    // that no transport oracle would catch.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  // Board coordinates in, window pixels out — every remote drawing site keeps
  // passing board coordinates and needs no change.
  applyWindowTransform(ctx, win);
}

/**
 * Collapse a remote user's preview canvas to 1x1, after an idle delay.
 *
 * Only ever called from the content-cleared path, where the canvas has just
 * been wiped, so the delay is about avoiding allocation churn rather than
 * about protecting content.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 * @private
 */
function scheduleCollapse(user) {
  const canvas = previewCanvasOf(user);
  if (!canvas || user._layerCollapseTimer) return;
  if (canvas.width === 1 && canvas.height === 1) return;

  user._layerCollapseTimer = setTimeout(() => {
    user._layerCollapseTimer = null;
    // Re-check rather than trusting the state at schedule time: the user may
    // have started drawing again inside the delay window.
    if (user._userLayerHasContent) return;
    const live = previewCanvasOf(user);
    if (!live) return;
    collapseCanvas(live);
  }, COLLAPSE_IDLE_MS);
}

/**
 * Releases a remote user's preview canvas immediately.
 *
 * For departure and AFK, where waiting out the idle delay is pointless. Safe to
 * call on a user who has already been cleaned up.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 */
export function releaseUserLayer(user) {
  cancelCollapse(user);
  const canvas = previewCanvasOf(user);
  if (!canvas || (canvas.width === 1 && canvas.height === 1)) return;
  collapseCanvas(canvas);
}

/**
 * Applies the display state implied by the user's current flags.
 *
 * During a layered preview the canvas is handed to LayerManager as a drawImage
 * source and hidden with `opacity: 0`. A canvas works fine as a drawImage
 * source while `display:none`, so take it out of the tree instead of leaving an
 * invisible full-board layer behind.
 *
 * Deliberately does NOT resize. This is called from display-only paths (layered
 * preview toggling, remote layer visibility) where the canvas still holds
 * pixels that are about to be read back as a drawImage source; collapsing here
 * would throw them away.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 */
export function syncUserLayerDisplay(user) {
  const canvas = previewCanvasOf(user);
  if (!canvas) return;
  // `data-force-hidden` marks a board something else owns the hiding of — a
  // remote user drawing on a layer this client has hidden. Content-driven
  // presence must never override that and reveal those strokes.
  const present = !!user._userLayerHasContent
    && !user._layeredPreviewActive
    && canvas.dataset?.forceHidden !== '1';
  const next = present ? '' : 'none';
  if (canvas.style.display === next) return;
  canvas.style.display = next;
}

/**
 * Records whether a remote user's preview canvas currently holds anything.
 *
 * @param {Object} user - Remote user model.
 * @param {boolean} hasContent
 * @returns {void}
 */
export function setUserLayerContent(user, hasContent) {
  if (!user) return;
  const has = !!hasContent;
  // Inflate before the flag flips, so the canvas is already full size by the
  // time the caller starts drawing on the line after this one.
  if (has) ensureUserLayerSized(user);
  user._userLayerHasContent = has;
  syncUserLayerDisplay(user);
  if (!has) scheduleCollapse(user);
}
