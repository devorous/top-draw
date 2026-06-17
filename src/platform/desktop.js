function hasTauriGlobals() {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);
}

export function isTauriDesktop() {
  return hasTauriGlobals();
}

async function invokeDesktop(command, payload = {}) {
  if (!hasTauriGlobals()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, payload);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to serialize canvas'));
      }
    }, 'image/png');
  });
}

export async function openImageViaNativeDialog() {
  if (!hasTauriGlobals()) return null;
  return invokeDesktop('open_image_via_dialog');
}

export async function saveCanvasViaNativeDialog(canvas, suggestedName) {
  if (!hasTauriGlobals()) return { saved: false };
  const blob = await canvasToBlob(canvas);
  const dataUrl = await blobToDataUrl(blob);
  const base64Png = typeof dataUrl === 'string' ? dataUrl.split(',')[1] : '';
  return invokeDesktop('save_png_via_dialog', { base64Png, suggestedName });
}

/**
 * Save arbitrary bytes through the desktop native save dialog. Returns
 * `{ saved, path }` — `saved:false` means the user cancelled the dialog.
 * No-op (`{ saved:false }`) outside the Tauri desktop app.
 * @param {Blob} blob
 * @param {{ suggestedName?: string, filterName?: string, extensions?: string[] }} [opts]
 * @returns {Promise<{ saved: boolean, path?: string|null }>}
 */
export async function saveBytesViaNativeDialog(blob, { suggestedName, filterName, extensions } = {}) {
  if (!hasTauriGlobals()) return { saved: false };
  const dataUrl = await blobToDataUrl(blob);
  const base64 = typeof dataUrl === 'string' ? dataUrl.split(',')[1] ?? '' : '';
  return invokeDesktop('save_bytes_via_dialog', {
    base64,
    suggestedName,
    filterName,
    extensions,
  });
}

/**
 * Reveal a previously-saved file in the OS file manager. No-op outside Tauri.
 * @param {string} path - Absolute path returned by saveBytesViaNativeDialog.
 * @returns {Promise<boolean>} true if the reveal was invoked.
 */
export async function revealPathInDir(path) {
  if (!hasTauriGlobals() || !path) return false;
  try {
    await invokeDesktop('reveal_path_in_dir', { path });
    return true;
  } catch (error) {
    console.warn('[Desktop] Failed to reveal file location:', error);
    return false;
  }
}

export async function copyCanvasToSystemClipboard(canvas) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return false;
  }

  try {
    const blob = await canvasToBlob(canvas);
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob
      })
    ]);
    return true;
  } catch (error) {
    console.warn('[Desktop] Failed to write image to clipboard:', error);
    return false;
  }
}

export async function copyImageDataToSystemClipboard(imageData, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return copyCanvasToSystemClipboard(canvas);
}

export async function updateDiscordRichPresence(presence) {
  if (!hasTauriGlobals()) return null;
  return invokeDesktop('update_discord_presence', { presence });
}

export async function openDiscordOAuthWindow(url, { onResult, onClosed } = {}) {
  if (!hasTauriGlobals()) return null;

  const { listen } = await import('@tauri-apps/api/event');
  const unlistenResult = await listen('discord-oauth-result', (event) => {
    const resultUrl = typeof event.payload === 'string' ? event.payload : event.payload?.url;
    if (resultUrl) onResult?.(resultUrl);
  });
  const unlistenClosed = await listen('discord-oauth-closed', () => {
    onClosed?.();
  });

  const cleanup = () => {
    unlistenResult();
    unlistenClosed();
  };

  try {
    await invokeDesktop('open_discord_oauth_window', { url });
  } catch (error) {
    cleanup();
    throw error;
  }

  return { cleanup };
}
