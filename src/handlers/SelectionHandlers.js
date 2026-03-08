/**
 * SelectionHandlers
 *
 * Handles all selection-related events (buffered during sync):
 * - Selection lifecycle (lift, move, commit, cancel)
 * - Selection operations (delete, fill, stamp, to_brush)
 * - Image paste
 */

export function setupSelectionHandlers(wrapHandler, app) {
  const { users, remoteUserHandler } = app;

  // Selection lift - remote user lifted a selection
  wrapHandler('sel_lift', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionLift(user, data.selection, data.lassoPath);
    }
  });

  // Selection commit - remote user committed selection
  wrapHandler('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionCommit(user, data.layerIndex);
    }
  });

  // Selection pending - remote user created a selection marquee
  wrapHandler('sel_pending', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionPending(user, data.selection, data.lassoPath);
    }
  });

  // Selection delete - remote user deleted selection
  wrapHandler('sel_delete', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionDelete(user, data.layerIndex);
    }
  });

  // Selection fill - remote user filled selection
  wrapHandler('sel_fill', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionFill(user, data.color, data.layerIndex);
    }
  });

  // Selection stamp - remote user stamped selection
  wrapHandler('sel_stamp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionStamp(user, data.layerIndex);
    }
  });

  // Selection flip - remote user flipped selection
  wrapHandler('sel_flip', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionFlip(user);
    }
  });

  // Selection cancel - remote user cancelled selection
  wrapHandler('sel_cancel', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionCancel(user);
    }
  });

  // Selection to brush - remote user converted selection to brush
  wrapHandler('sel_to_brush', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionToBrush(user, data.brushData);
    }
  });

  // Image paste - remote user pasted image content
  wrapHandler('img_paste', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleImagePaste(user, data);
    }
  });
}
