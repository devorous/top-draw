/**
 * @fileoverview Main-thread wrapper for the .ddraw encode worker.
 *
 * The recording crosses to the worker via a structured-clone copy (not a
 * transfer) so `TimeMachine`'s `_localRecording` stays intact and usable
 * for further scrubbing/export after this resolves.
 */
export class DdrawEncodeWorkerClient {
  constructor() {
    this._worker = null;
    this._nextId = 0;
    this._pending = new Map();
  }

  _ensureWorker() {
    if (this._worker) return this._worker;

    const worker = new Worker(new URL('./ddrawEncodeWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, blob, error } = event.data || {};
      const pending = this._pending.get(id);
      if (!pending) return;
      this._pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(blob);
    };
    worker.onerror = (event) => {
      const err = new Error(event?.message || 'Ddraw encode worker failed');
      for (const pending of this._pending.values()) pending.reject(err);
      this._pending.clear();
      this._worker?.terminate?.();
      this._worker = null;
    };

    this._worker = worker;
    return worker;
  }

  /**
   * @param {import('./Recorder.js').ReplayRecording} recording
   * @returns {Promise<Blob>}
   */
  encode(recording) {
    const id = this._nextId++;
    const worker = this._ensureWorker();
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, recording });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  destroy() {
    this._worker?.terminate?.();
    this._worker = null;
    for (const { reject } of this._pending.values()) reject(new Error('Worker terminated'));
    this._pending.clear();
  }
}
