/**
 * @fileoverview Text tool for drawing text on the canvas
 */

import { getAppliedTextLayout, getUserTextLineHeight } from '../utils/textLayout.js';

const TEXT_DIRTY_RECT_PADDING = 12;

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

  activate() {
    if (this.board.app?.ui) {
      this.board.app.ui.elements.selfCrosshair.style.display = 'none';
      this.board.app.ui.elements.selfHand.style.display = 'none';
    }
  }

  /**
   * Handle pointer down: if user has text, draw it; otherwise set text position.
   * If no text and clicking, swap back to previous tool.
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
    } else if (this.board.app?.previousTool) {
      // If no text and clicking, swap back to previous tool
      this.board.app.selectTool(this.board.app.previousTool);
      return;
    }
    user.x = pos.x;
    user.y = pos.y;
  }

  /**
   * Handle key press for text input
   * @param {Object} user - User object
   * @param {string} key - Pressed key
   * @param {boolean} ctrlKey - Whether Ctrl/Cmd was held
   * @param {boolean} shiftKey - Whether Shift was held
   * @returns {string|null} Current user text, or null if tool should be swapped
   */
  onKeyPress(user, key, ctrlKey = false, shiftKey = false) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      if (shiftKey) {
        // Shift+Enter: add newline
        user.text += '\n';
      } else {
        // Enter: place text or clear if empty
        if (!user.text) return null; // Signal to swap tool
        user.text = '';
      }
    } else if (key === 'Backspace') {
      if (ctrlKey) {
        // Ctrl+Backspace: delete word backwards including preceding whitespace
        const text = user.text;
        let i = text.length - 1;
        // Skip word characters backwards
        while (i >= 0 && /\S/.test(text[i])) i--;
        // Skip whitespace backwards
        while (i >= 0 && /\s/.test(text[i])) i--;
        user.text = text.slice(0, i + 1);
      } else {
        user.text = user.text.slice(0, -1);
      }
    } else if (key === 'Delete') {
      if (ctrlKey) {
        // Ctrl+Delete: same as Ctrl+Backspace since cursor is at end
        const text = user.text;
        let i = text.length - 1;
        // Skip word characters backwards
        while (i >= 0 && /\S/.test(text[i])) i--;
        // Skip whitespace backwards
        while (i >= 0 && /\s/.test(text[i])) i--;
        user.text = text.slice(0, i + 1);
      }
    } else if (key === 'a' && ctrlKey) {
      // Ctrl+A: select all (for now, just mark that all text is conceptually selected)
      return user.text; // Just return current text, visual feedback not needed
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
    const { fontSize, drawX, baselineY } = getAppliedTextLayout(user);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';

    const lines = user.text.split('\n');
    const lineHeight = getUserTextLineHeight(user);
    lines.forEach((line, i) => {
      ctx.fillText(line, drawX, baselineY + (i * lineHeight));
    });
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
    const { fontSize, drawX, baselineY, ascent, descent } = getAppliedTextLayout(user);
    const text = user.text;

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px ${user.font}`;
    ctx.textBaseline = 'alphabetic';

    const lines = text.split('\n');
    const lineHeight = getUserTextLineHeight(user);

    // Measure all lines to get overall bounds
    let maxWidth = 0;
    lines.forEach(line => {
      const metrics = ctx.measureText(line);
      maxWidth = Math.max(maxWidth, metrics.width);
    });

    const left = 0;
    const right = maxWidth;
    const totalHeight = (lineHeight * Math.max(lines.length - 1, 0)) + ascent + descent;
    const drX = Math.floor(drawX - TEXT_DIRTY_RECT_PADDING);
    const drY = Math.floor(baselineY - ascent - TEXT_DIRTY_RECT_PADDING);
    const drW = Math.ceil(right + (TEXT_DIRTY_RECT_PADDING * 2));
    const drH = Math.ceil(totalHeight + (TEXT_DIRTY_RECT_PADDING * 2));

    // Draw each line
    lines.forEach((line, i) => {
      ctx.fillText(line, drawX, baselineY + (i * lineHeight));
    });

    this.board.expandDirtyRect(user, drX, drY, drW, drH);

    ctx.globalAlpha = 1.0;
  }
}
