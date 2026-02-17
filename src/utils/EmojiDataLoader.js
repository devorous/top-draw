/**
 * Lazy loader for emoji data with caching
 * Loads emojibase-data only when emoji picker is first opened
 */

let emojiDataCache = null;
let loadingPromise = null;

/**
 * Load emoji data dynamically (once)
 * @returns {Promise<Array>} Array of emoji objects
 */
export async function loadEmojiData() {
  // Return cached data if already loaded
  if (emojiDataCache) {
    return emojiDataCache;
  }

  // Return existing promise if already loading
  if (loadingPromise) {
    return loadingPromise;
  }

  // Start loading
  loadingPromise = import('emojibase-data/en/compact.json')
    .then(module => {
      emojiDataCache = module.default;
      loadingPromise = null;
      return emojiDataCache;
    })
    .catch(error => {
      loadingPromise = null;
      console.error('Failed to load emoji data:', error);
      throw error;
    });

  return loadingPromise;
}
