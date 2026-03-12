/** @fileoverview In-memory storage for canvas regions, storing finalized PNG data for synchronization. */

/**
 * Stores finalized regions with their PNG data for sync to new users.
 * Data is ephemeral and cleared when the last user leaves.
 */
export class RegionStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this.regions = new Map();
  }

  /**
   * Adds a new region to the store.
   * @param {Object} region - Region data object.
   * @param {string} region.id - Unique region ID.
   * @param {number} region.userId - Session index of the user who created the region.
   * @param {Array<number>} region.hull - Hull points [x1, y1, x2, y2, ...].
   * @param {Object} region.bounds - Bounding box {x, y, width, height}.
   * @param {number} region.timestamp - Creation timestamp.
   * @param {Uint8Array|Buffer} region.imageData - PNG image data.
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
   * Removes a region from the store by its ID.
   * @param {string} regionId - The ID of the region to remove.
   * @returns {boolean} - True if the region existed and was removed.
   */
  removeRegion(regionId) {
    return this.regions.delete(regionId);
  }

  /**
   * Retrieves a region by its ID.
   * @param {string} regionId - The ID of the region.
   * @returns {Object|undefined} - The region data or undefined if not found.
   */
  getRegion(regionId) {
    return this.regions.get(regionId);
  }

  /**
   * Returns an array of all stored regions.
   * @returns {Array<Object>} - A list of all regions.
   */
  getAllRegions() {
    return Array.from(this.regions.values());
  }

  /**
   * Returns all regions created by a specific user.
   * @param {number} userId - The user's session index.
   * @returns {Array<Object>} - A list of regions created by the user.
   */
  getRegionsByUser(userId) {
    return this.getAllRegions().filter(r => r.userId === userId);
  }

  /**
   * Clears all regions from the store.
   */
  clear() {
    this.regions.clear();
  }

  /**
   * Returns the total number of regions in the store.
   * @returns {number} - The region count.
   */
  getCount() {
    return this.regions.size;
  }

  /**
   * Calculates the total size of all stored image data in bytes.
   * @returns {number} - The total size in bytes.
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
