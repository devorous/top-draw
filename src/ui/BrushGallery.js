/**
 * @fileoverview Brush Gallery - loads and displays GIMP or image brushes from the brushes folder.
 */
import { parseGbr, parseGih } from '../utils/parseGimp.js';
import { BRUSH_MANIFEST } from './brushManifest.js';
import { assetLibrary } from './AssetLibrary.js';

/**
 * BrushGallery class
 */
export class BrushGallery {
  /**
   * @param {Object} [options={}] - Configuration options
   */
  constructor(options = {}) {
    this.brushListEl = null;
    this.galleryEl = null;
    this.brushes = [];
    this.selectedBrush = null;
    this.onSelect = options.onSelect || (() => {});
    this.onUpload = options.onUpload || null;
    this.kind = options.kind || 'imageBrush';
    this.includeGih = options.includeGih !== false;
    this.shouldShowBrush = options.shouldShowBrush || (() => true);
    this.includeDefaultShapes = options.includeDefaultShapes || false;
    this.assetLibrary = options.assetLibrary || assetLibrary;
    this.listElements = [];
    this.pendingRemovalId = null;
    this.headerButtons = [];
  }

  /**
   * Initializes the brush gallery by setting up DOM references and loading brushes.
   */
  init() {
    this.galleryEl = document.getElementById('brushGallery');
    this.brushListEl = document.getElementById('brushList');
    this.listElements = [this.brushListEl].filter(Boolean);

    if (!this.brushListEl) {
      console.warn('Brush gallery elements not found');
      return;
    }

    this.renderUploadTile();
    this.initDefaultShapes();
    this.initHeaderActions();
    this.loadBrushes();
  }

  initDefaultShapes() {
    if (!this.includeDefaultShapes) return;
    for (const shape of ['circle', 'square']) {
      const title = shape.charAt(0).toUpperCase() + shape.slice(1);
      const dataUrl = this.createDefaultShapeIcon(shape);
      this.registerBrush({
        type: 'confetti-shape',
        confettiShape: shape,
        brushName: title,
        fileName: `${shape}.confetti`,
        gimpUrl: dataUrl,
        previewUrl: dataUrl,
        id: `builtin:${this.kind}:${shape}`,
        source: 'builtin',
        kind: this.kind
      });
    }
  }

  shouldIncludeDefaultShapes() {
    return typeof this.includeDefaultShapes === 'function'
      ? this.includeDefaultShapes()
      : !!this.includeDefaultShapes;
  }

