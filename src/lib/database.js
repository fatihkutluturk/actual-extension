/**
 * Actual AI — IndexedDB Database Layer
 *
 * Uses Dexie.js for clean IndexedDB access.
 * Since we can't bundle Dexie in a plain extension without a build step,
 * we implement a lightweight IndexedDB wrapper that mirrors Dexie's API.
 */

const DB_NAME = 'ActualAI';
const DB_VERSION = 1;

const STORES = {
  settings: { keyPath: 'key' },
  statements: { keyPath: 'id', indexes: ['accountId', 'fileHash', 'parseStatus', 'createdAt'] },
  parsedTransactions: { keyPath: 'id', indexes: ['statementId', 'date', 'importStatus', 'suggestedCategory'] },
  merchantMappings: { keyPath: 'id', indexes: ['rawPattern', 'actualPayeeId', 'actualCategoryId', 'source'] },
  summaries: { keyPath: 'id', indexes: ['accountId', 'period', 'periodType'] },
  chatMessages: { keyPath: 'id', indexes: ['role', 'createdAt'] },
};

class ActualAIDatabase {
  constructor() {
    this.db = null;
    this._ready = this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        for (const [storeName, config] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: config.keyPath });
            if (config.indexes) {
              for (const idx of config.indexes) {
                store.createIndex(idx, idx, { unique: false });
              }
            }
          }
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  async ready() {
    if (!this.db) await this._ready;
    return this.db;
  }

  // ─── Generic CRUD ───

  async put(storeName, data) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(storeName, key) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(storeName) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllByIndex(storeName, indexName, value) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, key) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clear(storeName) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async count(storeName) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putBatch(storeName, items) {
    const db = await this.ready();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const item of items) {
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ─── Settings helpers ───

  async getSetting(key) {
    const row = await this.get('settings', key);
    return row ? row.value : null;
  }

  async setSetting(key, value) {
    return this.put('settings', { key, value });
  }

  // ─── Statement helpers ───

  async getStatementByHash(hash) {
    const results = await this.getAllByIndex('statements', 'fileHash', hash);
    return results.length > 0 ? results[0] : null;
  }

  async getPendingTransactions(statementId) {
    const all = await this.getAllByIndex('parsedTransactions', 'statementId', statementId);
    return all.filter(t => t.importStatus === 'pending');
  }

  // ─── Merchant mapping helpers ───

  async findMerchantMapping(rawDescription) {
    const mappings = await this.getAll('merchantMappings');
    const desc = rawDescription.toLowerCase();

    // Exact match first
    let match = mappings.find(m => desc === m.rawPattern.toLowerCase());
    if (match) return match;

    // Contains match
    match = mappings.find(m => desc.includes(m.rawPattern.toLowerCase()));
    if (match) return match;

    // Regex match
    for (const m of mappings) {
      try {
        if (m.isRegex && new RegExp(m.rawPattern, 'i').test(desc)) {
          return m;
        }
      } catch (e) { /* skip invalid regex */ }
    }

    return null;
  }

  // ─── Chat helpers ───

  async getChatHistory(limit = 50) {
    const all = await this.getAll('chatMessages');
    return all
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(-limit);
  }

  async clearChat() {
    return this.clear('chatMessages');
  }
}

// Singleton
const database = new ActualAIDatabase();
export default database;
