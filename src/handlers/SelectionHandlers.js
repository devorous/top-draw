/** @fileoverview Handles selection-related events including lifting, moving, committing, and manipulating selections. */

/**
 * Sets up WebSocket event handlers for selection and image paste operations.
 * @param {Function} wrapHandler - Function to wrap event handlers for sync buffering.
 * @param {App} app - The main application instance.
 */
export function setupSelectionHandlers(wrapHandler, app) {
  const { users, remoteUserHandler } = app;

  wrapHandler('sel_lift', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionLift(user, data.selection, data.lassoPath);
    }
  });

  wrapHandler('sel_move', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionMove(user, data.corners);
    }
  });

  wrapHandler('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionCommit(user, data.layerIndex);
    }
  });

  wrapHandler('sel_pending', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionPending(user, data.selection, data.lassoPath);
    }
  });

  wrapHandler('sel_delete', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionDelete(user, data.layerIndex);
    }
  });

  wrapHandler('sel_fill', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionFill(user, data.color, data.layerIndex);
    }
  });

  wrapHandler('sel_stamp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionStamp(user, data.layerIndex);
    }
  });

  wrapHandler('sel_flip', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionFlip(user);
    }
  });

  wrapHandler('sel_cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionCancel(user);
    }
  });

  wrapHandler('sel_to_brush', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionToBrush(user, data.brushData);
    }
  });

  wrapHandler('img_paste', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleImagePaste(user, data);
    }
  });
}
