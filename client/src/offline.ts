import type { Bootstrap, OutboxItem } from './types'

const DB_NAME = 'moapp-offline'
const DB_VERSION = 2

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache')
      if (db.objectStoreNames.contains('outbox')) db.deleteObjectStore('outbox')
      db.createObjectStore('outbox', { keyPath: 'operationId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function store<T>(name: 'cache' | 'outbox', mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode)
    const request = action(transaction.objectStore(name))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => db.close()
  })
}

export const cacheBootstrap = (data: Bootstrap) => store('cache', 'readwrite', (s) => s.put(data, 'bootstrap'))
export const readCachedBootstrap = () => store<Bootstrap | undefined>('cache', 'readonly', (s) => s.get('bootstrap'))
export const queueMutation = (item: OutboxItem) => store('outbox', 'readwrite', (s) => s.put(item))
export const removeMutation = (id: string) => store('outbox', 'readwrite', (s) => s.delete(id))
export const readOutbox = () => store<OutboxItem[]>('outbox', 'readonly', (s) => s.getAll())

export async function outboxSize() {
  return (await readOutbox()).length
}

export async function outboxStats() {
  const items = await readOutbox()
  return {
    total: items.length,
    conflicts: items.filter((item) => item.status === 'conflict').length,
    failed: items.filter((item) => item.status === 'failed').length,
  }
}

export async function clearOfflineData() {
  const db = await openDb()
  await Promise.all(['cache', 'outbox'].map((name) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(name, 'readwrite')
    const request = transaction.objectStore(name).clear()
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })))
  db.close()
}
