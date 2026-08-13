import type { OutboxStats, SessionState, WorkspaceBootstrap, WorkspaceOutboxItem } from './types'

export const WORKSPACE_DB_NAME = 'moapp-offline'
export const WORKSPACE_DB_VERSION = 3

type CachedWorkspace = { userId: string; workspaceId: string; data: WorkspaceBootstrap; cachedAt: string }
type CachedProfile = { userId: string; session: SessionState; cachedAt: string }
type MigrationState = { userId: string; migration: 'legacy-v2'; stage: 'db_complete' | 'complete' }
type LegacyOutbox = Omit<WorkspaceOutboxItem, 'userId' | 'workspaceId'>

const pendingWrites = new Set<Promise<unknown>>()

function track<T>(promise: Promise<T>, write = false): Promise<T> {
  if (write) {
    pendingWrites.add(promise)
    // Do not use finally() here: its returned promise would reject separately
    // from the caller's awaited write and can become an unhandled rejection.
    void promise.then(() => pendingWrites.delete(promise), () => pendingWrites.delete(promise))
  }
  return promise
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // v2 stores are deliberately retained: legacy data is quarantined until a
      // completed legacy claim supplies the only safe workspace mapping.
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache')
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'operationId' })
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'userId' })
      if (!db.objectStoreNames.contains('workspace-cache')) db.createObjectStore('workspace-cache', { keyPath: ['userId', 'workspaceId'] })
      if (!db.objectStoreNames.contains('workspace-outbox')) {
        const store = db.createObjectStore('workspace-outbox', { keyPath: ['userId', 'workspaceId', 'operationId'] })
        store.createIndex('byWorkspace', ['userId', 'workspaceId'], { unique: false })
        store.createIndex('byCreatedAtStatus', ['userId', 'workspaceId', 'status', 'createdAt'], { unique: false })
      }
      if (!db.objectStoreNames.contains('migration-state')) db.createObjectStore('migration-state', { keyPath: ['userId', 'migration'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open offline storage'))
  })
}

async function transaction<T>(stores: string | string[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb()
  const promise = new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    let value: T | undefined
    let request: IDBRequest<T> | void
    try { request = action(tx) } catch (error) { tx.abort(); reject(error); return }
    if (request) {
      request.onsuccess = () => { value = request.result }
      request.onerror = () => { /* transaction.onerror carries the final failure */ }
    }
    tx.oncomplete = () => { db.close(); resolve(value) }
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction failed')) }
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
  })
  return track(promise, mode === 'readwrite')
}

function workspaceKey(userId: string, workspaceId: string) { return [userId, workspaceId] }
function mutationKey(userId: string, workspaceId: string, operationId: string) { return [userId, workspaceId, operationId] }

export async function cacheProfile(userId: string, session: SessionState): Promise<void> {
  await transaction('profiles', 'readwrite', (tx) => tx.objectStore('profiles').put({ userId, session, cachedAt: new Date().toISOString() } satisfies CachedProfile))
}

export async function readCachedProfile(userId: string): Promise<CachedProfile | undefined> {
  return transaction<CachedProfile | undefined>('profiles', 'readonly', (tx) => tx.objectStore('profiles').get(userId))
}

export async function cacheBootstrap(userId: string, workspaceId: string, data: WorkspaceBootstrap): Promise<void> {
  if (data.workspaceId !== workspaceId) throw new Error('Bootstrap workspace does not match its storage scope')
  await transaction('workspace-cache', 'readwrite', (tx) => tx.objectStore('workspace-cache').put({ userId, workspaceId, data, cachedAt: new Date().toISOString() } satisfies CachedWorkspace))
}

export async function readCachedBootstrap(userId: string, workspaceId: string): Promise<WorkspaceBootstrap | undefined> {
  const row = await transaction<CachedWorkspace | undefined>('workspace-cache', 'readonly', (tx) => tx.objectStore('workspace-cache').get(workspaceKey(userId, workspaceId)))
  return row?.data
}

export async function queueMutation(userId: string, workspaceId: string, item: WorkspaceOutboxItem): Promise<void> {
  if (item.userId !== userId || item.workspaceId !== workspaceId) throw new Error('Outbox item does not match its storage scope')
  await transaction('workspace-outbox', 'readwrite', (tx) => tx.objectStore('workspace-outbox').put(item))
}

export async function readOutbox(userId: string, workspaceId: string): Promise<WorkspaceOutboxItem[]> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace-outbox', 'readonly')
      const request = tx.objectStore('workspace-outbox').index('byWorkspace').getAll(IDBKeyRange.only(workspaceKey(userId, workspaceId))) as IDBRequest<WorkspaceOutboxItem[]>
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}

