/**
 * @fileoverview Client-side apply for the opt-in tiled-canvas-backing-store
 * room setting. Mirrors applyRoomBoardSize's shape (see BoardSizes.js):
 * called both at initial connect and on a live ROOM_UPDATE/SETTINGS change.
 */
export function applyRoomTiledCanvas(app, enabled) {
  const lm = app?.board?.layerManager;
  if (!lm) return false;

  enabled = !!enabled;
  if (lm.tiledBackingStore === enabled) return false;

  lm.setTiledBackingStore(enabled);
  if (app.currentRoomData) {
    app.currentRoomData.tiledCanvas = enabled;
  }
  return true;
}
