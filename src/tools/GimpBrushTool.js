/**
 * GimpBrushTool - GIMP brush stamp tool
 */

import { Tool } from './Tool.js';
import { MessageType } from '../network/Protocol.js';
import { parseGbr, parseGih } from '../parsers/GimpParser.js';

export class GimpBrushTool extends Tool {
  constructor(stateManager, canvasManager, drawingEngine, wsClient) {
    super('gimp', stateManager, canvasManager, drawingEngine, wsClient);
  }

  activate() {
    this.canvas.setCompositeOperation('source-over');

    // Show square cursor and GIMP UI
    const squareElement = document.querySelector('.square.self');
    if (squareElement) {
      squareElement.style.display = 'block';
    }

    const circleElement = document.querySelector('.circle.self');
    if (circleElement) {
      circleElement.style.display = 'none';
    }

    const textElement = document.querySelector('.text.self');
    if (textElement) {
      textElement.style.display = 'none';
    }

    const gimpImage = document.getElementById('gimpImage');
    if (gimpImage) {
      gimpImage.style.display = 'block';
    }

    const gimpFileInput = document.getElementById('gimp-file-input');
    if (gimpFileInput) {
      gimpFileInput.style.display = 'block';
    }

    const gimpSpacing = document.getElementById('gimp-spacing');
    if (gimpSpacing) {
      gimpSpacing.style.display = 'block';
    }
  }

  deactivate() {
    // Hide GIMP-specific UI
    const gimpImage = document.getElementById('gimpImage');
    if (gimpImage) {
      gimpImage.style.display = 'none';
    }

    const gimpFileInput = document.getElementById('gimp-file-input');
    if (gimpFileInput) {
      gimpFileInput.style.display = 'none';
    }

    const gimpSpacing = document.getElementById('gimp-spacing');
    if (gimpSpacing) {
      gimpSpacing.style.display = 'none';
    }
  }

  onPointerDown(e) {
    const user = this.localUser;
    if (user.panning) return;

    const pos = { x: e.offsetX, y: e.offsetY };

    user.mousedown = true;
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;

    if (user.gBrush) {
      this.drawing.drawGimp(user, pos);
    }

    // Broadcast
    this.ws.broadcast(MessageType.POINTER_DOWN, {});
  }

  onPointerMove(e) {
    const user = this.localUser;
    if (!user.mousedown || user.panning) return;

    const pos = { x: e.offsetX, y: e.offsetY };

    if (user.gBrush) {
      this.drawing.drawGimp(user, pos);
    }
  }

  onPointerUp(e) {
    const user = this.localUser;

    user.mousedown = false;

    // Broadcast
    this.ws.broadcast(MessageType.POINTER_UP, {});
  }

  /**
   * Load a GIMP brush file
   * @param {File} file - The brush file (.gbr or .gih)
   */
  async loadBrushFile(file) {
    const user = this.localUser;
    const fileType = file.name.split('.').pop().toLowerCase();

    const arrayBuffer = await file.arrayBuffer();

    if (fileType === 'gbr') {
      const gbrObject = parseGbr(arrayBuffer);
      if (gbrObject) {
        gbrObject.type = 'gbr';

        // Create image from data URL
        const gimpImage = new Image();
        gimpImage.src = gbrObject.gimpUrl;
        await new Promise(resolve => gimpImage.onload = resolve);
        gbrObject.image = gimpImage;

        user.gBrush = gbrObject;

        // Update preview
        const preview = document.getElementById('gimpImage');
        if (preview) {
          preview.src = gbrObject.gimpUrl;
        }

        // Broadcast brush data
        this.ws.broadcast(MessageType.BRUSH_GIMP, { gimpData: gbrObject });
      }
    } else if (fileType === 'gih') {
      const gihObject = parseGih(arrayBuffer);
      if (gihObject) {
        // Create images for all frames
        const images = [];
        for (const gbrObject of gihObject.gBrushes) {
          const gimpImage = new Image();
          gimpImage.src = gbrObject.gimpUrl;
          await new Promise(resolve => gimpImage.onload = resolve);
          images.push(gimpImage);
        }

        gihObject.type = 'gih';
        gihObject.index = 0;
        gihObject.images = images;
        user.gBrush = gihObject;

        // Update preview
        const preview = document.getElementById('gimpImage');
        if (preview && gihObject.gBrushes.length > 0) {
          preview.src = gihObject.gBrushes[0].gimpUrl;
        }

        // Broadcast brush data
        this.ws.broadcast(MessageType.BRUSH_GIMP, { gimpData: gihObject });
      }
    }
  }

  handleRemotePointerDown(data, user) {
    if (user.panning) return;

    user.mousedown = true;
    user.lastx = user.x;
    user.lasty = user.y;
    user.spaceIndex = 0;

    if (user.gBrush) {
      this.drawing.drawGimp(user, { x: user.x, y: user.y });
    }
  }

  handleRemotePointerMove(data, user) {
    if (!user.mousedown || user.panning) return;

    if (user.gBrush) {
      this.drawing.drawGimp(user, { x: user.x, y: user.y });
    }
  }

  handleRemotePointerUp(data, user) {
    user.mousedown = false;
  }

  /**
   * Handle remote GIMP brush data
   * @param {Object} data - Message with gimpData
   * @param {Object} user - Remote user
   */
  async handleRemoteBrushData(data, user) {
    const gimpData = data.gimpData;

    if (gimpData.type === 'gbr') {
      const image = new Image();
      image.src = gimpData.gimpUrl;
      await new Promise(resolve => image.onload = resolve);
      gimpData.image = image;
      user.gBrush = gimpData;
    } else if (gimpData.type === 'gih') {
      const images = [];
      for (const gbrObject of gimpData.gBrushes) {
        const image = new Image();
        image.src = gbrObject.gimpUrl;
        await new Promise(resolve => image.onload = resolve);
        images.push(image);
      }
      gimpData.index = 0;
      gimpData.images = images;
      user.gBrush = gimpData;
    }
  }

  getCursorClass() {
    return 'square';
  }
}
