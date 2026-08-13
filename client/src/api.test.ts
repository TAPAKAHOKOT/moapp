import { beforeEach, describe, expect, it, vi } from 'vitest'

const offline = vi.hoisted(() => {
  let outbox: import('./types').OutboxItem[] = []
  return {
    reset: () => { outbox = [] },
    read: () => outbox,
    cacheBootstrap: vi.fn(), clearOfflineData: vi.fn(), readCachedBootstrap: vi.fn(),
    queueMutation: vi.fn(async (item: import('./types').OutboxItem) => { outbox = [...outbox.filter((candidate) => candidate.operationId !== item.operationId), item] }),
    readOutbox: vi.fn(async () => outbox),
    removeMutation: vi.fn(async (id: string) => { outbox = outbox.filter((item) => item.operationId !== id) }),
  }
})

vi.mock('./offline', () => offline)

import { buildExpenseOperation, submitExpenseOperations, syncOutbox } from './api'
import type { Expense, OutboxItem } from './types'

const expense: Expense = {
  id: 'e7257dee-0f75-4ee0-8d3c-09da03fe4a91', amountMinor: 1250, currency: 'RSD', categoryId: 'products', note: null,
  occurredAt: '2026-08-03T11:30:00.000Z', createdAt: '2026-08-03T11:30:00.000Z', updatedAt: '2026-08-03T11:30:00.000Z', version: 3, deletedAt: null,
}

describe('sync operation builder', () => {
  it('preserves the operation id used by outbox retries', () => {
    const operation = buildExpenseOperation('updateExpense', expense, '66d9d33e-cb60-436c-be35-b531ecc99d52', '2026-08-03T12:00:00.000Z')
    expect(operation.operationId).toBe('66d9d33e-cb60-436c-be35-b531ecc99d52')
    expect(operation.payload.version).toBe(2)
  })
  it('keeps the current version for delete', () => {
    expect(buildExpenseOperation('deleteExpense', expense, 'id', 'now').payload).toEqual({ id: expense.id, version: 3 })
  })
})

const response = (status: number, body?: unknown) => new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function upgradeResponse() {
  return response(410, { error: { code: 'UPGRADE_REQUIRED', message: 'Update required' } })
}

describe('outbox compatibility safety', () => {
  beforeEach(() => {
    offline.reset()
    vi.clearAllMocks()
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'retryable-operation-id') })
  })

  it.each([401, 500])('retains queued operations after HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(status, { error: { code: status === 401 ? 'UNAUTHORIZED' : 'INTERNAL', message: 'No result' } })))
    await expect(submitExpenseOperations('createExpense', [expense])).resolves.toEqual([null])
    expect(offline.read()).toHaveLength(1)
  })

  it('retains queued operations after UPGRADE_REQUIRED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upgradeResponse()))
    await submitExpenseOperations('createExpense', [expense])
    expect(offline.read()).toHaveLength(1)
  })

  it('retains an operation when the sync response is invalid or partial', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { results: [] })))
    await submitExpenseOperations('createExpense', [expense])
    expect(offline.read()).toHaveLength(1)
  })

  it('removes only an explicitly rejected validation operation', async () => {
    const second = { ...expense, id: 'ffd472b0-9b67-4c64-a624-4f93f9aed1c7' }
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('first-operation').mockReturnValueOnce('second-operation') })
    vi.stubGlobal('fetch', vi.fn(async () => response(200, { results: [
      { operationId: 'first-operation', status: 'error', error: { code: 'VALIDATION', message: 'Invalid expense' } },
    ] })))
    await submitExpenseOperations('createExpense', [expense, second])
    expect(offline.read().map((item) => item.operationId)).toEqual(['second-operation'])
  })

  it('retries the same operation id after a lost response', async () => {
    const sent: OutboxItem[][] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const operations = JSON.parse(String(init.body)).operations
      sent.push(operations)
      return sent.length === 1 ? response(500, { error: { code: 'INTERNAL' } }) : response(200, { results: [{ operationId: operations[0].operationId, status: 'applied' }] })
    }))
    await submitExpenseOperations('createExpense', [expense])
    await syncOutbox()
    expect(sent[1]![0]!.operationId).toBe(sent[0]![0]!.operationId)
    expect(offline.read()).toHaveLength(0)
  })

  it('keeps a queued legacy operation when the future server fixture returns 410', async () => {
    const queued = buildExpenseOperation('deleteExpense', expense, 'legacy-operation-id', '2026-08-03T12:00:00.000Z')
    await offline.queueMutation(queued)
    vi.stubGlobal('fetch', vi.fn(async () => upgradeResponse()))
    await syncOutbox()
    expect(offline.read()).toEqual([queued])
  })
})
