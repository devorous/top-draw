/**
 * Base tool class
 */
class Tool {
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
 * Text tool
 */
export class TextTool extends Tool {
  constructor(board) {
    super('text', board);
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  onPointerDown(user, pos) {
    if (user.text) {
      this.board.beginStroke(user);
      this.drawText(user);
      user.text = '';
      this.board.endStroke(user); // commits stroke and composites

      // Clear the hidden touch input value too (reset with one space)
      if (this.board.app?.ui.elements.touchInput) {
        this.board.app.ui.elements.touchInput.value = ' ';
      }
    }
    // Update user position to the new click/lift location
    user.x = pos.x;
    user.y = pos.y;
  }

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

  drawText(user) {
    // Text drawn source-over into sub-layer; blend mode applied at composite time.
    const ctx = this.board.getLayerContext(user.activeLayer, user.id);
    ctx.globalCompositeOperation = 'source-over';
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    const size = (user.size + 5).toString();
    const text = user.text;

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${size}px Newsreader, serif`;
    ctx.fillText(text, user.x + 5, user.y - 6 + user.size + 5);
    ctx.globalAlpha = 1.0;
  }
}
