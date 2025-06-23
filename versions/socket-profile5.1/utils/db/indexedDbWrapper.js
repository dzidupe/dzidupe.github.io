// Simple async IndexedDB wrapper for large data storage
// Usage: const db = new IndexedDbWrapper('my-db', 1, { myStore: { keyPath: 'id' } });

class IndexedDbWrapper {
    constructor(dbName, version = 1, stores = {}) {
        this.dbName = dbName;
        this.version = version;
        this.stores = stores;
        this.db = null;
        this.ready = this._init();
    }

    _init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                for (const [storeName, opts] of Object.entries(this.stores)) {
                    if (!db.objectStoreNames.contains(storeName)) {
                        db.createObjectStore(storeName, opts || { keyPath: 'id' });
                    }
                }
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve();
            };
            request.onerror = (event) => {
                reject(event.target.error);
            };
        });
    }

    async _withStore(storeName, mode, fn) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const result = fn(store);
            tx.oncomplete = () => resolve(result);
            tx.onerror = (e) => reject(e.target.error);
            tx.onabort = (e) => reject(e.target.error);
        });
    }

    async get(storeName, key) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async getAll(storeName) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async set(storeName, value) {
        return this._withStore(storeName, 'readwrite', (store) => {
            store.put(value);
        });
    }

    async setBulk(storeName, values) {
        return this._withStore(storeName, 'readwrite', (store) => {
            for (const v of values) store.put(v);
        });
    }

    async delete(storeName, key) {
        return this._withStore(storeName, 'readwrite', (store) => {
            store.delete(key);
        });
    }

    async clear(storeName) {
        return this._withStore(storeName, 'readwrite', (store) => {
            store.clear();
        });
    }

    async keys(storeName) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async close() {
        await this.ready;
        this.db.close();
    }

    async deleteDatabase() {
        await this.close();
        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(this.dbName);
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e.target.error);
        });
    }
}

window.IndexedDbWrapper = IndexedDbWrapper;
export default IndexedDbWrapper;