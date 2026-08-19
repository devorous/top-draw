/**
 * @fileoverview Compositing-tree presence for remote users' preview canvases.
 *
 * Every remote user owns a full board-sized canvas in #userBoards. Those
 * canvases used to sit `display:block` for a user's entire session, so a room
 * of N users cost N full-board layers in the compositor's blend tree on every
 * composited frame — whether or not anyone was drawing. The content is
 * transient (previews are cleared once a stroke commits into the layer state),
 * so a canvas only needs to be in the tree while something is actually on it.
 *
 * Lives in its own module because the drawing sites are spread across
 * RemoteUserHandler and its sibling handlers (ink, pen, selection), none of
 * which hold a reference to each other.
 *
 * Presence is deliberately fail-safe: a missed hide costs a little compositing,
 * while a missed show would make a remote user's drawing invisible. Callers
 * should mark content on any path that draws, and clear it only where the
 * canvas has just been cleared.
 */

/**
 * Applies the display state implied by the user's current flags.
 *
 * During a layered preview the canvas is handed to LayerManager as a drawImage
 * source and hidden with `opacity: 0`. A canvas works fine as a drawImage
 * source while `display:none`, so take it out of the tree instead of leaving an
 * invisible full-board layer behind.
 *
 * @param {Object} user - Remote user model.
 * @returns {void}
 */
export function syncUserLayerDisplay(user) {
  const canvas = user?.board || user?.context?.canvas;
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
  user._userLayerHasContent = !!hasContent;
  syncUserLayerDisplay(user);
}
