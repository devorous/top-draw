/**
 * @fileoverview Pan tool for navigating the canvas.
 * Left drag: pan, Scroll: zoom in/out.
 */

/**
 * PanTool handles viewport panning and zooming.
 */
export class PanTool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    this.name = 'pan';
    this.board = board;
  }

  /**
   * Activates the tool.
   */
  activate() {}

  /**
   * Deactivates the tool.
   */
  deactivate() {}

  /**
   * Handles pointer down event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerDown(user, pos, e) {}

  /**
   * Handles pointer move event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Object} lastPos - The previous pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerMove(user, pos, lastPos, e) {}

  /**
   * Handles pointer up event.
   * @param {Object} user - The user performing the action.
   * @param {Object} pos - The current pointer position.
   * @param {Event} e - The pointer event.
   */
  onPointerUp(user, pos, e) {}
}