  createDefaultShapeIcon(shape) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(20, 20, 18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(2, 2, 36, 36);
    }
    return canvas.toDataURL();
  }

  /**
   * Loads brush files from the checked-in manifest.
   * @returns {Promise<void>}
   */
  async loadBrushes() {
    try {
      for (const entry of BRUSH_MANIFEST) {
        try {
          if (!this.shouldIncludeManifestEntry(entry)) continue;
          let brush;
          if (entry.svgContent) {
            brush = await this.loadBrushFromSvgContent(entry.svgContent, entry.file);
          } else {
            const brushPath = entry.path || `/brushes/${entry.file}`;
            brush = await this.loadBrush(brushPath, entry.file);
          }
          if (brush) {
            this.registerBrush({
              ...brush,
              id: `builtin:${this.kind}:${entry.file}`,
              source: 'builtin',
              kind: this.kind
            });
          }
        } catch (err) {
          console.warn(`Failed to load brush: ${entry.file}`, err);
        }
      }

      await this.loadCustomBrushes();
    } catch (err) {
      console.warn('Failed to load brushes:', err);
    }
  }

  shouldIncludeManifestEntry(entry) {
    if (entry.type === 'gih' && !this.includeGih) return false;
    return true;
  }

  async loadCustomBrushes() {
    const customAssets = this.assetLibrary.getCustomAssets(this.kind);
    for (const asset of customAssets) {
      try {
        const brush = await this.loadCustomAsset(asset);
        if (brush) {
          this.registerBrush(brush);
        }
      } catch (error) {
        console.warn(`Failed to load custom asset ${asset.id}:`, error);
      }
    }
  }

  async loadCustomAsset(asset) {
    if (asset.fileType === 'svg' && asset.svgContent) {
      const brush = await this.loadBrushFromSvgContent(asset.svgContent, asset.fileName || `${asset.id}.svg`);
      return { ...brush, ...asset, kind: this.kind, source: 'custom' };
    }

    const imageUrl = asset.dataUrl || asset.gimpUrl;
    if (!imageUrl) return null;

    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Failed to load image asset ${asset.id}`));
      image.src = imageUrl;
    });

    return {
      type: asset.type || 'image',
      kind: this.kind,
      source: 'custom',
      id: asset.id,
      fileName: asset.fileName,
      fileType: asset.fileType,
      brushName: asset.brushName || asset.fileName?.replace(/\.[^/.]+$/, '') || 'Custom asset',
      gimpUrl: imageUrl,
      dataUrl: asset.dataUrl || imageUrl,
      width: image.width,
      height: image.height,
      image,
      svgContent: asset.svgContent || null
    };
  }

  registerBrush(brush) {
    if (!brush?.id) {
      brush.id = `${brush.source || 'runtime'}:${brush.fileName || brush.brushName || this.brushes.length}`;
    }
    if (this.assetLibrary.isHidden(brush.id)) return;
    this.brushes.push(brush);
    this.addBrushToGallery(brush);
    this.updateUnhideButtons();
  }

  initHeaderActions() {
    this.headerButtons = this.listElements
      .map(listEl => this.ensureUnhideButtonForList(listEl))
      .filter(Boolean);
    this.updateUnhideButtons();
  }

  ensureUnhideButtonForList(listEl) {
    const label = listEl?.previousElementSibling;
    if (!label) return null;
    if (!label.classList.contains('brushGalleryHeader')) {
      label.classList.add('brushGalleryHeader');
    }

    let btn = label.querySelector('.brushGalleryUnhideBtn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brushGalleryUnhideBtn';
    btn.textContent = 'Unhide all';
    btn.style.display = 'none';
    btn.addEventListener('click', () => this.unhideAll());
    label.appendChild(btn);
    return btn;
  }

  updateUnhideButtons() {
    const hasHidden = this.brushes.length + this.assetLibrary.getCustomAssets(this.kind).length < this.getTotalKnownAssetCount()
      || this.hasHiddenAssets();
    this.headerButtons.forEach(btn => {
      btn.style.display = hasHidden ? 'inline-flex' : 'none';
    });
  }

  hasHiddenAssets() {
    const hiddenIds = this.assetLibrary.getHiddenAssetIds();
    for (const id of hiddenIds) {
      if (typeof id === 'string' && id.includes(`:${this.kind}:`)) return true;
      if (typeof id === 'string' && id.startsWith(`${this.kind}-`)) return true;
    }
    return false;
  }

  getTotalKnownAssetCount() {
    return this.getBuiltinAssetCount()
      + this.assetLibrary.getCustomAssets(this.kind).length;
  }

  getBuiltinAssetCount() {
    const defaultShapeCount = this.shouldIncludeDefaultShapes() ? 2 : 0;
    return BRUSH_MANIFEST.filter(entry => this.shouldIncludeManifestEntry(entry)).length + defaultShapeCount;
  }

  unhideAll() {
    const hiddenIds = [...this.assetLibrary.getHiddenAssetIds()];
    hiddenIds.forEach(id => {
      if ((typeof id === 'string' && id.includes(`:${this.kind}:`)) || (typeof id === 'string' && id.startsWith(`${this.kind}-`))) {
        this.assetLibrary.unhideAsset(id);
      }
    });
    this.reloadGallery();
  }

  async reloadGallery() {
    this.pendingRemovalId = null;
    this.brushes = [];
    this.selectedBrush = null;
    this._clearGalleryTiles();
    this.initDefaultShapes();
    await this.loadBrushes();
    this.updateUnhideButtons();
  }

  /**
   * Loads a single brush file and parses its content.
   * @param {string} filePath - Path to the brush file
   * @returns {Promise<Object|null>} - Parsed brush data or null
   */
  async loadBrush(filePath, hintFileName) {
    const response = await fetch(filePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filePath}`);
    }

    const fileName = hintFileName || filePath.split('/').pop();
    const fileType = fileName.split('.').pop().toLowerCase();

    let brushData = null;

    if (fileType === 'gbr') {
      const arrayBuffer = await response.arrayBuffer();
      brushData = parseGbr(arrayBuffer);
      if (brushData) {
        brushData.type = 'gbr';
        brushData.fileName = fileName;
        const image = new Image();
        image.src = brushData.gimpUrl;
        brushData.image = image;
      }
    } else if (fileType === 'gih') {
      const arrayBuffer = await response.arrayBuffer();
      brushData = parseGih(arrayBuffer);
      if (brushData) {
        brushData.type = 'gih';
        brushData.fileName = fileName;
        const images = brushData.gBrushes.map(brush => {
          const img = new Image();
          img.src = brush.gimpUrl;
          return img;
        });
        brushData.images = images;
      }
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(fileType)) {
      const blob = await response.blob();
      const imageUrl = URL.createObjectURL(blob);

      brushData = {
        type: 'image',
        fileName: fileName,
        imageFormat: fileType,
        brushName: fileName.replace(/\.[^/.]+$/, ''),
        gimpUrl: imageUrl,
        width: 0,
        height: 0
      };

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => {
          brushData.width = image.width;
          brushData.height = image.height;
          resolve();
        };
        image.onerror = reject;
        image.src = imageUrl;
      });
      brushData.image = image;
    } else if (fileType === 'svg') {
      const svgText = await response.text();
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
      const previewUrl = URL.createObjectURL(svgBlob);
      brushData = {
        type: 'svg',
        fileName: fileName,
        brushName: fileName.replace(/\.[^/.]+$/, ''),
        gimpUrl: filePath,
        previewUrl: previewUrl,
        svgContent: svgText,
        width: 0,
        height: 0
      };

      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = () => {
          brushData.width = image.naturalWidth || image.width;
          brushData.height = image.naturalHeight || image.height;
          resolve();
        };
        image.onerror = () => {
          URL.revokeObjectURL(previewUrl);
          reject(new Error(`Failed to load SVG brush ${fileName}`));
        };
        image.src = previewUrl;
      });
      brushData.image = image;
    }

    return brushData;
  }

  async loadBrushFromSvgContent(svgText, fileName) {
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
    const previewUrl = URL.createObjectURL(svgBlob);
    const brushData = {
      type: 'svg',
      fileName: fileName,
      brushName: fileName.replace(/\.[^/.]+$/, ''),
      gimpUrl: null,
      previewUrl: previewUrl,
      svgContent: svgText,
      width: 0,
      height: 0
    };

    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = () => {
        brushData.width = image.naturalWidth || image.width;
        brushData.height = image.naturalHeight || image.height;
        resolve();
      };
      image.onerror = () => {
        URL.revokeObjectURL(previewUrl);
        reject(new Error(`Failed to load SVG brush ${fileName}`));
      };
      image.src = previewUrl;
    });
    brushData.image = image;
    return brushData;
  }

  /**
   * Adds a brush item to the gallery UI.
   * @param {Object} brush - Brush data object
   */
  addBrushToGallery(brush) {
    if (!this.shouldShowBrush(brush)) return;
    for (const listEl of this.listElements) {
      const item = this.createGalleryItem(brush);
      if (this._isFolderBrush(brush)) {
        const folder = this._ensureFolderForList(listEl);
        folder.querySelector('.brushFolderContent').appendChild(item);
        this._updateFolderCount(folder);
      } else {
        listEl.appendChild(item);
      }
    }
  }

  _isFolderBrush(brush) {
    return brush?.type === 'svg';
  }

  _getFolderForList(listEl) {
    const next = listEl?.nextElementSibling;
    return next?.classList?.contains('brushFolder') ? next : null;
  }

  _ensureFolderForList(listEl) {
    const existing = this._getFolderForList(listEl);
    if (existing) return existing;
    const folder = document.createElement('div');
    folder.className = 'brushFolder collapsed';
    folder.innerHTML = `
      <button type="button" class="brushFolderHeader">
        <span class="brushFolderCaret">▶</span>
        <span class="brushFolderLabel">Icons</span>
        <span class="brushFolderCount">0</span>
      </button>
      <div class="brushFolderContent"></div>
    `;
    folder.querySelector('.brushFolderHeader').addEventListener('click', () => {
      folder.classList.toggle('collapsed');
    });
    listEl.insertAdjacentElement('afterend', folder);
    return folder;
  }

  _updateFolderCount(folder) {
    if (!folder) return;
    const content = folder.querySelector('.brushFolderContent');
    const count = content ? content.children.length : 0;
    const countEl = folder.querySelector('.brushFolderCount');
    if (countEl) countEl.textContent = count;
    folder.style.display = count === 0 ? 'none' : '';
  }

  _clearGalleryTiles() {
    this.listElements.forEach(listEl => {
      listEl.querySelectorAll('.brushItem[data-asset-id]').forEach(t => t.remove());
      const folder = this._getFolderForList(listEl);
      if (folder) {
        folder.querySelectorAll('.brushItem[data-asset-id]').forEach(t => t.remove());
        this._updateFolderCount(folder);
      }
    });
  }

  refreshVisibleBrushes() {
    this.clearPendingRemoval();
    this._clearGalleryTiles();
    for (const brush of this.brushes) {
      this.addBrushToGallery(brush);
    }
  }

  createGalleryItem(brush) {
    const item = document.createElement('div');
    item.className = 'brushItem';
    item.title = brush.brushName || brush.name || brush.fileName;
    item.dataset.assetId = brush.id || '';

    this.appendBrushPreview(item, brush);
    item.addEventListener('click', () => {
      if (this.pendingRemovalId === brush.id) {
        this.confirmRemoveBrush(brush);
        return;
      }
      this.selectBrush(brush, item);
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.handleBrushContextMenu(brush, item);
    });

    return item;
  }

  appendBrushPreview(item, brush) {
    if (brush.svgContent) {
      item.innerHTML = brush.svgContent;
      return;
    }

    const img = document.createElement('img');
    if (brush.type === 'gih' && brush.gBrushes && brush.gBrushes.length > 0) {
      img.src = brush.gBrushes[0].gimpUrl;
    } else if (brush.type === 'image' || brush.type === 'gbr' || brush.type === 'confetti-shape') {
      img.src = brush.gimpUrl;
    } else {
      img.src = brush.previewUrl || brush.gimpUrl;
    }
    img.alt = brush.brushName || brush.name || 'Brush';
    item.appendChild(img);
  }

  handleBrushContextMenu(brush, item) {
    this.clearPendingRemoval();
    if (brush.source === 'custom') {
      this.pendingRemovalId = brush.id;
      item.classList.add('pendingRemoval');
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'brushConfirmAction';
      confirm.textContent = 'Remove?';
      confirm.addEventListener('click', (event) => {
        event.stopPropagation();
        this.confirmRemoveBrush(brush);
      });
      item.appendChild(confirm);
      return;
    }

    this.hideBrush(brush);
  }

  clearPendingRemoval() {
    this.pendingRemovalId = null;
    document.querySelectorAll('.brushItem.pendingRemoval').forEach(el => el.classList.remove('pendingRemoval'));
    document.querySelectorAll('.brushConfirmAction').forEach(el => el.remove());
  }

  confirmRemoveBrush(brush) {
    this.clearPendingRemoval();
    this.removeBrush(brush);
  }

  renderUploadTile() {
    if (!this.onUpload) return;
    for (const listEl of this.listElements) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'brushItem brushItemUpload';
      item.title = `Upload ${this.kind === 'pattern' ? 'texture' : 'brush'}`;
      item.innerHTML = '<span>+</span><small>Upload</small>';
      item.addEventListener('click', () => this.onUpload());
      listEl.appendChild(item);
    }
  }

  hideBrush(brush) {
    if (!brush?.id) return;
    this.assetLibrary.hideAsset(brush.id);
    if (this.selectedBrush?.id === brush.id) {
      this.selectedBrush = null;
    }
    this.removeBrushElements(brush.id);
    this.brushes = this.brushes.filter(entry => entry.id !== brush.id);
    this.updateUnhideButtons();
  }

  removeBrush(brush) {
    if (!brush?.id || brush.source !== 'custom') return;
    this.assetLibrary.removeCustomAsset(brush.id);
    if (this.selectedBrush?.id === brush.id) {
      this.selectedBrush = null;
    }
    this.removeBrushElements(brush.id);
    this.brushes = this.brushes.filter(entry => entry.id !== brush.id);
    this.updateUnhideButtons();
  }

  removeBrushElements(assetId) {
    document.querySelectorAll(`.brushItem[data-asset-id="${assetId}"]`).forEach(el => el.remove());
  }

  /**
   * Selects a brush in the gallery.
   * @param {Object} brush - Brush data object
   * @param {HTMLElement} itemEl - The gallery item element
   */
  selectBrush(brush, itemEl) {
    this._clearSelectionInAllGalleries();

    itemEl.classList.add('selected');
    this.selectedBrush = brush;

    this.onSelect(brush);
  }

  _clearSelectionInAllGalleries() {
    for (const listEl of this.listElements) {
      listEl.querySelectorAll('.brushItem.selected').forEach(el => el.classList.remove('selected'));
      const folder = this._getFolderForList(listEl);
      if (folder) {
        folder.querySelectorAll('.brushItem.selected').forEach(el => el.classList.remove('selected'));
      }
    }
  }

  /**
   * Shows the brush gallery.
   */
  show() {
    if (this.galleryEl) {
      this.refreshVisibleBrushes();
      this.galleryEl.style.display = 'block';
      window.app?.ui?.refreshToolOptionsLayout?.(window.app?.self?.tool);
    }
  }

  /**
   * Hides the brush gallery.
   */
  hide() {
    if (this.galleryEl) {
      this.galleryEl.style.display = 'none';
      this.clearPendingRemoval();
      window.app?.ui?.refreshToolOptionsLayout?.(window.app?.self?.tool);
    }
  }

  /**
   * Gets the currently selected brush.
   * @returns {Object|null} - Selected brush data
   */
  getSelectedBrush() {
    return this.selectedBrush;
  }
}
