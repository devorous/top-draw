import { SelectToolLoader } from './SelectToolLoader.js';
import { BrushTool } from './BrushTool.js';
import { FlowPenTool } from './FlowPenTool.js';
import { InkTool } from './InkTool.js';
import { ImageBrushTool } from './ImageBrushTool.js';
import { LineTool, RectangleTool, CircleTool } from './ShapeTools.js';
import { EraserTool } from './EraserTool.js';
import { TextTool } from './TextTool.js';
import { InkdropperTool } from './InkdropperTool.js';
import { BlurTool } from './BlurTool.js';
import { CircleBlurTool } from './CircleBlurTool.js';

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
 * Tool manager
 */
export class ToolManager {
  constructor(board) {
    this.board = board;
    this.tools = {
      select: new SelectToolLoader(board),
      brush: new BrushTool(board),
      flowPen: new FlowPenTool(board),
      ink: new InkTool(board),
      line: new LineTool(board),
      rectangle: new RectangleTool(board),
      circle: new CircleTool(board),
      erase: new EraserTool(board),
      text: new TextTool(board),
      imageBrush: new ImageBrushTool(board),
      inkdropper: new InkdropperTool(board),
      blur: new BlurTool(board),
      circleBlur: new CircleBlurTool(board)
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

// Re-export tools for backward compatibility
export { BrushTool, FlowPenTool, InkTool, ImageBrushTool, LineTool, RectangleTool, CircleTool, EraserTool, TextTool, SelectToolLoader, InkdropperTool, BlurTool };
