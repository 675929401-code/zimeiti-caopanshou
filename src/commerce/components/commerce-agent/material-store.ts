export type StoredMaterial = { id: string; name: string; type: string; size: number; slot: string; createdAt: number; blob: Blob };
const DATABASE = 'commerce-agent-materials-v1';
function open(namespace?:string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(namespace?DATABASE+':'+namespace:DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('materials', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function listMaterials(namespace?:string): Promise<StoredMaterial[]> {
  const db = await open(namespace);
  try { return await new Promise((resolve, reject) => { const request = db.transaction('materials').objectStore('materials').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
export async function saveMaterial(value: StoredMaterial,namespace?:string) {
  const db = await open(namespace);
  try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction('materials', 'readwrite'); transaction.objectStore('materials').put(value); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
  finally { db.close(); }
}
export async function deleteMaterial(id: string,namespace?:string) {
  const db = await open(namespace);
  try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction('materials', 'readwrite'); transaction.objectStore('materials').delete(id); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
  finally { db.close(); }
}
