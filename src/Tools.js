import { manhattanDistance, mirrorLine } from './utils/drawing.js';
import { parseGbr, parseGih } from './utils/parseGimp.js';

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
 * Brush tool for drawing lines
 */
export class BrushTool extends Tool {
  constructor(board) {
    super('brush', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    user.currentLine.push(pos);
    user.currentLine.push(pos);
    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    user.currentLine.push(pos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.topCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.topCtx, user);
    }

    user.lineLength += manhattanDistance(pos, lastPos);
  }

  onPointerUp(user) {
    if (user.panning) return;

    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    this.board.clearTop();
    user.clearLine();
  }

  drawPreview(user) {
    this.drawLineArray(user.currentLine, this.board.topCtx, user);
  }

  drawLineArray(points, ctx, user) {
    if (points.length === 0) return;

    ctx.strokeStyle = user.getColorString();
    ctx.lineWidth = user.pressure * user.size * 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  commitCurrentLine(user) {
    this.board.clearTop();
    this.board.topCtx.beginPath();
    this.drawLineArray(user.currentLine, this.board.mainCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      this.drawLineArray(mirrored, this.board.mainCtx, user);
    }

    user.clearLine();
    user.currentLine.push({ x: user.x, y: user.y });
  }
}

/**
 * Eraser tool
 */
export class EraserTool extends Tool {
  constructor(board) {
    super('erase', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'destination-out';
  }

  onPointerDown(user, pos) {
    this.erase(pos.x, pos.y, pos.x, pos.y, user.pressure * user.size * 2);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    this.erase(pos.x, pos.y, lastPos.x, lastPos.y, user.pressure * user.size * 2);

    if (this.board.mirror) {
      const width = this.board.getWidth();
      this.erase(width - pos.x, pos.y, width - lastPos.x, lastPos.y, user.pressure * user.size * 2);
    }
  }

  erase(x1, y1, x2, y2, size) {
    const ctx = this.board.mainCtx;
    ctx.lineWidth = size;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

/**
 * Text tool
 */
export class TextTool extends Tool {
  constructor(board) {
    super('text', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    if (user.text) {
      this.drawText(user);
      user.text = '';
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
    const ctx = this.board.mainCtx;
    ctx.globalCompositeOperation = 'source-over';
    const size = (user.size + 5).toString();
    const text = user.text.replace(/&nbsp;/g, ' ');

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.font = `${size}px Newsreader, serif`;
    ctx.fillText(text, user.x + 5, user.y - 6 + user.size + 5);
  }
}

/**
 * GIMP brush tool
 */
export class GimpTool extends Tool {
  constructor(board) {
    super('gimp', board);
  }

  activate() {
    this.board.mainCtx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(user, pos) {
    if (user.gBrush) {
      this.draw(user, pos);
    }
  }

  onPointerMove(user, pos) {
    if (!user.mousedown || user.panning || !user.gBrush) return;
    this.draw(user, pos);
  }

  draw(user, pos) {
    if (user.spacing !== 0) {
      if (user.spaceIndex !== 0) {
        user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
        return;
      }
      user.spaceIndex = (user.spaceIndex + 1) % user.spacing;
    }

    const gBrush = user.gBrush;
    const size = user.size;
    const ctx = this.board.mainCtx;

    let height, width, image;

    if (gBrush.type === 'gbr') {
      height = gBrush.height;
      width = gBrush.width;
      image = gBrush.image;
    } else if (gBrush.type === 'gih') {
      height = gBrush.cellheight;
      width = gBrush.cellwidth;
      image = gBrush.images[gBrush.index];
      gBrush.index = (gBrush.index + 1) % gBrush.ncells;
    }

    let ratioX = width / height;
    let ratioY = height / width;

    if (width > height) ratioX = 1;
    if (height > width) ratioY = 1;

    ctx.beginPath();
    ctx.fillStyle = user.getColorString();
    ctx.drawImage(
      image,
      pos.x - size * ratioX,
      pos.y - size * ratioY,
      size * 2 * ratioX,
      size * 2 * ratioY
    );
    ctx.stroke();
  }

  loadBrush(file, user) {
    return new Promise((resolve) => {
      const fileType = file.name.split('.').pop().toLowerCase();
      const reader = new FileReader();

      reader.onload = () => {
        const arrayBuffer = reader.result;

        if (fileType === 'gbr') {
          const gbrObject = parseGbr(arrayBuffer);
          if (gbrObject) {
            gbrObject.type = 'gbr';
            const image = new Image();
            image.src = gbrObject.gimpUrl;
            gbrObject.image = image;
            user.gBrush = gbrObject;
            resolve(gbrObject);
          }
        } else if (fileType === 'gih') {
          const gihObject = parseGih(arrayBuffer);
          if (gihObject) {
            const images = gihObject.gBrushes.map(brush => {
              const img = new Image();
              img.src = brush.gimpUrl;
              return img;
            });
            gihObject.type = 'gih';
            gihObject.index = 0;
            gihObject.images = images;
            user.gBrush = gihObject;
            resolve(gihObject);
          }
        }
      };

      reader.readAsArrayBuffer(file);
    });
  }
}

/**
 * Tool manager
 */
export class ToolManager {
  constructor(board) {
    this.board = board;
    this.tools = {
      brush: new BrushTool(board),
      erase: new EraserTool(board),
      text: new TextTool(board),
      gimp: new GimpTool(board)
    };
    this.currentTool = null;
  }

  setTool(toolName) {
    if (this.currentTool) {
      this.currentTool.deactivate();
    }
    this.currentTool = this.tools[toolName];
    if (this.currentTool) {
      this.currentTool.activate();
    }
    return this.currentTool;
  }

  getTool(toolName) {
    return this.tools[toolName];
  }

  getCurrentTool() {
    return this.currentTool;
  }
}
