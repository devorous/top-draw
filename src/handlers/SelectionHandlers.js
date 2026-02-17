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

  // Selection move - remote user moved/transformed selection
  wrapHandler('sel_move', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionMove(user, data.corners);
    }
  });

  // Selection commit - remote user committed selection
  wrapHandler('sel_commit', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionCommit(user);
    }
  });

  // Selection delete - remote user deleted selection
  wrapHandler('sel_delete', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionDelete(user);
    }
  });

  // Selection fill - remote user filled selection
  wrapHandler('sel_fill', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionFill(user, data.color);
    }
  });

  // Selection stamp - remote user stamped selection
  wrapHandler('sel_stamp', (data) => {
    const user = users.get(data.sessionIndex);
    if (user) {
      remoteUserHandler.selectionHandler.handleSelectionStamp(user);
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
