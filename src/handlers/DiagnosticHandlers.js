/**
 * @fileoverview
 * Client-side diagnostic handler for responding to server canvas state requests.
 * 
 * When server broadcasts a diagnostic request, this handler:
 * 1. Captures current canvas hash
 * 2. Collects stroke metadata (counts by user)
 * 3. Sends response back to server
 */

export function setupDiagnosticHandlers(wsClient, app) {
  /**
   * Handle diagnostic canvas state request from server
   */
  wsClient.on('diagnostic_request', (data) => {
    if (!data || !data.requestId) return;
    
    try {
      const canvasState = collectCanvasState(app);
      
      wsClient.send({
        t: 9998, // Custom response type
        action: 'DIAGNOSTIC_RESPONSE',
        requestId: data.requestId,
        username: app.self.username,
        userId: app.self.id,
        hash: canvasState.hash,
        layerCount: canvasState.layerCount,
        strokesByUser: canvasState.strokesByUser,
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('[Diagnostic] Error collecting canvas state:', err);
    }
  });
}

/**
 * Collect canvas rendering state for diagnostic purposes.
 * 
 * @param {App} app - The Top Draw app instance
 * @returns {Object} { hash, layerCount, strokesByUser }
 */
function collectCanvasState(app) {
  const canvas = app.board.mainCanvas;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  
  // Compute canvas hash (same as test uses)
  let hash = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    hash = ((hash << 5) - hash) + pixels[i] + pixels[i + 1] + pixels[i + 2] + pixels[i + 3];
    hash |= 0;
  }

  // Count strokes per layer group
  const lm = app.board.layerManager;
  let totalLayerCount = 0;
  const strokesByUser = {};

  lm.layerGroups.forEach((group, groupIdx) => {
    totalLayerCount += group.strokeStack.length;
    
    // Track stroke count by user
    group.strokeStack.forEach((stroke) => {
      const userId = stroke.userId;
      if (!strokesByUser[userId]) {
        strokesByUser[userId] = 0;
      }
      strokesByUser[userId]++;
    });
  });

  return {
    hash,
    layerCount: totalLayerCount,
    strokesByUser
  };
}

/**
 * Utility: Get canvas state on demand (for debugging)
 * window.app.diagnosticGetCanvasState() in console
 */
export function exposeCanvasStateDiagnostic(app) {
  if (!window.app) window.app = {};
  
  window.app.diagnosticGetCanvasState = () => {
    return collectCanvasState(app);
  };

  window.app.diagnosticRequestUpdate = () => {
    app.wsClient.send({
      t: 9998,
      action: 'DIAGNOSTIC_REQUEST_CANVAS_STATE'
    });
  };
}
