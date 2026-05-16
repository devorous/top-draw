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
}
