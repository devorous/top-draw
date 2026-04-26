/** @fileoverview IndexedDB-backed local snapshot store for non-uploader clients. */

const DB_NAME = 'topdraw_local_snapshots';
const DB_VERSION = 1;
const STORE = 'snapshots';

export class LocalSnapshotStore {
  constructor() {
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('roomId_ts', ['roomId', 'ts']);
          store.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }

  async _tx(mode) {
    const db = await this._open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async add(record) {
    const store = await this._tx('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async list(roomId) {
    const store = await this._tx('readonly');
    return new Promise((resolve, reject) => {
      const out = [];
      const idx = store.index('roomId_ts');
      const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
      const req = idx.openCursor(range, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve(out);
        const { layers, thumb, ...meta } = cursor.value;
        out.push({ ...meta, hasThumb: !!thumb });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async get(id) {
    const store = await this._tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id) {
    const store = await this._tx('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clearRoom(roomId) {
    const store = await this._tx('readwrite');
    await new Promise((resolve, reject) => {
      const idx = store.index('roomId_ts');
      const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
      const req = idx.openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve();
        cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

}
