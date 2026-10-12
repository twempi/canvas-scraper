export class Store {
  constructor(name = 'canvas-local-archive') { this.name = name; }
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }
  async transaction(mode, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode);
      const request = operation(tx.objectStore('records'));
      let value;
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || request.error);
    });
  }
  get(key) { return this.transaction('readonly', s => s.get(key)); }
  set(key, value) { return this.transaction('readwrite', s => s.put(value, key)); }
  delete(key) { return this.transaction('readwrite', s => s.delete(key)); }
}

export const destinationKey = (origin, courseId) => `destination:${origin}:${courseId}`;
export async function renew(handle) {
  // Call directly from a visible button, before unrelated asynchronous work.
  return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
}
export async function permission(handle) {
  return !!handle && await handle.queryPermission({ mode: 'readwrite' }) === 'granted';
}
