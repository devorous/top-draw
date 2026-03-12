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
import { HardCircleBlurTool } from './HardCircleBlurTool.js';
import { PanTool } from './PanRotateTool.js';
import { RotateTool } from './RotateTool.js';

/**
 * @fileoverview Tool management and base tool definition
 */

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
 * Manages tool instances and switching between them
 */
export class ToolManager {
  /**
   * @param {Object} board - Board instance
   */
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
      circleBlur: new CircleBlurTool(board),
      circleBlurHard: new HardCircleBlurTool(board),
      pan: new PanTool(board),
      rotate: new RotateTool(board)
    };
    this.currentTool = null;
  }

  /**
   * Set the active tool by name
   * @param {string} toolName - Tool name
   * @returns {Tool} The newly activated tool instance
   */
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

  /**
   * Get a tool instance by name
   * @param {string} toolName - Tool name
   * @returns {Tool}
   */
  getTool(toolName) {
    return this.tools[toolName];
  }

  /**
   * Get the currently active tool
   * @returns {Tool|null}
   */
  getCurrentTool() {
    return this.currentTool;
  }
}

export { BrushTool, FlowPenTool, InkTool, ImageBrushTool, LineTool, RectangleTool, CircleTool, EraserTool, TextTool, SelectToolLoader, InkdropperTool, BlurTool };
