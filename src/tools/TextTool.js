/**
 * @fileoverview Text tool for drawing text on the canvas
 */

import { getAppliedTextLayout, getPreviewTextLayout } from '../utils/textLayout.js';

/**
 * Base tool class
 * @abstract
 */
class Tool {
  /**
   * @param {string} name - Tool name
   * @param {Object} board - Board instance
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

/**
 * Tool for placing and drawing text
 */
export class TextTool extends Tool {
  /**
   * @param {Object} board - Board instance
   */
  constructor(board) {
    super('text', board);
  }

  activate() {}

  /**
   * Handle pointer down: if user has text, draw it; otherwise set text position.
   * @param {Object} user - User object
   * @param {Object} pos - Pointer position {x, y}
   */
  onPointerDown(user, pos) {
    if (user.text) {
      this.board.beginStroke(user);
      this.drawText(user);
      user.text = '';
      this.board.endStroke(user);

      if (this.board.app?.ui.elements.touchInput) {
        this.board.app.ui.elements.touchInput.value = ' ';
      }
    }
    user.x = pos.x;
    user.y = pos.y;
  }

  /**
   * Handle key press for text input
   * @param {Object} user - User object
   * @param {string} key - Pressed key
   * @returns {string} Current user text
   */
  onKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      user.text = user.text.slice(0, -1);
    }
    return user.text;
  }

  /**
   * Renders a canvas-based text preview to the top canvas.
   * Used when a blend mode is active, since DOM elements can't blend with canvas layers.
   * @param {Object} user - User object
   */
  renderPreview(user) {
    if (!user.text) return;
    const ctx = this.board.topCtx;
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    const { fontSize, drawX, baselineY } = getPreviewTextLayout(user);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(user.text, drawX, baselineY);
    ctx.restore();
  }

  /**
   * Draw the user's text to the active layer
   * @param {Object} user - User object
   */
  drawText(user) {
    const ctx = this.board.getLayerContext(user.activeLayer, user.id);
    ctx.globalCompositeOperation = 'source-over';
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    const { fontSize } = getAppliedTextLayout(user);
    const text = user.text;

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';

    const metrics = ctx.measureText(text);
    const { drawX, baselineY, ascent, descent } = getAppliedTextLayout(user, metrics);
    const textWidth = metrics.width;

    const drX = Math.floor(drawX - 4);
    const drY = Math.floor(baselineY - ascent - 4);
    const drW = Math.ceil(textWidth + 8);
    const drH = Math.ceil(ascent + descent + 8);

    ctx.fillText(text, drawX, baselineY);
    this.board.expandDirtyRect(user, drX, drY, drW, drH);

    ctx.globalAlpha = 1.0;
  }
}
