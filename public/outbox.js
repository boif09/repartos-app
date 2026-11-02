// Cola de gastos y pagos creados sin conexión, guardada en el móvil (IndexedDB).
// Cada elemento: { id, kind: 'expense' | 'settlement', user, groupId, path, body, expense | settlement,
//                  createdAt, error? }. El id es el mismo UUID que se envía al servidor: reenviarlo
// nunca duplica (la API es idempotente por id).
const DB_NAME = 'repartos';
const STORE = 'outbox';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function outboxAvailable() {
  return typeof indexedDB !== 'undefined';
}

export function putItem(item) {
  return run('readwrite', (store) => store.put(item));
}

export function removeItem(id) {
  return run('readwrite', (store) => store.delete(id));
}

// Solo los del usuario actual, en el orden en que se crearon.
export async function listItems(user) {
  const items = (await run('readonly', (store) => store.getAll())) ?? [];
  return items.filter((item) => item.user === user).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
