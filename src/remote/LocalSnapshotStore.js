/** @fileoverview IndexedDB-backed local snapshot store for non-uploader clients. */

const DB_NAME = 'topdraw_local_snapshots';
const DB_VERSION = 2;
const STORE = 'snapshots';      // Full records: id, roomId, ts, issuer, name, layers, thumb
const META_STORE = 'snapshot_meta'; // Lightweight: id, roomId, ts, issuer, name, thumb (NO layers)

export class LocalSnapshotStore {
  constructor() {
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        const tx = e.target.transaction;

        // v1: original snapshots store
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('roomId_ts', ['roomId', 'ts']);
          store.createIndex('ts', 'ts');
        }

        // v2: lightweight meta store with thumbnails (no layers)
        if (!db.objectStoreNames.contains(META_STORE)) {
          const metaStore = db.createObjectStore(META_STORE, { keyPath: 'id' });
          metaStore.createIndex('roomId_ts', ['roomId', 'ts']);

          // Migrate existing records from snapshots store -> meta store
          if (e.oldVersion < 2 && tx) {
            const oldStore = tx.objectStore(STORE);
            const cursorReq = oldStore.openCursor();
            cursorReq.onsuccess = (event) => {
              const cursor = event.target.result;
              if (!cursor) return;
              const { layers, ...metaWithThumb } = cursor.value;
              metaStore.put(metaWithThumb);
              cursor.continue();
            };
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }

  async _tx(storeNames, mode) {
    const db = await this._open();
    const stores = Array.isArray(storeNames) ? storeNames : [storeNames];
    return db.transaction(stores, mode);
  }

  async add(record) {
    const tx = await this._tx([STORE, META_STORE], 'readwrite');
    const fullStore = tx.objectStore(STORE);
    const metaStore = tx.objectStore(META_STORE);
    const { layers, ...metaWithThumb } = record;
    await new Promise((resolve, reject) => {
      const req1 = fullStore.put(record);
      const req2 = metaStore.put(metaWithThumb);
      let pending = 2;
      const done = () => { if (--pending === 0) resolve(); };
      req1.onsuccess = done;
      req2.onsuccess = done;
      req1.onerror = () => reject(req1.error);
      req2.onerror = () => reject(req2.error);
    });
  }

  async list(roomId, limit = 20, beforeTs = 0) {
    const tx = await this._tx(META_STORE, 'readonly');
    const metaStore = tx.objectStore(META_STORE);
    return new Promise((resolve, reject) => {
      const out = [];
      const idx = metaStore.index('roomId_ts');
      const range = beforeTs > 0
        ? IDBKeyRange.bound([roomId, -Infinity], [roomId, beforeTs])
        : IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);
      const req = idx.openCursor(range, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || out.length >= limit) return resolve(out);
        const { thumb, ...meta } = cursor.value;
        out.push({ ...meta, thumb, hasThumb: !!thumb });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async get(id) {
    const tx = await this._tx(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getThumb(id) {
    const tx = await this._tx(META_STORE, 'readonly');
    const metaStore = tx.objectStore(META_STORE);
    return new Promise((resolve, reject) => {
      const req = metaStore.get(id);
      req.onsuccess = () => {
        const result = req.result;
        resolve(result?.thumb || null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id) {
    const tx = await this._tx([STORE, META_STORE], 'readwrite');
    const fullStore = tx.objectStore(STORE);
    const metaStore = tx.objectStore(META_STORE);
    await new Promise((resolve, reject) => {
      const req1 = fullStore.delete(id);
      const req2 = metaStore.delete(id);
      let pending = 2;
      const done = () => { if (--pending === 0) resolve(); };
      req1.onsuccess = done;
      req2.onsuccess = done;
      req1.onerror = () => reject(req1.error);
      req2.onerror = () => reject(req2.error);
    });
  }

  /**
   * Deletes oldest snapshots in a room beyond `keep` count.
   * @param {string} roomId
   * @param {number} keep - Max number of snapshots to retain
   */
  async pruneRoom(roomId, keep) {
    if (!Number.isFinite(keep) || keep < 1) return 0;
    const tx = await this._tx([STORE, META_STORE], 'readwrite');
    const fullStore = tx.objectStore(STORE);
    const metaStore = tx.objectStore(META_STORE);
    const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);

    return new Promise((resolve, reject) => {
      let seen = 0;
      let removed = 0;
      const req = metaStore.index('roomId_ts').openCursor(range, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve(removed);
        seen++;
        if (seen > keep) {
          fullStore.delete(cursor.value.id);
          cursor.delete();
          removed++;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clearRoom(roomId) {
    const tx = await this._tx([STORE, META_STORE], 'readwrite');
    const fullStore = tx.objectStore(STORE);
    const metaStore = tx.objectStore(META_STORE);
    const range = IDBKeyRange.bound([roomId, -Infinity], [roomId, Infinity]);

    await Promise.all([
      new Promise((resolve, reject) => {
        const req = fullStore.index('roomId_ts').openCursor(range);
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return resolve();
          cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }),
      new Promise((resolve, reject) => {
        const req = metaStore.index('roomId_ts').openCursor(range);
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return resolve();
          cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      })
    ]);
  }
}
