import { SelectTool } from './tools/SelectTool.js';
import { BrushTool } from './tools/BrushTool.js';
import { FlowPenTool } from './tools/FlowPenTool.js';
import { InkTool } from './tools/InkTool.js';
import { ImageBrushTool } from './tools/ImageBrushTool.js';
import { LineTool, RectangleTool, CircleTool } from './tools/ShapeTools.js';
import { EraserTool } from './tools/EraserTool.js';
import { TextTool } from './tools/TextTool.js';
import { InkdropperTool } from './tools/InkdropperTool.js';

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
      select: new SelectTool(board),
      brush: new BrushTool(board),
      flowPen: new FlowPenTool(board),
      ink: new InkTool(board),
      line: new LineTool(board),
      rectangle: new RectangleTool(board),
      circle: new CircleTool(board),
      erase: new EraserTool(board),
      text: new TextTool(board),
      imageBrush: new ImageBrushTool(board),
      inkdropper: new InkdropperTool(board)
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
export { BrushTool, FlowPenTool, InkTool, ImageBrushTool, LineTool, RectangleTool, CircleTool, EraserTool, TextTool, SelectTool, InkdropperTool };
