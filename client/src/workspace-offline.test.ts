import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_DB_NAME, cacheBootstrap, clearUserOfflineData, clearWorkspaceOfflineData, migrateLegacyOfflineData, outboxStats, queueMutation, queueMutations, readCachedBootstrap, readOutbox,
} from './workspace-offline'
import type { WorkspaceBootstrap, WorkspaceOutboxItem } from './types'

const bootstrap = (workspaceId: string): WorkspaceBootstrap => ({
  workspaceId, workspace: { id: workspaceId, name: workspaceId, role: 'owner', version: 1, joinedAt: '2026-01-01T00:00:00.000Z' },
  expenses: [], categories: [], currencies: [], rates: { base: 'RSD', date: null, ratesToRsd: { RSD: 1 } }, defaultAnalyticsCurrency: 'RSD', serverTime: '2026-01-01T00:00:00.000Z',
})
const item = (userId: string, workspaceId: string, operationId = 'same-operation'): WorkspaceOutboxItem => ({ userId, workspaceId, operationId, type: 'createExpense', payload: { id: 'expense' }, createdAt: '2026-01-01T00:00:00.000Z' })

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(WORKSPACE_DB_NAME)
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('database remained open'))
  })
}
function open(version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_DB_NAME, version)
    request.onupgradeneeded = () => upgrade?.(request.result)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function seedV2(): Promise<void> {
  const db = await open(2, (database) => { database.createObjectStore('cache'); database.createObjectStore('outbox', { keyPath: 'operationId' }) })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['cache', 'outbox'], 'readwrite')
    tx.objectStore('cache').put({ ...bootstrap('legacy'), workspaceId: undefined }, 'bootstrap')
    tx.objectStore('outbox').put({ operationId: 'same-operation', type: 'createExpense', payload: { id: 'legacy' }, createdAt: '2026-01-01T00:00:00.000Z' })
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
  })
  db.close()
}
async function rawPut(storeName: string, value: unknown): Promise<void> {
  const db = await open(3)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).put(value)
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
  })
  db.close()
}

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key) }, setItem: (key, value) => { data.set(key, String(value)) },
  }
}

beforeEach(async () => { vi.stubGlobal('localStorage', memoryStorage()); await deleteDatabase() })
afterEach(async () => { await deleteDatabase(); vi.unstubAllGlobals() })

describe('workspace offline isolation', () => {
  it('keeps same operation IDs isolated by user and workspace', async () => {
    await Promise.all([
      queueMutation('user-a', 'workspace-a', item('user-a', 'workspace-a')),
      queueMutation('user-a', 'workspace-b', item('user-a', 'workspace-b')),
      queueMutation('user-b', 'workspace-a', item('user-b', 'workspace-a')),
    ])
    expect(await readOutbox('user-a', 'workspace-a')).toHaveLength(1)
    expect(await readOutbox('user-a', 'workspace-b')).toHaveLength(1)
    expect(await readOutbox('user-b', 'workspace-a')).toHaveLength(1)
  })

  it('queues a batch in one transaction and rejects mixed scopes without partial writes', async () => {
    const valid = item('user-a', 'workspace-a', 'one')
    const foreign = item('user-a', 'workspace-b', 'two')

    await expect(queueMutations('user-a', 'workspace-a', [valid, foreign])).rejects.toThrow('scope')
    expect(await readOutbox('user-a', 'workspace-a')).toEqual([])
    expect(await readOutbox('user-a', 'workspace-b')).toEqual([])

    await queueMutations('user-a', 'workspace-a', [valid, item('user-a', 'workspace-a', 'two')])
    expect(await readOutbox('user-a', 'workspace-a')).toHaveLength(2)
  })

  it('quarantines a v2 cache and outbox until an explicit legacy mapping exists', async () => {
    await seedV2()
    expect(await readOutbox('user-a', 'workspace-a')).toEqual([])
    expect(await readCachedBootstrap('user-a', 'workspace-a')).toBeUndefined()
  })

  it('moves legacy rows only into the claimed legacy workspace and clears their old stores', async () => {
    await seedV2()
    await migrateLegacyOfflineData('user-a', 'legacy-workspace')
    expect((await readCachedBootstrap('user-a', 'legacy-workspace'))?.workspaceId).toBe('legacy-workspace')
    expect(await readOutbox('user-a', 'legacy-workspace')).toMatchObject([{ operationId: 'same-operation', workspaceId: 'legacy-workspace', userId: 'user-a' }])
    expect(await readOutbox('user-a', 'other-workspace')).toEqual([])
  })

  it('finishes a db_complete migration without copying an outbox a second time', async () => {
    // Initialise v3, then emulate the point after the atomic DB transaction
    // but before localStorage preferences/marker completion.
    await cacheBootstrap('user-a', 'legacy-workspace', bootstrap('legacy-workspace'))
    await queueMutation('user-a', 'legacy-workspace', item('user-a', 'legacy-workspace'))
    await rawPut('migration-state', { userId: 'user-a', migration: 'legacy-v2', stage: 'db_complete' })
    localStorage.setItem('moapp:last-currency', 'EUR')
    await migrateLegacyOfflineData('user-a', 'legacy-workspace')
    expect(await readOutbox('user-a', 'legacy-workspace')).toHaveLength(1)
    expect(localStorage.getItem('moapp:v2:user:user-a:workspace:legacy-workspace:last-currency')).toBe('EUR')
  })

  it('clears only the requested workspace scope', async () => {
    await cacheBootstrap('user-a', 'workspace-a', bootstrap('workspace-a'))
    await cacheBootstrap('user-a', 'workspace-b', bootstrap('workspace-b'))
    await queueMutation('user-a', 'workspace-a', item('user-a', 'workspace-a'))
    await queueMutation('user-a', 'workspace-b', item('user-a', 'workspace-b'))
    await clearWorkspaceOfflineData('user-a', 'workspace-a')
    expect(await readCachedBootstrap('user-a', 'workspace-a')).toBeUndefined()
    expect(await readOutbox('user-a', 'workspace-a')).toEqual([])
    expect(await readCachedBootstrap('user-a', 'workspace-b')).toBeDefined()
    expect((await outboxStats('user-a', 'workspace-b')).total).toBe(1)
  })

  it('clears every cache and outbox row for one user without touching another user', async () => {
    await cacheBootstrap('user-a', 'workspace-a', bootstrap('workspace-a'))
    await cacheBootstrap('user-a', 'workspace-b', bootstrap('workspace-b'))
    await cacheBootstrap('user-b', 'workspace-a', bootstrap('workspace-a'))
    await queueMutation('user-a', 'workspace-a', item('user-a', 'workspace-a'))
    await queueMutation('user-a', 'workspace-b', item('user-a', 'workspace-b'))
    await queueMutation('user-b', 'workspace-a', item('user-b', 'workspace-a'))

    await clearUserOfflineData('user-a')

    expect(await readCachedBootstrap('user-a', 'workspace-a')).toBeUndefined()
    expect(await readCachedBootstrap('user-a', 'workspace-b')).toBeUndefined()
    expect(await readOutbox('user-a', 'workspace-a')).toEqual([])
    expect(await readOutbox('user-a', 'workspace-b')).toEqual([])
    expect(await readCachedBootstrap('user-b', 'workspace-a')).toBeDefined()
    expect(await readOutbox('user-b', 'workspace-a')).toHaveLength(1)
  })
})