export async function removeMutation(userId: string, workspaceId: string, operationId: string): Promise<void> {
  await transaction('workspace-outbox', 'readwrite', (tx) => tx.objectStore('workspace-outbox').delete(mutationKey(userId, workspaceId, operationId)))
}

export async function outboxStats(userId: string, workspaceId: string): Promise<OutboxStats> {
  const items = await readOutbox(userId, workspaceId)
  return { total: items.length, conflicts: items.filter((item) => item.status === 'conflict').length, failed: items.filter((item) => item.status === 'failed').length }
}

export async function clearWorkspaceOfflineData(userId: string, workspaceId: string): Promise<void> {
  const db = await openDb()
  const done = new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['workspace-cache', 'workspace-outbox'], 'readwrite')
    tx.objectStore('workspace-cache').delete(workspaceKey(userId, workspaceId))
    const index = tx.objectStore('workspace-outbox').index('byWorkspace')
    const cursor = index.openKeyCursor(IDBKeyRange.only(workspaceKey(userId, workspaceId)))
    cursor.onsuccess = () => {
      const current = cursor.result
      // A key cursor from an index is not a portable deletion cursor (notably
      // fake-indexeddb rejects cursor.delete()). Delete by its full primary key.
      if (current) { tx.objectStore('workspace-outbox').delete(current.primaryKey); current.continue() }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  try { await track(done, true) } finally { db.close() }
}

export async function clearUserOfflineData(userId: string): Promise<void> {
  const db = await openDb()
  const done = new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['profiles', 'workspace-cache', 'workspace-outbox', 'migration-state'], 'readwrite')
    tx.objectStore('profiles').delete(userId)
    for (const storeName of ['workspace-cache', 'workspace-outbox'] as const) {
      const store = tx.objectStore(storeName)
      const cursor = store.openKeyCursor()
      cursor.onsuccess = () => { const current = cursor.result; if (current) { if (Array.isArray(current.key) && current.key[0] === userId) current.delete(); current.continue() } }
    }
    tx.objectStore('migration-state').delete([userId, 'legacy-v2'])
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  try { await track(done, true) } finally { db.close() }
}

function legacyPreferenceKeys(userId: string, workspaceId: string) {
  return [
    ['moapp:last-currency', `moapp:v2:user:${userId}:workspace:${workspaceId}:last-currency`],
    ['moapp:analytics-currency', `moapp:v2:user:${userId}:workspace:${workspaceId}:analytics-currency`],
  ] as const
}

/** Explicitly moves quarantined v2 data only after the server supplied its precise legacy workspace. */
export async function migrateLegacyOfflineData(userId: string, legacyWorkspaceId: string): Promise<void> {
  const migration = await transaction<MigrationState | undefined>('migration-state', 'readonly', (tx) => tx.objectStore('migration-state').get([userId, 'legacy-v2']))
  if (migration?.stage !== 'complete') {
    if (migration?.stage !== 'db_complete') {
      const db = await openDb()
      const done = new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['cache', 'outbox', 'workspace-cache', 'workspace-outbox', 'migration-state'], 'readwrite')
        const legacyCache = tx.objectStore('cache').get('bootstrap') as IDBRequest<unknown>
        const legacyOutbox = tx.objectStore('outbox').getAll() as IDBRequest<LegacyOutbox[]>
        legacyCache.onsuccess = () => {
          const data = legacyCache.result as Partial<WorkspaceBootstrap> | undefined
          if (data && typeof data === 'object') tx.objectStore('workspace-cache').put({ userId, workspaceId: legacyWorkspaceId, data: { ...data, workspaceId: legacyWorkspaceId } as WorkspaceBootstrap, cachedAt: new Date().toISOString() } satisfies CachedWorkspace)
        }
        legacyOutbox.onsuccess = () => {
          for (const item of legacyOutbox.result ?? []) tx.objectStore('workspace-outbox').put({ ...item, userId, workspaceId: legacyWorkspaceId })
        }
        tx.objectStore('migration-state').put({ userId, migration: 'legacy-v2', stage: 'db_complete' } satisfies MigrationState)
        // Clearing legacy stores in this very transaction prevents a crash from
        // duplicating retries on the next start.
        tx.objectStore('cache').clear(); tx.objectStore('outbox').clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      try { await track(done, true) } finally { db.close() }
    }
    if (typeof localStorage !== 'undefined') {
      for (const [legacy, scoped] of legacyPreferenceKeys(userId, legacyWorkspaceId)) {
        const value = localStorage.getItem(legacy)
        if (value !== null) { localStorage.setItem(scoped, value); localStorage.removeItem(legacy) }
      }
    }
    await transaction('migration-state', 'readwrite', (tx) => tx.objectStore('migration-state').put({ userId, migration: 'legacy-v2', stage: 'complete' } satisfies MigrationState))
  }
}

export async function waitForWorkspaceOfflineWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.all([...pendingWrites])
}
