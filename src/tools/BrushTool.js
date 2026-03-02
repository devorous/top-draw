import { manhattanDistance, mirrorLine, drawLineArray, bridgeGap } from '../utils/drawing.js';

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
 *
 * Note: Position smoothing is handled by InputBufferManager before points
 * reach this tool, ensuring perfect parity between local preview and remote rendering.
 */
export class BrushTool extends Tool {
  constructor(board) {
    super('brush', board);
  }

  activate() {
    // Sub-layers always draw source-over; blend mode is applied at composite time.
  }

  onPointerDown(user, pos) {
    this.board.beginStroke(user);

    // Position is already smoothed by InputBufferManager
    user.currentLine.push(pos);
    user.currentLine.push(pos);
    this.drawPreview(user);
  }

  onPointerMove(user, pos, lastPos) {
    if (!user.mousedown || user.panning) return;

    // Position is already smoothed by InputBufferManager
    user.currentLine.push(pos);
    this.board.clearTop();
    this.board.topCtx.beginPath();
    drawLineArray(user.currentLine, this.board.topCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      drawLineArray(mirrored, this.board.topCtx, user);
    }

    user.lineLength += manhattanDistance(pos, lastPos);
  }

  onPointerUp(user) {
    if (user.panning) return;

    // Clear preview FIRST to prevent composite boldness
    this.board.clearTop();

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    drawLineArray(user.currentLine, layerCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      drawLineArray(mirrored, layerCtx, user);
    }

    // Update dirty rect
    this.trackDirtyRect(user, user.currentLine);

    user.clearLine();

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
    this.board.endStroke(user);
  }

  drawPreview(user) {
    drawLineArray(user.currentLine, this.board.topCtx, user);
  }

  /**
   * Calculate and expand the dirty rectangle for a set of points
   */
  trackDirtyRect(user, points) {
    if (!points || points.length === 0) return;

    const hardness = user.hardness !== undefined ? user.hardness : 1.0;

    // Calculate bounding box of all points
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    // Expand by brush radius plus blur, with 25% safety margin
    const radius = user.pressure * user.size;
    const blurAmount = hardness < 1.0 ? (1 - hardness) * (20 + user.size * 0.2) : 0;
    const safetyMargin = radius * 0.25; // 25% additional margin for blur/hardness
    const margin = radius + blurAmount + safetyMargin + 2; // +2 for anti-aliasing

    const x = Math.floor(minX - margin);
    const y = Math.floor(minY - margin);
    const width = Math.ceil(maxX - minX + margin * 2);
    const height = Math.ceil(maxY - minY + margin * 2);

    this.board.expandDirtyRect(user, x, y, width, height);

    if (this.board.mirror) {
      const boardWidth = this.board.getWidth();
      const mirrorX = Math.floor(boardWidth - maxX - margin);
      this.board.expandDirtyRect(user, mirrorX, y, width, height);
    }
  }

  commitCurrentLine(user, newPressure, newSize) {
    this.board.clearTop();
    this.board.topCtx.beginPath();

    // Old segment draws with current user.pressure (still the old value
    // because callers commit BEFORE calling setPressure)
    const oldRadius = user.pressure * user.size;
    const newRadius = (newPressure ?? user.pressure) * (newSize ?? user.size);

    // Draw to active layer
    const layerCtx = this.board.getActiveLayerContext();
    drawLineArray(user.currentLine, layerCtx, user);

    if (this.board.mirror) {
      const mirrored = mirrorLine(user.currentLine, this.board.getWidth());
      drawLineArray(mirrored, layerCtx, user);
    }

    // Update dirty rect for the line
    this.trackDirtyRect(user, user.currentLine);

    // Save last smoothed position (where old segment visually ends)
    const lastSmoothedPos = user.currentLine.length > 0
      ? user.currentLine[user.currentLine.length - 1]
      : { x: user.x, y: user.y };

    // Bridge the gap between old segment end and new segment start
    // using interpolated filled circles (flow-pen style)
    if (user.currentLine.length > 0) {
      const from = lastSmoothedPos;
      bridgeGap(layerCtx, from, lastSmoothedPos, oldRadius, newRadius, user);
      if (this.board.mirror) {
        const w = this.board.getWidth();
        bridgeGap(layerCtx,
          { x: w - from.x, y: from.y },
          { x: w - lastSmoothedPos.x, y: lastSmoothedPos.y },
          oldRadius, newRadius, user);
      }
    }

    user.clearLine();
    user.currentLine.push(lastSmoothedPos);

    // Composite all layers to visible canvas
    this.board.compositeAllLayers();
  }
}
