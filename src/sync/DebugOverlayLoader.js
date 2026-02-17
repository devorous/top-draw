/**
 * DebugOverlayLoader
 *
 * Conditionally loads DebugOverlay only in development mode.
 * In production, returns a no-op stub that tree-shakes away.
 *
 * This keeps DebugOverlay (~1,438 lines) out of production builds.
 */

// No-op stub for production
class DebugOverlayStub {
  init() {}
  toggle() { return false; }
  startStrokeTracking() {}
  addStrokePoint() {}
  addDrawingPoint() {}
  startDrawing() {}
  endDrawing() {}
  endStrokeTracking() {}
  cancelDrawing() {}
}

// Conditionally import real DebugOverlay only in dev mode
let DebugOverlayClass;

if (import.meta.env.DEV) {
  // Dynamic import only executes in dev mode
  const module = await import('./DebugOverlay.js');
  DebugOverlayClass = module.DebugOverlay;
} else {
  // Production: use no-op stub
  DebugOverlayClass = DebugOverlayStub;
}

export { DebugOverlayClass as DebugOverlay };
