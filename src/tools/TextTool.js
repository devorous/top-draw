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
    const fontSize = user.size + 5;
    const text = user.text;

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${fontSize}px Newsreader, serif`;
    ctx.textBaseline = 'alphabetic';
    
    // Calculate metrics for precise dirty rect and positioning
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    
    // actualBoundingBox metrics provide the exact pixel bounds of the rendered glyphs.
    // We use these for a tight dirty rect that won't cut off descenders or ascenders.
    const ascent = metrics.actualBoundingBoxAscent || (fontSize * 0.75);
    const descent = metrics.actualBoundingBoxDescent || (fontSize * 0.25);


    const baselineY = user.y + (fontSize * 0.66) - 3;
    const drawX = user.x + 5;

    // Calculate dirty rect bounds with a generous safety margin (4px)
    const drX = Math.floor(drawX - 4);
    const drY = Math.floor(baselineY - ascent - 4);
    const drW = Math.ceil(textWidth + 8);
    const drH = Math.ceil(ascent + descent + 8);

    ctx.fillText(text, drawX, baselineY);
    this.board.expandDirtyRect(user, drX, drY, drW, drH);

    // Handle mirrored text if mirror mode is enabled
    if (this.board.mirror) {
      const boardWidth = this.board.getWidth();
      // Mirror the position: the text starts at (boardWidth - drawX - textWidth)
      const mirroredX = boardWidth - drawX - textWidth;
      ctx.fillText(text, mirroredX, baselineY);
      
      const mDrX = Math.floor(mirroredX - 4);
      this.board.expandDirtyRect(user, mDrX, drY, drW, drH);
    }

    ctx.globalAlpha = 1.0;
  }
}
