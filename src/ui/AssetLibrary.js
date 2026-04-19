const STORAGE_KEY = 'topDrawCustomAssetLibraryV1';

function safeReadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { customAssets: [], hiddenAssetIds: [] };
    }
    const parsed = JSON.parse(raw);
    return {
      customAssets: Array.isArray(parsed?.customAssets) ? parsed.customAssets : [],
      hiddenAssetIds: Array.isArray(parsed?.hiddenAssetIds) ? parsed.hiddenAssetIds : []
    };
  } catch (error) {
    console.warn('Failed to read asset library:', error);
    return { customAssets: [], hiddenAssetIds: [] };
  }
}

function saveStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save asset library:', error);
  }
}

function makeId(prefix = 'asset') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class AssetLibrary {
  constructor() {
    this.state = safeReadStorage();
  }

  getHiddenAssetIds() {
    return new Set(this.state.hiddenAssetIds);
  }

  isHidden(assetId) {
    return this.state.hiddenAssetIds.includes(assetId);
  }

  hideAsset(assetId) {
    if (!assetId || this.isHidden(assetId)) return;
    this.state.hiddenAssetIds = [...this.state.hiddenAssetIds, assetId];
    saveStorage(this.state);
  }

  unhideAsset(assetId) {
    this.state.hiddenAssetIds = this.state.hiddenAssetIds.filter(id => id !== assetId);
    saveStorage(this.state);
  }

  getCustomAssets(kind) {
    return this.state.customAssets.filter(asset => asset.kind === kind);
  }

  addCustomAsset(asset) {
    const storedAsset = {
      id: asset.id || makeId(asset.kind || 'asset'),
      source: 'custom',
      createdAt: Date.now(),
      ...asset
    };
    this.state.customAssets = [...this.state.customAssets, storedAsset];
    saveStorage(this.state);
    return storedAsset;
  }

  removeCustomAsset(assetId) {
    this.state.customAssets = this.state.customAssets.filter(asset => asset.id !== assetId);
    this.state.hiddenAssetIds = this.state.hiddenAssetIds.filter(id => id !== assetId);
    saveStorage(this.state);
  }
}

export const assetLibrary = new AssetLibrary();
