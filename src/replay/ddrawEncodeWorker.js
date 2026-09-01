/**
 * @fileoverview Worker wrapper around encodeDdraw().
 *
 * encodeDdraw does a JSON.stringify + compress pass over the entire
 * recording — every stroke delta plus every checkpoint/layer blob for the
 * whole tape. For a long multi-user session that's large enough to freeze
 * (and, combined with the peak-memory cost of the encode itself, crash) the
 * tab if run inline on the main thread, so DdrawEncodeWorkerClient routes it
 * through here instead.
 */
import { encodeDdraw } from '../../shared/ddrawCodec.js';

self.onmessage = async (event) => {
  const { id, recording } = event.data || {};
  try {
    const blob = await encodeDdraw(recording);
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err?.message || 'Ddraw encode failed' });
  }
};
