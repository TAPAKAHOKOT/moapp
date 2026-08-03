import { describe, expect, it } from 'vitest'
import { buildExpenseOperation } from './api'
import type { Expense } from './types'

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
