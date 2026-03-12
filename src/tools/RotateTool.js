/**
 * @fileoverview Rotate tool for rotating the canvas viewport.
 */

/**
 * RotateTool handles viewport rotation around a center point.
 */
export class RotateTool {
  /**
   * @param {Object} board - The drawing board instance.
   */
  constructor(board) {
    this.name = 'rotate';
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
