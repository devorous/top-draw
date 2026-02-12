/**
 * RegionStore - In-memory storage for canvas regions
 *
 * Stores finalized regions with their PNG data for sync to new users.
 * Data is ephemeral - cleared when the last user leaves.
 */

export class RegionStore {
  constructor() {
    // regionId -> { id, userId, hull, bounds, timestamp, imageData }
    this.regions = new Map();
  }

  /**
   * Add a new region to the store
   * @param {Object} region - Region data
   * @param {string} region.id - Unique region ID
   * @param {number} region.userId - User who created the region
   * @param {Array<number>} region.hull - Hull points [x1, y1, x2, y2, ...]
   * @param {Object} region.bounds - Bounding box {x, y, width, height}
   * @param {number} region.timestamp - Creation timestamp
   * @param {Uint8Array|Buffer} region.imageData - PNG image data
   */
  addRegion(region) {
    this.regions.set(region.id, {
      id: region.id,
      userId: region.userId,
      hull: region.hull,
      bounds: region.bounds,
      timestamp: region.timestamp,
      imageData: region.imageData
    });

  }

  /**
   * Remove a region by ID
   * @param {string} regionId - Region ID to remove
   * @returns {boolean} True if region was removed
   */
  removeRegion(regionId) {
    const existed = this.regions.delete(regionId);
    if (existed) {
    }
    return existed;
  }

  /**
   * Get a region by ID
   * @param {string} regionId - Region ID
   * @returns {Object|undefined} Region data or undefined
   */
  getRegion(regionId) {
    return this.regions.get(regionId);
  }

  /**
   * Get all regions
   * @returns {Array<Object>} Array of all regions
   */
  getAllRegions() {
    return Array.from(this.regions.values());
  }

  /**
   * Get regions created by a specific user
   * @param {number} userId - User session index
   * @returns {Array<Object>} Array of user's regions
   */
  getRegionsByUser(userId) {
    return this.getAllRegions().filter(r => r.userId === userId);
  }

  /**
   * Clear all regions
   */
  clear() {
    const count = this.regions.size;
    this.regions.clear();
  }

  /**
   * Get total number of regions
   * @returns {number}
   */
  getCount() {
    return this.regions.size;
  }

  /**
   * Get total size of stored image data in bytes
   * @returns {number}
   */
  getTotalSize() {
    let total = 0;
    for (const region of this.regions.values()) {
      if (region.imageData) {
        total += region.imageData.length;
      }
    }
    return total;
  }
}
