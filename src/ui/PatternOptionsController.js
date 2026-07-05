/**
 * @fileoverview Pattern/image-brush options controller — owns the pattern option
 * sliders (scale/rotation/spacing/offset), color-mode radios, pattern image upload,
 * and the network payload builders for pattern/image/confetti brushes.
 * Extracted from App.js.
 */

import { assetLibrary } from './AssetLibrary.js';

// Slider config: self property, UI value-element base name, display suffix
const PATTERN_OPTIONS = {
  scale: { prop: 'patternScale', base: 'PatternScaleValue', suffix: '%' },
  rotation: { prop: 'patternRotation', base: 'PatternRotationValue', suffix: '°' },
  spacing: { prop: 'patternSpacing', base: 'PatternSpacingValue', suffix: '' },
  offsetX: { prop: 'patternOffsetX', base: 'PatternOffsetXValue', suffix: '' },
  offsetY: { prop: 'patternOffsetY', base: 'PatternOffsetYValue', suffix: '' }
};

export class PatternOptionsController {
  constructor(app) {
    this.app = app;
  }

  get self() { return this.app.self; }
  get ui() { return this.app.ui; }

  roundPatternOptionValue(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.round(numericValue * 10) / 10;
  }

  formatPatternOptionValue(value) {
    const roundedValue = this.roundPatternOptionValue(value);
    return Number.isInteger(roundedValue) ? String(roundedValue) : roundedValue.toFixed(1);
  }

  /**
   * Shared handler for the pattern option sliders. Each option mirrors its value
   * into the pattern, fill-pattern, and selection-pattern panels.
   */
  _handlePatternOptionChange(e, option) {
    const { prop, base, suffix } = PATTERN_OPTIONS[option];
    const value = this.roundPatternOptionValue(e.target.value);
    this.self[prop] = value;

    const text = `${this.formatPatternOptionValue(value)}${suffix}`;
    const { elements } = this.ui;
    const lower = base[0].toLowerCase() + base.slice(1);
    if (elements[lower]) elements[lower].textContent = text;
    if (elements[`fill${base}`]) elements[`fill${base}`].textContent = text;
    if (elements[`selection${base}`]) elements[`selection${base}`].textContent = text;

    this.app.updatePatternPreviewIfVisible();
    this._broadcastPatternIfActive();
  }

  _broadcastPatternIfActive() {
    if (this.app.connected && this.self.patternBrush) {
      this.app.inputBufferManager.queueBroadcast(() =>
        this.app.wsClient.broadcastPatternBrush(this._buildPatternPayload())
      );
    }
  }

  handlePatternScaleChange(e) { this._handlePatternOptionChange(e, 'scale'); }
  handlePatternRotationChange(e) { this._handlePatternOptionChange(e, 'rotation'); }
  handlePatternSpacingChange(e) { this._handlePatternOptionChange(e, 'spacing'); }
  handlePatternOffsetXChange(e) { this._handlePatternOptionChange(e, 'offsetX'); }
  handlePatternOffsetYChange(e) { this._handlePatternOptionChange(e, 'offsetY'); }

  handlePatternImageBtnClick() {
    if (!this.app.canUseImageFeatures(true)) return;
    this.ui.elements.patternImageUploadInput?.click();
  }

  async handlePatternImageUpload(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (!this.app.canUseImageFeatures(true)) {
      e.target.value = '';
      return;
    }

    const MAX_PATTERN_SIZE_BYTES = 10 * 1024 * 1024;
    let firstBrush = null;
    const failedFiles = [];

    for (const file of files) {
      if (file.size > MAX_PATTERN_SIZE_BYTES) {
        const sizeMB = (MAX_PATTERN_SIZE_BYTES / 1024 / 1024).toFixed(0);
        failedFiles.push(`${file.name} (exceeds ${sizeMB} MB limit)`);
        continue;
      }

      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const img = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = dataUrl;
        });

        const customBrush = assetLibrary.addCustomAsset({
          kind: 'pattern',
          type: 'image',
          fileName: file.name,
          fileType: file.name.split('.').pop().toLowerCase(),
          dataUrl,
          gimpUrl: dataUrl,
          brushName: file.name.replace(/\.[^/.]+$/, '') || 'Uploaded Image'
        });

        const runtimeBrush = {
          ...customBrush,
          type: 'image',
          image: img,
          gimpUrl: dataUrl,
          width: img.width,
          height: img.height
        };

