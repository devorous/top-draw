/**
 * @fileoverview Base tool class shared by all interactive tools.
 * Defines the lifecycle methods invoked by the input pipeline.
 */

/**
 * Base tool class.
 * @abstract
 */
export class Tool {
  /**
   * @param {string} name - Unique identifier for the tool.
   * @param {Object} board - The drawing board instance.
   */
  constructor(name, board) {
    this.name = name;
    this.board = board;
  }

  activate() {}
  deactivate() {}
  onPointerDown(user, pos, e) {}
  onPointerMove(user, pos, lastPos, e) {}
  onPointerUp(user, pos, e) {}

  /**
   * Repaint whatever this tool is currently showing on a preview surface.
   *
   * Called when the surface window moves or is re-allocated, which throws away
   * everything on topCanvas and on the per-user preview canvases. The composite
   * surfaces rebuild themselves from the layer stack; preview surfaces hold
   * tool-owned state that only the tool can reproduce.
   *
   * Most tools need nothing: the input pipeline already does clearTop() +
   * drawPreview() on every tick of a live stroke, so their preview is at most
   * one tick stale. It matters for the tools whose preview PERSISTS between
   * ticks or between gestures — a floating selection, a fill preview, a placed
   * text caret, the eyedropper swatch.
   *
   * Must repaint from state, never incrementally from what is already on the
   * surface — by the time this runs, that is gone.
   *
   * @param {Object} user - The user whose preview should be repainted.
   * @returns {void}
   */
  redrawPreview(user) {}
}
