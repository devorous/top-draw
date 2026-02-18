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
    const ctx = this.board.getActiveLayerContext();
    const blendMode = this.board.app?.self?.blendMode || 'source-over';
    ctx.globalCompositeOperation = blendMode;
  }

  onPointerDown(user, pos) {
    if (user.text) {
      this.drawText(user);
      user.text = '';
      // Composite after drawing text
      this.board.compositeAllLayers();
    }
  }

  onKeyPress(user, key) {
    if (key.length === 1) {
      user.text += key;
    } else if (key === 'Enter') {
      user.text = '';
    } else if (key === 'Backspace') {
      if (user.text.endsWith('&nbsp;')) {
        user.text = user.text.slice(0, -6);
      } else {
        user.text = user.text.slice(0, -1);
      }
    }
    return user.text;
  }

  drawText(user) {
    const ctx = this.board.getActiveLayerContext();
    ctx.globalCompositeOperation = user.blendMode || 'source-over';
    const opacity = user.opacity !== undefined ? user.opacity : 1;
    ctx.globalAlpha = opacity;
    const size = (user.size + 5).toString();
    const text = user.text.replace(/&nbsp;/g, ' ');

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${size}px Newsreader, serif`;
    ctx.fillText(text, user.x + 5, user.y - 6 + user.size + 5);
    ctx.globalAlpha = 1.0;
  }
}