        this.app.patternGallery.registerBrush(runtimeBrush);
        if (!firstBrush) {
          firstBrush = runtimeBrush;
          this.handlePatternBrushSelect(runtimeBrush);
        }
      } catch (err) {
        console.error(`Failed to load pattern ${file.name}:`, err);
        failedFiles.push(file.name);
      }
    }

    if (failedFiles.length > 0) {
      this.ui.alert(`Failed to load: ${failedFiles.join(', ')}`);
    }

    e.target.value = '';
  }

  handlePatternColorModeChange(e) {
    const colorMode = e.target.value;
    this.self.patternColorMode = colorMode;

    const patternTool = this.app.toolManager.getTool('pattern');
    if (patternTool) {
      // Clear cache so tiles are regenerated with new color mode
      patternTool._tileCache.clear();
      this.app.updatePatternPreviewIfVisible();
    }

    // Sync all radio groups (pattern, fill pattern, and selection pattern)
    document.querySelectorAll('input[name="patternColorMode"], input[name="fillPatternColorMode"], input[name="selectionPatternColorMode"]').forEach(r => r.checked = r.value === colorMode);

    this._broadcastPatternIfActive();
  }

  _buildPatternPayload() {
    const brush = this.self.patternBrush;
    if (!brush) return null;
    // Strip non-serializable Image/HTMLImageElement references, keep data URLs
    const brushData = { type: brush.type, brushName: brush.brushName, fileName: brush.fileName, width: brush.width, height: brush.height };
    if (brush.svgContent) brushData.svgContent = brush.svgContent;
    if (brush.colorDepth !== undefined) brushData.colorDepth = brush.colorDepth;
    if (brush.gBrushes) brushData.gBrushes = brush.gBrushes.map(b => ({ gimpUrl: b.gimpUrl, width: b.width, height: b.height }));
    // Carry gimpUrl on every payload (same as the image brush's _buildImageBrushPayload).
    // Built-in shapes (Circle/Square) and .gbr/image brushes store their bitmap ONLY in
    // gimpUrl with no svgContent, so remote clients and the replay engine cannot rebuild
    // the tile without it — every property change must re-ship it or the pattern vanishes.
    if (brush.gimpUrl) brushData.gimpUrl = brush.gimpUrl;
    return {
      brush: brushData,
      scale: this.self.patternScale ?? 100,
      rotation: this.self.patternRotation ?? 0,
      spacing: this.self.patternSpacing ?? 0,
      offsetX: this.self.patternOffsetX ?? 0,
      offsetY: this.self.patternOffsetY ?? 0,
      colorMode: this.self.patternColorMode ?? 'original'
    };
  }

  handleImageBrushColorModeChange(e) {
    const colorMode = e.target.value;
    this.self.imageBrushColorMode = colorMode;

    const imageBrushTool = this.app.toolManager.getTool('imageBrush');
    if (imageBrushTool) {
      imageBrushTool._tintCache.clear();
      imageBrushTool.updatePreview?.(this.self);
    }

    if (this.app.connected && this.self.imageBrush) {
      this.app.inputBufferManager.queueBroadcast(() =>
        this.app.wsClient.broadcastBrush(this._buildImageBrushPayload())
      );
    }
  }

  _buildImageBrushPayload() {
    const brush = this.self.imageBrush;
    if (!brush) return null;
    const data = {
      type: brush.type,
      brushName: brush.brushName,
      fileName: brush.fileName,
      width: brush.width,
      height: brush.height
    };
    if (brush.gimpUrl) data.gimpUrl = brush.gimpUrl;
    if (brush.svgContent) data.svgContent = brush.svgContent;
    if (brush.colorDepth !== undefined) data.colorDepth = brush.colorDepth;
    if (brush.gBrushes) data.gBrushes = brush.gBrushes.map(b => ({ gimpUrl: b.gimpUrl, width: b.width, height: b.height }));
    if (brush.dimensions) data.dimensions = brush.dimensions;
    if (brush.ncells) data.ncells = brush.ncells;
    if (brush.cellwidth) data.cellwidth = brush.cellwidth;
    if (brush.cellheight) data.cellheight = brush.cellheight;
    data.colorMode = this.self.imageBrushColorMode ?? 'original';
    return data;
  }

  _buildConfettiBrushPayload(extra = {}) {
    const confettiTool = this.app.toolManager?.getTool('confetti');
    return confettiTool?.getNetworkSettings?.(this.self, extra) || null;
  }

  handlePatternBrushSelect(brush) {
    this.self.patternBrush = brush;

    this.app.updatePatternPreviewIfVisible();

    if (this.app.connected) {
      this.app.inputBufferManager.queueBroadcast(() =>
        this.app.wsClient.broadcastPatternBrush(this._buildPatternPayload())
      );
    }
  }
}
